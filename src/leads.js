// Leads (base do CRM) + envio de eventos para a Meta via Conversions API.
// Tudo que depende da Meta é opcional: sem META_PIXEL_ID / META_CAPI_TOKEN o lead
// é salvo normalmente e o evento fica registrado como "skipped".

import { ensureSchema, upsertContactRow, canonicalPhone, safeJson } from "./schema.js";
import { attachLeadToContact, afterLeadSaved, afterStageChange, originLabel } from "./crm.js";
import { markFinancingSimulationConverted } from "./financing.js";

const encoder = new TextEncoder();

export const STAGES = ["novo", "contatado", "qualificado", "visita", "proposta", "fechado", "perdido"];

// Etapa do CRM -> evento enviado à Meta (uma vez por lead).
const STAGE_EVENTS = {
  qualificado: "QualifiedLead",
  visita: "Schedule",
  proposta: "Proposta",
  fechado: "Purchase",
};

const DEDUP_WINDOW_MS = 30 * 60 * 1000;

// ---------- API pública ----------

export async function postLead(request, env, ctx, body) {
  await ensureSchema(env);
  const v = validateLeadInput(body);
  if (v.error) return { status: 400, body: { error: { code: "invalid_field", message: v.error } } };

  const lead = await saveLead(request, env, ctx, {
    kind: v.value.context === "simulador" ? "simulador" : "whatsapp",
    leadType: v.value.leadType,
    name: v.value.name,
    phone: v.value.phone,
    email: null,
    propertyId: v.value.propertyId,
    propertyTitle: v.value.propertyTitle,
    value: v.value.value,
    tracking: v.value.tracking,
    viewed: v.value.viewed,
    origin: v.value.context === "simulador" ? "Simulador" : null,
    extra: { context: v.value.context, interest: v.value.interest, cta: v.value.cta, simulation: v.value.simulation },
  });
  if (v.value.simulation && v.value.simulation.id) {
    await markFinancingSimulationConverted(env, v.value.simulation.id, lead.id);
  }
  return { status: 201, body: { id: lead.id, ref: lead.ref, eventId: lead.eventId, duplicate: lead.duplicate === true } };
}

// Chamado pelo formulário de avaliação (proprietário) depois de gravar a avaliação.
export async function leadFromAppraisal(request, env, ctx, appraisal, rawBody) {
  await ensureSchema(env);
  const tracking = sanitizeTracking(rawBody && rawBody.tracking);
  return saveLead(request, env, ctx, {
    kind: "avaliacao",
    leadType: "proprietario",
    name: appraisal.name,
    phone: appraisal.phone,
    email: appraisal.email,
    propertyId: null,
    propertyTitle: `${appraisal.type} - ${appraisal.location}`,
    value: null,
    tracking,
    viewed: rawBody && Array.isArray(rawBody.viewed) ? rawBody.viewed.filter(x => typeof x === "string" && x.length <= 200).slice(0, 20) : [],
    extra: { appraisalId: appraisal.id, area: appraisal.area, details: appraisal.details },
  });
}

