import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import direct_loop as dl


SAMPLE_CATALOG = [
    {
        "id": "prop-1792252762995",
        "title": "Lindo Triplex 220 m2 com 3 Quartos/1 Suíte | Excelente Localização | A 50m de Panificadora, Farmácias e Restaurantes | Uberaba de Cima | Curitiba/PR | Entrada + Financiamento",
        "status": "venda",
        "type": "sobrado",
        "price": 1190000,
        "location": "Uberaba",
        "address": "R. Julio Wischral, 993, sobrado 02 - Uberaba",
        "area": 220,
        "beds": 3,
        "baths": 3,
        "vagas": 3,
        "image": "/media/photos/2026/10/93e26a65-5bec-4ba4-a2ae-db78bad03919.jpg",
        "images": [
            "/media/photos/2026/10/93e26a65-5bec-4ba4-a2ae-db78bad03919.jpg",
            "/media/photos/2026/10/1ed3c9f4-df4b-4fb6-a383-4ad0c6fbdb2f.jpg",
            "/media/photos/2026/10/f3917ac8-5092-4d64-ab66-d6fd179f10c6.jpg",
        ],
    },
    {
        "id": "prop-default-jba-2",
        "title": "Apartamento 59 m² Condomínio Clube | Boa Vista",
        "status": "venda",
        "type": "apartamento",
        "price": 563000,
        "location": "Boa Vista",
        "area": 59,
        "beds": 2,
        "baths": 1,
        "vagas": 1,
    },
]

AD_BUTTON_TEXTS = (
    "Quero o endereço do Triplex no Uberaba de Cima",
    "Quero mais fotos do Triplex 220 m² no Uberaba",
    "Quero saber condições e agendar visita no Triplex do Uberaba",
)


