import unittest
from datetime import datetime, timedelta, timezone

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
            "Veja no site: https://ebvimoveiscuritiba.com.br/imovel/prop-1792252762995 "
            "ou chame no https://wa.me/5541988024346?text=Oi%20Edicleia. Quer saber mais?",
        )
        self.assertEqual(
            dl.sanitize("Rua Júlio Wischral, 993, sobrado 02, foto https://ebvimoveiscuritiba.com.br/media/photos/a.jpg e https://outrosite.com/x"),
            "Rua Júlio Wischral, 993, foto e",
        )
        self.assertEqual(dl.sanitize("O código é prop-1792252762995"), "")

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


if __name__ == "__main__":
    unittest.main()
