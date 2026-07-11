// M7 signing. docs/VERDICT_SPEC.md §5 (see the D4 correction there): the signing key is
// TEE-secured in the OKX Agentic Wallet and can only be reached via `onchainos wallet
// sign-message` - EIP-191 personal_sign or EIP-712, never a raw-digest ECDSA op. We sign the
// canonical JSON string directly with `--type personal`; this is a standard EIP-191
// personal_sign, recoverable with any EIP-191-aware library (see scripts/verify-verdict.ts).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keccak256, toBytes } from "viem";
import { config } from "../config.js";
import { canonicalize } from "./canonicalize.js";
import type { Verdict } from "./types.js";

const execFileAsync = promisify(execFile);

interface SignMessageResponse {
  ok: boolean;
  error?: string;
  data?: { signature: string };
}

export interface SignedVerdict {
  signature: string;
  digest: string;
}

const SIGN_MAX_ATTEMPTS = 3;
const SIGN_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function signVerdict(verdictMinusSignature: Omit<Verdict, "signature">): Promise<SignedVerdict> {
  const canonical = canonicalize(verdictMinusSignature);
  const digest = keccak256(toBytes(canonical));

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= SIGN_MAX_ATTEMPTS; attempt++) {
    const { stdout } = await execFileAsync("onchainos", [
      "wallet",
      "sign-message",
      "--chain",
      "196",
      "--from",
      config.erc8004Address,
      "--type",
      "personal",
      "--message",
      canonical,
    ]);

    const resp = JSON.parse(stdout) as SignMessageResponse;
    if (resp.ok && resp.data?.signature) {
      return { signature: resp.data.signature, digest };
    }
    lastError = resp.error ?? "unknown error";
    // Transient DNS/network blips against the OKX gateway are observed in practice (not a code
    // bug - the CLI itself reports "Network unavailable... dns error") - retry a couple of
    // times before giving up rather than 500ing every paid call on a blip.
    if (attempt < SIGN_MAX_ATTEMPTS) await sleep(SIGN_RETRY_DELAY_MS * attempt);
  }

  throw new Error(`signVerdict: wallet sign-message failed after ${SIGN_MAX_ATTEMPTS} attempts: ${lastError}`);
}
