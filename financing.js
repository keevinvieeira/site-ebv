const CURRENCY = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const NUMBER = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const calculatorStates = new Map();
let settingsPromise = null;

export function calculateFinancing(input) {
  const propertyValue = positive(input.propertyValue);
  const entry = Math.max(0, Number(input.entry) || 0);
  const fgts = input.usesFgts ? Math.max(0, Number(input.fgts) || 0) : 0;
  const exchange = input.hasExchange ? Math.max(0, Number(input.exchange) || 0) : 0;
  const termYears = Math.max(1, Number(input.termYears) || 1);
  const annualRateEffective = Math.max(0, Number(input.annualRateEffective) || 0);
  const commitmentPercent = Math.max(1, Number(input.incomeCommitmentPercent) || 30);
  const financed = Math.max(0, propertyValue - entry - fgts - exchange);
  const months = Math.round(termYears * 12);
  const monthlyRate = Math.pow(1 + annualRateEffective / 100, 1 / 12) - 1;

  if (!propertyValue || !financed || !months) {
    return { propertyValue, entry, fgts, exchange, financed, months, monthlyRate, sac: emptyPlan(), price: emptyPlan(), minimumIncome: 0 };
  }

  const amortization = financed / months;
  const sacFirst = amortization + financed * monthlyRate;
  const sacLast = amortization + amortization * monthlyRate;
  const sacTotal = financed + monthlyRate * financed * (months + 1) / 2;
  const pricePayment = monthlyRate
    ? financed * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months))
    : financed / months;
  const priceTotal = pricePayment * months;
  const minimumIncome = Math.max(sacFirst, pricePayment) / (commitmentPercent / 100);

  return {
    propertyValue,
    entry,
    fgts,
    exchange,
    financed,
    months,
    monthlyRate,
    minimumIncome,
    sac: { first: sacFirst, last: sacLast, total: sacTotal },
    price: { first: pricePayment, last: pricePayment, total: priceTotal },
  };
}

export function buildSacSeries(input, points = 24) {
  const result = calculateFinancing(input);
  if (!result.financed || !result.months) return [];
  const amortization = result.financed / result.months;
  const values = [];
  for (let index = 0; index < points; index += 1) {
    const month = Math.round((index / Math.max(1, points - 1)) * (result.months - 1));
    const balance = Math.max(amortization, result.financed - amortization * month);
    values.push({ month: month + 1, value: amortization + balance * result.monthlyRate });
  }
  return values;
}

function emptyPlan() {
  return { first: 0, last: 0, total: 0 };
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function loadSettings() {
  if (!settingsPromise) {
    settingsPromise = fetch("/api/financing/config", { credentials: "same-origin" })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("Configuração indisponível")));
  }
  return settingsPromise;
}

function properties() {
  return typeof window !== "undefined" && typeof window.ebvProperties === "function" ? window.ebvProperties() : [];
}

function triplex() {
  return properties().find(property => property.id === "prop-1792252762995") || null;
}

function exchangeLimit(property) {
  if (!property) return 0;
  const configured = Number(property.exchangeMaxPercent);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return property.id === "prop-1792252762995" ? 50 : 0;
}

async function renderCalculator(root, property = null, standalone = false) {
  if (!root) return;
  const settings = await loadSettings();
  const initialProperty = property || triplex() || properties()[0] || null;
  const uid = root.id || `financing_${calculatorStates.size + 1}`;
  const propertyValue = Number(initialProperty && initialProperty.price) || 1190000;
  const minimumEntry = propertyValue * Number(settings.minimumEntrySacPercent) / 100;
  root.innerHTML = calculatorMarkup(uid, settings, initialProperty, propertyValue, minimumEntry, standalone);
  const state = { root, uid, settings, property: initialProperty, standalone, simulationId: null, result: null };
  calculatorStates.set(root, state);
  bindCalculator(state);
  updateCalculation(state, false);
  if (standalone && window.location.hash === "#contato") openContactForm(state);
}

