# sepolia-env.sh — copied verbatim from https://docs.squeekchain.com/developers/ (Environment file)
# and cross-checked against https://docs.squeekchain.com/assets/deployments/sepolia.json
# (release squeeks-sepolia-core3-mining6-001). Load with:  set -a; . ./sepolia-env.sh; set +a
EXPECTED_CHAIN_ID=11155111
CORE_ADDRESS=0x74665dAecA35A2303e767E76a2FF1FB6F93e119f
EXPECTED_CORE_IMPLEMENTATION=0x0a71c86ab63a77675002a389fdf4d096a07b11e2
EXPECTED_CORE_RUNTIME_HASH=0xe8a5a5aa913141ddd8951cf9fcc1375044b541773e5b0bf8ee04a5c7ac2d194d
EXPECTED_CORE_LAYOUT_DIGEST=0x9a9c008e029460808209571703fbf2679785874e0e6d3232f16a864d12abcb20
EXPECTED_CORE_PROXY_ADMIN=0x05a9af6c3f6780dd58168f2e145cdd0d64564a5e
MINING_ADDRESS=0x3beE588fC20dE788Bac17d33b41Da7346cb27EC4
EXPECTED_MINING_IMPLEMENTATION=0x08890b360c65fd878344bf6e23d1c36358433b4e
EXPECTED_MINING_RUNTIME_HASH=0x6097cf8e8f96ea654878ab0a35410240ab1b05668c08ce1b3f99e04116e88bc1
EXPECTED_MINING_LAYOUT_DIGEST=0xace564e9c052f30122779a32fdf3333ebce7cc708eae9c01cb7875b4f6ad37a6
EXPECTED_MINING_PROXY_ADMIN=0x7369d930f8dfb7a6657578eda5906d3472e4ac9a
SQK_ADDRESS=0x6872bfa5ccc3e9e440c6c16e5ffdabb8dba4cc76
NFT_ADDRESS=0x0eAF3E0d40A0a8E5a6Ac030b2459E9FB0B7905c6
INDEX_FROM_BLOCK=11902282
EXPECTED_TIMELOCK=0x6B35AB6E96EF292E4fdD3f15a4E812f3CA291844
EXPECTED_STREAM_ID=0xa0186b1a24b217f12f56c8574b492e286d00cd94bb5546cba45b048b19c60e44
EXPECTED_GENESIS_TIMESTAMP=1791847800
EXPECTED_GUARDIAN=0x0E1B21ED2fc5fc48E221D3E863f09589Cb490e73
EXPECTED_REPORTER=0xA663b5C05eAFa3e90bFbD3F7DEcdaaa3d41F5A75
EXPECTED_MAX_WORK_PER_ROUND=10000

# --- Local settings (not from docs) ---
# Sepolia RPC that serves historical state + eth_getLogs. Free public default (no key).
RPC_URL=${RPC_URL:-https://sepolia.gateway.tenderly.co}
# Snapshot block: "finalized" (default) pins the latest finalized Sepolia block, or set a block number.
ETHEREUM_BLOCK=${ETHEREUM_BLOCK:-finalized}
# Alert thresholds (seconds). Latency = time from a round closing to the BatchSettled tx that certifies it.
LATENCY_WARN_SEC=${LATENCY_WARN_SEC:-1800}
LATENCY_CRIT_SEC=${LATENCY_CRIT_SEC:-3600}
# Gap between two consecutive BatchSettled txs that triggers an alert.
BATCH_GAP_WARN_SEC=${BATCH_GAP_WARN_SEC:-3600}
# Max blocks per eth_getLogs request.
LOG_CHUNK=${LOG_CHUNK:-50000}
