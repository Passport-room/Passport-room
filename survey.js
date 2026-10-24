/* "Free forever" notice after cookie accept (1.5 s gap) + one-time post-creation survey (saved to Firebase). */
const DB = 'https://passport-48389-default-rtdb.firebaseio.com';
const config = { apiKey: 'AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM', authDomain: 'passport-48389.firebaseapp.com', projectId: 'passport-48389', appId: '1:222961536167:web:618360108d616b8f129f82' };
const DONE = 'pr_survey_done_v1';
const $ = id => document.getElementById(id);
const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lock = on => { document.body.style.overflow = on ? 'hidden' : ''; };

// Review display names come from the visitor profile and are words only.
const NAME_OK = /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/;
function profileName() {
  try {
    const p = JSON.parse(get('pr_anonymous_visitor_v1') || 'null');
    const cleaned = String((p || {}).name || '').replace(/[^A-Za-z' -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return NAME_OK.test(cleaned) ? cleaned : 'Guest';
  } catch { return 'Guest'; }
}

window.addEventListener('pr:accepted', () => {
  const n = $('prFreeNotice'); if (!n) return;
  // Small pause after the cookie box before the notice appears.
  setTimeout(() => {
    if (!n.classList.contains('hidden')) return;
    n.classList.remove('hidden'); lock(true);
    $('prFreeNoticeOk').onclick = () => { n.classList.add('hidden'); lock(false); };
  }, 1500);
});

async function token() {
  try {
    const [a, b] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js')
    ]);
    const app = a.getApps().find(x => x.name === 'passport-survey') || a.initializeApp(config, 'passport-survey');
    const auth = b.getAuth(app);
    await auth.authStateReady();
    const user = auth.currentUser || (await b.signInAnonymously(auth)).user;
    return { t: await user.getIdToken(), uid: user.uid };
  } catch { return { t: '', uid: '' }; }
}
async function post(path, body, t) {
  const r = await fetch(`${DB}/${path}.json${t ? '?auth=' + encodeURIComponent(t) : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok && t) return post(path, body, '');
  if (!r.ok) throw new Error('save failed');
}

const LABELS = { search: 'Search engine', social: 'Social media', ai: 'AI agents', other: 'Other' };
let source = '', sourceDetail = '', rating = 0, sending = false;

function open() {
  if (get(DONE)) return;
  const m = $('prSurvey'); if (!m || !m.classList.contains('hidden')) return;
  m.classList.remove('hidden'); lock(true);
}
window.addEventListener('pr:photo-created', () => setTimeout(open, 600));

function init() {
  const m = $('prSurvey'); if (!m) return;
  const other = $('prSrcOther');
  m.querySelectorAll('input[name=prSrc]').forEach(r => r.addEventListener('change', () => {
    other.classList.toggle('hidden', r.value !== 'other' || !r.checked);
    if (r.value === 'other') other.focus();
  }));
  $('prSurveyNext').onclick = () => {
    const c = m.querySelector('input[name=prSrc]:checked');
    const err = $('prSurveyErr1');
    if (!c) { err.textContent = 'Please choose an option.'; return; }
    source = c.value; sourceDetail = '';
    if (source === 'other') {
      sourceDetail = other.value.trim().slice(0, 120);
      if (sourceDetail.length < 2) { err.textContent = 'Please tell us where you found us.'; return; }
    }
    err.textContent = '';
    m.querySelector('[data-step="1"]').classList.add('hidden');
    m.querySelector('[data-step="2"]').classList.remove('hidden');
  };
  const stars = [...m.querySelectorAll('[data-sv]')];
  stars.forEach(b => b.onclick = () => { rating = Number(b.dataset.sv); stars.forEach(s => s.classList.toggle('on', s === b)); });
  $('prSurveySend').onclick = async () => {
    if (sending) return;
    const err = $('prSurveyErr2');
    const text = $('prSurveyText').value.trim().slice(0, 300);
    if (!rating) { err.textContent = 'Please pick a rating first.'; return; }
    if (text.length < 2) { err.textContent = 'Please write a few words.'; return; }
    const name = profileName();
    sending = true; err.textContent = 'Sending…'; $('prSurveySend').disabled = true;
    const ts = Date.now();
    const deviceId = get('cubit_device_id') || '';
    try {
      const { t, uid } = await token();
      const src = LABELS[source] + (sourceDetail ? ': ' + sourceDetail : '');
      await post('referrals', { source, sourceLabel: LABELS[source], detail: sourceDetail, uid, ts, page: location.pathname }, t);
      await post('reviews', { deviceId, customerId: get('pr_customer_code') || '', name, rating, text, source: src, uid, ts }, t);
      set(DONE, String(ts));
      m.classList.add('hidden'); lock(false);
    } catch { err.textContent = 'Could not send. Please check your connection and try again.'; }
    finally { sending = false; $('prSurveySend').disabled = false; }
  };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