function calculatorMarkup(uid, settings, property, propertyValue, minimumEntry, standalone) {
  const options = properties().map(item => `<option value="${escapeHtml(item.id)}" ${property && item.id === property.id ? "selected" : ""}>${escapeHtml(item.title)} · ${CURRENCY.format(Number(item.price) || 0)}</option>`).join("");
  const sourceDate = formatDate(settings.sourceCheckedAt);
  return `
    <div class="finance-card" data-finance-uid="${escapeHtml(uid)}">
      <div class="finance-card-head">
        <div>
          <span class="section-tagline">Planeje antes de conversar com o banco</span>
          <h2>${standalone ? "Simulador de financiamento imobiliário" : "Simule o financiamento deste imóvel"}</h2>
          <p>Compare SAC e Price usando uma taxa de referência editada pela EBV no painel.</p>
        </div>
        <div class="finance-rate-chip"><strong>${NUMBER.format(settings.annualRateEffective)}% ao ano</strong><span>taxa efetiva de referência</span></div>
      </div>
      <form class="finance-form" data-finance-form>
        ${standalone ? `<label class="finance-field finance-full"><span>Imóvel da EBV</span><select data-field="propertyId">${options || '<option value="">Simulação sem imóvel selecionado</option>'}</select></label>` : ""}
        <label class="finance-field"><span>Valor do imóvel</span><input data-field="propertyValue" type="number" min="1" step="1000" inputmode="numeric" value="${propertyValue}"></label>
        <div class="finance-field"><span>Entrada</span><div class="finance-entry-row"><input data-field="entry" type="number" min="0" step="1000" inputmode="numeric" value="${Math.round(minimumEntry)}"><select data-field="entryMode" aria-label="Forma da entrada"><option value="currency">R$</option><option value="percent">%</option></select></div><small data-entry-help>Mínimo de referência SAC: ${NUMBER.format(settings.minimumEntrySacPercent)}%</small></div>
        <label class="finance-check finance-full"><input data-field="usesFgts" type="checkbox"><span>Quero considerar meu FGTS na entrada</span></label>
        <label class="finance-field finance-full is-collapsed" data-fgts-field><span>Valor do FGTS</span><input data-field="fgts" type="number" min="0" step="1000" inputmode="numeric" value="0"></label>
        <label class="finance-check finance-full"><input data-field="hasExchange" type="checkbox"><span>Tenho um imóvel para entrar na negociação</span></label>
        <label class="finance-field finance-full is-collapsed" data-exchange-field><span>Valor estimado do imóvel na troca</span><input data-field="exchange" type="number" min="0" step="1000" inputmode="numeric" value="0"><small data-exchange-help></small></label>
        <label class="finance-field"><span>Prazo</span><div class="finance-range-line"><input data-field="termYears" type="range" min="${settings.minimumTermYears}" max="${settings.maximumTermYears}" value="35"><output data-term-output>35 anos</output></div></label>
        <label class="finance-field"><span>Renda mensal opcional</span><input data-field="income" type="number" min="0" step="500" inputmode="numeric" placeholder="Exemplo: 18000"></label>
        <button type="submit" class="btn-primary finance-full">Atualizar simulação</button>
      </form>
      <div class="finance-results" data-finance-results aria-live="polite"></div>
      <div class="finance-actions">
        <button type="button" class="btn-primary" data-open-contact>Quero simular com a corretora</button>
        ${standalone ? '<a class="btn-secondary" href="/#imoveis">Ver imóveis disponíveis</a>' : '<a class="finance-text-link" href="/simulador">Abrir simulador completo</a>'}
      </div>
      <form class="finance-contact is-collapsed" data-contact-form>
        <div><span class="section-tagline">Leve os números para a Edicleia</span><h3>Receba ajuda para sua simulação</h3><p>Informe seus dados e a corretora entrará em contato com os valores que você simulou.</p></div>
        <label class="finance-field"><span>Nome</span><input data-contact-name required maxlength="120" autocomplete="name"></label>
        <label class="finance-field"><span>WhatsApp</span><input data-contact-phone required maxlength="20" inputmode="tel" autocomplete="tel" placeholder="(41) 99999 9999"></label>
        <button type="submit" class="btn-primary">Enviar simulação</button>
        <p class="finance-form-status" data-contact-status aria-live="polite"></p>
      </form>
      <p class="finance-disclaimer">Valores estimados. A aprovação, a taxa final, os seguros, a TR e as demais condições dependem da análise do banco.</p>
      <p class="finance-source">Referência consultada em ${sourceDate}: <a href="${escapeHtml(settings.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(settings.sourceLabel)}</a>.</p>
    </div>`;
}

