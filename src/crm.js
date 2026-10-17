// CRM da EBV: contatos, perfil de busca, tarefas, linha do tempo, match de imóveis,
// avisos de lead novo e API para automação (agente de WhatsApp).
import { ensureSchema, upsertContactRow, canonicalPhone, safeJson } from "./schema.js";

const OPEN_STAGES = ["novo", "contatado", "qualificado", "visita", "proposta"];
const PROFILE_FIELDS = {
  tipos: "list",        // apartamento, casa, sobrado, cobertura, terreno
  bairros: "list",
  precoMin: "number",
  precoMax: "number",
  quartosMin: "number",
  vagasMin: "number",
  pagamento: "text",    // financiamento, à vista, FGTS, permuta
  prazo: "text",        // imediato, 3 meses, 6 meses, sem pressa
  obs: "text",
};

// ---------- Ganchos chamados pela captação de leads ----------

// Liga o lead novo a um contato, registra na linha do tempo, cria tarefa de resposta
// e decide se é um negócio novo ou continuação de um negócio aberto.
export async function attachLeadToContact(env, input) {
  const contactId = await upsertContactRow(env, {
    name: input.name,
    phone: input.phone,
    email: input.email,
    role: input.leadType,
    source: input.kind,
  });

  const open = await env.DB.prepare(
    `SELECT id, ref, data FROM leads WHERE contact_id = ? AND lead_type = ? AND stage IN (${OPEN_STAGES.map(() => "?").join(",")})
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(contactId, input.leadType, ...OPEN_STAGES).first();

  return { contactId, openLead: open ? { id: open.id, ref: open.ref, eventId: safeJson(open.data).eventId } : null };
}

export async function afterLeadSaved(env, ctx, { contactId, leadId, ref, isNew, input }) {
  const now = new Date().toISOString();
  const what = input.propertyTitle ? `Interesse em: ${input.propertyTitle}` : input.kind === "avaliacao" ? "Pediu avaliação de imóvel" : "Chamou no WhatsApp pelo site";
  await addActivity(env, {
    contactId,
    leadId,
    type: isNew ? "lead" : "interesse",
    text: what,
    data: {
      ref,
      origin: input.origin || null,
      propertyId: input.propertyId || null,
      viewed: Array.isArray(input.viewed) ? input.viewed.slice(0, 20) : [],
    },
  });
  await env.DB.prepare("UPDATE contacts SET last_activity_at = ? WHERE id = ?").bind(now, contactId).run();

  const hasOpenTask = await env.DB.prepare(
    "SELECT 1 FROM tasks WHERE contact_id = ? AND done_at IS NULL LIMIT 1",
  ).bind(contactId).first();
  if (!hasOpenTask) {
    await createTask(env, {
      contactId,
      leadId,
      title: input.kind === "avaliacao" ? `Ligar para ${firstName(input.name)} e agendar a avaliação` : `Responder ${firstName(input.name)} no WhatsApp`,
      dueAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      origin: "auto",
    });
  }

  ctx.waitUntil(notify(env, {
    subject: `${isNew ? "Lead novo" : "Lead voltou"}: ${input.name} (${input.leadType === "proprietario" ? "proprietário" : "comprador"})`,
    lines: [
      `Nome: ${input.name}`,
      `WhatsApp: https://wa.me/55${canonicalPhone(input.phone) || ""}`,
      input.email ? `E-mail: ${input.email}` : null,
      what,
      input.origin ? `Origem: ${input.origin}` : null,
      `Código: ${ref}`,
    ],
  }));
}