class DirectLoopTests(unittest.TestCase):
    def test_public_line_includes_approved_address_with_993_and_official_url(self):
        line = dl.public_line(SAMPLE_CATALOG[0])
        self.assertIn("Rua Júlio Wischral, 993", line)
        self.assertIn("Uberaba de Cima", line)
        self.assertIn("Panificadora Akipão", line)
        self.assertIn("https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995", line)
        self.assertNotIn("sobrado 02", line.lower())

    def test_sanitize_preserves_official_urls_and_blocks_media_third_party_loose_codes_and_sobrado_02(self):
        self.assertEqual(
            dl.sanitize(
                "Veja no site: https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995 "
                "ou chame no https://wa.me/5541988024346?text=Oi%20Edicleia. Quer saber mais?"
            ),
            "Veja no site:\n\nhttps://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995\n\n"
            "ou chame no\n\nhttps://wa.me/5541988024346?text=Oi%20Edicleia\n\nQuer saber mais?",
        )
        self.assertEqual(
            dl.sanitize("Rua Júlio Wischral, 993, sobrado 02, foto https://ebvimoveiscuritiba.com.br/media/photos/a.jpg e https://outrosite.com/x"),
            "Rua Júlio Wischral, 993, foto e",
        )
        self.assertEqual(dl.sanitize("O código é prop-1792252762995"), "")

    def test_links_go_alone_on_own_line_clickable_in_instagram(self):
        site = "https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995"
        cases = [
            "Mais detalhes em [site da EBV](https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995).",
            "Mais detalhes em ebvimoveiscuritiba.com.br/imovel/prop-1792252762995, é só abrir.",
            "Mais detalhes em www.ebvimoveiscuritiba.com.br/imovel/prop-1792252762995!",
            "Mais detalhes em (http://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995).",
            "Mais detalhes em <https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995>.",
        ]
        for raw in cases:
            out = dl.sanitize(raw)
            lines = out.splitlines()
            self.assertIn(site, lines, raw)
            i = lines.index(site)
            self.assertEqual(lines[i - 1], "", raw)
            if i + 1 < len(lines):
                self.assertEqual(lines[i + 1], "", raw)
            self.assertNotIn("](", out)
        # URL de imóvel nunca é bloqueada e o wa.me continua codificado (sem espaço).
        wa = dl.build_wa_link("Olá, Edicleia! Vim pelo Instagram e tenho interesse no Triplex (R$ 1.190.000).")
        self.assertNotIn(" ", wa)
        self.assertIn("%20", wa)
        self.assertIn(wa, dl.sanitize(f"Chame aqui: {wa}.").splitlines())
        # Corte por tamanho nunca deixa link pela metade.
        long_text = ("palavra " * 140) + site
        cut = dl.sanitize(long_text, max_bytes=1000)
        self.assertFalse(any(l.startswith("https://") and l != site for l in cut.splitlines()))

    def test_extract_crm_and_wa_link_work_together(self):
        raw = (
            "Perfeito! A Edicleia vai te chamar, ou você pode abrir direto abaixo. Ficou alguma dúvida?\n"
            "[[WA_RESUMO: Olá, Edicleia! Interesse no Triplex 220 m² no Uberaba de Cima (R$ 1.190.000). Sobrado 02.]]\n"
            "[[CRM_LEAD: {\"nome\":\"Ana Silva\",\"telefone\":\"\",\"objetivo\":\"morar\",\"orcamento\":\"financiamento\",\"imovel\":\"Triplex 220 m²\",\"resumo\":\"Quer visita\"}]]"
        )
        cleaned, crm = dl.extract_crm_lead(raw)
        self.assertIsInstance(crm, dict)
        self.assertEqual(crm["nome"], "Ana Silva")
        body, wa_link, wa_summary = dl.extract_wa_link(cleaned)
        self.assertEqual(body, "Perfeito! A Edicleia vai te chamar, ou você pode abrir direto abaixo. Ficou alguma dúvida?")
        self.assertTrue(wa_link.startswith("https://wa.me/5541988024346?text="))
        self.assertNotIn("sobrado", wa_link.lower())
        self.assertIn("Triplex", wa_summary)

    def test_extract_photo_tag_strips_tag_and_captures_hint(self):
        cleaned, hint = dl.extract_photo_tag("Seguem as fotos. O que achou? [[ENVIAR_FOTOS: Triplex]]")
        self.assertEqual(cleaned, "Seguem as fotos. O que achou?")
        self.assertEqual(hint, "Triplex")

    def test_ad_context_routes_buttons_and_greeting_but_not_generic_organic(self):
        # 1) Os 3 botões publicados do anúncio roteiam direto para o Triplex
        for btn in AD_BUTTON_TEXTS:
            turns = [{"role": "cliente", "text": btn, "referral": None}]
            self.assertTrue(dl.is_triplex_ad_context(turns), msg=f"Failed button: {btn}")
            self.assertIn("CONTEXTO DO ANÚNCIO DO TRIPLEX", dl.ad_note(turns))

        # 2) Saudação automática da Meta + resposta curta do lead também roteia para o Triplex
        meta_greeting = (
            "Olá! Que bom ver seu interesse no Triplex de 220 m² no Uberaba de Cima (R$ 1.190.000). "
            "Como posso te ajudar agora?"
        )
        turns_greeting = [
            {"role": "ebv", "text": meta_greeting, "referral": None},
            {"role": "cliente", "text": "Quero o endereço", "referral": None},
        ]
        self.assertTrue(dl.is_triplex_ad_context(turns_greeting))

        # 3) Mensagens orgânicas genéricas sem contexto do Triplex nem saudação da Meta NÃO são forçadas para o Triplex
        for generic in ("valor", "endereço", "fotos", "Oi, qual o valor?"):
            turns_generic = [{"role": "cliente", "text": generic, "referral": None}]
            self.assertFalse(dl.is_triplex_ad_context(turns_generic), msg=f"Should not force Triplex: {generic}")
            self.assertEqual(dl.ad_note(turns_generic), "")

        boa_vista = [{"role": "cliente", "text": "Tem apartamento no Boa Vista?", "referral": None}]
        self.assertFalse(dl.is_triplex_ad_context(boa_vista))

        with_ref = [
            {
                "role": "cliente",
                "text": "Oi",
                "referral": {"ads_context_data": {"ad_title": "Triplex 220 m² Uberaba de Cima"}},
            }
        ]
        self.assertIn("Triplex 220 m² Uberaba de Cima", dl.ad_note(with_ref))

    def test_followup_schedule_strictly_inside_24h_and_skips_old_leads(self):
        base = datetime(2026, 11, 21, 12, 0, 0, tzinfo=timezone.utc)
        state = {
            "followup_since": dl.stamp(base),
            "followups": {},
            "qualified": [],
        }
        old_turns = [
            {"id": "c0", "from": "u0", "role": "cliente", "text": "Endereço", "at": base - timedelta(hours=2)},
            {"id": "e0", "from": "ebv", "role": "ebv", "text": "Fica na Rua Júlio Wischral, 993?", "at": base - timedelta(hours=1)},
        ]
        stage, _ = dl.due_followup_stage(old_turns, state, "t-old", base + timedelta(hours=4))
        self.assertEqual(stage, 0)

        new_turns = [
            {"id": "c1", "from": "u1", "role": "cliente", "text": "Endereço", "at": base + timedelta(minutes=1)},
            {"id": "e1", "from": "ebv", "role": "ebv", "text": "Fica na Rua Júlio Wischral, 993, o que achou?", "at": base + timedelta(minutes=2)},
        ]
        self.assertEqual(dl.due_followup_stage(new_turns, state, "t1", base + timedelta(hours=2))[0], 0)
        self.assertEqual(dl.due_followup_stage(new_turns, state, "t1", base + timedelta(hours=3, minutes=5))[0], 1)

        state["followups"]["t1"] = {"mid": "c1", "fu1_at": dl.stamp(base + timedelta(hours=3, minutes=5)), "fu2_at": ""}
        self.assertEqual(dl.due_followup_stage(new_turns, state, "t1", base + timedelta(hours=10))[0], 0)
        self.assertEqual(dl.due_followup_stage(new_turns, state, "t1", base + timedelta(hours=20, minutes=5))[0], 2)
        self.assertEqual(dl.due_followup_stage(new_turns, state, "t1", base + timedelta(hours=23, minutes=45))[0], 0)

        state["skip_followup"] = ["u1"]
        self.assertEqual(dl.due_followup_stage(new_turns, state, "t1", base + timedelta(hours=20, minutes=5))[0], 0)

        phone_turns = [
            {"id": "c2", "from": "u2", "role": "cliente", "text": "+5541998952095", "at": base + timedelta(minutes=1)},
            {"id": "e2", "from": "ebv", "role": "ebv", "text": "Obrigado, encaminhei para a corretora!", "at": base + timedelta(minutes=2)},
        ]
        self.assertEqual(dl.due_followup_stage(phone_turns, state, "t2", base + timedelta(hours=4))[0], 0)

        local_phone_turns = [
            {"id": "c3", "from": "u3", "role": "cliente", "text": "99873-2272", "at": base + timedelta(minutes=1)},
            {"id": "e3", "from": "ebv", "role": "ebv", "text": "Obrigado, encaminhei para a corretora!", "at": base + timedelta(minutes=2)},
        ]
        self.assertEqual(dl.due_followup_stage(local_phone_turns, state, "t3", base + timedelta(hours=4))[0], 0)

    def test_phone_detection_ignores_property_ids_and_prices(self):
        self.assertEqual(dl.extract_phone("+5541998952095"), "41998952095")
        self.assertEqual(dl.extract_phone("Meu whats é (41) 99895-2095"), "41998952095")
        self.assertEqual(dl.extract_phone("Veja https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995 por R$ 1.190.000"), "")
        self.assertTrue(dl.lead_has_phone([{"role": "cliente", "text": "+5541998952095"}]))

    def test_instagram_profile_and_crm_sync_payload(self):
        state = {"profiles": {}, "synced": {}, "qualified": []}
        thread = {"id": "thread1", "updated_time": "2026-11-23T12:00:00+0000", "participants": {"data": [
            {"id": "17841448438742197", "username": "ebvimoveiscuritiba"},
            {"id": "1146800138099503", "username": "elisangelaa.moreira"},
        ]}}
        with mock.patch.object(dl, "request_json", return_value=({"id": "1146800138099503", "username": "elisangelaa.moreira", "name": "Elisangela Moreira"}, 200)):
            profile = dl.instagram_profile(thread, "token", state)
        self.assertEqual(profile["name"], "Elisangela Moreira")
        turns = [{"id": "m1", "role": "cliente", "text": "99873-2272", "at": datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)}]
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        with mock.patch.object(dl, "read_agent_token", return_value="a" * 32), mock.patch.object(dl.urllib.request, "urlopen", return_value=response) as opened, mock.patch.object(dl, "save_state"):
            self.assertTrue(dl.sync_crm_thread(thread, turns, profile, SAMPLE_CATALOG, state, force=True))
        payload = json.loads(opened.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(payload["username"], "elisangelaa.moreira")
        self.assertEqual(payload["profileName"], "Elisangela Moreira")
        self.assertEqual(payload["phone"], "41998732272")
        self.assertTrue(payload["qualified"])

    def test_crm_sync_marks_visit_from_customer_history(self):
        state = {"profiles": {}, "synced": {}, "qualified": []}
        thread = {"id": "thread2", "updated_time": "2026-11-23T12:00:00+0000"}
        profile = {"id": "1888631988796569", "username": "eduardotourinhogomes", "name": "Eduardo Tourinho Gomes"}
        turns = [
            {"id": "m1", "role": "cliente", "text": "Quero saber condições e agendar visita no Triplex do Uberaba", "at": datetime(2026, 11, 22, 21, 42, tzinfo=timezone.utc)},
            {"id": "m2", "role": "cliente", "text": "+5541998952095", "at": datetime(2026, 11, 23, 0, 28, tzinfo=timezone.utc)},
        ]
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        with mock.patch.object(dl, "read_agent_token", return_value="a" * 32), mock.patch.object(dl.urllib.request, "urlopen", return_value=response) as opened, mock.patch.object(dl, "save_state"):
            self.assertTrue(dl.sync_crm_thread(thread, turns, profile, SAMPLE_CATALOG, state, force=True))
        payload = json.loads(opened.call_args.args[0].data.decode("utf-8"))
        self.assertTrue(payload["visitRequested"])
        self.assertEqual(payload["propertyId"], "prop-1792252762995")

    def test_local_curitiba_phone_without_area_code(self):
        self.assertEqual(dl.extract_phone("99873-2272"), "41998732272")
        self.assertEqual(dl.extract_phone("998732272"), "41998732272")
        self.assertEqual(dl.extract_phone("99873 2272"), "41998732272")
        self.assertEqual(dl.extract_phone("R$ 1.190.000 e prop-1792252762995"), "")

    def test_luna_reply_suppresses_wa_link_when_lead_already_sent_phone_and_sends_photos_once(self):
        turns_open = [{"role": "cliente", "text": "Quero o endereço do Triplex no Uberaba de Cima", "referral": None}]
        fake_open = (
            "Fica na Rua Júlio Wischral, 993, no Uberaba de Cima.\n\n"
            "• Valor: R$ 1.190.000\n• Aceita financiamento\n"
            "https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995\n"
            "Você gostaria de agendar uma visita para conhecer o Triplex?\n"
            "[[ENVIAR_FOTOS: Triplex]]"
        )
        with mock.patch.object(dl, "call_hermes", return_value=fake_open):
            reply, photos, crm, _ = dl.luna_reply(turns_open, SAMPLE_CATALOG, photos_sent=False)
        self.assertEqual(len(photos), 3)
        self.assertIn("• Valor: R$ 1.190.000", reply)
        self.assertIn("\n\nhttps://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995\n\n", reply)
        self.assertNotIn("wa.me", reply)
        self.assertIsNone(crm)

        turns_phone = [
            {"role": "ebv", "text": "Perfeito! Me passa seu nome completo e número de WhatsApp?"},
            {"role": "cliente", "text": "Eduardo Tourinho Gomes, +5541998952095"},
        ]
        fake_handoff = (
            "Perfeito, Eduardo! Acabei de encaminhar seu contato para a corretora Edicleia e ela já vai te chamar no WhatsApp. Obrigado!\n"
            "[[WA_RESUMO: Olá, Edicleia! Interesse no Triplex.]]\n"
            "[[CRM_LEAD: {\"nome\":\"Eduardo Tourinho Gomes\",\"telefone\":\"+5541998952095\",\"objetivo\":\"morar\",\"orcamento\":\"\",\"imovel\":\"Triplex 220 m²\",\"resumo\":\"Quer visita\"}]]"
        )
        with mock.patch.object(dl, "call_hermes", return_value=fake_handoff):
            reply2, photos2, crm2, _ = dl.luna_reply(turns_phone, SAMPLE_CATALOG, photos_sent=True)
        self.assertEqual(photos2, [])
        self.assertNotIn("wa.me", reply2)
        with mock.patch.object(dl, "call_hermes", return_value=fake_handoff.replace("Obrigado!", "Obrigado! https://wa.me/5541988024346")):
            reply2b, _, _, _ = dl.luna_reply(turns_phone, SAMPLE_CATALOG, photos_sent=True)
        self.assertNotIn("wa.me", reply2b)
        self.assertIsInstance(crm2, dict)
        self.assertEqual(crm2["nome"], "Eduardo Tourinho Gomes")

        turns_refusal = [
            {"role": "ebv", "text": "Me passa seu nome completo e número de WhatsApp?"},
            {"role": "cliente", "text": "Prefiro não passar meu número, pode mandar o seu WhatsApp?"},
        ]
        fake_refusal = (
            "Sem problemas! Você pode chamar a Edicleia direto pelo link abaixo:\n"
            "[[WA_RESUMO: Olá, Edicleia! Vim pelo Instagram com interesse no Triplex 220 m² no Uberaba de Cima (R$ 1.190.000).]]\n"
            "[[CRM_LEAD: {\"nome\":\"\",\"telefone\":\"\",\"objetivo\":\"morar\",\"orcamento\":\"\",\"imovel\":\"Triplex 220 m²\",\"resumo\":\"Preferiu chamar no WhatsApp\"}]]"
        )
        with mock.patch.object(dl, "call_hermes", return_value=fake_refusal):
            reply3, _, crm3, _ = dl.luna_reply(turns_refusal, SAMPLE_CATALOG, photos_sent=True)
        self.assertIn("https://wa.me/5541988024346?text=", reply3)
        self.assertIsInstance(crm3, dict)

    def test_luna_followup_stage_1_and_stage_2(self):
        turns = [
            {"role": "cliente", "text": "Quero saber condições e agendar visita no Triplex do Uberaba"},
            {"role": "ebv", "text": "O Triplex tem 220 m²... Você gostaria de agendar uma visita?"},
        ]
        with mock.patch.object(dl, "call_hermes", return_value="Oi! Ficou alguma dúvida sobre o Triplex no Uberaba de Cima ou o valor e as condições estão dentro do que você esperava? [[WA_RESUMO: teste]]"):
            fu1 = dl.luna_followup(turns, SAMPLE_CATALOG, stage=1)
        self.assertNotIn("wa.me", fu1)
        self.assertIn("dúvida", fu1.lower())

        with mock.patch.object(dl, "call_hermes", return_value="Oi! Se preferir, chame a corretora Edicleia direto no WhatsApp quando quiser:\n[[WA_RESUMO: Olá, Edicleia! Interesse no <imóvel>.]]"):
            fu2 = dl.luna_followup(turns, SAMPLE_CATALOG, stage=2)
        self.assertIn("https://wa.me/5541988024346?text=", fu2)
        self.assertTrue(fu2.splitlines()[-1].startswith("https://wa.me/5541988024346?text="))
        self.assertEqual(fu2.splitlines()[-2], "")
        self.assertNotIn(" ", fu2.splitlines()[-1])
        self.assertNotIn("%3C", fu2)
        self.assertIn("Triplex", fu2)

    def test_prompt_removes_morar_ou_investir_and_sets_complete_triplex_opening(self):
        prompt = dl.build_system_prompt([{"role": "cliente", "text": "Quero mais fotos do Triplex"}], SAMPLE_CATALOG)
        self.assertIn("SDR", prompt)
        self.assertIn("PROIBIDO FAZER PERGUNTAS VAZIAS", prompt)
        self.assertIn("Aceita apartamento como parte do pagamento (até 50% do valor)", prompt)
        self.assertIn("Imóvel averbado, documentação ok", prompt)
        self.assertIn("https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995", prompt)
        self.assertNotIn("1) Objetivo: pergunte se a busca é para morar ou investir", prompt)


if __name__ == "__main__":
    unittest.main()
