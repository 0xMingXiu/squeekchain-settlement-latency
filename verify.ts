// CLI: npm run verify -> Quickstart deployment verification at one pinned finalized block (read-only).
import { checkChain, jsonSafe, makeClient, resolveBlock, verifyGraph } from "./src/chain";

const client = makeClient();
const chainId = await checkChain(client);
const block = await resolveBlock(client);
const g = await verifyGraph(client, block.number!);
console.log("✅ Squeekchain Sepolia deployment verified");
console.log(JSON.stringify(jsonSafe({
  chainId, blockNumber: block.number, blockHash: block.hash, abiRelease: "squeeks-sepolia-core3-mining6-001",
  core: g.core, mining: g.mining, token: g.token, nft: g.nft,
  coreImplementation: g.coreId.implementation, coreVersion: g.coreId.codeVersion, coreRuntimeHash: g.coreId.runtimeHash,
  miningImplementation: g.miningId.implementation, miningVersion: g.miningId.codeVersion, miningRuntimeHash: g.miningId.runtimeHash,
  reporter: { docs: g.reporter.docs, current: g.config.reporter, rotations: g.reporter.rotations },
}), null, 2));
