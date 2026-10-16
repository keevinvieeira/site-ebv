-- Leads (base do CRM) e log de eventos enviados para a Meta (Conversions API)
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,              -- whatsapp | avaliacao
  lead_type TEXT NOT NULL,         -- comprador | proprietario
  stage TEXT NOT NULL DEFAULT 'novo',
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  property_id TEXT,
  property_title TEXT,
  value REAL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads (phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_ref ON leads (ref);

CREATE TABLE IF NOT EXISTS lead_events (
  id TEXT PRIMARY KEY NOT NULL,
  lead_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  stage TEXT,
  meta_status TEXT NOT NULL,       -- sent | skipped | error
  meta_response TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events (lead_id, created_at);
