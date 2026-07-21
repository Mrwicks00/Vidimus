// Hardened URL fetcher for content.source_grounding / content.no_hallucination
// (docs/VERIFICATION_MODULES.md M4 Tier-2) - the "source fetcher" docs/SECURITY.md §2.2 already
// anticipated as a narrow, single-purpose, non-instructable extraction tool. It fetches bytes and
// returns inert text, nothing more - the returned text is still untrusted data, fed to the same
// canary-protected extraction pass (src/modules/m4-content-grounding.ts) as any other deliverable
// content. Never executed, never given instruction authority, regardless of what it contains.
//
// SSRF guard: resolves the hostname ourselves and rejects any address in a private/reserved
// range, re-checked on every redirect hop (redirects handled manually - never trust a single
// up-front check then blindly follow a citation's server wherever it redirects). Residual risk,
// not hidden: this checks resolved addresses before connecting, then lets `fetch()` re-resolve
// and connect itself - a narrow DNS-rebinding race exists between those two steps. Closing that
// fully needs a custom dispatcher pinning the exact validated IP for the actual socket, which is
// out of scope tonight; this guard stops the overwhelmingly common case (a citation URL that
// plainly points at an internal/metadata address) without that added complexity.
import { lookup } from "node:dns/promises";

const FETCH_TIMEOUT_MS = 8_000;
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 400;
const MAX_RESPONSE_BYTES = 300_000;
const MAX_TEXT_LENGTH = 50_000;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/json"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SourceFetchResult = { ok: true; text: string; finalUrl: string } | { ok: false; reason: string };

// [network, prefixLength] - RFC1918 + loopback + link-local (incl. the 169.254.169.254 cloud
// metadata address) + CGNAT (100.64.0.0/10) + the usual documentation/reserved/multicast ranges.
const PRIVATE_V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function isPrivateV4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  return PRIVATE_V4_RANGES.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (ipv4ToInt(network) & mask);
  });
}

function firstHextet(ip: string): number {
  const first = ip.split(":").find((seg) => seg.length > 0) ?? "0";
  return parseInt(first, 16);
}

// Loopback (::1), unspecified (::), unique-local (fc00::/7), link-local (fe80::/10), and any
// ::ffff:-mapped IPv4 address that itself maps to a private v4 range above.
export function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateV4(mapped[1]);
  const first = firstHextet(normalized);
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true });
  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateV4(address)) {
      throw new Error(`hostname "${hostname}" resolves to a private/reserved address (${address})`);
    }
    if (family === 6 && isPrivateV6(address)) {
      throw new Error(`hostname "${hostname}" resolves to a private/reserved address (${address})`);
    }
  }
  if (addresses.length === 0) {
    throw new Error(`hostname "${hostname}" did not resolve to any address`);
  }
}

// Conservative, hand-rolled HTML -> plain text (no new dependency, consistent with this
// project's existing preference for hand-rolled parsing where a full library isn't warranted -
// see the canonicalizer/EIP-3009 encoder in git history). Parse quality doesn't matter for
// safety here: the output is still just inert data handed to a canary-protected extraction pass
// next (src/modules/m4-content-grounding.ts), never given instruction authority regardless of
// how well the tags were stripped.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Never throws - a blocked/unreachable/oversized/wrong-type source is itself verification-
 * relevant evidence (mirrors resolveSpecFromJobId's never-throws contract), not an exception
 * the caller needs to catch.
 *
 * `fetchImpl` is only ever overridden in tests (source-fetch.test.ts) - same pattern as
 * resolve-spec.ts's injectable `runner` - defaults to the real global fetch in production.
 */
export async function fetchSourceText(url: string, fetchImpl: typeof fetch = fetch): Promise<SourceFetchResult> {
  let currentUrl = url;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, reason: `not a valid URL: ${currentUrl}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: `unsupported scheme: ${parsed.protocol}` };
    }

    try {
      await assertPublicHost(parsed.hostname);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "SSRF guard rejected this host" };
    }

    // Transient network/timeout blips are observed in practice against real external hosts (same
    // reasoning as signVerdict/resolveSpecFromJobId/compileCriteria elsewhere in this codebase) -
    // retry the fetch itself a couple of times before giving up. Never retried: the SSRF-guard
    // rejection above and the content-type/redirect-shape checks below, which are deterministic
    // and would never succeed on a second attempt.
    let response: Response | undefined;
    let fetchError: unknown;
    for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        response = await fetchImpl(parsed.toString(), { redirect: "manual", signal: controller.signal });
        fetchError = undefined;
        break;
      } catch (err) {
        fetchError = err;
        if (attempt < FETCH_MAX_ATTEMPTS) await sleep(FETCH_RETRY_DELAY_MS * attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!response) {
      return { ok: false, reason: `fetch failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}` };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: `redirect (${response.status}) with no Location header` };
      currentUrl = new URL(location, parsed).toString();
      continue; // re-validated against the SSRF guard at the top of the next iteration
    }

    if (!response.ok) {
      return { ok: false, reason: `unreachable: HTTP ${response.status}` };
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return { ok: false, reason: `unsupported content-type: ${contentType || "(none)"}` };
    }

    const reader = response.body?.getReader();
    if (!reader) return { ok: false, reason: "response had no readable body" };
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { ok: false, reason: `response exceeded ${MAX_RESPONSE_BYTES} byte cap` };
      }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    const text = (contentType === "text/html" ? htmlToText(raw) : raw).slice(0, MAX_TEXT_LENGTH);
    return { ok: true, text, finalUrl: parsed.toString() };
  }

  return { ok: false, reason: `too many redirects (> ${MAX_REDIRECTS})` };
}
