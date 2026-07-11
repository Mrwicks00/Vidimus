// M7 canonical serialization. docs/VERDICT_SPEC.md §5: sorted keys within each object, no
// insignificant whitespace, UTF-8, arrays in given order. Hand-rolled (no RFC 8785 lib) -
// the verdict schema has no exotic numeric edge cases (confidence is null or a decimal in
// [0,1], tiers are 1|2|3, everything else is strings/arrays/objects), so plain recursive
// key-sorting plus JSON.stringify on leaves is deterministic and sufficient for this schema.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
