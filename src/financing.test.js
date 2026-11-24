import test from "node:test";
import assert from "node:assert/strict";
import { buildSacSeries, calculateFinancing, shortPropertyLabel } from "../financing.js";
import { normalizeSettings } from "./financing.js";

test("calcula SAC e Price com primeira e última parcela", () => {
  const result = calculateFinancing({
    propertyValue: 1190000,
    entry: 238000,
    fgts: 0,
    exchange: 0,
    usesFgts: false,
    hasExchange: false,
    termYears: 35,
    annualRateEffective: 10.99,
    incomeCommitmentPercent: 30,
  });
  assert.equal(result.financed, 952000);
  assert.equal(result.months, 420);
  assert.ok(result.sac.first > result.sac.last);
  assert.equal(result.price.first, result.price.last);
  assert.ok(result.price.total > result.financed);
  assert.ok(result.minimumIncome > result.sac.first);
});

test("considera FGTS e imóvel na troca como recursos de entrada", () => {
  const result = calculateFinancing({
    propertyValue: 1190000,
    entry: 200000,
    fgts: 50000,
    exchange: 300000,
    usesFgts: true,
    hasExchange: true,
    termYears: 20,
    annualRateEffective: 10.99,
    incomeCommitmentPercent: 30,
  });
  assert.equal(result.financed, 640000);
});

test("gera série SAC decrescente para o gráfico", () => {
  const series = buildSacSeries({ propertyValue: 500000, entry: 100000, termYears: 10, annualRateEffective: 10, incomeCommitmentPercent: 30 }, 12);
  assert.equal(series.length, 12);
  assert.ok(series[0].value > series.at(-1).value);
});

test("normaliza configuração sem perder a fonte oficial", () => {
  const settings = normalizeSettings({ annualRateEffective: 11.25, sourceLabel: "CAIXA oficial" });
  assert.equal(settings.annualRateEffective, 11.25);
  assert.equal(settings.sourceLabel, "CAIXA oficial");
  assert.match(settings.sourceUrl, /^https:\/\//);
});

test("gera nome curto legível para o seletor do simulador", () => {
  assert.equal(
    shortPropertyLabel({ title: "Lindo Triplex 220 m2", type: "sobrado", area: 220, beds: 3, location: "Uberaba", price: 1190000 }),
    "Triplex 220 m² · Uberaba · R$\u00a01.190.000",
  );
  assert.equal(
    shortPropertyLabel({ title: "Lançamento - Studios com 1 dormitório", type: "apartamento", area: 19, beds: 1, location: "Alto da Rua XV", price: 261000 }),
    "Studio 1 dorm. · Alto da Rua XV · R$\u00a0261.000",
  );
});