function bindCalculator(state) {
  const { root } = state;
  const form = root.querySelector("[data-finance-form]");
  form.addEventListener("submit", event => {
    event.preventDefault();
    updateCalculation(state, true);
  });
  form.addEventListener("input", event => {
    const name = event.target.dataset.field;
    if (name === "usesFgts") root.querySelector("[data-fgts-field]").classList.toggle("is-collapsed", !event.target.checked);
    if (name === "hasExchange") root.querySelector("[data-exchange-field]").classList.toggle("is-collapsed", !event.target.checked);
    if (name === "termYears") root.querySelector("[data-term-output]").textContent = `${event.target.value} anos`;
    if (["entryMode", "propertyValue", "propertyId"].includes(name)) syncEntry(state, name);
    updateCalculation(state, false);
  });
  const propertySelect = root.querySelector('[data-field="propertyId"]');
  if (propertySelect) propertySelect.addEventListener("change", () => selectProperty(state, propertySelect.value));
  root.querySelector("[data-open-contact]").addEventListener("click", () => openContactForm(state));
  root.querySelector("[data-contact-form]").addEventListener("submit", event => submitContact(event, state));
}

function selectProperty(state, id) {
  state.property = properties().find(item => item.id === id) || null;
  if (!state.property) return;
  const value = Number(state.property.price) || 0;
  state.root.querySelector('[data-field="propertyValue"]').value = value;
  const entryMode = state.root.querySelector('[data-field="entryMode"]').value;
  state.root.querySelector('[data-field="entry"]').value = entryMode === "percent"
    ? state.settings.minimumEntrySacPercent
    : Math.round(value * state.settings.minimumEntrySacPercent / 100);
  updateCalculation(state, false);
}

function syncEntry(state, changed) {
  const propertyValue = Number(state.root.querySelector('[data-field="propertyValue"]').value) || 0;
  const mode = state.root.querySelector('[data-field="entryMode"]').value;
  const entry = state.root.querySelector('[data-field="entry"]');
  if (changed === "entryMode") {
    const current = Number(entry.value) || 0;
    entry.value = mode === "percent"
      ? Number((current / Math.max(1, propertyValue) * 100).toFixed(2))
      : Math.round(propertyValue * current / 100);
    entry.step = mode === "percent" ? "0.5" : "1000";
  }
}

function readInput(state) {
  const find = name => state.root.querySelector(`[data-field="${name}"]`);
  const propertyValue = Number(find("propertyValue").value) || 0;
  const rawEntry = Number(find("entry").value) || 0;
  const mode = find("entryMode").value;
  return {
    propertyValue,
    entry: mode === "percent" ? propertyValue * rawEntry / 100 : rawEntry,
    entryMode: mode,
    entryPercent: mode === "percent" ? rawEntry : propertyValue ? rawEntry / propertyValue * 100 : 0,
    usesFgts: find("usesFgts").checked,
    fgts: Number(find("fgts").value) || 0,
    hasExchange: find("hasExchange").checked,
    exchange: Number(find("exchange").value) || 0,
    termYears: Number(find("termYears").value) || state.settings.maximumTermYears,
    income: Number(find("income").value) || 0,
    annualRateEffective: Number(state.settings.annualRateEffective),
    incomeCommitmentPercent: Number(state.settings.incomeCommitmentPercent),
  };
}

function updateCalculation(state, shouldRecord) {
  const input = readInput(state);
  const limit = exchangeLimit(state.property);
  if (limit && input.exchange > input.propertyValue * limit / 100) input.exchange = input.propertyValue * limit / 100;
  const result = calculateFinancing(input);
  state.result = { input, result };
  state.root.querySelector("[data-finance-results]").innerHTML = resultMarkup(state, input, result);
  const help = state.root.querySelector("[data-exchange-help]");
  help.textContent = limit ? `Este imóvel aceita apartamento de até ${NUMBER.format(limit)}% do valor na negociação.` : "A aceitação depende da análise da proprietária e da corretora.";
  if (shouldRecord) recordSimulation(state).catch(() => {});
  if (shouldRecord && window.EBVTracking && window.EBVTracking.siteMetric) {
    window.EBVTracking.siteMetric("calculator_use", { propertyId: state.property && state.property.id });
    window.EBVTracking.siteMetric("simulator_calculate", { propertyId: state.property && state.property.id });
  }
}

