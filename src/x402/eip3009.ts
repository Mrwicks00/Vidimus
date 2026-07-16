// EIP-3009 (transferWithAuthorization) - signed directly against the payment token's own
// EIP-712 domain. Confirmed live against the real production payment token (USD₮0 on X Layer
// mainnet, 0x779ded0c9e1022225f8e0630b35a9b54be713736) via a read-only `simulateContract`
// probe (no funds moved): the (v,r,s)-split function reverted with the token's own branded
// "TetherToken: invalid signature" error - proof the real function was reached and executed
// genuine signature-checking logic, not a guess. `DOMAIN_SEPARATOR()` and `authorizationState()`
// both resolve on that token too, confirming full EIP-3009 support (docs/PLATFORM.md §7).

export const EIP3009_TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function eip3009Domain(name: string, version: string, chainId: number, verifyingContract: `0x${string}`) {
  return { name, version, chainId, verifyingContract } as const;
}

export const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
