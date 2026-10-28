import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAlerts, buildRows, percentile, roundAt, roundClose, toCsv, type Batch, type Config } from "../src/latency";

const c: Config = { genesis: 1_000_000, roundDuration: 600, warnSec: 1800, critSec: 3600, gapWarnSec: 3600 };
const b = (o: Partial<Batch>): Batch => ({ blockNumber: 1, timestamp: 0, txHash: "0x", logIndex: 0, reporter: "0xR", nonce: 1, previous: 0, through: 1, activeRoundCount: 1, cumulativeWork: "0", cumulativeBlockUnits: "0", ...o });

test("round model matches Quickstart currentRound formula", () => {
  assert.equal(roundAt(c, c.genesis - 1), 0);
  assert.equal(roundAt(c, c.genesis), 1);
  assert.equal(roundAt(c, c.genesis + 599), 1);
  assert.equal(roundAt(c, c.genesis + 600), 2);
  assert.equal(roundClose(c, 1), c.genesis + 600);
});

test("latency, gap and severity per batch", () => {
  const rows = buildRows(c, [
    b({ blockNumber: 10, timestamp: roundClose(c, 3) + 120, previous: 0, through: 3, nonce: 1 }),
    b({ blockNumber: 20, timestamp: roundClose(c, 4) + 4000, previous: 3, through: 4, nonce: 2 }),
  ]);
  assert.equal(rows[0].roundsSettled, 3);
  assert.equal(rows[0].newestLatencySec, 120);
  assert.equal(rows[0].oldestLatencySec, 120 + 1200);
  assert.equal(rows[0].severity, "OK");
  assert.equal(rows[1].oldestLatencySec, 4000);
  assert.equal(rows[1].severity, "CRIT");
  assert.equal(rows[1].gapSincePrevSec, 600 + 4000 - 120);
});

test("alerts: latency, gap, discontinuity, nonce jump, unsettled now", () => {
  const rows = buildRows(c, [
    b({ blockNumber: 10, timestamp: roundClose(c, 1) + 60, previous: 0, through: 1, nonce: 1 }),
    b({ blockNumber: 20, timestamp: roundClose(c, 9) + 2000, previous: 2, through: 9, nonce: 5 }),
  ]);
  const now = { timestamp: roundClose(c, 20) + 10, blockNumber: 30, frontier: 9, miningProcessed: 8 };
  const types = buildAlerts(c, rows, [], now).map((a) => `${a.severity}:${a.type}`);
  assert.deepEqual(types.sort(), ["CRIT:FRONTIER_DISCONTINUITY", "CRIT:SETTLEMENT_LATENCY", "CRIT:UNSETTLED_NOW", "INFO:MINING_CHECKPOINT_LAG", "INFO:NONCE_JUMP", "WARN:BATCH_GAP"].sort());
});

test("percentile + csv escaping", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([], 50), null);
  assert.equal(toCsv([{ a: 'x,"y"', b: 1 }], ["a", "b"]), 'a,b\n"x,""y""",1\n');
});