function resultMarkup(state, input, result) {
  const incomeLimit = input.income ? input.income * state.settings.incomeCommitmentPercent / 100 : 0;
  const incomeOk = !input.income || Math.max(result.sac.first, result.price.first) <= incomeLimit;
  return `
    <div class="finance-summary">
      <div><span>Valor financiado</span><strong>${CURRENCY.format(result.financed)}</strong></div>
      <div><span>Prazo</span><strong>${result.months} meses</strong></div>
      <div><span>Renda mínima estimada</span><strong>${CURRENCY.format(result.minimumIncome)}</strong></div>
    </div>
    ${input.income ? `<p class="finance-income ${incomeOk ? "is-ok" : "is-alert"}">${incomeOk ? "A renda informada comporta a maior primeira parcela dentro do limite de referência." : "A renda informada fica abaixo da estimativa para a maior primeira parcela."}</p>` : ""}
    <div class="finance-plans">
      ${planCard("SAC", result.sac, "Parcela cai ao longo do tempo", state.settings.minimumEntrySacPercent)}
      ${planCard("Price", result.price, "Parcela de juros e amortização constante na estimativa", state.settings.minimumEntryPricePercent)}
    </div>
    <div class="finance-chart"><div class="finance-chart-head"><strong>Evolução estimada da parcela SAC</strong><span>${CURRENCY.format(result.sac.first)} até ${CURRENCY.format(result.sac.last)}</span></div>${chartSvg(buildSacSeries(input))}</div>`;
}

function planCard(name, plan, subtitle, entryPercent) {
  return `<article class="finance-plan"><div class="finance-plan-title"><h3>${name}</h3><span>entrada de referência ${NUMBER.format(entryPercent)}%</span></div><p>${subtitle}</p><dl><div><dt>Primeira parcela</dt><dd>${CURRENCY.format(plan.first)}</dd></div><div><dt>Última parcela</dt><dd>${CURRENCY.format(plan.last)}</dd></div><div><dt>Total estimado</dt><dd>${CURRENCY.format(plan.total)}</dd></div></dl></article>`;
}

