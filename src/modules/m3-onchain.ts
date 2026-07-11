// M3.A onchain verifier - VERIFICATION_MODULES.md M3.A, scope locked to the four Tier-1
// methods per docs/ROADMAP.md D3. All confidence 1.0 (Tier 1, VERDICT_SPEC §2.1).
//
// Reads real chain state via a direct viem RPC reader, not the OnchainOS CLI. Checked first:
// `onchainos wallet history --chain xlayer_test --tx-hash <hash>` against a real, confirmed
// X Layer testnet tx belonging to a wallet other than our CLI-logged-in account returned
// `{"data":[]}` - the command is scoped to the logged-in wallet's own order history, not a
// general arbitrary-tx-hash chain reader. No other installed skill (gateway/portfolio/token)
// exposes one either. That's the CLI genuinely unable to do this (L8) - a seller's claimed
// deliverable tx belongs to their wallet, never ours.
import { createPublicClient, http, type Address, type Hex, type TransactionReceipt } from "viem";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { isOnchainMethod, type Criterion, type Evidence, type OnchainMethod } from "../verdict/types.js";
import type { QuarantineRejection } from "../security/quarantine.js";

const execFileAsync = promisify(execFile);

const chain = {
  id: config.chainId,
  name: `x-layer-${config.chainId}`,
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
} as const;

// Exported (D5) so src/modules/m3-data.ts's sample_verify seed logic can read the chain tip
// block for the commit-after-delivery seed without standing up a second RPC client.
export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });

// keccak256("Transfer(address,address,uint256)") - standard, identical for ERC-20 and ERC-721.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

function topicToAddress(topic: Hex): Address {
  return `0x${topic.slice(26)}` as Address;
}

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface Transfer {
  kind: "native" | "erc20" | "erc721";
  asset: "native" | Address;
  from: Address;
  to: Address;
  amount?: bigint; // erc20 / native
  tokenId?: bigint; // erc721
}

async function readTransfers(txHash: Hex): Promise<{ receipt: TransactionReceipt; transfers: Transfer[] }> {
  const [tx, receipt] = await Promise.all([
    publicClient.getTransaction({ hash: txHash }),
    publicClient.getTransactionReceipt({ hash: txHash }),
  ]);

  const transfers: Transfer[] = [];
  if (tx.value > 0n && tx.to) {
    transfers.push({ kind: "native", asset: "native", from: tx.from, to: tx.to, amount: tx.value });
  }
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.topics.length === 4 && log.topics[1] && log.topics[2] && log.topics[3]) {
      // ERC-721: tokenId indexed, no data.
      transfers.push({
        kind: "erc721",
        asset: log.address,
        from: topicToAddress(log.topics[1]),
        to: topicToAddress(log.topics[2]),
        tokenId: BigInt(log.topics[3]),
      });
    } else if (log.topics.length === 3 && log.topics[1] && log.topics[2]) {
      // ERC-20: value in data, not indexed.
      transfers.push({
        kind: "erc20",
        asset: log.address,
        from: topicToAddress(log.topics[1]),
        to: topicToAddress(log.topics[2]),
        amount: BigInt(log.data),
      });
    }
  }
  return { receipt, transfers };
}

function evidence(kind: Evidence["kind"], ref: string, detail: string): Evidence {
  return { kind, ref, detail };
}

function withResult(c: Criterion, result: Criterion["result"], ev: Evidence): Criterion {
  return { ...c, result, confidence: result === "UNVERIFIABLE" ? null : 1.0, evidence: ev };
}

function unverifiable(c: Criterion, detail: string): Criterion {
  return withResult(c, "UNVERIFIABLE", evidence("none", "", detail));
}

// ---- Claim shapes (deliverable-provided, inert data - never instructions) ----

export interface TxExistsClaim {
  txHash: Hex;
}
export interface TransferCheckClaim {
  txHash: Hex;
  asset?: "native" | Address;
  amountMin?: string; // atomic units, base-10 string
}
export interface DestinationCheckClaim {
  txHash: Hex;
  destination: Address;
  asset?: "native" | Address;
}
export interface OwnerCheckClaim {
  txHash: Hex;
  asset: Address; // NFT contract
  tokenId: string;
  owner: Address;
}

