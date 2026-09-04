// Admin panel data access. The password lives only on the server (ADMIN_PASSWORD
// secret) and is compared with a timing-safe check.
import { createServerFn } from "@tanstack/react-start";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type VisitorRow = {
  customer_code: string;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  screen: string | null;
  visit_count: number;
  total_ms: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type AdminResult =
  | { ok: false }
  | { ok: true; visitors: VisitorRow[]; totalVisitors: number; totalVisits: number; totalMs: number };

function matches(input: string, expected: string) {
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export const getAdminStats = createServerFn({ method: "POST" })
  .inputValidator((data: { password: string }) => z.object({ password: z.string() }).parse(data))
  .handler(async ({ data }): Promise<AdminResult> => {
    const expected = process.env["ADMIN_PASSWORD"];
    if (!expected || !matches(data.password, expected)) return { ok: false };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows } = await supabaseAdmin
      .from("visitors")
      .select(
        "customer_code, device_type, browser, os, screen, visit_count, total_ms, first_seen_at, last_seen_at",
      )
      .order("last_seen_at", { ascending: false })
      .limit(500);

    const visitors = (rows ?? []).map((r) => ({ ...r, total_ms: Number(r.total_ms) })) as VisitorRow[];
    return {
      ok: true,
      visitors,
      totalVisitors: visitors.length,
      totalVisits: visitors.reduce((s, v) => s + v.visit_count, 0),
      totalMs: visitors.reduce((s, v) => s + v.total_ms, 0),
    };
  });
