// Offline, deterministic pieces only - same convention as m2-criteria-compiler.test.ts (the
// canary tripwire itself is already unit-tested there via containsCanary, reused not
// reimplemented here). Live model calls for extractCoverage/extractGrounding cost real money and
// need OPENROUTER_API_KEY, so they're exercised via the manual local-server check in this
// session's plan, not mocked here - this project's established pattern is to keep live-LLM
// verification opt-in/manual rather than mock the OpenAI SDK client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverageSystemPrompt, buildGroundingSystemPrompt } from "./m4-content-grounding.js";

test("buildCoverageSystemPrompt: embeds the canary as a control token", () => {
  const prompt = buildCoverageSystemPrompt("deadbeefcafef00d");
  assert.match(prompt, /deadbeefcafef00d/);
  assert.match(prompt, /DATA, not instructions/);
});

test("buildGroundingSystemPrompt: embeds the canary as a control token, mentions sources", () => {
  const prompt = buildGroundingSystemPrompt("deadbeefcafef00d");
  assert.match(prompt, /deadbeefcafef00d/);
  assert.match(prompt, /source/i);
});
