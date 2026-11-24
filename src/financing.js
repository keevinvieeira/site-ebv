const DEFAULT_SETTINGS = Object.freeze({
  annualRateEffective: 10.99,
  minimumEntrySacPercent: 20,
  minimumEntryPricePercent: 30,
  minimumTermYears: 10,
  maximumTermYears: 35,
  incomeCommitmentPercent: 30,
  sourceLabel: "CAIXA Notícias, crédito imobiliário SBPE",
  sourceUrl: "https://caixanoticias.caixa.gov.br/Paginas/Not%C3%ADcias/2025/12-DEZEMBRO/CAIXA-volta-a-permitir-mais-de-um-financiamento--imobiliario-pelo-SBPE.aspx",
  sourcePublishedAt: "2025-12-09",
  sourceCheckedAt: "2026-11-24",
});

const SETTINGS_KEY = "financing_settings";
let schemaReady = null;

export async function ensureFinancingSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS financing_simulations (
          id TEXT PRIMARY KEY NOT NULL,
          property_id TEXT,
          property_title TEXT,
          property_value REAL NOT NULL,
          input_data TEXT NOT NULL CHECK (json_valid(input_data)),
          result_data TEXT NOT NULL CHECK (json_valid(result_data)),
          lead_id TEXT,
          created_at TEXT NOT NULL,
          converted_at TEXT
        )`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_financing_simulations_created ON financing_simulations (created_at DESC)"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_financing_simulations_lead ON financing_simulations (lead_id)"),
      ]);
      await env.DB.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)")
        .bind(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS)).run();
    })().catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function getFinancingSettings(env) {
  await ensureFinancingSchema(env);
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SETTINGS_KEY).first();
  return normalizeSettings(safeJson(row && row.value));
}

export async function saveFinancingSettings(env, raw) {
  await ensureFinancingSchema(env);
  const value = validateSettings(raw);
  if (value.error) return value;
  await env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
    .bind(SETTINGS_KEY, JSON.stringify(value.value)).run();
  return value;
}

export async function createFinancingSimulation(env, raw) {
  await ensureFinancingSchema(env);
  const value = validateSimulation(raw);
  if (value.error) return value;
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO financing_simulations
    (id, property_id, property_title, property_value, input_data, result_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      value.value.propertyId,
      value.value.propertyTitle,
      value.value.propertyValue,
      JSON.stringify(value.value.input),
      JSON.stringify(value.value.result),
      createdAt,
    ).run();
  return { value: { id, createdAt } };
}

export async function markFinancingSimulationConverted(env, simulationId, leadId) {
  if (!validId(simulationId) || !validId(leadId)) return false;
  await ensureFinancingSchema(env);
  const result = await env.DB.prepare(`UPDATE financing_simulations
    SET lead_id = COALESCE(lead_id, ?), converted_at = COALESCE(converted_at, ?)
    WHERE id = ?`)
    .bind(leadId, new Date().toISOString(), simulationId).run();
  return Boolean(result.meta && result.meta.changes);
}

export async function getFinancingMetrics(env) {
  await ensureFinancingSchema(env);
  const totals = await env.DB.prepare(`SELECT
    COUNT(*) AS simulations,
    SUM(CASE WHEN lead_id IS NOT NULL THEN 1 ELSE 0 END) AS contacts
    FROM financing_simulations`).first();
  const simulations = Number(totals && totals.simulations) || 0;
  const contacts = Number(totals && totals.contacts) || 0;
  return {
    simulations,
    contacts,
    conversionRate: simulations ? Number(((contacts / simulations) * 100).toFixed(1)) : 0,
  };
}

export function normalizeSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    annualRateEffective: finite(merged.annualRateEffective, DEFAULT_SETTINGS.annualRateEffective),
    minimumEntrySacPercent: finite(merged.minimumEntrySacPercent, DEFAULT_SETTINGS.minimumEntrySacPercent),
    minimumEntryPricePercent: finite(merged.minimumEntryPricePercent, DEFAULT_SETTINGS.minimumEntryPricePercent),
    minimumTermYears: finite(merged.minimumTermYears, DEFAULT_SETTINGS.minimumTermYears),
    maximumTermYears: finite(merged.maximumTermYears, DEFAULT_SETTINGS.maximumTermYears),
    incomeCommitmentPercent: finite(merged.incomeCommitmentPercent, DEFAULT_SETTINGS.incomeCommitmentPercent),
    sourceLabel: text(merged.sourceLabel, 200) || DEFAULT_SETTINGS.sourceLabel,
    sourceUrl: text(merged.sourceUrl, 1000) || DEFAULT_SETTINGS.sourceUrl,
    sourcePublishedAt: isoDate(merged.sourcePublishedAt) || DEFAULT_SETTINGS.sourcePublishedAt,
    sourceCheckedAt: isoDate(merged.sourceCheckedAt) || DEFAULT_SETTINGS.sourceCheckedAt,
  };
}

function validateSettings(raw) {
  const value = normalizeSettings(raw);
  if (value.annualRateEffective <= 0 || value.annualRateEffective > 50) return { error: "Informe uma taxa efetiva anual entre 0 e 50%." };
  if (value.minimumEntrySacPercent < 0 || value.minimumEntrySacPercent > 90) return { error: "Entrada mínima SAC inválida." };
  if (value.minimumEntryPricePercent < 0 || value.minimumEntryPricePercent > 90) return { error: "Entrada mínima Price inválida." };
  if (value.minimumTermYears < 1 || value.maximumTermYears > 50 || value.minimumTermYears > value.maximumTermYears) return { error: "Faixa de prazo inválida." };
  if (value.incomeCommitmentPercent <= 0 || value.incomeCommitmentPercent > 100) return { error: "Limite de renda inválido." };
  try {
    const source = new URL(value.sourceUrl);
    if (source.protocol !== "https:") return { error: "A fonte deve usar HTTPS." };
  } catch {
    return { error: "Informe uma URL válida para a fonte." };
  }
  return { value };
}

function validateSimulation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Simulação inválida." };
  const propertyValue = finite(raw.propertyValue, 0);
  if (propertyValue <= 0 || propertyValue > 1e10) return { error: "Valor do imóvel inválido." };
  const input = compactObject(raw.input, 8000);
  const result = compactObject(raw.result, 8000);
  if (!input || !result) return { error: "Dados da simulação inválidos." };
  return {
    value: {
      propertyId: text(raw.propertyId, 200) || null,
      propertyTitle: text(raw.propertyTitle, 200) || null,
      propertyValue,
      input,
      result,
    },
  };
}

function compactObject(value, maxBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const json = JSON.stringify(value);
  return new TextEncoder().encode(json).byteLength <= maxBytes ? JSON.parse(json) : null;
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isoDate(value) {
  const string = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(string) ? string : null;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
}

function safeJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