export async function afterStageChange(env, { leadId, contactId, from, to, lostReason }) {
  if (!contactId) return;
  const labels = { novo: "Novo", contatado: "Contatado", qualificado: "Qualificado", visita: "Visita agendada", proposta: "Proposta", fechado: "Fechado", perdido: "Perdido" };
  await addActivity(env, {
    contactId,
    leadId,
    type: "etapa",
    text: `Etapa: ${labels[from] || from} → ${labels[to] || to}${to === "perdido" && lostReason ? ` (${lostReason})` : ""}`,
    data: { from, to },
  });
  if (to === "fechado") {
    const row = await env.DB.prepare("SELECT roles FROM contacts WHERE id = ?").bind(contactId).first();
    const roles = new Set(safeJson(row && row.roles, []));
    roles.add("cliente");
    await env.DB.prepare("UPDATE contacts SET roles = ? WHERE id = ?").bind(JSON.stringify([...roles]), contactId).run();
  }
  if (to === "fechado" || to === "perdido") {
    await env.DB.prepare(
      "UPDATE tasks SET done_at = ? WHERE done_at IS NULL AND origin = 'auto' AND (lead_id = ? OR (lead_id IS NULL AND contact_id = ?))",
    ).bind(new Date().toISOString(), leadId, contactId).run();
  }
}

// Imóveis cadastrados agora: procura compradores com perfil compatível.
export async function afterPropertiesSaved(env, ctx, previousIds, properties) {
  await ensureSchema(env);
  const fresh = properties.filter(p => p && p.id && !previousIds.has(p.id));
  if (!fresh.length) return;
  const buyers = await activeBuyers(env);
  const summary = [];
  for (const prop of fresh) {
    const matches = buyers.filter(b => matchScore(b.profile, prop) > 0);
    for (const b of matches) {
      await addActivity(env, { contactId: b.id, type: "match", text: `Imóvel novo compatível: ${prop.title}`, data: { propertyId: prop.id } });
      await createTask(env, {
        contactId: b.id,
        title: `Enviar "${prop.title}" para ${firstName(b.name)}`,
        dueAt: new Date().toISOString(),
        origin: "auto",
      });
    }
    if (matches.length) summary.push(`${prop.title}: ${matches.map(m => m.name).join(", ")}`);
  }
  if (summary.length) {
    ctx.waitUntil(notify(env, { subject: "Imóvel novo tem compradores compatíveis", lines: summary }));
  }
}

// ---------- API do painel (admin) ----------

