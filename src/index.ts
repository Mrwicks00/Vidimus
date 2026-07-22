import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { resolve } from "node:path";
import { Hono } from "hono";
import { paymentMiddleware } from "@okxweb3/x402-hono";
import { config } from "./config.js";
import { resourceServer, verifyRoutes } from "./x402/server.js";
import { verifyRoute } from "./routes/verify.js";
import { demoRoute } from "./routes/demo.js";
import { requirementsRoute } from "./routes/requirements.js";

// Node's fetch (undici) resolves IPv6 first by default; in this environment (and observed live
// on at least one deployment target) that IPv6 route to some hosts (e.g. openrouter.ai, used by
// m2-criteria-compiler.ts) hangs and times out (ETIMEDOUT) before ever falling back to a working
// IPv4 route - confirmed live: a plain `curl` to the same host succeeded every time (curl
// defaults differently), only Node's own fetch-based clients failed, intermittently. Forcing
// IPv4-first here fixes it at the source rather than depending on a NODE_OPTIONS env var being
// set correctly on every deployment target.
setDefaultResultOrder("ipv4first");

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
// Gates both GET and POST /verify with the official OKX x402 SDK - mounted globally (not per
// route) so the SDK's own route table is the single source of truth for which paths are paid,
// replacing the old per-route x402Gate middleware.
app.use(paymentMiddleware(verifyRoutes, resourceServer));
app.route("/", verifyRoute);
app.route("/", demoRoute);
// Free pre-flight (see src/routes/requirements.ts) - not in verifyRoutes above, so the
// paymentMiddleware's exact "/verify" route table never matches this distinct path.
app.route("/", requirementsRoute);

// Static frontend (web/, built by `npm run build` into web/dist) - served from the same
// process so the marketing/demo page and the priced API live on one Render service. Falls
// back to index.html for any unmatched GET so client-side routing (if ever added) still works.
// Resolved from process.cwd() rather than import.meta.url: the compiled entrypoint lives at
// dist/src/index.js, so a path relative to the module's own location would land on
// dist/web/dist instead of the real web/dist at the repo root. scripts/start.sh cds to
// the repo root before starting node, so cwd is reliable in both dev (tsx) and prod.
const webDist = resolve(process.cwd(), "web/dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: "web/dist" }));
  app.get("*", (c) => {
    const indexHtml = readFileSync(`${webDist}/index.html`, "utf8");
    return c.html(indexHtml);
  });
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Vidimus listening on http://localhost:${info.port}`);
});
