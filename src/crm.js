// CRM da EBV: contatos, perfil de busca, tarefas, linha do tempo, match de imóveis,
// avisos de lead novo e API para automação (agente de WhatsApp).
import { ensureSchema, upsertContactRow, canonicalPhone, safeJson } from "./schema.js";
import {
  followUpPlan, fullName, qualifyTurn, extractInstagramDirect, keepForAccount, verifyMetaSignature,
  DIRECT_AGENT_SINCE, sanitizeCustomerReply, shouldAutoReplyDirect, directAgentPrompt, publicPropertyFact,
} from "./sdr.js";

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
  finalidade: "text",   // comprar, vender, avaliar
  visita: "text",
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
  const extra = input.extra || {};
  const byInterest = {
    comprar: "Quer comprar, ainda sem imóvel escolhido (WhatsApp pelo site)",
    vender: "Quer vender o imóvel (WhatsApp pelo site)",
    avaliar: "Quer avaliar o imóvel (WhatsApp pelo site)",
  };
  const sim = extra.simulation;
  const simSummary = sim ? formatSimulationSummary(sim) : null;
  const what = simSummary
    ? `${input.propertyTitle ? `Simulação para ${input.propertyTitle}` : "Simulação de financiamento"} (${simSummary})`
    : input.propertyTitle ? `Interesse em: ${input.propertyTitle}`
    : input.kind === "avaliacao" ? "Pediu avaliação de imóvel"
    : byInterest[extra.interest] || "Chamou no WhatsApp pelo site";
  await addActivity(env, {
    contactId,
    leadId,
    type: isNew ? "lead" : "interesse",
    text: what,
    data: {
      ref,
      origin: input.origin || null,
      interest: extra.interest || null,
      cta: extra.cta || null,
      propertyId: input.propertyId || null,
      simulation: sim || null,
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
      extra.cta ? `Botão do site: ${extra.cta}` : null,
      `Código: ${ref}`,
    ],
  }));
}