export async function handleCrmAdmin(request, env, ctx, path, method, readBody, helpers) {
  await ensureSchema(env);
  const url = new URL(request.url);

  if (path === "/api/admin/crm/overview" && method === "GET") {
    return ok(await overview(env));
  }

  if (path === "/api/admin/crm/contacts" && method === "GET") {
    return ok(await listContacts(env, url.searchParams.get("q") || ""));
  }

  if (path === "/api/admin/crm/contacts" && method === "POST") {
    const body = await readBody();
    if (body.error) return body.error;
    const b = body.value || {};
    const name = str(b.name, 120);
    const phone = canonicalPhone(b.phone);
    if (!name || (!phone && !b.email)) return bad("Informe nome e telefone ou e-mail.");
    const contactId = await upsertContactRow(env, { name, phone, email: str(b.email, 254) || null, role: b.role === "proprietario" ? "proprietario" : "comprador", source: "manual" });
    if (b.createDeal !== false) {
      const leadId = await helpers.createManualLead(env, { contactId, name, phone, email: str(b.email, 254) || null, leadType: b.role === "proprietario" ? "proprietario" : "comprador" });
      await addActivity(env, { contactId, leadId, type: "lead", text: "Cadastrado manualmente no CRM" });
    }
    return ok(await contactDetail(env, contactId), 201);
  }

  let m = path.match(/^\/api\/admin\/crm\/contacts\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === "GET") {
      const detail = await contactDetail(env, id);
      return detail ? ok(detail) : notFound();
    }
    if (method === "PATCH") {
      const body = await readBody();
      if (body.error) return body.error;
      const updated = await updateContact(env, id, body.value || {});
      return updated ? ok(await contactDetail(env, id)) : notFound();
    }
  }

  m = path.match(/^\/api\/admin\/crm\/contacts\/([^/]+)\/notes$/);
  if (m && method === "POST") {
    const body = await readBody();
    if (body.error) return body.error;
    const text = str(body.value && body.value.text, 4000);
    if (!text) return bad("Escreva a anotação.");
    const id = decodeURIComponent(m[1]);
    await addActivity(env, { contactId: id, type: "nota", text });
    return ok(await contactDetail(env, id), 201);
  }

  if (path === "/api/admin/crm/tasks" && method === "POST") {
    const body = await readBody();
    if (body.error) return body.error;
    const b = body.value || {};
    const title = str(b.title, 300);
    if (!title) return bad("Descreva a tarefa.");
    const due = b.dueAt && !Number.isNaN(Date.parse(b.dueAt)) ? new Date(b.dueAt).toISOString() : new Date().toISOString();
    const id = await createTask(env, { contactId: str(b.contactId, 100) || null, leadId: str(b.leadId, 100) || null, title, dueAt: due, origin: "manual" });
    return ok({ id }, 201);
  }

  m = path.match(/^\/api\/admin\/crm\/tasks\/([^/]+)$/);
  if (m && method === "PATCH") {
    const body = await readBody();
    if (body.error) return body.error;
    const b = body.value || {};
    const id = decodeURIComponent(m[1]);
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
    if (!task) return notFound();
    if (b.done !== undefined) {
      const doneAt = b.done ? new Date().toISOString() : null;
      await env.DB.prepare("UPDATE tasks SET done_at = ? WHERE id = ?").bind(doneAt, id).run();
      if (b.done && task.contact_id) await addActivity(env, { contactId: task.contact_id, leadId: task.lead_id, type: "tarefa", text: `Feito: ${task.title}` });
    }
    if (b.dueAt && !Number.isNaN(Date.parse(b.dueAt))) {
      await env.DB.prepare("UPDATE tasks SET due_at = ? WHERE id = ?").bind(new Date(b.dueAt).toISOString(), id).run();
    }
    return ok({ ok: true });
  }

  m = path.match(/^\/api\/admin\/crm\/matches\/property\/([^/]+)$/);
  if (m && method === "GET") {
    const prop = await getProperty(env, decodeURIComponent(m[1]));
    if (!prop) return notFound();
    const buyers = await activeBuyers(env);
    return ok(buyers.map(b => ({ id: b.id, name: b.name, phone: b.phone, score: matchScore(b.profile, prop) }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score));
  }

  return null;
}

// ---------- API de automação (agente de WhatsApp) ----------
// Autenticação: header "Authorization: Bearer <AGENT_TOKEN>".

export async function handleAgentApi(request, env, ctx, path, method, readBody, helpers) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.AGENT_TOKEN || env.AGENT_TOKEN.length < 24 || auth !== `Bearer ${env.AGENT_TOKEN}`) {
    return json({ error: { code: "unauthorized", message: "Token inválido." } }, 401);
  }
  await ensureSchema(env);
  const url = new URL(request.url);

  if (path === "/api/agent/contact" && method === "GET") {
    const phone = canonicalPhone(url.searchParams.get("phone"));
    if (!phone) return bad("Informe phone.");
    const row = await env.DB.prepare("SELECT id FROM contacts WHERE phone = ?").bind(phone).first();
    return row ? ok(await contactDetail(env, row.id)) : notFound();
  }

  if (path === "/api/agent/contact" && method === "POST") {
    const body = await readBody();
    if (body.error) return body.error;
    const b = body.value || {};
    const phone = canonicalPhone(b.phone);
    if (!phone) return bad("Informe phone.");
    const leadType = b.leadType === "proprietario" ? "proprietario" : "comprador";
    const name = str(b.name, 120) || "Contato WhatsApp";
    const { contactId, openLead } = await attachLeadToContact(env, { name, phone, email: str(b.email, 254) || null, leadType, kind: "whatsapp" });

    let leadId = openLead && openLead.id;
    if (!leadId) {
      leadId = await helpers.createManualLead(env, { contactId, name, phone, email: str(b.email, 254) || null, leadType, kind: "agente" });
      await addActivity(env, { contactId, leadId, type: "lead", text: "Contato iniciado pelo WhatsApp (agente)" });
    }
    if (b.profile) await updateContact(env, contactId, { profile: b.profile });
    if (b.note) await addActivity(env, { contactId, leadId, type: "nota", text: `[agente] ${str(b.note, 4000)}` });
    if (b.task && b.task.title) {
      await createTask(env, { contactId, leadId, title: str(b.task.title, 300), dueAt: b.task.dueAt && !Number.isNaN(Date.parse(b.task.dueAt)) ? new Date(b.task.dueAt).toISOString() : new Date().toISOString(), origin: "agente" });
    }
    if (b.stage) {
      const res = await helpers.updateLead(request, env, ctx, leadId, { stage: b.stage, lostReason: b.lostReason });
      if (res.status !== 200) return json(res.body, res.status);
    }
    return ok(await contactDetail(env, contactId));
  }

  return notFound();
}

