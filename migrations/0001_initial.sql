CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_properties_sort_order
  ON properties (sort_order, id);

CREATE TABLE IF NOT EXISTS appraisals (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appraisals_created_at
  ON appraisals (created_at DESC, id DESC);
