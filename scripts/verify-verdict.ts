// The publishable "open verifier" (ROADMAP.md D4): given a Vidimus verdict JSON, checks it
// mechanically without trusting us. No SECURITY.md internals live here - safe to publish.
//
// Usage: npm run verify-verdict -- <verdict.json | ->
//
// Checks (docs/VERDICT_SPEC.md §5):
//   1. Recompute the canonical JSON (verdict minus `signature`) and recover the EIP-191
//      personal_sign signer from `signature`.
//   2. Recovered address === verdict.signer.address.
//   3. verdict.signer.address is the on-chain owner of verdict.signer.erc8004_id (X Layer,
//      read live via `onchainos agent get-agents`, not cached).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { recoverMessageAddress } from "viem";
import { canonicalize } from "../src/verdict/canonicalize.js";

const execFileAsync = promisify(execFile);

interface AgentDetail {
  agentId: string;
  ownerAddress: string;
  agentWalletAddress: string;
  chainIndex: number;
}
interface AgentGetResponse {
  ok: boolean;
  error?: string;
  data?: AgentDetail[];
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error("Usage: npm run verify-verdict -- <verdict.json | ->");
    process.exit(1);
  }
  const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const verdict = JSON.parse(raw);

  const { signature, ...verdictMinusSignature } = verdict;
  if (!signature) {
    console.log("FAIL: verdict has no `signature` field");
    process.exit(1);
  }

  const canonical = canonicalize(verdictMinusSignature);
  const recovered = await recoverMessageAddress({ message: canonical, signature });
  console.log(`Recovered signer:      ${recovered}`);
  console.log(`Claimed signer.address: ${verdict.signer?.address}`);

  const signatureMatches = recovered.toLowerCase() === String(verdict.signer?.address).toLowerCase();
  console.log(signatureMatches ? "PASS: signature recovers to claimed signer.address" : "FAIL: signature does NOT match signer.address");

  const erc8004Id = verdict.signer?.erc8004_id;
  const { stdout } = await execFileAsync("onchainos", ["agent", "get-agents", "--agent-ids", String(erc8004Id)]);
  const resp = JSON.parse(stdout) as AgentGetResponse;
  const onchainOwner = resp.data?.[0]?.ownerAddress;
  console.log(`On-chain owner of erc8004_id ${erc8004Id}: ${onchainOwner}`);

  const ownerMatches = !!onchainOwner && onchainOwner.toLowerCase() === String(verdict.signer?.address).toLowerCase();
  console.log(ownerMatches ? "PASS: signer.address matches the on-chain ERC-8004 identity owner" : "FAIL: signer.address does NOT match the on-chain identity owner");

  process.exit(signatureMatches && ownerMatches ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
