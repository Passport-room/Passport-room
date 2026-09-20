// "I already paid on another phone" — restores an active membership onto this
// device using the email address the payment was made with.

import { createFileRoute } from "@tanstack/react-router";
import { NO_MEMBERSHIP, isEmail, restoreMembership, safeDeviceId } from "@/lib/membership.server";

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
    },
  },
});