// ---------- Feed do catálogo para a Meta ----------

export async function catalogCsv(env, origin) {
  const rows = await env.DB.prepare("SELECT data FROM properties ORDER BY sort_order ASC").all();
  const head = ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "additional_image_link", "brand", "custom_label_0", "custom_label_1"];
  const esc = v => `"${String(v == null ? "" : v).replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const lines = [head.join(",")];
  for (const r of rows.results) {
    const p = safeJson(r.data);
    if (!p.id || !p.price) continue;
    const images = (Array.isArray(p.images) && p.images.length ? p.images : [p.image]).filter(Boolean).map(src => absolute(src, origin));
    if (!images.length) continue;
    const title = String(p.title || "Imóvel").slice(0, 150);
    const desc = String(p.desc || title).replace(/\s+/g, " ").slice(0, 5000);
    lines.push([
      p.id,
      title,
      desc,
      p.sold || p.status === "vendido" ? "out of stock" : "in stock",
      "new",
      `${Number(p.price).toFixed(2)} BRL`,
      `${origin}/imovel/${encodeURIComponent(p.id)}/${slug(title)}`,
      images[0],
      images.slice(1, 10).join(","),
      "EBV Imóveis",
      p.type || "",
      p.location || "",
    ].map(esc).join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------- Internos ----------

async function overview(env) {
  const now = new Date();
  const sp = new Date(now.getTime() - 3 * 3600000); // horário de São Paulo (UTC-3)
  const endToday = new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate(), 23, 59, 59) + 3 * 3600000);
  const tasks = await env.DB.prepare(
    `SELECT t.*, c.name AS contact_name, c.phone AS contact_phone FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.done_at IS NULL AND t.due_at <= ? ORDER BY t.due_at ASC LIMIT 200`,
  ).bind(endToday.toISOString()).all();
  const upcoming = await env.DB.prepare(
    `SELECT t.*, c.name AS contact_name, c.phone AS contact_phone FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE t.done_at IS NULL AND t.due_at > ? ORDER BY t.due_at ASC LIMIT 50`,
  ).bind(endToday.toISOString()).all();
  const leads = await env.DB.prepare(
    `SELECT l.id, l.ref, l.kind, l.lead_type, l.stage, l.name, l.phone, l.property_title, l.value, l.contact_id, l.lost_reason, l.data, l.created_at, l.updated_at
       FROM leads l ORDER BY l.updated_at DESC LIMIT 1000`,
  ).all();
  const since30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const stats = { porEtapa: {}, porOrigem: {}, novos30d: 0, fechados30d: 0 };
  const deals = leads.results.map(l => {
    const data = safeJson(l.data);
    const origin = data.imported ? "Lista de clientes" : originLabel(data.tracking || {});
    stats.porEtapa[l.stage] = (stats.porEtapa[l.stage] || 0) + 1;
    if (l.created_at >= since30 && l.kind !== "importado") {
      stats.novos30d += 1;
      stats.porOrigem[origin] = (stats.porOrigem[origin] || 0) + 1;
    }
    if (l.stage === "fechado" && l.updated_at >= since30 && l.kind !== "importado") stats.fechados30d += 1;
    return {
      id: l.id, ref: l.ref, kind: l.kind, leadType: l.lead_type, stage: l.stage, name: l.name, phone: l.phone,
      propertyTitle: l.property_title, value: l.value, contactId: l.contact_id, lostReason: l.lost_reason,
      origin, createdAt: l.created_at, updatedAt: l.updated_at,
    };
  });
  return { today: tasks.results.map(taskOut), upcoming: upcoming.results.map(taskOut), deals, stats };
}

async function listContacts(env, q) {
  const term = q.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  let sql = "SELECT * FROM contacts";
  const binds = [];
  if (term) {
    sql += " WHERE lower(name) LIKE ? OR lower(COALESCE(email,'')) LIKE ?";
    binds.push(`%${term}%`, `%${term}%`);
    if (digits.length >= 4) { sql += " OR phone LIKE ?"; binds.push(`%${digits}%`); }
  }
  sql += " ORDER BY last_activity_at DESC LIMIT 500";
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const ids = rows.results.map(r => r.id);
  const stageByContact = {};
  if (ids.length) {
    const leads = await env.DB.prepare(
      `SELECT contact_id, stage, updated_at FROM leads WHERE contact_id IN (${ids.map(() => "?").join(",")}) ORDER BY updated_at DESC`,
    ).bind(...ids).all();
    for (const l of leads.results) if (!stageByContact[l.contact_id]) stageByContact[l.contact_id] = l.stage;
  }
  return rows.results.map(r => ({ ...contactOut(r), stage: stageByContact[r.id] || null }));
}

async function contactDetail(env, id) {
  const row = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first();
  if (!row) return null;
  const [leads, tasks, acts] = await Promise.all([
    env.DB.prepare("SELECT id, ref, kind, lead_type, stage, property_id, property_title, value, lost_reason, data, created_at, updated_at FROM leads WHERE contact_id = ? ORDER BY created_at DESC").bind(id).all(),
    env.DB.prepare("SELECT * FROM tasks WHERE contact_id = ? ORDER BY done_at IS NOT NULL, due_at ASC LIMIT 100").bind(id).all(),
    env.DB.prepare("SELECT * FROM activities WHERE contact_id = ? ORDER BY created_at DESC LIMIT 200").bind(id).all(),
  ]);
  const contact = contactOut(row);
  const props = await allProperties(env);
  const viewedIds = new Set();
  for (const a of acts.results) for (const v of safeJson(a.data).viewed || []) viewedIds.add(v);
  return {
    ...contact,
    deals: leads.results.map(l => ({
      id: l.id, ref: l.ref, kind: l.kind, leadType: l.lead_type, stage: l.stage, propertyId: l.property_id,
      propertyTitle: l.property_title, value: l.value, lostReason: l.lost_reason,
      origin: safeJson(l.data).imported ? "Lista de clientes" : originLabel(safeJson(l.data).tracking || {}),
      createdAt: l.created_at, updatedAt: l.updated_at,
    })),
    tasks: tasks.results.map(taskOut),
    timeline: acts.results.map(a => ({ id: a.id, type: a.type, text: a.text, leadId: a.lead_id, data: safeJson(a.data), createdAt: a.created_at })),
    viewedProperties: props.filter(p => viewedIds.has(p.id)).map(p => ({ id: p.id, title: p.title, price: p.price })),
    matches: contact.roles.includes("comprador")
      ? props.map(p => ({ id: p.id, title: p.title, price: p.price, location: p.location, score: matchScore(contact.profile, p) }))
        .filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 10)
      : [],
  };
}

async function updateContact(env, id, b) {
  const row = await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first();
  if (!row) return false;
  const name = b.name !== undefined ? str(b.name, 120) || row.name : row.name;
  const email = b.email !== undefined ? (str(b.email, 254) || null) : row.email;
  let phone = row.phone;
  if (b.phone !== undefined) {
    const p = canonicalPhone(b.phone);
    if (p && p !== row.phone) {
      const clash = await env.DB.prepare("SELECT 1 FROM contacts WHERE phone = ? AND id != ?").bind(p, id).first();
      if (!clash) phone = p;
    }
  }
  const notes = b.notes !== undefined ? String(b.notes || "").slice(0, 8000) : row.notes;
  const tags = Array.isArray(b.tags) ? b.tags.map(t => str(t, 40)).filter(Boolean).slice(0, 20) : safeJson(row.tags, []);
  let roles = safeJson(row.roles, []);
  if (Array.isArray(b.roles)) roles = b.roles.filter(r => ["comprador", "proprietario", "cliente"].includes(r));
  const profile = b.profile !== undefined ? { ...safeJson(row.profile), ...cleanProfile(b.profile) } : safeJson(row.profile);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE contacts SET name = ?, email = ?, phone = ?, notes = ?, tags = ?, roles = ?, profile = ?, updated_at = ? WHERE id = ?",
  ).bind(name, email, phone, notes, JSON.stringify(tags), JSON.stringify(roles), JSON.stringify(profile), now, id).run();
  if (b.profile !== undefined) {
    await addActivity(env, { contactId: id, type: "perfil", text: `Perfil de busca atualizado: ${profileSummary(profile)}` });
  }
  return true;
}

function cleanProfile(p) {
  const out = {};
  if (!p || typeof p !== "object") return out;
  for (const [k, kind] of Object.entries(PROFILE_FIELDS)) {
    if (p[k] === undefined) continue;
    if (p[k] === null || p[k] === "") { out[k] = null; continue; }
    if (kind === "list") {
      const arr = Array.isArray(p[k]) ? p[k] : String(p[k]).split(",");
      out[k] = arr.map(v => str(v, 60).toLowerCase()).filter(Boolean).slice(0, 20);
    } else if (kind === "number") {
      const n = Number(String(p[k]).replace(/\./g, "").replace(",", "."));
      out[k] = Number.isFinite(n) && n >= 0 ? n : null;
    } else {
      out[k] = str(p[k], 500) || null;
    }
  }
  return out;
}

export function profileSummary(p) {
  const parts = [];
  if (p.tipos && p.tipos.length) parts.push(p.tipos.join("/"));
  if (p.bairros && p.bairros.length) parts.push(p.bairros.join(", "));
  if (p.precoMin || p.precoMax) parts.push(`R$ ${p.precoMin ? brl(p.precoMin) : "0"} a ${p.precoMax ? brl(p.precoMax) : "?"}`);
  if (p.quartosMin) parts.push(`${p.quartosMin}+ quartos`);
  if (p.vagasMin) parts.push(`${p.vagasMin}+ vagas`);
  if (p.pagamento) parts.push(p.pagamento);
  if (p.prazo) parts.push(p.prazo);
  return parts.join(" · ") || "vazio";
}

// 0 = não combina. Quanto maior, melhor. Perfil vazio não combina com nada.
export function matchScore(profile, prop) {
  const p = profile || {};
  const filled = ["tipos", "bairros", "precoMax", "precoMin", "quartosMin"].some(k => Array.isArray(p[k]) ? p[k].length : p[k]);
  if (!filled || !prop) return 0;
  let score = 1;
  const price = Number(prop.price) || 0;
  if (p.precoMax) { if (price > p.precoMax * 1.1) return 0; score += 2; }
  if (p.precoMin) { if (price < p.precoMin * 0.8) return 0; score += 1; }
  if (Array.isArray(p.tipos) && p.tipos.length) {
    if (!p.tipos.includes(String(prop.type || "").toLowerCase())) return 0;
    score += 2;
  }
  if (Array.isArray(p.bairros) && p.bairros.length) {
    const loc = norm(prop.location);
    if (!p.bairros.some(b => loc.includes(norm(b)))) return 0;
    score += 3;
  }
  if (p.quartosMin) { if ((Number(prop.beds) || 0) < p.quartosMin) return 0; score += 1; }
  if (p.vagasMin) { if ((Number(prop.vagas) || 0) < p.vagasMin) return 0; score += 1; }
  return score;
}

async function activeBuyers(env) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT c.* FROM contacts c JOIN leads l ON l.contact_id = c.id
      WHERE l.lead_type = 'comprador' AND l.stage IN (${OPEN_STAGES.map(() => "?").join(",")})`,
  ).bind(...OPEN_STAGES).all();
  return rows.results.map(contactOut);
}

