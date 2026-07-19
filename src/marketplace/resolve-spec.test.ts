// Unit tests for jobId -> spec resolution (see resolve-spec.ts for why this exists). All
// offline: `resolveSpecFromJobId` takes an injectable `runner` so no real `onchainos` call is
// ever made in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDescription, resolveSpecFromJobId } from "./resolve-spec.js";

// Captured live from a real `onchainos agent common context <jobId> --role user --agent-id ...`
// call this session, against a job this test-writer had no part in - confirms both the parser
// shape and that common context is genuinely readable by a non-participant.
const REAL_SAMPLE_OUTPUT = `You are the User Agent in the task system.

[Your Identity]
- Role: User Agent
- AgentID: 6566
- Wallet address: 0xc66f8b978ce501560a9fc6b7161052df8680f7e0
- Communication address: 0x054132C6e146FFcC7F80faEBe95a01A924Bfe3AD
- Name: lycantho

[Task Details]
- Job ID: 0x552dcd8dc8282683a14917c0a18a40c6b404c6312c75f39576c35bc3a6aa40f9
- Internal ID: 409482
- Title: Compare quotes for logo work
- Description: Hey, I need a simple logo designed for my new crypto side project (it's called "MoonLedger" — a small portfolio tracker). Nothing fancy, just a clean modern logo I can use on the website and Twitter.

Can you look across the marketplace and find me a few agents that could do this, then rank them so I know which is the best pick? I care most about price and whether they're reliable, but I'd also like it done reasonably fast.

My budget is around 50 USDT and I'd like the work wrapped up within about 48 hours. Just point me to the top options with a quick note on why you'd recommend each one.
- Budget: 0.01 USDT (token: 0x779ded0c9e1022225f8e0630b35a9b54be713736)
- Payment mode (paymentType=1): escrow payment
- Visibility: Private
- Chain: chainId=196
- Created: —

[Current Status]
- created — Awaiting acceptance (Created)
`;

test("extractDescription: parses a real multi-paragraph description out of common context output", () => {
  const description = extractDescription(REAL_SAMPLE_OUTPUT);
  assert.ok(description?.startsWith('Hey, I need a simple logo designed for my new crypto side project (it\'s called "MoonLedger"'));
  assert.ok(description?.endsWith("why you'd recommend each one."));
  assert.ok(!description?.includes("- Budget:"));
});

test("extractDescription: single-line description", () => {
  const output = `[Task Details]\n- Title: X\n- Description: Do the thing.\n- Budget: 1 USDT\n`;
  assert.equal(extractDescription(output), "Do the thing.");
});

test("extractDescription: no Description field -> undefined", () => {
  const output = `[Task Details]\n- Title: X\n- Budget: 1 USDT\n`;
  assert.equal(extractDescription(output), undefined);
});

test("extractDescription: empty description -> undefined (not empty string)", () => {
  const output = `[Task Details]\n- Description:   \n- Budget: 1 USDT\n`;
  assert.equal(extractDescription(output), undefined);
});

test("extractDescription: unexpected/garbled output -> undefined, never throws", () => {
  assert.equal(extractDescription("not the format we expected at all"), undefined);
  assert.equal(extractDescription(""), undefined);
});

test("resolveSpecFromJobId: immediate success", async () => {
  let calls = 0;
  const runner = async (jobId: string) => {
    calls += 1;
    assert.equal(jobId, "job-1");
    return { stdout: "[Task Details]\n- Title: X\n- Description: Real spec text.\n- Budget: 1 USDT\n" };
  };
  const spec = await resolveSpecFromJobId("job-1", runner);
  assert.equal(spec, "Real spec text.");
  assert.equal(calls, 1);
});

test("resolveSpecFromJobId: fails twice (transient) then succeeds on the 3rd attempt", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    if (calls < 3) throw new Error("Network unavailable - dns error");
    return { stdout: "[Task Details]\n- Description: Recovered spec.\n- Budget: 1 USDT\n" };
  };
  const spec = await resolveSpecFromJobId("job-1", runner);
  assert.equal(spec, "Recovered spec.");
  assert.equal(calls, 3);
});

test("resolveSpecFromJobId: exhausts all retries -> undefined, never throws", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    throw new Error("Network unavailable - dns error");
  };
  const spec = await resolveSpecFromJobId("job-1", runner);
  assert.equal(spec, undefined);
  assert.equal(calls, 3);
});

test("resolveSpecFromJobId: job not found (CLI succeeds but no Description field) -> undefined, never throws", async () => {
  const runner = async () => ({ stdout: "Error: job not found\n" });
  const spec = await resolveSpecFromJobId("does-not-exist", runner);
  assert.equal(spec, undefined);
});
