/* Consent-controlled Firebase visitor identity. No remote analytics database writes. */
const config = {
  apiKey: 'AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM',
  authDomain: 'passport-48389.firebaseapp.com',
  projectId: 'passport-48389',
  appId: '1:222961536167:web:618360108d616b8f129f82'
};
const PROFILE_KEY = 'pr_anonymous_visitor_v1';
let auth, sdk, profile = null, busy = false, unsubscribe;
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function removeProfile() { try { localStorage.removeItem(PROFILE_KEY); } catch {} profile = null; }
function consent() { return read('pr_cookie_consent') === 'accepted'; }
function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function render(status) {
  setText('visitorName', profile?.name || 'Guest');
  setText('visitorUid', profile?.uid || 'Not assigned');
  setText('visitorStatus', status || (profile ? `Visits in this browser: ${profile.visits} · Firebase visitor account active` : 'Visitor tracking is off until you accept cookies.'));
  const button = document.getElementById('profileBtn');
  if (button) button.setAttribute('aria-label', profile ? `Your profile: ${profile.name}, user ID ${profile.uid}` : 'Your profile');
}
function randomName(uid) {
  const words = ['Sunny', 'Calm', 'Bright', 'Swift', 'Happy', 'Kind', 'Brave', 'Gentle'];
  const nouns = ['Robin', 'Panda', 'Otter', 'Falcon', 'Dolphin', 'Fox', 'Sparrow', 'Tiger'];
  const values = new Uint32Array(3); crypto.getRandomValues(values);
  return `${words[values[0] % words.length]} ${nouns[values[1] % nouns.length]} ${String(values[2] % 10000).padStart(4, '0')}`;
}
let countedUid = null;
function showUser(user) {
  if (!consent() || !user?.isAnonymous) return;
  let saved;
  try { saved = JSON.parse(read(PROFILE_KEY) || 'null'); } catch {}
  const now = new Date().toISOString();
  profile = saved?.uid === user.uid ? saved : { uid: user.uid, name: randomName(user.uid), visits: 0, firstVisit: now };
  if (countedUid !== user.uid) { profile.visits = (Number(profile.visits) || 0) + 1; countedUid = user.uid; }
  profile.lastVisit = now;
  let stored = true;
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { stored = false; }
  render(stored ? undefined : 'Firebase connected; browser storage is unavailable, so this profile may not survive a reload.');
}
async function start() {
  if (busy || !consent()) return;
  busy = true; render('Connecting to Firebase…');
  try {
    if (!auth) {
      const [appSdk, authSdk] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js')
      ]);
      sdk = authSdk;
      const app = appSdk.initializeApp(config, 'passport-visitor');
      auth = sdk.getAuth(app);
      await sdk.setPersistence(auth, sdk.browserLocalPersistence);
      await auth.authStateReady();
      unsubscribe = sdk.onAuthStateChanged(auth, user => { if (consent()) showUser(user); });
    }
    if (!consent()) { await sdk.signOut(auth); return; }
    if (auth.currentUser?.isAnonymous) showUser(auth.currentUser);
    else if (auth.currentUser) render('Visitor identity is unavailable for this session.');
    else {
      const result = await sdk.signInAnonymously(auth);
      if (consent()) showUser(result.user);
      else await sdk.signOut(auth);
    }
  } catch {
    if (consent()) { profile = null; render('Unable to connect to Firebase. Check your connection and reopen your profile to retry. Photo tools still work.'); }
  } finally { busy = false; if (!consent()) render(); }
}
async function stop() {
  removeProfile(); countedUid = null; render();
  if (auth && sdk) { try { await sdk.signOut(auth); } catch {} }
}
window.addEventListener('pr:consent', event => { if (event.detail === 'accepted') start(); else stop(); });
window.addEventListener('storage', event => { if (event.key === 'pr_cookie_consent') { if (consent()) start(); else stop(); } });
document.getElementById('profileBtn')?.addEventListener('click', () => { render(); if (consent() && !profile) start(); });
render();
if (consent()) start(); else stop();
