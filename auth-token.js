/* Shared Firebase sign-in for review/referral writes.
   The database only accepts these writes from a signed-in visitor, so every
   send needs an ID token. The token is cached in localStorage for 50 minutes
   (tokens live 60), so a review submit usually needs no sign-in round trip. */
const config = { apiKey: 'AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM', authDomain: 'passport-48389.firebaseapp.com', projectId: 'passport-48389', appId: '1:222961536167:web:618360108d616b8f129f82' };
const APP = 'passport-survey';
const KEY = 'pr_id_token_cache';
let pending = null;
const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

function cached() {
  try {
    const v = JSON.parse(read(KEY) || 'null');
    if (v && v.t && v.uid && v.exp && Date.now() < v.exp) return v;
  } catch {}
  return null;
}

async function fresh() {
  const [appSdk, authSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js')
  ]);
  const app = appSdk.getApps().find(x => x.name === APP) || appSdk.initializeApp(config, APP);
  const auth = authSdk.getAuth(app);
  await auth.authStateReady();
  // The session persists in the browser, so after the first-ever sign-in this
  // restores instantly with no network call.
  const user = auth.currentUser || (await authSdk.signInAnonymously(auth)).user;
  const t = await user.getIdToken();
  const v = { t, uid: user.uid, exp: Date.now() + 50 * 60 * 1000 };
  write(KEY, JSON.stringify(v));
  return v;
}

export function idToken(force = false) {
  if (!force) { const c = cached(); if (c) return Promise.resolve(c); }
  if (!pending) pending = fresh().catch(error => { pending = null; throw error; });
  return pending;
}

export function clearToken() { try { localStorage.removeItem(KEY); } catch {} pending = null; }

// Pre-warm right after cookie accept so a later review submit has no auth wait.
if (read('pr_cookie_consent') === 'accepted' && !cached()) idToken().catch(() => {});
