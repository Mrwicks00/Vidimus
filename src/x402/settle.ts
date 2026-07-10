import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import type { AcceptsEntry, Permit2Authorization, PaymentResponse } from "./types.js";
import { PERMIT2_ABI, PERMIT2_ADDRESS } from "./permit2.js";
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
  auth: Permit2Authorization,
  accepted: AcceptsEntry,
): Promise<PaymentResponse> {
  const txHash = await walletClient.writeContract({
    address: PERMIT2_ADDRESS,
    abi: PERMIT2_ABI,
    functionName: "permitTransferFrom",
    args: [
      {
        permitted: {
          token: auth.permitted.token,
          amount: BigInt(auth.permitted.amount),
        },
        nonce: BigInt(auth.nonce),
        deadline: BigInt(auth.deadline),
      },
      {
        to: accepted.payTo,
        requestedAmount: BigInt(accepted.amount),
      },
      auth.owner,
      auth.signature,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`settlement transaction reverted: ${txHash}`);
  }

  markNonceUsed(auth.owner, auth.nonce);

  return {
    status: "success",
    transaction: txHash,
    amount: accepted.amount,
    payer: auth.owner,
  };
}

export function encodePaymentResponseHeader(res: PaymentResponse): string {
  return Buffer.from(JSON.stringify(res), "utf8").toString("base64url");
}
