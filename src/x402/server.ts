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

// `extra.name`/`extra.version` are the token's own EIP-712 domain, required for the client-side
// ExactEvmScheme to build the correct typed-data domain when signing the EIP-3009 authorization -
// the SDK does not infer or fetch these on its own (confirmed live: createPaymentPayload throws
// "EIP-712 domain parameters (name, version) are required" without them).
const extra = { name: config.paymentTokenName, version: config.paymentTokenVersion };

const accepts = { scheme: "exact" as const, network: NETWORK, payTo: config.payToAddress, price, maxTimeoutSeconds: 300, extra };

// Both verbs point at the same payment option - OKX's ASP validator probes with a plain GET
// before ever attempting a real paid POST (see docs/OKX_ASP_LISTING_GUIDE.md §3.2); declaring
// both here in the SDK's own route table makes that structurally impossible to regress, unlike
// the old hand-rolled version which needed the same middleware manually applied to both routes.
const resource = `${config.publicBaseUrl}/verify`;
const description =
  "Vidimus conformance verdict - signed, evidence-backed verification against onchain, dataset, code, and content deliverables. " +
  `Before paying, call the free preview endpoint POST ${config.publicBaseUrl}/verify/requirements with the same jobId to see the exact deliverable shape required - avoids paying for a submission that turns out UNVERIFIABLE due to a shape mismatch.`;

export const verifyRoutes: RoutesConfig = {
  "GET /verify": { accepts, resource, description, mimeType: "application/json" },
  "POST /verify": { accepts, resource, description, mimeType: "application/json" },
};