// Safety scan claim - decoupled from config.chainId/config.rpcUrl on purpose: the
// `onchainos security` scanner covers a different chain set than our RPC reader does (X Layer
// testnet 1952, where the other four checkers read, is not in the scanner's supported-chain
// list at all - confirmed live; X Layer mainnet 196 is). VERIFICATION_MODULES.md M3.A's own
// "natively multi-chain" note licenses this: the safety leg of a job need not run on the same
// chain as the payment/tx-existence leg.
export interface SafetyTokenClaim {
  kind: "token";
  chain: string; // chain name or numeric id, per onchainos --chain / chainId:addr syntax
  tokenAddress: Address;
}
export interface SafetyTxClaim {
  kind: "tx";
  chain: string;
  from: Address;
  to?: Address;
  data?: Hex;
  value?: string; // wei, decimal string
}
export type SafetyCheckClaim = SafetyTokenClaim | SafetyTxClaim;

export interface OnchainDeliverable {
  "onchain.tx_exists"?: TxExistsClaim[];
  "onchain.transfer_check"?: TransferCheckClaim[];
  "onchain.destination_check"?: DestinationCheckClaim[];
  "onchain.owner_check"?: OwnerCheckClaim[];
  "onchain.safety"?: SafetyCheckClaim[];
}

// ---- Checkers ----

async function checkTxExists(c: Criterion, claim: TxExistsClaim): Promise<Criterion> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: claim.txHash });
    if (receipt.status === "success") {
      return withResult(
        c,
        "PASS",
        evidence("tx", claim.txHash, `tx ${claim.txHash} exists and is confirmed (block ${receipt.blockNumber})`),
      );
    }
    return withResult(c, "FAIL", evidence("tx", claim.txHash, `tx ${claim.txHash} exists but reverted (status: ${receipt.status})`));
  } catch {
    return unverifiable(c, `tx ${claim.txHash} not found on chain or chain unreachable`);
  }
}

async function checkTransfer(c: Criterion, claim: TransferCheckClaim): Promise<Criterion> {
  try {
    const { receipt, transfers } = await readTransfers(claim.txHash);
    if (receipt.status !== "success") {
      return unverifiable(c, `tx ${claim.txHash} did not succeed on chain - cannot verify a transfer within it`);
    }
    const wantNative = !claim.asset || claim.asset === "native";
    const matches = transfers.filter((t) =>
      wantNative ? t.kind === "native" : t.kind === "erc20" && sameAddr(t.asset, claim.asset!),
    );
    const total = matches.reduce((sum, t) => sum + (t.amount ?? 0n), 0n);
    const min = claim.amountMin ? BigInt(claim.amountMin) : 1n;
    const assetLabel = wantNative ? "native OKB" : claim.asset!;
    if (total >= min) {
      return withResult(
        c,
        "PASS",
        evidence("tx", claim.txHash, `${total} atomic units of ${assetLabel} moved in tx ${claim.txHash} (>= required ${min})`),
      );
    }
    return withResult(
      c,
      "FAIL",
      evidence("tx", claim.txHash, `only ${total} atomic units of ${assetLabel} moved in tx ${claim.txHash} (required >= ${min})`),
    );
  } catch {
    return unverifiable(c, `tx ${claim.txHash} not found on chain or chain unreachable`);
  }
}

async function checkDestination(c: Criterion, claim: DestinationCheckClaim): Promise<Criterion> {
  try {
    const { receipt, transfers } = await readTransfers(claim.txHash);
    if (receipt.status !== "success") {
      return unverifiable(c, `tx ${claim.txHash} did not succeed on chain - cannot verify its destination`);
    }
    const wantNative = !claim.asset || claim.asset === "native";
    const relevant = transfers.filter((t) =>
      wantNative ? t.kind === "native" : t.kind === "erc20" && sameAddr(t.asset, claim.asset!),
    );
    if (relevant.length === 0) {
      return unverifiable(c, `no matching asset transfer found in tx ${claim.txHash}`);
    }
    const matched = relevant.find((t) => sameAddr(t.to, claim.destination));
    if (matched) {
      return withResult(
        c,
        "PASS",
        evidence("tx", claim.txHash, `asset landed at the spec's destination ${claim.destination} in tx ${claim.txHash}`),
      );
    }
    const actual = relevant.map((t) => t.to).join(", ");
    return withResult(
      c,
      "FAIL",
      evidence("tx", claim.txHash, `asset landed at ${actual} in tx ${claim.txHash}, not the spec's destination ${claim.destination}`),
    );
  } catch {
    return unverifiable(c, `tx ${claim.txHash} not found on chain or chain unreachable`);
  }
}

