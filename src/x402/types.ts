export interface AcceptsEntry {
  scheme: "exact";
  network: string; // CAIP-2, e.g. "eip155:196"
  asset: `0x${string}`;
  amount: string; // atomic units, base-10 string
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  extra: {
    name: string; // the token's own EIP-712 domain name (signed directly against the token,
    version: string; // no intermediary contract) - see docs/PLATFORM.md §7 (U2, D7 revision).
  };
}

export interface PaymentRequirements {
  x402Version: 2;
  resource: { method: string; url: string; description: string };
  accepts: AcceptsEntry[];
}

// EIP-3009 transferWithAuthorization - signed directly against the payment token's own
// EIP-712 domain, no intermediary contract, no pre-approval step. Replaces the D1-D6 Permit2
// path (see git history for the retired implementation) after live-testing found real
// OKX-ecosystem tooling (`onchainos payment pay`) defaults to Permit2's witness-augmented
// variant for any `assetTransferMethod: "permit2"` declaration - an undocumented signing
// shape this project has no way to verify safely. EIP-3009 is simpler (single flat struct,
// no witness), well-documented, and is what every real third-party agent tested this session
// already used successfully against the same payment token.
export interface Eip3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string; // uint256 decimal string
  validAfter: string; // unix seconds, decimal string
  validBefore: string; // unix seconds, decimal string
  nonce: `0x${string}`; // bytes32
  signature: `0x${string}`; // packed 65-byte (r,s,v) signature
}

export interface PaymentSignatureHeader {
  x402Version: 2;
  scheme: "exact";
  network: string;
  payload: {
    authorization: Eip3009Authorization;
  };
}

export interface PaymentResponse {
  status: "success" | "pending";
  transaction: `0x${string}`;
  amount: string;
  payer: `0x${string}`;
}
