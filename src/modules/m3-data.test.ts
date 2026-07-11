// Unit tests for the pure/offline parts of M3.B (docs/ROADMAP.md D5): the seed->sample-index
// expansion (SECURITY.md §4.1/§4.4) and the schema/rowcount checkers dispatched through
// applyDataChecks. No live chain call - data.sample_verify's chain-dependent path (block wait +
// per-row ground truth) is proven live via scripts/test-buyer.ts, same split as m3-onchain.ts's
// checkers (live-proven, not unit-tested against a real RPC).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { applyDataChecks, deriveSampleIndices, type DataDeliverableSealed, type DataFactSet } from "./m3-data.js";
import { quarantineDataDeliverable } from "../security/quarantine.js";
import type { Criterion } from "../verdict/types.js";

let seq = 0;
function criterion(method: Criterion["method"], index: number): Criterion {
  seq += 1;
  return {
    id: `c${seq}`,
    text: "fixture criterion",
    source: "EXPLICIT",
    tier: 1,
    method,
    locator: method ? { method: method as "data.schema" | "data.rowcount" | "data.sample_verify", index } : undefined,
    result: "UNVERIFIABLE",
    confidence: null,
    evidence: { kind: "none", ref: "", detail: "compiled, not yet verified" },
  };
}

const SEED = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

test("deriveSampleIndices: deterministic for the same seed/rowCount/size", () => {
  const a = deriveSampleIndices(SEED, 1000, 20);
  const b = deriveSampleIndices(SEED, 1000, 20);
  assert.deepEqual(a, b);
});

test("deriveSampleIndices: a different seed produces a different sample (overwhelmingly likely)", () => {
  const other = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
  const a = deriveSampleIndices(SEED, 1000, 20);
  const b = deriveSampleIndices(other, 1000, 20);
  assert.notDeepEqual(a, b);
});

test("deriveSampleIndices: every index is in range and unique", () => {
  const indices = deriveSampleIndices(SEED, 500, 50);
  assert.equal(indices.length, 50);
  assert.equal(new Set(indices).size, 50);
  for (const i of indices) {
    assert.ok(i >= 0 && i < 500);
  }
});

test("deriveSampleIndices: caps at rowCount when size exceeds it", () => {
  const indices = deriveSampleIndices(SEED, 5, 20);
  assert.equal(indices.length, 5);
  assert.deepEqual(indices, [0, 1, 2, 3, 4]);
});

test("deriveSampleIndices: empty rowCount yields no indices", () => {
  assert.deepEqual(deriveSampleIndices(SEED, 0, 20), []);
});

function factSet(id: string, columns: DataFactSet["columns"], rows: Record<string, string>[]): DataFactSet {
  return { id, columns, rowCount: rows.length, rows };
}

test("data.schema: PASS when declared columns are present with matching types", async () => {
  const c = criterion("data.schema", 0);
  const sealed: DataDeliverableSealed = {
    datasets: [
      factSet(
        "d1",
        [
          { name: "tokenId", type: "number" },
          { name: "owner", type: "string" },
        ],
        [{ tokenId: "1", owner: "0xabc" }],
      ),
    ],
    "data.schema": [{ datasetId: "d1", columns: [{ name: "tokenId", type: "number" }, { name: "owner", type: "string" }] }],
  };
  const [result] = await applyDataChecks([c], sealed, [], "sha256:deadbeef");
  assert.equal(result!.result, "PASS");
  assert.equal(result!.evidence.kind, "extract");
});

test("data.schema: FAIL naming the missing/mismatched columns", async () => {
  const c = criterion("data.schema", 0);
  const sealed: DataDeliverableSealed = {
    datasets: [factSet("d1", [{ name: "owner", type: "string" }], [{ owner: "0xabc" }])],
    "data.schema": [
      { datasetId: "d1", columns: [{ name: "tokenId", type: "number" }, { name: "owner", type: "number" }] },
    ],
  };
  const [result] = await applyDataChecks([c], sealed, [], "sha256:deadbeef");
  assert.equal(result!.result, "FAIL");
  assert.match(result!.evidence.detail, /missing: tokenId/);
  assert.match(result!.evidence.detail, /type mismatch: owner/);
});

test("data.rowcount: PASS when actual >= claimed minimum", async () => {
  const c = criterion("data.rowcount", 0);
  const sealed: DataDeliverableSealed = {
    datasets: [factSet("d1", [{ name: "x", type: "string" }], [{ x: "1" }, { x: "2" }, { x: "3" }])],
    "data.rowcount": [{ datasetId: "d1", minCount: 2 }],
  };
  const [result] = await applyDataChecks([c], sealed, [], "sha256:deadbeef");
  assert.equal(result!.result, "PASS");
});

