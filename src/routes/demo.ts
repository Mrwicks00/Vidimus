// Powers the frontend's "run a live verification" button (web/src/components/LiveDemo.tsx).
// Not part of the priced product surface - this route pays Vidimus's own /verify out of a
// dedicated demo-buyer wallet so a visitor can watch one real, signed, on-chain-settled
// verdict happen without needing a wallet of their own. Rate-limited because it spends real
// money on every successful run and every visitor on the internet can reach it.
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@okxweb3/x402-core/client";
import { x402HTTPClient } from "@okxweb3/x402-core/http";
import type { SettleResponse } from "@okxweb3/x402-core/types";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import { config } from "../config.js";
import type { OnchainDeliverable } from "../modules/m3-onchain.js";

export const demoRoute = new Hono();

// Both cases below are real, independently reproducible mainnet facts already covered in the
// track record (docs/ROADMAP.md D7) - fixed historical tx hashes, not synthetic fixtures, so
// every demo run re-derives the verdict from live chain state rather than replaying a canned
// response. Barker Yield Agent isn't offered here: its original verification read live
// external market data at the time, not a frozen on-chain fact, so it can't be replayed
// deterministically without either a live paid re-fetch each click or a fabricated snapshot.
const USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736" as const;

interface DemoCase {
  id: string;
  label: string;
  spec: string;
  deliverable: { onchain: OnchainDeliverable };
}

const OTTO_SWAP_TX = "0x1f1b1e4edbe703e6a9bbf0f8aba431c0413b25362047c2aef61f3d65ae046697" as const;
const IDLEFLOW_APPROVE_TX = "0xe8ef44af871f5a118adbd85d1308247ca1a62c6b0be144c4bc276cec56a59c44" as const;
const IDLEFLOW_SUPPLY_TX = "0xb7530922068809688a19ccf77dd16d033e1d101f292ee289bc77349564fb3d03" as const;
const IDLEFLOW_AAVE_RESERVE = "0xf356ae412db5df43bd3a10746f7ad4e1c4de4297" as const;

const DEMO_CASES: Record<string, DemoCase> = {
  otto: {
    id: "otto",
    label: "Otto AI's swap",
    spec: `Verify a token swap executed on X Layer mainnet by a third-party agent (Otto AI):
- The transaction ${OTTO_SWAP_TX} must exist and be confirmed on X Layer mainnet.
- The transaction must move at least 0.05 USDT0 (token ${USDT0}) - the amount the swap was
  paid to move.`,
    deliverable: {
      onchain: {
        "onchain.tx_exists": [{ txHash: OTTO_SWAP_TX }],
        "onchain.transfer_check": [{ txHash: OTTO_SWAP_TX, asset: USDT0, amountMin: "50000" }],
      },
    },
  },
  idleflow: {
    id: "idleflow",
    label: "IdleFlow's DeFi deposit",
    spec: `Verify a real stablecoin deposit executed by IdleFlow (agent #4523) on X Layer mainnet, via its Stablecoin Yield Allocation service:
- The approval transaction ${IDLEFLOW_APPROVE_TX} must exist and be confirmed on X Layer mainnet.
- The supply transaction ${IDLEFLOW_SUPPLY_TX} must exist and be confirmed on X Layer mainnet, and must move at least 200000 atomic units (0.2 USDT) of token ${USDT0} to destination ${IDLEFLOW_AAVE_RESERVE}.
- IdleFlow claims it deposited into 'the highest-APY vetted Aave V3 market' for USDT on X Layer - verify this claim is actually true against real current market data, not just that a deposit happened.`,
    deliverable: {
      onchain: {
        "onchain.tx_exists": [{ txHash: IDLEFLOW_APPROVE_TX }, { txHash: IDLEFLOW_SUPPLY_TX }],
        "onchain.destination_check": [{ txHash: IDLEFLOW_SUPPLY_TX, destination: IDLEFLOW_AAVE_RESERVE, asset: USDT0 }],
        "onchain.transfer_check": [{ txHash: IDLEFLOW_SUPPLY_TX, asset: USDT0, amountMin: "200000" }],
      },
    },
  },
};

const DEFAULT_DEMO_CASE = "otto";

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
    cases: Object.values(DEMO_CASES).map((c) => ({ id: c.id, label: c.label })),
    defaultCase: DEFAULT_DEMO_CASE,
  });
});

demoRoute.post("/demo/verify", async (c) => {
  if (!config.demoBuyerPrivateKey) {
    return c.json({ error: "The live demo isn't funded on this deployment. See the track record above for real verified evidence." }, 503);
  }

  const requestedCase = c.req.query("case") ?? DEFAULT_DEMO_CASE;
  const demoCase = DEMO_CASES[requestedCase];
  if (!demoCase) {
    return c.json({ error: `unknown demo case "${requestedCase}"` }, 400);
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

    const account = privateKeyToAccount(config.demoBuyerPrivateKey as `0x${string}`);
    const network = `eip155:${config.chainId}` as const;
    const client = new x402HTTPClient(new x402Client().register(network, new ExactEvmScheme(toClientEvmSigner(account))));

    const first = await fetch(verifyUrl, { method: "POST" });
    if (first.status !== 402) {
      throw new Error(`expected a 402 payment challenge from /verify, got ${first.status}`);
    }
    const paymentRequired = client.getPaymentRequiredResponse((name) => first.headers.get(name));

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeaders = client.encodePaymentSignatureHeader(paymentPayload);

    const second = await fetch(verifyUrl, {
      method: "POST",
      headers: { ...paymentHeaders, "content-type": "application/json" },
      body: JSON.stringify({ spec: demoCase.spec, deliverable: demoCase.deliverable }),
    });
    const bodyText = await second.text();
    if (second.status !== 200) {
      throw new Error(`verification call failed: ${second.status} ${bodyText}`);
    }
    const verdict = JSON.parse(bodyText);

    const settlement: SettleResponse = client.getPaymentSettleResponse((name) => second.headers.get(name));

    state.countToday += 1;
    return c.json({ verdict, settlement });
  } catch (err) {
    const message = err instanceof Error ? err.message : "the live demo failed unexpectedly";
    return c.json({ error: message }, 502);
  }
});
