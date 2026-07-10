import type { Context, Next } from "hono";
import { buildPaymentRequirements, encodePaymentRequiredHeader } from "./challenge.js";
import { decodePaymentSignatureHeader, verifyPayment, PaymentVerificationError } from "./verify.js";
import { encodePaymentResponseHeader, settlePayment } from "./settle.js";

declare module "hono" {
  interface ContextVariableMap {
    paymentId: string;
  }
}

export async function x402Gate(c: Context, next: Next) {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  const requirements = buildPaymentRequirements(url.toString());
  const accepted = requirements.accepts[0];

  const sigHeader = c.req.header("PAYMENT-SIGNATURE");
  if (!sigHeader) {
    c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(requirements));
    return c.json(requirements, 402);
  }

  let decoded;
  try {
    decoded = decodePaymentSignatureHeader(sigHeader);
    await verifyPayment(decoded, accepted);
  } catch (err) {
    const message = err instanceof PaymentVerificationError ? err.message : "payment verification failed";
    return c.json({ error: message }, 402);
  }

  const settlement = await settlePayment(decoded.payload.permit2Authorization, accepted);
  c.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settlement));
  c.set("paymentId", settlement.transaction);

  await next();
}
