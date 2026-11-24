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
        "bairro_completo": "Uberaba de Cima (Jardim Santa Bárbara, Uberaba, pertinho do Jardim das Américas)",
        "endereco_publico": (
            "Rua Júlio Wischral, 993, no Uberaba de Cima, a uns 50 m da Panificadora Akipão, "
            "farmácias e restaurantes, e a uma quadra da Rua Capitão Leônidas Marques"
        ),
        "regra_complemento": (
            "O complemento específico da unidade dentro do lote só pode ser passado na confirmação da visita, "
            "porque o imóvel é habitado."
        ),
        "condicoes_aprovadas": (
            "Valor: R$ 1.190.000 | Aceita financiamento | "
            "Aceita apartamento como parte do pagamento (até 50% do valor) | "
            "Imóvel averbado, documentação ok"
        ),
        "detalhes": (
            "220 m² em 3 andares, 3 quartos (sendo 1 suíte com closet e porta panorâmica), "
            "sala de estar com lareira, sala de jantar para até 8 pessoas, espaço gourmet com cobertura em vidro temperado e deck de itaúba, "
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
        if "photos_sent" not in state or not isinstance(state.get("photos_sent"), list):
            state["photos_sent"] = []
            changed = True
        if "profiles" not in state or not isinstance(state.get("profiles"), dict):
            state["profiles"] = {}
            changed = True
        if "synced" not in state or not isinstance(state.get("synced"), dict):
            state["synced"] = {}
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
        "photos_sent": [],
        "profiles": {},
        "synced": {},
    }
    save_state(state)
    return state


def save_state(state):
    state["replied"] = state.get("replied", [])[-400:]
    state["failed"] = state.get("failed", [])[-200:]
    state["pending"] = state.get("pending", [])[-200:]
    state["qualified"] = state.get("qualified", [])[-300:]
    state["photos_sent"] = state.get("photos_sent", [])[-300:]
    state["profiles"] = dict(list((state.get("profiles") or {}).items())[-300:])
    state["synced"] = dict(list((state.get("synced") or {}).items())[-300:])
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


def normalize_whitespace(text):
    lines = []
    blank = False
    for raw_line in str(text or "").splitlines():
        line = " ".join(raw_line.split())
        if line:
            lines.append(line)
            blank = False
        elif lines and not blank:
            lines.append("")
            blank = True
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def strip_urls(text):
    def _keep_or_drop(match):
        token = match.group(0)
        trimmed = token.rstrip(".,;:!?)]}>\"'`”’*_")
        suffix = token[len(trimmed):]
        normalized = full_url(trimmed)
        if is_allowed_url(normalized):
            return normalized + suffix
        return " "

    value = str(text or "")
    # Markdown [texto](url) não vira link no Instagram: deixa só "texto" e a URL pura.
    value = re.sub(r"\[([^\]\n]{1,120})\]\(\s*([^)\s]+)\s*\)", r"\1 \2", value)
    value = re.sub(r"<((?:https?://|www\.|wa\.me/)[^>\s]+)>", r"\1", value, flags=re.IGNORECASE)
    cleaned = re.sub(
        r"(?:https?://|www\.|wa\.me/|ebvimoveiscuritiba\.com\.br\b)\S*",
        _keep_or_drop,
        value,
        flags=re.IGNORECASE,
    )
    return normalize_whitespace(cleaned)


def full_url(raw):
    value = str(raw or "").strip()
    if re.match(r"https?://", value, flags=re.IGNORECASE):
        return re.sub(r"^http://", "https://", value, flags=re.IGNORECASE)
    if value.lower().startswith("www."):
        value = value[4:]
    return "https://" + value


URL_LINE_RE = re.compile(r"https://\S+")


def isolate_urls(text):
    """No app do Instagram, link no meio da frase ou com pontuação colada costuma não ficar
    clicável. Cada URL vai sozinha numa linha, com uma linha em branco antes e depois."""
    out = []
    for line in str(text or "").splitlines():
        if not URL_LINE_RE.search(line):
            out.append(line)
            continue
        pos = 0
        for match in URL_LINE_RE.finditer(line):
            before = line[pos:match.start()].strip()
            url = match.group(0)
            trimmed = url.rstrip(".,;:!?)]}>\"'`”’*_")
            if before:
                out.append(before.rstrip(" :–—-") + (":" if before.rstrip().endswith(":") else ""))
            out.extend(["", trimmed, ""])
            pos = match.start() + len(trimmed)
        after = line[pos:].strip().lstrip(".,;:!?)]}>\"'`”’*_ ").strip()
        if after:
            out.append(after)
    return normalize_whitespace("\n".join(out))


