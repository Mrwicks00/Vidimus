import { config } from "../config.js";
import type { PaymentRequirements } from "./types.js";
import { PERMIT2_DOMAIN_NAME } from "./permit2.js";

export function buildPaymentRequirements(resourceUrl: string): PaymentRequirements {
  return {
    x402Version: 2,
    resource: {
      method: "POST",
      url: resourceUrl,
      description: "Vidimus conformance verdict - signed, evidence-backed verification against onchain, dataset, code, and content deliverables",
    },
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${config.chainId}`,
        asset: config.paymentTokenAddress,
        amount: config.priceAtomic.toString(),
        payTo: config.payToAddress,
        maxTimeoutSeconds: 300,
        extra: {
          name: PERMIT2_DOMAIN_NAME,
          version: "1",
          assetTransferMethod: "permit2",
        },
      },
    ],
  };
}

export function encodePaymentRequiredHeader(req: PaymentRequirements): string {
  return Buffer.from(JSON.stringify(req), "utf8").toString("base64url");
}
