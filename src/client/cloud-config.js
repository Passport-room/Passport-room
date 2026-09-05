// Public cloud connection details.
//
// These two values are meant to be public (the same pair ships in every
// Supabase browser app). They are written here on purpose so the site keeps
// working when it is hosted somewhere else — GitHub + Vercel, Netlify, any
// static host — without setting up environment variables.
//
// All real work happens inside protected database routines, so this key cannot
// read or change anyone's data on its own.
export const CLOUD_URL = "https://ykdewaampxfergikntoa.supabase.co";
export const CLOUD_KEY = "sb_publishable_SdykgtJkaEZs4-gxd_iIEQ_JkzCNxMt";

/** Calls a protected database routine and returns its JSON result. */
export async function callCloud(fn, args, { keepalive = false } = {}) {
  const res = await fetch(`${CLOUD_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: CLOUD_KEY,
    },
    body: JSON.stringify(args),
    keepalive,
  });
  if (!res.ok) throw new Error(`cloud ${fn} failed (${res.status})`);
  return res.json();
}