async function checkOwner(c: Criterion, claim: OwnerCheckClaim): Promise<Criterion> {
  try {
    const { receipt, transfers } = await readTransfers(claim.txHash);
    if (receipt.status !== "success") {
      return unverifiable(c, `tx ${claim.txHash} did not succeed on chain - cannot verify resulting ownership`);
    }
    const tokenId = BigInt(claim.tokenId);
    const nftTransfers = transfers.filter(
      (t) => t.kind === "erc721" && sameAddr(t.asset, claim.asset) && t.tokenId === tokenId,
    );
    if (nftTransfers.length === 0) {
      return unverifiable(c, `no ERC-721 transfer of tokenId ${claim.tokenId} on ${claim.asset} found in tx ${claim.txHash}`);
    }
    const resultingOwner = nftTransfers[nftTransfers.length - 1]!.to;
    if (sameAddr(resultingOwner, claim.owner)) {
      return withResult(
        c,
        "PASS",
        evidence("tx", claim.txHash, `tokenId ${claim.tokenId} on ${claim.asset} resulted in owner ${resultingOwner}, matching the spec`),
      );
    }
    return withResult(
      c,
      "FAIL",
      evidence(
        "tx",
        claim.txHash,
        `tokenId ${claim.tokenId} on ${claim.asset} resulted in owner ${resultingOwner}, not the spec's ${claim.owner}`,
      ),
    );
  } catch {
    return unverifiable(c, `tx ${claim.txHash} not found on chain or chain unreachable`);
  }
}

// ---- Row ground-truth (reused by M3.B data.sample_verify, D5) ----
//
// A sampled dataset row claims a mint happened - same fact shape `checkOwner` already checks,
// minus the Criterion plumbing (sample_verify aggregates many of these into one criterion
// result, it doesn't have a 1:1 criterion per row). Exported so m3-data.ts doesn't reimplement
// chain-fact reading; the sampling/seed logic lives entirely in m3-data.ts, this function only
// ever answers "is this one row's claim true."

export interface RowGroundTruthClaim {
  txHash: Hex;
  owner?: Address;
  tokenId?: string;
  asset?: Address;
}

export interface RowGroundTruthResult {
  // "verified" = row's claim confirmed true (independent evidence). "mismatch" = we have
  // evidence the row's claim is false (a caught fake - drives sample_verify to FAIL, never
  // PARTIAL, per SECURITY.md §4). "blocked" = couldn't get evidence either way.
  status: "verified" | "mismatch" | "blocked";
  detail: string;
}

export async function verifyRowGroundTruth(claim: RowGroundTruthClaim): Promise<RowGroundTruthResult> {
  try {
    const { receipt, transfers } = await readTransfers(claim.txHash);
    if (receipt.status !== "success") {
      return { status: "blocked", detail: `tx ${claim.txHash} did not succeed on chain` };
    }
    if (claim.owner && claim.tokenId && claim.asset) {
      const tokenId = BigInt(claim.tokenId);
      const nftTransfers = transfers.filter(
        (t) => t.kind === "erc721" && sameAddr(t.asset, claim.asset!) && t.tokenId === tokenId,
      );
      if (nftTransfers.length === 0) {
        return {
          status: "blocked",
          detail: `no ERC-721 transfer of tokenId ${claim.tokenId} on ${claim.asset} found in tx ${claim.txHash}`,
        };
      }
      const resultingOwner = nftTransfers[nftTransfers.length - 1]!.to;
      if (!sameAddr(resultingOwner, claim.owner)) {
        return {
          status: "mismatch",
          detail: `tx ${claim.txHash}: tokenId ${claim.tokenId} resulted in owner ${resultingOwner}, not the row's claimed ${claim.owner}`,
        };
      }
      return {
        status: "verified",
        detail: `tx ${claim.txHash}: tokenId ${claim.tokenId} owner ${resultingOwner} matches the row's claim`,
      };
    }
    return { status: "verified", detail: `tx ${claim.txHash} exists and is confirmed (block ${receipt.blockNumber})` };
  } catch {
    return { status: "blocked", detail: `tx ${claim.txHash} not found on chain or chain unreachable` };
  }
}

