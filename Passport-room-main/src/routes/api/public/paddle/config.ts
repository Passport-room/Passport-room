// Public checkout settings for the browser.
//
// The Paddle client-side token and price id are publishable values (they are
// designed to live in a web page). Serving them from here instead of baking
// them into the bundle means switching from Sandbox to Live is just an
// environment-variable change — no rebuild.
//
// Secret values (PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, FIREBASE_DB_SECRET) are
// NEVER returned here — only their *names* when they are missing, so the owner
// can see what still needs configuring on Vercel.

import { createFileRoute } from "@tanstack/react-router";
import {
  FREE_DAILY_LIMIT,
  PLAN_DAYS,
  expectedPriceId,
  paddleEnvironment,
  paddleReadiness,
} from "@/lib/membership.server";

export const Route = createFileRoute("/api/public/paddle/config")({
  server: {
    handlers: {
      GET: async () => {
        const clientToken = (process.env["PADDLE_CLIENT_TOKEN"] ?? "").trim() || null;
        // Checkout needs a *price* id (pri_...). A product id (pro_...) would
        // make Paddle reject the checkout, so treat it as "not configured yet".
        const priceId = expectedPriceId();
        const { configured, missing } = paddleReadiness();

        return Response.json(
          {
            configured,
            missing,
            environment: paddleEnvironment(),
            clientToken: configured ? clientToken : null,
            priceId,
            priceLabel: (process.env["PADDLE_PRICE_LABEL"] ?? "").trim() || "$0.99",
            planDays: PLAN_DAYS,
            freeDailyLimit: FREE_DAILY_LIMIT,
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
