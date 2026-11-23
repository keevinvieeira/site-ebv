import test from "node:test";
import assert from "node:assert/strict";
import {
  assertEbvSessionDir,
  directAgentPrompt,
  extractSignals,
  extractInstagramDirect,
  followUpPlan,
  keepForAccount,
  outboundJid,
  qualifyTurn,
  sanitizeCustomerReply,
  shouldAutoReplyDirect,
  verifyMetaSignature,
} from "./sdr.js";

const catalog = [
  { id: "prop-1792252762995", title: "Lindo triplex 220 m2", location: "Uberaba de Cima", area: 220, beds: 3, price: 1190000, type: "sobrado" },
  { id: "prop-jardim", title: "Sobrado amplo", location: "Jardim das Américas", area: 187, beds: 4, price: 1249900, type: "sobrado", status: "vendido" },
];

test("normaliza telefone local de Curitiba sem confundir preÃ§o ou cÃ³digo do imÃ³vel", () => {
  assert.equal(extractSignals("Meu WhatsApp Ã© 99873-2272").phone, "41998732272");
  assert.equal(extractSignals("998732272").phone, "41998732272");
  assert.equal(extractSignals("99873 2272").phone, "41998732272");
  assert.equal(extractSignals("R$ 1.190.000 e prop-1792252762995").phone, undefined);
});

test("qualifica compra, imóvel e nome sem citar código interno", () => {
  const turn = qualifyTurn({
    text: "Oi, me chamo Deyse Silva. Quero comprar o triplex de 220 m2 no Uberaba de Cima, até 1,2 milhão, financiamento, em até 3 meses.",
    properties: catalog,
    channel: "whatsapp",
  });
  assert.equal(turn.profile.finalidade, "comprar");
  assert.equal(turn.profile.name, "Deyse Silva");
  assert.equal(turn.profile.precoMax, 1200000);
  assert.equal(turn.profile.pagamento, "Financiamento");
  assert.equal(turn.property.id, "prop-1792252762995");
  assert.equal(turn.reply.includes("prop-"), false);
  assert.equal(/código|codigo/i.test(turn.reply), false);
  assert.match(turn.reply, /Uberaba de Cima/);
});

test("visita fica pendente e nome sem sobrenome não abre pedido", () => {
  const blocked = qualifyTurn({
    text: "Sou Deyse e quero agendar visita no triplex do Uberaba de Cima amanhã às 10h",
    properties: catalog,
  });
  assert.equal(blocked.visit, null);
  assert.match(blocked.reply, /sobrenome/);

  const open = qualifyTurn({
    text: "Me chamo Deyse Silva e quero agendar visita no triplex do Uberaba de Cima amanhã às 10h",
    properties: catalog,
  });
  assert.equal(open.visit.propertyId, "prop-1792252762995");
  assert.match(open.reply, /confirma/);
  assert.equal(/confirmad/i.test(open.reply), false);
});

test("pedido de pessoa pausa a resposta automática", () => {
  const turn = qualifyTurn({ text: "Quero falar com a Edicleia", properties: catalog, knownName: "Ana Souza" });
  assert.equal(turn.handoff, true);
  assert.equal(turn.nextStep, "Com a corretora");
});

test("lembrete só cabe dentro da janela de 24h (~3h e ~20h), nunca pergunta morar/investir e some com telefone ou >24h", () => {
  const start = "2026-11-18T12:00:00.000Z";
  const tooEarly = followUpPlan({ lastInboundAt: start, now: "2026-11-18T14:00:00.000Z", profile: {} });
  assert.equal(tooEarly, null);
  const withPhone = followUpPlan({ lastInboundAt: start, now: "2026-11-18T15:30:00.000Z", profile: { phone: "41998952095" }, stage: 1 });
  assert.equal(withPhone, null);
  const due1 = followUpPlan({ lastInboundAt: start, now: "2026-11-18T15:30:00.000Z", profile: { name: "Thomas Kova" }, stage: 1 });
  assert.ok(due1);
  assert.match(due1.text, /Oi, Thomas!/);
  assert.match(due1.text, /valor e as condições/);
  assert.equal(/morar ou|investir|achou/i.test(due1.text), false);
  const due2 = followUpPlan({ lastInboundAt: start, now: "2026-11-19T08:30:00.000Z", profile: {}, stage: 2 });
  assert.ok(due2);
  assert.match(due2.text, /https:\/\/wa\.me\/5541988024346\?text=/);
  const late = followUpPlan({ lastInboundAt: start, now: "2026-11-19T12:00:00.000Z", profile: {} });
  assert.equal(late, null);
});

