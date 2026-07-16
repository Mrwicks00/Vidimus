// Real, load-bearing facts about the live service — kept in one place so copy across
// sections (nav, hero, footer, demo panel) can't drift from what's actually deployed.
export const SITE = {
  agentId: "4933",
  chainLabel: "X Layer mainnet",
  caip2: "eip155:196",
  verifyUrl: "https://vidimus.onrender.com/verify",
  githubUrl: "https://github.com/Mrwicks00/Vidimus",
  okxAgentUrl: "https://okx.ai",
  priceLabel: "0.1 USD₮0",
  tokenSymbol: "USD₮0",
  erc8004Address: "0xc66f8b978ce501560a9fc6b7161052df8680f7e0",
  payToAddress: "0x2085D86C5EC584f337738E9AA8A0c566Fe86f0a9",
} as const;