async function allProperties(env) {
  const rows = await env.DB.prepare("SELECT data FROM properties ORDER BY sort_order ASC").all();
  return rows.results.map(r => safeJson(r.data)).filter(p => p && p.id);
}

async function getProperty(env, id) {
  const row = await env.DB.prepare("SELECT data FROM properties WHERE id = ?").bind(id).first();
  return row ? safeJson(row.data) : null;
}

export async function addActivity(env, { contactId, leadId = null, type, text, data = {} }) {
  if (!contactId) return;
  await env.DB.prepare(
    "INSERT INTO activities (id, contact_id, lead_id, type, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), contactId, leadId, type, String(text).slice(0, 4000), JSON.stringify(data), new Date().toISOString()).run();
}

async function createTask(env, { contactId = null, leadId = null, title, dueAt, origin }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tasks (id, contact_id, lead_id, title, due_at, done_at, origin, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
  ).bind(id, contactId, leadId, title, dueAt, origin, new Date().toISOString()).run();
  return id;
}

// Aviso por e-mail (Resend). Sem RESEND_API_KEY/NOTIFY_EMAIL, não faz nada.
async function notify(env, { subject, lines }) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  const text = lines.filter(Boolean).join("\n") + "\n\nAbrir o CRM: https://ebvimoveiscuritiba.com.br/#admin";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || "EBV CRM <crm@wellness-protocol.com>",
        to: String(env.NOTIFY_EMAIL).split(",").map(s => s.trim()).filter(Boolean),
        subject: subject.slice(0, 200),
        text,
      }),
    });
    if (!res.ok) console.error("notify failed", res.status, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("notify error", err);
  }
}

export function originLabel(t) {
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

function contactOut(r) {
  return {
    id: r.id, name: r.name, phone: r.phone, email: r.email,
    roles: safeJson(r.roles, []), profile: safeJson(r.profile), tags: safeJson(r.tags, []),
    notes: r.notes || "", source: r.source, createdAt: r.created_at, lastActivityAt: r.last_activity_at,
  };
}

function taskOut(t) {
  return {
    id: t.id, contactId: t.contact_id, leadId: t.lead_id, title: t.title, dueAt: t.due_at, doneAt: t.done_at,
    origin: t.origin, contactName: t.contact_name, contactPhone: t.contact_phone,
  };
}

function absolute(src, origin) {
  try { return new URL(src, `${origin}/`).href; } catch { return src; }
}
function slug(v) {
  return String(v).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
function norm(v) {
  return String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function brl(n) { return Number(n).toLocaleString("pt-BR"); }
function firstName(n) { return String(n || "").trim().split(/\s+/)[0] || "contato"; }
function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function ok(body, status = 200) { return json(body, status); }
function bad(message) { return json({ error: { code: "invalid", message } }, 400); }
function notFound() { return json({ error: { code: "not_found", message: "Não encontrado." } }, 404); }
