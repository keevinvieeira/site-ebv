// EBV Imóveis - Captação de leads + Meta Pixel
// - Guarda a origem da visita (UTMs, fbclid) para atribuir o lead à campanha.
// - Carrega o Pixel da Meta por padrão; se a pessoa clicar em "Recusar" no aviso de
//   cookies (LGPD), o Pixel é desligado e a recusa fica salva neste navegador.
// - Antes de abrir o WhatsApp, pede interesse, imóvel, nome completo e telefone e registra o lead no CRM.
(function () {
  "use strict";

  const STORE_KEY = "ebv_attribution";
  const CONTACT_KEY = "ebv_lead_contact";
  const CONSENT_KEY = "ebv_lgpd_consent";
  let pixelId = null;
  let pixelLoaded = false;

  // ---------- storage seguro ----------
  function getLS(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  function setLS(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  }
  function readJSON(key) {
    try { return JSON.parse(getLS(key) || "null"); } catch { return null; }
  }
  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ---------- atribuição ----------
  function captureAttribution() {
    const params = new URLSearchParams(window.location.search);
    const current = readJSON(STORE_KEY) || {};
    const fresh = {};
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"].forEach(k => {
      const v = params.get(k);
      if (v) fresh[k] = v.slice(0, 500);
    });

    // Um novo clique de anúncio substitui a atribuição anterior (last click pago).
    if (Object.keys(fresh).length) {
      const next = { ...fresh, landingPage: window.location.href.slice(0, 1000), firstSeen: new Date().toISOString() };
      if (document.referrer) next.referrer = document.referrer.slice(0, 1000);
      if (fresh.fbclid) next.fbc = `fb.1.${Date.now()}.${fresh.fbclid}`;
      setLS(STORE_KEY, JSON.stringify(next));
      return;
    }
    if (!current.firstSeen) {
      const next = { landingPage: window.location.href.slice(0, 1000), firstSeen: new Date().toISOString() };
      if (document.referrer && !document.referrer.startsWith(window.location.origin)) next.referrer = document.referrer.slice(0, 1000);
      setLS(STORE_KEY, JSON.stringify(next));
    }
  }

  function collect() {
    const a = readJSON(STORE_KEY) || {};
    const out = { ...a, pageUrl: window.location.href.slice(0, 1000) };
    if (!hasConsent()) {
      delete out.fbc;
      return out;
    }
    const fbc = readCookie("_fbc");
    const fbp = readCookie("_fbp");
    if (fbc) out.fbc = fbc;
    if (fbp) out.fbp = fbp;
    return out;
  }

  function newEventId(prefix) {
    const rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    return `${prefix}:${rand}`;
  }

  // ---------- Pixel ----------
  // Sem escolha registrada = Pixel ligado (opt-out). Só "false" (recusou) desliga.
  function hasConsent() {
    return getLS(CONSENT_KEY) !== "false";
  }

  function expireCookie(name) {
    const host = window.location.hostname.replace(/^www\./, "");
    [`; domain=.${host}`, ""].forEach(d => {
      document.cookie = `${name}=; Max-Age=0; path=/${d}`;
    });
  }

  // Chamado quando a pessoa recusa: revoga o Pixel já carregado e apaga os cookies dele.
  function revokePixel() {
    if (typeof window.fbq === "function") {
      try { window.fbq("consent", "revoke"); } catch { /* ignore */ }
    }
    pixelLoaded = false;
    ["_fbp", "_fbc"].forEach(expireCookie);
  }

  function loadPixel() {
    if (pixelLoaded || !pixelId || !hasConsent()) return;
    pixelLoaded = true;
    /* eslint-disable */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = []; t = b.createElement(e); t.async = !0;
      t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s)
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    /* eslint-enable */
    const saved = readJSON(CONTACT_KEY);
    const advanced = {};
    if (saved && saved.phone) advanced.ph = normalizePhone(saved.phone);
    window.fbq("init", pixelId, advanced);
    window.fbq("track", "PageView");
  }

  function track(eventName, params, eventId) {
    if (!pixelLoaded || !hasConsent() || typeof window.fbq !== "function") return;
    const standard = ["PageView", "ViewContent", "Lead", "Contact", "Schedule", "Search"];
    const method = standard.includes(eventName) ? "track" : "trackCustom";
    window.fbq(method, eventName, params || {}, eventId ? { eventID: eventId } : undefined);
  }

  function normalizePhone(p) {
    const d = String(p || "").replace(/\D/g, "").replace(/^0+/, "");
    return d.length === 10 || d.length === 11 ? "55" + d : d;
  }

  async function init() {
    captureAttribution();
    try {
      const res = await fetch("/api/config", { credentials: "same-origin" });
      const cfg = res.ok ? await res.json() : {};
      pixelId = cfg.metaPixelId || null;
    } catch { pixelId = null; }
    loadPixel();
  }

  // ---------- Eventos do site ----------
  function rememberViewed(id) {
    const list = (readJSON("ebv_viewed") || []).filter(x => x !== id);
    list.unshift(id);
    setLS("ebv_viewed", JSON.stringify(list.slice(0, 20)));
  }

  function getViewed() {
    const list = readJSON("ebv_viewed");
    return Array.isArray(list) ? list.slice(0, 20) : [];
  }

  function viewContent(prop) {
    if (!prop) return;
    rememberViewed(prop.id);
    track("ViewContent", {
      content_ids: [prop.id],
      content_type: "product",
      content_name: prop.title,
      value: Number(prop.price) || undefined,
      currency: "BRL",
    });
  }

  // ---------- Formulário antes do WhatsApp ----------
  // Todo link wa.me do site abre este formulário. Ele pergunta o interesse
  // (comprar, vender ou avaliar), o imóvel (quando é compra), nome completo e WhatsApp,
  // registra o lead no CRM e só então abre a conversa com uma mensagem clara, sem código interno.
  const INTERESTS = {
    comprar: { label: "Comprar um imóvel", leadType: "comprador" },
    vender: { label: "Vender meu imóvel", leadType: "proprietario" },
    avaliar: { label: "Avaliar meu imóvel", leadType: "proprietario" },
  };
  const TYPE_LABEL = { sobrado: "sobrado", apartamento: "apartamento", casa: "casa", terreno: "terreno", comercial: "imóvel comercial", sala: "sala comercial" };
  const NO_PROPERTY = "ajuda";
  let pending = null;

  function brl(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  }

  function typeOf(p) {
    return TYPE_LABEL[String(p.type || "").toLowerCase()] || "imóvel";
  }

  // Ex.: "sobrado de 220 m² com 3 quartos no bairro Uberaba"
  function describeProperty(p) {
    const type = typeOf(p);
    const parts = [type];
    if (Number(p.area) > 0) parts.push(`de ${p.area} m²`);
    const beds = Number(p.beds);
    if (beds > 0 && type !== "terreno") parts.push(`com ${beds} ${beds === 1 ? "quarto" : "quartos"}`);
    if (p.location) parts.push(`no bairro ${p.location}`);
    return parts.join(" ");
  }

  // Ex.: "Sobrado 220 m² · Uberaba · R$ 1.190.000"
  function optionLabel(p) {
    const type = typeOf(p);
    const bits = [type.charAt(0).toUpperCase() + type.slice(1) + (Number(p.area) > 0 ? ` ${p.area} m²` : "")];
    if (p.location) bits.push(p.location);
    if (brl(p.price)) bits.push(brl(p.price));
    return bits.join(" · ");
  }

  function availableProperties() {
    const list = typeof window.ebvProperties === "function" ? window.ebvProperties() : [];
    return (Array.isArray(list) ? list : []).filter(p => p && p.id && !p.sold && p.status !== "vendido");
  }

  // Imóvel aberto na tela agora (ficha visível), para o botão flutuante já saber do que se trata.
  function visibleProperty() {
    const modal = document.getElementById("property-modal");
    if (!modal || modal.style.display !== "flex") return null;
    return typeof window.ebvActiveProperty === "function" ? window.ebvActiveProperty() : null;
  }

  function propertyUrl(p) {
    return `${window.location.origin}/imovel/${encodeURIComponent(p.id)}`;
  }

  function buildMessage(interest, prop, name) {
    const hello = `Olá, Edicleia! Meu nome é ${name}.`;
    if (interest === "vender") return `${hello} Quero vender meu imóvel e gostaria de conversar com você sobre isso.`;
    if (interest === "avaliar") return `${hello} Gostaria de uma avaliação do meu imóvel.`;
    if (prop) {
      const article = typeOf(prop) === "casa" || typeOf(prop) === "sala comercial" ? "na" : "no";
      const price = brl(prop.price) ? `, de ${brl(prop.price)},` : "";
      return `${hello} Tenho interesse ${article} ${describeProperty(prop)}${price} que vi no site da EBV Imóveis:\n${propertyUrl(prop)}\n\nPode me passar mais informações?`;
    }
    return `${hello} Estou procurando um imóvel para comprar em Curitiba e vi o site da EBV Imóveis. Pode me ajudar?`;
  }

  function isFullName(name) {
    const words = name.split(/\s+/).filter(w => w.replace(/[^\p{L}]/gu, "").length >= 2);
    return words.length >= 2;
  }

  function buildModal() {
    if (document.getElementById("wa-lead-modal")) return;
    const style = document.createElement("style");
    style.textContent = `
      #wa-lead-modal .wa-interests{display:flex;flex-direction:column;gap:8px;margin:0 0 14px;border:none;padding:0}
      #wa-lead-modal .wa-interests legend{font-size:.8rem;font-weight:600;color:#1C1C1E;margin-bottom:6px;padding:0}
      #wa-lead-modal .wa-interest{display:flex;align-items:center;gap:10px;border:1px solid #ddd;border-radius:10px;padding:10px 12px;cursor:pointer;font-size:.92rem;color:#1C1C1E}
      #wa-lead-modal .wa-interest:has(input:checked){border-color:var(--primary-color,#722F37);background:#faf3f4;font-weight:600}
      #wa-lead-modal .wa-interest input{accent-color:var(--primary-color,#722F37);margin:0}
      #wa-lead-modal label.wa-l{display:block;font-size:.8rem;font-weight:600;color:#1C1C1E;margin-bottom:4px}
      #wa-lead-modal .wa-in{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ddd;border-radius:8px;font-size:1rem;margin-bottom:12px;background:#fff;color:#1C1C1E}
      #wa-lead-modal .wa-fixed{background:#faf3f4;border-radius:10px;padding:10px 12px;font-size:.88rem;color:#1C1C1E;margin:0 0 14px;line-height:1.4}`;
    document.head.appendChild(style);

    const wrap = document.createElement("div");
    wrap.id = "wa-lead-modal";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "wa-lead-title");
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(20,10,12,.55);display:none;align-items:center;justify-content:center;z-index:10000;padding:16px;";
    wrap.innerHTML = `
      <form id="wa-lead-form" novalidate style="background:#fff;border-radius:16px;max-width:420px;width:100%;max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:26px 24px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:var(--font-sub, sans-serif);position:relative;">
        <button type="button" id="wa-lead-close" aria-label="Fechar" style="position:absolute;top:10px;right:12px;background:none;border:none;font-size:1.5rem;line-height:1;color:#888;cursor:pointer;box-shadow:none;padding:4px;">&times;</button>
        <h3 id="wa-lead-title" style="font-family:var(--font-title, serif);color:var(--primary-color,#722F37);font-size:1.35rem;margin:0 0 6px;">Falar com a Edicleia</h3>
        <p id="wa-lead-sub" style="color:#555;font-size:.88rem;margin:0 0 16px;line-height:1.45;">Conte rapidinho o que você procura para ela já te responder com as informações certas.</p>
        <fieldset class="wa-interests" id="wa-lead-interests">
          <legend>Qual é o seu interesse?</legend>
          ${Object.entries(INTERESTS).map(([k, v]) => `<label class="wa-interest"><input type="radio" name="interest" value="${k}"> ${v.label}</label>`).join("")}
        </fieldset>
        <div id="wa-lead-prop-wrap" style="display:none;">
          <label class="wa-l" for="wa-lead-prop">Qual imóvel?</label>
          <select id="wa-lead-prop" class="wa-in"></select>
        </div>
        <p id="wa-lead-prop-fixed" class="wa-fixed" style="display:none;"></p>
        <label class="wa-l" for="wa-lead-name">Nome completo</label>
        <input id="wa-lead-name" class="wa-in" name="name" autocomplete="name" required maxlength="120" placeholder="Ex.: Maria da Silva">
        <label class="wa-l" for="wa-lead-phone">WhatsApp com DDD</label>
        <input id="wa-lead-phone" class="wa-in" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20" placeholder="(41) 99999-9999" style="margin-bottom:6px;">
        <p id="wa-lead-error" role="alert" style="display:none;color:#b00020;font-size:.8rem;margin:4px 0 0;"></p>
        <button type="submit" id="wa-lead-submit" style="margin-top:16px;width:100%;background:#25D366;color:#fff;border:none;border-radius:30px;padding:13px 16px;font-weight:700;font-size:.95rem;cursor:pointer;box-shadow:0 4px 15px rgba(37,211,102,.3);">Continuar no WhatsApp</button>
        <p style="font-size:.72rem;color:#888;margin:12px 0 0;line-height:1.4;">Seus dados são usados apenas para o atendimento, conforme a <a href="#privacidade" data-wa-privacy style="color:inherit;text-decoration:underline;">Política de Privacidade</a>.</p>
      </form>`;
    document.body.appendChild(wrap);

    const phoneInput = wrap.querySelector("#wa-lead-phone");
    phoneInput.addEventListener("input", () => {
      const d = phoneInput.value.replace(/\D/g, "").slice(0, 11);
      let out = d;
      if (d.length > 2) out = `(${d.slice(0, 2)}) ${d.slice(2)}`;
      if (d.length > 7) out = `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
      phoneInput.value = out;
    });
    wrap.querySelectorAll('input[name="interest"]').forEach(r => r.addEventListener("change", syncInterest));
    wrap.querySelector("#wa-lead-close").addEventListener("click", closeModal);
    wrap.addEventListener("click", e => { if (e.target === wrap) closeModal(); });
    wrap.querySelector("[data-wa-privacy]").addEventListener("click", e => {
      e.preventDefault();
      closeModal();
      if (typeof window.navigateTo === "function") window.navigateTo("privacidade");
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && wrap.style.display === "flex") closeModal(); });
    wrap.querySelector("#wa-lead-form").addEventListener("submit", onSubmit);
  }

  function selectedInterest() {
    const r = document.querySelector('#wa-lead-modal input[name="interest"]:checked');
    return r ? r.value : null;
  }

  function syncInterest() {
    const fixed = pending && pending.fixedProperty;
    const showSelect = !fixed && selectedInterest() === "comprar";
    document.getElementById("wa-lead-prop-wrap").style.display = showSelect ? "block" : "none";
  }

  function fillPropertySelect(selectedId) {
    const select = document.getElementById("wa-lead-prop");
    const list = availableProperties();
    select.innerHTML = "";
    const add = (value, text, opts = {}) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      if (opts.disabled) o.disabled = true;
      select.appendChild(o);
      return o;
    };
    add("", "Selecione o imóvel", { disabled: true });
    list.forEach(p => add(p.id, optionLabel(p)));
    add(NO_PROPERTY, "Ainda não escolhi, quero ajuda para encontrar");
    select.value = selectedId && list.some(p => p.id === selectedId) ? selectedId : "";
  }

  function openModal(ctx) {
    buildModal();
    pending = ctx;
    const wrap = document.getElementById("wa-lead-modal");
    const saved = readJSON(CONTACT_KEY) || {};
    wrap.querySelector("#wa-lead-name").value = saved.name || "";
    wrap.querySelector("#wa-lead-phone").value = saved.phone || "";
    wrap.querySelector("#wa-lead-error").style.display = "none";
    wrap.querySelector("#wa-lead-submit").disabled = false;

    // Interesse: vem do botão clicado; a ficha do imóvel já fixa "comprar" e o imóvel.
    wrap.querySelectorAll('input[name="interest"]').forEach(r => { r.checked = r.value === ctx.interest; });
    wrap.querySelector("#wa-lead-interests").style.display = ctx.fixedProperty ? "none" : "flex";
    const fixedEl = wrap.querySelector("#wa-lead-prop-fixed");
    if (ctx.fixedProperty) {
      fixedEl.textContent = `Imóvel: ${optionLabel(ctx.fixedProperty)}`;
      fixedEl.style.display = "block";
    } else {
      fixedEl.style.display = "none";
    }
    fillPropertySelect(ctx.property ? ctx.property.id : null);
    syncInterest();

    wrap.style.display = "flex";
    track("WhatsAppFormOpen", { cta: ctx.cta, interest: ctx.interest || undefined });
    const firstEmpty = !ctx.interest ? 'input[name="interest"]' : !saved.name ? "#wa-lead-name" : "#wa-lead-submit";
    setTimeout(() => { const el = wrap.querySelector(firstEmpty); if (el) el.focus(); }, 30);
  }

  function closeModal() {
    const wrap = document.getElementById("wa-lead-modal");
    if (wrap) wrap.style.display = "none";
    pending = null;
  }

  function showError(msg) {
    const el = document.getElementById("wa-lead-error");
    el.textContent = msg;
    el.style.display = "block";
  }

  function isTouch() {
    try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!pending) return;
    const interest = pending.fixedProperty ? "comprar" : selectedInterest();
    const name = document.getElementById("wa-lead-name").value.trim().replace(/\s+/g, " ");
    const phone = document.getElementById("wa-lead-phone").value.trim();
    const digits = phone.replace(/\D/g, "");
    if (!interest) return showError("Escolha se você quer comprar, vender ou avaliar um imóvel.");

    let prop = pending.fixedProperty || null;
    if (!prop && interest === "comprar") {
      const chosen = document.getElementById("wa-lead-prop").value;
      if (!chosen) return showError("Escolha o imóvel ou a opção \"Ainda não escolhi\".");
      if (chosen !== NO_PROPERTY) prop = availableProperties().find(p => p.id === chosen) || null;
    }
    if (!isFullName(name)) return showError("Informe seu nome completo (nome e sobrenome).");
    if (digits.length < 10 || digits.length > 11) return showError("Informe o WhatsApp com DDD, ex: (41) 99999-9999.");

    const ctx = pending;
    const leadType = INTERESTS[interest].leadType;
    const context = prop ? "imovel" : interest === "comprar" ? "geral" : interest === "vender" ? "proprietario" : "avaliacao";
    setLS(CONTACT_KEY, JSON.stringify({ name, phone }));
    document.getElementById("wa-lead-submit").disabled = true;

    // Abre a aba já no clique (evita bloqueio de pop-up); no celular segue na mesma aba.
    const touch = isTouch();
    const win = touch ? null : window.open("about:blank", "_blank");

    const eventId = newEventId("lead");
    let duplicate = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch("/api/leads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, phone, leadType, context, interest,
          cta: ctx.cta,
          propertyId: prop ? prop.id : null,
          propertyTitle: prop ? prop.title : null,
          value: prop ? prop.price : null,
          tracking: { ...collect(), eventId },
          viewed: getViewed(),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        duplicate = data.duplicate === true;
      }
    } catch { /* segue para o WhatsApp mesmo se a API falhar */ }

    if (!duplicate) {
      track("Lead", {
        lead_type: leadType,
        interest,
        cta: ctx.cta,
        content_ids: prop ? [prop.id] : undefined,
        content_name: prop ? prop.title : undefined,
        currency: "BRL",
      }, eventId);
    }

    const url = `${ctx.waBase}?text=${encodeURIComponent(buildMessage(interest, prop, name))}`;
    closeModal();
    if (win) {
      win.location.href = url;
    } else {
      window.location.href = url;
    }
  }

  function ctaFor(link) {
    if (link.dataset.cta) return link.dataset.cta.slice(0, 40);
    if (link.id === "modal-whatsapp-link") return "ficha-imovel";
    if (link.classList.contains("floating-whatsapp-btn")) return "flutuante";
    return "outro";
  }

  function contextFor(link) {
    const href = link.href || "";
    let waBase = "https://wa.me/5541988024346";
    let text = "";
    try {
      const u = new URL(href);
      waBase = `${u.origin}${u.pathname}`;
      text = u.searchParams.get("text") || "";
    } catch { /* ignore */ }
    const cta = ctaFor(link);

    if (link.id === "modal-whatsapp-link") {
      const prop = typeof window.ebvActiveProperty === "function" ? window.ebvActiveProperty() : null;
      return { waBase, cta, interest: "comprar", property: prop, fixedProperty: prop };
    }
    const preset = link.dataset.interest || (/avalia/i.test(text) ? "avaliar" : /venda do meu im[óo]vel|vender/i.test(text) ? "vender" : null);
    if (preset && INTERESTS[preset]) return { waBase, cta, interest: preset, property: null, fixedProperty: null };

    // Botões gerais (flutuante, rodapé): se há uma ficha aberta, já sugere aquele imóvel.
    const prop = visibleProperty();
    return { waBase, cta, interest: prop ? "comprar" : null, property: prop, fixedProperty: null };
  }

  document.addEventListener("click", e => {
    const link = e.target.closest && e.target.closest('a[href*="wa.me/"]:not([data-crm-link])');
    if (!link) return;
    e.preventDefault();
    openModal(contextFor(link));
  }, true);

  // Telefone e e-mail do rodapé: registra o contato no Pixel.
  document.addEventListener("click", e => {
    const link = e.target.closest && e.target.closest('a[href^="tel:"], a[href^="mailto:"]');
    if (!link || link.closest("#admin-panel, [data-crm-link]")) return;
    track("Contact", { method: link.href.startsWith("tel:") ? "telefone" : "email", cta: link.dataset.cta || "rodape" });
  });

  // Se a pessoa aceitar depois de ter recusado, liga o Pixel de novo.
  document.addEventListener("click", e => {
    const btn = e.target.closest && e.target.closest('#lgpd-banner button');
    if (btn) setTimeout(loadPixel, 0);
  });

  window.EBVTracking = { collect, newEventId, track, viewContent, loadPixel, revokePixel, getViewed };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
