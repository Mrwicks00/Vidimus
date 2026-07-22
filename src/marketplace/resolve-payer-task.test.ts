// Unit tests for the payer-address -> jobId fallback (see resolve-payer-task.ts for why this
// exists). All offline: `findAcceptedJobIdForPayer` takes an injectable `runner`, same convention
// as resolve-spec.test.ts - no real `onchainos` call is ever made in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import { extractPayerAddress, findAcceptedJobIdForPayer } from "./resolve-payer-task.js";

const PAYER = "0xAbC0000000000000000000000000000000dEaD";

function realHeader(from: string): string {
  // Round-trips through the SDK's own encode function (not hand-crafted base64) - same payload
  // shape the ExactEvmScheme client actually produces (payload.authorization.from).
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {} as never,
    payload: { authorization: { from, to: "0x0", value: "1", validAfter: "0", validBefore: "0", nonce: "0x0" } },
  } as never);
}

test("extractPayerAddress: decodes a real SDK-encoded header, lowercases the address", () => {
  assert.equal(extractPayerAddress(realHeader(PAYER)), PAYER.toLowerCase());
});

test("extractPayerAddress: garbage header -> undefined, never throws", () => {
  assert.equal(extractPayerAddress("not-base64-json-at-all"), undefined);
});

test("extractPayerAddress: valid JSON but no authorization.from -> undefined", () => {
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: {} as never, payload: {} } as never);
  assert.equal(extractPayerAddress(header), undefined);
});

function providerTasksOutput(tasks: unknown[]): { stdout: string } {
  return { stdout: JSON.stringify({ data: { providerTasks: tasks } }) };
}

test("findAcceptedJobIdForPayer: exactly one accepted x402 match -> its jobId", async () => {
  const runner = async () =>
    providerTasksOutput([{ buyerAgentAddress: PAYER, jobId: "0xjob1", status: 1, paymentMode: 3 }]);
  const jobId = await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner);
  assert.equal(jobId, "0xjob1");
});

test("findAcceptedJobIdForPayer: address match is case-insensitive", async () => {
  const runner = async () =>
    providerTasksOutput([{ buyerAgentAddress: PAYER.toUpperCase(), jobId: "0xjob1", status: 1, paymentMode: 3 }]);
  const jobId = await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner);
  assert.equal(jobId, "0xjob1");
});

test("findAcceptedJobIdForPayer: zero matches -> undefined, never guesses", async () => {
  const runner = async () => providerTasksOutput([{ buyerAgentAddress: "0xsomeoneelse", jobId: "0xjob1", status: 1, paymentMode: 3 }]);
  assert.equal(await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner), undefined);
});

test("findAcceptedJobIdForPayer: multiple matches (ambiguous concurrent tasks) -> undefined, never guesses", async () => {
  const runner = async () =>
    providerTasksOutput([
      { buyerAgentAddress: PAYER, jobId: "0xjob1", status: 1, paymentMode: 3 },
      { buyerAgentAddress: PAYER, jobId: "0xjob2", status: 1, paymentMode: 3 },
    ]);
  assert.equal(await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner), undefined);
});

test("findAcceptedJobIdForPayer: matching address but wrong status (not accepted) -> undefined", async () => {
  const runner = async () => providerTasksOutput([{ buyerAgentAddress: PAYER, jobId: "0xjob1", status: 0, paymentMode: 3 }]);
  assert.equal(await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner), undefined);
});

test("findAcceptedJobIdForPayer: matching address but wrong paymentMode (not x402) -> undefined", async () => {
  const runner = async () => providerTasksOutput([{ buyerAgentAddress: PAYER, jobId: "0xjob1", status: 1, paymentMode: 1 }]);
  assert.equal(await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner), undefined);
});

test("findAcceptedJobIdForPayer: CLI failure -> undefined, never throws", async () => {
  const runner = async () => {
    throw new Error("Network unavailable");
  };
  assert.equal(await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner), undefined);
});

test("findAcceptedJobIdForPayer: unparseable CLI output -> undefined, never throws", async () => {
  const runner = async () => ({ stdout: "not json" });
  assert.equal(await findAcceptedJobIdForPayer(PAYER.toLowerCase(), runner), undefined);
});
