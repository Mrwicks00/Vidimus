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
  priceAtomic: BigInt(process.env.PRICE_ATOMIC ?? "10000"),
  erc8004Id: process.env.ERC8004_ID ?? "",
  erc8004Address: (process.env.ERC8004_ADDRESS ?? "") as `0x${string}` | "",
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
};