function formatSimulationSummary(sim) {
  if (!sim || typeof sim !== "object") return "";
  const brl = v => Number.isFinite(Number(v)) ? `R$ ${Math.round(Number(v)).toLocaleString("pt-BR")}` : null;
  const parts = [];
  if (sim.propertyValue) parts.push(`imóvel ${brl(sim.propertyValue)}`);
  if (sim.entry) parts.push(`entrada ${brl(sim.entry)}`);
  if (sim.usesFgts && sim.fgts) parts.push(`FGTS ${brl(sim.fgts)}`);
  if (sim.hasExchange && sim.exchange) parts.push(`troca ${brl(sim.exchange)}`);
  if (sim.financed) parts.push(`financiado ${brl(sim.financed)}`);
  if (sim.termYears) parts.push(`${sim.termYears} anos`);
  if (sim.sacFirst) parts.push(`SAC 1ª ${brl(sim.sacFirst)}`);
  if (sim.priceFirst) parts.push(`Price ${brl(sim.priceFirst)}`);
  return parts.join(" · ");
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

  if (path === "/api/agent/site-metrics" && method === "GET") {
    if (typeof helpers.getSiteMetrics !== "function") return notFound();
    return ok(await helpers.getSiteMetrics(env, url.searchParams.get("days")));
  }

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

  if (path === "/api/admin/crm/atendimento" && method === "GET") {
    return ok(await listAtendimento(env));
  }

  m = path.match(/^\/api\/admin\/crm\/conversations\/([^/]+)\/(assumir|pausar|retomar)$/);
  if (m && method === "POST") {
    const status = { assumir: "humano", pausar: "pausada", retomar: "ia" }[m[2]];
    const saved = await setConversationStatus(env, decodeURIComponent(m[1]), status);
    return saved ? ok({ ok: true, status }) : notFound();
  }

  m = path.match(/^\/api\/admin\/crm\/visits\/([^/]+)\/(aprovar|recusar)$/);
  if (m && method === "POST") {
    const saved = await decideVisit(env, decodeURIComponent(m[1]), m[2] === "aprovar" ? "aprovada" : "recusada");
    return saved ? ok({ ok: true }) : notFound();
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

  if (path === "/api/agent/inbound" && method === "POST") {
    const body = await readBody();
    if (body.error) return body.error;
    const result = await ingestSdrInbound(env, body.value || {}, helpers);
    if (result.error) return bad(result.error);
    return ok(result);
  }

  if (path === "/api/agent/direct-sync" && method === "POST") {
    const body = await readBody();
    if (body.error) return body.error;
    const b = body.value || {};
    const externalId = str(b.externalId, 80);
    if (!externalId) return bad("Informe externalId.");
    const username = str(b.username, 100).replace(/^@+/, "");
    const profileName = str(b.profileName, 120);
    const displayName = profileName || (username ? `@${username}` : "Contato Instagram");
    const phone = canonicalPhone(b.phone);
    const qualified = Boolean(b.qualified || phone);
    const propertyId = str(b.propertyId, 200) || null;
    const propertyTitle = str(b.propertyTitle, 200) || null;
    const adTitle = str(b.adTitle, 200);
    const visitRequested = Boolean(b.visitRequested);
    const visitWhen = str(b.visitWhen, 200);
    const now = new Date().toISOString();
    let conv = await env.DB.prepare("SELECT * FROM sdr_conversations WHERE channel = 'instagram' AND external_id = ?")
      .bind(externalId).first();
    if (!conv) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO sdr_conversations (id, contact_id, channel, external_id, account_id, status, qualificacao, next_step, last_inbound_at, created_at, updated_at)
         VALUES (?, NULL, 'instagram', ?, ?, 'ia', '{}', '', NULL, ?, ?)`,
      ).bind(id, externalId, ebvInstagramAccounts(env).split(",")[0], now, now).run();
      conv = await env.DB.prepare("SELECT * FROM sdr_conversations WHERE id = ?").bind(id).first();
    }

    const messages = Array.isArray(b.messages) ? b.messages.slice(-100) : [];
    let lastInboundAt = conv.last_inbound_at;
    for (const item of messages) {
      const direction = item && item.direction === "out" ? "out" : "in";
      const text = str(item && item.body, 4000);
      const mid = str(item && item.externalMid, 180) || null;
      const createdAt = item && !Number.isNaN(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : now;
      if (!text) continue;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO sdr_messages (id, conversation_id, direction, body, external_mid, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), conv.id, direction, text, mid, createdAt).run();
      if (direction === "in" && (!lastInboundAt || createdAt > lastInboundAt)) lastInboundAt = createdAt;
    }

    let contactId = conv.contact_id;
    let openLead = null;
    if (phone || qualified) {
      if (phone) {
        const attached = await attachLeadToContact(env, { name: displayName, phone, email: null, leadType: "comprador", kind: "instagram" });
        contactId = attached.contactId;
        openLead = attached.openLead;
      } else if (!contactId) {
        contactId = await upsertContactRow(env, { name: displayName, phone: null, email: null, role: "comprador", source: "instagram" });
      }
    }
    if (contactId) {
      const contact = await env.DB.prepare("SELECT name, profile FROM contacts WHERE id = ?").bind(contactId).first();
      const currentProfile = safeJson(contact && contact.profile, {});
      currentProfile.instagramUsername = username || currentProfile.instagramUsername || "";
      currentProfile.instagramName = profileName || currentProfile.instagramName || "";
      const shouldRename = !contact || !contact.name || ["Sem nome", "Contato do atendimento", "Contato Instagram"].includes(contact.name) || contact.name.startsWith("@");
      await env.DB.prepare("UPDATE contacts SET name = ?, phone = COALESCE(phone, ?), profile = ?, updated_at = ?, last_activity_at = MAX(last_activity_at, ?) WHERE id = ?")
        .bind(shouldRename ? displayName : contact.name, phone, JSON.stringify(currentProfile), now, lastInboundAt || now, contactId).run();
    }

    const qualification = {
      ...safeJson(conv.qualificacao, {}),
      name: profileName || safeJson(conv.qualificacao, {}).name || "",
      phone: phone || safeJson(conv.qualificacao, {}).phone || "",
      instagramUsername: username,
      instagramName: profileName,
      propertyId,
      propertyTitle,
      adTitle,
      visita: visitRequested ? "sim" : (safeJson(conv.qualificacao, {}).visita || ""),
    };
    let saved = null;
    if (qualified && contactId) {
      if (!openLead) {
        const row = await env.DB.prepare(
          `SELECT id, ref, data FROM leads WHERE contact_id = ? AND stage IN (${OPEN_STAGES.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`,
        ).bind(contactId, ...OPEN_STAGES).first();
        if (row) openLead = { id: row.id, ref: row.ref, eventId: safeJson(row.data).eventId };
      }
      saved = await helpers.saveDirectLead(env, ctx, {
        contactId, openLead, externalId, name: displayName, phone: phone || "", leadType: "comprador",
        propertyId, propertyTitle, goal: "comprar", budgetFit: "", adTitle,
        summary: str(b.summary, 2000) || `Instagram @${username || externalId}`,
      });
      qualification.leadId = saved.id;
      qualification.stage = "qualificado";
      if (visitRequested) {
        const existingVisit = await env.DB.prepare(
          "SELECT id FROM visit_requests WHERE conversation_id = ? AND COALESCE(property_id, '') = ? LIMIT 1",
        ).bind(conv.id, propertyId || "").first();
        if (!existingVisit) {
          await env.DB.prepare(
            `INSERT INTO visit_requests (id, contact_id, conversation_id, lead_id, property_id, property_title, when_text, status, created_at, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', ?, NULL)`,
          ).bind(crypto.randomUUID(), contactId, conv.id, saved.id, propertyId, propertyTitle, visitWhen || null, now).run();
          await createTask(env, {
            contactId,
            leadId: saved.id,
            title: `Aprovar visita: ${propertyTitle || "imóvel do Instagram"}`,
            dueAt: now,
            origin: "sdr",
          });
        }
      }
    }
    await env.DB.prepare(
      "UPDATE sdr_conversations SET contact_id = ?, qualificacao = ?, next_step = ?, last_inbound_at = ?, updated_at = ? WHERE id = ?",
    ).bind(contactId, JSON.stringify(qualification), qualified ? "Lead no funil: Qualificado" : conv.next_step || "", lastInboundAt, now, conv.id).run();
    return ok({ ok: true, conversationId: conv.id, contactId, leadId: saved && saved.id, username, phone: phone || "" });
  }

  if (path === "/api/agent/direct-lead" && method === "POST") {
    const body = await readBody();
    if (body.error) return body.error;
    const b = body.value || {};
    const externalId = str(b.externalId, 80);
    if (!externalId) return bad("Informe externalId.");

    const rawPhone = canonicalPhone(b.phone);
    const goalRaw = str(b.goal, 40).toLowerCase();
    const goal = goalRaw || "comprar";
    const leadType = goal === "vender" || goal === "avaliar" || goal === "proprietario" ? "proprietario" : "comprador";
    const name = str(b.name, 120) || "Contato Instagram";
    const budgetFit = str(b.budgetFit, 200);
    const propertyId = str(b.propertyId, 200) || null;
    const propertyTitle = str(b.propertyTitle, 200) || null;
    const adTitle = str(b.adTitle, 200) || "";
    const summary = str(b.summary, 2000) || "";
    const now = new Date().toISOString();

    let conv = await env.DB.prepare(
      "SELECT * FROM sdr_conversations WHERE channel = 'instagram' AND external_id = ?",
    ).bind(externalId).first();

    if (conv && conv.contact_id && rawPhone) {
      const clash = await env.DB.prepare("SELECT id FROM contacts WHERE phone = ? AND id != ?").bind(rawPhone, conv.contact_id).first();
      if (!clash) {
        await env.DB.prepare("UPDATE contacts SET phone = COALESCE(phone, ?), updated_at = ? WHERE id = ?")
          .bind(rawPhone, now, conv.contact_id).run();
      }
    }

    let contactId = conv ? conv.contact_id : null;
    let openLead = null;
    if (rawPhone) {
      const attached = await attachLeadToContact(env, { name, phone: rawPhone, email: null, leadType, kind: "instagram" });
      contactId = attached.contactId;
      openLead = attached.openLead;
    } else if (!contactId) {
      contactId = await upsertContactRow(env, { name, phone: null, email: null, role: leadType, source: "instagram" });
    }
    if (!openLead && contactId) {
      const open = await env.DB.prepare(
        `SELECT id, ref, data FROM leads WHERE contact_id = ? AND lead_type = ? AND stage IN (${OPEN_STAGES.map(() => "?").join(",")})
          ORDER BY created_at DESC LIMIT 1`,
      ).bind(contactId, leadType, ...OPEN_STAGES).first();
      if (open) openLead = { id: open.id, ref: open.ref, eventId: safeJson(open.data).eventId };
    }

    if (name && name !== "Contato Instagram") {
      await env.DB.prepare(
        "UPDATE contacts SET name = ? WHERE id = ? AND (name = '' OR name = 'Sem nome' OR name = 'Contato do atendimento' OR name = 'Contato Instagram' OR name NOT LIKE '% %')",
      ).bind(name, contactId).run();
    }

    const profilePatch = {
      finalidade: leadType === "proprietario" ? (goal === "avaliar" ? "avaliar" : "vender") : "comprar",
      obs: [goal ? `Objetivo: ${goal}` : "", budgetFit ? `Valor: ${budgetFit}` : ""].filter(Boolean).join(" | ") || null,
    };
    if (propertyId) {
      const prop = await getProperty(env, propertyId);
      if (prop && prop.location) profilePatch.bairros = [prop.location];
    }
    await updateContact(env, contactId, { profile: profilePatch });

    const qual = {
      ...(conv ? safeJson(conv.qualificacao, {}) : {}),
      name,
      phone: rawPhone || "",
      goal,
      budgetFit,
      propertyId,
      propertyTitle,
      adTitle,
    };
    if (conv) {
      await env.DB.prepare(
        "UPDATE sdr_conversations SET contact_id = ?, qualificacao = ?, next_step = ?, updated_at = ? WHERE id = ?",
      ).bind(contactId, JSON.stringify(qual), "Lead quente encaminhado para Edicleia", now, conv.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO sdr_conversations (id, contact_id, channel, external_id, account_id, status, qualificacao, next_step, last_inbound_at, created_at, updated_at)
         VALUES (?, ?, 'instagram', ?, '17841448438742197', 'ia', ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), contactId, externalId, JSON.stringify(qual), "Lead quente encaminhado para Edicleia", now, now, now).run();
    }

    const saved = await helpers.saveDirectLead(env, ctx, {
      contactId,
      openLead,
      externalId,
      name,
      phone: rawPhone || "",
      leadType,
      propertyId,
      propertyTitle,
      goal,
      budgetFit,
      adTitle,
      summary,
    });

    if (saved.isNew || saved.shouldNotify) {
      await addActivity(env, {
        contactId,
        leadId: saved.id,
        type: "lead",
        text: summary || `Lead qualificado no Instagram Direct (${propertyTitle || "imóvel a definir"})`,
        data: { channel: "instagram", goal, budgetFit, propertyId, adTitle },
      });
    }

    const hasOpenSdrTask = await env.DB.prepare(
      "SELECT 1 FROM tasks WHERE contact_id = ? AND origin = 'sdr' AND done_at IS NULL LIMIT 1",
    ).bind(contactId).first();
    if (!hasOpenSdrTask) {
      await createTask(env, {
        contactId,
        leadId: saved.id,
        title: `Chamar ${firstName(name)} (${propertyTitle || "Instagram Direct"})`,
        dueAt: now,
        origin: "sdr",
      });
    }

    if (saved.shouldNotify) {
      const goalLabels = { morar: "Comprar para morar", investir: "Investir", vender: "Vender imóvel", avaliar: "Avaliar imóvel" };
      ctx.waitUntil(notify(env, {
        subject: `Lead quente do Instagram: ${name} (${goalLabels[goal] || goal})`,
        lines: [
          `Nome: ${name}`,
          `WhatsApp: ${rawPhone ? `https://wa.me/55${rawPhone}` : "Não informado no Direct"}`,
          `Objetivo: ${goalLabels[goal] || goal}`,
          budgetFit ? `Orçamento: ${budgetFit}` : null,
          `Imóvel: ${propertyTitle || "A definir"}`,
          `Origem: ${adTitle ? `Anúncio Instagram (${adTitle})` : "Instagram Direct"}`,
          summary ? `Resumo: ${summary}` : null,
          `Código: ${saved.ref}`,
        ],
      }));
    }

    return ok({ ok: true, leadId: saved.id, ref: saved.ref, contactId, notified: saved.shouldNotify });
  }

  if (path === "/api/agent/properties" && method === "GET") {
    const q = url.searchParams.get("q") || "";
    const rows = (await allProperties(env)).filter(p => !p.sold && p.status !== "vendido");
    const found = q ? rows.filter(p => foldSafe(p, q)) : rows;
    return ok(found.slice(0, 20).map(p => ({
      id: p.id, title: p.title, location: p.location, price: p.price, area: p.area, beds: p.beds, type: p.type,
    })));
  }

  return notFound();
}

