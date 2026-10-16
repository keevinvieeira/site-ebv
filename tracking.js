// EBV Imóveis - Captação de leads + Meta Pixel
// - Guarda a origem da visita (UTMs, fbclid) para atribuir o lead à campanha.
// - Carrega o Pixel da Meta só depois do aceite de cookies (LGPD).
// - Antes de abrir o WhatsApp, pede nome e telefone e registra o lead no CRM.
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
  function hasConsent() {
    return getLS(CONSENT_KEY) === "true";
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
    if (!pixelLoaded || typeof window.fbq !== "function") return;
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
  function viewContent(prop) {
    if (!prop) return;
    track("ViewContent", {
      content_ids: [prop.id],
      content_type: "home_listing",
      content_name: prop.title,
      value: Number(prop.price) || undefined,
      currency: "BRL",
    });
  }

  // ---------- Pop-up antes do WhatsApp ----------
  let pending = null;

  function buildModal() {
    if (document.getElementById("wa-lead-modal")) return;
    const wrap = document.createElement("div");
    wrap.id = "wa-lead-modal";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "wa-lead-title");
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(20,10,12,.55);display:none;align-items:center;justify-content:center;z-index:10000;padding:16px;";
    wrap.innerHTML = `
      <form id="wa-lead-form" novalidate style="background:#fff;border-radius:16px;max-width:400px;width:100%;padding:26px 24px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:var(--font-sub, sans-serif);position:relative;">
        <button type="button" id="wa-lead-close" aria-label="Fechar" style="position:absolute;top:10px;right:12px;background:none;border:none;font-size:1.5rem;line-height:1;color:#888;cursor:pointer;box-shadow:none;padding:4px;">&times;</button>
        <h3 id="wa-lead-title" style="font-family:var(--font-title, serif);color:var(--primary-color,#722F37);font-size:1.35rem;margin:0 0 6px;">Falar com a Edicleia</h3>
        <p id="wa-lead-sub" style="color:#555;font-size:.88rem;margin:0 0 18px;line-height:1.45;">Deixe seu nome e WhatsApp para ela saber quem é e já te responder com as informações.</p>
        <label for="wa-lead-name" style="display:block;font-size:.8rem;font-weight:600;color:#1C1C1E;margin-bottom:4px;">Seu nome</label>
        <input id="wa-lead-name" name="name" autocomplete="name" required maxlength="120" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ddd;border-radius:8px;font-size:1rem;margin-bottom:12px;">
        <label for="wa-lead-phone" style="display:block;font-size:.8rem;font-weight:600;color:#1C1C1E;margin-bottom:4px;">WhatsApp com DDD</label>
        <input id="wa-lead-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20" placeholder="(41) 99999-9999" style="width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ddd;border-radius:8px;font-size:1rem;margin-bottom:6px;">
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

  function openModal(ctx) {
    buildModal();
    pending = ctx;
    const wrap = document.getElementById("wa-lead-modal");
    const saved = readJSON(CONTACT_KEY) || {};
    wrap.querySelector("#wa-lead-name").value = saved.name || "";
    wrap.querySelector("#wa-lead-phone").value = saved.phone || "";
    wrap.querySelector("#wa-lead-error").style.display = "none";
    wrap.querySelector("#wa-lead-submit").disabled = false;
    wrap.querySelector("#wa-lead-sub").textContent = ctx.leadType === "proprietario"
      ? "Deixe seu nome e WhatsApp para a Edicleia saber quem é e já conversar sobre o seu imóvel."
      : "Deixe seu nome e WhatsApp para a Edicleia saber quem é e já te responder sobre o imóvel.";
    wrap.style.display = "flex";
    setTimeout(() => wrap.querySelector(saved.name ? "#wa-lead-submit" : "#wa-lead-name").focus(), 30);
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
    const name = document.getElementById("wa-lead-name").value.trim();
    const phone = document.getElementById("wa-lead-phone").value.trim();
    const digits = phone.replace(/\D/g, "");
    if (name.length < 2) return showError("Informe seu nome.");
    if (digits.length < 10 || digits.length > 11) return showError("Informe o WhatsApp com DDD, ex: (41) 99999-9999.");

    const ctx = pending;
    setLS(CONTACT_KEY, JSON.stringify({ name, phone }));
    document.getElementById("wa-lead-submit").disabled = true;

    // Abre a aba já no clique (evita bloqueio de pop-up); no celular segue na mesma aba.
    const touch = isTouch();
    const win = touch ? null : window.open("about:blank", "_blank");

    const eventId = newEventId("lead");
    let ref = null;
    let duplicate = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch("/api/leads", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, phone,
          leadType: ctx.leadType,
          context: ctx.context,
          propertyId: ctx.property ? ctx.property.id : null,
          propertyTitle: ctx.property ? ctx.property.title : null,
          value: ctx.property ? ctx.property.price : null,
          tracking: { ...collect(), eventId },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        ref = data.ref || null;
        duplicate = data.duplicate === true;
      }
    } catch { /* segue para o WhatsApp mesmo se a API falhar */ }

    if (!duplicate) {
      track("Lead", {
        lead_type: ctx.leadType,
        content_ids: ctx.property ? [ctx.property.id] : undefined,
        content_name: ctx.property ? ctx.property.title : undefined,
        currency: "BRL",
      }, eventId);
    }

    const url = withRef(ctx.href, name, ref);
    closeModal();
    if (win) {
      win.location.href = url;
    } else {
      window.location.href = url;
    }
  }

  function withRef(href, name, ref) {
    try {
      const u = new URL(href);
      let text = u.searchParams.get("text") || "";
      const first = name.split(/\s+/)[0];
      if (first && !/meu nome/i.test(text)) text = text.replace(/^(Ol[áa],?\s*Edicleia!?)/i, `$1 Meu nome é ${first}.`);
      if (ref) text += `\n\n(Código do atendimento: ${ref})`;
      return `${u.origin}${u.pathname}?text=${encodeURIComponent(text)}`;
    } catch {
      return href;
    }
  }

  function contextFor(link) {
    const href = link.href || "";
    let text = "";
    try { text = decodeURIComponent(new URL(href).searchParams.get("text") || ""); } catch { /* ignore */ }

    if (link.id === "modal-whatsapp-link") {
      const prop = typeof window.ebvActiveProperty === "function" ? window.ebvActiveProperty() : null;
      return { href, leadType: "comprador", context: "imovel", property: prop };
    }
    if (/venda do meu im[óo]vel|vender|avalia/i.test(text)) {
      return { href, leadType: "proprietario", context: "proprietario", property: null };
    }
    return { href, leadType: "comprador", context: "geral", property: null };
  }

  document.addEventListener("click", e => {
    const link = e.target.closest && e.target.closest('a[href*="wa.me/"]:not([data-crm-link])');
    if (!link) return;
    e.preventDefault();
    openModal(contextFor(link));
  }, true);

  // Liga o Pixel assim que a pessoa aceitar os cookies.
  document.addEventListener("click", e => {
    const btn = e.target.closest && e.target.closest('#lgpd-banner button');
    if (btn) setTimeout(loadPixel, 0);
  });

  window.EBVTracking = { collect, newEventId, track, viewContent, loadPixel };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
