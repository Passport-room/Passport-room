// Paddle webhook — the only place that can unlock Pro access.
//
// Paddle signs every delivery. The signature is checked against the raw body
// before anything is stored, so nobody can grant themselves unlimited access
// by calling this endpoint.

import { createFileRoute } from "@tanstack/react-router";
import {
  activateMembership,
  fetchPaddleCustomerEmail,
  isEmail,
  paddleEnvironment,
  safeDeviceId,
  verifyPaddleSignature,
} from "@/lib/membership.server";

type PaddleEvent = {
  event_type?: string;
  data?: {
    id?: string;
    status?: string;
    customer_id?: string | null;
    custom_data?: Record<string, unknown> | null;
    items?: Array<{ price?: { id?: string } | null; price_id?: string }>;
    details?: { line_items?: Array<{ price_id?: string }> };
  };
};

const PAID_EVENTS = new Set(["transaction.completed", "transaction.paid"]);

export const Route = createFileRoute("/api/public/paddle/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["PADDLE_WEBHOOK_SECRET"];
        if (!secret) return new Response("webhook not configured", { status: 503 });

        const rawBody = await request.text();
        if (!verifyPaddleSignature(request.headers.get("paddle-signature"), rawBody, secret)) {
          return new Response("invalid signature", { status: 401 });
        }

        let event: PaddleEvent;
        try {
          event = JSON.parse(rawBody) as PaddleEvent;
        } catch {
          return new Response("invalid payload", { status: 400 });
        }

        const type = event.event_type ?? "";
        if (!PAID_EVENTS.has(type)) {
          // Acknowledge everything else so Paddle stops retrying.
          return Response.json({ ok: true, ignored: type });
        }

        const data = event.data ?? {};
        const custom = data.custom_data ?? {};
        const deviceId = safeDeviceId(custom["device_id"] ?? custom["deviceId"]);
        if (!deviceId) {
          return Response.json({ ok: true, skipped: "no device id in custom data" });
        }

        const priceId =
          data.items?.[0]?.price?.id ??
          data.items?.[0]?.price_id ??
          data.details?.line_items?.[0]?.price_id ??
          null;

        const customEmail = custom["email"];
        const email = isEmail(customEmail)
          ? customEmail.trim().toLowerCase()
          : await fetchPaddleCustomerEmail(data.customer_id ?? null);

        try {
          const record = await activateMembership({
            deviceId,
            email,
            transactionId: data.id ?? null,
            priceId,
            environment: paddleEnvironment(),
          });
          return Response.json({ ok: true, expiresAt: record.expiresAt });
        } catch (err) {
          console.error("[paddle-webhook] activation failed", err);
          // 500 makes Paddle retry, so a temporary database problem cannot
          // lose a paid membership.
          return new Response("activation failed", { status: 500 });
        }
      },
    },
  },
});