function foldSafe(property, q) {
  const blob = `${property.title || ""} ${property.location || ""} ${property.id || ""}`.toLowerCase();
  return blob.includes(String(q).toLowerCase());
}

function ebvInstagramAccounts(env) {
  return String(env.EBV_IG_ACCOUNT_ID || "17841448438742197,29032059263111949")
    .split(",").map(item => item.trim()).filter(Boolean).join(",");
}

export async function handleInstagramWebhook(request, env, helpers = {}) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    if (mode === "subscribe" && env.EBV_IG_VERIFY_TOKEN && token === env.EBV_IG_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (request.method !== "POST") return new Response("method", { status: 405 });
  const raw = await request.text();
  const valid = await verifyMetaSignature(raw, request.headers.get("X-Hub-Signature-256"), env.EBV_IG_APP_SECRET);
  const accounts = ebvInstagramAccounts(env);
  if (!valid || !accounts) return new Response("forbidden", { status: 403 });
  let payload = null;
  try { payload = JSON.parse(raw); } catch { return new Response("bad", { status: 400 }); }
  const events = keepForAccount(extractInstagramDirect(payload), accounts);
  for (const event of events) {
    await ingestSdrInbound(env, {
      channel: "instagram",
      externalId: event.senderId,
      accountId: event.accountId,
      text: event.text,
      messageId: event.messageId,
    }, helpers);
  }
  return new Response("ok", { status: 200 });
}