// ---- Safety (onchain.safety, via `onchainos security`) ----
//
// Subcontracts the okx-agentic-wallet skill's bundled `security token-scan`/`tx-scan`
// commands (see .agents/skills/okx-agentic-wallet/references/security*.md). Live-tested
// against the real API before writing this: both commands return a genuinely graded verdict
// (token-scan: riskLevel CRITICAL/HIGH/MEDIUM/LOW backed by ~20 heuristic boolean labels;
// tx-scan: action ""/warn/block backed by named risk items, confirmed live returning a real
// "warn" for a heuristic caution, not just doc-described). Per VERDICT_SPEC §2.1 (Tier 1 ==
// confidence exactly 1.0 or demote it), only the scanner's own definitive buckets - CRITICAL /
// block (malicious pattern, blacklist hit, honeypot simulation) and LOW / safe (no risk
// signal) - are asserted as PASS/FAIL. The graded middle (MEDIUM/HIGH/warn) is a heuristic
// caution, not a mechanical fact, and is left UNVERIFIABLE rather than forced into a Tier-2
// confidence number the project has no CalibrationLog to back yet (that's D6).
//
// The CLI has no `--format json` flag (Session 3 finding, still true on v4.2.2) - default
// stdout is already JSON, so none is passed. Invoked via execFile (argv array, no shell) so
// claim fields - deliverable-provided, inert data per the dual-pass discipline - can never be
// interpreted as shell syntax.

interface TokenScanResult {
  riskLevel?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  isChainSupported?: boolean;
  [label: string]: unknown;
}
interface TokenScanResponse {
  ok: boolean;
  error?: string;
  data?: TokenScanResult[];
}
interface TxScanRiskItem {
  name: string;
  description?: { en?: string };
}
interface TxScanResponse {
  ok: boolean;
  error?: string;
  data?: { action: "" | "warn" | "block"; riskItemDetail?: TxScanRiskItem[] };
}

const TOKEN_RISK_LABELS = [
  "isHoneypot",
  "isRubbishAirdrop",
  "isAirdropScam",
  "isHasAssetEditAuth",
  "isLowLiquidity",
  "isDumping",
  "isLiquidityRemoval",
  "isPump",
  "isWash",
  "isFakeLiquidity",
  "isWash2",
  "isFundLinkage",
  "isVeryLowLpBurn",
  "isVeryHighLpHolderProp",
  "isHasBlockingHis",
  "isOverIssued",
  "isCounterfeit",
  "isNotOpenSource",
  "isMintable",
  "isHasFrozenAuth",
  "isNotRenounced",
] as const;

async function runOnchainos(args: string[]): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const { stdout } = await execFileAsync("onchainos", args);
  return JSON.parse(stdout);
}

async function checkSafetyToken(c: Criterion, claim: SafetyTokenClaim): Promise<Criterion> {
  const resp = (await runOnchainos([
    "security",
    "token-scan",
    "--tokens",
    `${claim.chain}:${claim.tokenAddress}`,
  ])) as TokenScanResponse;
  if (!resp.ok) {
    return unverifiable(c, `security token-scan unavailable: ${resp.error ?? "unknown error"}`);
  }
  const result = resp.data?.[0];
  if (!result || result.isChainSupported === false) {
    return unverifiable(c, `token ${claim.tokenAddress}: chain ${claim.chain} not supported by the security scanner`);
  }
  const triggered = TOKEN_RISK_LABELS.filter((label) => result[label] === true);
  const labelText = triggered.length > 0 ? triggered.join(", ") : "flagged by composite analysis, no specific label identified";
  if (result.riskLevel === "CRITICAL") {
    return withResult(
      c,
      "FAIL",
      evidence("tx", claim.tokenAddress, `token-scan: riskLevel CRITICAL on ${claim.tokenAddress} (chain ${claim.chain}) - ${labelText}`),
    );
  }
  if (result.riskLevel === "LOW") {
    return withResult(
      c,
      "PASS",
      evidence("tx", claim.tokenAddress, `token-scan: riskLevel LOW on ${claim.tokenAddress} (chain ${claim.chain}), no risk labels triggered`),
    );
  }
  return unverifiable(
    c,
    `token-scan: riskLevel ${result.riskLevel ?? "unknown"} on ${claim.tokenAddress} - graded heuristic risk (${labelText}), not a definitive safety fact`,
  );
}

