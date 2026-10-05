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
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      let response;
      if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request, env, url);
      } else if (url.pathname.startsWith("/media/")) {
        response = await handleMedia(request, env, url);
      } else if (url.pathname.startsWith("/imovel/")) {
        response = await handlePropertyPage(request, env, url);
      } else {
        response = await env.ASSETS.fetch(request);
      }

      return addSecurityHeaders(response);
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
};

async function handleApi(request, env, url) {
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
    return createAppraisal(request, env);
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
    return replaceProperties(request, env);
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
  const description = String(property.desc || "Imóvel disponível na EBV Imóveis")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const image = new URL(property.image || "/assets/hero_bg.jpg", `${url.origin}/`).href;
  const canonicalUrl = `${url.origin}${url.pathname}`;

  html = html
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeAttribute(title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="description" content="${escapeAttribute(description)}">`,
    )
    .replace("</head>", `${propertyMetaTags({ title, description, image, canonicalUrl })}\n</head>`);

  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
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

async function login(request, env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    console.error("Missing ADMIN_USERNAME, ADMIN_PASSWORD or SESSION_SECRET binding");
    return jsonError(500, "server_misconfigured", "Autenticação não configurada.");
  }

  const parsed = await readJson(request, 4096);
  if (parsed.error) return parsed.error;

  const { username, password } = parsed.value;
  if (typeof username !== "string" || typeof password !== "string" || username.length > 200 || password.length > 1000) {
    return jsonError(400, "invalid_credentials", "Usuário e senha são obrigatórios.");
  }

  const validUsername = await constantTimeEqual(username, env.ADMIN_USERNAME);
  const validPassword = await constantTimeEqual(password, env.ADMIN_PASSWORD);
  if (!validUsername || !validPassword) {
    return jsonError(401, "invalid_credentials", "Usuário ou senha inválidos.");
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await createSessionToken({ sub: env.ADMIN_USERNAME, exp }, env.SESSION_SECRET);
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

async function createAppraisal(request, env) {
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

  return jsonResponse(appraisal, 201);
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

async function replaceProperties(request, env) {
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

  // D1 executes a batch sequentially as one transaction and rolls it back on failure.
  await env.DB.batch(statements);
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
  if (!env.ADMIN_USERNAME || !env.SESSION_SECRET) {
    console.error("Missing ADMIN_USERNAME or SESSION_SECRET binding");
    return jsonError(500, "server_misconfigured", "Autenticação não configurada.");
  }
  return await readSession(request, env)
    ? null
    : jsonError(401, "unauthorized", "Autenticação necessária.");
}

async function readSession(request, env) {
  if (!env.ADMIN_USERNAME || !env.SESSION_SECRET) return null;
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!token || token.length > 4096) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  try {
    const key = await importHmacKey(env.SESSION_SECRET, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(parts[1]),
      encoder.encode(parts[0]),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    const now = Math.floor(Date.now() / 1000);
    if (!isPlainObject(payload) || payload.sub !== env.ADMIN_USERNAME || !Number.isInteger(payload.exp) || payload.exp <= now) {
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

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
