// CLI: npm run track  -> verifies the deployment, replays settlement history, writes out/*.csv + out/summary.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { makeClient, jsonSafe } from "./src/chain";
import { runTracker } from "./src/track";
import { fmtDur, iso, toCsv } from "./src/latency";

const r = await runTracker(makeClient());
const dir = new URL("./out/", import.meta.url);
mkdirSync(dir, { recursive: true });
const batchCols = ["blockNumber", "timeUtc", "txHash", "previous", "through", "roundsSettled", "activeRoundCount", "oldestLatencySec", "newestLatencySec", "gapSincePrevSec", "severity", "nonce", "reporter", "cumulativeWork", "cumulativeBlockUnits"];
writeFileSync(new URL("batches.csv", dir), toCsv(r.rows.map((x) => ({ ...x, timeUtc: iso(x.timestamp) })), batchCols));
writeFileSync(new URL("alerts.csv", dir), toCsv(r.alerts.map((a) => ({ ...a, timeUtc: iso(a.timestamp) })), ["timeUtc", "blockNumber", "severity", "type", "rounds", "valueSec", "txHash", "message"]));
writeFileSync(new URL("daily.csv", dir), toCsv(r.daily.map((d) => ({ date: d.date, batches: d.batches, roundsSettled: d.roundsSettled, p50: d.oldestLatency.p50, p90: d.oldestLatency.p90, max: d.oldestLatency.max, warn: d.warn, crit: d.crit })), ["date", "batches", "roundsSettled", "p50", "p90", "max", "warn", "crit"]));
writeFileSync(new URL("summary.json", dir), JSON.stringify(jsonSafe({ meta: r.meta, now: r.now, stats: r.stats, checkpoints: r.checkpoints }), null, 2));

const s = r.stats.allTime, d = r.stats.last24h, n = r.now;
const f = (v: number | null) => (v === null ? "-" : fmtDur(v));
console.log(`✅ Deployment verified at Sepolia block ${r.meta.blockNumber} (${iso(r.meta.blockTimestamp)}) via ${r.meta.rpcHost}${r.meta.strict ? " [strict]" : ""}`);
console.log(`   reporter: docs ${r.meta.reporter.docs} -> current ${r.meta.reporter.current} (${r.meta.reporter.rotations} onchain rotation(s))`);
console.log(`Round now ${n.currentRound} | certified frontier ${n.frontier} | ${n.closedUnsettled} closed rounds unsettled (oldest waiting ${f(n.oldestUnsettledWaitSec)}) | last batch ${f(n.lastBatchAgeSec)} ago${n.paused ? " | CORE PAUSED" : ""}`);
console.log(`Mining processed through round ${n.miningProcessedThroughRound} | last checkpoint ${f(n.lastCheckpointAgeSec)} ago | Squeek block height ${n.blockHeight}`);
console.log(`All time: ${s.batches} batches / ${s.roundsSettled} rounds | settle latency p50 ${f(s.oldestLatency.p50)} p90 ${f(s.oldestLatency.p90)} p99 ${f(s.oldestLatency.p99)} max ${f(s.oldestLatency.max)} | WARN ${s.warn} CRIT ${s.crit}`);
console.log(`Last 24h: ${d.batches} batches | p50 ${f(d.oldestLatency.p50)} p90 ${f(d.oldestLatency.p90)} max ${f(d.oldestLatency.max)}`);
console.log(`Alerts: ${r.alerts.length} (${["CRIT", "WARN", "INFO"].map((k) => `${k} ${r.alerts.filter((a) => a.severity === k).length}`).join(", ")})`);
for (const a of r.alerts.slice(-5)) console.log(`  [${a.severity}] ${iso(a.timestamp)} ${a.type} ${a.message}`);
console.log(`Wrote out/batches.csv, out/alerts.csv, out/daily.csv, out/summary.json`);
// Optional CI-style exit code: FAIL_ON=CRIT npm run track exits 2 if the CURRENT state is critical.
if (process.env.FAIL_ON && r.alerts.some((a) => a.type === "UNSETTLED_NOW" && a.severity === process.env.FAIL_ON)) process.exit(2);
