// Orchestrates one tracker run at ONE pinned finalized block:
// chain check -> verify deployment graph -> scan Core/Mining events -> block timestamps (cached) -> analysis.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAbiItem, type PublicClient } from "viem";
import { SqueekCoreAbi, SqueekMiningAbi } from "./abis";
import { checkChain, getLogsChunked, numEnv, required, resolveBlock, strict, verifyGraph } from "./chain";
import { buildAlerts, buildRows, daily, roundAt, stats, type Batch, type Config, type SimpleEvent } from "./latency";

const CACHE_DIR = new URL("../.cache/", import.meta.url);
const TS_CACHE = new URL("block-timestamps.json", CACHE_DIR);

/** Block timestamps for finalized blocks never change, so they are cached on disk. */
async function timestamps(client: PublicClient, blocks: bigint[]) {
  const cache: Record<string, number> = existsSync(TS_CACHE) ? JSON.parse(readFileSync(TS_CACHE, "utf8")) : {};
  const missing = [...new Set(blocks.map(String))].filter((b) => cache[b] === undefined);
  const save = () => { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(TS_CACHE, JSON.stringify(cache)); };
  const CONC = Number(process.env.RPC_CONCURRENCY ?? 4); // keep public RPCs under their rate limits
  for (let i = 0; i < missing.length; i += CONC) {
    const got = await Promise.all(missing.slice(i, i + CONC).map((b) => client.getBlock({ blockNumber: BigInt(b) })));
    got.forEach((blk) => (cache[String(blk.number)] = Number(blk.timestamp)));
    if (missing.length > 40 && (i / CONC) % 25 === 0) { save(); process.stderr.write(`  block timestamps ${Math.min(i + CONC, missing.length)}/${missing.length}\n`); }
  }
  if (missing.length) save();
  return cache;
}

