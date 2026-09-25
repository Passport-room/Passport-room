import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { loadVisitors, type VisitorRow } from "@/lib/firebase";

const TITLE = "Passport Room Admin — Visitor Numbers & Usage";
const DESCRIPTION =
  "Password-protected admin panel showing every visitor's permanent customer number, visits, total time spent, photos made, country, browser and device.";

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
  const [password, setPassword] = useState("");
  const [visitors, setVisitors] = useState<VisitorRow[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      setVisitors(await loadVisitors(password));
    } catch {
      setError(true);
      setVisitors(null);
    } finally {
      setBusy(false);
    }
  }

  const totals = {
    users: visitors?.length ?? 0,
    visits: visitors?.reduce((s, v) => s + v.visitCount, 0) ?? 0,
    photos: visitors?.reduce((s, v) => s + v.photoCount, 0) ?? 0,
    ms: visitors?.reduce((s, v) => s + v.totalMs, 0) ?? 0,
  };

  if (!visitors) {
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
          {error && <p className="mt-2 text-sm text-destructive">Wrong secret. Try again.</p>}
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
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold text-foreground">Visitor tracking</h1>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Unique users", String(totals.users)],
            ["Home visits", String(totals.visits)],
            ["Photos made", String(totals.photos)],
            ["Total time", fmtTime(totals.ms)],
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
                {[
                  "Number",
                  "Country",
                  "Visits",
                  "Photos",
                  "Time spent",
                  "Browser",
                  "Device",
                  "OS",
                  "Last seen",
                ].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visitors.map((v) => (
                <tr key={v.id} className="border-t border-border text-card-foreground">
                  <td className="whitespace-nowrap px-3 py-2 font-mono">{v.id}</td>
                  <td className="whitespace-nowrap px-3 py-2">{v.country ?? "—"}</td>
                  <td className="px-3 py-2">{v.visitCount}</td>
                  <td className="px-3 py-2">{v.photoCount}</td>
                  <td className="whitespace-nowrap px-3 py-2">{fmtTime(v.totalMs)}</td>
                  <td className="px-3 py-2">{v.browser ?? "—"}</td>
                  <td className="px-3 py-2">{v.deviceType ?? "—"}</td>
                  <td className="px-3 py-2">{v.os ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {v.lastVisit ? new Date(v.lastVisit).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
              {visitors.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
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
