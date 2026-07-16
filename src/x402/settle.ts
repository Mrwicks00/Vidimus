import { createPublicClient, createWalletClient, http, hexToSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import type { AcceptsEntry, Eip3009Authorization, PaymentResponse } from "./types.js";
import { EIP3009_ABI } from "./eip3009.js";
import { markNonceUsed } from "./nonceStore.js";

const account = privateKeyToAccount(config.facilitatorPrivateKey);
const chain = {
  id: config.chainId,
  name: `x-layer-${config.chainId}`,
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
} as const;

const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(config.rpcUrl) });

export async function settlePayment(
  auth: Eip3009Authorization,
  signature: `0x${string}`,
  accepted: AcceptsEntry,
): Promise<PaymentResponse> {
  // EIP-3009 signs directly against the token - no intermediary contract, no pre-approval step.
  // The signed authorization is a single packed 65-byte (r,s,v) signature; the token's own
  // transferWithAuthorization takes the split form.
  const { r, s, v } = hexToSignature(signature);

  const txHash = await walletClient.writeContract({
    address: accepted.asset,
    abi: EIP3009_ABI,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, Number(v), r, s],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`settlement transaction reverted: ${txHash}`);
  }

  markNonceUsed(auth.from, auth.nonce);

  return {
    status: "success",
    transaction: txHash,
    amount: accepted.amount,
    payer: auth.from,
  };
}

export function encodePaymentResponseHeader(res: PaymentResponse): string {
  return Buffer.from(JSON.stringify(res), "utf8").toString("base64url");
}
