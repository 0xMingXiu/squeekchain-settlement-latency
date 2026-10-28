// Pure analysis (no I/O): turns BatchSettled / Paused / Unpaused / ReporterUpdated / Checkpointed events
// into per-batch settlement latency rows, alerts and summary stats. Unit-tested in test/latency.test.ts.
//
// Round model (from the Quickstart): currentRound = floor((t - genesis) / roundDuration) + 1, so round r
// covers [genesis + (r-1)*D, genesis + r*D) and CLOSES at genesis + r*D.
// A BatchSettled moves the certified frontier from previousSettledThroughRound to settledThroughRound.
//   oldestLatency = batchTime - close(previous + 1)   (longest any round in the batch waited)
//   newestLatency = batchTime - close(settledThrough) (freshness of the frontier right after the batch)

export type Batch = {
  blockNumber: number; timestamp: number; txHash: string; logIndex: number;
  reporter: string; nonce: number; previous: number; through: number; activeRoundCount: number;
  cumulativeWork: string; cumulativeBlockUnits: string;
};
export type SimpleEvent = { kind: "PAUSED" | "UNPAUSED" | "REPORTER_ROTATED" | "CHECKPOINT"; blockNumber: number; timestamp: number; txHash: string; detail: string; throughRound?: number };
export type Config = { genesis: number; roundDuration: number; warnSec: number; critSec: number; gapWarnSec: number };
export type Row = Batch & {
  roundsSettled: number; closeOfOldest: number; closeOfNewest: number;
  oldestLatencySec: number; newestLatencySec: number; gapSincePrevSec: number | null; severity: "OK" | "WARN" | "CRIT";
};
export type Alert = { timestamp: number; blockNumber: number; severity: "INFO" | "WARN" | "CRIT"; type: string; rounds: string; valueSec: number | null; txHash: string; message: string };

export const roundClose = (c: Config, r: number) => c.genesis + r * c.roundDuration;
export const roundAt = (c: Config, t: number) => (t < c.genesis ? 0 : Math.floor((t - c.genesis) / c.roundDuration) + 1);

export function buildRows(c: Config, batches: Batch[]): Row[] {
  const sorted = [...batches].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return sorted.map((b, i) => {
    const prev = sorted[i - 1];
    const closeOfOldest = roundClose(c, b.previous + 1), closeOfNewest = roundClose(c, b.through);
    const oldestLatencySec = b.timestamp - closeOfOldest;
    return {
      ...b, roundsSettled: b.through - b.previous, closeOfOldest, closeOfNewest,
      oldestLatencySec, newestLatencySec: b.timestamp - closeOfNewest,
      gapSincePrevSec: prev ? b.timestamp - prev.timestamp : null,
      severity: oldestLatencySec >= c.critSec ? "CRIT" : oldestLatencySec >= c.warnSec ? "WARN" : "OK",
    };
  });
}

export const fmtDur = (s: number) => {
  const a = Math.abs(s), sign = s < 0 ? "-" : "";
  if (a < 60) return `${sign}${a}s`;
  if (a < 3600) return `${sign}${Math.floor(a / 60)}m${String(a % 60).padStart(2, "0")}s`;
  if (a < 86400) return `${sign}${Math.floor(a / 3600)}h${String(Math.floor((a % 3600) / 60)).padStart(2, "0")}m`;
  return `${sign}${Math.floor(a / 86400)}d${String(Math.floor((a % 86400) / 3600)).padStart(2, "0")}h`;
};

