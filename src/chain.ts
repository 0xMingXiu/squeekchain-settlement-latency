// Shared read-only chain helpers: env, chain-ID check, pinned block, deployment verification.
// Adapted from the official Quickstart (https://docs.squeekchain.com/developers/quickstart/).
// No wallet, no private key — only eth_call / eth_getStorageAt / eth_getCode / eth_getLogs.
import { createPublicClient, getAbiItem, getAddress, http, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { SqueekCoreAbi, SqueekMiningAbi, SqueekTokenAbi } from "./abis";

export const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Supply ${name} (run through ./env.sh or npm scripts)`);
  return value;
};
export const numEnv = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
export const strict = () => !!process.env.SQUEEK_STRICT;

export const makeClient = () =>
  createPublicClient({ transport: http(required("RPC_URL"), { retryCount: 6, retryDelay: 800, timeout: 30_000 }) }) as PublicClient;

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const proxyAdminAbi = parseAbi(["function owner() view returns (address)"]);
const slotAddress = (word: Hex | undefined) => getAddress(`0x${(word ?? "0x").slice(-40)}`);
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function checkChain(client: PublicClient) {
  const chainId = BigInt(await client.getChainId());
  if (chainId !== BigInt(required("EXPECTED_CHAIN_ID"))) throw new Error(`Chain mismatch: got ${chainId}`);
  return chainId;
}

export async function resolveBlock(client: PublicClient) {
  const raw = (process.env.ETHEREUM_BLOCK ?? "").trim();
  if (raw && /^\d+$/.test(raw)) return client.getBlock({ blockNumber: BigInt(raw) });
  return client.getBlock({ blockTag: (raw || "finalized") as "finalized" | "safe" | "latest" });
}

async function verifyProxy(client: PublicClient, blockNumber: bigint, name: "CORE" | "MINING", version: bigint) {
  const proxy = getAddress(required(`${name}_ADDRESS`));
  const abi = name === "CORE" ? SqueekCoreAbi : SqueekMiningAbi;
  const implementation = slotAddress(await client.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT, blockNumber }));
  const admin = slotAddress(await client.getStorageAt({ address: proxy, slot: ADMIN_SLOT, blockNumber }));
  const adminOwner = await client.readContract({ address: admin, abi: proxyAdminAbi, functionName: "owner", blockNumber });
  const code = await client.getCode({ address: implementation, blockNumber });
  const read = { address: proxy, abi, blockNumber } as const;
  const [reported, codeVersion, layout] = await Promise.all([
    client.readContract({ ...read, functionName: "implementationCodeAddress" }) as Promise<Address>,
    client.readContract({ ...read, functionName: "implementationCodeVersion" }) as Promise<bigint>,
    client.readContract({ ...read, functionName: "implementationStorageLayoutDigest" }) as Promise<Hex>,
  ]);
  const runtimeHash = code ? keccak256(code) : undefined;
  const checks: Record<string, boolean> = {
    implementation: same(implementation, required(`EXPECTED_${name}_IMPLEMENTATION`)),
    reportedImplementation: same(reported, implementation),
    runtimeHash: !!runtimeHash && same(runtimeHash, required(`EXPECTED_${name}_RUNTIME_HASH`)),
    proxyAdmin: same(admin, required(`EXPECTED_${name}_PROXY_ADMIN`)),
    layoutDigest: same(layout, required(`EXPECTED_${name}_LAYOUT_DIGEST`)),
    adminOwnedByTimelock: same(adminOwner, required("EXPECTED_TIMELOCK")),
    implementationVersion: codeVersion === version,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) throw new Error(`${name}: deployment does not match the approved record (${failed.join(", ")})`);
  return { proxy, implementation, runtimeHash: runtimeHash!, layout, codeVersion };
}

export type ReporterRotation = { blockNumber: bigint; txHash: Hex; previous: Address; next: Address };

/**
 * Resolve the reporter the Core SHOULD have at `blockNumber`: start from the documented reporter and follow
 * every onchain ReporterUpdated event (only the Guardian can emit it). The chain must be unbroken.
 * In strict mode (SQUEEK_STRICT=1) no rotation is followed — the docs value must match exactly.
 */
export async function resolveReporter(client: PublicClient, blockNumber: bigint) {
  const docs = getAddress(required("EXPECTED_REPORTER"));
  const core = getAddress(required("CORE_ADDRESS"));
  if (strict()) return { docs, expected: docs, rotations: [] as ReporterRotation[] };
  const logs = await getLogsChunked(client, core, getAbiItem({ abi: SqueekCoreAbi, name: "ReporterUpdated" }), BigInt(required("INDEX_FROM_BLOCK")), blockNumber);
  let expected = docs;
  const rotations: ReporterRotation[] = [];
  for (const l of logs) {
    const { previousReporter, newReporter } = l.args as { previousReporter: Address; newReporter: Address };
    // initialize() emits ReporterUpdated(0x0 -> documented reporter): an initial assignment, not a rotation.
    if (rotations.length === 0 && /^0x0{40}$/i.test(previousReporter)) {
      if (!same(newReporter, docs)) throw new Error(`Initial reporter ${newReporter} is not the documented reporter`);
      continue;
    }
    if (!same(previousReporter, expected)) throw new Error(`Reporter rotation chain broken at block ${l.blockNumber}`);
    rotations.push({ blockNumber: l.blockNumber!, txHash: l.transactionHash!, previous: previousReporter, next: newReporter });
    expected = getAddress(newReporter);
  }
  const docsWasReporter = await client.readContract({ address: core, abi: SqueekCoreAbi, functionName: "hasEverBeenReporter", args: [docs], blockNumber });
  if (!docsWasReporter) throw new Error("Documented reporter was never a reporter on this Core");
  return { docs, expected, rotations };
}

/** Quickstart verifyGraph, with the reporter check driven by resolveReporter(). Throws on any mismatch. */
export async function verifyGraph(client: PublicClient, blockNumber: bigint) {
  const coreId = await verifyProxy(client, blockNumber, "CORE", 3n);
  const miningId = await verifyProxy(client, blockNumber, "MINING", 6n);
  const core = coreId.proxy, mining = miningId.proxy;
  const token = getAddress(required("SQK_ADDRESS"));
  const nft = getAddress(required("NFT_ADDRESS"));
  const [miningCore, tokenMining, policy, config, reporter] = await Promise.all([
    client.readContract({ address: mining, abi: SqueekMiningAbi, functionName: "core", blockNumber }),
    client.readContract({ address: token, abi: SqueekTokenAbi, functionName: "mining", blockNumber }),
    client.readContract({ address: mining, abi: SqueekMiningAbi, functionName: "collectionPolicy", args: [0], blockNumber }),
    client.readContract({ address: core, abi: SqueekCoreAbi, functionName: "configuration", blockNumber }),
    resolveReporter(client, blockNumber),
  ]);
  if (!same(miningCore as string, core) || !same(tokenMining as string, mining) || !same((policy as { nft: string }).nft, nft)) {
    throw new Error("Contracts are not connected as one graph");
  }
  if (
    !same(config.streamId, required("EXPECTED_STREAM_ID")) ||
    config.genesisTimestamp !== BigInt(required("EXPECTED_GENESIS_TIMESTAMP")) ||
    !same(config.guardian, required("EXPECTED_GUARDIAN")) ||
    !same(config.reporter, reporter.expected) ||
    config.maxWorkPerRound !== BigInt(required("EXPECTED_MAX_WORK_PER_ROUND"))
  ) throw new Error(`SqueekCore configuration does not match the launch configuration${strict() ? " (strict mode: docs reporter only)" : ""}`);
  return { core, mining, token, nft, coreId, miningId, config, reporter };
}

/** eth_getLogs in fixed-size chunks (LOG_CHUNK), halving the chunk on provider range errors. */
export async function getLogsChunked(client: PublicClient, address: Address, event: any, from: bigint, to: bigint) {
  let step = BigInt(numEnv("LOG_CHUNK", 50_000));
  const out: any[] = [];
  for (let start = from; start <= to; ) {
    const end = start + step - 1n > to ? to : start + step - 1n;
    try {
      out.push(...(await client.getLogs({ address, event, fromBlock: start, toBlock: end, strict: true })));
      start = end + 1n;
    } catch (e) {
      if (step <= 500n) throw e;
      step /= 2n;
    }
  }
  return out;
}

/** Recursively stringify bigints for JSON. */
export const jsonSafe = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString()
  : Array.isArray(v) ? v.map(jsonSafe)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]))
  : v;
