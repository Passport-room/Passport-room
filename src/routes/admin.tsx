import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getAdminStats, type AdminResult } from "@/lib/admin.functions";

const TITLE = "Passport Room Admin — Visitor Numbers & Usage";
const DESCRIPTION =
  "Password-protected admin panel showing every visitor's permanent customer number, visit count, total time spent, browser and device.";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: Admin,
});

function fmtTime(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Admin() {
  const load = useServerFn(getAdminStats);
  const [password, setPassword] = useState("");
  const [state, setState] = useState<AdminResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setState(await load({ data: { password } }));
    } finally {
      setBusy(false);
    }
  }

  if (!state?.ok) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <form
          onSubmit={submit}
          className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg"
        >
          <h1 className="text-xl font-semibold text-card-foreground">Admin panel</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your admin secret to see visitor numbers and usage.
          </p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin secret"
            autoComplete="current-password"
            className="mt-4 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          {state && !state.ok && (
            <p className="mt-2 text-sm text-destructive">Wrong secret. Try again.</p>
          )}
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-semibold text-foreground">Visitor tracking</h1>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            ["Unique users", String(state.totalVisitors)],
            ["Home visits", String(state.totalVisits)],
            ["Total time", fmtTime(state.totalMs)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border bg-card p-4">
              <div className="text-2xl font-semibold text-card-foreground">{value}</div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {["Number", "Visits", "Time spent", "Browser", "Device", "OS", "Last seen"].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.visitors.map((v) => (
                <tr key={v.customer_code} className="border-t border-border text-card-foreground">
                  <td className="whitespace-nowrap px-3 py-2 font-mono">{v.customer_code}</td>
                  <td className="px-3 py-2">{v.visit_count}</td>
                  <td className="whitespace-nowrap px-3 py-2">{fmtTime(v.total_ms)}</td>
                  <td className="px-3 py-2">{v.browser ?? "—"}</td>
                  <td className="px-3 py-2">{v.device_type ?? "—"}</td>
                  <td className="px-3 py-2">{v.os ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {new Date(v.last_seen_at).toLocaleString()}
                  </td>
                </tr>
              ))}
              {state.visitors.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    No visitors recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
