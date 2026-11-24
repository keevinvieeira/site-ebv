import { postLead, leadFromAppraisal, listLeads, updateLead, deleteLead, importLeads, audienceCsv, createManualLead, saveDirectLead } from "./leads.js";
import { handleCrmAdmin, handleAgentApi, handleInstagramWebhook, pollInstagram, afterPropertiesSaved, catalogCsv } from "./crm.js";
import { createFinancingSimulation, getFinancingMetrics, getFinancingSettings, saveFinancingSettings } from "./financing.js";
import { getSiteMetrics, recordSiteEvent } from "./site-metrics.js";

const SESSION_COOKIE = "ebv_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROPERTIES = 500;
const MAX_PROPERTY_BYTES = 100 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

const SECURITY_HEADERS = {
  "Content-Security-Policy": "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request, env, ctx) {
    const runtimeEnv = !env.DB && env.PREVIEW_MODE === "true" ? { ...env, DB: getPreviewDb() } : env;
    const url = new URL(request.url);

    try {
      let response;
      if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request, runtimeEnv, url, ctx);
      } else if (url.pathname.startsWith("/media/")) {
        response = await handleMedia(request, runtimeEnv, url);
      } else if (url.pathname === "/catalog.csv") {
        response = new Response(await catalogCsv(runtimeEnv, url.origin), {
          headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "public, max-age=900" },
        });
      } else if (url.pathname === "/sitemap.xml") {
        response = new Response(await generateSitemap(runtimeEnv, url.origin), {
          headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        });
      } else if (url.pathname === "/robots.txt") {
        response = new Response(generateRobots(url.origin, runtimeEnv), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
        });
      } else if (url.pathname.startsWith("/imovel/")) {
        response = await handlePropertyPage(request, runtimeEnv, url);
      } else if (url.pathname === "/simulador" || url.pathname === "/simulador/") {
        response = await handleSimulatorPage(request, runtimeEnv, url);
      } else if (url.pathname === "/artigos" || url.pathname.startsWith("/artigos/")) {
        response = await handleArticlePage(request, runtimeEnv, url);
      } else if (url.pathname === "/articles" || url.pathname.startsWith("/articles/")) {
        const mapped = url.pathname.replace(/^\/articles(?=\/|$)/, "/artigos");
        const target = mapped === "/artigos" ? "/artigos/" : mapped;
        response = Response.redirect(`${url.origin}${target}${url.search}`, 301);
      } else {
        response = await runtimeEnv.ASSETS.fetch(request);
      }

      return addSecurityHeaders(response, runtimeEnv);
    } catch (error) {
      const requestId = crypto.randomUUID();
      console.error("Unhandled request error", requestId, error);

      if (url.pathname.startsWith("/api/")) {
        return addSecurityHeaders(jsonError(500, "internal_error", "Erro interno do servidor.", requestId));
      }

      return addSecurityHeaders(new Response("Erro interno do servidor.", {
        status: 500,
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      }));
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(pollInstagram(env, { createManualLead }).catch(err => console.error("ig poll", err)));
  },
};

