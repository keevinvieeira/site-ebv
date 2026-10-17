// EBV Imóveis - CRM no painel (Hoje, Funil, Contatos e ficha do contato).
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

  let overview = null;
  let contacts = [];
  let currentContactId = null;
  let searchTimer = null;

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

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase() || "?";
  }

  function phoneFmt(d) {
    d = String(d || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return d;
  }

  function waLink(phone, text) {
    const d = String(phone || "").replace(/\D/g, "");
    if (!d) return null;
    const full = d.length <= 11 ? `55${d}` : d;
    return `https://wa.me/${full}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
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
    if ($('[data-crm-panel="contatos"]').classList.contains("is-active")) loadContacts();
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
      <div class="crm-kpi"><div class="crm-kpi-label">Fechados 30 dias</div><div class="crm-kpi-value">${s.fechados30d}</div><div class="crm-kpi-note">${(s.porEtapa.qualificado || 0)} qualificado(s) agora</div></div>`;
  }

  function taskHtml(t, showContact = true) {
    const late = new Date(t.dueAt) < new Date() && !t.doneAt;
    const wa = t.contactPhone ? waLink(t.contactPhone) : null;
    return `
      <div class="crm-task${late ? " is-late" : ""}">
        <input type="checkbox" class="crm-task-check" data-task-done="${esc(t.id)}" ${t.doneAt ? "checked" : ""} aria-label="Marcar como feita: ${esc(t.title)}">
        <div class="crm-task-main">
          <div class="crm-task-title">${esc(t.title)}</div>
          <div class="crm-task-meta">
            <span class="${late ? "is-late" : ""}">${late ? "Atrasada · " : ""}${esc(when(t.dueAt))}</span>
            ${showContact && t.contactName ? ` · <button type="button" class="crm-link" data-open-contact="${esc(t.contactId)}">${esc(t.contactName)}</button>` : ""}
            ${t.origin === "auto" ? " · automática" : t.origin === "agente" ? " · agente" : ""}
          </div>
        </div>
        ${wa && !t.doneAt ? `<div class="crm-task-actions"><a class="crm-btn crm-btn-sm crm-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-crm-link>WhatsApp</a></div>` : ""}
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
    const type = ($("#crm-funnel-type") || {}).value || "todos";
    const deals = overview.deals.filter(d => type === "todos" || d.leadType === type);
    const cols = STAGES.map(([key, label]) => {
      const items = deals.filter(d => d.stage === key);
      const shown = key === "fechado" || key === "perdido" ? items.slice(0, 15) : items;
      return `
        <div class="crm-col">
          <div class="crm-col-head"><span>${esc(label)}</span><span class="crm-col-count">${items.length}</span></div>
          ${shown.map(d => `
            <button type="button" class="crm-card" data-open-contact="${esc(d.contactId || "")}">
              <div class="crm-card-name">${esc(d.name)}</div>
              <div class="crm-card-sub">${roleChips([], d.leadType)}${esc(d.propertyTitle || (d.leadType === "proprietario" ? "Captação" : "Contato geral"))}</div>
              <div class="crm-card-sub">${esc(d.origin)} · há ${esc(ago(d.updatedAt))}${d.stage === "perdido" && d.lostReason ? ` · ${esc(d.lostReason)}` : ""}</div>
            </button>`).join("")}
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
    el.innerHTML = contacts.map(c => `
      <button type="button" class="crm-contact-row" data-open-contact="${esc(c.id)}">
        <span class="crm-avatar" aria-hidden="true">${esc(initials(c.name))}</span>
        <span style="flex:1;min-width:0">
          <span class="crm-card-name" style="display:block">${esc(c.name)}</span>
          <span class="crm-card-sub" style="display:block">${roleChips(c.roles)}${esc(phoneFmt(c.phone) || c.email || "")}</span>
        </span>
        <span class="crm-muted">${c.stage ? esc(STAGE_LABEL[c.stage] || c.stage) : ""}<br>${esc(when(c.lastActivityAt))}</span>
      </button>`).join("");
  }

  // ---------- Ficha do contato ----------

  async function openContact(id) {
    if (!id) return;
    currentContactId = id;
    const drawer = $("#crm-drawer");
    drawer.hidden = false;
    document.body.style.overflow = "hidden";
    $("#crm-drawer-body").innerHTML = '<div class="crm-muted">Carregando...</div>';
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
    $("#crm-drawer-title").textContent = c.name;
    const p = c.profile || {};
    const wa = waLink(c.phone, `Olá ${c.name.split(" ")[0]}, aqui é a Edicleia da EBV Imóveis.`);
    const isBuyer = c.roles.includes("comprador") || c.deals.some(d => d.leadType === "comprador");
    const openTasks = c.tasks.filter(t => !t.doneAt);

    const deals = c.deals.map(d => `
      <div class="crm-deal">
        <div style="min-width:0">
          <div class="crm-card-name">${roleChips([], d.leadType)}${esc(d.propertyTitle || (d.leadType === "proprietario" ? "Captação de imóvel" : "Contato geral"))}</div>
          <div class="crm-card-sub">${esc(d.ref)} · ${esc(d.origin)} · desde ${esc(when(d.createdAt))}${d.value ? ` · ${esc(money(d.value))}` : ""}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <select data-deal-stage="${esc(d.id)}" aria-label="Etapa do negócio">
            ${STAGES.map(([v, l]) => `<option value="${v}"${v === d.stage ? " selected" : ""}>${l}</option>`).join("")}
          </select>
          ${d.stage === "perdido" ? `<select data-deal-lost="${esc(d.id)}" aria-label="Motivo da perda"><option value="">Motivo...</option>${LOST_REASONS.map(r => `<option${r === d.lostReason ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>` : ""}
        </div>
      </div>`).join("") || '<div class="crm-muted">Sem negócios.</div>';

    const profileForm = `
      <form id="crm-profile-form">
        <div class="crm-field" style="margin-bottom:10px">Tipo de imóvel
          <div class="crm-checks">${TIPOS.map(t => `<label><input type="checkbox" name="tipos" value="${t}"${(p.tipos || []).includes(t) ? " checked" : ""}> ${t[0].toUpperCase() + t.slice(1)}</label>`).join("")}</div>
        </div>
        <label class="crm-field" style="margin-bottom:10px">Bairros (separados por vírgula)
          <input type="text" name="bairros" value="${esc((p.bairros || []).join(", "))}" placeholder="Batel, Água Verde, Ecoville">
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
        <label class="crm-field" style="margin-bottom:10px">Observações<textarea name="obs" rows="2">${esc(p.obs || "")}</textarea></label>
        <button type="submit" class="crm-btn crm-btn-primary crm-btn-sm">Salvar perfil</button>
      </form>`;

    const matches = c.matches.length
      ? `<ul class="crm-list-plain">${c.matches.map(m => `<li><span>${esc(m.title)}<br><span class="crm-muted">${esc(m.location || "")}</span></span><span>${esc(money(m.price))}</span></li>`).join("")}</ul>`
      : `<div class="crm-muted">${isBuyer ? "Preencha o perfil de busca para ver os imóveis compatíveis." : "Só para compradores."}</div>`;

    const viewed = c.viewedProperties.length
      ? `<ul class="crm-list-plain">${c.viewedProperties.map(v => `<li><span>${esc(v.title)}</span><span>${esc(money(v.price))}</span></li>`).join("")}</ul>`
      : '<div class="crm-muted">Nenhum registro.</div>';

    $("#crm-drawer-body").innerHTML = `
      <div class="crm-box">
        <div class="crm-contact-head">
          <span class="crm-avatar" aria-hidden="true">${esc(initials(c.name))}</span>
          <div style="flex:1;min-width:0">
            <div class="crm-card-name">${esc(c.name)}</div>
            <div class="crm-card-sub">${roleChips(c.roles)}${esc(phoneFmt(c.phone))}${c.email ? ` · ${esc(c.email)}` : ""}</div>
          </div>
          ${wa ? `<a class="crm-btn crm-btn-wa" href="${esc(wa)}" target="_blank" rel="noopener" data-crm-link>WhatsApp</a>` : ""}
        </div>
      </div>

      <div class="crm-box"><h4>Negócios</h4>${deals}</div>

      <div class="crm-box">
        <h4>Tarefas</h4>
        ${openTasks.length ? openTasks.map(t => taskHtml(t, false)).join("") : '<div class="crm-muted">Nenhuma tarefa aberta.</div>'}
        <form class="crm-inline-form" id="crm-task-form">
          <input type="text" name="title" placeholder="Nova tarefa (ex: ligar e oferecer visita)" required maxlength="300">
          <input type="datetime-local" name="dueAt" aria-label="Quando">
          <button type="submit" class="crm-btn crm-btn-sm">Adicionar</button>
        </form>
      </div>

      <div class="crm-box"><h4>Perfil de busca</h4>${profileForm}</div>
      <div class="crm-box"><h4>Imóveis compatíveis</h4>${matches}</div>
      <div class="crm-box"><h4>Imóveis que viu no site</h4>${viewed}</div>

      <div class="crm-box">
        <h4>Anotações e histórico</h4>
        <form class="crm-inline-form" id="crm-note-form" style="margin:0 0 14px">
          <textarea name="text" rows="2" placeholder="Anotar algo da conversa" required maxlength="4000"></textarea>
          <button type="submit" class="crm-btn crm-btn-sm">Salvar nota</button>
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
    await refreshContact();
  }

  async function newContact() {
    const name = window.prompt("Nome do contato:");
    if (!name || !name.trim()) return;
    const phone = window.prompt("WhatsApp com DDD:");
    if (!phone || phone.replace(/\D/g, "").length < 10) { toast("Telefone inválido."); return; }
    const owner = window.confirm("É proprietário querendo vender? (OK = proprietário, Cancelar = comprador)");
    try {
      const c = await api("/api/admin/crm/contacts", { method: "POST", body: JSON.stringify({ name: name.trim(), phone, role: owner ? "proprietario" : "comprador" }) });
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
  }

  // ---------- Eventos ----------

  document.addEventListener("click", e => {
    const viewBtn = e.target.closest(".crm-view-btn");
    if (viewBtn) return setView(viewBtn.dataset.crmView);
    const open = e.target.closest("[data-open-contact]");
    if (open && open.dataset.openContact) return openContact(open.dataset.openContact);
    if (e.target.closest("[data-crm-close]")) return closeContact();
    if (e.target.closest("[data-crm-new-contact]")) return newContact();
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
        await refreshContact();
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
