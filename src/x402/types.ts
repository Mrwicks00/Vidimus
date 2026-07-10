export interface AcceptsEntry {
  scheme: "exact";
  network: string; // CAIP-2, e.g. "eip155:1952"
  asset: `0x${string}`;
  amount: string; // atomic units, base-10 string
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  extra: {
    name: string; // token EIP-712 domain name (informational for permit2)
    version: string;
    assetTransferMethod: "permit2";
  };
}

export interface PaymentRequirements {
  x402Version: 2;
  resource: { method: string; url: string; description: string };
  accepts: AcceptsEntry[];
}

export interface Permit2Authorization {
  owner: `0x${string}`;
  permitted: { token: `0x${string}`; amount: string };
  spender: `0x${string}`;
  nonce: string; // uint256 decimal string
  deadline: string; // unix seconds, decimal string
  signature: `0x${string}`;
}

export interface PaymentSignatureHeader {
  x402Version: 2;
  scheme: "exact";
  network: string;
  payload: {
    permit2Authorization: Permit2Authorization;
  };
}

export interface PaymentResponse {
  status: "success" | "pending";
  transaction: `0x${string}`;
  amount: string;
  payer: `0x${string}`;
}
