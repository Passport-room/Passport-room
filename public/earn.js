/* Earn page: Offerwall.GG wall for the visitor's Firebase user ID + live coin balance. */
const config = { apiKey: 'AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM', authDomain: 'passport-48389.firebaseapp.com', projectId: 'passport-48389', appId: '1:222961536167:web:618360108d616b8f129f82' };
const DB_URL = 'https://passport-48389-default-rtdb.firebaseio.com';
const WALL = 'https://offerwall.gg/wall/c0d9316557f3d9db1ad4997bef387970';
const $ = id => document.getElementById(id);
const consent = () => { try { return localStorage.getItem('pr_cookie_consent') === 'accepted'; } catch { return false; } };
let started = false;

async function start() {
  if (started || !consent()) return;
  started = true;
  $('earnStatus').textContent = 'Connecting…';
  try {
    const [appSdk, authSdk, dbSdk] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js')
    ]);
    // Same named app as visitor-profile.js, so the user ID matches the profile.
    const app = appSdk.getApps().find(a => a.name === 'passport-visitor') || appSdk.initializeApp(config, 'passport-visitor');
    const auth = authSdk.getAuth(app);
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    await auth.authStateReady();
    const user = auth.currentUser || (await authSdk.signInAnonymously(auth)).user;
    $('earnUid').textContent = user.uid;
    const frame = $('earnWall');
    frame.src = `${WALL}?userId=${encodeURIComponent(user.uid)}`;
    frame.hidden = false;
    $('earnGate').hidden = true;
    $('earnStatus').textContent = '';
    dbSdk.onValue(dbSdk.ref(dbSdk.getDatabase(app, DB_URL), `wallets/${user.uid}/coins`), s => {
      $('earnCoins').textContent = (Number(s.val()) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    });
  } catch {
    started = false;
    $('earnStatus').textContent = 'Could not connect. Check your connection and reload.';
  }
}
window.addEventListener('pr:consent', e => { if (e.detail === 'accepted') start(); });
if (consent()) start();
