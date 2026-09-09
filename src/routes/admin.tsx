import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { loadVisitors, type VisitorRow } from "@/lib/firebase";

const TITLE = "Passport Room Admin — Visitor Codes & Usage";
const DESCRIPTION =
  "Password-protected admin panel showing every visitor's permanent code, visits, time spent, photos made per tool, country, browser and device.";

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

const fmtDate = (t: number) => (t ? new Date(t).toLocaleString() : "—");

type SortKey = "code" | "country" | "visits" | "photos" | "totalMs" | "createdAt" | "lastSeenAt";

const COLUMNS: { key: SortKey | null; label: string }[] = [
  { key: "code", label: "Code" },
  { key: "country", label: "Country" },
  { key: "visits", label: "Visits" },
  { key: "photos", label: "Photos" },
  { key: null, label: "Single / Sheet / Dress / Enhance / Cutout" },
  { key: "totalMs", label: "Time spent" },
  { key: null, label: "Browser" },
  { key: null, label: "Device" },
  { key: null, label: "System" },
  { key: null, label: "Screen" },
  { key: null, label: "Language" },
  { key: "createdAt", label: "First seen" },
  { key: "lastSeenAt", label: "Last seen" },
];

function toCsv(rows: VisitorRow[]) {
  const head = [
    "code",
    "country",
    "visits",
    "photos_total",
    "single",
    "sheet",
    "dress",
    "enhance",
    "bgremove",
    "time_spent_seconds",
    "browser",
    "device",
    "system",
    "screen",
    "language",
    "time_zone",
    "first_seen",
    "last_seen",
    "carried_over_from",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((v) =>
    [
      v.code,
      v.country,
      v.visits,
      v.photos.total,
      v.photos.single,
      v.photos.sheet,
      v.photos.dress,
      v.photos.enhance,
      v.photos.bgremove,
      Math.round(v.totalMs / 1000),
      v.browser,
      v.deviceType,
      v.os,
      v.screen,
      v.language,
      v.timeZone,
      fmtDate(v.createdAt),
      fmtDate(v.lastSeenAt),
      v.migratedFrom,
    ]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

function Admin() {
  const [password, setPassword] = useState("");
  const [visitors, setVisitors] = useState<VisitorRow[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "lastSeenAt",
    dir: -1,
  });

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

  const rows = useMemo(() => {
    if (!visitors) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? visitors.filter((v) =>
          [v.code, v.country, v.browser, v.os, v.deviceType, v.language, v.timeZone]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : visitors;
    const { key, dir } = sort;
    return [...filtered].sort((a, b) => {
      const av = key === "photos" ? a.photos.total : a[key];
      const bv = key === "photos" ? b.photos.total : b[key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [visitors, query, sort]);

  const totals = {
    users: rows.length,
    visits: rows.reduce((s, v) => s + v.visits, 0),
    photos: rows.reduce((s, v) => s + v.photos.total, 0),
    ms: rows.reduce((s, v) => s + v.totalMs, 0),
  };

  function downloadCsv() {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "passport-room-visitors.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!visitors) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <form
          onSubmit={submit}
          className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg"
        >
          <h1 className="text-xl font-semibold text-card-foreground">Admin panel</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your admin secret to see visitor codes and usage.
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
      <div className="mx-auto max-w-7xl">
        <h1 className="text-2xl font-semibold text-foreground">Visitor tracking</h1>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Unique visitors", String(totals.users)],
            ["Visits", String(totals.visits)],
            ["Photos made", String(totals.photos)],
            ["Total time", fmtTime(totals.ms)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border bg-card p-4">
              <div className="text-2xl font-semibold text-card-foreground">{value}</div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search code, country, browser…"
            className="w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={downloadCsv}
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Export CSV
          </button>
          <button
            onClick={() => loadVisitors(password).then(setVisitors).catch(() => setError(true))}
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.label} className="whitespace-nowrap px-3 py-2 font-medium">
                    {c.key ? (
                      <button
                        onClick={() =>
                          setSort((s) =>
                            s.key === c.key
                              ? { key: s.key, dir: s.dir === 1 ? -1 : 1 }
                              : { key: c.key as SortKey, dir: -1 },
                          )
                        }
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {c.label}
                        {sort.key === c.key ? (sort.dir === 1 ? "▲" : "▼") : ""}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.uid} className="border-t border-border text-card-foreground">
                  <td className="whitespace-nowrap px-3 py-2 font-mono">
                    {v.code}
                    {v.migratedFrom && (
                      <span
                        title={`Carried over from ${v.migratedFrom}`}
                        className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                      >
                        carried over
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{v.country ?? "—"}</td>
                  <td className="px-3 py-2">{v.visits}</td>
                  <td className="px-3 py-2">{v.photos.total}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {v.photos.single} / {v.photos.sheet} / {v.photos.dress} / {v.photos.enhance} /{" "}
                    {v.photos.bgremove}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{fmtTime(v.totalMs)}</td>
                  <td className="px-3 py-2">{v.browser ?? "—"}</td>
                  <td className="px-3 py-2">{v.deviceType ?? "—"}</td>
                  <td className="px-3 py-2">{v.os ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">{v.screen ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">{v.language ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {fmtDate(v.createdAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {fmtDate(v.lastSeenAt)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-muted-foreground">
                    No visitors match.
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
