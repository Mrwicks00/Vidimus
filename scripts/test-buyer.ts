// Drives a real round-trip against a live server, acting as the paying buyer: hit /verify ->
// get 402 -> sign via the official OKX Payment SDK client (EIP-3009 transferWithAuthorization
// under the hood, no gas, no pre-approval) -> replay with the SDK-encoded payment header + a
// spec body -> print the verdict. Replaces the earlier hand-rolled EIP-3009 signing/base64url
// encoding (see git history) - same motivation as the server-side migration: stop hand-rolling
// the x402 wire format after repeated OKX.AI listing rejections traced to subtle bugs in it.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@okxweb3/x402-core/client";
import { x402HTTPClient } from "@okxweb3/x402-core/http";
import type { SettleResponse } from "@okxweb3/x402-core/types";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";

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
const NETWORK = `eip155:${chainId}` as const;

async function main() {
  const account = privateKeyToAccount(buyerKey);
  const chain = {
    id: chainId,
    name: `x-layer-${chainId}`,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402HTTPClient(new x402Client().register(NETWORK, new ExactEvmScheme(signer)));

  console.log(`Buyer address: ${account.address}`);
  console.log(`Requesting ${targetUrl} (no payment)...`);

  const first = await fetch(targetUrl, { method: "POST" });
  if (first.status !== 402) {
    throw new Error(`Expected 402, got ${first.status}: ${await first.text()}`);
  }
  const paymentRequired = client.getPaymentRequiredResponse((name) => first.headers.get(name));
  console.log("Got 402. accepts =", paymentRequired.accepts);

  const buyerBalance = await publicClient.getBalance({ address: account.address });
  if (buyerBalance === 0n) {
    console.warn("Warning: buyer wallet has no native gas token - fine for signing (EIP-3009 needs no buyer-side tx), but check if this is unexpected.");
  }

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeaders = client.encodePaymentSignatureHeader(paymentPayload);

  console.log("Replaying with the signed payment header and a spec body...");
  const second = await fetch(targetUrl, {
    method: "POST",
    headers: { ...paymentHeaders, "content-type": "application/json" },
    body: JSON.stringify(deliverable ? { spec, deliverable } : { spec }),
  });

  const body = await second.text();
  if (second.status !== 200) {
    throw new Error(`Replay failed: ${second.status} ${body}`);
  }

  const settlement: SettleResponse = client.getPaymentSettleResponse((name) => second.headers.get(name));

  console.log("\n--- SUCCESS ---");
  console.log("Settlement:", settlement);
  const verdict = JSON.parse(body);
  console.log(`Criteria compiled: ${verdict.criteria?.length ?? 0}`);
  console.log(JSON.stringify(verdict, null, 2));

  const receipt = await publicClient.getTransactionReceipt({ hash: settlement.transaction as `0x${string}` });
  console.log(`\nOn-chain confirmation: status=${receipt.status}, block=${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
