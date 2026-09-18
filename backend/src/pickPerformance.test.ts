import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  attribute,
  geTax,
  matchLots,
  MAX_SANE_PREDICTED_ROI,
  summarise,
  type Fill,
  type Pick,
} from "./pickPerformance.js";

// The two things in this module most likely to be quietly wrong are the buy/sell pairing and the
// attribution, and both fail silently: a mis-paired lot does not throw, it just makes a profit
// figure a bit off in a way nobody would notice from the screen. These tests pin the arithmetic
// by hand, with numbers small enough to check on paper.

const buy = (itemId: number, quantity: number, price: number, occurredAt: number): Fill => ({
  itemId,
  type: "buy",
  quantity,
  price,
  occurredAt,
});
const sell = (itemId: number, quantity: number, price: number, occurredAt: number): Fill => ({
  itemId,
  type: "sell",
  quantity,
  price,
  occurredAt,
});
const pick = (
  itemId: number,
  takenAt: number,
  resolveAt: number,
  predictedRoi = 0.05,
  strategy: Pick["strategy"] = "signals",
): Pick => ({ itemId, takenAt, resolveAt, strategy, predictedRoi });

describe("geTax", () => {
  // Pinned because this is a copy of signals.ts's rule (importing it would open the database).
  // If the game changes the rule, both copies must change, and these cases are how you notice.
  it("takes 2% rounded down", () => {
    assert.equal(geTax(1000), 20);
    assert.equal(geTax(120), 2); // 2.4 rounds down
  });

  it("waives the tax when it would round to zero, under 50gp", () => {
    assert.equal(geTax(49), 0);
    assert.equal(geTax(50), 1);
  });

  it("caps at 5m per unit", () => {
    assert.equal(geTax(250_000_000), 5_000_000);
    assert.equal(geTax(1_000_000_000), 5_000_000);
  });
});

describe("matchLots", () => {
  it("prices a simple round trip after tax", () => {
    const { lots } = matchLots([buy(1, 10, 100, 1), sell(1, 10, 120, 2)]);
    assert.equal(lots.length, 1);
    // 10 units x (120 sell - 2 tax) - 1,000 cost = 180
    assert.equal(lots[0].profit, 180);
    assert.equal(lots[0].cost, 1000);
  });

  it("sells the OLDEST units first", () => {
    // Same convention as flips.ts. If this ever flipped to newest-first, every profit figure here
    // would stop reconciling with the Flips tab.
    const { lots, openUnits, openCost } = matchLots([
      buy(1, 5, 100, 1),
      buy(1, 5, 200, 2),
      sell(1, 5, 150, 3),
    ]);
    assert.equal(lots.length, 1);
    assert.equal(lots[0].buyPrice, 100);
    // 5 x (150 - 3 tax) - 500 = 235
    assert.equal(lots[0].profit, 235);
    // The dearer lot is what is still held.
    assert.equal(openUnits, 5);
    assert.equal(openCost, 1000);
  });

  it("splits one sell across the buys it consumed, keeping each buy's own time", () => {
    // This is why the unit of account is a lot rather than a fill: these two chunks came in at
    // different times, so they can follow different picks.
    const { lots } = matchLots([buy(1, 3, 100, 10), buy(1, 3, 100, 20), sell(1, 6, 120, 30)]);
    assert.deepEqual(
      lots.map((l) => [l.quantity, l.buyTime]),
      [
        [3, 10],
        [3, 20],
      ],
    );
  });

  it("EXCLUDES sells with no recorded buy rather than zero-costing them", () => {
    // The deliberate break from flips.ts. Zero-costing these would count them as pure profit, and
    // make whichever group held more pre-ledger stock look better for no reason to do with picks.
    const { lots, unmatchedSellUnits } = matchLots([
      buy(1, 2, 100, 1),
      sell(1, 5, 120, 2), // 3 of these units were never bought on record
    ]);
    assert.equal(unmatchedSellUnits, 3);
    assert.equal(lots.length, 1);
    assert.equal(lots[0].quantity, 2);
    // Only the 2 known units contribute: 2 x (120 - 2) - 200 = 36. Not inflated by the other 3.
    assert.equal(lots[0].profit, 36);
  });

  it("orders a same-second buy before its sell, so an instant flip still pairs", () => {
    const { lots, unmatchedSellUnits, openUnits } = matchLots([
      sell(1, 4, 120, 5),
      buy(1, 4, 100, 5),
    ]);
    assert.equal(lots.length, 1);
    assert.equal(unmatchedSellUnits, 0);
    assert.equal(openUnits, 0);
  });

  it("never pairs across items", () => {
    const { lots, unmatchedSellUnits } = matchLots([buy(1, 5, 100, 1), sell(2, 5, 120, 2)]);
    assert.equal(lots.length, 0);
    assert.equal(unmatchedSellUnits, 5);
  });
});

