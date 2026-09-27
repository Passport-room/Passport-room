// Current access status for a visitor (device id, optionally an email).
//
// Read-only and returns no personal data beyond the email the visitor already
// supplied, so it is safe for the public studio page to call.

import { createFileRoute } from "@tanstack/react-router";
import {
  NO_MEMBERSHIP,
  isEmail,
  resolveMembership,
  safeDeviceId,
  toStatus,
} from "@/lib/membership.server";

export const Route = createFileRoute("/api/public/membership")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const deviceId = safeDeviceId(url.searchParams.get("deviceId"));
        const emailParam = url.searchParams.get("email");
        const email = isEmail(emailParam) ? emailParam.trim().toLowerCase() : null;

        if (!deviceId && !email) {
          return Response.json(NO_MEMBERSHIP, { headers: { "cache-control": "no-store" } });
        }

        try {
          const record = await resolveMembership(deviceId, email);
          return Response.json(toStatus(record), { headers: { "cache-control": "no-store" } });
        } catch (err) {
          console.error("[membership] lookup failed", err);
          // Never block the studio because of a lookup problem.
          return Response.json(
            { ...NO_MEMBERSHIP, unavailable: true },
            { headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