async function handleApi(request, env, url, ctx) {
  const { method } = request;
  const path = url.pathname;

  if (path === "/api/login") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return login(request, env);
  }

  if (path === "/api/logout") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return jsonResponse({ authenticated: false }, 200, { "Set-Cookie": clearSessionCookie() });
  }

  if (path === "/api/admin/session") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const session = await readSession(request, env);
    return jsonResponse(session
      ? { authenticated: true, user: session.sub, expiresAt: new Date(session.exp * 1000).toISOString() }
      : { authenticated: false });
  }

  if (path === "/api/properties") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return getProperties(env);
  }

  if (path === "/api/appraisals") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return createAppraisal(request, env, ctx);
  }

  if (path === "/api/config") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return jsonResponse({
      metaPixelId: env.META_PIXEL_ID || null,
      gtmId: env.GTM_ID || null,
      ga4Id: env.GA4_ID || null,
    });
  }

  if (path === "/api/financing/config") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    return jsonResponse(await getFinancingSettings(env));
  }

  if (path === "/api/financing/simulations") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const parsed = await readJson(request, 32 * 1024);
    if (parsed.error) return parsed.error;
    const result = await createFinancingSimulation(env, parsed.value);
    return result.error
      ? jsonError(400, "invalid_simulation", result.error)
      : jsonResponse(result.value, 201);
  }

  if (path === "/api/metrics/event") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const parsed = await readJson(request, 8 * 1024);
    if (parsed.error) return parsed.error;
    const result = await recordSiteEvent(env, parsed.value);
    return result.error
      ? jsonError(400, "invalid_metric", result.error)
      : jsonResponse({ ok: true }, 202);
  }

  if (path === "/api/admin/financing/settings") {
    if (method !== "GET" && method !== "PUT") return methodNotAllowed(["GET", "PUT"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    if (method === "GET") return jsonResponse(await getFinancingSettings(env));
    const parsed = await readJson(request, 16 * 1024);
    if (parsed.error) return parsed.error;
    const result = await saveFinancingSettings(env, parsed.value);
    return result.error
      ? jsonError(400, "invalid_financing_settings", result.error)
      : jsonResponse(result.value);
  }

  if (path === "/api/admin/financing/metrics") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return jsonResponse(await getFinancingMetrics(env));
  }

  if (path === "/api/leads") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const parsed = await readJson(request, 16 * 1024);
    if (parsed.error) return parsed.error;
    const result = await postLead(request, env, ctx, parsed.value);
    return jsonResponse(result.body, result.status);
  }

  if (path.startsWith("/api/admin/crm/")) {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const response = await handleCrmAdmin(request, env, ctx, path, method, () => readJson(request, 64 * 1024), { createManualLead, updateLead });
    return response || jsonError(404, "not_found", "Rota não encontrada.");
  }

  if (path === "/api/instagram/webhook") {
    return handleInstagramWebhook(request, env, { createManualLead });
  }

  if (path === "/api/instagram/poll") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const auth = request.headers.get("Authorization") || "";
    if (!env.EBV_IG_VERIFY_TOKEN || auth !== `Bearer ${env.EBV_IG_VERIFY_TOKEN}`) {
      return jsonError(401, "unauthorized", "Token inválido.");
    }
    return jsonResponse(await pollInstagram(env, { createManualLead }));
  }

  if (path.startsWith("/api/agent/")) {
    return handleAgentApi(request, env, ctx, path, method, () => readJson(request, 64 * 1024), { createManualLead, updateLead, saveDirectLead, getSiteMetrics });
  }

  if (path === "/api/admin/leads/import") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const parsed = await readJson(request, MAX_JSON_BYTES);
    if (parsed.error) return parsed.error;
    const result = await importLeads(env, parsed.value);
    return jsonResponse(result.body, result.status);
  }

  if (path === "/api/admin/leads/audience.csv") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return new Response(await audienceCsv(env), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="publico-clientes-ebv-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  if (path === "/api/admin/leads") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return jsonResponse(await listLeads(env));
  }

  const leadMatch = path.match(/^\/api\/admin\/leads\/([^/]+)$/);
  if (leadMatch) {
    if (method !== "PATCH" && method !== "DELETE") return methodNotAllowed(["PATCH", "DELETE"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const id = decodePathPart(leadMatch[1]);
    if (!id) return jsonError(400, "invalid_id", "Identificador de lead inválido.");
    if (method === "DELETE") {
      const result = await deleteLead(env, id);
      return jsonResponse(result.body, result.status);
    }
    const parsed = await readJson(request, 16 * 1024);
    if (parsed.error) return parsed.error;
    const result = await updateLead(request, env, ctx, id, parsed.value);
    return jsonResponse(result.body, result.status);
  }

  const metricMatch = path.match(/^\/api\/properties\/([^/]+)\/(view|whatsapp)$/);
  if (metricMatch) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const id = decodePathPart(metricMatch[1]);
    if (!id) return jsonError(400, "invalid_id", "Identificador de imóvel inválido.");
    return incrementMetric(env, id, metricMatch[2] === "view" ? "views" : "waClicks");
  }

  if (path === "/api/admin/appraisals") {
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return getAppraisals(env);
  }

  if (path === "/api/admin/properties") {
    if (method !== "PUT") return methodNotAllowed(["PUT"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return replaceProperties(request, env, ctx);
  }

  if (path === "/api/admin/images") {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return uploadImage(request, env);
  }

  const appraisalMatch = path.match(/^\/api\/admin\/appraisals\/([^/]+)$/);
  if (appraisalMatch) {
    if (method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const id = decodePathPart(appraisalMatch[1]);
    if (!id) return jsonError(400, "invalid_id", "Identificador de avaliação inválido.");
    return deleteAppraisal(env, id);
  }

  return jsonError(404, "not_found", "Rota não encontrada.");
}

async function handlePropertyPage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Método não permitido.", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const match = url.pathname.match(/^\/imovel\/([^/]+)(?:\/[^/]*)?\/?$/);
  const id = match ? decodePathPart(match[1]) : null;
  if (!id) return new Response("Imóvel não encontrado.", { status: 404 });

  const row = await env.DB.prepare("SELECT data FROM properties WHERE id = ?").bind(id).first();
  if (!row) return new Response("Imóvel não encontrado.", { status: 404 });

  const property = JSON.parse(row.data);
  const assetResponse = await env.ASSETS.fetch(new Request(new URL("/", url), request));
  let html = await assetResponse.text();
  const title = `${property.title || "Imóvel"} | EBV Imóveis`;
  const description = propertySummary(property);
  const mainImagePath = property.image || (Array.isArray(property.images) && property.images[0]) || "/assets/hero_bg.jpg";
  const image = new URL(mainImagePath, `${url.origin}/`).href;
  // Fotos locais têm versão WebP leve; og:image continua em JPG (redes sociais).
  const displayImagePath = String(mainImagePath).replace(/^(\/?assets\/[\w-]+)\.jpe?g$/i, "$1.webp");
  const canonicalUrl = `${url.origin}${url.pathname}`;
  const bootstrapJson = JSON.stringify(property)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const pixelJson = JSON.stringify(env.META_PIXEL_ID || null);
  const bootstrapScript = `  <script>window.__EBV_INITIAL_PROPERTY__=${bootstrapJson};window.__EBV_META_PIXEL_ID__=${pixelJson};</script>`;

  html = html
    .replace(
      /<link\s+rel="preload"\s+as="image"\s+href="assets\/hero_bg\.(?:jpg|webp)"[^>]*>/i,
      `<link rel="preload" as="image" href="${escapeAttribute(displayImagePath)}" fetchpriority="high">`,
    )
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeAttribute(title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="description" content="${escapeAttribute(description)}">`,
    )
    .replace("</head>", `${propertyMetaTags({ title, description, image, canonicalUrl })}\n${propertyJsonLd(property, { canonicalUrl, image, origin: url.origin })}\n${bootstrapScript}\n</head>`);

  // Renderiza a página do imóvel já aberta no HTML do servidor (sem flash da home atrás
  // e sem valores-modelo "R$ 0,00" / "0 m²" antes do JavaScript hidratar).
  const priceText = formatPrice(property.price);
  const waText = encodeURIComponent(`Olá Edicleia! Tenho interesse no imóvel "${property.title || "Imóvel"}"${priceText ? ` (${priceText})` : ""} que vi no seu site EBV Imóveis. Gostaria de receber mais informações.`);
  const fill = {
    "modal-badge-status": "COMPRA E VENDA",
    "modal-title-text": property.title,
    "modal-location-text": property.location ? `${property.location}, Curitiba` : null,
    "modal-price-text": priceText,
    "modal-spec-area": property.area,
    "modal-spec-beds": property.beds,
    "modal-spec-baths": property.baths,
    "modal-spec-vagas": property.vagas ?? "0",
    "modal-desc-content": property.desc,
    "fullscreen-counter": Array.isArray(property.images) && property.images.length ? `1 / ${property.images.length}` : null,
  };
  const rewriter = new HTMLRewriter()
    .on("body", {
      element(el) {
        const cls = el.getAttribute("class") || "";
        el.setAttribute("class", cls ? `${cls} property-page-open` : "property-page-open");
      },
    })
    .on("#property-modal", {
      element(el) {
        const cls = el.getAttribute("class") || "modal-overlay";
        if (!cls.split(/\s+/).includes("property-page")) el.setAttribute("class", `${cls} property-page`);
        el.setAttribute("style", "display: flex;");
      },
    })
    .on("#modal-image", {
      element(el) {
        el.setAttribute("src", displayImagePath);
        if (property.title) el.setAttribute("alt", String(property.title));
      },
    })
    .on("#modal-badge-status", {
      element(el) {
        el.setAttribute("class", "property-badge-status badge-venda");
      },
    })
    .on("#modal-whatsapp-link", {
      element(el) {
        el.setAttribute("href", `https://wa.me/5541988024346?text=${waText}`);
      },
    })
    .on("#modal-map-container", {
      element(el) {
        if (!property.address) el.setAttribute("style", "display: none;");
      },
    })
    .on("#modal-address-text span", {
      element(el) {
        if (property.address) el.setInnerContent(`Endereço: ${property.address}`);
      },
    });
  for (const [elementId, value] of Object.entries(fill)) {
    if (value === null || value === undefined || value === "") continue;
    rewriter.on(`#${elementId}`, { element(el) { el.setInnerContent(String(value)); } });
  }
  html = await rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();

  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}

