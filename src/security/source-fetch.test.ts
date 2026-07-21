// The actual HTTP fetch is always faked (injected fetchImpl, same pattern as resolve-spec.ts's
// injectable `runner`) - no live HTTP request in this suite. The SSRF-guard-triggering cases
// (loopback/private/metadata/bad-scheme URLs) never reach even DNS. The success-path cases do
// still perform a real DNS lookup of example.com/example.org (IANA-reserved for exactly this
// kind of documentation/test use, effectively always resolvable) to reach the injected fetchImpl
// at all - a small, deliberate pragmatic exception, not a live-network dependency on the actual
// fetch/response.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSourceText, isPrivateV4, isPrivateV6 } from "./source-fetch.js";

test("isPrivateV4: RFC1918, loopback, link-local (incl. cloud metadata), CGNAT", () => {
  assert.equal(isPrivateV4("10.1.2.3"), true);
  assert.equal(isPrivateV4("192.168.1.1"), true);
  assert.equal(isPrivateV4("172.16.0.5"), true);
  assert.equal(isPrivateV4("127.0.0.1"), true);
  assert.equal(isPrivateV4("169.254.169.254"), true); // cloud metadata
  assert.equal(isPrivateV4("100.64.0.1"), true); // CGNAT
  assert.equal(isPrivateV4("8.8.8.8"), false);
  assert.equal(isPrivateV4("1.1.1.1"), false);
});

test("isPrivateV6: loopback, unique-local, link-local, mapped-v4", () => {
  assert.equal(isPrivateV6("::1"), true);
  assert.equal(isPrivateV6("fc00::1"), true);
  assert.equal(isPrivateV6("fd12:3456::1"), true);
  assert.equal(isPrivateV6("fe80::1"), true);
  assert.equal(isPrivateV6("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateV6("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateV6("2001:4860:4860::8888"), false); // real public v6 (Google DNS)
});

test("fetchSourceText: rejects loopback/private URLs before ever touching the network", async () => {
  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    throw new Error("should never be called");
  }) as typeof fetch;

  const result = await fetchSourceText("http://127.0.0.1/secret", fakeFetch);
  assert.equal(result.ok, false);
  assert.equal(fetchCalled, false);
  if (!result.ok) assert.match(result.reason, /private|reserved/);
});

test("fetchSourceText: rejects the cloud metadata address", async () => {
  const result = await fetchSourceText("http://169.254.169.254/latest/meta-data/", async () => {
    throw new Error("should never be called");
  });
  assert.equal(result.ok, false);
});

test("fetchSourceText: rejects non-http(s) schemes without any lookup", async () => {
  const result = await fetchSourceText("file:///etc/passwd", async () => {
    throw new Error("should never be called");
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /scheme/);
});

function fakeResponse(opts: { status?: number; contentType?: string; body?: string; location?: string }): Response {
  const headers = new Headers();
  if (opts.contentType) headers.set("content-type", opts.contentType);
  if (opts.location) headers.set("location", opts.location);
  return new Response(opts.body ?? "", { status: opts.status ?? 200, headers });
}

test("fetchSourceText: successful text/plain fetch returns the body", async () => {
  const result = await fetchSourceText("https://example.com/article", async () => fakeResponse({ contentType: "text/plain", body: "hello world" }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "hello world");
});

test("fetchSourceText: strips HTML to plain text", async () => {
  const html = "<html><head><style>.x{}</style></head><body><script>evil()</script><h1>Title</h1><p>Body &amp; text</p></body></html>";
  const result = await fetchSourceText("https://example.com/page", async () => fakeResponse({ contentType: "text/html", body: html }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.doesNotMatch(result.text, /evil|<[a-z]/i);
    assert.match(result.text, /Title/);
    assert.match(result.text, /Body & text/);
  }
});

test("fetchSourceText: rejects a disallowed content-type", async () => {
  const result = await fetchSourceText("https://example.com/file.pdf", async () => fakeResponse({ contentType: "application/pdf", body: "%PDF-1.4" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /content-type/);
});

test("fetchSourceText: non-2xx status is unreachable, not thrown", async () => {
  const result = await fetchSourceText("https://example.com/missing", async () => fakeResponse({ status: 404, contentType: "text/plain" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /404/);
});

test("fetchSourceText: follows a redirect to another public host, re-validates it", async () => {
  let calls = 0;
  const result = await fetchSourceText("https://example.com/redirector", async (input) => {
    calls += 1;
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://example.com/redirector") {
      return fakeResponse({ status: 302, location: "https://example.org/real-article" });
    }
    return fakeResponse({ contentType: "text/plain", body: "the real content" });
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, "the real content");
  assert.equal(calls, 2);
});

test("fetchSourceText: a redirect to a private address is rejected, not followed", async () => {
  const result = await fetchSourceText("https://example.com/evil-redirector", async () => fakeResponse({ status: 302, location: "http://127.0.0.1/internal" }));
  assert.equal(result.ok, false);
});