describe("attribute", () => {
  const lotAt = (buyTime: number) =>
    matchLots([buy(1, 1, 100, buyTime), sell(1, 1, 120, buyTime + 1)]).lots;

  it("counts a buy made while the pick was live as following it", () => {
    const [l] = attribute(lotAt(150), [pick(1, 100, 200)]);
    assert.notEqual(l.pick, null);
  });

  it("treats both ends of the window as inclusive", () => {
    assert.notEqual(attribute(lotAt(100), [pick(1, 100, 200)])[0].pick, null);
    assert.notEqual(attribute(lotAt(200), [pick(1, 100, 200)])[0].pick, null);
  });

  it("does not count a buy made BEFORE the call", () => {
    // You cannot have followed advice that had not been given yet.
    assert.equal(attribute(lotAt(99), [pick(1, 100, 200)])[0].pick, null);
  });

  it("does not count a buy made after the call's own horizon ran out", () => {
    assert.equal(attribute(lotAt(201), [pick(1, 100, 200)])[0].pick, null);
  });

  it("does not credit a pick for a different item", () => {
    assert.equal(attribute(lotAt(150), [pick(2, 100, 200)])[0].pick, null);
  });

  it("credits the most recent live pick when several overlap", () => {
    // The same item called on consecutive half-hourly runs is common; the latest one is what was
    // on screen when you bought.
    const [l] = attribute(lotAt(150), [pick(1, 100, 300, 0.01), pick(1, 140, 300, 0.09)]);
    assert.equal(l.pick!.predictedRoi, 0.09);
  });
});

describe("summarise", () => {
  it("splits followed from independent and compares them by return on capital", () => {
    const match = matchLots([
      buy(1, 10, 100, 150),
      sell(1, 10, 120, 160), // followed: +180 on 1,000
      buy(2, 10, 100, 500),
      sell(2, 10, 102, 510), // independent: 10 x (102 - 2) - 1,000 = 0
    ]);
    const report = summarise(match, [pick(1, 100, 200)]);
    assert.equal(report.followed.profit, 180);
    assert.equal(report.followed.roi, 0.18);
    assert.equal(report.independent.profit, 0);
    assert.equal(report.independent.roi, 0);
  });

  it("weights the win rate by capital, so how the GE split an order cannot move it", () => {
    // One 1,000gp winner and one 1,000gp loser: half the capital won, however either is chunked.
    const oneChunk = summarise(
      matchLots([buy(1, 10, 100, 1), sell(1, 10, 120, 2), buy(2, 10, 100, 3), sell(2, 10, 90, 4)]),
      [],
    );
    // The same winner, arriving as ten partial fills.
    const winnerFills: Fill[] = [];
    for (let i = 0; i < 10; i++) winnerFills.push(buy(1, 1, 100, 1), sell(1, 1, 120, 2));
    const tenChunks = summarise(
      matchLots([...winnerFills, buy(2, 10, 100, 3), sell(2, 10, 90, 4)]),
      [],
    );
    assert.equal(oneChunk.independent.capitalWinRate, 0.5);
    assert.equal(tenChunks.independent.capitalWinRate, 0.5);
    // ...while a count-based rate would have read 1/2 in the first case and 10/11 in the second.
    assert.notEqual(oneChunk.independent.lots, tenChunks.independent.lots);
  });

  it("breaks followed trades down by the strategy of the pick they followed", () => {
    const report = summarise(
      matchLots([
        buy(1, 1, 100, 150),
        sell(1, 1, 120, 160),
        buy(2, 1, 100, 150),
        sell(2, 1, 120, 160),
      ]),
      [pick(1, 100, 200, 0.05, "signals"), pick(2, 100, 200, 0.05, "overnight")],
    );
    assert.equal(report.byStrategy.signals.lots, 1);
    assert.equal(report.byStrategy.overnight.lots, 1);
  });

  it("leaves a glitched prediction out of the predicted-return average", () => {
    // The stored data really does contain a signals call predicting a 13,430% return. Averaged in,
    // one row like it would set the predicted figure on its own.
    const report = summarise(
      matchLots([
        buy(1, 10, 100, 150),
        sell(1, 10, 120, 160),
        buy(2, 10, 100, 150),
        sell(2, 10, 120, 160),
      ]),
      [pick(1, 100, 200, 0.05), pick(2, 100, 200, 134.3)],
    );
    assert.ok(134.3 > MAX_SANE_PREDICTED_ROI);
    assert.equal(report.execution.excludedGlitches, 1);
    assert.equal(report.execution.lots, 1);
    assert.equal(report.execution.predictedRoi, 0.05);
  });

  it("weights predicted and realised return by YOUR cost, not the pick's", () => {
    // 1,000gp committed at a 10% prediction, 9,000gp at a 0% one: the money says 1%, not 5%.
    const report = summarise(
      matchLots([
        buy(1, 10, 100, 150),
        sell(1, 10, 100, 160),
        buy(2, 90, 100, 150),
        sell(2, 90, 100, 160),
      ]),
      [pick(1, 100, 200, 0.1), pick(2, 100, 200, 0)],
    );
    assert.ok(Math.abs(report.execution.predictedRoi! - 0.01) < 1e-12);
  });

  it("breaks followed trades down per item, largest capital first", () => {
    const report = summarise(
      matchLots([
        buy(1, 1, 100, 150),
        sell(1, 1, 120, 160), // small winner
        buy(2, 10, 100, 150),
        sell(2, 10, 90, 160), // bigger loser
        buy(3, 5, 100, 500),
        sell(3, 5, 120, 510), // not followed: must not appear
      ]),
      [pick(1, 100, 200), pick(2, 100, 200)],
    );
    assert.deepEqual(
      report.followedItems.map((i) => i.itemId),
      [2, 1],
    );
    // 10 x (90 - 1 tax) - 1,000 = -110
    assert.equal(report.followedItems[0].profit, -110);
  });

  it("reports nothing rather than dividing by zero when there are no trades", () => {
    const report = summarise(matchLots([]), []);
    assert.equal(report.followed.roi, null);
    assert.equal(report.followed.capitalWinRate, null);
    assert.equal(report.execution.predictedRoi, null);
    assert.equal(report.range.from, null);
  });
});