test("Direct de outra conta é ignorado e eco não entra", () => {
  const payload = {
    object: "instagram",
    entry: [{
      id: "conta-ebv",
      messaging: [
        { sender: { id: "cliente" }, message: { mid: "m1", text: "Oi" } },
        { sender: { id: "conta-ebv" }, message: { mid: "m2", text: "eco", is_echo: true } },
      ],
    }, {
      id: "conta-wellness",
      messaging: [{ sender: { id: "outro" }, message: { mid: "m3", text: "Não é da EBV" } }],
    }],
  };
  const kept = keepForAccount(extractInstagramDirect(payload), "conta-ebv");
  assert.deepEqual(kept.map(item => item.messageId), ["m1"]);
  const both = keepForAccount(extractInstagramDirect(payload), "17841448438742197,conta-ebv");
  assert.deepEqual(both.map(item => item.messageId), ["m1"]);
  assert.deepEqual(keepForAccount(extractInstagramDirect(payload), ""), []);
});

test("assinatura da Meta e JID do WhatsApp", async () => {
  const body = '{"ok":true}';
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("segredo"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyMetaSignature(body, `sha256=${hex}`, "segredo"), true);
  assert.equal(await verifyMetaSignature(body, `sha256=${hex}`, "outro"), false);
  assert.equal(outboundJid("5511999999999@lid"), "5511999999999@lid");
  assert.throws(() => outboundJid("5511999999999"));
  assert.throws(() => assertEbvSessionDir("C:/Projetos/milena-crm/whatsapp-contact-connector/session"));
  assert.doesNotThrow(() => assertEbvSessionDir("C:/Users/kevin/OpenBot/Agents/ebv/ebv-whatsapp/session"));
});

test("Direct só responde mensagem nova, dentro da janela, e sem código interno", () => {
  const base = {
    channel: "instagram",
    status: "ia",
    reply: "Oi",
    createdAt: "2026-11-18T18:05:00.000Z",
    agentSince: "2026-11-18T18:00:00.000Z",
    now: "2026-11-18T18:06:00.000Z",
  };
  assert.equal(shouldAutoReplyDirect(base), true);
  assert.equal(shouldAutoReplyDirect({ ...base, createdAt: "2026-11-17T12:29:55.000Z" }), false);
  assert.equal(shouldAutoReplyDirect({ ...base, duplicate: true }), false);
  assert.equal(shouldAutoReplyDirect({ ...base, channel: "whatsapp" }), false);
  assert.equal(shouldAutoReplyDirect({ ...base, status: "pausada" }), false);
  assert.equal(shouldAutoReplyDirect({ ...base, status: "humano" }), false);
  assert.equal(shouldAutoReplyDirect({ ...base, status: "humano", handoff: true }), true);
  assert.equal(shouldAutoReplyDirect({ ...base, now: "2026-11-19T16:00:00.000Z" }), false);
  assert.equal(shouldAutoReplyDirect({ ...base, agentSince: "" }), false);
  assert.equal(sanitizeCustomerReply("O código interno é prop-1792252762995."), "");
  assert.equal(
    sanitizeCustomerReply("Veja aqui: https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995 ou https://wa.me/5541988024346?text=oi. Quer falar com ela?"),
    "Veja aqui: https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995 ou https://wa.me/5541988024346?text=oi. Quer falar com ela?",
  );
  assert.equal(sanitizeCustomerReply("Veja https://outrosite.com"), "");
  assert.equal(sanitizeCustomerReply("Rua Júlio Wischral, 993, no Uberaba de Cima?"), "Rua Júlio Wischral, 993, no Uberaba de Cima?");
  assert.equal(sanitizeCustomerReply("Rua Julio Wischral, 993, sobrado 02"), "");
  assert.equal(sanitizeCustomerReply("Quer visitar? E qual o prazo?"), "");
  assert.equal(sanitizeCustomerReply("Sobre o triplex no Uberaba de Cima, me passa seu nome e sobrenome?"), "Sobre o triplex no Uberaba de Cima, me passa seu nome e sobrenome?");
  const prompt = directAgentPrompt({
    text: "Quero o triplex",
    turn: {
      profile: { name: "Deyse Silva" },
      property: { id: "prop-1792252762995", line: "220 m², Uberaba de Cima" },
      reply: "Me passa seu nome e sobrenome?",
      nextStep: "Pedir nome completo",
      visit: null,
    },
    catalog: [{ id: "prop-1792252762995", title: "Lindo triplex", location: "Uberaba de Cima", area: 220, beds: 3, price: 1190000 }],
  });
  assert.equal(prompt.user.includes("prop-"), false);
  assert.equal(/c[oó]digo/i.test(prompt.user), false);
});
