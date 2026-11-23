// Qualificação da EBV. Não envia mensagem, não acessa outro negócio e não confirma visita.
const encoder = new TextEncoder();

export function fold(value) {
  return String(value || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export function fullName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  const parts = name.split(" ").filter(part => part.length > 1);
  return parts.length >= 2 ? name : "";
}

export function extractSignals(text) {
  const raw = String(text || "").slice(0, 4000);
  const folded = fold(raw);
  const signals = {};

  const name = raw.match(/(?:meu nome é|me chamo|eu sou|sou)\s+([A-Za-zÀ-ÿ]{2,}(?:\s+[A-Za-zÀ-ÿ]{2,}){0,3})/i);
  if (name) signals.name = name[1].replace(/\s+/g, " ").trim();

  const phoneSource = raw
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bprop-[\w-]+\b/gi, " ")
    .replace(/R\$\s*\d[\d.,]*/gi, " ");
  const phone = phoneSource.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[-\s]?\d{4}\b/);
  if (phone) {
    let digits = phone[0].replace(/\D/g, "").replace(/^0+/, "");
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
    if (digits.length === 8 || digits.length === 9) digits = `41${digits}`;
    if (digits.length >= 10) signals.phone = digits;
  }

  const marks = [
    ["vender", /\b(vender|venda do meu|anunciar meu)\b/],
    ["avaliar", /\b(avaliar|avaliacao)\b/],
    ["comprar", /\b(comprar|compra|procuro|quero ver|tenho interesse)\b/],
  ];
  let purposeAt = -1;
  for (const [purpose, pattern] of marks) {
    const at = folded.search(pattern);
    if (at >= purposeAt) {
      purposeAt = at;
      if (at >= 0) signals.finalidade = purpose;
    }
  }

  if (/\b(financiamento|financiar)\b/.test(folded)) signals.pagamento = "Financiamento";
  else if (/\b(a vista|à vista|avista)\b/.test(folded)) signals.pagamento = "À vista";
  else if (/\bfgts\b/.test(folded)) signals.pagamento = "FGTS + financiamento";
  else if (/\bpermuta\b/.test(folded)) signals.pagamento = "Permuta";

  if (/\b(imediato|agora|essa semana|esta semana)\b/.test(folded)) signals.prazo = "Imediato";
  else if (/\b(3 meses|tres meses|três meses)\b/.test(folded)) signals.prazo = "Até 3 meses";
  else if (/\b(6 meses|seis meses)\b/.test(folded)) signals.prazo = "Até 6 meses";
  else if (/\b(sem pressa|ano que vem|mais de 6)\b/.test(folded)) signals.prazo = "Mais de 6 meses";

  const money = folded.match(/(?:ate|orcamento|faixa|uns|cerca de|por volta de|r\$)\s*(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(milhoes|milhao|mil)?/)
    || folded.match(/(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(milhoes|milhao|mil)\b/);
  if (money) {
    let amount = money[1];
    if (money[2]) {
      amount = amount.replace(/\./g, "").replace(",", ".");
      const base = Number(amount);
      if (Number.isFinite(base)) signals.precoMax = Math.round(base * (money[2] === "mil" ? 1000 : 1000000));
    } else if (/^\d{1,3}(\.\d{3})+$/.test(amount)) {
      signals.precoMax = Number(amount.replace(/\./g, ""));
    } else if (Number(amount) >= 100000) {
      signals.precoMax = Number(amount);
    }
  }

  const propertyUrl = raw.match(/\/imovel\/(prop-[\w-]+)/i);
  if (propertyUrl) signals.propertyId = propertyUrl[1];

  signals.handoff = /\b(corretor|correta|humano|atendente|edicleia|pessoa)\b/.test(folded)
    || /falar com/.test(folded);
  signals.visita = /\b(visita|visitar|conhecer o imovel|conhecer o imóvel|agendar)\b/.test(folded);
  const when = raw.match(/\b(amanhã|amanha|hoje|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)(?:\s+às\s+\d{1,2}(?::\d{2})?h?)?/i);
  if (when) signals.whenText = when[0];
  return signals;
}

export function publicPropertyLine(property) {
  if (!property) return "";
  const bits = [];
  if (property.area) bits.push(`${property.area} m²`);
  if (property.beds) bits.push(`${property.beds} quartos`);
  if (property.location) bits.push(String(property.location));
  if (property.price) bits.push(`R$ ${Number(property.price).toLocaleString("pt-BR")}`);
  return bits.join(", ");
}

export function matchProperty(text, properties) {
  const folded = fold(text);
  let best = null;
  let bestScore = 0;
  for (const property of properties || []) {
    if (!property || property.sold || property.status === "vendido") continue;
    let score = 0;
    const id = fold(property.id);
    if (id && folded.includes(id)) score += 6;
    const location = fold(property.location);
    if (location.length > 3 && folded.includes(location)) score += 4;
    const words = fold(property.title).split(/[^a-z0-9]+/).filter(word => word.length > 4);
    const hits = words.filter(word => folded.includes(word)).length;
    if (hits >= 2) score += hits;
    if (score > bestScore) {
      best = property;
      bestScore = score;
    }
  }
  return bestScore >= 4 ? best : null;
}

function missingStep(profile, property) {
  if (!fullName(profile.name)) return "Pedir nome completo";
  if (!profile.finalidade) return "Confirmar se quer comprar, vender ou avaliar";
  if (profile.finalidade === "comprar" && !property && !profile.precoMax) return "Entender o imóvel ou a faixa de investimento";
  if (!profile.pagamento) return "Perguntar a forma de pagamento";
  if (!profile.prazo) return "Perguntar o prazo";
  if (!profile.visita) return "Perguntar se quer visitar";
  return "Qualificado, aguardando a corretora";
}

function ask(profile, property) {
  const step = missingStep(profile, property);
  if (step.startsWith("Pedir nome")) return "Para eu te atender com segurança, me passa seu nome e sobrenome?";
  if (step.startsWith("Confirmar")) return "Você quer comprar, vender ou avaliar um imóvel?";
  if (step.startsWith("Entender")) return "Qual imóvel você viu, ou até que valor quer investir?";
  if (step.startsWith("Perguntar a forma")) return "A compra seria financiada, à vista, com FGTS ou permuta?";
  if (step.startsWith("Perguntar o prazo")) return "Você pensa em resolver isso agora, em até 3 meses ou mais para a frente?";
  if (step.startsWith("Perguntar se quer")) return "Quer que eu deixe um pedido de visita para a Edicleia confirmar?";
  return "Anotei o que você me contou. A Edicleia segue com você a partir daqui.";
}

export function qualifyTurn({ text, profile = {}, properties = [], channel = "whatsapp", knownName = "" }) {
  const signals = extractSignals(text);
  const property = (signals.propertyId && (properties || []).find(item => item.id === signals.propertyId))
    || matchProperty(text, properties);
  const next = {
    name: fullName(signals.name) || fullName(knownName) || fullName(profile.name) || profile.name || "",
    finalidade: signals.finalidade || profile.finalidade || "",
    pagamento: signals.pagamento || profile.pagamento || "",
    prazo: signals.prazo || profile.prazo || "",
    precoMax: signals.precoMax || profile.precoMax || null,
    visita: signals.visita ? "sim" : (profile.visita || ""),
    phone: signals.phone || profile.phone || "",
  };
  const line = publicPropertyLine(property);
  const where = channel === "instagram" ? "Instagram" : "WhatsApp";
  let reply = "";
  let handoff = false;
  let visit = null;

  if (signals.handoff) {
    handoff = true;
    reply = "Vou chamar a Edicleia agora. Eu paro por aqui e ela continua com você.";
  } else if (signals.visita && (property || next.finalidade === "vender" || next.finalidade === "avaliar")) {
    if (!fullName(next.name)) {
      reply = "Consigo anotar a visita. Antes, me passa seu nome e sobrenome?";
    } else {
      visit = {
        propertyId: property ? property.id : null,
        propertyTitle: line || (next.finalidade === "avaliar" ? "Avaliação" : "Imóvel do proprietário"),
        whenText: signals.whenText || "",
      };
      const place = line ? ` no ${line}` : "";
      reply = `Anotei seu pedido de visita${place}. A Edicleia confirma o horário antes de ficar marcado.`;
    }
  } else {
    const intro = property
      ? `Sobre o imóvel ${line}, que você viu no ${where}: `
      : "";
    reply = `${intro}${ask(next, property)}`.trim();
  }

  return {
    profile: next,
    property: property ? { id: property.id, line } : null,
    reply,
    handoff,
    visit,
    nextStep: handoff ? "Com a corretora" : (visit ? "Pedido de visita aguardando aprovação" : missingStep(next, property)),
    summary: [
      next.finalidade || "finalidade em aberto",
      next.name || "sem nome completo",
      next.precoMax ? `até R$ ${Number(next.precoMax).toLocaleString("pt-BR")}` : "",
      next.pagamento || "",
      next.prazo || "",
      line || "",
    ].filter(Boolean).join(" · "),
  };
}

// Lembretes automáticos só dentro da janela de 24h das plataformas (~3h e ~20h). Fora dela, nunca envia.
export function followUpPlan({ lastInboundAt, now, profile = {}, status = "ia", stage = 1 }) {
  if (status !== "ia" || !lastInboundAt) return null;
  if (profile.phone) return null;
  const age = new Date(now).getTime() - new Date(lastInboundAt).getTime();
  const threeHours = 3 * 60 * 60 * 1000;
  const twentyHours = 20 * 60 * 60 * 1000;
  const maxWindow = 23.5 * 60 * 60 * 1000;
  if (!Number.isFinite(age) || age < threeHours || age >= maxWindow) return null;
  const first = String(profile.name || "").trim().split(/\s+/)[0];
  const greeting = first ? `Oi, ${first}!` : "Oi!";
  if (stage === 2 || age >= twentyHours) {
    return {
      title: "Última tentativa de retomada dentro de 24h (~20h)",
      text: `${greeting} Se preferir continuar por lá, você pode chamar a corretora Edicleia direto no WhatsApp quando quiser: https://wa.me/5541988024346?text=Ol%C3%A1%2C%20Edicleia!%20Vim%20pelo%20Instagram%20e%20tenho%20interesse%20no%20im%C3%B3vel.`,
    };
  }
  return {
    title: "Lembrete curto dentro de 24h (~3h)",
    text: `${greeting} Ficou alguma dúvida sobre o imóvel ou o valor e as condições estão dentro do que você esperava?`,
  };
}

export function extractInstagramDirect(payload) {
  const messages = [];
  if (!payload || payload.object !== "instagram") return messages;
  for (const entry of payload.entry || []) {
    const accountId = String(entry && entry.id || "");
    for (const item of (entry && entry.messaging) || []) {
      const message = item && item.message;
      if (message && message.is_echo) continue;
      const senderId = String(item.sender && item.sender.id || "");
      const referral = (item && item.referral) || (message && message.referral) || null;
      const adsCtx = referral && referral.ads_context_data || null;
      const adTitle = String((adsCtx && adsCtx.ad_title) || "").trim();
      const adId = String((referral && referral.ad_id) || "").trim();
      const mid = String((message && message.mid) || (referral && adId ? `ref:${senderId}:${adId}` : "") || "");
      const text = String((message && (message.text || (message.quick_reply && message.quick_reply.payload))) || "").trim();
      if (!accountId || !senderId || (!mid && !referral) || (!text && !adTitle && !adId)) continue;
      if (senderId === accountId) continue;
      messages.push({ accountId, senderId, messageId: mid, text, adTitle, adId });
    }
  }
  return messages;
}

export function keepForAccount(messages, accountId) {
  const expected = String(accountId || "").split(",").map(item => item.trim()).filter(Boolean);
  if (!expected.length) return [];
  return (messages || []).filter(message => expected.includes(message.accountId));
}

export async function verifyMetaSignature(rawBody, header, secret) {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(String(rawBody)));
  const hex = [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const got = header.slice("sha256=".length);
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i += 1) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// A conversa que chegou em @lid continua em @lid. Reescrever para o número foi o que derrubou a entrega.
export function outboundJid(remoteJid) {
  const jid = String(remoteJid || "");
  if (!/@(lid|s\.whatsapp\.net)$/.test(jid)) throw new Error("JID de resposta inválido.");
  return jid;
}

export function assertEbvSessionDir(dir) {
  const value = String(dir || "").replaceAll("\\", "/").toLowerCase();
  if (!value.includes("/ebv-whatsapp/")) throw new Error("A sessão do WhatsApp da EBV precisa ficar na pasta exclusiva ebv-whatsapp.");
  if (value.includes("milena") || value.includes("wellness")) throw new Error("Sessão de outro negócio recusada.");
}

// Vazio até o momento do deploy. Mensagem anterior a isto entra no CRM e não é respondida.
export const DIRECT_AGENT_SINCE = "";

export function sanitizeCustomerReply(text) {
  const original = String(text || "").trim();
  if (!original) return "";
  const withoutOfficialUrls = original
    .replace(/https:\/\/ebvimoveiscuritiba\.com\.br\/(?!media\/)\S*/gi, "")
    .replace(/https:\/\/wa\.me\/5541988024346(?:\?\S*)?/gi, "");
  if (/prop-|c[oó]digo/i.test(withoutOfficialUrls)) return "";
  if (/respostaSegura|proximoPasso|catalogoPublico/i.test(withoutOfficialUrls)) return "";
  if (/https?:\/\/|\b(?:www\.|wa\.me\/)/i.test(withoutOfficialUrls)) return "";
  if (/\bsobrado\s*0?2\b/i.test(original)) return "";
  let value = original.replace(/\s+/g, " ").trim().replace(/^["'`“”]+|["'`“”]+$/g, "");
  if ((withoutOfficialUrls.match(/\?/g) || []).length > 1) return "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= 900) return value;
  let cut = value;
  while (new TextEncoder().encode(cut).length > 900 && cut.length) cut = cut.slice(0, -1);
  return cut.replace(/\s+\S*$/, "").trim();
}

// Só o Direct, só mensagem nova, só dentro de 20h, e nunca com a conversa pausada ou já assumida.
export function shouldAutoReplyDirect({
  channel,
  duplicate = false,
  ignored = false,
  error = false,
  status = "ia",
  handoff = false,
  reply = "",
  createdAt,
  agentSince,
  now,
} = {}) {
  if (channel !== "instagram") return false;
  if (duplicate || ignored || error || !reply) return false;
  if (status === "pausada") return false;
  if (status === "humano" && !handoff) return false;
  if (status !== "ia" && !(status === "humano" && handoff)) return false;
  const created = Date.parse(createdAt || "");
  const since = Date.parse(agentSince || "");
  const at = Date.parse(now || "");
  if (!Number.isFinite(created) || !Number.isFinite(since) || !Number.isFinite(at)) return false;
  if (created < since) return false;
  const age = at - created;
  if (age < -5 * 60 * 1000 || age > 20 * 60 * 60 * 1000) return false;
  return true;
}

export function publicPropertyFact(property) {
  if (!property || typeof property === "string") {
    const line = String(property || "").replace(/\bprop-[\w-]+/gi, "").trim();
    return /prop-|c[oó]digo/i.test(line) ? "" : line;
  }
  const title = String(property.title || "").replace(/\bprop-[\w-]+/gi, "").trim();
  const line = publicPropertyLine(property);
  const fact = [title, line].filter(Boolean).join(" — ");
  return /prop-|c[oó]digo/i.test(fact) ? "" : fact;
}

export function directAgentPrompt({ text, history = [], turn = {}, catalog = [] }) {
  const safeReply = /prop-|c[oó]digo/i.test(turn.reply || "") ? "" : String(turn.reply || "");
  const facts = {
    nome: turn.profile && turn.profile.name || "",
    finalidade: turn.profile && turn.profile.finalidade || "",
    pagamento: turn.profile && turn.profile.pagamento || "",
    prazo: turn.profile && turn.profile.prazo || "",
    investimentoMaximo: turn.profile && turn.profile.precoMax || null,
    visita: turn.profile && turn.profile.visita || "",
    imovel: String(turn.property && turn.property.line || "").replace(/\bprop-[\w-]+/gi, "").trim(),
    proximoPasso: turn.nextStep || "",
    pedidoDeVisita: Boolean(turn.visit),
    catalogo: (catalog || []).map(publicPropertyFact).filter(Boolean).slice(0, 8),
    respostaSegura: safeReply,
    historico: (history || []).slice(-6).map(item => String(item || "").slice(0, 500)),
    mensagem: String(text || "").slice(0, 1000),
  };
  return {
    system: "Você atua como pré-atendimento comercial (SDR) da corretora Edicleia Borba Vieira no Instagram Direct da EBV Imóveis Curitiba. Português do Brasil, natural e direto. NUNCA pergunte se é para 'morar ou investir' (nem na abertura, nem no meio, nem em follow-up). PROIBIDO perguntas vazias ('O que você achou?', 'Gostaria de ver algum outro detalhe?', 'Você já conhece essa região?'). Abertura completa do Triplex (anúncio, saudação da Meta ou menção a Triplex/220/Uberaba): responda direto ao que pediu (se pediu endereço: Rua Júlio Wischral, 993, no Uberaba de Cima, a uns 50 m da Panificadora Akipão, farmácias e restaurantes, a uma quadra da Rua Capitão Leônidas Marques, segurando 'sobrado 02' até confirmar visita) e já entregue na mesma resposta: 3 fotos, introdução (220 m² em 3 andares, 3 quartos sendo 1 suíte, espaço gourmet com deck, garagem para 3 carros, no Uberaba de Cima pertinho do Jardim das Américas), condições (Valor R$ 1.190.000, aceita financiamento, aceita apartamento como parte do pagamento até 50% do valor, imóvel averbado/documentação ok), link do site (https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995) e pergunta final se gostaria de agendar uma visita. Se disser sim para visita, peça nome completo e número de WhatsApp. Se o lead já informou o número de WhatsApp, agradeça pelo nome, confirme que a corretora Edicleia vai chamar no WhatsApp para agendar e NUNCA envie link wa.me. Só envie wa.me/5541988024346?text=... se o lead preferir não passar o telefone ou pedir o WhatsApp da EBV. Em abertura orgânica genérica sem imóvel nem bairro, pergunte qual imóvel ou bairro procura. Não diga que é IA, não invente dados fora do cadastro e não escreva código prop- solto.",
    user: JSON.stringify(facts),
  };
}
