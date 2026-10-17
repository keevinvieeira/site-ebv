// Esquema do banco (D1) do CRM. Tudo idempotente: roda na primeira requisição
// de cada instância, sem depender de migration manual.

const BASE = [
  `CREATE TABLE IF NOT EXISTS leads ( id TEXT PRIMARY KEY NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, lead_type TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'novo', name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, property_id TEXT, property_title TEXT, value REAL, data TEXT NOT NULL CHECK (json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_ref ON leads (ref)`,
  `CREATE TABLE IF NOT EXISTS lead_events ( id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL, event_name TEXT NOT NULL, stage TEXT, meta_status TEXT NOT NULL, meta_response TEXT, created_at TEXT NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events (lead_id, created_at)`,
  // CRM
  `CREATE TABLE IF NOT EXISTS contacts ( id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, phone TEXT, email TEXT, roles TEXT NOT NULL DEFAULT '[]', profile TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT NOT NULL )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone) WHERE phone IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_activity ON contacts (last_activity_at DESC)`,
  `CREATE TABLE IF NOT EXISTS tasks ( id TEXT PRIMARY KEY NOT NULL, contact_id TEXT, lead_id TEXT, title TEXT NOT NULL, due_at TEXT NOT NULL, done_at TEXT, origin TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks (done_at, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks (contact_id)`,
  `CREATE TABLE IF NOT EXISTS activities ( id TEXT PRIMARY KEY NOT NULL, contact_id TEXT NOT NULL, lead_id TEXT, type TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL )`,
  `CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities (contact_id, created_at DESC)`,
];

// Colunas adicionadas depois (ALTER não tem IF NOT EXISTS no SQLite).
const COLUMNS = [
  ["leads", "contact_id", "TEXT"],
  ["leads", "lost_reason", "TEXT"],
];

let ready = null;

export function ensureSchema(env) {
  if (!ready) {
    ready = (async () => {
      await env.DB.batch(BASE.map(sql => env.DB.prepare(sql)));
      for (const [table, column, type] of COLUMNS) {
        try {
          await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
        } catch (err) {
          if (!/duplicate column/i.test(String(err && err.message))) throw err;
        }
      }
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads (contact_id)").run();
      await backfillContacts(env);
    })().catch(err => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

// Leads antigos (antes do CRM) ganham um contato.
async function backfillContacts(env) {
  const orphans = await env.DB.prepare(
    "SELECT id, name, phone, email, lead_type, kind, created_at FROM leads WHERE contact_id IS NULL ORDER BY created_at LIMIT 2000",
  ).all();
  for (const lead of orphans.results) {
    const contactId = await upsertContactRow(env, {
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      role: lead.kind === "importado" ? "cliente" : lead.lead_type,
      source: lead.kind,
      at: lead.created_at,
    });
    await env.DB.prepare("UPDATE leads SET contact_id = ? WHERE id = ?").bind(contactId, lead.id).run();
  }
}

// Cria ou atualiza o contato pelo telefone (ou e-mail, se não houver telefone).
export async function upsertContactRow(env, { name, phone, email, role, source, at }) {
  const now = at || new Date().toISOString();
  const canonical = canonicalPhone(phone);
  const mail = email ? String(email).trim().toLowerCase() : null;

  let row = null;
  if (canonical) row = await env.DB.prepare("SELECT * FROM contacts WHERE phone = ?").bind(canonical).first();
  if (!row && mail) row = await env.DB.prepare("SELECT * FROM contacts WHERE email = ? LIMIT 1").bind(mail).first();

  if (row) {
    const roles = new Set(safeJson(row.roles, []));
    if (role) roles.add(role);
    await env.DB.prepare(
      `UPDATE contacts SET name = CASE WHEN name = '' THEN ? ELSE name END, phone = COALESCE(phone, ?), email = COALESCE(email, ?),
         roles = ?, updated_at = ?, last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`,
    ).bind(name || "", canonical, mail, JSON.stringify([...roles]), now, now, row.id).run();
    return row.id;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO contacts (id, name, phone, email, roles, profile, tags, notes, source, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, '{}', '[]', '', ?, ?, ?, ?)`,
  ).bind(id, name || "Sem nome", canonical, mail, JSON.stringify(role ? [role] : []), source || null, now, now, now).run();
  return id;
}

// Telefone brasileiro sem DDI: "5541999991234" e "(41) 99999-1234" viram "41999991234".
export function canonicalPhone(phone) {
  let d = String(phone || "").replace(/\D/g, "").replace(/^0+/, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  return d.length >= 10 ? d : null;
}

export function safeJson(text, fallback = {}) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