function chartSvg(series) {
  if (!series.length) return '<div class="finance-chart-empty">Informe um valor financiado para ver o gráfico.</div>';
  const width = 720;
  const height = 180;
  const max = Math.max(...series.map(point => point.value));
  const min = Math.min(...series.map(point => point.value));
  const range = Math.max(1, max - min);
  const points = series.map((point, index) => {
    const x = 10 + index / Math.max(1, series.length - 1) * (width - 20);
    const y = 10 + (max - point.value) / range * (height - 20);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico com redução da parcela SAC"><defs><linearGradient id="financeArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#722f37" stop-opacity=".28"></stop><stop offset="1" stop-color="#722f37" stop-opacity=".02"></stop></linearGradient></defs><polygon points="10,${height - 10} ${points} ${width - 10},${height - 10}" fill="url(#financeArea)"></polygon><polyline points="${points}" fill="none" stroke="#722f37" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
}

async function recordSimulation(state) {
  if (!state.result) return null;
  const payload = simulationPayload(state);
  const response = await fetch("/api/financing/simulations", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Não foi possível registrar a simulação.");
  const saved = await response.json();
  state.simulationId = saved.id;
  return saved.id;
}

function simulationPayload(state) {
  return {
    propertyId: state.property && state.property.id || null,
    propertyTitle: state.property && state.property.title || "Simulação sem imóvel selecionado",
    propertyValue: state.result.result.propertyValue,
    input: state.result.input,
    result: state.result.result,
  };
}

function openContactForm(state) {
  const form = state.root.querySelector("[data-contact-form]");
  form.classList.remove("is-collapsed");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => form.querySelector("[data-contact-name]").focus(), 250);
  if (window.EBVTracking && window.EBVTracking.siteMetric) {
    window.EBVTracking.siteMetric("form_open", { propertyId: state.property && state.property.id });
  }
}

async function submitContact(event, state) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("[data-contact-status]");
  const name = form.querySelector("[data-contact-name]").value.trim().replace(/\s+/g, " ");
  const phone = form.querySelector("[data-contact-phone]").value.trim();
  const digits = phone.replace(/\D/g, "");
  if (name.length < 2) return showStatus(status, "Informe seu nome.", true);
  if (digits.length < 8 || digits.length > 13) return showStatus(status, "Informe um número válido.", true);
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  showStatus(status, "Enviando sua simulação...", false);
  try {
    if (!state.simulationId) await recordSimulation(state);
    const { input, result } = state.result;
    const tracking = window.EBVTracking && window.EBVTracking.collect ? window.EBVTracking.collect() : {};
    const response = await fetch("/api/leads", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        phone,
        leadType: "comprador",
        context: "simulador",
        interest: "comprar",
        cta: "simulador",
        propertyId: state.property && state.property.id || null,
        propertyTitle: state.property && state.property.title || "Simulação de financiamento",
        value: result.propertyValue,
        tracking,
        simulation: {
          id: state.simulationId,
          propertyValue: result.propertyValue,
          entry: result.entry,
          fgts: result.fgts,
          exchange: result.exchange,
          financed: result.financed,
          termYears: input.termYears,
          annualRateEffective: input.annualRateEffective,
          sacFirst: result.sac.first,
          sacLast: result.sac.last,
          priceFirst: result.price.first,
          priceLast: result.price.last,
          minimumIncome: result.minimumIncome,
          usesFgts: input.usesFgts,
          hasExchange: input.hasExchange,
        },
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body && body.error && body.error.message || "Não foi possível enviar.");
    form.reset();
    showStatus(status, `Recebido. A Edicleia verá sua simulação no CRM. Referência ${body.ref}.`, false, true);
    if (window.EBVTracking && window.EBVTracking.generateLead) {
      window.EBVTracking.generateLead({
        lead_type: "comprador",
        cta: "simulador",
        propertyId: state.property && state.property.id,
        content_name: state.property && state.property.title || "Simulação de financiamento",
      }, body.eventId);
    }
    if (window.EBVTracking && window.EBVTracking.siteMetric) {
      window.EBVTracking.siteMetric("simulator_contact", { propertyId: state.property && state.property.id });
    }
  } catch (error) {
    showStatus(status, error.message || "Não foi possível enviar agora.", true);
  } finally {
    button.disabled = false;
  }
}

function showStatus(element, message, error, success = false) {
  element.textContent = message;
  element.className = `finance-form-status ${error ? "is-error" : success ? "is-success" : ""}`;
}

async function renderAdmin() {
  const form = document.getElementById("financing-settings-form");
  if (!form || form.dataset.loaded === "true") return;
  const [settingsResponse, metricsResponse] = await Promise.all([
    fetch("/api/admin/financing/settings", { credentials: "same-origin" }),
    fetch("/api/admin/financing/metrics", { credentials: "same-origin" }),
  ]);
  if (!settingsResponse.ok) return;
  const settings = await settingsResponse.json();
  const metrics = metricsResponse.ok ? await metricsResponse.json() : { simulations: 0, contacts: 0, conversionRate: 0 };
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  }
  document.getElementById("financing-stat-simulations").textContent = metrics.simulations;
  document.getElementById("financing-stat-contacts").textContent = metrics.contacts;
  document.getElementById("financing-stat-conversion").textContent = `${NUMBER.format(metrics.conversionRate)}%`;
  form.dataset.loaded = "true";
  form.addEventListener("submit", saveAdminSettings);
}

async function saveAdminSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("[data-settings-status]");
  const data = Object.fromEntries(new FormData(form).entries());
  for (const key of ["annualRateEffective", "minimumEntrySacPercent", "minimumEntryPricePercent", "minimumTermYears", "maximumTermYears", "incomeCommitmentPercent"]) data[key] = Number(data[key]);
  const response = await fetch("/api/admin/financing/settings", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) return showStatus(status, body && body.error && body.error.message || "Não foi possível salvar.", true);
  settingsPromise = Promise.resolve(body);
  showStatus(status, "Taxa e referências atualizadas.", false, true);
}

function refreshProperties() {
  const page = document.getElementById("financing-page-root");
  if (page && !calculatorStates.has(page)) renderCalculator(page, triplex(), true);
}

function openForProperty(property) {
  const root = document.getElementById("modal-financing-root");
  if (root) renderCalculator(root, property, false);
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "data não informada";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day));
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.EBVFinancing = { refreshProperties, openForProperty, openAdmin: renderAdmin };
  document.addEventListener("DOMContentLoaded", refreshProperties);
}