export async function listLeads(env) {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    `SELECT id, ref, kind, lead_type, stage, name, phone, email, property_id, property_title, value, contact_id, lost_reason, data, created_at, updated_at
       FROM leads ORDER BY created_at DESC, id DESC LIMIT 1000`,
  ).all();
  return result.results.map(row => {
    const data = safeJson(row.data);
    return {
      id: row.id,
      ref: row.ref,
      kind: row.kind,
      leadType: row.lead_type,
      stage: row.stage,
      name: row.name,
      phone: row.phone,
      email: row.email,
      propertyId: row.property_id,
      propertyTitle: row.property_title,
      value: row.value,
      contactId: row.contact_id,
      lostReason: row.lost_reason,
      notes: data.notes || "",
      origin: data.imported ? "Lista de clientes" : originLabel(data.tracking || {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

export async function updateLead(request, env, ctx, id, body) {
  await ensureSchema(env);
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: { code: "invalid_body", message: "Corpo inválido." } } };
  }
  const row = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!row) return { status: 404, body: { error: { code: "lead_not_found", message: "Lead não encontrado." } } };

  const data = safeJson(row.data);
  let stage = row.stage;
  let value = row.value;
  let lostReason = row.lost_reason || null;
  if (body.lostReason !== undefined) {
    lostReason = typeof body.lostReason === "string" && body.lostReason.trim() ? body.lostReason.trim().slice(0, 200) : null;
  }

  if (body.stage !== undefined) {
    if (!STAGES.includes(body.stage)) {
      return { status: 400, body: { error: { code: "invalid_stage", message: "Etapa inválida." } } };
    }
    if (body.stage !== stage) {
      data.history = Array.isArray(data.history) ? data.history.slice(-50) : [];
      data.history.push({ from: stage, to: body.stage, at: new Date().toISOString() });
      stage = body.stage;
    }
  }
  if (body.value !== undefined) {
    const n = body.value === null || body.value === "" ? null : Number(body.value);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 1e10)) {
      return { status: 400, body: { error: { code: "invalid_value", message: "Valor inválido." } } };
    }
    value = n;
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string" || body.notes.length > 4000) {
      return { status: 400, body: { error: { code: "invalid_notes", message: "Anotação inválida." } } };
    }
    data.notes = body.notes;
  }

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE leads SET stage = ?, value = ?, lost_reason = ?, data = ?, updated_at = ? WHERE id = ?")
    .bind(stage, value, lostReason, JSON.stringify(data), now, id).run();

  if (stage !== row.stage) {
    try {
      await afterStageChange(env, { leadId: id, contactId: row.contact_id, from: row.stage, to: stage, lostReason });
    } catch (err) {
      console.error("afterStageChange failed", err);
    }
  }

  const eventName = STAGE_EVENTS[stage];
  if (eventName && stage !== row.stage) {
    const lead = { ...row, stage, value, data };
    const already = await env.DB.prepare(
      "SELECT 1 FROM lead_events WHERE lead_id = ? AND event_name = ? AND meta_status = 'sent' LIMIT 1",
    ).bind(id, eventName).first();
    if (!already) {
      ctx.waitUntil(sendAndLog(env, lead, {
        eventName,
        eventId: `${id}:${eventName}`,
        actionSource: "system_generated",
        stage,
      }));
    }
  }

  return { status: 200, body: { ok: true, stage, value } };
}

// Importa clientes antigos (planilha) direto como "fechado". Não envia nada à Meta:
// esses contatos viram público personalizado pela exportação abaixo.
export async function importLeads(env, body) {
  await ensureSchema(env);
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0 || rows.length > 5000) {
    return { status: 400, body: { error: { code: "invalid_rows", message: "Envie de 1 a 5000 linhas." } } };
  }
  const now = new Date().toISOString();
  const existing = new Set((await env.DB.prepare("SELECT phone FROM leads").all()).results.map(r => r.phone));
  let imported = 0;
  let skipped = 0;
  const statements = [];
  for (const raw of rows) {
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
    const phone = typeof raw.phone === "string" ? raw.phone.replace(/\D/g, "").replace(/^0+/, "") : "";
    const emailRaw = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw.slice(0, 254) : null;
    const leadType = raw.leadType === "proprietario" ? "proprietario" : "comprador";
    const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 1000) : "";
    if (!name || (phone.length < 10 && !email) || (phone && existing.has(phone))) {
      skipped += 1;
      continue;
    }
    if (phone) existing.add(phone);
    const id = crypto.randomUUID();
    const contactId = await upsertContactRow(env, { name, phone: phone || null, email, role: "cliente", source: "importado", at: now });
    const data = { eventId: null, tracking: {}, imported: true, notes: note, history: [{ to: "fechado", at: now, imported: true }] };
    statements.push(env.DB.prepare(
      `INSERT INTO leads (id, ref, kind, lead_type, stage, name, phone, email, property_id, property_title, value, contact_id, data, created_at, updated_at)
       VALUES (?, ?, 'importado', ?, 'fechado', ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)`,
    ).bind(id, makeRef() + "-" + id.slice(0, 4).toUpperCase(), leadType, name, phone, email, "Cliente antigo", contactId, JSON.stringify(data), now, now));
    imported += 1;
  }
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  return { status: 200, body: { ok: true, imported, skipped } };
}