def drop_wa_links(text):
    cleaned = re.sub(rf"https://wa\.me/{EDICLEIA_WA}\S*", " ", str(text or ""), flags=re.IGNORECASE)
    return normalize_whitespace(cleaned)


def mask_private_unit(text):
    value = str(text or "")
    value = re.sub(r",?\s*\bsobrado\s*0?2\b", "", value, flags=re.IGNORECASE)
    value = re.sub(r"[ \t]+,", ",", value)
    value = re.sub(r",\s*,+", ",", value)
    lines = [line.strip(" ,") if line.strip() else "" for line in value.splitlines()]
    return normalize_whitespace("\n".join(lines))


def without_official_urls(text):
    cleaned = re.sub(r"https://ebvimoveiscuritiba\.com\.br/[^\s)>\"]*", " ", str(text or ""), flags=re.IGNORECASE)
    cleaned = re.sub(rf"https://wa\.me/{EDICLEIA_WA}(?:\?[^\s)>\"]*)?", " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def extract_phone(text):
    cleaned = re.sub(r"\bprop-[\w-]+\b", " ", without_official_urls(text), flags=re.IGNORECASE)
    cleaned = re.sub(r"R\$\s*\d[\d.,]*", " ", cleaned, flags=re.IGNORECASE)
    for match in re.finditer(r"(?:\+?55[\s.-]*)?(?:\(?\d{2}\)?[\s.-]*)(?:9[\s.-]*)?\d{4}[\s.-]?\d{4}\b", cleaned):
        digits = re.sub(r"\D", "", match.group(0)).lstrip("0")
        if len(digits) in (12, 13) and digits.startswith("55"):
            digits = digits[2:]
        if len(digits) in (10, 11):
            return digits
    mobile = re.search(r"\b9\d{4}[-\s]?\d{4}\b", cleaned)
    if mobile:
        return "41" + re.sub(r"\D", "", mobile.group(0))
    local = re.search(r"\b\d{4}[-\s]?\d{4}\b", cleaned)
    if local:
        return "41" + re.sub(r"\D", "", local.group(0))
    return ""


def lead_has_phone(turns, crm_lead=None):
    if isinstance(crm_lead, dict):
        tel = re.sub(r"\D", "", str(crm_lead.get("telefone") or ""))
        if len(tel) >= 8:
            return True
    for turn in turns or []:
        if turn.get("role") == "cliente" and extract_phone(turn.get("text")):
            return True
    return False


def visit_request_from_turns(turns):
    patterns = (
        r"\b(?:agendar|marcar)\s+(?:uma\s+)?visita\b",
        r"\b(?:quero|gostaria|podemos|posso)\b.{0,48}\b(?:visitar|visita|conhecer)\b",
    )
    for turn in reversed(turns or []):
        if turn.get("role") != "cliente":
            continue
        text = fold(turn.get("text"))
        if any(re.search(pattern, text) for pattern in patterns):
            when = re.search(
                r"\b(?:hoje|amanha|segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado|domingo)(?:\s+(?:as\s+)?\d{1,2}(?::\d{2})?h?)?\b",
                text,
            )
            return {"requested": True, "when": when.group(0) if when else ""}
    return {"requested": False, "when": ""}


def sanitize(text, max_bytes=950):
    value = strip_urls(text)
    value = re.sub(r"(?<!/imovel/)\bprop-[\w-]+\b", "", value, flags=re.IGNORECASE)
    value = mask_private_unit(value)
    value = normalize_whitespace(value).strip().strip("\"'`“”")
    if not value:
        return ""
    outside = without_official_urls(value).lower()
    if "prop-" in outside or "código" in outside or "codigo" in outside:
        return ""
    value = isolate_urls(value)
    full_lines = set(value.splitlines())
    raw = value.encode("utf-8")
    if len(raw) > max_bytes:
        partial = raw[:max_bytes].decode("utf-8", "ignore")
        parts = re.split(r"\s+(?=\S*$)", partial)
        value = (parts[0] if len(parts) > 1 else partial).strip()
        # Nunca deixar um link cortado pela metade no fim da mensagem.
        lines = value.splitlines()
        if lines and URL_LINE_RE.match(lines[-1]) and lines[-1] not in full_lines:
            lines.pop()
        value = normalize_whitespace("\n".join(lines))
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
    if extra.get("condicoes_aprovadas"):
        bits.append("condições aprovadas: " + extra["condicoes_aprovadas"])
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
    if "código" in folded or "codigo" in folded or "<" in clean or ">" in clean:
        return f"https://wa.me/{EDICLEIA_WA}"
    if len(clean) > 280:
        clean = clean[:280].rsplit(" ", 1)[0].strip()
    # Ponto, hífen, sublinhado e til ficam codificados: assim a URL nunca termina em
    # pontuação, que o Instagram corta do link.
    encoded = urllib.parse.quote(clean, safe="")
    encoded = encoded.replace(".", "%2E").replace("-", "%2D").replace("_", "%5F").replace("~", "%7E")
    return f"https://wa.me/{EDICLEIA_WA}?text={encoded}"


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
        return AGENT_TOKEN_FILE.read_text(encoding="utf-8-sig").lstrip("\ufeff").strip()
    return ""


def instagram_profile(thread, token, state):
    participants = ((thread.get("participants") or {}).get("data") or [])
    person = next((p for p in participants if str(p.get("id") or "") not in OWN), {})
    external_id = str(person.get("id") or "")
    cached = (state.get("profiles") or {}).get(external_id) or {}
    username = str(person.get("username") or cached.get("username") or "").strip().lstrip("@")
    name = str(cached.get("name") or "").strip()
    if external_id and (not username or not name):
        profile, status = request_json(GRAPH + "/" + external_id + "?fields=id,username,name", token)
        if status == 200 and isinstance(profile, dict):
            username = str(profile.get("username") or username).strip().lstrip("@")
            name = str(profile.get("name") or name).strip()
            state.setdefault("profiles", {})[external_id] = {"username": username, "name": name}
    return {"id": external_id, "username": username, "name": name}


def sync_crm_thread(thread, turns, profile, properties, state, force=False):
    external_id = str(profile.get("id") or "")
    updated = str(thread.get("updated_time") or "")
    if not external_id or (not force and (state.get("synced") or {}).get(external_id) == updated):
        return True
    agent_token = read_agent_token()
    if not agent_token:
        return False
    phone = next((extract_phone(t.get("text")) for t in reversed(turns) if t.get("role") == "cliente" and extract_phone(t.get("text"))), "")
    chat_blob = " ".join(str(t.get("text") or "") for t in turns)
    prop = match_property_from_text(chat_blob, properties)
    if not prop and is_triplex_ad_context(turns):
        prop = next((p for p in (properties or []) if p.get("id") == ACTIVE_AD_PROPERTY_ID), None)
    visit = visit_request_from_turns(turns)
    payload = {
        "externalId": external_id,
        "username": profile.get("username") or "",
        "profileName": profile.get("name") or "",
        "phone": phone,
        "qualified": bool(phone or external_id in set(state.get("qualified") or [])),
        "propertyId": str(prop.get("id") or "") if prop else "",
        "propertyTitle": short_title(prop.get("title")) if prop else "",
        "adTitle": ad_title_from(turns),
        "visitRequested": visit["requested"],
        "visitWhen": visit["when"],
        "messages": [{
            "externalMid": t.get("id") or "",
            "direction": "out" if t.get("role") == "ebv" else "in",
            "body": t.get("text") or "",
            "createdAt": stamp(t.get("at")),
        } for t in turns if t.get("text")],
    }
    req = urllib.request.Request(
        SITE + "/api/agent/direct-sync",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Authorization": "Bearer " + agent_token, "Content-Type": "application/json", "User-Agent": CATALOG_UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            json.loads(res.read().decode("utf-8"))
        state.setdefault("synced", {})[external_id] = updated
        save_state(state)
        return True
    except urllib.error.HTTPError as err:
        print(f"direct sync_fail status={err.code}", flush=True)
    except Exception as err:
        print(f"direct sync_fail {type(err).__name__}", flush=True)
    return False


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


def build_system_prompt(turns, properties, photos_sent=False):
    lines = [public_line(prop) for prop in properties or []]
    lines = [line for line in lines if line]
    if lines:
        facts = "\n".join(f"- {line}" for line in lines)
    else:
        facts = "- O catálogo não carregou nesta tentativa. Não afirme que um bairro está sem imóvel."
    origin = ad_note(turns)
    chat = transcript(turns) or "Cliente: (sem texto)"
    index = stock_index(properties) or "- cadastro sem imóveis nesta leitura"
    photos_flag = "SIM" if photos_sent else "NÃO"
    return (
        "Você atua como pré-atendimento comercial (SDR) da corretora Edicleia Borba Vieira no Instagram Direct da EBV Imóveis Curitiba. "
        "Português do Brasil, natural, direto e acolhedor.\n"
        "SUA MISSÃO DE PRÉ-VENDA (SDR):\n"
        "- Entregar de imediato o que o lead pediu com clareza e conduzir a conversa para o agendamento da visita, "
        "coletando nome completo e número de WhatsApp para a corretora Edicleia assumir o atendimento.\n"
        "REGRAS INEGOCIÁVEIS:\n"
        "- NUNCA pergunte se a pessoa busca o imóvel para 'morar ou investir' (nem na abertura, nem no meio, nem em follow-up). No Triplex o público compra para morar.\n"
        "- PROIBIDO FAZER PERGUNTAS VAZIAS: nunca pergunte 'O que você achou?', 'O que achou dessas fotos/localização?', "
        "'Gostaria de ver algum outro detalhe?', 'O que mais gostaria de ver?' ou 'Você já conhece essa região?'.\n"
        "- Não diga que é inteligência artificial. Não invente imóvel, preço, metragem, disponibilidade, condições de pagamento ou benefícios fora do cadastro.\n"
        "- Nunca prometa algo que não esteja no cadastro (não prometa vídeo). Nunca escreva código prop- solto fora da URL oficial do site. Não peça documento, CPF ou RG.\n"
        "- Nunca comece com 'Claro!' seguido de recusa (ex: nunca diga 'Por aqui não envio links').\n"
        "- NUNCA passe o complemento 'sobrado 02' antes de a visita estar confirmada (explique que só é passado na confirmação da visita porque o imóvel é habitado).\n"
        "- Faça no máximo UMA pergunta objetiva no final da mensagem (terminando com '?'), EXCETO no fechamento final após o cliente já ter enviado o WhatsApp (que pode encerrar agradecendo e confirmando o contato da Edicleia).\n"
        f"ESTADO DAS FOTOS NESTA CONVERSA: FOTOS JÁ ENVIADAS = {photos_flag}.\n"
        "FLUXO EXATO DO TRIPLEX (Uberaba de Cima, R$ 1.190.000):\n"
        "1) ABERTURA / PRIMEIRA RESPOSTA COMPLETA DO TRIPLEX (quando o lead vier por qualquer botão do anúncio do Triplex — endereço, fotos ou condições — ou perguntar do Triplex pela primeira vez sem ter recebido a apresentação completa ainda):\n"
        "   - Responda diretamente ao que o lead pediu logo na primeira frase (se pediu endereço, comece informando: "
        "'Rua Júlio Wischral, 993, no Uberaba de Cima, a uns 50 m da Panificadora Akipão, farmácias e restaurantes, e a uma quadra da Rua Capitão Leônidas Marques', mantendo 'sobrado 02' retido).\n"
        "   - E na MESMA resposta entregue a apresentação completa do Triplex (seja objetivo para caber em até ~820 caracteres):\n"
        "     a) Fotos: se FOTOS JÁ ENVIADAS = NÃO, inclua [[ENVIAR_FOTOS: Triplex]] na última linha (as 3 fotos serão enviadas antes do texto). Se FOTOS JÁ ENVIADAS = SIM, não repita a tag.\n"
        "     b) Introdução: 220 m² em 3 andares, 3 quartos (sendo 1 suíte), espaço gourmet com deck e garagem para 3 carros, no Uberaba de Cima, pertinho do Jardim das Américas.\n"
        "     c) Condições e valor em tópicos curtos:\n"
        "        • Valor: R$ 1.190.000\n"
        "        • Aceita financiamento\n"
        "        • Aceita apartamento como parte do pagamento (até 50% do valor)\n"
        "        • Imóvel averbado, documentação ok\n"
        "     d) Link do site para mais informações, com a URL completa SOZINHA numa linha própria (linha em branco antes e depois, sem Markdown, sem pontuação colada no fim):\n"
        "        Mais fotos e detalhes no site:\n\n"
        "        https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995\n\n"
        "     e) Pergunta final: 'Você gostaria de agendar uma visita para conhecer o Triplex?'\n"
        "   - NÃO repita a saudação automática da Meta ('Olá! Que bom ver seu interesse...').\n"
        "2) TURNOS SEGUINTES / DÚVIDAS ESPECÍFICAS:\n"
        "   - Se nos turnos seguintes o lead fizer outra pergunta específica (ex.: permuta, quartos, localização, financiamento), responda de acordo com o contexto usando o cadastro, sem repetir o bloco inteiro da apresentação nem reenviar fotos já enviadas, e conduza para o agendamento da visita (ou peça nome completo e WhatsApp se já tiver topado visitar).\n"
        "   - Se for corretor/corretora buscando parceria, registre no resumo e pergunte se já tem cliente interessado e qual o perfil/contato para a Edicleia alinhar.\n"
        "3) SE O LEAD DISSER SIM (QUER AGENDAR VISITA / AVANÇAR):\n"
        "   - Peça o nome completo e o número de WhatsApp para a corretora Edicleia agendar a visita (ex.: 'Perfeito! Para a corretora Edicleia agendar sua visita, me passa seu nome completo e número de WhatsApp?').\n"
        "   - Se o lead já passou apenas um deles (ex.: já disse o nome, falta o WhatsApp), peça o que falta.\n"
        "4) SE O LEAD JÁ ENVIOU O NÚMERO DE WHATSAPP DELA:\n"
        "   - NUNCA envie o link wa.me/5541988024346! Como a pessoa já deixou o número dela, nós é que vamos entrar em contato.\n"
        "   - Agradeça pelo nome (se houver) e confirme que o contato já foi encaminhado para a corretora Edicleia e que ela vai chamar no WhatsApp logo em seguida para agendar a visita (ex.: 'Perfeito, [Nome]! Acabei de encaminhar seu contato para a corretora Edicleia e ela já vai te chamar no WhatsApp para alinhar a sua visita. Obrigado!').\n"
        "   - Adicione na última linha APENAS a tag [[CRM_LEAD: ...]] (SEM [[WA_RESUMO: ...]] e SEM link wa.me):\n"
        "     [[CRM_LEAD: {\"nome\":\"<nome completo ou nome do perfil>\",\"telefone\":\"<whatsapp informado>\",\"objetivo\":\"<morar|vender|avaliar>\",\"orcamento\":\"<condições ou vazio>\",\"imovel\":\"<nome/bairro/valor do imóvel>\",\"resumo\":\"<resumo curto da conversa e interesse na visita>\"}]]\n"
        "5) LINK DO WHATSAPP DA EBV (EXCEÇÃO ÚNICA):\n"
        "   - Só envie [[WA_RESUMO: ...]] (que gera https://wa.me/5541988024346?text=...) se o cliente preferir NÃO informar o próprio número de telefone na etapa de contato ou pedir explicitamente o link do WhatsApp da EBV para ele mesmo chamar.\n"
        "   - Nesse caso de recusa de telefone, envie:\n"
        "     [[WA_RESUMO: Olá, Edicleia! Vim pelo Instagram com interesse no <imóvel com bairro e valor>. Nome: <nome ou não informado>. <resumo>.]]\n"
        "     [[CRM_LEAD: {\"nome\":\"<nome ou vazio>\",\"telefone\":\"\",\"objetivo\":\"<morar|vender|avaliar>\",\"orcamento\":\"<detalhes>\",\"imovel\":\"<imóvel>\",\"resumo\":\"<resumo curto>\"}]]\n"
        "CONTEXTO DE OUTROS IMÓVEIS E MENSAGENS ORGÂNICAS:\n"
        "- Se citar outro bairro do resumo abaixo, fale dos imóveis daquele bairro seguindo a mesma lógica (dados do cadastro + link do site + convite para visita / nome e WhatsApp).\n"
        "- Se for uma mensagem orgânica genérica sem contexto de imóvel nem saudação prévia do Triplex (ex.: apenas 'valor', 'endereço', 'fotos'), não presuma o Triplex: pergunte qual imóvel ou bairro a pessoa procura.\n\n"
        f"{origin}\n"
        f"Resumo por bairro, fonte do cadastro:\n{index}\n\n"
        f"Catálogo:\n{facts}\n\n"
        f"Conversa:\n{chat}\n\n"
        "Escreva só a próxima mensagem da EBV (sem URLs de /media/ no texto)."
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


def has_real_ebv_reply(turns):
    return any(
        t.get("role") == "ebv" and t.get("text") and not is_auto_greeting(t.get("text"))
        for t in (turns or [])
    )


def luna_reply(turns, properties, photos_sent=False):
    prompt = build_system_prompt(turns, properties, photos_sent=photos_sent)
    stdout = call_hermes(prompt)
    if not stdout:
        return "", [], None, ""
    allowed = {url for prop in properties or [] for _label, url in chosen_shots(prop)}
    raw_reply, crm_lead = extract_crm_lead(stdout)
    raw_reply, wa_link, wa_summary = extract_wa_link(raw_reply)
    raw_reply, photo_hint = extract_photo_tag(raw_reply)
    text, photos = take_photos(raw_reply, allowed)
    last_cust_text = fold(next((t.get("text") for t in reversed(turns or []) if t.get("role") == "cliente" and t.get("text")), ""))
    asked_photos = any(k in last_cust_text for k in ("foto", "fotos", "imagem", "imagens"))
    if not photos and (photo_hint or "[[ENVIAR_FOTOS" in stdout.upper() or (not photos_sent and is_triplex_ad_context(turns) and not has_real_ebv_reply(turns))):
        prop = match_property_from_text(photo_hint, properties)
        if not prop:
            chat_blob = " ".join(str(t.get("text") or "") for t in (turns or []))
            prop = match_property_from_text(chat_blob, properties)
        if not prop and is_triplex_ad_context(turns):
            prop = next((p for p in (properties or []) if p.get("id") == ACTIVE_AD_PROPERTY_ID), None)
        if prop:
            photos = [url for _label, url in chosen_shots(prop)][:3]
    if photos_sent and not asked_photos:
        photos = []
    has_phone = lead_has_phone(turns, crm_lead)
    ebv_asked_phone = any(
        turn.get("role") == "ebv"
        and any(w in fold(turn.get("text")) for w in ("whatsapp", "telefone", "numero"))
        for turn in (turns or [])
    )
    wants_our_wa = any(k in last_cust_text for k in (
        "seu whats", "whats da", "whatsapp da", "contato da corretora", "numero da",
        "link do whats", "nao quero passar", "prefiro nao passar", "prefiro nao informar",
        "sem telefone", "prefiro chamar", "eu chamo", "manda o seu", "passa o seu",
    ))
    if has_phone or not (ebv_asked_phone or wants_our_wa):
        wa_link = ""
    budget = 950 - (len(wa_link.encode("utf-8")) + 2 if wa_link else 0)
    body = sanitize(text, max_bytes=max(350, budget))
    if has_phone:
        body = drop_wa_links(body)
    if not body:
        return "", photos, None, ""
    if wa_link:
        return f"{body}\n\n{wa_link}", photos, crm_lead, wa_summary
    return body, photos, crm_lead, wa_summary


def luna_followup(turns, properties, stage):
    chat = transcript(turns) or "Cliente: (sem texto)"
    origin = ad_note(turns)
    triplex_ctx = is_triplex_ad_context(turns)
    chat_blob = " ".join(str(t.get("text") or "") for t in (turns or []))
    matched = match_property_from_text(chat_blob, properties)
    if not matched and triplex_ctx:
        matched = next((p for p in (properties or []) if p.get("id") == ACTIVE_AD_PROPERTY_ID), None)
    prop_label = (
        "Triplex 220 m² no Uberaba de Cima (R$ 1.190.000)"
        if (matched and matched.get("id") == ACTIVE_AD_PROPERTY_ID) or triplex_ctx
        else (f"{short_title(matched.get('title'))} ({brl(matched.get('price'))})".strip(" ()") if matched else "imóvel da EBV")
    )
    if stage == 1:
        goal = (
            "Envie o 1º lembrete curto, educado e natural (~3h sem resposta do cliente), retomando o imóvel da conversa "
            "(se for o Triplex no Uberaba de Cima, cite o Triplex no Uberaba de Cima) e perguntando se ficou alguma dúvida "
            "sobre o imóvel e se o valor e as condições estão dentro do que ele esperava "
            "(ex.: 'Oi, [Nome]! Ficou alguma dúvida sobre o Triplex no Uberaba de Cima ou o valor e as condições estão dentro do que você esperava?'). "
            "NUNCA pergunte 'morar ou investir', não repita a mesma frase anterior e NÃO envie link wa.me."
        )
    else:
        goal = (
            "Envie o 2º lembrete gentil dentro da janela de 24h (~20h sem resposta), convidando o cliente a abrir uma mensagem "
            "direto com a corretora Edicleia no WhatsApp pelo link abaixo quando preferir. "
            "NUNCA pergunte 'morar ou investir' e NÃO use colchetes ou sinais < > no resumo. "
            "Na última linha, inclua exatamente:\n"
            f"[[WA_RESUMO: Olá, Edicleia! Vim pelo Instagram e tenho interesse no {prop_label}.]]"
        )
    prompt = (
        "Você atua como pré-atendimento comercial (SDR) da corretora Edicleia Borba Vieira no Instagram Direct da EBV Imóveis Curitiba.\n"
        f"{goal}\n"
        "REGRAS: Português do Brasil, máximo 2 frases, "
        "NUNCA pergunte 'morar ou investir', PROIBIDO perguntas vazias ('o que achou?', 'gostaria de ver algum outro detalhe?'), "
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
    raw_reply, wa_link, wa_summary = extract_wa_link(raw_reply)
    if stage == 1:
        wa_link = ""
    elif not wa_link or wa_link == f"https://wa.me/{EDICLEIA_WA}" or "<" in wa_summary or ">" in wa_summary:
        default_summary = (
            f"Olá, Edicleia! Vim pelo Instagram e tenho interesse no {prop_label}."
            if matched or triplex_ctx else
            "Olá, Edicleia! Vim pelo Instagram e gostaria de falar com você sobre um imóvel."
        )
        wa_link = build_wa_link(default_summary)
    budget = 750 - (len(wa_link.encode("utf-8")) + 2 if wa_link else 0)
    body = sanitize(raw_reply, max_bytes=max(320, budget))
    if not body:
        return ""
    if wa_link:
        return f"{body}\n\n{wa_link}"
    return body


def thread_turns(thread):
    messages = ((thread.get("messages") or {}).get("data") or [])
    found = []
    for msg in messages:
        sender = str((msg.get("from") or {}).get("id") or "")
        text = str(msg.get("message") or "").strip()
        created = parse_time(msg.get("created_time"))
        referral = msg.get("referral") if isinstance(msg.get("referral"), dict) else None
        atts = msg.get("attachments")
        has_photos = bool((atts.get("data") if isinstance(atts, dict) else atts))
        if not sender or not msg.get("id") or not created:
            continue
        if not text and not referral and not has_photos:
            continue
        found.append({
            "id": str(msg["id"]),
            "from": sender,
            "role": "ebv" if sender in OWN else "cliente",
            "text": text,
            "at": created,
            "referral": referral,
            "has_photos": has_photos,
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
    if last_cust["from"] in set(state.get("qualified") or []) or last_cust["from"] in set(state.get("skip_followup") or []):
        return 0, None
    if lead_has_phone(all_turns):
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
        GRAPH + "/me/conversations?fields=id,updated_time,participants,messages.limit(20){id,message,from,created_time,referral,attachments}&limit=20",
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
        profile = instagram_profile(thread, token, state)
        sync_crm_thread(thread, all_turns, profile, properties, state)
        turns = [item for item in all_turns if current - item["at"] <= WINDOW]
        fresh = [item for item in turns if item["role"] == "cliente" and item["at"] >= since and item.get("text")]
        photos_already_sent = (
            (thread_id in set(state.get("photos_sent") or []))
            or any(item.get("has_photos") for item in all_turns if item.get("role") == "ebv")
        )
        if fresh:
            latest = fresh[-1]
            seen += 1
            if latest["id"] not in replied and latest["id"] not in failed and latest["id"] not in pending:
                if sent >= 3:
                    continue
                reply, photos, crm_lead, wa_summary = luna_reply(turns, properties, photos_sent=photos_already_sent)
                if not reply:
                    print("direct empty_reply", flush=True)
                    continue
                state.setdefault("pending", []).append(latest["id"])
                save_state(state)
                result, send_status = send_direct_bundle(token, latest["from"], reply, photos)
                if result and result.get("message_id"):
                    state.setdefault("replied", []).append(latest["id"])
                    if photos and thread_id and thread_id not in (state.get("photos_sent") or []):
                        state.setdefault("photos_sent", []).append(thread_id)
                    if crm_lead or lead_has_phone(turns, crm_lead):
                        if latest["from"] not in (state.get("qualified") or []):
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
