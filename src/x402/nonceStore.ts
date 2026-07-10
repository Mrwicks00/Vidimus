// D1-only replay guard: in-memory, per-process. Real persistence is a later concern
// (this skeleton only needs to prove the round-trip, not survive a restart).
const usedNonces = new Set<string>();

export function isNonceUsed(owner: string, nonce: string): boolean {
  return usedNonces.has(`${owner.toLowerCase()}:${nonce}`);
}

export function markNonceUsed(owner: string, nonce: string): void {
  usedNonces.add(`${owner.toLowerCase()}:${nonce}`);
}
