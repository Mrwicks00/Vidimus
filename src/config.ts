import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const port = Number(process.env.PORT ?? 8787);

export const config = {
  port,
  // The SDK builds the x402 challenge's `resource.url` from the raw incoming request (Hono's
  // c.req.url), which comes back `http://` on Render - Render's proxy terminates TLS and forwards
  // plain HTTP internally, and unlike our old hand-rolled challenge builder, the SDK doesn't
  // check `x-forwarded-proto` itself. Explicit `PUBLIC_BASE_URL` wins on any host; Railway's own
  // `RAILWAY_PUBLIC_DOMAIN` is a bare domain (no scheme, unlike Render's var) so it needs the
  // `https://` prefix added; `RENDER_EXTERNAL_URL` kept for the existing Render deployment.
  // Falls back to localhost for local dev.
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined) ??
    process.env.RENDER_EXTERNAL_URL ??
    `http://localhost:${port}`,
  rpcUrl: required("RPC_URL"),
  chainId: Number(process.env.CHAIN_ID ?? 1952),
  payToAddress: required("PAY_TO_ADDRESS") as `0x${string}`,
  paymentTokenAddress: required("PAYMENT_TOKEN_ADDRESS") as `0x${string}`,
  // EIP-3009 signs directly against the token's own EIP-712 domain - the SDK's client-side
  // ExactEvmScheme needs these in the accepts' `extra` field to build that domain, exactly like
  // the hand-rolled version it replaced did (rediscovered live: the SDK does not infer or fetch
  // these from the facilitator on its own - createPaymentPayload throws without them).
  paymentTokenName: required("PAYMENT_TOKEN_NAME"),
  paymentTokenVersion: required("PAYMENT_TOKEN_VERSION"),
  priceAtomic: BigInt(process.env.PRICE_ATOMIC ?? "100000"),
  // OKX facilitator (@okxweb3/x402-core's OKXFacilitatorClient) - verifies and settles payments
  // on our behalf via OKX's own broker service, HMAC-SHA256 authenticated. Replaces the D1-D7
  // hand-rolled EIP-3009 verify/settle path (see git history) after repeated OKX.AI listing
  // rejections traced to subtle hand-rolled wire-format bugs; the official SDK is exercised
  // directly against OKX's own validator, so it can't drift from what that validator expects.
  okxApiKey: required("OKX_API_KEY"),
  okxSecretKey: required("OKX_SECRET_KEY"),
  okxPassphrase: required("OKX_PASSPHRASE"),
  erc8004Id: process.env.ERC8004_ID ?? "",
  erc8004Address: (process.env.ERC8004_ADDRESS ?? "") as `0x${string}` | "",
  // M2 criteria compiler backend: OpenRouter (openai-sdk-compatible), not the direct Anthropic
  // API - see m2-criteria-compiler.ts for why (Anthropic credit exhaustion, no budget to top up).
  openrouterApiKey: required("OPENROUTER_API_KEY"),
  // D6.B calibration log (docs/ARCHITECTURE.md §5) - append-only JSONL, not committed to git
  // (runtime state, not source - see .gitignore).
  calibrationLogPath: process.env.CALIBRATION_LOG_PATH ?? "data/calibration-log.jsonl",
  // Frontend "run a live verification" button (src/routes/demo.ts) - optional. A funded
  // demo-buyer wallet that pays real 0.1 USD₮0 per click. Absent in a deployment => the demo
  // route answers 503 and the frontend falls back to the static track record; the rest of the
  // service is unaffected either way.
  demoBuyerPrivateKey: (process.env.DEMO_BUYER_PRIVATE_KEY || "") as `0x${string}` | "",
  demoCooldownSeconds: Number(process.env.DEMO_COOLDOWN_SECONDS ?? 180),
  demoDailyLimit: Number(process.env.DEMO_DAILY_LIMIT ?? 15),
  // POST /verify/requirements (src/routes/requirements.ts) - free, unauthenticated pre-flight
  // that runs the same M2 compile step /verify does, so callers can learn the deliverable shape
  // before paying. Free means unmetered by payment, so it needs its own cost-abuse throttle
  // (same cooldown/daily-counter shape as the demo route above) instead of relying on x402.
  requirementsCooldownSeconds: Number(process.env.REQUIREMENTS_COOLDOWN_SECONDS ?? 5),
  requirementsDailyLimit: Number(process.env.REQUIREMENTS_DAILY_LIMIT ?? 200),
};