// CSV no formato aceito pelo upload de público personalizado da Meta
// (a Meta criptografa na hora do envio). Inclui todos os negócios fechados.
export async function audienceCsv(env) {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    "SELECT name, phone, email FROM leads WHERE stage = 'fechado' ORDER BY created_at",
  ).all();
  const esc = v => `"${String(v || "").replace(/"/g, '""')}"`;
  const lines = ["email,phone,fn,ln,country"];
  for (const r of result.results) {
    const parts = String(r.name || "").trim().toLowerCase().split(/\s+/);
    const phone = r.phone ? normalizePhone(r.phone) : "";
    lines.push([r.email || "", phone, parts[0] || "", parts.length > 1 ? parts[parts.length - 1] : "", "br"].map(esc).join(","));
  }
  return "\uFEFF" + lines.join("\n") + "\n";
}

export async function deleteLead(env, id) {
  await ensureSchema(env);
  const result = await env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM lead_events WHERE lead_id = ?").bind(id).run();
  if (!result.meta.changes) return { status: 404, body: { error: { code: "lead_not_found", message: "Lead não encontrado." } } };
  return { status: 200, body: { ok: true } };
}

// ---------- Internos ----------

async function saveLead(request, env, ctx, input) {
  const now = new Date();
  const nowIso = now.toISOString();
  const phoneDigits = canonicalPhone(input.phone) || "";

  // Evita duplicar o mesmo contato clicando várias vezes no mesmo imóvel.
  const since = new Date(now.getTime() - DEDUP_WINDOW_MS).toISOString();
  const dup = await env.DB.prepare(
    `SELECT id, ref, data FROM leads
      WHERE phone = ? AND kind = ? AND COALESCE(property_id, '') = ? AND created_at > ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(phoneDigits, input.kind, input.propertyId || "", since).first();
  if (dup) {
    const d = safeJson(dup.data);
    return { id: dup.id, ref: dup.ref, eventId: d.eventId, duplicate: true };
  }

  // Mesma pessoa com negócio em aberto: não abre outro, registra o novo interesse.
  const { contactId, openLead } = await attachLeadToContact(env, {
    name: input.name, phone: phoneDigits, email: input.email, leadType: input.leadType, kind: input.kind,
  });
  const origin = input.origin || originLabel(input.tracking || {});
  if (openLead) {
    await env.DB.prepare("UPDATE leads SET updated_at = ? WHERE id = ?").bind(nowIso, openLead.id).run();
    await afterLeadSaved(env, ctx, { contactId, leadId: openLead.id, ref: openLead.ref, isNew: false, input: { ...input, origin } });
    return { id: openLead.id, ref: openLead.ref, eventId: openLead.eventId, duplicate: true };
  }

  const id = crypto.randomUUID();
  const eventId = input.tracking.eventId || `lead:${id}`;
  const cookieFbc = readRequestCookie(request, "_fbc");
  const cookieFbp = readRequestCookie(request, "_fbp");
  const resolvedFbc = input.tracking.fbc
    || cookieFbc
    || (input.tracking.fbclid ? `fb.1.${now.getTime()}.${input.tracking.fbclid}` : null);
  const resolvedFbp = input.tracking.fbp || cookieFbp || null;
  const data = {
    eventId,
    origin,
    tracking: {
      ...input.tracking,
      ...(resolvedFbc ? { fbc: resolvedFbc } : {}),
      ...(resolvedFbp ? { fbp: resolvedFbp } : {}),
      clientIp: request.headers.get("CF-Connecting-IP") || null,
      userAgent: (request.headers.get("User-Agent") || "").slice(0, 500) || null,
    },
    ...input.extra,
    history: [{ to: "novo", at: nowIso }],
  };

  let ref;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ref = makeRef();
    try {
      await env.DB.prepare(
        `INSERT INTO leads (id, ref, kind, lead_type, stage, name, phone, email, property_id, property_title, value, contact_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'novo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, ref, input.kind, input.leadType, input.name, phoneDigits, input.email || null,
        input.propertyId || null, input.propertyTitle || null, input.value ?? null, contactId,
        JSON.stringify(data), nowIso, nowIso,
      ).run();
      break;
    } catch (err) {
      if (attempt === 4 || !String(err && err.message).includes("UNIQUE")) throw err;
    }
  }

  const lead = {
    id, ref, kind: input.kind, lead_type: input.leadType, stage: "novo", name: input.name,
    phone: phoneDigits, email: input.email, property_id: input.propertyId, property_title: input.propertyTitle,
    value: input.value, data,
  };
  ctx.waitUntil(sendAndLog(env, lead, {
    eventName: "Lead",
    eventId,
    actionSource: "website",
    stage: "novo",
  }));

  try {
    await afterLeadSaved(env, ctx, { contactId, leadId: id, ref, isNew: true, input: { ...input, origin } });
  } catch (err) {
    console.error("afterLeadSaved failed", err);
  }

  return { id, ref, eventId };
}

