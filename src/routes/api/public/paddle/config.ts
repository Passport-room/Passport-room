// Public checkout settings for the browser.
//
// The Paddle client-side token and price id are publishable values (they are
// designed to live in a web page). Serving them from here instead of baking
// them into the bundle means switching from Sandbox to Live is just an
// environment-variable change — no rebuild.

import { createFileRoute } from "@tanstack/react-router";
import { FREE_DAILY_LIMIT, PLAN_DAYS, paddleEnvironment } from "@/lib/membership.server";

export const Route = createFileRoute("/api/public/paddle/config")({
  server: {
    handlers: {
      GET: async () => {
        const clientToken = (process.env["PADDLE_CLIENT_TOKEN"] ?? "").trim() || null;
        const rawPriceId = (process.env["PADDLE_PRICE_ID"] ?? "").trim();
        // Checkout needs a *price* id (pri_...). A product id (pro_...) would
        // make Paddle reject the checkout, so treat it as "not configured yet".
        const priceId = rawPriceId.startsWith("pri_") ? rawPriceId : null;
        return Response.json(
          {
            configured: Boolean(clientToken && priceId),
            environment: paddleEnvironment(),
            clientToken,
            priceId,
            priceLabel: process.env["PADDLE_PRICE_LABEL"] ?? "$0.99",
            planDays: PLAN_DAYS,
            freeDailyLimit: FREE_DAILY_LIMIT,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