export async function runTracker(client: PublicClient) {
  const chainId = await checkChain(client);
  const block = await resolveBlock(client);
  const blockNumber = block.number!;
  const graph = await verifyGraph(client, blockNumber);
  const from = BigInt(required("INDEX_FROM_BLOCK"));
  const ev = (abi: any, name: string) => getAbiItem({ abi, name });

  // Sequential on purpose: free public RPCs rate-limit bursts.
  const settled = await getLogsChunked(client, graph.core, ev(SqueekCoreAbi, "BatchSettled"), from, blockNumber);
  const paused = await getLogsChunked(client, graph.core, ev(SqueekCoreAbi, "Paused"), from, blockNumber);
  const unpaused = await getLogsChunked(client, graph.core, ev(SqueekCoreAbi, "Unpaused"), from, blockNumber);
  const checkpoints = await getLogsChunked(client, graph.mining, ev(SqueekMiningAbi, "Checkpointed"), from, blockNumber);
  const coreState = await client.readContract({ address: graph.core, abi: SqueekCoreAbi, functionName: "state", blockNumber });
  const miningState = await client.readContract({ address: graph.mining, abi: SqueekMiningAbi, functionName: "state", blockNumber });
  const ts = await timestamps(client, [...settled, ...paused, ...unpaused, ...checkpoints].map((l) => l.blockNumber!).concat(graph.reporter.rotations.map((r) => r.blockNumber)));
  const T = (b: bigint) => ts[String(b)];

  const batches: Batch[] = settled.map((l) => ({
    blockNumber: Number(l.blockNumber), timestamp: T(l.blockNumber), txHash: l.transactionHash, logIndex: l.logIndex,
    reporter: l.args.reporter, nonce: Number(l.args.nonce), previous: Number(l.args.previousSettledThroughRound),
    through: Number(l.args.settledThroughRound), activeRoundCount: Number(l.args.activeRoundCount),
    cumulativeWork: String(l.args.cumulativeWork), cumulativeBlockUnits: String(l.args.cumulativeBlockUnits),
  }));
  const events: SimpleEvent[] = [
    ...paused.map((l) => ({ kind: "PAUSED" as const, blockNumber: Number(l.blockNumber), timestamp: T(l.blockNumber), txHash: l.transactionHash, detail: `SqueekCore paused by ${l.args.account}` })),
    ...unpaused.map((l) => ({ kind: "UNPAUSED" as const, blockNumber: Number(l.blockNumber), timestamp: T(l.blockNumber), txHash: l.transactionHash, detail: `SqueekCore unpaused by ${l.args.account}` })),
    ...graph.reporter.rotations.map((r) => ({ kind: "REPORTER_ROTATED" as const, blockNumber: Number(r.blockNumber), timestamp: T(r.blockNumber), txHash: r.txHash, detail: `Reporter rotated ${r.previous} -> ${r.next}` })),
    ...checkpoints.map((l) => ({ kind: "CHECKPOINT" as const, blockNumber: Number(l.blockNumber), timestamp: T(l.blockNumber), txHash: l.transactionHash, detail: `Mining checkpoint through round ${l.args.throughRound}`, throughRound: Number(l.args.throughRound) })),
  ].sort((a, b) => a.blockNumber - b.blockNumber);

  const cfg: Config = {
    genesis: Number(graph.config.genesisTimestamp), roundDuration: Number(graph.config.roundDuration),
    warnSec: numEnv("LATENCY_WARN_SEC", 1800), critSec: numEnv("LATENCY_CRIT_SEC", 3600), gapWarnSec: numEnv("BATCH_GAP_WARN_SEC", 3600),
  };
  const rows = buildRows(cfg, batches);
  const frontier = Number(coreState.settledThroughRound);
  const last = rows.at(-1);
  if (last && last.through !== frontier) throw new Error(`Event replay (${last.through}) disagrees with state().settledThroughRound (${frontier})`);
  const now = { timestamp: Number(block.timestamp), blockNumber: Number(blockNumber), frontier, miningProcessed: Number(miningState.processedThroughRound) };
  const alerts = buildAlerts(cfg, rows, events, now);
  const dayAgo = now.timestamp - 86_400;
  const currentRound = roundAt(cfg, now.timestamp);

  return {
    meta: {
      chainId: Number(chainId), blockNumber: now.blockNumber, blockHash: block.hash, blockTimestamp: now.timestamp,
      rpcHost: new URL(required("RPC_URL")).host, strict: strict(), generatedAt: new Date().toISOString(),
      contracts: { core: graph.core, mining: graph.mining, token: graph.token, nft: graph.nft },
      coreImplementation: graph.coreId.implementation, coreVersion: Number(graph.coreId.codeVersion), miningVersion: Number(graph.miningId.codeVersion),
      reporter: { docs: graph.reporter.docs, current: graph.config.reporter, rotations: graph.reporter.rotations.length },
      thresholds: cfg,
    },
    now: {
      currentRound, frontier, closedUnsettled: Math.max(0, currentRound - 1 - frontier),
      oldestUnsettledWaitSec: currentRound - 1 > frontier ? now.timestamp - (cfg.genesis + (frontier + 1) * cfg.roundDuration) : 0,
      lastBatchAgeSec: last ? now.timestamp - last.timestamp : null, paused: coreState.paused,
      blockHeight: Number(coreState.blockHeight), miningProcessedThroughRound: now.miningProcessed,
      lastCheckpointAgeSec: events.filter((e) => e.kind === "CHECKPOINT").at(-1) ? now.timestamp - events.filter((e) => e.kind === "CHECKPOINT").at(-1)!.timestamp : null,
    },
    stats: { allTime: stats(rows), last24h: stats(rows.filter((r) => r.timestamp >= dayAgo)) },
    rows, alerts, daily: daily(rows), checkpoints: events.filter((e) => e.kind === "CHECKPOINT").length,
  };
}
export type TrackerResult = Awaited<ReturnType<typeof runTracker>>;