// Negócio criado pelo painel ou pelo agente (sem evento de Lead para a Meta).
export async function createManualLead(env, { contactId, name, phone, email, leadType, kind = "manual" }) {
  await ensureSchema(env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const data = { eventId: null, tracking: {}, history: [{ to: "novo", at: now }] };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await env.DB.prepare(
        `INSERT INTO leads (id, ref, kind, lead_type, stage, name, phone, email, property_id, property_title, value, contact_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'novo', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
      ).bind(id, makeRef(), kind, leadType, name, canonicalPhone(phone) || "", email || null, contactId, JSON.stringify(data), now, now).run();
      return id;
    } catch (err) {
      if (attempt === 4 || !String(err && err.message).includes("UNIQUE")) throw err;
    }
  }
  return id;
}

// Lead qualificado vindo do Instagram Direct: grava/atualiza o negócio, envia Lead e QualifiedLead à Meta CAPI (sem duplicar).
export async function saveDirectLead(env, ctx, {
  contactId,
  openLead = null,
  externalId,
  name,
  phone = "",
  leadType = "comprador",
  propertyId = null,
  propertyTitle = null,
  goal = "",
  budgetFit = "",
  adTitle = "",
  summary = "",
}) {
  await ensureSchema(env);
  const now = new Date().toISOString();
  const phoneDigits = canonicalPhone(phone) || "";
  const tracking = {
    utm_source: adTitle ? "instagram_ad" : "instagram_direct",
    ...(adTitle ? { utm_campaign: String(adTitle).slice(0, 200) } : {}),
  };

  let leadId = "";
  let ref = "";
  let data = {};
  let isNew = false;
  let shouldNotify = false;
  let finalName = name || "Contato Instagram";
  let finalPhone = phoneDigits;
  let finalPropId = propertyId || null;
  let finalPropTitle = propertyTitle || null;

  const existingRow = openLead && openLead.id
    ? await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(openLead.id).first()
    : null;

  if (existingRow) {
    leadId = existingRow.id;
    ref = existingRow.ref;
    data = safeJson(existingRow.data);
    data.tracking = { ...(data.tracking || {}), ...tracking };
    if (!data.eventId) data.eventId = `ig:${leadId}`;
    data.igUserId = externalId;
    if (goal) data.goal = goal;
    if (budgetFit) data.budgetFit = budgetFit;
    if (summary) data.notes = summary;

    let stage = existingRow.stage;
    if (stage === "novo" || stage === "contatado") {
      data.history = Array.isArray(data.history) ? data.history.slice(-50) : [];
      data.history.push({ from: stage, to: "qualificado", at: now });
      stage = "qualificado";
    }
    finalName = name && name !== "Contato Instagram" ? name : existingRow.name;
    finalPhone = phoneDigits || existingRow.phone || "";
    finalPropId = propertyId || existingRow.property_id || null;
    finalPropTitle = propertyTitle || existingRow.property_title || null;
    shouldNotify = !data.notifiedAt;
    if (shouldNotify) data.notifiedAt = now;

    await env.DB.prepare(
      `UPDATE leads SET kind = CASE WHEN kind = 'manual' THEN 'instagram' ELSE kind END,
         name = ?, phone = ?, property_id = ?, property_title = ?, stage = ?, data = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(finalName, finalPhone, finalPropId, finalPropTitle, stage, JSON.stringify(data), now, leadId).run();
  } else {
    isNew = true;
    shouldNotify = true;
    leadId = crypto.randomUUID();
    const eventId = `ig:${leadId}`;
    data = {
      eventId,
      tracking,
      igUserId: externalId,
      goal: goal || null,
      budgetFit: budgetFit || null,
      notes: summary || "",
      notifiedAt: now,
      history: [{ to: "qualificado", at: now }],
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      ref = makeRef();
      try {
        await env.DB.prepare(
          `INSERT INTO leads (id, ref, kind, lead_type, stage, name, phone, email, property_id, property_title, value, contact_id, data, created_at, updated_at)
           VALUES (?, ?, 'instagram', ?, 'qualificado', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
        ).bind(
          leadId, ref, leadType, finalName, finalPhone, finalPropId, finalPropTitle,
          contactId, JSON.stringify(data), now, now,
        ).run();
        break;
      } catch (err) {
        if (attempt === 4 || !String(err && err.message).includes("UNIQUE")) throw err;
      }
    }
  }

  const leadObj = {
    id: leadId,
    ref,
    kind: "instagram",
    lead_type: leadType,
    stage: "qualificado",
    name: finalName,
    phone: finalPhone,
    email: null,
    property_id: finalPropId,
    property_title: finalPropTitle,
    value: null,
    data,
  };

  const sentRows = await env.DB.prepare(
    "SELECT event_name FROM lead_events WHERE lead_id = ? AND meta_status = 'sent'",
  ).bind(leadId).all();
  const sentSet = new Set((sentRows.results || []).map(r => r.event_name));
  const pendingEvents = [];
  if (!sentSet.has("Lead")) {
    pendingEvents.push(sendAndLog(env, leadObj, {
      eventName: "Lead",
      eventId: data.eventId || `ig:${leadId}`,
      actionSource: "system_generated",
      stage: "qualificado",
    }));
  }
  if (!sentSet.has("QualifiedLead")) {
    pendingEvents.push(sendAndLog(env, leadObj, {
      eventName: "QualifiedLead",
      eventId: `${leadId}:QualifiedLead`,
      actionSource: "system_generated",
      stage: "qualificado",
    }));
  }
  if (pendingEvents.length) {
    ctx.waitUntil(Promise.all(pendingEvents));
  }

  return { id: leadId, ref, isNew, shouldNotify };
}

async function sendAndLog(env, lead, { eventName, eventId, actionSource, stage }) {
  let status = "skipped";
  let responseText = "META_PIXEL_ID/META_CAPI_TOKEN não configurados";

  try {
    if (env.META_PIXEL_ID && env.META_CAPI_TOKEN) {
      const payload = await buildEvent(lead, { eventName, eventId, actionSource });
      const body = { data: [payload] };
      if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;
      const version = env.META_GRAPH_VERSION || "v23.0";
      const res = await fetch(
        `${env.META_GRAPH_BASE || "https://graph.facebook.com"}/${version}/${encodeURIComponent(env.META_PIXEL_ID)}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      responseText = (await res.text()).slice(0, 2000);
      status = res.ok ? "sent" : "error";
    }
  } catch (err) {
    status = "error";
    responseText = String(err && err.message || err).slice(0, 2000);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO lead_events (id, lead_id, event_name, stage, meta_status, meta_response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), lead.id, eventName, stage || null, status, responseText, new Date().toISOString()).run();
  } catch (err) {
    console.error("lead_events log failed", err);
  }
}

async function buildEvent(lead, { eventName, eventId, actionSource }) {
  const t = (lead.data && lead.data.tracking) || {};
  const [firstName, ...rest] = String(lead.name || "").trim().toLowerCase().split(/\s+/);
  const lastName = rest.length ? rest[rest.length - 1] : "";

  const normPhone = lead.phone ? normalizePhone(lead.phone) : "";
  const userData = {
    external_id: [await sha256(lead.id)],
    country: [await sha256("br")],
  };
  if (normPhone.length >= 10) userData.ph = [await sha256(normPhone)];
  if (lead.email) userData.em = [await sha256(String(lead.email).trim().toLowerCase())];
  if (firstName) userData.fn = [await sha256(firstName)];
  if (lastName) userData.ln = [await sha256(lastName)];
  if (t.fbc) userData.fbc = t.fbc;
  if (t.fbp) userData.fbp = t.fbp;
  if (actionSource === "website") {
    if (t.clientIp) userData.client_ip_address = t.clientIp;
    if (t.userAgent) userData.client_user_agent = t.userAgent;
  }

  const customData = {
    lead_type: lead.lead_type,
    lead_source: lead.kind,
    currency: "BRL",
  };
  if (lead.property_id) {
    customData.content_ids = [lead.property_id];
    customData.content_type = "product";
  }
  if (lead.property_title) customData.content_name = lead.property_title;
  if (lead.data && lead.data.interest) customData.interest = lead.data.interest;
  if (lead.data && lead.data.cta) customData.cta = lead.data.cta;
  // Valor só no fechamento, para não inflar o retorno com preço de imóvel em leads.
  if (eventName === "Purchase" && lead.value != null) customData.value = Number(lead.value);

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: actionSource,
    user_data: userData,
    custom_data: customData,
  };
  if (actionSource === "website" && t.pageUrl) event.event_source_url = t.pageUrl;
  return event;
}

function validateLeadInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Corpo inválido." };
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const phone = typeof value.phone === "string" ? value.phone.trim() : "";
  if (!name || name.length > 120) return { error: "Informe seu nome." };
  const digits = canonicalPhone(phone);
  if (!digits) return { error: "Informe um WhatsApp vÃ¡lido." };
  if (digits.length < 10 || digits.length > 13) return { error: "Informe um WhatsApp válido com DDD." };

  const leadType = value.leadType === "proprietario" ? "proprietario" : "comprador";
  const context = typeof value.context === "string" ? value.context.slice(0, 40) : "geral";
  const interest = ["comprar", "vender", "avaliar"].includes(value.interest) ? value.interest : null;
  const cta = typeof value.cta === "string" && /^[a-z0-9-]{1,40}$/.test(value.cta) ? value.cta : null;
  const propertyId = typeof value.propertyId === "string" && value.propertyId.length <= 200 ? value.propertyId : null;
  const propertyTitle = typeof value.propertyTitle === "string" ? value.propertyTitle.slice(0, 200) : null;
  const num = Number(value.value);
  const leadValue = Number.isFinite(num) && num > 0 && num < 1e10 ? num : null;
  const simulation = sanitizeSimulation(value.simulation);

  return {
    value: {
      name, phone: digits, leadType, context, interest, cta, propertyId, propertyTitle, value: leadValue, simulation,
      tracking: sanitizeTracking(value.tracking),
      viewed: Array.isArray(value.viewed) ? value.viewed.filter(x => typeof x === "string" && x.length <= 200).slice(0, 20) : [],
    },
  };
}

