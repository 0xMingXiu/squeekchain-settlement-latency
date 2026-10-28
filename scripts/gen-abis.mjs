// Generates src/abis.ts from the official ABI JSON files in ./abi (as const for viem type inference).
import { readFileSync, writeFileSync } from "node:fs";
const names = ["SqueekCore", "SqueekMining", "SqueekToken", "SqueekNFT"];
let out = "// AUTO-GENERATED from ./abi/*.json (official https://docs.squeekchain.com/assets/abi/). Do not edit.\n";
for (const n of names) {
  const abi = JSON.parse(readFileSync(new URL(`../abi/${n}.json`, import.meta.url), "utf8"));
  out += `export const ${n}Abi = ${JSON.stringify(abi)} as const;\n`;
}
writeFileSync(new URL("../src/abis.ts", import.meta.url), out);
console.log("wrote src/abis.ts");
