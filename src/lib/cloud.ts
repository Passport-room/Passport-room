// Public cloud connection details for the admin page.
//
// Same publishable pair as src/client/cloud-config.js. It is safe in the code
// (that is what publishable keys are for) and it means the site needs no
// environment variables when hosted on Vercel, Netlify or any static host.
export const CLOUD_URL = "https://ykdewaampxfergikntoa.supabase.co";
export const CLOUD_KEY = "sb_publishable_SdykgtJkaEZs4-gxd_iIEQ_JkzCNxMt";

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

/** Loads the visitor list. Rejects when the secret is wrong. */
export async function loadVisitors(password: string): Promise<VisitorRow[]> {
  const res = await fetch(`${CLOUD_URL}/rest/v1/rpc/admin_visitors`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: CLOUD_KEY },
    body: JSON.stringify({ p_password: password }),
  });
  if (!res.ok) throw new Error("unauthorized");
  const rows = (await res.json()) as VisitorRow[];
  return rows.map((r) => ({ ...r, total_ms: Number(r.total_ms) }));
}
