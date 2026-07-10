import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { verifyRoute } from "./routes/verify.js";

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.route("/", verifyRoute);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Vidimus D1 skeleton listening on http://localhost:${info.port}`);
});
