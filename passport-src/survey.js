/* "Free forever" notice after cookie accept (1.5 s gap) + one-time post-creation survey (saved to Firebase). */
import { idToken, clearToken } from '/auth-token.js';
const DB = 'https://passport-48389-default-rtdb.firebaseio.com';
const DONE = 'pr_survey_done_v1';
const $ = id => document.getElementById(id);
const get = k => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lock = on => { document.body.style.overflow = on ? 'hidden' : ''; };

// Review display names come from the visitor profile. The database only
// accepts letters with no spaces, so the profile's words are joined
// ("Sunny River Panda" -> "SunnyRiverPanda").
function profileName() {
  try {
    const p = JSON.parse(get('pr_anonymous_visitor_v1') || 'null');
    const joined = String((p || {}).name || '').replace(/[^A-Za-z]/g, '').slice(0, 40);
    return joined.length >= 2 ? joined : 'Guest';
  } catch { return 'Guest'; }
}

window.addEventListener('pr:accepted', () => {
  idToken().catch(() => {}); // sign in early so a later submit has no auth wait
  const n = $('prFreeNotice'); if (!n) return;
  // Small pause after the cookie box before the notice appears.
  setTimeout(() => {
    if (!n.classList.contains('hidden')) return;
    n.classList.remove('hidden'); lock(true);
    $('prFreeNoticeOk').onclick = () => { n.classList.add('hidden'); lock(false); };
  }, 1500);
});

// The token is cached, so a send is one request. On an auth rejection the
// token is refreshed once and the write retried.
async function post(path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { t } = await idToken(attempt > 0).catch(() => ({ t: '' }));
    const r = await fetch(`${DB}/${path}.json${t ? '?auth=' + encodeURIComponent(t) : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return;
    if (r.status !== 401 && r.status !== 403) throw new Error('save failed');
    clearToken();
  }
  throw new Error('save failed');
}

const LABELS = { search: 'Search engine', social: 'Social media', ai: 'AI agents', other: 'Other' };
let source = '', sourceDetail = '', rating = 0, sending = false;

function open() {
  if (get(DONE)) return;
  const m = $('prSurvey'); if (!m || !m.classList.contains('hidden')) return;
  // Ask once, ever: mark done the moment the survey is shown so it never
  // re-appears — even if the visitor leaves before finishing, the send
  // fails, or the site is redeployed.
  set(DONE, String(Date.now()));
  m.classList.remove('hidden'); lock(true);
}
window.addEventListener('pr:photo-created', () => { idToken().catch(() => {}); setTimeout(open, 600); });

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
    // The app stores the device ID under pr_device_id; cubit_device_id is the
    // legacy key. The database rejects empty device IDs, so fall back correctly.
    const deviceId = get('pr_device_id') || get('cubit_device_id') || '';
    try {
      const { uid } = await idToken().catch(() => ({ uid: '' }));
      const src = LABELS[source] + (sourceDetail ? ': ' + sourceDetail : '');
      // Both writes go out together — the survey closes at the speed of one request.
      await Promise.all([
        post('referrals', { source, sourceLabel: LABELS[source], detail: sourceDetail, uid, ts, page: location.pathname }),
        post('reviews', { deviceId, customerId: get('pr_customer_code') || '', name, rating, text, source: src, uid, ts })
      ]);
      set(DONE, String(ts));
      m.classList.add('hidden'); lock(false);
    } catch { err.textContent = 'Could not send. Please check your connection and try again.'; }
    finally { sending = false; $('prSurveySend').disabled = false; }
  };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
