const ALLOWED_EVENTS = new Set([
  "page_view",
  "form_open",
  "form_start",
  "generate_lead",
  "whatsapp_click",
  "cta_click",
  "phone_click",
  "outbound_click",
  "scroll_75",
  "calculator_use",
  "article_read",
  "simulator_calculate",
  "simulator_contact",
  "article_cta",
]);

const ALLOWED_SOURCES = new Set(["direct", "google", "instagram", "facebook", "other"]);
let schemaReady = null;

export async function ensureSiteMetricsSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS site_events (
        id TEXT PRIMARY KEY NOT NULL,
        event_name TEXT NOT NULL,
        path TEXT NOT NULL,
        source TEXT NOT NULL,
        property_id TEXT,
        created_at TEXT NOT NULL
      )`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_site_events_created ON site_events (created_at DESC)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_site_events_name_created ON site_events (event_name, created_at DESC)"),
    ]).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function recordSiteEvent(env, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Evento inválido." };
  const eventName = text(raw.eventName, 40);
  if (!ALLOWED_EVENTS.has(eventName)) return { error: "Evento não permitido." };
  const path = cleanPath(raw.path);
  if (!path) return { error: "Caminho inválido." };
  const sourceCandidate = text(raw.source, 20).toLowerCase();
  const source = ALLOWED_SOURCES.has(sourceCandidate) ? sourceCandidate : "other";
  const propertyId = text(raw.propertyId, 200) || null;
  await ensureSiteMetricsSchema(env);
  await env.DB.prepare(`INSERT INTO site_events
    (id, event_name, path, source, property_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), eventName, path, source, propertyId, new Date().toISOString()).run();
  return { value: true };
}

export async function getSiteMetrics(env, requestedDays = 30) {
  await ensureSiteMetricsSchema(env);
  const days = Math.min(365, Math.max(1, Number.parseInt(requestedDays, 10) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [totals, eventsByDay, pages, sources, leads, leadsByDay] = await Promise.all([
    env.DB.prepare(`SELECT event_name, COUNT(*) AS total
      FROM site_events WHERE created_at >= ? GROUP BY event_name ORDER BY total DESC`).bind(since).all(),
    env.DB.prepare(`SELECT substr(created_at, 1, 10) AS day, event_name, COUNT(*) AS total
      FROM site_events WHERE created_at >= ? GROUP BY substr(created_at, 1, 10), event_name ORDER BY day DESC, total DESC`).bind(since).all(),
    env.DB.prepare(`SELECT path, COUNT(*) AS views
      FROM site_events WHERE event_name = 'page_view' AND created_at >= ?
      GROUP BY path ORDER BY views DESC, path ASC LIMIT 20`).bind(since).all(),
    env.DB.prepare(`SELECT source, COUNT(*) AS visits
      FROM site_events WHERE event_name = 'page_view' AND created_at >= ?
      GROUP BY source ORDER BY visits DESC, source ASC`).bind(since).all(),
    env.DB.prepare(`SELECT COALESCE(json_extract(data, '$.origin'), kind, 'Não informada') AS origin, COUNT(*) AS contacts
      FROM leads WHERE created_at >= ? GROUP BY COALESCE(json_extract(data, '$.origin'), kind, 'Não informada')
      ORDER BY contacts DESC, origin ASC`).bind(since).all(),
    env.DB.prepare(`SELECT substr(created_at, 1, 10) AS day, COALESCE(json_extract(data, '$.origin'), kind, 'Não informada') AS origin, COUNT(*) AS contacts
      FROM leads WHERE created_at >= ? GROUP BY substr(created_at, 1, 10), COALESCE(json_extract(data, '$.origin'), kind, 'Não informada')
      ORDER BY day DESC, contacts DESC, origin ASC`).bind(since).all(),
  ]);
  return {
    period: { days, since, until: new Date().toISOString() },
    events: rows(totals),
    eventsByDay: rows(eventsByDay),
    topPages: rows(pages),
    trafficSources: rows(sources),
    crmContactsByOrigin: rows(leads),
    crmContactsByOriginAndDay: rows(leadsByDay),
    privacy: "Somente eventos agregáveis, sem nome, telefone, endereço IP ou identificador do navegador.",
  };
}

function rows(result) {
  return Array.isArray(result && result.results) ? result.results : [];
}

function cleanPath(value) {
  const path = text(value, 500).split("?")[0].split("#")[0];
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