function sanitizeSimulation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value.id) ? value.id : null;
  const fields = ["propertyValue", "entry", "fgts", "exchange", "financed", "termYears", "annualRateEffective", "sacFirst", "sacLast", "priceFirst", "priceLast", "minimumIncome"];
  const out = id ? { id } : {};
  for (const field of fields) {
    const number = Number(value[field]);
    if (Number.isFinite(number) && number >= 0 && number < 1e12) out[field] = number;
  }
  if (typeof value.usesFgts === "boolean") out.usesFgts = value.usesFgts;
  if (typeof value.hasExchange === "boolean") out.hasExchange = value.hasExchange;
  return Object.keys(out).length ? out : null;
}

function sanitizeTracking(t) {
  const out = {};
  if (!t || typeof t !== "object") return out;
  const fields = {
    eventId: 100, fbc: 500, fbp: 200, fbclid: 500, gclid: 500, pageUrl: 1000, referrer: 1000, landingPage: 1000,
    utm_source: 200, utm_medium: 200, utm_campaign: 200, utm_content: 200, utm_term: 200, firstSeen: 40,
  };
  for (const [k, max] of Object.entries(fields)) {
    if (typeof t[k] === "string" && t[k].trim()) out[k] = t[k].trim().slice(0, max);
  }
  return out;
}

function readRequestCookie(request, name) {
  const header = request && request.headers && request.headers.get("Cookie");
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match) return null;
  try {
    const val = decodeURIComponent(match[1]).trim();
    return val ? val.slice(0, 500) : null;
  } catch {
    return null;
  }
}

function normalizePhone(digits) {
  const d = String(digits).replace(/\D/g, "").replace(/^0+/, "");
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

function makeRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return "EBV-" + Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(text)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
