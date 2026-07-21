import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer } from "@okxweb3/x402-hono";
import type { RoutesConfig } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { config } from "../config.js";

const NETWORK = `eip155:${config.chainId}` as const;

const facilitatorClient = new OKXFacilitatorClient({
  apiKey: config.okxApiKey,
  secretKey: config.okxSecretKey,
  passphrase: config.okxPassphrase,
});

export const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());

// Exact atomic amount + explicit asset address (not the "$0.10" USD shorthand) - keeps the
// existing price/token identity byte-for-byte instead of trusting the facilitator's own
// USD-to-atomic conversion for a value this precise.
const price = { asset: config.paymentTokenAddress, amount: config.priceAtomic.toString() };

// Both verbs point at the same payment option - OKX's ASP validator probes with a plain GET
// before ever attempting a real paid POST (see docs/OKX_ASP_LISTING_GUIDE.md §3.2); declaring
// both here in the SDK's own route table makes that structurally impossible to regress, unlike
// the old hand-rolled version which needed the same middleware manually applied to both routes.
export const verifyRoutes: RoutesConfig = {
  "GET /verify": {
    accepts: { scheme: "exact", network: NETWORK, payTo: config.payToAddress, price, maxTimeoutSeconds: 300 },
    description: "Vidimus conformance verdict - signed, evidence-backed verification against onchain, dataset, code, and content deliverables",
    mimeType: "application/json",
  },
  "POST /verify": {
    accepts: { scheme: "exact", network: NETWORK, payTo: config.payToAddress, price, maxTimeoutSeconds: 300 },
    description: "Vidimus conformance verdict - signed, evidence-backed verification against onchain, dataset, code, and content deliverables",
    mimeType: "application/json",
  },
};
