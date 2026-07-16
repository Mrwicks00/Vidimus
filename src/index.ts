import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { config } from "./config.js";
import { verifyRoute } from "./routes/verify.js";
import { demoRoute } from "./routes/demo.js";

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.route("/", verifyRoute);
app.route("/", demoRoute);

// Static frontend (web/, built by `npm run build` into web/dist) - served from the same
// process so the marketing/demo page and the priced API live on one Render service. Falls
// back to index.html for any unmatched GET so client-side routing (if ever added) still works.
const webDist = new URL("../web/dist", import.meta.url).pathname;
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
