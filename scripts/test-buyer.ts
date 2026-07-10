// Drives the real D1/D2 round-trip against a live server, acting as the paying buyer:
// hit /verify -> get 402 -> decode accepts -> approve Permit2 (first run only) -> sign
// PermitTransferFrom -> replay with PAYMENT-SIGNATURE + a spec body -> print the verdict.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements, Permit2Authorization, PaymentSignatureHeader, PaymentResponse } from "../src/x402/types.js";
import { ERC20_ABI, PERMIT2_ADDRESS, permit2Domain, PERMIT2_TRANSFER_TYPES } from "../src/x402/permit2.js";

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

  const buyerOkbBalance = await publicClient.getBalance({ address: account.address });
  if (buyerOkbBalance === 0n) {
    throw new Error("Buyer wallet has no OKB for the Permit2 approve tx - fund it first.");
  }

  const currentAllowance = await publicClient.readContract({
    address: accepted.asset,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, PERMIT2_ADDRESS],
  });
  if (currentAllowance < BigInt(accepted.amount)) {
    console.log("Approving Permit2 to spend the payment token (one-time)...");
    const approveTx = await walletClient.writeContract({
      address: accepted.asset,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`Approved (tx ${approveTx}).`);
  } else {
    console.log("Permit2 already approved for this token.");
  }

  const nonce = BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`) % (2n ** 250n);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + accepted.maxTimeoutSeconds);

  const signature = await walletClient.signTypedData({
    domain: permit2Domain(chainId),
    types: PERMIT2_TRANSFER_TYPES,
    primaryType: "PermitTransferFrom",
    message: {
      permitted: { token: accepted.asset, amount: BigInt(accepted.amount) },
      spender: accepted.payTo,
      nonce,
      deadline,
    },
  });

  const auth: Permit2Authorization = {
    owner: account.address,
    permitted: { token: accepted.asset, amount: accepted.amount },
    spender: accepted.payTo,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signature,
  };
  const header: PaymentSignatureHeader = {
    x402Version: 2,
    scheme: "exact",
    network: accepted.network,
    payload: { permit2Authorization: auth },
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");

  console.log("Replaying with PAYMENT-SIGNATURE and a spec body...");
  const second = await fetch(targetUrl, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": encodedHeader, "content-type": "application/json" },
    body: JSON.stringify({ spec }),
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