function agentSinceValue(env) {
  const value = String((env && env.IG_AGENT_SINCE) || DIRECT_AGENT_SINCE || "").trim();
  return Number.isFinite(Date.parse(value)) ? value : "";
}

async function storeSdrMessage(env, conversationId, direction, body, externalMid) {
  await env.DB.prepare(
    "INSERT INTO sdr_messages (id, conversation_id, direction, body, external_mid, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), conversationId, direction, body, externalMid, new Date().toISOString()).run();
}

async function claimDirectReply(env, conversationId, inboundMid, body) {
  const lockMid = `lock:${String(inboundMid).slice(0, 140)}`;
  const existing = await env.DB.prepare(
    "SELECT id FROM sdr_messages WHERE conversation_id = ? AND external_mid = ?",
  ).bind(conversationId, lockMid).first();
  if (existing) return { claimed: false };
  try {
    await storeSdrMessage(env, conversationId, "reserva", body, lockMid);
  } catch {
    return { claimed: false };
  }
  return { claimed: true, lockMid };
}

async function inboundHistory(env, conversationId) {
  const rows = await env.DB.prepare(
    "SELECT body FROM sdr_messages WHERE conversation_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 6",
  ).bind(conversationId).all();
  return (rows.results || []).map(row => row.body).reverse();
}

async function composeDirectReply(_env, { turn }) {
  return sanitizeCustomerReply(turn && turn.reply) || "";
}

async function sendInstagramText(token, recipientId, text) {
  const res = await fetch("https://graph.instagram.com/v23.0/me/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  let payload = {};
  try { payload = await res.json(); } catch { payload = {}; }
  if (!res.ok || !payload.message_id) return { ok: false, status: res.status };
  return { ok: true, messageId: String(payload.message_id) };
}

async function deliverDirectReply(env, input) {
  const fallback = sanitizeCustomerReply(input.fallback) || "";
  if (!fallback || !input.conversationId) return "held";
  const claim = await claimDirectReply(env, input.conversationId, input.inboundMid, fallback);
  if (!claim.claimed) return "held";
  const outgoing = fallback;
  const sent = await sendInstagramText(input.token, input.recipientId, outgoing);
  if (sent.ok) {
    await env.DB.prepare(
      "UPDATE sdr_messages SET direction = 'out', body = ?, external_mid = ? WHERE conversation_id = ? AND external_mid = ?",
    ).bind(outgoing, sent.messageId, input.conversationId, claim.lockMid).run();
    return "sent";
  }
  console.error("ig send", sent.status || 0);
  await env.DB.prepare(
    "UPDATE sdr_messages SET direction = 'sugestao', body = ?, external_mid = ? WHERE conversation_id = ? AND external_mid = ?",
  ).bind(outgoing, `draft:${String(input.inboundMid).slice(0, 150)}`, input.conversationId, claim.lockMid).run();
  return "held";
}

// Lê o Direct da EBV e responde só mensagem nova. Não mexe no webhook das outras marcas.
export async function pollInstagram(env, helpers = {}) {
  const token = env.IG_TOKEN_EBV;
  if (!token) return { skipped: "sem_token" };
  const own = new Set(ebvInstagramAccounts(env).split(","));
  const windowStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const endpoint = "https://graph.instagram.com/v23.0/me/conversations?fields=updated_time,messages.limit(20){id,message,from,created_time,story,attachments}&limit=10";
  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: res.status };
  const body = await res.json();
  let seen = 0;
  let imported = 0;
  let sent = 0;
  let held = 0;
  const now = new Date().toISOString();
  const sinceAgent = agentSinceValue(env);
  for (const thread of body.data || []) {
    const updated = Date.parse(thread.updated_time || "");
    if (Number.isFinite(updated) && updated < windowStart) continue;
    const messages = ((thread.messages && thread.messages.data) || []).slice().sort((a, b) => {
      return (Date.parse(a.created_time || "") || 0) - (Date.parse(b.created_time || "") || 0);
    });
    let latestCustomerId = "";
    let latestAt = -1;
    for (const msg of messages) {
      const fromId = String(msg.from && msg.from.id || "");
      const created = Date.parse(msg.created_time || "") || 0;
      if (!fromId || own.has(fromId)) continue;
      if (created >= latestAt) {
        latestAt = created;
        latestCustomerId = String(msg.id || "");
      }
    }
    for (const msg of messages) {
      seen += 1;
      const created = Date.parse(msg.created_time || "");
      if (Number.isFinite(created) && created < windowStart) continue;
      const fromId = String(msg.from && msg.from.id || "");
      if (!fromId || own.has(fromId)) continue;
      let text = String(msg.message || msg.text || "").trim();
      if (!text && msg.story) text = "Respondeu a um story do Instagram.";
      if (!text && msg.attachments) text = "Enviou uma mídia no Instagram.";
      if (!text || !msg.id) continue;
      const isLatest = String(msg.id) === latestCustomerId;
      const fresh = shouldAutoReplyDirect({
        channel: "instagram", status: "ia", reply: "ok", createdAt: msg.created_time, agentSince: sinceAgent, now,
      });
      if (isLatest && fresh && sent >= 8) continue;
      const result = await ingestSdrInbound(env, {
        channel: "instagram",
        externalId: fromId,
        accountId: "17841448438742197",
        text,
        messageId: msg.id,
        holdSuggestion: true,
      }, helpers);
      if (result && !result.duplicate && !result.ignored && !result.error) imported += 1;
      const allowed = isLatest && shouldAutoReplyDirect({
        channel: "instagram",
        duplicate: Boolean(result && result.duplicate),
        ignored: Boolean(result && result.ignored),
        error: Boolean(result && result.error),
        status: result && result.status,
        handoff: Boolean(result && result.handoff),
        reply: result && result.reply,
        createdAt: msg.created_time,
        agentSince: sinceAgent,
        now,
      });
      if (isLatest && result && result.reply && !result.duplicate && !result.ignored && !result.error) {
        await storeSdrMessage(env, result.conversationId, "sugestao", result.reply, null);
        held += 1;
      }
      // O envio fica no perfil Hermes ebv, no VPS, com a assinatura. O site não responde sozinho.
    }
  }
  return { seen, imported, sent, held, agentSince: sinceAgent || null };
}

export async function ingestSdrInbound(env, input, helpers = {}) {
  await ensureSchema(env);
  const channel = input.channel === "instagram" || input.channel === "whatsapp" ? input.channel : "";
  const externalId = str(input.externalId, 80);
  if (!channel || !externalId) return { error: "Informe canal e identificador do contato." };
  const accounts = ebvInstagramAccounts(env);
  if (channel === "instagram" && accounts && input.accountId && !accounts.split(",").includes(String(input.accountId))) {
    return { ignored: true, reason: "outra_conta" };
  }
  const text = str(input.text, 4000);
  if (!text) return { error: "Mensagem vazia." };
  const now = new Date().toISOString();
  let conversation = await env.DB.prepare(
    "SELECT * FROM sdr_conversations WHERE channel = ? AND external_id = ?",
  ).bind(channel, externalId).first();
  if (!conversation) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO sdr_conversations (id, contact_id, channel, external_id, account_id, status, qualificacao, next_step, last_inbound_at, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'ia', '{}', '', ?, ?, ?)`,
    ).bind(id, channel, externalId, str(input.accountId, 80) || null, now, now, now).run();
    conversation = await env.DB.prepare("SELECT * FROM sdr_conversations WHERE id = ?").bind(id).first();
  }
  if (input.messageId) {
    const dup = await env.DB.prepare(
      "SELECT id FROM sdr_messages WHERE conversation_id = ? AND external_mid = ?",
    ).bind(conversation.id, str(input.messageId, 180)).first();
    if (dup) return { duplicate: true, send: false, conversationId: conversation.id };
  }
  await env.DB.prepare(
    "INSERT INTO sdr_messages (id, conversation_id, direction, body, external_mid, created_at) VALUES (?, ?, 'in', ?, ?, ?)",
  ).bind(crypto.randomUUID(), conversation.id, text, str(input.messageId, 180) || null, now).run();

  if (conversation.status === "humano" || conversation.status === "pausada") {
    await env.DB.prepare(
      "UPDATE sdr_conversations SET last_inbound_at = ?, updated_at = ? WHERE id = ?",
    ).bind(now, now, conversation.id).run();
    return { send: false, reply: null, status: conversation.status, conversationId: conversation.id, contactId: conversation.contact_id };
  }

  const stored = safeJson(conversation.qualificacao, {});
  const properties = await allProperties(env);
  const turn = qualifyTurn({
    text,
    profile: stored,
    properties,
    channel,
    knownName: str(input.name, 120),
  });
  const phone = canonicalPhone(turn.profile.phone || input.phone || (channel === "whatsapp" ? externalId : ""));
  let contactId = conversation.contact_id;
  let existed = false;
  if (phone) {
    existed = Boolean(await env.DB.prepare("SELECT id FROM contacts WHERE phone = ?").bind(phone).first());
    const leadType = turn.profile.finalidade === "vender" || turn.profile.finalidade === "avaliar" ? "proprietario" : "comprador";
    const name = fullName(turn.profile.name) || str(input.name, 120) || "Contato do atendimento";
    const attached = await attachLeadToContact(env, { name, phone, email: null, leadType, kind: channel });
    contactId = attached.contactId;
    if (fullName(turn.profile.name)) {
      await env.DB.prepare("UPDATE contacts SET name = ? WHERE id = ? AND (name = 'Contato do atendimento' OR name NOT LIKE '% %')")
        .bind(fullName(turn.profile.name), contactId).run();
    }
    const profilePatch = {};
    if (turn.profile.finalidade) profilePatch.finalidade = turn.profile.finalidade;
    if (turn.profile.pagamento) profilePatch.pagamento = turn.profile.pagamento;
    if (turn.profile.prazo) profilePatch.prazo = turn.profile.prazo;
    if (turn.profile.precoMax) profilePatch.precoMax = turn.profile.precoMax;
    if (turn.profile.visita) profilePatch.visita = turn.profile.visita;
    if (turn.property && turn.property.line) {
      const location = properties.find(p => p.id === turn.property.id);
      if (location && location.location) profilePatch.bairros = [location.location];
    }
    if (Object.keys(profilePatch).length) await updateContact(env, contactId, { profile: profilePatch });
    let leadId = attached.openLead && attached.openLead.id;
    if (!leadId && helpers.createManualLead) {
      leadId = await helpers.createManualLead(env, { contactId, name, phone, leadType, kind: "agente" });
      await addActivity(env, { contactId, leadId, type: "lead", text: `Conversa nova pelo ${channel === "instagram" ? "Instagram" : "WhatsApp"}` });
    }
    await addActivity(env, { contactId, leadId, type: "conversa", text: text.slice(0, 500), data: { channel, conversationId: conversation.id } });
    if (turn.visit) {
      const pending = await env.DB.prepare(
        "SELECT id FROM visit_requests WHERE conversation_id = ? AND status = 'pendente' AND COALESCE(property_id, '') = ?",
      ).bind(conversation.id, turn.visit.propertyId || "").first();
      if (!pending) {
        await env.DB.prepare(
          `INSERT INTO visit_requests (id, contact_id, conversation_id, lead_id, property_id, property_title, when_text, status, created_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', ?, NULL)`,
        ).bind(crypto.randomUUID(), contactId, conversation.id, leadId, turn.visit.propertyId, turn.visit.propertyTitle, turn.visit.whenText || null, now).run();
        await createTask(env, { contactId, leadId, title: `Aprovar visita: ${turn.visit.propertyTitle}`, dueAt: now, origin: "sdr" });
        if (fullName(turn.profile.name)) {
          await createTask(env, { contactId, leadId, title: "Conferir o nome em fonte pública antes da visita", dueAt: now, origin: "sdr" });
        }
      }
    }
    const follow = turn.handoff ? null : followUpPlan({ lastInboundAt: now, now: new Date(Date.now() + 5 * 3600000).toISOString(), profile: turn.profile, status: "ia" });
    if (follow) {
      const openFollow = await env.DB.prepare(
        "SELECT id FROM tasks WHERE contact_id = ? AND origin = 'sdr-followup' AND done_at IS NULL",
      ).bind(contactId).first();
      if (!openFollow) {
        await createTask(env, {
          contactId,
          leadId,
          title: follow.title,
          dueAt: new Date(Date.now() + 4 * 3600000).toISOString(),
          origin: "sdr-followup",
        });
      }
    }
  }

  const status = turn.handoff ? "humano" : "ia";
  await env.DB.prepare(
    `UPDATE sdr_conversations SET contact_id = ?, status = ?, qualificacao = ?, next_step = ?, last_inbound_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(contactId, status, JSON.stringify(turn.profile), turn.nextStep, now, now, conversation.id).run();
  if (turn.reply && !input.holdSuggestion) {
    await storeSdrMessage(env, conversation.id, "sugestao", turn.reply, null);
  }
  return {
    send: false,
    reply: turn.reply,
    status,
    handoff: Boolean(turn.handoff),
    nextStep: turn.nextStep,
    summary: turn.summary,
    profile: turn.profile,
    propertyLine: turn.property ? turn.property.line : "",
    conversationId: conversation.id,
    contactId,
    duplicateContact: existed,
    visitPending: Boolean(turn.visit),
  };
}

// ---------- Feed do catálogo para a Meta ----------

async function listAtendimento(env) {
  const conversations = await env.DB.prepare(
    `SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone,
            (SELECT l.id FROM leads l WHERE l.contact_id = c.contact_id ORDER BY l.updated_at DESC LIMIT 1) AS lead_id,
            (SELECT l.stage FROM leads l WHERE l.contact_id = c.contact_id ORDER BY l.updated_at DESC LIMIT 1) AS lead_stage
       FROM sdr_conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id
      ORDER BY c.updated_at DESC LIMIT 100`,
  ).all();
  const ids = conversations.results.map(row => row.id);
  const messages = ids.length
    ? await env.DB.prepare(
      `SELECT conversation_id, direction, body, created_at FROM sdr_messages
        WHERE conversation_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC`,
    ).bind(...ids).all()
    : { results: [] };
  const latest = {};
  for (const message of messages.results) {
    if (!latest[message.conversation_id]) latest[message.conversation_id] = [];
    if (latest[message.conversation_id].length < 4) latest[message.conversation_id].push(message);
  }
  const visits = await env.DB.prepare(
    `SELECT v.*, ct.name AS contact_name FROM visit_requests v
       LEFT JOIN contacts ct ON ct.id = v.contact_id
      WHERE v.status = 'pendente' ORDER BY v.created_at DESC LIMIT 50`,
  ).all();
  return {
    autoreply: "instagram",
    conversations: conversations.results.map(row => ({
      ...conversationOut(row),
      contactName: row.contact_name,
      phone: row.contact_phone,
      leadId: row.lead_id,
      leadStage: row.lead_stage,
      messages: (latest[row.id] || []).reverse().map(message => ({
        direction: message.direction, body: message.body, createdAt: message.created_at,
      })),
    })),
    visits: visits.results.map(visit => ({
      id: visit.id, contactId: visit.contact_id, contactName: visit.contact_name,
      propertyTitle: visit.property_title, whenText: visit.when_text, status: visit.status, createdAt: visit.created_at,
    })),
  };
}

function conversationOut(row) {
  const qualification = safeJson(row.qualificacao, {});
  return {
    id: row.id, contactId: row.contact_id, channel: row.channel, status: row.status,
    nextStep: row.next_step, summary: profileSummary({ ...qualification, finalidade: qualification.finalidade }),
    qualification, instagramUsername: qualification.instagramUsername || "",
    instagramName: qualification.instagramName || "", lastInboundAt: row.last_inbound_at,
  };
}

async function setConversationStatus(env, id, status) {
  const row = await env.DB.prepare("SELECT * FROM sdr_conversations WHERE id = ?").bind(id).first();
  if (!row) return false;
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE sdr_conversations SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, id).run();
  if (row.contact_id) {
    const text = {
      humano: "Edicleia assumiu a conversa. A IA parou.",
      pausada: "IA pausada nesta conversa.",
      ia: "IA retomada nesta conversa. No Instagram, mensagens novas voltam a ser respondidas.",
    }[status];
    await addActivity(env, { contactId: row.contact_id, type: "atendimento", text });
  }
  return true;
}

async function decideVisit(env, id, status) {
  const row = await env.DB.prepare("SELECT * FROM visit_requests WHERE id = ? AND status = 'pendente'").bind(id).first();
  if (!row) return false;
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE visit_requests SET status = ?, decided_at = ? WHERE id = ?").bind(status, now, id).run();
  if (row.contact_id) {
    await addActivity(env, {
      contactId: row.contact_id,
      leadId: row.lead_id,
      type: "visita",
      text: status === "aprovada"
        ? `Visita aprovada para combinar com o cliente: ${row.property_title || "imóvel"}`
        : `Pedido de visita recusado: ${row.property_title || "imóvel"}`,
    });
  }
  return true;
}

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
      instagramUsername: data.instagramUsername || "", summary: data.summary || "",
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
    conversations: (await env.DB.prepare(
      "SELECT id, channel, status, next_step, qualificacao, last_inbound_at FROM sdr_conversations WHERE contact_id = ? ORDER BY updated_at DESC",
    ).bind(id).all()).results.map(conversationOut),
    visits: (await env.DB.prepare(
      "SELECT id, property_title, when_text, status, created_at FROM visit_requests WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20",
    ).bind(id).all()).results.map(v => ({
      id: v.id, propertyTitle: v.property_title, whenText: v.when_text, status: v.status, createdAt: v.created_at,
    })),
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
  if (p.finalidade) parts.push(p.finalidade);
  if (p.pagamento) parts.push(p.pagamento);
  if (p.prazo) parts.push(p.prazo);
  if (p.visita === "sim") parts.push("quer visita");
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
        from: env.NOTIFY_FROM || "EBV CRM <crm@ebvimoveiscuritiba.com.br>",
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
