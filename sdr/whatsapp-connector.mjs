// Sessão própria da EBV. Não inicia sozinho e não aceita pasta da Milena nem do Wellness.
import { assertEbvSessionDir, outboundJid } from "../src/sdr.js";

const sessionDir = process.env.EBV_WHATSAPP_SESSION_DIR || "";

export function prepareOutbound(remoteJid) {
  assertEbvSessionDir(sessionDir);
  return outboundJid(remoteJid);
}