async function checkSafetyTx(c: Criterion, claim: SafetyTxClaim): Promise<Criterion> {
  const args = ["security", "tx-scan", "--chain", claim.chain, "--from", claim.from];
  if (claim.to) args.push("--to", claim.to);
  if (claim.data) args.push("--data", claim.data);
  if (claim.value) args.push("--value", claim.value);
  const resp = (await runOnchainos(args)) as TxScanResponse;
  if (!resp.ok) {
    return unverifiable(c, `security tx-scan unavailable: ${resp.error ?? "unknown error"}`);
  }
  const { action, riskItemDetail } = resp.data ?? { action: "" as const };
  const ref = claim.to ?? claim.from;
  const names = (riskItemDetail ?? []).map((r) => r.name).join(", ");
  if (action === "block") {
    return withResult(c, "FAIL", evidence("tx", ref, `tx-scan: action BLOCK on chain ${claim.chain} - ${names}`));
  }
  if (action === "") {
    return withResult(c, "PASS", evidence("tx", ref, `tx-scan: no risk detected on chain ${claim.chain}`));
  }
  return unverifiable(c, `tx-scan: action WARN on chain ${claim.chain} - ${names} - graded heuristic risk, not a definitive safety fact`);
}

async function checkSafety(c: Criterion, claim: SafetyCheckClaim): Promise<Criterion> {
  try {
    return claim.kind === "token" ? await checkSafetyToken(c, claim) : await checkSafetyTx(c, claim);
  } catch (err) {
    return unverifiable(c, `security scan failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

const CHECKERS: Record<OnchainMethod, (c: Criterion, claim: any) => Promise<Criterion>> = {
  "onchain.tx_exists": checkTxExists,
  "onchain.transfer_check": checkTransfer,
  "onchain.destination_check": checkDestination,
  "onchain.owner_check": checkOwner,
  "onchain.safety": checkSafety,
};

// D4.5 (docs/VERDICT_SPEC.md §2): dispatches every criterion that carries a `locator` to its
// checker, resolving the locator against `deliverable`'s claim array for `locator.method` at
// `locator.index`. The locator was assigned by the M2 compiler at criteria-compile time (see
// m2-criteria-compiler.ts `assignLocators`) - this function only resolves it, it never
// (re)computes which slot a criterion binds to. Criteria with no `locator`, or a locator whose
// `method` isn't one of the five onchain methods (D5: `locator.method` widened to
// `LocatableMethod` - it may address the M3.B data bucket instead, which `applyDataChecks` in
// m3-data.ts handles; this function only touches its own family), pass through untouched. A
// locator that doesn't resolve (missing claim, index out of range, or quarantine rejected that
// exact slot) stays UNVERIFIABLE
// (blocked, not failed - VERIFICATION_MODULES.md M3.A determinism note); it never binds more
// than one claim (an array index denotes at most one element by construction).
//
// `deliverable` must already be the SEALED output of `quarantineDeliverable` (src/security/
// quarantine.ts) - this function is Pass 2 (SECURITY.md §2.4: scoring never touches raw input,
// only what quarantine/Pass-1 extraction already validated). `rejections` carries the specific
// claims quarantine dropped for schema failure, so the resulting UNVERIFIABLE evidence says
// "quarantine rejected a malformed/suspicious claim" rather than the ambiguous "buyer forgot
// to include one" - the real checker function is never invoked on rejected input.
export async function applyOnchainChecks(
  criteria: Criterion[],
  deliverable: OnchainDeliverable | undefined,
  rejections: QuarantineRejection[] = [],
): Promise<Criterion[]> {
  const rejectionByKey = new Map(rejections.map((r) => [`${r.method}[${r.index}]`, r]));

  return Promise.all(
    criteria.map((c) => {
      const locator = c.locator;
      if (!locator || !isOnchainMethod(locator.method)) return c;
      const { method, index } = locator;
      const rejection = rejectionByKey.get(`${method}[${index}]`);
      if (rejection) {
        return unverifiable(c, rejection.reason);
      }
      const claim = deliverable?.[method]?.[index];
      if (!claim) {
        return unverifiable(c, `locator did not resolve: no onchain claim submitted at ${method}[${index}]`);
      }
      return CHECKERS[method](c, claim);
    }),
  );
}
