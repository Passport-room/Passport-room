// Paddle LIVE webhook — the only place that can unlock Pro access.
//
// Paddle signs every delivery. The signature is checked against the RAW body
// before anything is parsed or stored, so nobody can grant themselves
// unlimited access by calling this endpoint. On top of that we:
//   * verify with the notification SIGNING SECRET (never the API key),
//   * reject an invalid signature with 401 (non-2xx),
//   * claim the event id first, so retries never repeat a side effect,
//   * ignore snapshots that arrive out of order,
//   * only accept the one price id we sell (PADDLE_PRICE_ID) for access,
//   * acknowledge every other event type so Paddle stops retrying it.
//
// This handler never creates, changes or deletes anything inside Paddle.

import { createFileRoute } from "@tanstack/react-router";
import {
  activateMembership,
  claimEvent,
  claimTransaction,
  expectedPriceId,
  fetchPaddleCustomerEmail,
  isEmail,
  occurredAtMs,
  paddleEnvironment,
  releaseEvent,
  readPaddleSubscription,
  releaseTransaction,
  revokeMembership,
  safeDeviceId,
  upsertPaddleCustomer,
  upsertPaddleSubscription,
  verifyPaddleSignature,
} from "@/lib/membership.server";

type PaddleEvent = {
  event_id?: string;
  event_type?: string;
  occurred_at?: string;
  data?: {
    id?: string;
    status?: string;
    email?: string | null;
    name?: string | null;
    customer_id?: string | null;
    canceled_at?: string | null;
    paused_at?: string | null;
    created_at?: string | null;
    next_billed_at?: string | null;
    subscription_id?: string | null;
    current_billing_period?: { starts_at?: string | null; ends_at?: string | null } | null;
    trial_dates?: { starts_at?: string | null; ends_at?: string | null } | null;
    scheduled_change?: {
      action?: string | null;
      effective_at?: string | null;
      resume_at?: string | null;
    } | null;
    custom_data?: Record<string, unknown> | null;
    items?: Array<{
      price?: { id?: string; product_id?: string; product?: { id?: string } | null } | null;
      price_id?: string;
      product?: { id?: string } | null;
      product_id?: string;
    }>;
    details?: { line_items?: Array<{ price_id?: string; product_id?: string }> };
  };
};

type EventData = NonNullable<PaddleEvent["data"]>;

const PAID_EVENTS = new Set(["transaction.completed", "transaction.paid"]);
const PAID_STATUSES = new Set(["completed", "paid"]);
// The only statuses that mean the buyer is paid up right now.
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);
// Statuses whose *actual* value must remove paid access.
const REVOKING_SUBSCRIPTION_STATUSES = new Set(["canceled"]);
// Every subscription event we mirror into the database.
const SUBSCRIPTION_EVENTS = new Set([
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled",
  "subscription.imported",
]);

