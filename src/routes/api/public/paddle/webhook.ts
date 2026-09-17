// Paddle webhook — the only place that can unlock Pro access.
//
// Paddle signs every delivery. The signature is checked against the RAW body
// before anything is parsed or stored, so nobody can grant themselves
// unlimited access by calling this endpoint. On top of that we:
//   * only accept the one price id we sell (PADDLE_PRICE_ID),
//   * only accept completed/paid transactions,
//   * claim the transaction id first, so retries never add extra days.

import { createFileRoute } from "@tanstack/react-router";
import {
  activateMembership,
  claimTransaction,
  expectedPriceId,
  fetchPaddleCustomerEmail,
  isEmail,
  paddleEnvironment,
  releaseTransaction,
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
const PAID_STATUSES = new Set(["completed", "paid"]);

function collectPriceIds(data: NonNullable<PaddleEvent["data"]>): string[] {
  const ids: string[] = [];
  for (const item of data.items ?? []) {
    if (item?.price?.id) ids.push(item.price.id);
    if (item?.price_id) ids.push(item.price_id);
  }
  for (const line of data.details?.line_items ?? []) {
    if (line?.price_id) ids.push(line.price_id);
  }
  return ids;
}

export const Route = createFileRoute("/api/public/paddle/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = (process.env["PADDLE_WEBHOOK_SECRET"] ?? "").trim();
        if (!secret) return new Response("webhook not configured", { status: 503 });

        // Raw body: signature is computed over the exact bytes Paddle sent.
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

        const status = (data.status ?? "").toLowerCase();
        if (status && !PAID_STATUSES.has(status)) {
          return Response.json({ ok: true, skipped: `status ${status}` });
        }

        // Only the price we actually sell may unlock access.
        const wanted = expectedPriceId();
        if (!wanted) {
          console.error("[paddle-webhook] PADDLE_PRICE_ID is not configured");
          return new Response("price not configured", { status: 503 });
        }
        const priceIds = collectPriceIds(data);
        if (!priceIds.includes(wanted)) {
          return Response.json({ ok: true, skipped: "price id does not match" });
        }

        const custom = data.custom_data ?? {};
        const deviceId = safeDeviceId(custom["device_id"] ?? custom["deviceId"]);
        if (!deviceId) {
          return Response.json({ ok: true, skipped: "no device id in custom data" });
        }

        const transactionId = data.id ?? null;

        try {
          // Idempotency: a replayed or retried delivery is acknowledged
          // without adding another 30 days.
          if (transactionId && !(await claimTransaction(transactionId))) {
            return Response.json({ ok: true, duplicate: true });
          }

          const customEmail = custom["email"];
          const email = isEmail(customEmail)
            ? customEmail.trim().toLowerCase()
            : await fetchPaddleCustomerEmail(data.customer_id ?? null);

          const record = await activateMembership({
            deviceId,
            email,
            transactionId,
            priceId: wanted,
            environment: paddleEnvironment(),
          });
          return Response.json({ ok: true, expiresAt: record.expiresAt });
        } catch (err) {
          console.error("[paddle-webhook] activation failed", err);
          if (transactionId) await releaseTransaction(transactionId);
          // 500 makes Paddle retry, so a temporary database problem cannot
          // lose a paid membership.
          return new Response("activation failed", { status: 500 });
        }
      },
    },
  },
});