export function buildAlerts(c: Config, rows: Row[], events: SimpleEvent[], now: { timestamp: number; blockNumber: number; frontier: number; miningProcessed?: number }): Alert[] {
  const alerts: Alert[] = [];
  rows.forEach((r, i) => {
    if (r.severity !== "OK") alerts.push({
      timestamp: r.timestamp, blockNumber: r.blockNumber, severity: r.severity, type: "SETTLEMENT_LATENCY",
      rounds: `${r.previous + 1}-${r.through}`, valueSec: r.oldestLatencySec, txHash: r.txHash,
      message: `Round ${r.previous + 1} waited ${fmtDur(r.oldestLatencySec)} after closing before it was settled (${r.roundsSettled} rounds in batch)`,
    });
    if (r.gapSincePrevSec !== null && r.gapSincePrevSec >= c.gapWarnSec) alerts.push({
      timestamp: r.timestamp, blockNumber: r.blockNumber, severity: "WARN", type: "BATCH_GAP",
      rounds: `${r.previous + 1}-${r.through}`, valueSec: r.gapSincePrevSec, txHash: r.txHash,
      message: `No BatchSettled for ${fmtDur(r.gapSincePrevSec)} before this batch`,
    });
    const prev = rows[i - 1];
    if (prev && r.previous !== prev.through) alerts.push({
      timestamp: r.timestamp, blockNumber: r.blockNumber, severity: "CRIT", type: "FRONTIER_DISCONTINUITY",
      rounds: `${prev.through}->${r.previous}`, valueSec: null, txHash: r.txHash,
      message: `Batch starts after round ${r.previous} but previous batch ended at ${prev.through} (missing logs?)`,
    });
    if (prev && r.nonce !== prev.nonce + 1) alerts.push({
      timestamp: r.timestamp, blockNumber: r.blockNumber, severity: "INFO", type: "NONCE_JUMP",
      rounds: `${r.previous + 1}-${r.through}`, valueSec: null, txHash: r.txHash,
      message: `Authorization nonce jumped ${prev.nonce} -> ${r.nonce}`,
    });
  });
  for (const e of events) {
    if (e.kind === "CHECKPOINT") continue;
    alerts.push({
      timestamp: e.timestamp, blockNumber: e.blockNumber, severity: e.kind === "PAUSED" ? "WARN" : "INFO", type: e.kind,
      rounds: "", valueSec: null, txHash: e.txHash, message: e.detail,
    });
  }
  // Ongoing stall: completed rounds that are not settled yet at the pinned block.
  const lastClosed = roundAt(c, now.timestamp) - 1;
  if (lastClosed > now.frontier) {
    const waiting = now.timestamp - roundClose(c, now.frontier + 1);
    alerts.push({
      timestamp: now.timestamp, blockNumber: now.blockNumber,
      severity: waiting >= c.critSec ? "CRIT" : waiting >= c.warnSec ? "WARN" : "INFO", type: "UNSETTLED_NOW",
      rounds: `${now.frontier + 1}-${lastClosed}`, valueSec: waiting, txHash: "",
      message: `${lastClosed - now.frontier} closed round(s) not settled yet; oldest (round ${now.frontier + 1}) has waited ${fmtDur(waiting)}`,
    });
  }
  if (now.miningProcessed !== undefined && now.miningProcessed < now.frontier) alerts.push({
    timestamp: now.timestamp, blockNumber: now.blockNumber, severity: "INFO", type: "MINING_CHECKPOINT_LAG",
    rounds: `${now.miningProcessed + 1}-${now.frontier}`, valueSec: null, txHash: "",
    message: `SqueekMining has processed through round ${now.miningProcessed}; Core frontier is ${now.frontier} (${now.frontier - now.miningProcessed} settled rounds awaiting checkpoint)`,
  });
  return alerts.sort((a, b) => a.blockNumber - b.blockNumber);
}

export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function stats(rows: Row[]) {
  const v = rows.map((r) => r.oldestLatencySec);
  const n = rows.map((r) => r.newestLatencySec);
  return {
    batches: rows.length,
    roundsSettled: rows.reduce((a, r) => a + r.roundsSettled, 0),
    oldestLatency: { p50: percentile(v, 50), p90: percentile(v, 90), p99: percentile(v, 99), max: v.length ? Math.max(...v) : null },
    newestLatency: { p50: percentile(n, 50), p90: percentile(n, 90), max: n.length ? Math.max(...n) : null },
    warn: rows.filter((r) => r.severity === "WARN").length,
    crit: rows.filter((r) => r.severity === "CRIT").length,
  };
}

/** Per-UTC-day rollup. */
export function daily(rows: Row[]) {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const d = new Date(r.timestamp * 1000).toISOString().slice(0, 10);
    by.set(d, [...(by.get(d) ?? []), r]);
  }
  return [...by.entries()].map(([date, rs]) => ({ date, ...stats(rs) }));
}

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Record<string, unknown>[], cols: string[]) =>
  [cols.join(","), ...rows.map((r) => cols.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
export const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