function collectPriceIds(data: EventData): string[] {
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

function collectProductIds(data: EventData): string[] {
  const ids: string[] = [];
  for (const item of data.items ?? []) {
    if (item?.price?.product_id) ids.push(item.price.product_id);
    if (item?.price?.product?.id) ids.push(item.price.product.id);
    if (item?.product?.id) ids.push(item.product.id);
    if (item?.product_id) ids.push(item.product_id);
  }
  for (const line of data.details?.line_items ?? []) {
    if (line?.product_id) ids.push(line.product_id);
  }
  return [...new Set(ids)];
}

function customDeviceId(data: EventData): string | null {
  const custom = data.custom_data ?? {};
  return safeDeviceId(custom["device_id"] ?? custom["deviceId"]);
}

function customEmail(data: EventData): string | null {
  const custom = data.custom_data ?? {};
  const value = custom["email"];
  return isEmail(value) ? value.trim().toLowerCase() : null;
}

export const Route = createFileRoute("/api/public/paddle/webhook")({
  server: {
    handlers: {
      // A GET is only a readiness probe — it never changes anything.
      GET: async () => {
        const secret = (process.env["PADDLE_WEBHOOK_SECRET"] ?? "").trim();
        return Response.json(
          {
            ok: Boolean(secret) && Boolean(expectedPriceId()),
            environment: paddleEnvironment(),
            signingSecretConfigured: Boolean(secret),
            priceConfigured: Boolean(expectedPriceId()),
            method: "POST",
          },
          { headers: { "cache-control": "no-store" } },
        );
      },

      POST: async ({ request }) => {
        // The notification signing secret — NOT the Paddle API key.
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
        const eventId = event.event_id ?? null;
        const occurredAt = occurredAtMs(event.occurred_at);
        const data = event.data ?? {};

        const handled =
          PAID_EVENTS.has(type) ||
          type === "customer.created" ||
          type === "customer.updated" ||
          type === "customer.imported" ||
          SUBSCRIPTION_EVENTS.has(type);

        // Anything we do not need is safely ignored with a 2xx.
        if (!handled) return Response.json({ ok: true, ignored: type });

        let claimedEvent = false;
        try {
          // Delivery-level idempotency: a retry of the same event is a no-op.
          if (eventId) {
            if (!(await claimEvent(eventId))) {
              return Response.json({ ok: true, duplicate: true, eventId });
            }
            claimedEvent = true;
          }

          if (
            type === "customer.created" ||
            type === "customer.updated" ||
            type === "customer.imported"
          ) {
            const id = data.id ?? null;
            if (!id) return Response.json({ ok: true, skipped: "no customer id" });
            const result = await upsertPaddleCustomer({
              id,
              email: isEmail(data.email) ? data.email : null,
              name: data.name ?? null,
              status: data.status ?? null,
              createdAt: data.created_at ?? null,
              occurredAt,
            });
            return Response.json({ ok: true, customer: result });
          }

          if (SUBSCRIPTION_EVENTS.has(type)) {
            const id = data.id ?? data.subscription_id ?? null;
            if (!id) return Response.json({ ok: true, skipped: "no subscription id" });

            const status =
              type === "subscription.canceled" ? "canceled" : (data.status ?? "").toLowerCase();
            const priceIds = collectPriceIds(data);
            const productIds = collectProductIds(data);
            const stored = await readPaddleSubscription(id);
            const deviceId = customDeviceId(data) ?? safeDeviceId(stored?.deviceId);
            const email =
              customEmail(data) ??
              (await fetchPaddleCustomerEmail(data.customer_id ?? null)) ??
              stored?.email ??
              null;
            const scheduled = data.scheduled_change
              ? {
                  action: data.scheduled_change.action ?? null,
                  effectiveAt: data.scheduled_change.effective_at ?? null,
                  resumeAt: data.scheduled_change.resume_at ?? null,
                }
              : null;

            // UPSERT: the same subscription id always rewrites one row, so a
            // duplicate delivery can never create a second record.
            const result = await upsertPaddleSubscription({
              id,
              customerId: data.customer_id ?? null,
              status,
              priceIds,
              productIds,
              deviceId,
              email,
              scheduledChange: scheduled,
              currentPeriodStart: data.current_billing_period?.starts_at ?? null,
              currentPeriodEnd: data.current_billing_period?.ends_at ?? null,
              nextBilledAt: data.next_billed_at ?? null,
              trialEndsAt: data.trial_dates?.ends_at ?? null,
              canceledAt: data.canceled_at ?? null,
              pausedAt: data.paused_at ?? null,
              createdAt: data.created_at ?? null,
              occurredAt,
            });

            // A scheduled cancellation or pause is only recorded above — it
            // never removes access. Only the real status does.
            if (REVOKING_SUBSCRIPTION_STATUSES.has(status)) {
              const revoked = await revokeMembership({
                deviceId,
                email,
                reason: `subscription ${status}`,
              });
              return Response.json({
                ok: true,
                subscription: result,
                status,
                granted: false,
                access: revoked,
              });
            }

            const wanted = expectedPriceId();
            const grants =
              result === "stored" &&
              Boolean(wanted) &&
              Boolean(deviceId) &&
              ACTIVE_SUBSCRIPTION_STATUSES.has(status) &&
              priceIds.includes(wanted as string);

            if (!grants) {
              return Response.json({ ok: true, subscription: result, status, granted: false });
            }

            // One grant per billing period — replays and later snapshots of
            // the same period are ignored by the claim below.
            const periodKey = `${id}-${data.current_billing_period?.starts_at ?? "initial"}`;
            if (!(await claimTransaction(periodKey))) {
              return Response.json({ ok: true, subscription: result, granted: false, seen: true });
            }
            try {
              const record = await activateMembership({
                deviceId: deviceId as string,
                email,
                transactionId: periodKey,
                priceId: wanted,
                environment: paddleEnvironment(),
              });
              return Response.json({ ok: true, granted: true, expiresAt: record.expiresAt });
            } catch (err) {
              await releaseTransaction(periodKey);
              throw err;
            }
          }

          /* ---------------------- transaction.completed ---------------------- */

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
          if (!collectPriceIds(data).includes(wanted)) {
            return Response.json({ ok: true, skipped: "price id does not match" });
          }

          const deviceId = customDeviceId(data);
          if (!deviceId) {
            return Response.json({ ok: true, skipped: "no device id in custom data" });
          }

          const transactionId = data.id ?? null;

          // Idempotency: a replayed or retried delivery is acknowledged
          // without adding another 30 days.
          if (transactionId && !(await claimTransaction(transactionId))) {
            return Response.json({ ok: true, duplicate: true });
          }

          try {
            const email =
              customEmail(data) ?? (await fetchPaddleCustomerEmail(data.customer_id ?? null));
            const record = await activateMembership({
              deviceId,
              email,
              transactionId,
              priceId: wanted,
              environment: paddleEnvironment(),
            });
            return Response.json({ ok: true, expiresAt: record.expiresAt });
          } catch (err) {
            if (transactionId) await releaseTransaction(transactionId);
            throw err;
          }
        } catch (err) {
          console.error(`[paddle-webhook] ${type} failed`, err);
          // Free the event claim so Paddle's retry can succeed, then 500 so a
          // temporary database problem cannot lose a paid membership.
          if (claimedEvent) await releaseEvent(eventId);
          return new Response("processing failed", { status: 500 });
        }
      },
    },
  },
});
