#!/usr/bin/env python3
"""Atendimento do Instagram Direct da EBV.

Roda no hermes-vps, perfil ebv, modelo gpt-5.6-luna pela assinatura ChatGPT.
Não usa API da OpenAI. Não mexe na recepção da Milena. Não responde mensagem antiga.
"""
import json
import re
import subprocess
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path("/home/deploy/.hermes/profiles/ebv")
TOKEN_FILE = HOME / "secrets" / "ig-token"
AGENT_TOKEN_FILE = HOME / "secrets" / "agent-token"
STATE_FILE = HOME / "direct-state.json"
HERMES = "/home/deploy/.hermes/hermes-agent/venv/bin/python"
OWN = {"17841448438742197", "29032059263111949"}
GRAPH = "https://graph.instagram.com/v23.0"
WINDOW = timedelta(hours=20)
FOLLOWUP_1_AFTER = timedelta(hours=3)
FOLLOWUP_2_AFTER = timedelta(hours=20)
META_WINDOW_CAP = timedelta(hours=23, minutes=30)
BRT = timezone(timedelta(hours=-3))
CATALOG_URL = "https://ebvimoveiscuritiba.com.br/api/properties"
CRM_LEAD_URL = "https://ebvimoveiscuritiba.com.br/api/agent/direct-lead"
CATALOG_UA = "Mozilla/5.0 (compatible; EBVDirect/1.0)"
SITE = "https://ebvimoveiscuritiba.com.br"
EDICLEIA_WA = "5541988024346"
ACTIVE_AD_PROPERTY_ID = "prop-1792252762995"

PUBLIC_EXTRAS = {
    "prop-1792252762995": {
        "bairro_completo": "Uberaba de Cima (Jardim Santa Bárbara, Uberaba)",
        "endereco_publico": (
            "Rua Júlio Wischral, 993, no Uberaba de Cima, a uns 50 m de panificadora "
            "(Panificadora Akipão), farmácias e restaurantes, a uma quadra da Rua Capitão Leônidas Marques"
        ),
        "regra_complemento": (
            "O complemento específico da unidade dentro do lote só pode ser passado na confirmação da visita, "
            "porque o imóvel é habitado."
        ),
        "detalhes": (
            "Aceita entrada + financiamento. Sala de estar com lareira, sala de jantar para até 8 pessoas, "
            "espaço gourmet com cobertura em vidro temperado e deck de itaúba, suíte com closet (porta panorâmica), "
            "ático amplo para cinema ou academia, espaço para home office (3+ estações) e garagem para até 3 carros (2 em paralelo)."
        ),
    },
}

OTHER_PROPERTY_HINTS = (
    "harmonia",
    "garden sevilha",
    "sevilha",
    "boa vista",
    "theros",
    "alto da rua xv",
    "studio",
    "apartamento",
    "cajuru",
    "terreno",
    "zr3",
    "jardim das americas",
    "quais imoveis",
    "outras opcoes",
    "outros imoveis",
    "tem outros",
    "portifolio",
    "portfolio",
    "vender meu",
    "avaliar meu",
)

TRIPLEX_KEYWORDS = (
    "triplex",
    "220",
    "uberaba",
    "wischral",
    "akipao",
)


def now():
    return datetime.now(timezone.utc)


def stamp(value):
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_time(value):
    raw = str(value or "").strip()
    if raw.endswith("+0000"):
        raw = raw[:-5] + "+00:00"
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_state():
    current = stamp(now())
    if STATE_FILE.exists():
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        changed = False
        if not state.get("followup_since"):
            state["followup_since"] = current
            changed = True
        if "followups" not in state or not isinstance(state.get("followups"), dict):
            state["followups"] = {}
            changed = True
        if "qualified" not in state or not isinstance(state.get("qualified"), list):
            state["qualified"] = []
            changed = True
        if changed:
            save_state(state)
        return state
    state = {
        "since": current,
        "followup_since": current,
        "replied": [],
        "failed": [],
        "pending": [],
        "followups": {},
        "qualified": [],
    }
    save_state(state)
    return state


def save_state(state):
    state["replied"] = state.get("replied", [])[-400:]
    state["failed"] = state.get("failed", [])[-200:]
    state["pending"] = state.get("pending", [])[-200:]
    state["qualified"] = state.get("qualified", [])[-300:]
    followups = state.get("followups") or {}
    if len(followups) > 200:
        keys = list(followups.keys())[-200:]
        state["followups"] = {k: followups[k] for k in keys}
    STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
    STATE_FILE.chmod(0o600)


def read_token():
    return TOKEN_FILE.read_text(encoding="utf-8").strip()


def request_json(url, token, method="GET", payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8")), res.status
    except urllib.error.HTTPError as err:
        return None, err.code


def fold(text):
    raw = unicodedata.normalize("NFKD", str(text or ""))
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch))
    return " ".join(raw.lower().split())


def is_allowed_url(raw_url):
    clean = str(raw_url or "").strip().rstrip(".,;:!?)\"'`”")
    lower = clean.lower()
    if lower.startswith(SITE + "/media/"):
        return False
    if lower == SITE or lower.startswith(SITE + "/"):
        return True
    if lower == f"https://wa.me/{EDICLEIA_WA}" or lower.startswith(f"https://wa.me/{EDICLEIA_WA}?"):
        return True
    return False


