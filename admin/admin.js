/* Read-only admin panel. Sign-in uses Firebase Authentication (email/password).
   Access to data is decided by the Realtime Database rules (admins/{uid} === true),
   not by this file. No passwords, secrets or service-account keys are in this code. */
const config = { apiKey: 'AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM', authDomain: 'passport-48389.firebaseapp.com', projectId: 'passport-48389', appId: '1:222961536167:web:618360108d616b8f129f82' };
const DB = 'https://passport-48389-default-rtdb.firebaseio.com';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = v => (v === undefined || v === null || v === '') ? '—' : esc(v);
const when = ms => Number(ms) > 0 ? esc(new Date(Number(ms)).toLocaleString()) : '—';
const dur = ms => { if (!(Number(ms) >= 0) || ms === undefined) return '—'; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`; };

const [appSdk, authSdk] = await Promise.all([
  import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
  import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js')
]);
const app = appSdk.initializeApp(config, 'passport-admin');
const auth = authSdk.getAuth(app);
await authSdk.setPersistence(auth, authSdk.browserSessionPersistence);

const data = { customers: null, reviews: null, referrals: null };
const errors = {};
let tab = 'customers';

async function read(path, token) {
  const r = await fetch(`${DB}/${path}.json?auth=${encodeURIComponent(token)}`);
  if (r.status === 401 || r.status === 403) throw new Error('denied');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function load() {
  const user = auth.currentUser; if (!user || user.isAnonymous) return;
  $('status').textContent = 'Loading…';
  const token = await user.getIdToken();
  let isAdmin = false;
  try { isAdmin = (await read(`admins/${user.uid}`, token)) === true; } catch {}
  if (!isAdmin) {
    await authSdk.signOut(auth);
    showLogin(`This account is not an admin. Ask the owner to add UID ${user.uid} under /admins in the database.`);
    return;
  }
  await Promise.all(Object.keys(data).map(async p => {
    try { const v = await read(p, token); data[p] = Object.entries(v || {}).map(([key, x]) => ({ key, ...(x && typeof x === 'object' ? x : { value: x }) })); delete errors[p]; }
    catch (e) { data[p] = null; errors[p] = e.message === 'denied' ? 'Permission denied by database rules for this path.' : 'Could not load (' + e.message + ').'; }
  }));
  render();
}

function render() {
  const c = data.customers || [], rv = data.reviews || [], rf = data.referrals || [];
  const sum = f => c.reduce((s, x) => s + (Number(x[f]) || 0), 0);
  $('stats').innerHTML = [
    ['Customers', data.customers ? c.length : '—'], ['Visits', data.customers ? sum('visitCount') : '—'],
    ['Images created', data.customers ? sum('photoCount') : '—'], ['Time spent', data.customers ? dur(sum('totalMs')) : '—'],
    ['Reviews', data.reviews ? rv.length : '—'], ['Referral answers', data.referrals ? rf.length : '—']
  ].map(([l, v]) => `<div class="adCard"><b>${v}</b><span>${l}</span></div>`).join('');
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const cols = {
    customers: [['Customer no.', x => `<td class="mono">${dash(x.id || x.key)}</td>`], ['Name', x => `<td>${dash(x.name)}</td>`], ['Visits', x => `<td>${dash(x.visitCount)}</td>`], ['Images', x => `<td>${dash(x.photoCount)}</td>`], ['Time spent', x => `<td>${x.totalMs === undefined ? '—' : dur(x.totalMs)}</td>`], ['Country', x => `<td>${dash(x.country)}</td>`], ['Device', x => `<td>${dash([x.deviceType, x.os, x.browser].filter(Boolean).join(' · '))}</td>`], ['First visit', x => `<td>${when(x.firstVisit)}</td>`], ['Last visit', x => `<td>${when(x.lastVisit)}</td>`]],
    reviews: [['Time', x => `<td>${when(x.ts)}</td>`], ['Rating', x => `<td>${dash(x.rating)}</td>`], ['Review', x => `<td>${dash(x.text)}</td>`], ['Name', x => `<td>${dash(x.name)}</td>`], ['Source', x => `<td>${dash(x.source)}</td>`], ['Customer ID', x => `<td class="mono">${dash(x.customerId)}</td>`], ['Visitor UID', x => `<td class="mono">${dash(x.uid)}</td>`], ['Device ID', x => `<td class="mono">${dash(x.deviceId)}</td>`]],
    referrals: [['Time', x => `<td>${when(x.ts)}</td>`], ['Answer', x => `<td>${dash(x.sourceLabel || x.source)}</td>`], ['Details', x => `<td>${dash(x.detail)}</td>`], ['Visitor UID', x => `<td class="mono">${dash(x.uid)}</td>`], ['Page', x => `<td>${dash(x.page)}</td>`]]
  }[tab];
  const sortKey = tab === 'customers' ? 'lastVisit' : 'ts';
  const rows = (data[tab] || []).slice().sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
  $('thead').innerHTML = `<tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr>`;
  $('tbody').innerHTML = rows.map(r => `<tr>${cols.map(([, f]) => f(r)).join('')}</tr>`).join('') ||
    `<tr><td colspan="${cols.length}" class="adNote">${errors[tab] ? esc(errors[tab]) : 'No records at this path.'}</td></tr>`;
  $('status').textContent = errors[tab] ? errors[tab] : `${rows.length} record(s) from /${tab}`;
}

function showLogin(msg = '') { $('panel').hidden = true; $('login').hidden = false; $('loginErr').textContent = msg; }
function showPanel(user) { $('login').hidden = true; $('panel').hidden = false; $('who').textContent = user.email || ''; }

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('loginErr').textContent = ''; $('loginBtn').disabled = true;
  try { await authSdk.signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); $('password').value = ''; }
  catch { $('loginErr').textContent = 'Sign-in failed. Check the email and password.'; }
  finally { $('loginBtn').disabled = false; }
});
$('logout').onclick = () => authSdk.signOut(auth);
$('refresh').onclick = load;
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
authSdk.onAuthStateChanged(auth, user => { if (user && !user.isAnonymous) { showPanel(user); load(); } else showLogin($('loginErr').textContent); });
