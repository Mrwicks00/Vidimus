import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  rpcUrl: required("RPC_URL"),
  chainId: Number(process.env.CHAIN_ID ?? 1952),
  facilitatorPrivateKey: required("FACILITATOR_PRIVATE_KEY") as `0x${string}`,
  payToAddress: required("PAY_TO_ADDRESS") as `0x${string}`,
  paymentTokenAddress: required("PAYMENT_TOKEN_ADDRESS") as `0x${string}`,
  // EIP-3009 signs directly against the token's own EIP-712 domain - these must exactly match
  // what the deployed token contract actually uses, or every signature recovery will fail.
  paymentTokenName: required("PAYMENT_TOKEN_NAME"),
  paymentTokenVersion: required("PAYMENT_TOKEN_VERSION"),
  priceAtomic: BigInt(process.env.PRICE_ATOMIC ?? "100000"),
  erc8004Id: process.env.ERC8004_ID ?? "",
  erc8004Address: (process.env.ERC8004_ADDRESS ?? "") as `0x${string}` | "",
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  // D6.B calibration log (docs/ARCHITECTURE.md §5) - append-only JSONL, not committed to git
  // (runtime state, not source - see .gitignore).
  calibrationLogPath: process.env.CALIBRATION_LOG_PATH ?? "data/calibration-log.jsonl",
};
