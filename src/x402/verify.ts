import { recoverTypedDataAddress } from "viem";
import { config } from "../config.js";
import type { AcceptsEntry, PaymentSignatureHeader } from "./types.js";
import { EIP3009_TRANSFER_TYPES, eip3009Domain } from "./eip3009.js";
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
  if (header.x402Version !== 2 || !header.payload?.authorization || !header.payload.signature) {
    throw new PaymentVerificationError("PAYMENT-SIGNATURE header has an unrecognized shape");
  }
  return header as PaymentSignatureHeader;
}

export async function verifyPayment(header: PaymentSignatureHeader, accepted: AcceptsEntry): Promise<void> {
  const auth = header.payload.authorization;
  const signature = header.payload.signature;

  if (auth.to.toLowerCase() !== accepted.payTo.toLowerCase()) {
    throw new PaymentVerificationError("authorization recipient does not match payTo");
  }
  if (BigInt(auth.value) < BigInt(accepted.amount)) {
    throw new PaymentVerificationError("signed amount is less than the required amount");
  }
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(auth.validBefore) < nowSeconds) {
    throw new PaymentVerificationError("authorization has expired");
  }
  if (BigInt(auth.validAfter) > nowSeconds) {
    throw new PaymentVerificationError("authorization is not yet valid");
  }
  if (isNonceUsed(auth.from, auth.nonce)) {
    throw new PaymentVerificationError("nonce already used");
  }

  const recovered = await recoverTypedDataAddress({
    domain: eip3009Domain(accepted.extra.name, accepted.extra.version, config.chainId, accepted.asset),
    types: EIP3009_TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature,
  });

  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    throw new PaymentVerificationError("signature does not match the claimed sender");
  }
}
