// Tiny local dashboard. GET /api/summary runs the tracker (cached 60 s, single-flight) at a pinned finalized block.
// GET /csv/batches.csv | alerts.csv | daily.csv streams the same data as CSV. Read-only, no wallet, no keys.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { jsonSafe, makeClient } from "../src/chain";
import { runTracker, type TrackerResult } from "../src/track";
import { iso, toCsv } from "../src/latency";

const client = makeClient();
const PORT = Number(process.env.PORT ?? 8877);
const HTML = new URL("./index.html", import.meta.url);
let cache: { at: number; data: TrackerResult } | undefined;
let inflight: Promise<TrackerResult> | undefined;

async function get() {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  inflight ??= runTracker(client).then((data) => ((cache = { at: Date.now(), data }), data)).finally(() => (inflight = undefined));
  return inflight;
}

const csv = (r: TrackerResult, name: string) => {
  if (name === "batches.csv") return toCsv(r.rows.map((x) => ({ ...x, timeUtc: iso(x.timestamp) })), ["blockNumber", "timeUtc", "txHash", "previous", "through", "roundsSettled", "activeRoundCount", "oldestLatencySec", "newestLatencySec", "gapSincePrevSec", "severity", "nonce", "reporter"]);
  if (name === "alerts.csv") return toCsv(r.alerts.map((a) => ({ ...a, timeUtc: iso(a.timestamp) })), ["timeUtc", "blockNumber", "severity", "type", "rounds", "valueSec", "txHash", "message"]);
  if (name === "daily.csv") return toCsv(r.daily.map((d) => ({ date: d.date, batches: d.batches, roundsSettled: d.roundsSettled, p50: d.oldestLatency.p50, p90: d.oldestLatency.p90, max: d.oldestLatency.max, warn: d.warn, crit: d.crit })), ["date", "batches", "roundsSettled", "p50", "p90", "max", "warn", "crit"]);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/api/summary") {
      const r = await get();
      // Chart only needs a few fields per batch.
      const points = r.rows.map((x) => [x.timestamp, x.oldestLatencySec, x.roundsSettled, x.blockNumber]);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jsonSafe({ ok: true, meta: r.meta, now: r.now, stats: r.stats, daily: r.daily, alerts: r.alerts, points, checkpoints: r.checkpoints })));
      return;
    }
    const m = url.pathname.match(/^\/csv\/(batches|alerts|daily)\.csv$/);
    if (m) {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": `attachment; filename="squeek-${m[1]}.csv"` }).end(csv(await get(), `${m[1]}.csv`));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(HTML));
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: (e as Error).message }));
  }
}).listen(PORT, () => console.log(`Squeek settlement latency dashboard: http://localhost:${PORT}  (first load replays history; cached afterwards)`));
