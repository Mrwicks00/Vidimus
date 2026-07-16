// Drives a real round-trip against a live server, acting as the paying buyer: hit /verify ->
// get 402 -> decode accepts -> sign an EIP-3009 transferWithAuthorization directly against the
// token's own EIP-712 domain (no intermediary contract, no pre-approval step) -> replay with
// PAYMENT-SIGNATURE + a spec body -> print the verdict. Replaces the earlier Permit2-based
// flow (see git history) - real OKX-ecosystem payment tooling defaults to Permit2's
// witness-augmented variant, which this project has no documented way to verify safely;
// EIP-3009 is simpler, well-documented, and what real third-party agents use in practice.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements, Eip3009Authorization, PaymentSignatureHeader, PaymentResponse } from "../src/x402/types.js";
import { EIP3009_TRANSFER_TYPES, eip3009Domain } from "../src/x402/eip3009.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const targetUrl = process.argv[2];
if (!targetUrl) {
  console.error("Usage: npm run test-buyer -- <https://tunnel-url>/verify [spec-file]");
  process.exit(1);
}

const DEFAULT_SPEC = `Mint an NFT on X Layer for our new "Sunset Riders" collection.

Requirements:
- Deploy an ERC-721 contract with the name "Sunset Riders" and symbol "SNRD".
- Mint exactly 1 token (tokenId 1) to our team wallet 0x2085D86C5EC584f337738E9AA8A0c566Fe86f0a9.
- The token's metadata URI must point to an image we already uploaded to IPFS; the trait list
  must include "Background", "Rider", and "Sky" attributes.
- The mint transaction must succeed on X Layer testnet (chainId 1952) and be confirmed
  (not just submitted).
- Total gas spent on the mint should be reasonable for a single ERC-721 mint - flag it if it
  looks like something else (e.g. a batch mint or an unrelated contract call) got charged
  against this job instead.`;

const specPath = process.argv[3];
const spec = specPath ? readFileSync(specPath, "utf8") : DEFAULT_SPEC;

const deliverablePath = process.argv[4];
const deliverable = deliverablePath ? JSON.parse(readFileSync(deliverablePath, "utf8")) : undefined;

const rpcUrl = required("RPC_URL");
const chainId = Number(process.env.CHAIN_ID ?? 1952);
const buyerKey = required("TEST_BUYER_PRIVATE_KEY") as `0x${string}`;

async function main() {
  const account = privateKeyToAccount(buyerKey);
  const chain = {
    id: chainId,
    name: `x-layer-${chainId}`,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log(`Buyer address: ${account.address}`);
  console.log(`Requesting ${targetUrl} (no payment)...`);

  const first = await fetch(targetUrl, { method: "POST" });
  if (first.status !== 402) {
    throw new Error(`Expected 402, got ${first.status}: ${await first.text()}`);
  }
  const requirements = (await first.json()) as PaymentRequirements;
  const accepted = requirements.accepts[0];
  console.log("Got 402. accepts[0] =", accepted);

  const buyerBalance = await publicClient.getBalance({ address: account.address });
  if (buyerBalance === 0n) {
    console.warn("Warning: buyer wallet has no native gas token - fine for signing (EIP-3009 needs no buyer-side tx), but check if this is unexpected.");
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = 0n;
  const validBefore = nowSeconds + BigInt(accepted.maxTimeoutSeconds);
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;

  const signature = await walletClient.signTypedData({
    domain: eip3009Domain(accepted.extra.name, accepted.extra.version, chainId, accepted.asset),
    types: EIP3009_TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: accepted.payTo,
      value: BigInt(accepted.amount),
      validAfter,
      validBefore,
      nonce,
    },
  });

  const auth: Eip3009Authorization = {
    from: account.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };
  const header: PaymentSignatureHeader = {
    x402Version: 2,
    payload: { authorization: auth, signature },
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");

  console.log("Replaying with PAYMENT-SIGNATURE and a spec body...");
  const second = await fetch(targetUrl, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": encodedHeader, "content-type": "application/json" },
    body: JSON.stringify(deliverable ? { spec, deliverable } : { spec }),
  });

  const body = await second.text();
  if (second.status !== 200) {
    throw new Error(`Replay failed: ${second.status} ${body}`);
  }

  const responseHeader = second.headers.get("PAYMENT-RESPONSE");
  if (!responseHeader) throw new Error("200 response missing PAYMENT-RESPONSE header");
  const settlement = JSON.parse(Buffer.from(responseHeader, "base64url").toString("utf8")) as PaymentResponse;

  console.log("\n--- SUCCESS ---");
  console.log("Settlement:", settlement);
  const verdict = JSON.parse(body);
  console.log(`Criteria compiled: ${verdict.criteria?.length ?? 0}`);
  console.log(JSON.stringify(verdict, null, 2));

  const receipt = await publicClient.getTransactionReceipt({ hash: settlement.transaction });
  console.log(`\nOn-chain confirmation: status=${receipt.status}, block=${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