def strip_urls(text):
    def _keep_or_drop(match):
        token = match.group(0)
        trimmed = token.rstrip(".,;:!?)\"'`”")
        suffix = token[len(trimmed):]
        normalized = trimmed if trimmed.lower().startswith("http") else f"https://{trimmed}"
        if is_allowed_url(normalized):
            return trimmed + suffix
        return " "

    cleaned = re.sub(r"(?:https?://|www\.|wa\.me/)\S+", _keep_or_drop, str(text or ""), flags=re.IGNORECASE)
    return " ".join(cleaned.split())


def mask_private_unit(text):
    value = str(text or "")
    value = re.sub(r",?\s*\bsobrado\s*0?2\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+,", ",", value)
    value = re.sub(r",\s*,+", ",", value)
    return " ".join(value.split()).strip(" ,")


def without_official_urls(text):
    cleaned = re.sub(r"https://ebvimoveiscuritiba\.com\.br/[^\s)>\"]*", " ", str(text or ""), flags=re.IGNORECASE)
    cleaned = re.sub(rf"https://wa\.me/{EDICLEIA_WA}(?:\?[^\s)>\"]*)?", " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def sanitize(text, max_bytes=900):
    value = strip_urls(text)
    value = re.sub(r"(?<!/imovel/)\bprop-[\w-]+\b", "", value, flags=re.IGNORECASE)
    value = mask_private_unit(value)
    value = " ".join(value.split()).strip().strip("\"'`“”")
    if not value:
        return ""
    outside = without_official_urls(value).lower()
    if "prop-" in outside or "código" in outside or "codigo" in outside:
        return ""
    raw = value.encode("utf-8")
    if len(raw) > max_bytes:
        value = raw[:max_bytes].decode("utf-8", "ignore").rsplit(" ", 1)[0].strip()
    return value


def brl(value):
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return ""
    return "R$ " + f"{number:,}".replace(",", ".")


def short_title(title):
    parts = [part.strip() for part in str(title or "").split("|") if part.strip()]
    short = ""
    for part in parts:
        nxt = part if not short else short + ", " + part
        if len(nxt) > 180:
            break
        short = nxt
    return short or " ".join(str(title or "").split())[:180]


def qty(value, one, many):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return ""
    if number <= 0:
        return ""
    return f"{number} {one if number == 1 else many}"


def media_url(src):
    value = str(src or "").strip()
    if value.startswith("/"):
        value = SITE + value
    if not value.startswith(SITE + "/media/"):
        return ""
    return value.split("?")[0].rstrip(".,)")


# Três ângulos diferentes por imóvel, vistos na galeria em 19/11/2026.
SHOTS = {
    "prop-1792252762995": [
        ("fachada de dia", "https://ebvimoveiscuritiba.com.br/media/photos/2026/10/93e26a65-5bec-4ba4-a2ae-db78bad03919.jpg"),
        ("espaço gourmet com cobertura de vidro", "https://ebvimoveiscuritiba.com.br/media/photos/2026/10/1ed3c9f4-df4b-4fb6-a383-4ad0c6fbdb2f.jpg"),
        ("ático com lareira", "https://ebvimoveiscuritiba.com.br/media/photos/2026/10/f3917ac8-5092-4d64-ab66-d6fd179f10c6.jpg"),
    ],
    "prop-default-jba-1": [
        ("fachada do sobrado novo", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/5157b583-5552-4621-b0d2-c47445ed53db.jpg"),
        ("sala vazia, sem móveis", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/972adf14-afc3-444c-af34-0704d14bba10.jpg"),
        ("quarto com sacada", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/6ffac0d3-f07a-438b-b3b1-d194190d3dcb.jpg"),
    ],
    "prop-default-1": [
        ("sala de jantar", "https://ebvimoveiscuritiba.com.br/media/photos/2026/10/87870b29-8191-44d1-8e77-d5b100c9c42c.jpg"),
        ("suíte", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/69efaf5a-4bf2-4b0f-9fdb-3ac05b68a2fd.jpg"),
        ("ático", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/779d7374-a1e6-45db-a02c-7d51908621ed.jpg"),
    ],
    "prop-default-jba-2": [
        ("entrada do condomínio", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/2bead669-6c63-4daf-8fd0-7acefc5c3b6c.jpg"),
        ("brinquedoteca", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/f1b3438e-801c-4d0a-a36c-dcf992a21f6c.jpg"),
        ("sala e cozinha do apartamento", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/ef5343c4-37fd-43ab-95de-a90c31483f9f.jpg"),
    ],
    "prop-1786737317774": [
        ("imagem do projeto, vista do prédio", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/d448c42a-a479-4d5a-bd6e-4ca6d11287bf.jpg"),
        ("imagem do projeto, studio com mezanino", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/b27ca4c2-25ef-4225-828f-f3286053d79a.jpg"),
        ("imagem do projeto, terraço com piscina", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/73ffd4ec-e55f-41fd-ad48-f98026194cc2.jpg"),
    ],
    "prop-default-2": [
        ("frente do terreno, com a casa que está no lote", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/9723dade-c127-4586-be33-af94a5ee49eb.jpg"),
        ("outro ângulo da mesma frente", "https://ebvimoveiscuritiba.com.br/media/photos/2026/08/43332278-63a0-48b9-9644-f366c9c1b1bc.jpg"),
    ],
}

SHOT_NOTES = {
    "prop-1786737317774": "Pré-lançamento. As imagens são do projeto, não de uma unidade pronta.",
    "prop-default-2": "Há uma construção antiga na frente. Não diga que o lote está vazio e não invente prédio.",
    "prop-default-1": "São três ambientes internos. A fachada deste sobrado está marcada como imagem gerada e não entra.",
    "prop-default-jba-1": "Sobrado novo, ainda sem móveis.",
}


def photo_urls(prop):
    raw = []
    if isinstance(prop, dict):
        if prop.get("image"):
            raw.append(prop.get("image"))
        if isinstance(prop.get("images"), list):
            raw.extend(prop.get("images"))
    found = []
    for src in raw:
        url = media_url(src)
        if url and url not in found:
            found.append(url)
    return found


def chosen_shots(prop):
    live = set(photo_urls(prop))
    found = []
    seen = set()
    for label, url in SHOTS.get(str((prop or {}).get("id") or ""), []):
        if url in live and url not in seen:
            found.append((label, url))
            seen.add(url)
    return found


def public_line(prop):
    if not isinstance(prop, dict):
        return ""
    pid = str(prop.get("id") or "")
    extra = PUBLIC_EXTRAS.get(pid, {})
    location = extra.get("bairro_completo") or " ".join(str(prop.get("location") or "").split())
    kind = " ".join(str(prop.get("type") or "imóvel").split()) or "imóvel"
    bits = [f"{kind} em {location}" if location else kind]
    if prop.get("area"):
        bits.append(f"{prop.get('area')} m²")
    for piece in (
        qty(prop.get("beds"), "quarto", "quartos"),
        qty(prop.get("baths"), "banheiro", "banheiros"),
        qty(prop.get("vagas"), "vaga", "vagas"),
    ):
        if piece:
            bits.append(piece)
    money = brl(prop.get("price"))
    if money:
        bits.append(money)
    name = short_title(prop.get("title"))
    if name:
        bits.append(name)
    if extra.get("endereco_publico"):
        bits.append("endereço público aprovado: " + extra["endereco_publico"])
    if extra.get("regra_complemento"):
        bits.append(extra["regra_complemento"])
    if extra.get("detalhes"):
        bits.append("detalhes confirmados: " + extra["detalhes"])
    bits.append(f"link oficial da página do imóvel no site: {SITE}/imovel/{pid}")
    shots = chosen_shots(prop)
    if shots:
        bits.append("fotos " + " | ".join(f"{label} {url}" for label, url in shots))
    note = SHOT_NOTES.get(pid)
    if note:
        bits.append(note)
    line = ", ".join(bits)
    folded = without_official_urls(line).lower()
    if not line or "prop-" in folded or "código" in folded or "codigo" in folded:
        return ""
    return line


def load_properties():
    req = urllib.request.Request(
        CATALOG_URL,
        headers={"User-Agent": CATALOG_UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode("utf-8"))
    except Exception as err:
        print(f"direct catalog_fail {type(err).__name__}", flush=True)
        return []
    if not isinstance(data, list):
        print("direct catalog_fail shape", flush=True)
        return []
    found = []
    for prop in data:
        if not isinstance(prop, dict) or not prop.get("id"):
            continue
        if prop.get("sold") or str(prop.get("status") or "") == "vendido":
            continue
        found.append(prop)
    return found


def ad_title_from(messages):
    for msg in reversed(messages or []):
        ref = msg.get("referral")
        if not isinstance(ref, dict) or not ref:
            continue
        ctx = ref.get("ads_context_data") if isinstance(ref.get("ads_context_data"), dict) else {}
        title = " ".join(str((ctx or {}).get("ad_title") or "").split())
        if title:
            return title
        ad_id = " ".join(str(ref.get("ad_id") or "").split())
        if ad_id:
            return f"Anúncio Meta {ad_id}"
    return ""


def is_triplex_ad_context(messages):
    title = fold(ad_title_from(messages))
    if title and ("triplex" in title or "220" in title or "uberaba" in title):
        return True
    cust_texts = [fold(m.get("text")) for m in (messages or []) if m.get("role") == "cliente" and m.get("text")]
    if not cust_texts:
        return False
    combined = " ".join(cust_texts)
    if any(hint in combined for hint in OTHER_PROPERTY_HINTS):
        return False
    if any(kw in combined for kw in TRIPLEX_KEYWORDS):
        return True
    for msg in messages or []:
        if msg.get("role") == "ebv":
            ebv_text = fold(msg.get("text"))
            if "triplex" in ebv_text and ("uberaba" in ebv_text or "220" in ebv_text):
                return True
    return False


def ad_note(messages):
    title = ad_title_from(messages)
    if title:
        return (
            f"ORIGEM CONFIRMADA DE ANÚNCIO: este contato abriu a conversa a partir do anúncio '{title}'. "
            "Responda diretamente sobre esse imóvel. NUNCA pergunte 'sobre qual imóvel você quer saber?'."
        )
    if is_triplex_ad_context(messages):
        return (
            "CONTEXTO DO ANÚNCIO DO TRIPLEX: esta conversa trata do Sobrado Triplex 220 m² no Uberaba de Cima (R$ 1.190.000). "
            "NUNCA pergunte 'sobre qual imóvel você quer saber?'. Responda diretamente sobre este Triplex."
        )
    return ""


def stock_index(properties):
    groups = {}
    order = []
    for prop in properties or []:
        place = " ".join(str(prop.get("location") or "").split()) or "Sem bairro"
        if prop.get("id") == "prop-1792252762995":
            place = "Uberaba / Uberaba de Cima"
        if place not in groups:
            order.append(place)
            groups[place] = []
        parts = [part.strip() for part in str(prop.get("title") or "").split("|") if part.strip()]
        name = parts[0] if parts else "Imóvel"
        if len(parts) > 1 and len(parts[1]) <= 42:
            name = f"{name}, {parts[1]}"
        bits = [name]
        if prop.get("area"):
            bits.append(f"{prop.get('area')} m²")
        money = brl(prop.get("price"))
        if money:
            bits.append(money)
        groups[place].append(", ".join(bits))
    return "\n".join(f"- {place}: " + " | ".join(groups[place]) for place in order)


def transcript(turns):
    lines = []
    for turn in (turns or [])[-12:]:
        who = "EBV" if turn.get("role") == "ebv" else "Cliente"
        text = " ".join(str(turn.get("text") or "").split())
        if text:
            lines.append(f"{who}: {text[:500]}")
    return "\n".join(lines)


def next_visit_slots(reference=None):
    base = (reference or now()).astimezone(BRT)
    day_names = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"]
    slots = []
    offset = 1
    while len(slots) < 2 and offset <= 7:
        cand = base + timedelta(days=offset)
        if cand.weekday() <= 5:  # segunda a sábado
            label = "amanhã (" + day_names[cand.weekday()] + ")" if offset == 1 else f"{day_names[cand.weekday()]} ({cand.strftime('%d/%m')})"
            hour = "10h" if len(slots) == 0 else "15h"
            slots.append(f"{label} às {hour}")
        offset += 1
    return slots or ["amanhã às 10h", "depois de amanhã às 15h"]


def build_wa_link(summary):
    clean = " ".join(str(summary or "").split()).strip().strip("\"'`“”")
    clean = re.sub(r"\bprop-[\w-]+\b", "", clean, flags=re.IGNORECASE)
    clean = mask_private_unit(clean)
    clean = " ".join(clean.split())
    if not clean:
        return f"https://wa.me/{EDICLEIA_WA}"
    folded = clean.lower()
    if "código" in folded or "codigo" in folded:
        return f"https://wa.me/{EDICLEIA_WA}"
    if len(clean) > 280:
        clean = clean[:280].rsplit(" ", 1)[0].strip()
    return f"https://wa.me/{EDICLEIA_WA}?text={urllib.parse.quote(clean, safe='')}"


def extract_wa_link(text):
    raw = str(text or "")
    match = re.search(r"\[\[WA_RESUMO:\s*(.*?)\s*\]\]", raw, flags=re.IGNORECASE | re.DOTALL)
    if match:
        cleaned = (raw[:match.start()] + " " + raw[match.end():]).strip()
        return cleaned, build_wa_link(match.group(1)), match.group(1).strip()
    direct = re.search(rf"https://wa\.me/{EDICLEIA_WA}(?:\?text=([^\s]+))?", raw)
    if direct:
        cleaned = (raw[:direct.start()] + " " + raw[direct.end():]).strip()
        if direct.group(1):
            decoded = urllib.parse.unquote_plus(direct.group(1))
            return cleaned, build_wa_link(decoded), decoded
        return cleaned, f"https://wa.me/{EDICLEIA_WA}", ""
    return raw, "", ""


def extract_crm_lead(text):
    raw = str(text or "")
    match = re.search(r"\[\[CRM_LEAD:\s*(\{.*?\})\s*\]\]", raw, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        cleaned = re.sub(r"\[\[CRM_LEAD:.*", "", raw, flags=re.IGNORECASE | re.DOTALL).strip()
        return cleaned, None
    cleaned = (raw[:match.start()] + " " + raw[match.end():]).strip()
    try:
        parsed = json.loads(match.group(1))
        return cleaned, parsed if isinstance(parsed, dict) else None
    except ValueError:
        return cleaned, None


def match_property_from_text(text, properties):
    needle = fold(text)
    if not needle:
        return None
    best = None
    best_score = 0
    for prop in properties or []:
        score = 0
        loc = fold(prop.get("location"))
        if loc and loc in needle:
            score += 4
        if "uberaba" in loc and "uberaba" in needle:
            score += 2
        if prop.get("area") and f"{prop.get('area')}" in needle:
            score += 3
        words = [w for w in re.split(r"[^a-z0-9]+", fold(prop.get("title"))) if len(w) > 4]
        score += sum(1 for w in words if w in needle)
        if score > best_score:
            best = prop
            best_score = score
    return best if best_score >= 3 else None


def read_agent_token():
    if AGENT_TOKEN_FILE.exists():
        return AGENT_TOKEN_FILE.read_text(encoding="utf-8").strip()
    return ""


def push_crm_lead(external_id, crm_lead, wa_summary, turns, properties):
    agent_token = read_agent_token()
    if not agent_token:
        print("direct crm_skip no_token", flush=True)
        return False
    data = crm_lead if isinstance(crm_lead, dict) else {}
    summary = " ".join(str(data.get("resumo") or wa_summary or "").split()).strip()
    if not summary and not data:
        return False
    imovel_hint = " ".join(str(data.get("imovel") or summary).split())
    prop = match_property_from_text(imovel_hint, properties)
    if not prop:
        chat_blob = " ".join(str(t.get("text") or "") for t in (turns or []))
        prop = match_property_from_text(chat_blob, properties)
    if not prop and is_triplex_ad_context(turns):
        prop = next((p for p in (properties or []) if p.get("id") == ACTIVE_AD_PROPERTY_ID), None)
    ad_title = ad_title_from(turns) or ("Triplex 220 m² Uberaba de Cima" if is_triplex_ad_context(turns) else "")
    payload = {
        "externalId": external_id,
        "name": str(data.get("nome") or "").strip(),
        "phone": str(data.get("telefone") or "").strip(),
        "goal": str(data.get("objetivo") or "").strip(),
        "budgetFit": str(data.get("orcamento") or "").strip(),
        "propertyId": str(prop.get("id") or "") if prop else "",
        "propertyTitle": short_title(prop.get("title")) if prop else str(data.get("imovel") or "").strip(),
        "adTitle": ad_title,
        "summary": summary,
    }
    req = urllib.request.Request(
        CRM_LEAD_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bearer " + agent_token,
            "Content-Type": "application/json",
            "User-Agent": CATALOG_UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            res_body = json.loads(res.read().decode("utf-8"))
            print(f"direct crm_ok ref={res_body.get('ref', '')} notified={res_body.get('notified')}", flush=True)
            return True
    except urllib.error.HTTPError as err:
        print(f"direct crm_fail status={err.code}", flush=True)
    except Exception as err:
        print(f"direct crm_fail {type(err).__name__}", flush=True)
    return False


def extract_photo_tag(text):
    raw = str(text or "")
    match = re.search(r"\[\[ENVIAR_FOTOS(?::\s*([^\]]*))?\]\]", raw, flags=re.IGNORECASE)
    if not match:
        return raw, ""
    cleaned = (raw[:match.start()] + " " + raw[match.end():]).strip()
    return cleaned, (match.group(1) or "").strip()


def take_photos(text, allowed):
    found = []
    for url in re.findall(r"https://ebvimoveiscuritiba\.com\.br/media/[^\s)>\"]+", text or ""):
        url = url.rstrip(".,)")
        if url in allowed and url not in found:
            found.append(url)
        if len(found) >= 3:
            break
    cleaned = strip_urls(text)
    return cleaned, found


def build_system_prompt(turns, properties):
    lines = [public_line(prop) for prop in properties or []]
    lines = [line for line in lines if line]
    if lines:
        facts = "\n".join(f"- {line}" for line in lines)
    else:
        facts = "- O catálogo não carregou nesta tentativa. Não afirme que um bairro está sem imóvel."
    origin = ad_note(turns)
    chat = transcript(turns) or "Cliente: (sem texto)"
    index = stock_index(properties) or "- cadastro sem imóveis nesta leitura"
    slots = next_visit_slots()
    return (
        "Você conversa no Instagram Direct da EBV Imóveis Curitiba, como uma pessoa da equipe da Edicleia Borba Vieira. "
        "Português do Brasil, natural, direto e acolhedor.\n"
        "REGRAS INEGOCIÁVEIS:\n"
        "- Não diga que é inteligência artificial. Não invente imóvel, preço, metragem, disponibilidade, condições de pagamento ou benefícios fora do cadastro.\n"
        "- Nunca prometa algo que não esteja no cadastro (ex: não prometa que permuta/FGTS já estão aprovados se não constar no cadastro; apenas pergunte como pretende pagar para a Edicleia avaliar). Não prometa vídeo.\n"
        "- LINKS PERMITIDOS NO DIRECT: é PERMITIDO enviar os links oficiais do site da EBV que constam no catálogo (como https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995) quando o cliente pedir o link do imóvel no início ou meio da conversa. NUNCA envie link do WhatsApp (wa.me) no início ou no meio da conversa.\n"
        "- LINK DO WHATSAPP (SÓ NO FINAL DO FUNIL): envie https://wa.me/5541988024346 (sempre via [[WA_RESUMO: ...]]) APENAS no FINAL DO FUNIL — ou no fechamento após receber nome e WhatsApp, ou na etapa final de pedir o telefone se o lead preferir não informar o próprio número.\n"
        "- Nunca comece com 'Claro!' seguido de recusa (ex: nunca diga 'Por aqui não envio links'). Se o cliente pedir o link do imóvel, entregue apenas o link oficial da página do imóvel no site (sem wa.me) e termine com 1 pergunta natural.\n"
        "- Nunca escreva código interno solto fora da URL oficial do site. Não peça documento, CPF ou RG.\n"
        "- FAÇA APENAS UMA PERGUNTA POR MENSAGEM. E TODA MENSAGEM SUA DEVE TERMINAR COM UMA PERGUNTA (com '?'). Nunca envie fotos ou texto sem terminar com uma pergunta.\n"
        "CONTEXTO DE ANÚNCIO E IMÓVEIS:\n"
        "- Quando houver origem de anúncio do Triplex, menção ao Triplex/220 m²/Uberaba ou saudação anterior sobre o Triplex, responda diretamente sobre o Sobrado Triplex 220 m² no Uberaba de Cima (R$ 1.190.000) e NUNCA pergunte 'sobre qual imóvel você quer saber?'.\n"
        "- NÃO REPITA A SAUDAÇÃO DA META: se a saudação automática ('Olá! Que bom ver seu interesse no Triplex...') já tiver aberto a conversa ou o cliente tiver clicado em um dos botões do anúncio ('Quero o endereço do Triplex...', 'Quero mais fotos do Triplex...', 'Quero saber condições e agendar visita...'), NÃO repita boas-vindas genéricas nem repita a apresentação básica do preço; responda direto e de forma acolhedora ao que o lead pediu (endereço, fotos ou condições/visita) e termine com 1 pergunta ('?').\n"
        "- Se citar outro bairro do resumo abaixo, fale dos imóveis daquele bairro.\n"
        "- Se for uma mensagem orgânica genérica sem contexto de imóvel nem saudação prévia do Triplex (ex.: apenas 'valor' ou 'endereço'), não presuma um imóvel: pergunte de forma cordial qual imóvel ou bairro a pessoa procura.\n"
        "ENDEREÇO DO TRIPLEX (Uberaba de Cima):\n"
        "- Quando perguntarem o endereço/localização do Triplex, responda com o endereço completo aprovado: "
        "'Rua Júlio Wischral, 993, no Uberaba de Cima, a uns 50 m de panificadora (Panificadora Akipão), farmácias e restaurantes, a uma quadra da Rua Capitão Leônidas Marques' "
        "e termine com uma frase de pergunta separada por ponto (ex: '...e a uma quadra da Rua Capitão Leônidas Marques. O que você achou dessa localização?').\n"
        "- NUNCA passe o complemento 'sobrado 02' antes de a visita estar confirmada. Se perguntarem qual é a casa ou unidade específica dentro do lote, explique com naturalidade que o complemento é passado na confirmação da visita porque o imóvel é habitado.\n"
        "FOTOS:\n"
        "- Quando o cliente pedir fotos ou mais detalhes (e ainda não tiver recebido fotos nesta conversa), JÁ ENVIE as 3 fotos na hora! Descreva brevemente os 3 ambientes (no Triplex: fachada de dia, espaço gourmet com cobertura de vidro e ático com lareira), termine com a pergunta (ex: 'O que você achou dessas fotos, ou gostaria de ver algum outro detalhe?'), e na última linha escreva a tag oculta [[ENVIAR_FOTOS: Triplex]] (ou o nome do imóvel). Nunca pergunte 'Você gostaria de receber as fotos?' quando o cliente já pediu fotos ou detalhes.\n"
        "- Nunca repita fotos que já foram enviadas na conversa.\n"
        "ORDEM DO FUNIL (pule o que o cliente já respondeu; sempre 1 pergunta por vez e termine com '?'):\n"
        "1) Após entregar fotos, link pedido ou endereço: pergunte o que a pessoa achou ou o que mais gostaria de ver.\n"
        "2) Qualificação (uma pergunta por mensagem, nesta ordem):\n"
        "   a) se a busca é para morar ou investir;\n"
        "   b) qual o prazo em que pretende fechar/se mudar;\n"
        "   c) qual a forma de pagamento pretendida (ex: financiamento, FGTS, recursos próprios ou imóvel na troca).\n"
        "3) Oferecer visita com 2 opções de dia e horário (use estas sugestões atuais: "
        f"{slots[0]} ou {slots[1]}), deixando claro que a Edicleia confirma o agendamento.\n"
        "4) Só depois de oferecer a visita / confirmar interesse na visita: peça o nome completo (uma mensagem) e depois o WhatsApp (outra mensagem) explicando que a Edicleia entra em contato por lá para confirmar a visita e passar o complemento da unidade.\n"
        "   - SE O LEAD PREFERIR NÃO PASSAR O TELEFONE NESSA ETAPA FINAL: não insista! Envie o link oficial do WhatsApp da Edicleia com uma mensagem pronta resumindo o interesse usando a tag [[WA_RESUMO: ...]] e encerre com 1 pergunta natural.\n"
        "5) Fechamento (quando já tiver objetivo, prazo/pagamento, interesse em visita, nome completo e WhatsApp — ou quando na etapa final o lead preferir não passar o telefone): "
        "confirme que vai passar tudo para a Edicleia chamar no WhatsApp (ou que ela já pode chamar pelo link abaixo com o resumo pronto) para confirmar a visita e passar o complemento da unidade, e faça uma pergunta separada no final (ex: '...Ficou mais alguma dúvida sobre o Triplex enquanto ela te chama?'). "
        "SOMENTE nesse fechamento final (ou se na etapa final de pedir telefone o lead recusar informar o número), adicione nas últimas linhas exatamente neste formato:\n"
        "[[WA_RESUMO: Olá, Edicleia! Vim pelo Instagram com interesse no <imóvel com bairro e valor>. Nome: <nome ou não informado>. Objetivo: <morar/investir>. Pagamento/Prazo: <detalhes>. Visita: <preferência de dia/horário>.]]\n"
        "[[CRM_LEAD: {\"nome\":\"<nome completo>\",\"telefone\":\"<whatsapp ou vazio>\",\"objetivo\":\"<morar|investir|vender|avaliar>\",\"orcamento\":\"<forma de pagamento e prazo>\",\"imovel\":\"<nome/bairro/valor do imóvel>\",\"resumo\":\"<resumo curto com visita/horário, pagamento, prazo e objetivo>\"}]]\n"
        "Não escreva a URL wa.me fora da tag [[WA_RESUMO: ...]] e NUNCA envie wa.me no início ou no meio da conversa.\n\n"
        f"{origin}\n"
        f"Resumo por bairro, fonte do cadastro:\n{index}\n\n"
        f"Catálogo:\n{facts}\n\n"
        f"Conversa:\n{chat}\n\n"
        "Escreva só a próxima mensagem da EBV (1 pergunta no final, terminando em '?', sem URLs de /media/ no texto)."
    )


def call_hermes(prompt):
    try:
        done = subprocess.run(
            [
                HERMES, "-m", "hermes_cli.main", "--profile", "ebv",
                "-z", prompt, "-m", "gpt-5.6-luna", "--provider", "openai-codex",
                "--reasoning", "medium", "--ignore-rules", "--in", str(HOME),
            ],
            cwd=str(HOME),
            capture_output=True,
            text=True,
            timeout=140,
            check=False,
        )
    except subprocess.TimeoutExpired:
        print("luna_timeout", flush=True)
        return ""
    if done.returncode != 0:
        print(f"luna_fail code={done.returncode}", flush=True)
        return ""
    return done.stdout or ""


def luna_reply(turns, properties):
    prompt = build_system_prompt(turns, properties)
    stdout = call_hermes(prompt)
    if not stdout:
        return "", [], None, ""
    allowed = {url for prop in properties or [] for _label, url in chosen_shots(prop)}
    raw_reply, crm_lead = extract_crm_lead(stdout)
    raw_reply, wa_link, wa_summary = extract_wa_link(raw_reply)
    raw_reply, photo_hint = extract_photo_tag(raw_reply)
    text, photos = take_photos(raw_reply, allowed)
    if not photos and (photo_hint or "[[ENVIAR_FOTOS" in stdout.upper()):
        prop = match_property_from_text(photo_hint, properties)
        if not prop:
            chat_blob = " ".join(str(t.get("text") or "") for t in (turns or []))
            prop = match_property_from_text(chat_blob, properties)
        if not prop and is_triplex_ad_context(turns):
            prop = next((p for p in (properties or []) if p.get("id") == ACTIVE_AD_PROPERTY_ID), None)
        if prop:
            photos = [url for _label, url in chosen_shots(prop)][:3]
    budget = 920 - (len(wa_link.encode("utf-8")) + 2 if wa_link else 0)
    body = sanitize(text, max_bytes=max(350, budget))
    if not body:
        return "", photos, None, ""
    if wa_link:
        return f"{body}\n\n{wa_link}", photos, crm_lead, wa_summary
    return body, photos, crm_lead, wa_summary


def luna_followup(turns, properties, stage):
    chat = transcript(turns) or "Cliente: (sem texto)"
    origin = ad_note(turns)
    slots = next_visit_slots()
    if stage == 1:
        goal = (
            "Envie um lembrete curto, educado e natural (~3h sem resposta do cliente), retomando o assunto do imóvel da conversa "
            "(se for o Triplex no Uberaba de Cima, cite-o), sem ser invasivo, e termine com UMA pergunta simples (ex: se conseguiu ver as informações ou se ficou alguma dúvida sobre a localização/imóvel)."
        )
    else:
        goal = (
            "Envie a última tentativa gentil dentro da janela de 24h (~20h sem resposta), trazendo ALGO NOVO: "
            f"ofereça 2 opções concretas de dia e horário para conhecer o imóvel ({slots[0]} ou {slots[1]}), "
            "sem insistir caso não faça sentido agora, e termine com UMA pergunta (com '?')."
        )
    prompt = (
        "Você conversa no Instagram Direct da EBV Imóveis Curitiba, como equipe da Edicleia Borba Vieira.\n"
        f"{goal}\n"
        "REGRAS: Português do Brasil, máximo 2 frases, apenas UMA pergunta terminando com '?', "
        "PROIBIDO citar código prop- solto ou o complemento 'sobrado 02', "
        "não prometa vídeo ou condição fora do cadastro.\n"
        f"{origin}\n"
        f"Conversa:\n{chat}\n\n"
        "Escreva só a mensagem de retomada da EBV."
    )
    stdout = call_hermes(prompt)
    if not stdout:
        return ""
    raw_reply, _ = extract_crm_lead(stdout)
    return sanitize(raw_reply, max_bytes=700)


def thread_turns(thread):
    messages = ((thread.get("messages") or {}).get("data") or [])
    found = []
    for msg in messages:
        sender = str((msg.get("from") or {}).get("id") or "")
        text = str(msg.get("message") or "").strip()
        created = parse_time(msg.get("created_time"))
        referral = msg.get("referral") if isinstance(msg.get("referral"), dict) else None
        if not sender or not msg.get("id") or not created:
            continue
        if not text and not referral:
            continue
        found.append({
            "id": str(msg["id"]),
            "from": sender,
            "role": "ebv" if sender in OWN else "cliente",
            "text": text,
            "at": created,
            "referral": referral,
        })
    found.sort(key=lambda item: item["at"])
    return found


def is_auto_greeting(text):
    folded = fold(text)
    return "confirmacao de que recebemos" in folded or "mensagem automatica" in folded


def is_handoff_complete(text):
    folded = fold(text)
    return "edicleia" in folded and ("entrar em contato" in folded or "chamar no whatsapp" in folded or "passar tudo para a edicleia" in folded)


def due_followup_stage(all_turns, state, thread_id, current_time=None):
    current = current_time or now()
    followup_since = parse_time(state.get("followup_since"))
    if not followup_since or not all_turns:
        return 0, None
    last_turn = all_turns[-1]
    if last_turn.get("role") != "ebv":
        return 0, None
    cust_turns = [t for t in all_turns if t.get("role") == "cliente" and t.get("text")]
    if not cust_turns:
        return 0, None
    last_cust = cust_turns[-1]
    if last_cust["at"] < followup_since:
        return 0, None
    if last_cust["from"] in set(state.get("qualified") or []):
        return 0, None
    if is_auto_greeting(last_cust.get("text")) or is_handoff_complete(last_turn.get("text")):
        return 0, None

    age_cust = current - last_cust["at"]
    age_ebv = current - last_turn["at"]
    if age_cust >= META_WINDOW_CAP or age_cust < timedelta(0) or age_ebv < timedelta(0):
        return 0, None

    entry = (state.get("followups") or {}).get(thread_id) or {}
    if entry.get("mid") != last_cust["id"]:
        entry = {"mid": last_cust["id"], "fu1_at": "", "fu2_at": ""}

    if not entry.get("fu2_at") and age_cust >= FOLLOWUP_2_AFTER and age_ebv >= FOLLOWUP_1_AFTER:
        return 2, last_cust
    if not entry.get("fu1_at") and age_ebv >= FOLLOWUP_1_AFTER and age_cust < timedelta(hours=19):
        return 1, last_cust
    return 0, None


def send_direct_bundle(token, recipient_id, reply, photos):
    for url in photos or []:
        photo_result, photo_status = request_json(
            GRAPH + "/me/messages",
            token,
            "POST",
            {"recipient": {"id": recipient_id}, "message": {"attachment": {"type": "image", "payload": {"url": url}}}},
        )
        if not (photo_result and photo_result.get("message_id")):
            print(f"direct photo_fail status={photo_status}", flush=True)
    result, send_status = request_json(
        GRAPH + "/me/messages",
        token,
        "POST",
        {"recipient": {"id": recipient_id}, "message": {"text": reply}},
    )
    return result, send_status


def cycle(token, state):
    body, status = request_json(
        GRAPH + "/me/conversations?fields=id,updated_time,messages.limit(15){id,message,from,created_time,referral}&limit=20",
        token,
    )
    if body is None:
        print(f"direct inbox_fail status={status}", flush=True)
        return
    since = parse_time(state.get("since")) or now()
    replied = set(state.get("replied") or [])
    failed = set(state.get("failed") or [])
    pending = set(state.get("pending") or [])
    seen = 0
    sent = 0
    skipped = 0
    properties = load_properties()
    print(f"direct catalog={len(properties)}", flush=True)
    current = now()
    for thread in body.get("data") or []:
        thread_id = str(thread.get("id") or "")
        updated = parse_time(thread.get("updated_time"))
        if updated and updated < since:
            continue
        all_turns = thread_turns(thread)
        turns = [item for item in all_turns if current - item["at"] <= WINDOW]
        fresh = [item for item in turns if item["role"] == "cliente" and item["at"] >= since and item.get("text")]
        if fresh:
            latest = fresh[-1]
            seen += 1
            if latest["id"] not in replied and latest["id"] not in failed and latest["id"] not in pending:
                if sent >= 3:
                    continue
                reply, photos, crm_lead, wa_summary = luna_reply(turns, properties)
                if not reply:
                    print("direct empty_reply", flush=True)
                    continue
                state.setdefault("pending", []).append(latest["id"])
                save_state(state)
                result, send_status = send_direct_bundle(token, latest["from"], reply, photos)
                if result and result.get("message_id"):
                    state.setdefault("replied", []).append(latest["id"])
                    if crm_lead:
                        state.setdefault("qualified", []).append(latest["from"])
                    save_state(state)
                    sent += 1
                    print("direct sent", flush=True)
                    if crm_lead or wa_summary:
                        push_crm_lead(latest["from"], crm_lead, wa_summary, turns, properties)
                else:
                    state.setdefault("failed", []).append(latest["id"])
                    save_state(state)
                    print(f"direct send_fail status={send_status}", flush=True)
                continue

        if sent >= 3 or not thread_id:
            if not fresh:
                skipped += len(turns)
            continue
        fu_stage, last_cust = due_followup_stage(all_turns, state, thread_id, current)
        if fu_stage and last_cust:
            fu_text = luna_followup(all_turns[-12:], properties, fu_stage)
            if not fu_text:
                print(f"direct followup_empty stage={fu_stage}", flush=True)
                continue
            entry = (state.get("followups") or {}).get(thread_id) or {}
            if entry.get("mid") != last_cust["id"]:
                entry = {"mid": last_cust["id"], "fu1_at": "", "fu2_at": ""}
            key = "fu1_at" if fu_stage == 1 else "fu2_at"
            entry[key] = stamp(current)
            state.setdefault("followups", {})[thread_id] = entry
            save_state(state)
            result, send_status = request_json(
                GRAPH + "/me/messages",
                token,
                "POST",
                {"recipient": {"id": last_cust["from"]}, "message": {"text": fu_text}},
            )
            if result and result.get("message_id"):
                sent += 1
                print(f"direct followup_sent stage={fu_stage}", flush=True)
            else:
                print(f"direct followup_fail stage={fu_stage} status={send_status}", flush=True)
        elif not fresh:
            skipped += len(turns)
    print(f"direct seen={seen} sent={sent} skipped={skipped}", flush=True)


def main():
    token = read_token()
    state = load_state()
    print(f"direct on since={state.get('since')} followup_since={state.get('followup_since')}", flush=True)
    while True:
        try:
            cycle(token, state)
        except Exception as err:
            print(f"direct error {type(err).__name__}", flush=True)
        time.sleep(45)


if __name__ == "__main__":
    main()
