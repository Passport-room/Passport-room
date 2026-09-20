// "I already paid on another phone" — restores an active membership onto this
// device using the email address the payment was made with.

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import {
  NO_MEMBERSHIP,
  isEmail,
  provisionMembershipForPaidEmail,
  restoreMembership,
  safeDeviceId,
} from "@/lib/membership.server";

/** Shared secret for the admin-only recovery below (PUT). */
function adminSecretMatches(provided: unknown): boolean {
  const expected =
    (process.env["MEMBERSHIP_ADMIN_SECRET"] ?? "").trim() ||
    (process.env["FIREBASE_DB_SECRET"] ?? "").trim();
  if (!expected || typeof provided !== "string" || !provided.trim()) return false;
  const a = Buffer.from(provided.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/membership/restore")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { email?: unknown; deviceId?: unknown };
        try {
          body = (await request.json()) as { email?: unknown; deviceId?: unknown };
        } catch {
          return new Response("invalid payload", { status: 400 });
        }

        const deviceId = safeDeviceId(body.deviceId);
        const email = isEmail(body.email) ? body.email.trim().toLowerCase() : null;
        if (!deviceId || !email) {
          return Response.json(
            { ...NO_MEMBERSHIP, error: "Enter the email address you paid with." },
            { status: 400 },
          );
        }

        try {
          const status = await restoreMembership(email, deviceId);
          return Response.json(status, { headers: { "cache-control": "no-store" } });
        } catch (err) {
          console.error("[membership-restore] failed", err);
          return Response.json(
            { ...NO_MEMBERSHIP, error: "Could not check that email right now. Try again." },
            { status: 500 },
          );
        }
      },

      // Admin recovery for a customer who already paid: grants the 30-day Pro
      // membership from the payment that already exists in Paddle. Requires the
      // admin secret, and never charges or changes anything inside Paddle.
      PUT: async ({ request }) => {
        let body: {
          secret?: unknown;
          email?: unknown;
          transactionId?: unknown;
          deviceId?: unknown;
        };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return new Response("invalid payload", { status: 400 });
        }

        const provided =
          typeof body.secret === "string" ? body.secret : request.headers.get("x-admin-secret");
        if (!adminSecretMatches(provided)) return new Response("unauthorized", { status: 401 });

        const email = isEmail(body.email) ? body.email.trim().toLowerCase() : null;
        if (!email) {
          return Response.json(
            { ...NO_MEMBERSHIP, error: "A valid email address is required." },
            { status: 400 },
          );
        }

        try {
          const result = await provisionMembershipForPaidEmail({
            email,
            transactionId: typeof body.transactionId === "string" ? body.transactionId : null,
            deviceId: safeDeviceId(body.deviceId),
          });
          return Response.json(
            { ...result.status, source: result.source, email },
            { headers: { "cache-control": "no-store" } },
          );
        } catch (err) {
          console.error("[membership-provision] failed", err);
          return Response.json(
            { ...NO_MEMBERSHIP, error: "Could not provision that membership right now." },
            { status: 500 },
          );
        }
      },
    },
  },
});
