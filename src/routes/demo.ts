// Powers the frontend's "run a live verification" button (web/src/components/LiveDemo.tsx).
// Not part of the priced product surface - this route pays Vidimus's own /verify out of a
// dedicated demo-buyer wallet so a visitor can watch one real, signed, on-chain-settled
// verdict happen without needing a wallet of their own. Rate-limited because it spends real
// money on every successful run and every visitor on the internet can reach it.
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { EIP3009_TRANSFER_TYPES, eip3009Domain } from "../x402/eip3009.js";
import type { Eip3009Authorization, PaymentRequirements, PaymentResponse, PaymentSignatureHeader } from "../x402/types.js";
import type { OnchainDeliverable } from "../modules/m3-onchain.js";

export const demoRoute = new Hono();

// The real Otto AI swap tx already covered in the track record (docs/ROADMAP.md D7) - a real,
// independently reproducible mainnet fact, not a synthetic fixture, so every demo run reads
// live chain state rather than replaying a canned response.
const DEMO_SWAP_TX = "0x1f1b1e4edbe703e6a9bbf0f8aba431c0413b25362047c2aef61f3d65ae046697" as const;
const DEMO_USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736" as const;

const DEMO_SPEC = `Verify a token swap executed on X Layer mainnet by a third-party agent (Otto AI):
- The transaction ${DEMO_SWAP_TX} must exist and be confirmed on X Layer mainnet.
- The transaction must move at least 0.05 USDT0 (token ${DEMO_USDT0}) - the amount the swap was
  paid to move.`;

const DEMO_DELIVERABLE: { onchain: OnchainDeliverable } = {
  onchain: {
    "onchain.tx_exists": [{ txHash: DEMO_SWAP_TX }],
    "onchain.transfer_check": [{ txHash: DEMO_SWAP_TX, asset: DEMO_USDT0, amountMin: "50000" }],
  },
};

interface DemoState {
  lastRunAt: number;
  dayKey: string;
  countToday: number;
}
const state: DemoState = { lastRunAt: 0, dayKey: "", countToday: 0 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
function rollDayIfNeeded(): void {
  const key = todayKey();
  if (state.dayKey !== key) {
    state.dayKey = key;
    state.countToday = 0;
  }
}
function cooldownRemaining(): number {
  const elapsedMs = Date.now() - state.lastRunAt;
  return Math.max(0, Math.ceil((config.demoCooldownSeconds * 1000 - elapsedMs) / 1000));
}
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(0, Math.ceil((midnight - now.getTime()) / 1000));
}

demoRoute.get("/demo/status", (c) => {
  rollDayIfNeeded();
  const enabled = Boolean(config.demoBuyerPrivateKey);
  return c.json({
    enabled,
    cooldownRemainingSeconds: enabled ? cooldownRemaining() : 0,
    dailyRemaining: enabled ? Math.max(0, config.demoDailyLimit - state.countToday) : 0,
    priceAtomic: config.priceAtomic.toString(),
    agentId: config.erc8004Id,
  });
});

demoRoute.post("/demo/verify", async (c) => {
  if (!config.demoBuyerPrivateKey) {
    return c.json({ error: "The live demo isn't funded on this deployment. See the track record above for real verified evidence." }, 503);
  }

  rollDayIfNeeded();
  if (state.countToday >= config.demoDailyLimit) {
    return c.json(
      { error: "Today's demo budget is spent. See the track record above for real verified evidence.", retryAfterSeconds: secondsUntilUtcMidnight() },
      429,
    );
  }
  const cooldown = cooldownRemaining();
  if (cooldown > 0) {
    return c.json({ error: "The demo just ran - give it a moment to cool down.", retryAfterSeconds: cooldown }, 429);
  }
  // Reserve the cooldown slot immediately, before doing any work, so retries (successful or
  // not) can't be used to bypass the rate limit by racing the request.
  state.lastRunAt = Date.now();

  try {
    const url = new URL(c.req.url);
    const forwardedProto = c.req.header("x-forwarded-proto");
    if (forwardedProto) url.protocol = `${forwardedProto}:`;
    const verifyUrl = `${url.protocol}//${url.host}/verify`;

    const first = await fetch(verifyUrl, { method: "POST" });
    if (first.status !== 402) {
      throw new Error(`expected a 402 payment challenge from /verify, got ${first.status}`);
    }
    const requirements = (await first.json()) as PaymentRequirements;
    const accepted = requirements.accepts[0];
    if (!accepted) throw new Error("payment challenge had no accepted payment method");

    const account = privateKeyToAccount(config.demoBuyerPrivateKey as `0x${string}`);
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = 0n;
    const validBefore = nowSeconds + BigInt(accepted.maxTimeoutSeconds);
    const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;

    const signature = await account.signTypedData({
      domain: eip3009Domain(accepted.extra.name, accepted.extra.version, Number(accepted.network.split(":")[1]), accepted.asset),
      types: EIP3009_TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: accepted.payTo,
        value: BigInt(accepted.amount),
        validAfter,
        validBefore,
        nonce,
      },
    });

    const authorization: Eip3009Authorization = {
      from: account.address,
      to: accepted.payTo,
      value: accepted.amount,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    };
    const header: PaymentSignatureHeader = { x402Version: 2, payload: { authorization, signature } };
    const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");

    const second = await fetch(verifyUrl, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": encodedHeader, "content-type": "application/json" },
      body: JSON.stringify({ spec: DEMO_SPEC, deliverable: DEMO_DELIVERABLE }),
    });
    const bodyText = await second.text();
    if (second.status !== 200) {
      throw new Error(`verification call failed: ${second.status} ${bodyText}`);
    }
    const verdict = JSON.parse(bodyText);

    const responseHeader = second.headers.get("PAYMENT-RESPONSE");
    const settlement: PaymentResponse | null = responseHeader
      ? JSON.parse(Buffer.from(responseHeader, "base64url").toString("utf8"))
      : null;

    state.countToday += 1;
    return c.json({ verdict, settlement });
  } catch (err) {
    const message = err instanceof Error ? err.message : "the live demo failed unexpectedly";
    return c.json({ error: message }, 502);
  }
});
