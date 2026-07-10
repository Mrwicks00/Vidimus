import { Hono } from "hono";
import { x402Gate } from "../x402/middleware.js";
import { buildDummyVerdict } from "../verdict/dummy.js";

export const verifyRoute = new Hono();

verifyRoute.post("/verify", x402Gate, (c) => {
  const paymentId = c.get("paymentId");
  return c.json(buildDummyVerdict(paymentId));
});
