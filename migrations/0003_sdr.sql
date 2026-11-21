-- Atendimento da SDR no CRM já existente. O schema.js aplica o mesmo SQL na primeira requisição.
CREATE TABLE IF NOT EXISTS sdr_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'ia',
  qualificacao TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(qualificacao)),
  next_step TEXT NOT NULL DEFAULT '',
  last_inbound_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sdr_conversation_external
  ON sdr_conversations (channel, external_id);

CREATE TABLE IF NOT EXISTS sdr_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  external_mid TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sdr_message_mid
  ON sdr_messages (conversation_id, external_mid);

CREATE TABLE IF NOT EXISTS visit_requests (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT,
  conversation_id TEXT,
  lead_id TEXT,
  property_id TEXT,
  property_title TEXT,
  when_text TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
