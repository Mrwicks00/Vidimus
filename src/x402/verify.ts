import { recoverTypedDataAddress } from "viem";
import { config } from "../config.js";
import type { AcceptsEntry, PaymentSignatureHeader } from "./types.js";
import { permit2Domain, PERMIT2_TRANSFER_TYPES } from "./permit2.js";
import { isNonceUsed } from "./nonceStore.js";

export class PaymentVerificationError extends Error {}

export function decodePaymentSignatureHeader(headerValue: string): PaymentSignatureHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(headerValue, "base64url").toString("utf8"));
  } catch {
    throw new PaymentVerificationError("PAYMENT-SIGNATURE header is not valid base64url JSON");
  }
  const header = parsed as Partial<PaymentSignatureHeader>;
  if (
    header.x402Version !== 2 ||
    header.scheme !== "exact" ||
    !header.payload?.permit2Authorization
  ) {
    throw new PaymentVerificationError("PAYMENT-SIGNATURE header has an unrecognized shape");
  }
  return header as PaymentSignatureHeader;
}

export async function verifyPayment(
  header: PaymentSignatureHeader,
  accepted: AcceptsEntry,
): Promise<void> {
  const auth = header.payload.permit2Authorization;

  if (header.network !== accepted.network) {
    throw new PaymentVerificationError("network mismatch");
  }
  if (auth.permitted.token.toLowerCase() !== accepted.asset.toLowerCase()) {
    throw new PaymentVerificationError("token mismatch");
  }
  if (BigInt(auth.permitted.amount) < BigInt(accepted.amount)) {
    throw new PaymentVerificationError("signed amount is less than the required amount");
  }
  if (auth.spender.toLowerCase() !== accepted.payTo.toLowerCase()) {
    throw new PaymentVerificationError("spender does not match payTo");
  }
  const deadline = BigInt(auth.deadline);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (deadline < nowSeconds) {
    throw new PaymentVerificationError("authorization has expired");
  }
  if (isNonceUsed(auth.owner, auth.nonce)) {
    throw new PaymentVerificationError("nonce already used");
  }

  const recovered = await recoverTypedDataAddress({
    domain: permit2Domain(config.chainId),
    types: PERMIT2_TRANSFER_TYPES,
    primaryType: "PermitTransferFrom",
    message: {
      permitted: {
        token: auth.permitted.token,
        amount: BigInt(auth.permitted.amount),
      },
      spender: auth.spender,
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
    },
    signature: auth.signature,
  });

  if (recovered.toLowerCase() !== auth.owner.toLowerCase()) {
    throw new PaymentVerificationError("signature does not match the claimed owner");
  }
}