test("data.rowcount: FAIL when actual < claimed minimum, evidence states both", async () => {
  const c = criterion("data.rowcount", 0);
  const sealed: DataDeliverableSealed = {
    datasets: [factSet("d1", [{ name: "x", type: "string" }], [{ x: "1" }])],
    "data.rowcount": [{ datasetId: "d1", minCount: 5 }],
  };
  const [result] = await applyDataChecks([c], sealed, [], "sha256:deadbeef");
  assert.equal(result!.result, "FAIL");
  assert.match(result!.evidence.detail, /has only 1 rows/);
  assert.match(result!.evidence.detail, /required >= 5/);
});

test("locator doesn't resolve (no claim submitted) -> UNVERIFIABLE, never FAIL", async () => {
  const c = criterion("data.rowcount", 0);
  const [result] = await applyDataChecks([c], { datasets: [] }, [], "sha256:deadbeef");
  assert.equal(result!.result, "UNVERIFIABLE");
  assert.match(result!.evidence.detail, /locator did not resolve/);
});

test("claim referencing an unquarantined/rejected dataset -> UNVERIFIABLE, never FAIL", async () => {
  const c = criterion("data.rowcount", 0);
  const sealed: DataDeliverableSealed = {
    datasets: [], // "d1" never made it through quarantine
    "data.rowcount": [{ datasetId: "d1", minCount: 5 }],
  };
  const [result] = await applyDataChecks([c], sealed, [], "sha256:deadbeef");
  assert.equal(result!.result, "UNVERIFIABLE");
  assert.match(result!.evidence.detail, /not delivered or was rejected/);
});

test("quarantine-rejected claim resolves UNVERIFIABLE with the rejection reason, never reaches the checker", async () => {
  const c = criterion("data.rowcount", 0);
  const rejection = { method: "data.rowcount" as const, index: 0, reason: "quarantine rejected malformed/suspicious claim (data.rowcount[0]): bad shape" };
  const sealed: DataDeliverableSealed = { datasets: [factSet("d1", [], [])] };
  const [result] = await applyDataChecks([c], sealed, [rejection], "sha256:deadbeef");
  assert.equal(result!.result, "UNVERIFIABLE");
  assert.equal(result!.evidence.detail, rejection.reason);
});

test("onchain-locator criteria pass through untouched", async () => {
  const c = criterion("onchain.tx_exists", 0);
  const [result] = await applyDataChecks([c], undefined, [], "sha256:deadbeef");
  assert.deepEqual(result, c);
});

// ---- quarantine parsing (Pass 1 extraction) ----

test("quarantineDataDeliverable: CSV parses into columns/rowCount/rows with inferred types", () => {
  const csv = "tokenId,owner,active\n1,0xabc,true\n2,0xdef,false\n";
  const { sealed } = quarantineDataDeliverable({ datasets: [{ id: "d1", format: "csv", content: csv }] });
  assert.ok(sealed);
  const d1 = sealed!.datasets.find((d) => d.id === "d1");
  assert.ok(d1);
  assert.equal(d1!.rowCount, 2);
  assert.deepEqual(
    [...d1!.columns].sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "active", type: "boolean" },
      { name: "owner", type: "string" },
      { name: "tokenId", type: "number" },
    ],
  );
  assert.deepEqual(d1!.rows[0], { tokenId: "1", owner: "0xabc", active: "true" });
});

test("quarantineDataDeliverable: JSON array parses with native-type inference", () => {
  const json = JSON.stringify([
    { tokenId: 1, owner: "0xabc" },
    { tokenId: 2, owner: "0xdef" },
  ]);
  const { sealed } = quarantineDataDeliverable({ datasets: [{ id: "d1", format: "json", content: json }] });
  const d1 = sealed!.datasets.find((d) => d.id === "d1");
  assert.equal(d1!.rowCount, 2);
  assert.ok(d1!.columns.some((c) => c.name === "tokenId" && c.type === "number"));
});

test("quarantineDataDeliverable: malformed claim is rejected, positional slot preserved as undefined", () => {
  const { sealed, rejected } = quarantineDataDeliverable({
    datasets: [{ id: "d1", format: "csv", content: "x\n1\n" }],
    "data.rowcount": [{ datasetId: "d1" /* missing minCount */ }, { datasetId: "d1", minCount: 5 }],
  });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.method, "data.rowcount");
  assert.equal(rejected[0]!.index, 0);
  assert.equal(sealed!["data.rowcount"]![0], undefined);
  assert.deepEqual(sealed!["data.rowcount"]![1], { datasetId: "d1", minCount: 5 });
});
