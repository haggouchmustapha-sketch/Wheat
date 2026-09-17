const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

/**
 * The arithmetic stock is built on.
 *
 * Every number a user ever sees in the stock module — a balance, a stock card
 * line, the value on an accounting draft — is produced by these two modules, so
 * the reference cases in the stock specification are pinned here as arithmetic,
 * with no database and no transaction in the way.
 *
 * The case that matters most is the one that looks least interesting: receiving
 * three units at 333,333333 and issuing them one and then two has to end at
 * quantity zero *and* value zero. A module that rounds a unit cost anywhere in
 * that path ends at value 0,000001, and nothing downstream can tell that the
 * centime is fictional.
 */

const root = process.env.WHEAT_CWD ?? path.resolve(__dirname, "..");

let units;
let valuation;

test.beforeAll(() => {
  units = tsxRequire(path.join(root, "electron", "stockUnits.ts"), __filename);
  valuation = tsxRequire(path.join(root, "electron", "stockValuation.ts"), __filename);
});

const qty = (value) => units.qtyFromDecimal(value, "La quantité");
const money = (value) => units.moneyFromDecimal(value, "Le montant");

test("scales are the ones the stock module documents", () => {
  expect(units.QTY_SCALE).toBe(1_000_000n);
  expect(units.MONEY_SCALE).toBe(1_000_000n);
  expect(units.CENT_SCALE).toBe(100n);
});

test("decimal input is read exactly, in either separator", () => {
  expect(qty("12,5")).toBe(12_500_000n);
  expect(qty("12.5")).toBe(12_500_000n);
  expect(qty("0,333333")).toBe(333_333n);
  expect(money("333,333333")).toBe(333_333_333n);
  expect(qty("")).toBe(0n);
  expect(qty(10)).toBe(10_000_000n);
});

