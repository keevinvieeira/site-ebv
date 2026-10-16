// Leads (base do CRM) + envio de eventos para a Meta via Conversions API.
// Tudo que depende da Meta é opcional: sem META_PIXEL_ID / META_CAPI_TOKEN o lead
// é salvo normalmente e o evento fica registrado como "skipped".

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

// Mesmo conteúdo de migrations/0002_leads.sql; garante as tabelas mesmo sem rodar a migration.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads ( id TEXT PRIMARY KEY NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, lead_type TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'novo', name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, property_id TEXT, property_title TEXT, value REAL, data TEXT NOT NULL CHECK (json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_ref ON leads (ref)`,
  `CREATE TABLE IF NOT EXISTS lead_events ( id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL, event_name TEXT NOT NULL, stage TEXT, meta_status TEXT NOT NULL, meta_response TEXT, created_at TEXT NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events (lead_id, created_at)`,
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql))).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ---------- API pública ----------

export async function postLead(request, env, ctx, body) {
  await ensureSchema(env);
  const v = validateLeadInput(body);
  if (v.error) return { status: 400, body: { error: { code: "invalid_field", message: v.error } } };

  const lead = await saveLead(request, env, ctx, {
    kind: "whatsapp",
    leadType: v.value.leadType,
    name: v.value.name,
    phone: v.value.phone,
    email: null,
    propertyId: v.value.propertyId,
    propertyTitle: v.value.propertyTitle,
    value: v.value.value,
    tracking: v.value.tracking,
    extra: { context: v.value.context },
  });
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
    extra: { appraisalId: appraisal.id, area: appraisal.area, details: appraisal.details },
  });
}

export async function listLeads(env) {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    `SELECT id, ref, kind, lead_type, stage, name, phone, email, property_id, property_title, value, data, created_at, updated_at
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
      notes: data.notes || "",
      origin: originLabel(data.tracking || {}),
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
  await env.DB.prepare("UPDATE leads SET stage = ?, value = ?, data = ?, updated_at = ? WHERE id = ?")
    .bind(stage, value, JSON.stringify(data), now, id).run();

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
  const phoneDigits = input.phone.replace(/\D/g, "");

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

  const id = crypto.randomUUID();
  const eventId = input.tracking.eventId || `lead:${id}`;
  const data = {
    eventId,
    tracking: {
      ...input.tracking,
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
        `INSERT INTO leads (id, ref, kind, lead_type, stage, name, phone, email, property_id, property_title, value, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'novo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, ref, input.kind, input.leadType, input.name, phoneDigits, input.email || null,
        input.propertyId || null, input.propertyTitle || null, input.value ?? null,
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

  return { id, ref, eventId };
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

  const userData = {
    ph: [await sha256(normalizePhone(lead.phone))],
    external_id: [await sha256(lead.id)],
    country: [await sha256("br")],
  };
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
    customData.content_type = "home_listing";
  }
  if (lead.property_title) customData.content_name = lead.property_title;
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
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return { error: "Informe um WhatsApp válido com DDD." };

  const leadType = value.leadType === "proprietario" ? "proprietario" : "comprador";
  const context = typeof value.context === "string" ? value.context.slice(0, 40) : "geral";
  const propertyId = typeof value.propertyId === "string" && value.propertyId.length <= 200 ? value.propertyId : null;
  const propertyTitle = typeof value.propertyTitle === "string" ? value.propertyTitle.slice(0, 200) : null;
  const num = Number(value.value);
  const leadValue = Number.isFinite(num) && num > 0 && num < 1e10 ? num : null;

  return {
    value: {
      name, phone, leadType, context, propertyId, propertyTitle, value: leadValue,
      tracking: sanitizeTracking(value.tracking),
    },
  };
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

function originLabel(t) {
  if (t.fbclid || t.fbc || /facebook|instagram|meta|^fb$|^ig$/i.test(t.utm_source || "")) {
    return t.utm_campaign ? `Meta Ads (${t.utm_campaign})` : "Meta / Instagram";
  }
  if (t.gclid || /google/i.test(t.utm_source || "")) return "Google";
  if (t.utm_source) return t.utm_source;
  if (t.referrer && /instagram/i.test(t.referrer)) return "Instagram";
  if (t.referrer) {
    try { return new URL(t.referrer).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  }
  return "Direto";
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

function safeJson(text) {
  try { return JSON.parse(text) || {}; } catch { return {}; }
}
