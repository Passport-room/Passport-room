// Anonymous visitor tracking endpoint.
//
// The public studio page (static /public/index.html) posts here. All database
// work happens server-side with the service role, so the browser can never read
// other people's rows and the customer number can never be forged or changed.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const payloadSchema = z.object({
  device_id: z.string().min(8).max(80),
  device_type: z.string().max(20).optional(),
  browser: z.string().max(40).optional(),
  os: z.string().max(40).optional(),
  screen: z.string().max(20).optional(),
  event: z.enum(["visit", "time"]).default("visit"),
  duration_ms: z.number().int().min(0).max(6 * 60 * 60 * 1000).default(0),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const Route = createFileRoute("/api/public/track")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ error: "Invalid payload" }, 400);
        const p = parsed.data;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Create the visitor row once; the customer number is assigned by the
        // database on first insert and never touched again.
        const { data: existing } = await supabaseAdmin
          .from("visitors")
          .select("customer_code, visit_count, total_ms")
          .eq("device_id", p.device_id)
          .maybeSingle();

        let code = existing?.customer_code ?? null;
        if (!existing) {
          const { data: created, error } = await supabaseAdmin
            .from("visitors")
            .insert({
              device_id: p.device_id,
              device_type: p.device_type ?? null,
              browser: p.browser ?? null,
              os: p.os ?? null,
              screen: p.screen ?? null,
            })
            .select("customer_code")
            .single();
          if (error) return json({ error: "Could not register device" }, 500);
          code = created.customer_code;
        }

        const nextVisits = (existing?.visit_count ?? 0) + (p.event === "visit" ? 1 : 0);
        const nextMs = Number(existing?.total_ms ?? 0) + p.duration_ms;

        await supabaseAdmin
          .from("visitors")
          .update({
            last_seen_at: new Date().toISOString(),
            visit_count: nextVisits,
            total_ms: nextMs,
            device_type: p.device_type ?? null,
            browser: p.browser ?? null,
            os: p.os ?? null,
            screen: p.screen ?? null,
          })
          .eq("device_id", p.device_id);

        await supabaseAdmin
          .from("visitor_events")
          .insert({ device_id: p.device_id, event_type: p.event, duration_ms: p.duration_ms });

        return json({ customer_code: code, visits: nextVisits, total_ms: nextMs });
      },
    },
  },
});
