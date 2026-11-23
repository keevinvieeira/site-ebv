// EBV Imóveis - CRM no painel (Hoje, Funil, Contatos, Atendimento e ficha do contato).
// Mobile-first para uso no celular da corretora Edicleia + integração Instagram Direct (@username).
// Depende de apiRequest, escapeHTML e formatBRL definidos em app.js.
(function () {
  "use strict";

  const STAGES = [
    ["novo", "Novo"],
    ["contatado", "Contatado"],
    ["qualificado", "Qualificado"],
    ["visita", "Visita agendada"],
    ["proposta", "Proposta"],
    ["fechado", "Fechado"],
    ["perdido", "Perdido"],
  ];
  const STAGE_LABEL = Object.fromEntries(STAGES);
  const OPEN = ["novo", "contatado", "qualificado", "visita", "proposta"];
  const LOST_REASONS = ["Sem resposta", "Fora do orçamento", "Comprou com outro corretor", "Desistiu", "Financiamento negado", "Só pesquisando", "Outro"];
  const TIPOS = ["apartamento", "casa", "sobrado", "cobertura", "terreno"];
  const GENERIC_NAMES = new Set(["", "sem nome", "contato do atendimento", "ainda sem telefone", "contato instagram", "contato sem nome"]);

  let overview = null;
  let contacts = [];
  let currentContactId = null;
  let searchTimer = null;
  let activeStageFilter = "todos";

  const $ = sel => document.querySelector(sel);
  const esc = v => (typeof escapeHTML === "function" ? escapeHTML(String(v == null ? "" : v)) : String(v == null ? "" : v));
  const money = v => (typeof formatBRL === "function" ? formatBRL(Number(v) || 0) : `R$ ${Number(v || 0).toLocaleString("pt-BR")}`);

  function api(path, options = {}) {
    return apiRequest(path, options);
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "crm-toast";
    el.setAttribute("role", "status");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function cleanHandle(u) {
    return String(u || "").trim().replace(/^@+/, "").replace(/\s+/g, "");
  }

  function isGenericName(name) {
    return GENERIC_NAMES.has(String(name || "").trim().toLowerCase());
  }

  function formatDisplayName(rawName, igName, igUsername, fallback = "Contato Instagram") {
    const handle = cleanHandle(igUsername);
    const candidate = !isGenericName(rawName) ? String(rawName).trim() : (!isGenericName(igName) ? String(igName).trim() : "");
    if (candidate) return candidate;
    if (handle) return `@${handle}`;
    return fallback;
  }

  function igChipHtml(igUsername, rawName) {
    let handle = cleanHandle(igUsername);
    if (!handle && rawName) {
      const m = String(rawName).match(/@([A-Za-z0-9._]{2,40})/);
      if (m) handle = m[1];
    }
    if (!handle) return "";
    return `<a class="crm-ig-chip" href="https://www.instagram.com/${encodeURIComponent(handle)}/" target="_blank" rel="noopener" data-crm-link title="Abrir @${esc(handle)} no Instagram">@${esc(handle)}</a>`;
  }

  function initials(name) {
    const clean = String(name || "?").replace(/^@+/, "").trim();
    return clean.split(/[\s._]+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase() || "?";
  }

  function normalizePhoneDigits(raw) {
    let d = String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
    if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
    if (d.length === 8 || d.length === 9) d = `41${d}`;
    return d.length >= 10 && d.length <= 11 ? d : "";
  }

  function extractPhoneFromMessages(messages) {
    for (const m of (messages || [])) {
      if (m && m.direction && m.direction !== "in") continue;
      const body = String((m && m.body) || "")
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/\bprop-[\w-]+\b/gi, " ")
        .replace(/R\$\s*\d[\d.,]*/gi, " ");
      const hit = body.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-\s.]?\d{4}\b/);
      if (hit) {
        const norm = normalizePhoneDigits(hit[0]);
        if (norm) return norm;
      }
    }
    return "";
  }

  function phoneFmt(d) {
    const norm = normalizePhoneDigits(d);
    if (norm.length === 11) return `(${norm.slice(0, 2)}) ${norm.slice(2, 7)}-${norm.slice(7)}`;
    if (norm.length === 10) return `(${norm.slice(0, 2)}) ${norm.slice(2, 6)}-${norm.slice(6)}`;
    return String(d || "").trim();
  }

  function waLink(phone, text) {
    const d = normalizePhoneDigits(phone);
    if (!d) return null;
    const full = `55${d}`;
    return `https://wa.me/${full}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
  }

  function telLink(phone) {
    const d = normalizePhoneDigits(phone);
    return d ? `tel:+55${d}` : null;
  }

  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
    if (sameDay) return `hoje ${time}`;
    const yest = new Date(now.getTime() - 86400000);
    if (d.toDateString() === yest.toDateString()) return `ontem ${time}`;
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" }) + ` ${time}`;
  }

  function ago(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${Math.max(mins, 0)} min`;
    const h = Math.round(mins / 60);
    if (h < 48) return `${h} h`;
    return `${Math.round(h / 24)} dias`;
  }

  function roleChips(roles, leadType) {
    const set = new Set(roles || []);
    if (leadType) set.add(leadType);
    let out = "";
    if (set.has("comprador")) out += '<span class="crm-chip">Comprador</span>';
    if (set.has("proprietario")) out += '<span class="crm-chip crm-chip-owner">Proprietário</span>';
    if (set.has("cliente")) out += '<span class="crm-chip crm-chip-client">Cliente</span>';
    return out;
  }

  function stageBadgeHtml(stage) {
    if (!stage) return "";
    const label = STAGE_LABEL[stage] || stage;
    return `<span class="crm-stage-badge is-stage-${esc(stage)}">${esc(label)}</span>`;
  }

  // ---------- Carregamento ----------

  async function load() {
    if (typeof adminAuthenticated !== "undefined" && !adminAuthenticated) return;
    try {
      overview = await api("/api/admin/crm/overview", { method: "GET" });
    } catch (err) {
      console.warn("CRM overview:", err);
      return;
    }
    renderKpis();
    renderToday();
    renderBoard();
    const count = $("#crm-today-count");
    if (count) count.textContent = overview.today.length;
    const contactsPanel = $('[data-crm-panel="contatos"]');
    if (contactsPanel && contactsPanel.classList.contains("is-active")) loadContacts();
    const atendPanel = $('[data-crm-panel="atendimento"]');
    if (atendPanel && atendPanel.classList.contains("is-active")) loadAtendimento();
  }

  async function loadContacts() {
    const q = ($("#crm-contact-search") || {}).value || "";
    try {
      contacts = await api(`/api/admin/crm/contacts?q=${encodeURIComponent(q)}`, { method: "GET" });
    } catch (err) {
      console.warn("CRM contacts:", err);
      contacts = [];
    }
    renderContacts();
  }

  // ---------- Render ----------

  function renderKpis() {
    const s = overview.stats;
    const open = overview.deals.filter(d => OPEN.includes(d.stage)).length;
    const late = overview.today.filter(t => new Date(t.dueAt) < new Date()).length;
    const origins = Object.entries(s.porOrigem).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(" · ");
    $("#crm-kpis").innerHTML = `
      <div class="crm-kpi"><div class="crm-kpi-label">Tarefas de hoje</div><div class="crm-kpi-value">${overview.today.length}</div><div class="crm-kpi-note">${late ? `${late} atrasada(s)` : "nada atrasado"}</div></div>
      <div class="crm-kpi"><div class="crm-kpi-label">Em andamento</div><div class="crm-kpi-value">${open}</div><div class="crm-kpi-note">negócios abertos</div></div>
      <div class="crm-kpi"><div class="crm-kpi-label">Leads 30 dias</div><div class="crm-kpi-value">${s.novos30d}</div><div class="crm-kpi-note">${esc(origins || "sem leads ainda")}</div></div>
      <div class="crm-kpi"><div class="crm-kpi-label">Qualificados</div><div class="crm-kpi-value">${s.porEtapa.qualificado || 0}</div><div class="crm-kpi-note">${s.fechados30d || 0} fechado(s) 30d</div></div>`;
  }

  function taskHtml(t, showContact = true) {
    const late = new Date(t.dueAt) < new Date() && !t.doneAt;
    const wa = t.contactPhone ? waLink(t.contactPhone) : null;
    const contactLabel = formatDisplayName(t.contactName, "", "", "Abrir ficha");
    return `
      <div class="crm-task${late ? " is-late" : ""}">
        <input type="checkbox" class="crm-task-check" data-task-done="${esc(t.id)}" ${t.doneAt ? "checked" : ""} aria-label="Marcar como feita: ${esc(t.title)}">
        <div class="crm-task-main">
          <div class="crm-task-title">${esc(t.title)}</div>
          <div class="crm-task-meta">
            <span class="${late ? "is-late" : ""}">${late ? "Atrasada · " : ""}${esc(when(t.dueAt))}</span>
            ${showContact && t.contactId ? ` · <button type="button" class="crm-link" data-open-contact="${esc(t.contactId)}">${esc(contactLabel)}</button>` : ""}
            ${t.origin === "auto" ? " · automática" : t.origin === "agente" || t.origin === "sdr" ? " · Instagram/SDR" : ""}
          </div>
        </div>
        <div class="crm-task-actions">
          ${showContact && t.contactId ? `<button type="button" class="crm-btn crm-btn-sm" data-open-contact="${esc(t.contactId)}">Ficha</button>` : ""}
          ${wa && !t.doneAt ? `<a class="crm-btn crm-btn-sm crm-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-crm-link>WhatsApp</a>` : ""}
        </div>
      </div>`;
  }

  function renderToday() {
    const el = $("#crm-today");
    const { today, upcoming } = overview;
    let html = '<div class="crm-section-title">Para hoje</div>';
    html += today.length ? today.map(t => taskHtml(t)).join("") : '<div class="crm-empty">Nenhuma tarefa para hoje. Quando chegar lead novo, a tarefa de resposta aparece aqui sozinha.</div>';
    if (upcoming.length) {
      html += '<div class="crm-section-title">Próximos dias</div>' + upcoming.slice(0, 15).map(t => taskHtml(t)).join("");
    }
    el.innerHTML = html;
  }

  function renderBoard() {
    if (!overview) return;
    const type = ($("#crm-funnel-type") || {}).value || "todos";
    const deals = overview.deals.filter(d => type === "todos" || d.leadType === type);

    // Barra de filtro rápido de etapas (mobile-first)
    let filterBar = $("#crm-stage-pills");
    if (!filterBar) {
      const funnelRow = document.querySelector('[data-crm-panel="funil"] .crm-filter-row');
      if (funnelRow) {
        filterBar = document.createElement("div");
        filterBar.id = "crm-stage-pills";
        filterBar.className = "crm-stage-pills";
        funnelRow.insertAdjacentElement("afterend", filterBar);
      }
    }
    if (filterBar) {
      const allCount = deals.length;
      const pills = [
        `<button type="button" class="crm-stage-pill${activeStageFilter === "todos" ? " is-active" : ""}" data-stage-filter="todos">Todas <span>${allCount}</span></button>`,
        ...STAGES.map(([key, label]) => {
          const cnt = deals.filter(d => d.stage === key).length;
          return `<button type="button" class="crm-stage-pill${activeStageFilter === key ? " is-active" : ""}" data-stage-filter="${esc(key)}">${esc(label)} <span>${cnt}</span></button>`;
        }),
      ];
      filterBar.innerHTML = pills.join("");
    }

    const stagesToRender = activeStageFilter === "todos"
      ? STAGES
      : STAGES.filter(([key]) => key === activeStageFilter);

    const cols = stagesToRender.map(([key, label]) => {
      const items = deals.filter(d => d.stage === key);
      const shown = (key === "fechado" || key === "perdido") && activeStageFilter === "todos" ? items.slice(0, 15) : items;
      return `
        <div class="crm-col" data-stage-col="${esc(key)}">
          <div class="crm-col-head"><span>${esc(label)}</span><span class="crm-col-count">${items.length}</span></div>
          ${shown.length ? shown.map(d => {
            const displayName = formatDisplayName(d.name, d.instagramName, d.instagramUsername, "Lead Instagram");
            const igChip = igChipHtml(d.instagramUsername, d.name);
            const phoneText = phoneFmt(d.phone);
            const wa = waLink(d.phone, `Olá ${displayName.replace(/^@/, "").split(" ")[0]}, aqui é a Edicleia da EBV Imóveis.`);
            return `
            <div class="crm-card">
              <div class="crm-card-top" data-open-contact="${esc(d.contactId || "")}" role="button" tabindex="0">
                <div class="crm-card-name-row">
                  <span class="crm-card-name">${esc(displayName)}</span>
                  ${igChip}
                </div>
                ${phoneText ? `<div class="crm-card-phone">${esc(phoneText)}</div>` : ""}
                <div class="crm-card-sub">${roleChips([], d.leadType)}${esc(d.propertyTitle || (d.leadType === "proprietario" ? "Captação" : "Sobrado Triplex / Imóvel EBV"))}</div>
                ${d.notes || d.summary ? `<div class="crm-card-note">${esc(d.notes || d.summary)}</div>` : ""}
                <div class="crm-card-sub">${esc(d.origin)} · há ${esc(ago(d.updatedAt))}${d.stage === "perdido" && d.lostReason ? ` · ${esc(d.lostReason)}` : ""}</div>
              </div>
              <div class="crm-card-footer">
                <select class="crm-card-stage-select" data-deal-stage="${esc(d.id)}" aria-label="Mudar etapa no funil">
                  ${STAGES.map(([v, l]) => `<option value="${v}"${v === d.stage ? " selected" : ""}>${l}</option>`).join("")}
                </select>
                ${wa ? `<a class="crm-btn crm-btn-sm crm-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-crm-link>WhatsApp</a>` : ""}
                ${d.contactId ? `<button type="button" class="crm-btn crm-btn-sm crm-btn-primary" data-open-contact="${esc(d.contactId)}">Abrir ficha</button>` : ""}
              </div>
            </div>`;
          }).join("") : '<div class="crm-col-empty">Nenhum lead nesta etapa</div>'}
          ${items.length > shown.length ? `<div class="crm-muted">+ ${items.length - shown.length} mais</div>` : ""}
        </div>`;
    }).join("");
    $("#crm-board").innerHTML = cols;
  }

  function renderContacts() {
    const el = $("#crm-contact-list");
    if (!contacts.length) {
      el.innerHTML = '<div class="crm-empty">Nenhum contato encontrado.</div>';
      return;
    }
    el.innerHTML = contacts.map(c => {
      const p = c.profile || {};
      const displayName = formatDisplayName(c.name, p.instagramName, p.instagramUsername, "Contato Instagram");
      const igChip = igChipHtml(p.instagramUsername, c.name);
      const wa = waLink(c.phone, `Olá ${displayName.replace(/^@/, "").split(" ")[0]}, aqui é a Edicleia da EBV Imóveis.`);
      return `
      <div class="crm-contact-row">
        <div class="crm-contact-row-main" data-open-contact="${esc(c.id)}" role="button" tabindex="0">
          <span class="crm-avatar" aria-hidden="true">${esc(initials(displayName))}</span>
          <span style="flex:1;min-width:0">
            <span class="crm-card-name-row">
              <span class="crm-card-name">${esc(displayName)}</span>
              ${igChip}
              ${stageBadgeHtml(c.stage)}
            </span>
            <span class="crm-card-sub" style="display:block">${roleChips(c.roles)}${esc(phoneFmt(c.phone) || c.email || "Sem telefone")}</span>
            ${p.obs ? `<span class="crm-card-note" style="display:block">${esc(p.obs)}</span>` : ""}
          </span>
        </div>
        <div class="crm-contact-row-actions">
          <span class="crm-muted crm-contact-time">${esc(when(c.lastActivityAt))}</span>
          ${wa ? `<a class="crm-btn crm-btn-sm crm-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-crm-link>WhatsApp</a>` : ""}
          <button type="button" class="crm-btn crm-btn-sm crm-btn-primary" data-open-contact="${esc(c.id)}">Abrir ficha</button>
        </div>
      </div>`;
    }).join("");
  }

  // ---------- Ficha do contato ----------

  async function openContact(id) {
    if (!id) return;
    currentContactId = id;
    const drawer = $("#crm-drawer");
    drawer.hidden = false;
    document.body.style.overflow = "hidden";
    $("#crm-drawer-body").innerHTML = '<div class="crm-muted">Carregando ficha...</div>';
    try {
      const c = await api(`/api/admin/crm/contacts/${encodeURIComponent(id)}`, { method: "GET" });
      renderContact(c);
    } catch (err) {
      $("#crm-drawer-body").innerHTML = `<div class="crm-empty">Não foi possível abrir o contato. ${esc(err.message || "")}</div>`;
    }
  }

  function closeContact() {
    $("#crm-drawer").hidden = true;
    document.body.style.overflow = "";
    currentContactId = null;
  }

  function renderContact(c) {
    const p = c.profile || {};
    const convIgUser = ((c.conversations || [])[0] || {}).instagramUsername || p.instagramUsername || "";
    const convIgName = ((c.conversations || [])[0] || {}).instagramName || p.instagramName || "";
    const displayName = formatDisplayName(c.name, convIgName, convIgUser, "Contato Instagram");
    const igChip = igChipHtml(convIgUser, c.name);
    $("#crm-drawer-title").textContent = displayName;

    const wa = waLink(c.phone, `Olá ${displayName.replace(/^@/, "").split(" ")[0]}, aqui é a Edicleia da EBV Imóveis.`);
    const tel = telLink(c.phone);
    const isBuyer = c.roles.includes("comprador") || c.deals.some(d => d.leadType === "comprador");
    const openTasks = c.tasks.filter(t => !t.doneAt);

    const deals = c.deals.map(d => `
      <div class="crm-deal">
        <div style="min-width:0;flex:1">
          <div class="crm-card-name">${roleChips([], d.leadType)}${esc(d.propertyTitle || (d.leadType === "proprietario" ? "Captação de imóvel" : "Sobrado Triplex / Imóvel EBV"))}</div>
          <div class="crm-card-sub">${esc(d.ref)} · ${esc(d.origin)} · desde ${esc(when(d.createdAt))}${d.value ? ` · ${esc(money(d.value))}` : ""}</div>
        </div>
        <div class="crm-deal-controls">
          <select data-deal-stage="${esc(d.id)}" aria-label="Etapa do negócio">
            ${STAGES.map(([v, l]) => `<option value="${v}"${v === d.stage ? " selected" : ""}>${l}</option>`).join("")}
          </select>
          ${d.stage === "perdido" ? `<select data-deal-lost="${esc(d.id)}" aria-label="Motivo da perda"><option value="">Motivo...</option>${LOST_REASONS.map(r => `<option${r === d.lostReason ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>` : ""}
        </div>
      </div>`).join("") || '<div class="crm-muted">Sem negócios vinculados.</div>';

    const profileForm = `
      <form id="crm-profile-form">
        <div class="crm-field" style="margin-bottom:10px">Tipo de imóvel
          <div class="crm-checks">${TIPOS.map(t => `<label><input type="checkbox" name="tipos" value="${t}"${(p.tipos || []).includes(t) ? " checked" : ""}> ${t[0].toUpperCase() + t.slice(1)}</label>`).join("")}</div>
        </div>
        <label class="crm-field" style="margin-bottom:10px">Bairros (separados por vírgula)
          <input type="text" name="bairros" value="${esc((p.bairros || []).join(", "))}" placeholder="Uberaba de Cima, Jardim das Américas, Batel">
        </label>
        <div class="crm-grid-2" style="margin-bottom:10px">
          <label class="crm-field">Preço mínimo (R$)<input type="text" inputmode="numeric" name="precoMin" value="${p.precoMin ? esc(Number(p.precoMin).toLocaleString("pt-BR")) : ""}"></label>
          <label class="crm-field">Preço máximo (R$)<input type="text" inputmode="numeric" name="precoMax" value="${p.precoMax ? esc(Number(p.precoMax).toLocaleString("pt-BR")) : ""}"></label>
          <label class="crm-field">Quartos (mínimo)<input type="number" min="0" max="10" name="quartosMin" value="${p.quartosMin || ""}"></label>
          <label class="crm-field">Vagas (mínimo)<input type="number" min="0" max="10" name="vagasMin" value="${p.vagasMin || ""}"></label>
          <label class="crm-field">Pagamento
            <select name="pagamento">${["", "Financiamento", "À vista", "FGTS + financiamento", "Permuta"].map(o => `<option value="${o}"${o === (p.pagamento || "") ? " selected" : ""}>${o || "Não informado"}</option>`).join("")}</select>
          </label>
          <label class="crm-field">Prazo para comprar
            <select name="prazo">${["", "Imediato", "Até 3 meses", "Até 6 meses", "Mais de 6 meses"].map(o => `<option value="${o}"${o === (p.prazo || "") ? " selected" : ""}>${o || "Não informado"}</option>`).join("")}</select>
          </label>
        </div>
        <label class="crm-field" style="margin-bottom:10px">Observações / Permuta<textarea name="obs" rows="3">${esc(p.obs || c.notes || "")}</textarea></label>
        <button type="submit" class="crm-btn crm-btn-primary">Salvar perfil</button>
      </form>`;

    const matches = c.matches.length
      ? `<ul class="crm-list-plain">${c.matches.map(m => `<li><span>${esc(m.title)}<br><span class="crm-muted">${esc(m.location || "")}</span></span><span>${esc(money(m.price))}</span></li>`).join("")}</ul>`
      : `<div class="crm-muted">${isBuyer ? "Preencha o perfil de busca para ver os imóveis compatíveis." : "Só para compradores."}</div>`;

    function sdrBox(contact) {
      const conversations = contact.conversations || [];
      const visits = contact.visits || [];
      if (!conversations.length && !visits.length) return '<div class="crm-muted">Nenhuma conversa de WhatsApp ou Instagram.</div>';
      const statusLabel = (channel, status) => status === "humano" ? "Com a corretora" : status === "pausada" ? "IA pausada" : channel === "instagram" ? "IA no Direct" : "Rascunho no WhatsApp";
      return `
        ${visits.map(v => `<p>${esc(v.propertyTitle || "Visita")} · ${esc(v.status)}${v.whenText ? ` · ${esc(v.whenText)}` : ""}</p>`).join("")}
        ${conversations.map(conv => `<p><strong>${esc(conv.channel)}</strong> ${conv.instagramUsername ? `(@${esc(cleanHandle(conv.instagramUsername))}) ` : ""}· ${esc(statusLabel(conv.channel, conv.status))} · ${esc(conv.nextStep || "")}<br><span class="crm-muted">${esc(conv.summary || "")}</span></p>`).join("")}`;
    }

    const viewed = c.viewedProperties.length
      ? `<ul class="crm-list-plain">${c.viewedProperties.map(v => `<li><span>${esc(v.title)}</span><span>${esc(money(v.price))}</span></li>`).join("")}</ul>`
      : '<div class="crm-muted">Nenhum registro.</div>';

    $("#crm-drawer-body").innerHTML = `
      <div class="crm-box">
        <div class="crm-contact-head">
          <span class="crm-avatar" aria-hidden="true">${esc(initials(displayName))}</span>
          <div style="flex:1;min-width:0">
            <div class="crm-card-name-row">
              <span class="crm-card-name">${esc(displayName)}</span>
              ${igChip}
            </div>
            <div class="crm-card-sub">${roleChips(c.roles)}${esc(phoneFmt(c.phone) || "Sem telefone")}${c.email ? ` · ${esc(c.email)}` : ""}</div>
          </div>
          <div class="crm-contact-quick-btns">
            ${wa ? `<a class="crm-btn crm-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-crm-link>WhatsApp</a>` : ""}
            ${tel ? `<a class="crm-btn" href="${esc(tel)}" data-crm-link>Ligar</a>` : ""}
          </div>
        </div>
      </div>

      <div class="crm-box"><h4>Funil e Negócios</h4>${deals}</div>
      <div class="crm-box"><h4>Atendimento Instagram / WhatsApp</h4>${sdrBox(c)}</div>

      <div class="crm-box">
        <h4>Tarefas</h4>
        ${openTasks.length ? openTasks.map(t => taskHtml(t, false)).join("") : '<div class="crm-muted">Nenhuma tarefa aberta.</div>'}
        <form class="crm-inline-form" id="crm-task-form">
          <input type="text" name="title" placeholder="Nova tarefa (ex: ligar e oferecer visita)" required maxlength="300">
          <input type="datetime-local" name="dueAt" aria-label="Quando">
          <button type="submit" class="crm-btn crm-btn-primary">Adicionar</button>
        </form>
      </div>

      <div class="crm-box"><h4>Perfil de busca e negociação</h4>${profileForm}</div>
      <div class="crm-box"><h4>Imóveis compatíveis</h4>${matches}</div>
      <div class="crm-box"><h4>Imóveis que viu no site</h4>${viewed}</div>

      <div class="crm-box">
        <h4>Anotações e histórico</h4>
        <form class="crm-inline-form" id="crm-note-form" style="margin:0 0 14px">
          <textarea name="text" rows="2" placeholder="Anotar algo da conversa (ex: tem Studio para permuta)" required maxlength="4000"></textarea>
          <button type="submit" class="crm-btn crm-btn-primary">Salvar nota</button>
        </form>
        <ul class="crm-timeline">${c.timeline.map(a => `<li>${esc(a.text)}<time datetime="${esc(a.createdAt)}">${esc(when(a.createdAt))}</time></li>`).join("")}</ul>
      </div>`;
  }

  async function refreshContact() {
    if (!currentContactId) return;
    const c = await api(`/api/admin/crm/contacts/${encodeURIComponent(currentContactId)}`, { method: "GET" });
    renderContact(c);
  }

  // ---------- Ações ----------

  async function changeStage(dealId, stage, selectEl) {
    const payload = { stage };
    if (stage === "fechado") {
      const answer = window.prompt("Valor do negócio fechado (R$, só números). Pode deixar em branco.", "");
      if (answer !== null && answer.trim()) {
        const n = Number(answer.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
        if (Number.isFinite(n) && n > 0) payload.value = n;
      }
    }
    if (stage === "perdido") payload.lostReason = "Sem resposta";
    selectEl.disabled = true;
    try {
      await api(`/api/admin/leads/${encodeURIComponent(dealId)}`, { method: "PATCH", body: JSON.stringify(payload) });
      toast(`Etapa: ${STAGE_LABEL[stage]}`);
      await Promise.all([refreshContact(), load()]);
    } catch (err) {
      toast("Não foi possível mudar a etapa.");
      selectEl.disabled = false;
    }
  }

  async function saveProfile(form) {
    const fd = new FormData(form);
    const profile = {
      tipos: fd.getAll("tipos"),
      bairros: String(fd.get("bairros") || "").split(",").map(s => s.trim()).filter(Boolean),
      precoMin: fd.get("precoMin") || null,
      precoMax: fd.get("precoMax") || null,
      quartosMin: fd.get("quartosMin") || null,
      vagasMin: fd.get("vagasMin") || null,
      pagamento: fd.get("pagamento") || null,
      prazo: fd.get("prazo") || null,
      obs: fd.get("obs") || null,
    };
    await api(`/api/admin/crm/contacts/${encodeURIComponent(currentContactId)}`, { method: "PATCH", body: JSON.stringify({ profile }) });
    toast("Perfil salvo");
    await Promise.all([refreshContact(), load()]);
  }

  async function newContact() {
    const name = window.prompt("Nome do contato:");
    if (!name || !name.trim()) return;
    const phone = window.prompt("WhatsApp (com ou sem DDD 41):");
    const norm = normalizePhoneDigits(phone);
    if (!norm) { toast("Telefone inválido."); return; }
    const owner = window.confirm("É proprietário querendo vender? (OK = proprietário, Cancelar = comprador)");
    try {
      const c = await api("/api/admin/crm/contacts", { method: "POST", body: JSON.stringify({ name: name.trim(), phone: norm, role: owner ? "proprietario" : "comprador" }) });
      await load();
      openContact(c.id);
    } catch (err) {
      toast(err.message || "Não foi possível criar o contato.");
    }
  }

  function setView(view) {
    document.querySelectorAll(".crm-view-btn").forEach(b => {
      const on = b.dataset.crmView === view;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".crm-view").forEach(p => p.classList.toggle("is-active", p.dataset.crmPanel === view));
    if (view === "contatos") loadContacts();
    if (view === "atendimento") loadAtendimento();
  }

  async function loadAtendimento() {
    const box = $("#crm-atendimento");
    box.innerHTML = '<div class="crm-muted">Carregando atendimento...</div>';
    try {
      const data = await api("/api/admin/crm/atendimento", { method: "GET" });
      renderAtendimento(data);
    } catch (err) {
      box.innerHTML = `<div class="crm-empty">Não foi possível abrir o atendimento. ${esc(err.message || "")}</div>`;
    }
  }

  function renderAtendimento(data) {
    const statusLabel = (channel, status) => status === "humano" ? "Com a corretora" : status === "pausada" ? "IA pausada" : channel === "instagram" ? "IA no Direct" : "Rascunho no WhatsApp";
    const visits = (data.visits || []).map(v => `
      <div class="crm-sdr-card">
        <strong>${esc(formatDisplayName(v.contactName, "", "", "Cliente com pedido de visita"))}</strong>
        <div class="crm-card-sub">${esc(v.propertyTitle || "Imóvel")} ${v.whenText ? `· ${esc(v.whenText)}` : ""}</div>
        <div class="crm-actions" style="margin-top:8px">
          <button type="button" class="crm-btn crm-btn-sm crm-btn-primary" data-sdr-visit="${esc(v.id)}" data-sdr-decision="aprovar">Aprovar visita</button>
          <button type="button" class="crm-btn crm-btn-sm" data-sdr-visit="${esc(v.id)}" data-sdr-decision="recusar">Recusar</button>
          ${v.contactId ? `<button type="button" class="crm-btn crm-btn-sm" data-open-contact="${esc(v.contactId)}">Abrir ficha</button>` : ""}
        </div>
      </div>`).join("") || '<div class="crm-muted">Nenhum pedido pendente.</div>';

    const conversations = (data.conversations || []).map(c => {
      const q = c.qualification || {};
      const igUser = c.instagramUsername || q.instagramUsername || "";
      const igName = c.instagramName || q.instagramName || q.name || "";
      const detectedPhone = normalizePhoneDigits(c.phone || q.phone || extractPhoneFromMessages(c.messages));
      const fallbackLabel = c.channel === "instagram" ? "Contato Instagram Direct" : "Contato WhatsApp";
      const displayName = formatDisplayName(c.contactName, igName, igUser, detectedPhone ? phoneFmt(detectedPhone) : fallbackLabel);
      const igChip = igChipHtml(igUser, c.contactName || igName);
      const stage = c.leadStage || q.stage || (detectedPhone ? "qualificado" : "");
      const wa = detectedPhone ? waLink(detectedPhone, `Olá ${displayName.replace(/^@/, "").split(" ")[0]}, aqui é a Edicleia da EBV Imóveis.`) : null;
      const cleanMessages = (c.messages || []).filter(m => {
        if (!m || !m.body) return false;
        if (m.direction === "sugestao" && /me passa seu nome e sobrenome\?/i.test(m.body)) return false;
        return true;
      });
      const summaryParts = [];
      if (q.propertyTitle) summaryParts.push(q.propertyTitle);
      if (c.summary && c.summary !== "vazio") summaryParts.push(c.summary);
      if (q.obs || q.notes) summaryParts.push(q.obs || q.notes);
      const summaryText = summaryParts.join(" · ") || (detectedPhone ? "Telefone informado no Direct" : "Conversa ativa no Direct");
      const nextStepText = detectedPhone && (!c.nextStep || /Pedir nome/i.test(c.nextStep))
        ? "Lead com telefone no CRM"
        : (c.nextStep && !/Pedir nome/i.test(c.nextStep) ? c.nextStep : "Em atendimento");

      return `
      <article class="crm-sdr-card">
        <div class="crm-sdr-head">
          <div class="crm-card-name-row">
            <span class="crm-card-name">${esc(displayName)}</span>
            ${igChip}
            ${stageBadgeHtml(stage)}
          </div>
          <span class="crm-status">${esc(c.channel)} · ${esc(statusLabel(c.channel, c.status))}</span>
        </div>
        ${detectedPhone ? `<div class="crm-card-phone">${esc(phoneFmt(detectedPhone))}</div>` : ""}
        <div class="crm-card-sub">${esc(summaryText)} · próximo: ${esc(nextStepText)}</div>
        <div class="crm-sdr-messages">
          ${cleanMessages.map(m => `<p class="crm-sdr-msg is-${esc(m.direction)}"><span class="crm-sdr-msg-role">${m.direction === "out" ? "EBV: " : m.direction === "sugestao" ? "Sugestão: " : m.direction === "in" ? "Cliente: " : ""}</span>${esc(m.body)}</p>`).join("")}
        </div>
        <div class="crm-actions" style="margin-top:10px">
          ${c.contactId ? `<button type="button" class="crm-btn crm-btn-sm crm-btn-primary" data-open-contact="${esc(c.contactId)}">Abrir ficha</button>` : ""}
          ${wa ? `<a class="crm-btn crm-btn-sm crm-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-crm-link>WhatsApp</a>` : ""}
          <button type="button" class="crm-btn crm-btn-sm${!c.contactId ? " crm-btn-primary" : ""}" data-sdr-conversation="${esc(c.id)}" data-sdr-action="assumir">Assumir conversa</button>
          <button type="button" class="crm-btn crm-btn-sm" data-sdr-conversation="${esc(c.id)}" data-sdr-action="pausar">Pausar IA</button>
          <button type="button" class="crm-btn crm-btn-sm" data-sdr-conversation="${esc(c.id)}" data-sdr-action="retomar">Retomar IA</button>
        </div>
      </article>`;
    }).join("") || '<div class="crm-muted">Nenhuma conversa ainda.</div>';

    $("#crm-atendimento").innerHTML = `
      <p class="crm-muted">No Instagram, a IA responde mensagens novas do Direct e já puxa nome, @usuário e telefone para criar a ficha e enviar ao funil. Assumir conversa ou Pausar IA interrompe o robô naquela conversa.</p>
      <div class="crm-section-title">Visitas para aprovar</div>
      ${visits}
      <div class="crm-section-title">Conversas do Instagram e WhatsApp</div>
      ${conversations}`;
  }

  // ---------- Eventos ----------

  document.addEventListener("click", e => {
    const viewBtn = e.target.closest(".crm-view-btn");
    if (viewBtn) return setView(viewBtn.dataset.crmView);
    const stagePill = e.target.closest("[data-stage-filter]");
    if (stagePill) {
      activeStageFilter = stagePill.dataset.stageFilter || "todos";
      renderBoard();
      return;
    }
    if (e.target.closest("[data-crm-link]") || e.target.closest("select")) return;
    const open = e.target.closest("[data-open-contact]");
    if (open && open.dataset.openContact) return openContact(open.dataset.openContact);
    if (e.target.closest("[data-crm-close]")) return closeContact();
    if (e.target.closest("[data-crm-new-contact]")) return newContact();
    const action = e.target.closest("[data-sdr-action]");
    if (action) {
      e.preventDefault();
      api(`/api/admin/crm/conversations/${encodeURIComponent(action.dataset.sdrConversation)}/${action.dataset.sdrAction}`, { method: "POST" })
        .then(() => { toast("Atendimento atualizado"); return loadAtendimento(); })
        .catch(() => toast("Não foi possível atualizar a conversa."));
      return;
    }
    const decision = e.target.closest("[data-sdr-decision]");
    if (decision) {
      e.preventDefault();
      api(`/api/admin/crm/visits/${encodeURIComponent(decision.dataset.sdrVisit)}/${decision.dataset.sdrDecision}`, { method: "POST" })
        .then(() => { toast(decision.dataset.sdrDecision === "aprovar" ? "Visita aprovada para a Edicleia combinar" : "Visita recusada"); return loadAtendimento(); })
        .catch(() => toast("Não foi possível decidir a visita."));
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("#crm-drawer").hidden) closeContact();
  });

  document.addEventListener("change", async e => {
    const t = e.target;
    if (t.matches("[data-task-done]")) {
      t.disabled = true;
      try {
        await api(`/api/admin/crm/tasks/${encodeURIComponent(t.dataset.taskDone)}`, { method: "PATCH", body: JSON.stringify({ done: t.checked }) });
        toast(t.checked ? "Tarefa feita" : "Tarefa reaberta");
        await Promise.all([load(), refreshContact()]);
      } catch {
        t.checked = !t.checked;
        t.disabled = false;
      }
      return;
    }
    if (t.matches("[data-deal-stage]")) return changeStage(t.dataset.dealStage, t.value, t);
    if (t.matches("[data-deal-lost]")) {
      await api(`/api/admin/leads/${encodeURIComponent(t.dataset.dealLost)}`, { method: "PATCH", body: JSON.stringify({ lostReason: t.value }) });
      toast("Motivo salvo");
      return;
    }
    if (t.id === "crm-funnel-type" && overview) renderBoard();
  });

  document.addEventListener("input", e => {
    if (e.target.id === "crm-contact-search") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadContacts, 250);
    }
  });

  document.addEventListener("submit", async e => {
    const form = e.target;
    if (form.id === "crm-profile-form") {
      e.preventDefault();
      try { await saveProfile(form); } catch (err) { toast("Não foi possível salvar o perfil."); }
    }
    if (form.id === "crm-note-form") {
      e.preventDefault();
      const text = new FormData(form).get("text");
      try {
        await api(`/api/admin/crm/contacts/${encodeURIComponent(currentContactId)}/notes`, { method: "POST", body: JSON.stringify({ text }) });
        toast("Nota salva");
        await Promise.all([refreshContact(), load()]);
      } catch { toast("Não foi possível salvar a nota."); }
    }
    if (form.id === "crm-task-form") {
      e.preventDefault();
      const fd = new FormData(form);
      const due = fd.get("dueAt") ? new Date(fd.get("dueAt")).toISOString() : new Date().toISOString();
      try {
        await api("/api/admin/crm/tasks", { method: "POST", body: JSON.stringify({ contactId: currentContactId, title: fd.get("title"), dueAt: due }) });
        toast("Tarefa criada");
        await Promise.all([refreshContact(), load()]);
      } catch { toast("Não foi possível criar a tarefa."); }
    }
  });

  window.CRM = { load, openContact };
})();