test("inexact input is refused rather than rounded", () => {
  // A non-integer JavaScript number has already lost precision before the
  // module sees it; accepting it would make the guarantee unverifiable.
  expect(() => qty(0.1 + 0.2)).toThrow(/texte décimal exact/);
  expect(() => qty("1,2345678")).toThrow(/plus de 6 décimales/);
  expect(() => qty("douze")).toThrow(/invalide/);
  expect(() => qty(10n)).toThrow(/déjà mise à l'échelle/);
});

test("stored values are checked against the signed 64-bit column", () => {
  expect(() => units.assertStoredRange(2n ** 63n, "La valeur")).toThrow(/capacité de stockage/);
  expect(units.assertStoredRange(2n ** 63n - 1n, "La valeur")).toBe(2n ** 63n - 1n);
  expect(() => qty("99999999999999")).toThrow(/capacité de stockage/);
});

test("micro-dirham converts to centimes half-up, away from zero", () => {
  expect(units.moneyMicroToCents(money("1,004999"))).toBe(100n);
  expect(units.moneyMicroToCents(money("1,005000"))).toBe(101n);
  expect(units.moneyMicroToCents(money("-1,005000"))).toBe(-101n);
  expect(units.moneyMicroToCents(money("110"))).toBe(11_000n);
});

test("A. a position that reaches quantity zero reaches value zero", () => {
  // The specification's mandatory case: 3 × 333,333333, issued 1 then 2.
  let position = valuation.applyReceipt(valuation.EMPTY_POSITION, qty("3"), units.valueFromUnitPrice(qty("3"), money("333,333333")));
  expect(position.value).toBe(money("999,999999"));

  const first = valuation.applyIssueCmp(position, qty("1"));
  position = first.position;
  expect(position.quantity).toBe(qty("2"));

  const second = valuation.applyIssueCmp(position, qty("2"));
  position = second.position;

  expect(position.quantity).toBe(0n);
  expect(position.value).toBe(0n);
  expect(first.valueRemoved + second.valueRemoved).toBe(money("999,999999"));
});

test("A. the same guarantee holds under FIFO", () => {
  const layers = [{ id: "A", quantityRemaining: qty("3"), valueRemaining: money("999,999999") }];
  const first = valuation.planFifoIssue(layers, qty("1"));
  const afterFirst = [valuation.applyConsumptionToLayer(layers[0], first.consumptions[0])];
  const second = valuation.planFifoIssue(afterFirst, qty("2"));
  const afterSecond = valuation.applyConsumptionToLayer(afterFirst[0], second.consumptions[0]);

  expect(afterSecond.quantityRemaining).toBe(0n);
  expect(afterSecond.valueRemaining).toBe(0n);
  expect(first.totalValue + second.totalValue).toBe(money("999,999999"));
});

test("B. CMP reference case: 10×100, 10×120, issue 5", () => {
  let position = valuation.applyReceipt(valuation.EMPTY_POSITION, qty("10"), money("1000"));
  position = valuation.applyReceipt(position, qty("10"), money("1200"));

  expect(position.quantity).toBe(qty("20"));
  expect(position.value).toBe(money("2200"));
  expect(units.derivedUnitCost(position.value, position.quantity)).toBe(money("110"));

  const issue = valuation.applyIssueCmp(position, qty("5"));
  expect(issue.valueRemoved).toBe(money("550"));
  expect(issue.position.quantity).toBe(qty("15"));
  expect(issue.position.value).toBe(money("1650"));
  expect(units.derivedUnitCost(issue.position.value, issue.position.quantity)).toBe(money("110"));
});

test("C. FIFO reference case: 10×100, 10×120, issue 15", () => {
  const layers = [
    { id: "A", quantityRemaining: qty("10"), valueRemaining: money("1000") },
    { id: "B", quantityRemaining: qty("10"), valueRemaining: money("1200") },
  ];
  const plan = valuation.planFifoIssue(layers, qty("15"));

  expect(plan.totalValue).toBe(money("1600"));
  expect(plan.consumptions).toHaveLength(2);
  expect(plan.consumptions[0]).toMatchObject({ layerId: "A", quantity: qty("10"), value: money("1000"), exhausted: true });
  expect(plan.consumptions[1]).toMatchObject({ layerId: "B", quantity: qty("5"), value: money("600"), exhausted: false });

  const remaining = layers.map((layer, index) => valuation.applyConsumptionToLayer(layer, plan.consumptions[index]));
  const remainingQuantity = remaining.reduce((sum, layer) => sum + layer.quantityRemaining, 0n);
  const remainingValue = remaining.reduce((sum, layer) => sum + layer.valueRemaining, 0n);
  expect(remainingQuantity).toBe(qty("5"));
  expect(remainingValue).toBe(money("600"));
});

test("a FIFO reversal returns value to the layers it came from", () => {
  const layers = [
    { id: "A", quantityRemaining: qty("10"), valueRemaining: money("1000") },
    { id: "B", quantityRemaining: qty("10"), valueRemaining: money("1200") },
  ];
  const plan = valuation.planFifoIssue(layers, qty("15"));
  const consumed = layers.map((layer, index) => valuation.applyConsumptionToLayer(layer, plan.consumptions[index]));
  const restored = consumed.map((layer, index) => valuation.restoreConsumptionToLayer(layer, plan.consumptions[index]));

  // Byte for byte the position that existed before the issue, which an average
  // recomputed at reversal time would not have reproduced.
  expect(restored[0]).toMatchObject({ quantityRemaining: qty("10"), valueRemaining: money("1000") });
  expect(restored[1]).toMatchObject({ quantityRemaining: qty("10"), valueRemaining: money("1200") });
});

test("D. an allocation sums exactly to the charge it splits", () => {
  const charge = money("100");
  const parts = units.allocateProportionally(charge, [qty("1"), qty("1"), qty("1")]);
  expect(parts.reduce((sum, part) => sum + part, 0n)).toBe(charge);
  // The remainder lands deterministically on the last weighted item.
  expect(parts[0]).toBe(money("33,333333"));
  expect(parts[2]).toBe(charge - parts[0] - parts[1]);

  const uneven = units.allocateProportionally(money("110"), [money("1000"), money("200"), money("1")]);
  expect(uneven.reduce((sum, part) => sum + part, 0n)).toBe(money("110"));

  expect(() => units.allocateProportionally(money("10"), [0n, 0n])).toThrow(/base de répartition/);
  expect(units.allocateProportionally(0n, [0n, 0n])).toEqual([0n, 0n]);
});

test("negative stock is refused by default, and always under FIFO", () => {
  const position = { quantity: qty("3"), value: money("300") };
  expect(() => valuation.applyIssueCmp(position, qty("5"))).toThrow(/INSUFFICIENT_STOCK/);
  expect(() => valuation.planFifoIssue([{ id: "A", quantityRemaining: qty("3"), valueRemaining: money("300") }], qty("5")))
    .toThrow(/INSUFFICIENT_STOCK/);
});

test("CMP may go negative only where a cost basis exists to extrapolate", () => {
  const withBasis = valuation.applyIssueCmp({ quantity: qty("3"), value: money("300") }, qty("5"), { allowNegative: true });
  expect(withBasis.position.quantity).toBe(qty("-2"));
  expect(withBasis.position.value).toBe(money("-200"));
  expect(withBasis.valueRemoved).toBe(money("500"));

  // Nothing in the dossier says what an empty position costs, so no number is
  // invented for it.
  expect(() => valuation.applyIssueCmp(valuation.EMPTY_POSITION, qty("5"), { allowNegative: true }))
    .toThrow(/NO_COST_BASIS/);
});

test("a receipt never recomputes the value already in the position", () => {
  const position = valuation.applyReceipt({ quantity: qty("7"), value: money("233,333333") }, qty("3"), money("100"));
  expect(position.quantity).toBe(qty("10"));
  expect(position.value).toBe(money("333,333333"));
  expect(() => valuation.applyReceipt(position, 0n, money("10"))).toThrow(/quantité positive/);
  expect(() => valuation.applyReceipt(position, qty("1"), money("-1"))).toThrow(/valeur négative/);
});