async function handleSimulatorPage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Método não permitido.", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const assetUrl = new URL("/", url.origin);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!assetResponse.ok) return assetResponse;
  let html = await assetResponse.text();
  const canonical = `${url.origin}/simulador`;
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, "<title>Simulador de Financiamento Imobiliário | EBV Imóveis Curitiba</title>")
    .replace(/<meta name="description" content="[^"]*">/i, '<meta name="description" content="Compare estimativas SAC e Price, entrada, FGTS, imóvel na troca, prazo e renda antes de falar com a corretora EBV em Curitiba.">')
    .replace("</head>", `<link rel="canonical" href="${canonical}">\n<meta property="og:title" content="Simulador de Financiamento Imobiliário | EBV Imóveis Curitiba">\n<meta property="og:description" content="Compare SAC e Price e leve sua simulação para a corretora.">\n<meta property="og:url" content="${canonical}">\n<script>window.__EBV_SIMULATOR_PAGE__=true;</script>\n</head>`);
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

async function handleArticlePage(request, env, url) {
  if (url.pathname === "/artigos/artigos.css") {
    return env.ASSETS.fetch(request);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Método não permitido.", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const routes = {
    "/artigos": "/artigos/",
    "/artigos/": "/artigos/",
    "/artigos/parte-juridica-compra-imovel": "/artigos/parte-juridica-compra-imovel/",
    "/artigos/parte-juridica-compra-imovel/": "/artigos/parte-juridica-compra-imovel/",
    "/artigos/financiamento-imovel-passo-a-passo": "/artigos/financiamento-imovel-passo-a-passo/",
    "/artigos/financiamento-imovel-passo-a-passo/": "/artigos/financiamento-imovel-passo-a-passo/",
    "/artigos/sac-ou-price": "/artigos/sac-ou-price/",
    "/artigos/sac-ou-price/": "/artigos/sac-ou-price/",
  };
  const assetPath = routes[url.pathname];
  if (!assetPath) return new Response("Artigo não encontrado.", { status: 404 });
  const assetUrl = new URL(assetPath, url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(request.method === "HEAD" ? null : response.body, { status: 200, headers });
}

const PRICE_FORMAT = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function formatPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? PRICE_FORMAT.format(n) : null;
}

// Resumo para meta description / prévia de link: preço, metragem, quartos, vagas e bairro,
// seguido do começo da descrição sem os títulos de seção (CARACTERÍSTICAS, DIFERENCIAIS...).
function propertySummary(property) {
  const facts = [];
  const price = formatPrice(property.price);
  if (price) facts.push(price.replace(/,00$/, ""));
  if (property.area) facts.push(`${property.area} m²`);
  if (property.beds) facts.push(`${property.beds} quartos`);
  if (property.vagas) facts.push(`${property.vagas} vagas`);
  if (property.location) facts.push(`${property.location}, Curitiba`);
  const body = String(property.desc || "")
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && !/^[A-ZÀ-Ú\s]{4,}$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ");
  const head = facts.join(" · ");
  const text = head ? `${head}. ${body}` : (body || "Imóvel disponível na EBV Imóveis");
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, "")}...` : text;
}

function propertyJsonLd(property, { canonicalUrl, image, origin }) {
  const images = (Array.isArray(property.images) && property.images.length ? property.images : [image])
    .slice(0, 10)
    .map(src => new URL(src, `${origin}/`).href);
  const data = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    name: property.title,
    url: canonicalUrl,
    image: images,
    description: propertySummary(property),
    offers: Number(property.price) > 0
      ? { "@type": "Offer", price: Number(property.price), priceCurrency: "BRL", availability: "https://schema.org/InStock" }
      : undefined,
    about: {
      "@type": "SingleFamilyResidence",
      numberOfRooms: Number(property.beds) || undefined,
      numberOfBathroomsTotal: Number(property.baths) || undefined,
      floorSize: Number(property.area) ? { "@type": "QuantitativeValue", value: Number(property.area), unitCode: "MTK" } : undefined,
      address: { "@type": "PostalAddress", addressLocality: "Curitiba", addressRegion: "PR", addressCountry: "BR", streetAddress: property.location || undefined },
    },
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `  <script type="application/ld+json">${json}</script>`;
}

function propertyMetaTags({ title, description, image, canonicalUrl }) {
  return `
  <link rel="canonical" href="${escapeAttribute(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="EBV Imóveis">
  <meta property="og:title" content="${escapeAttribute(title)}">
  <meta property="og:description" content="${escapeAttribute(description)}">
  <meta property="og:image" content="${escapeAttribute(image)}">
  <meta property="og:url" content="${escapeAttribute(canonicalUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttribute(title)}">
  <meta name="twitter:description" content="${escapeAttribute(description)}">
  <meta name="twitter:image" content="${escapeAttribute(image)}">`;
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

// Credenciais vêm só de secrets do Cloudflare (nunca do código):
//   ADMIN_USERNAME / ADMIN_PASSWORD (obrigatório) e ADMIN2_USERNAME / ADMIN2_PASSWORD (opcional)
//   SESSION_SECRET (opcional; sem ele a chave é gerada e guardada no D1)
function adminAccounts(env) {
  return [
    [env.ADMIN_USERNAME, env.ADMIN_PASSWORD],
    [env.ADMIN2_USERNAME, env.ADMIN2_PASSWORD],
  ].filter(([u, p]) => typeof u === "string" && u && typeof p === "string" && p.length >= 8);
}

// Chave de assinatura da sessão: usa SESSION_SECRET se existir; senão gera uma
// aleatória e guarda no D1 (ninguém precisa criar nem digitar essa chave).
let cachedSessionSecret = null;
async function sessionSecretOf(env) {
  if (typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET;
  if (cachedSessionSecret) return cachedSessionSecret;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
  ).run();
  const random = toBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  await env.DB.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('session_secret', ?)").bind(random).run();
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").first();
  cachedSessionSecret = row ? row.value : null;
  return cachedSessionSecret;
}

async function login(request, env) {
  const sessionSecret = await sessionSecretOf(env);
  const accounts = adminAccounts(env);
  if (!sessionSecret || accounts.length === 0) {
    return jsonError(503, "admin_not_configured", "Painel sem credenciais configuradas no servidor.");
  }

  const parsed = await readJson(request, 4096);
  if (parsed.error) return parsed.error;

  const { username, password } = parsed.value;
  if (typeof username !== "string" || typeof password !== "string" || username.length > 200 || password.length > 1000) {
    return jsonError(400, "invalid_credentials", "Usuário e senha são obrigatórios.");
  }

  const u = username.trim();
  let loggedUser = null;
  for (const [accUser, accPass] of accounts) {
    const ok = (await constantTimeEqual(u, accUser)) & (await constantTimeEqual(password, accPass));
    if (ok && !loggedUser) loggedUser = accUser;
  }

  if (!loggedUser) {
    return jsonError(401, "invalid_credentials", "Usuário ou senha inválidos.");
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await createSessionToken({ sub: loggedUser, exp }, sessionSecret);
  return jsonResponse(
    { authenticated: true, expiresAt: new Date(exp * 1000).toISOString() },
    200,
    { "Set-Cookie": sessionCookie(token) },
  );
}

async function getProperties(env) {
  const result = await env.DB.prepare(
    "SELECT id, data FROM properties ORDER BY sort_order ASC, id ASC",
  ).all();

  return jsonResponse(result.results.map(rowToObject));
}

async function createAppraisal(request, env, ctx) {
  const parsed = await readJson(request, 32 * 1024);
  if (parsed.error) return parsed.error;

  const validation = validateAppraisal(parsed.value);
  if (validation.error) return validation.error;

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const appraisal = {
    id,
    ...validation.value,
    date: new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(new Date()),
    createdAt,
  };

  await env.DB.prepare(
    "INSERT INTO appraisals (id, data, created_at) VALUES (?, ?, ?)",
  ).bind(id, JSON.stringify(appraisal), createdAt).run();

  let lead = null;
  try {
    lead = await leadFromAppraisal(request, env, ctx, appraisal, parsed.value);
  } catch (err) {
    console.error("Lead from appraisal failed", err);
  }

  return jsonResponse({ ...appraisal, leadRef: lead ? lead.ref : null, eventId: lead ? lead.eventId : null }, 201);
}

async function incrementMetric(env, id, field) {
  const now = new Date().toISOString();
  const jsonPath = field === "views" ? "$.views" : "$.waClicks";
  const update = env.DB.prepare(
    `UPDATE properties
       SET data = json_set(data, ?, CAST(COALESCE(json_extract(data, ?), 0) AS INTEGER) + 1),
           updated_at = ?
     WHERE id = ?`,
  ).bind(jsonPath, jsonPath, now, id);
  const select = env.DB.prepare(
    "SELECT json_extract(data, ?) AS value FROM properties WHERE id = ?",
  ).bind(jsonPath, id);
  const [updateResult, selectResult] = await env.DB.batch([update, select]);

  if (!updateResult.meta.changes) {
    return jsonError(404, "property_not_found", "Imóvel não encontrado.");
  }

  return jsonResponse({ ok: true, [field]: Number(selectResult.results[0].value) });
}

async function getAppraisals(env) {
  const result = await env.DB.prepare(
    "SELECT id, data FROM appraisals ORDER BY created_at DESC, id DESC",
  ).all();
  return jsonResponse(result.results.map(rowToObject));
}

async function replaceProperties(request, env, ctx) {
  const parsed = await readJson(request, MAX_JSON_BYTES);
  if (parsed.error) return parsed.error;

  if (!isPlainObject(parsed.value) || !Array.isArray(parsed.value.properties)) {
    return jsonError(400, "invalid_properties", "O corpo deve conter { properties: [...] }.");
  }

  const { properties } = parsed.value;
  if (properties.length > MAX_PROPERTIES) {
    return jsonError(400, "too_many_properties", `O catálogo aceita no máximo ${MAX_PROPERTIES} imóveis.`);
  }

  const ids = new Set();
  const now = new Date().toISOString();
  const statements = [env.DB.prepare("DELETE FROM properties")];

  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index];
    if (!isPlainObject(property) || typeof property.id !== "string") {
      return jsonError(400, "invalid_property", `Imóvel na posição ${index} deve ser um objeto com id.`);
    }

    const id = property.id.trim();
    if (!isValidId(id) || ids.has(id)) {
      return jsonError(400, "invalid_property_id", `ID inválido ou duplicado na posição ${index}.`);
    }

    const normalized = { ...property, id };
    const data = JSON.stringify(normalized);
    if (encoder.encode(data).byteLength > MAX_PROPERTY_BYTES) {
      return jsonError(400, "property_too_large", `Imóvel na posição ${index} excede o limite permitido.`);
    }

    ids.add(id);
    statements.push(env.DB.prepare(
      "INSERT INTO properties (id, data, sort_order, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(id, data, index, now));
  }

  const previousIds = new Set((await env.DB.prepare("SELECT id FROM properties").all()).results.map(r => r.id));

  // D1 executes a batch sequentially as one transaction and rolls it back on failure.
  await env.DB.batch(statements);

  ctx.waitUntil(afterPropertiesSaved(env, ctx, previousIds, properties).catch(err => console.error("match failed", err)));
  return jsonResponse({ ok: true, count: properties.length });
}

async function deleteAppraisal(env, id) {
  const result = await env.DB.prepare("DELETE FROM appraisals WHERE id = ?").bind(id).run();
  if (!result.meta.changes) {
    return jsonError(404, "appraisal_not_found", "Solicitação de avaliação não encontrada.");
  }
  return jsonResponse({ ok: true });
}

async function uploadImage(request, env) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return jsonError(415, "unsupported_media_type", "Envie multipart/form-data com o campo file.");
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + 1024 * 1024) {
    return jsonError(413, "image_too_large", "A imagem deve ter no máximo 8 MiB.");
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "invalid_multipart", "Formulário multipart inválido.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError(400, "missing_file", "O campo file é obrigatório.");
  }
  if (file.type.toLowerCase() !== "image/jpeg") {
    return jsonError(415, "invalid_image_type", "Apenas imagens JPEG são aceitas.");
  }
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return jsonError(413, "image_too_large", "A imagem deve ter entre 1 byte e 8 MiB.");
  }

  const signature = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  if (signature.length < 3 || signature[0] !== 0xff || signature[1] !== 0xd8 || signature[2] !== 0xff) {
    return jsonError(415, "invalid_image_content", "O arquivo enviado não é um JPEG válido.");
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `photos/${year}/${month}/${crypto.randomUUID()}.jpg`;
  await env.PHOTOS.put(key, file.stream(), {
    httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { originalName: sanitizeMetadata(file.name) },
  });

  return jsonResponse({ url: `/media/${key}` }, 201);
}

async function handleMedia(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Método não permitido.", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const rawKey = url.pathname.slice("/media/".length);
  const key = decodePathPart(rawKey, 1024);
  if (!key || key.startsWith("/") || key.split("/").includes("..")) {
    return new Response("Imagem não encontrada.", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const object = await env.PHOTOS.get(key);
  if (!object) {
    return new Response("Imagem não encontrada.", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));

  if (request.headers.get("If-None-Match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

function validateAppraisal(value) {
  if (!isPlainObject(value)) {
    return { error: jsonError(400, "invalid_appraisal", "O corpo da avaliação deve ser um objeto JSON.") };
  }

  const limits = { name: 120, phone: 40, email: 254, type: 80, location: 200, area: 80, details: 4000 };
  const required = ["name", "phone", "email", "type", "location"];
  const normalized = {};

  for (const [field, limit] of Object.entries(limits)) {
    const input = value[field];
    if (input == null && !required.includes(field)) {
      normalized[field] = field === "details" ? "-" : "Não informado";
      continue;
    }
    if (typeof input !== "string") {
      return { error: jsonError(400, "invalid_field", `O campo ${field} deve ser texto.`) };
    }
    const text = input.trim();
    if ((required.includes(field) && !text) || text.length > limit) {
      return { error: jsonError(400, "invalid_field", `O campo ${field} é inválido.`) };
    }
    normalized[field] = text || (field === "details" ? "-" : "Não informado");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
    return { error: jsonError(400, "invalid_email", "Informe um e-mail válido.") };
  }
  if (normalized.phone.replace(/\D/g, "").length < 8) {
    return { error: jsonError(400, "invalid_phone", "Informe um telefone válido.") };
  }

  return { value: normalized };
}

async function readJson(request, maxBytes) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { error: jsonError(415, "unsupported_media_type", "Use Content-Type application/json.") };
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { error: jsonError(413, "payload_too_large", "Corpo da requisição muito grande.") };
  }

  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) {
    return { error: jsonError(413, "payload_too_large", "Corpo da requisição muito grande.") };
  }

  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: jsonError(400, "invalid_json", "JSON inválido.") };
  }
}

async function requireAdmin(request, env) {
  const session = await readSession(request, env);
  if (!session) {
    return jsonError(401, "unauthorized", "Autenticação necessária.");
  }
  return null;
}

async function readSession(request, env) {
  const sessionSecret = await sessionSecretOf(env);
  if (!sessionSecret) return null;
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!token || token.length > 4096) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  try {
    const key = await importHmacKey(sessionSecret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(parts[1]),
      encoder.encode(parts[0]),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    const now = Math.floor(Date.now() / 1000);
    const validSubs = adminAccounts(env).map(([accUser]) => accUser);
    if (!isPlainObject(payload) || !validSubs.includes(payload.sub) || !Number.isInteger(payload.exp) || payload.exp <= now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function createSessionToken(payload, secret) {
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

function importHmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function constantTimeEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let i = 0; i < leftBytes.length; i += 1) difference |= leftBytes[i] ^ rightBytes[i];
  return difference === 0;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function rowToObject(row) {
  const data = JSON.parse(row.data);
  return { ...data, id: row.id };
}

function decodePathPart(value, maxLength = 200) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length <= maxLength ? decoded : null;
  } catch {
    return null;
  }
}

function isValidId(id) {
  return id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeMetadata(value) {
  return String(value || "upload.jpg").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 200);
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function jsonError(status, code, message, requestId) {
  const error = { code, message };
  if (requestId) error.requestId = requestId;
  return jsonResponse({ error }, status);
}

function methodNotAllowed(methods) {
  return jsonResponse(
    { error: { code: "method_not_allowed", message: "Método não permitido." } },
    405,
    { Allow: methods.join(", ") },
  );
}

function addSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (env && env.PREVIEW_MODE === "true") headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

let previewDbSingleton = null;
function getPreviewDb() {
  if (previewDbSingleton) return previewDbSingleton;
  const seedProperty = {
    id: "prop-1792252762995",
    title: "Lindo Triplex 220 m2 com 3 Quartos/1 Suíte | Uberaba de Cima | Curitiba/PR",
    type: "Sobrado",
    location: "Uberaba de Cima",
    price: 1190000,
    area: 220,
    beds: 3,
    baths: 4,
    vagas: 2,
    exchangeMaxPercent: 50,
    desc: "Triplex averbado no Uberaba de Cima. Aceita financiamento e apartamento até 50% do valor.",
    image: "/assets/hero_bg.jpg",
    images: ["/assets/hero_bg.jpg"],
  };
  const makeStmt = (sql) => {
    const stmt = {
      _args: [],
      bind(...args) { stmt._args = args; return stmt; },
      async run() { return { success: true, meta: { changes: 1 } }; },
      async first() {
        if (/FROM\s+properties/i.test(sql)) return { id: seedProperty.id, data: JSON.stringify(seedProperty) };
        if (/FROM\s+financing_simulations/i.test(sql)) return { simulations: 0, contacts: 0 };
        return null;
      },
      async all() {
        if (/FROM\s+properties/i.test(sql)) return { results: [{ id: seedProperty.id, data: JSON.stringify(seedProperty) }] };
        return { results: [] };
      },
    };
    return stmt;
  };
  previewDbSingleton = {
    prepare(sql) { return makeStmt(sql); },
    async batch(stmts) { return Promise.all(stmts.map(s => s.run())); },
  };
  return previewDbSingleton;
}


async function generateSitemap(env, origin) {
  const today = new Date().toISOString().split("T")[0];
  let propertyUrls = "";

  try {
    const { results } = await env.DB.prepare("SELECT id FROM properties").all();
    if (results && results.length) {
      for (const row of results) {
        propertyUrls += `  <url>
    <loc>${origin}/imovel/${encodeURIComponent(row.id)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>\n`;
      }
    }
  } catch (err) {
    console.warn("Sitemap properties fetch warning:", err);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Paginas Principais -->
  <url>
    <loc>${origin}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${origin}/simulador</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${origin}/artigos/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${origin}/artigos/parte-juridica-compra-imovel/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${origin}/artigos/financiamento-imovel-passo-a-passo/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${origin}/artigos/sac-ou-price/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <!-- Imoveis Ativos (SSR) -->
${propertyUrls}</urlset>`;
}

function generateRobots(origin, env) {
  if (env && env.PREVIEW_MODE === "true") {
    return "User-agent: *\nDisallow: /\n";
  }
  return `User-agent: *
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: Meta-ExternalAgent
Allow: /

# Diretorios restritos e internos
Disallow: /api/
Disallow: /branding
Disallow: /branding/

Sitemap: ${origin}/sitemap.xml
`;
}
