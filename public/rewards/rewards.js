/* Rewards page.
 *
 * Read-only with respect to money: this file displays a balance and asks the
 * server to start a partner wall. It never writes points, balances or
 * transactions — the database rules deny every client write under /rewards and
 * only the postback endpoint can move a balance.
 *
 * Identity is the visitor's existing anonymous Firebase UID (see auth-token.js),
 * so a returning visitor keeps the same account. The ID token proves that UID
 * to the Realtime Database (read-only) and to /api/rewards/session.
 */
import { idToken } from "/auth-token.js";

const DB = "https://passport-48389-default-rtdb.firebaseio.com";
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  providers: [],
  category: "survey",
  balance: null,
  transactions: [],
  uid: "",
  signedIn: false,
  busy: false,
};

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const fmt = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString();

function setNotice(text, tone = "info") {
  const el = $("rwNotice");
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.dataset.tone = tone;
}

function setStatus(text, open) {
  const el = $("rwStatus");
  el.textContent = text;
  el.dataset.state = open ? "on" : "off";
}

async function readDb(path) {
  const response = await fetch(`${DB}/${path}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`read failed ${response.status}`);
  return response.json();
}

async function readDbAuthed(path, token) {
  const response = await fetch(`${DB}/${path}.json?auth=${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403) throw new Error("denied");
  if (!response.ok) throw new Error(`read failed ${response.status}`);
  return response.json();
}

/* ------------------------------- configuration ------------------------------ */

async function loadConfig() {
  let config = null;
  try {
    config = await readDb("rewards/config");
  } catch {
    config = null;
  }
  const settings = { ...(config && config.settings ? config.settings : {}) };
  const providers = Object.entries((config && config.providers) || {})
    .map(([id, provider]) => ({ id, ...(provider && typeof provider === "object" ? provider : {}) }))
    .filter((provider) => provider.id)
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  return { settings, providers };
}

function pointsPerUnit(provider) {
  return Number(provider.pointsPerUnit) || Number(state.settings.pointsPerUnit) || 0;
}

function unitLabel() {
  return String(state.settings.unit || "USD");
}

/* ----------------------------------- render -------------------------------- */

function renderStatus() {
  const settings = state.settings || {};
  if (!settings.enabled) {
    setStatus("Not open yet", false);
    setNotice(
      settings.maintenanceMessage ||
        "Rewards are not open yet. The page is live so the setup can be checked, but no partners are crediting accounts at the moment.",
      "warn",
    );
    $("rwTabs").hidden = true;
    $("rwGrid").innerHTML = "";
    $("rwHistorySec").hidden = true;
    $("rwBalance").hidden = true;
    return;
  }
  setStatus("Rewards open", true);
  setNotice("");
  $("rwTabs").hidden = state.providers.length === 0;
  $("rwBalance").hidden = !state.signedIn;
  $("rwHistorySec").hidden = !state.signedIn;
  if (!state.providers.length) {
    $("rwGrid").innerHTML =
      '<p class="rwEmpty">No reward partners are enabled yet. Check back soon.</p>';
  }
}

function visibleProviders() {
  return state.providers.filter(
    (provider) => provider.enabled === true && (provider.category || "survey") === state.category,
  );
}

function renderTabs() {
  const counts = { survey: 0, offer: 0, video: 0 };
  for (const provider of state.providers) {
    if (provider.enabled !== true) continue;
    const cat = provider.category || "survey";
    if (counts[cat] !== undefined) counts[cat] += 1;
  }
  $("cntSurvey").textContent = String(counts.survey);
  $("cntOffer").textContent = String(counts.offer);
  $("cntVideo").textContent = String(counts.video);
  document.querySelectorAll("#rwTabs [data-cat]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.cat === state.category));
  });
}

function renderWalls() {
  if (!state.settings.enabled) return;
  renderTabs();
  const list = visibleProviders();
  if (!list.length) {
    const label =
      state.category === "survey" ? "survey walls" : state.category === "offer" ? "offerwalls" : "rewarded videos";
    $("rwGrid").innerHTML = `<p class="rwEmpty">No ${label} are available right now.</p>`;
    return;
  }
  $("rwGrid").innerHTML = list
    .map((provider) => {
      const rate = pointsPerUnit(provider);
      const rateText =
        rate > 0 ? `${fmt(rate)} points per 1 ${esc(unitLabel())}` : "Rate set by the partner";
      const cap = Number(provider.maxPerEventPoints) || 0;
      return `
        <article class="rwCard">
          <div class="rwCardTop">
            <h3>${esc(provider.name || provider.id)}</h3>
            <span class="rwChip" data-on="true">${esc((provider.category || "survey").replace(/^./, (c) => c.toUpperCase()))}</span>
          </div>
          <p>${esc(provider.description || "Complete activities with this partner and the points are credited to the account on this device.")}</p>
          <div class="rwCardMeta">
            <span class="rwChip">${rateText}</span>
            ${cap > 0 ? `<span class="rwChip">max ${fmt(cap)} per activity</span>` : ""}
          </div>
          <button class="rwStart" type="button" data-provider="${esc(provider.id)}">Start ${esc(provider.category === "video" ? "videos" : provider.category === "offer" ? "offers" : "surveys")}</button>
        </article>`;
    })
    .join("");
}

function renderBalance() {
  const data = state.balance || {};
  const balance = Math.max(0, Math.round(Number(data.balance) || 0));
  const rate = Number(state.settings.pointsPerUnit) || 0;
  $("rwPoints").textContent = fmt(balance);
  $("rwValue").textContent =
    rate > 0
      ? `points ≈ ${(balance / rate).toFixed(2)} ${unitLabel()} · minimum redemption ${fmt(state.settings.minPayoutPoints)} points`
      : `points · minimum redemption ${fmt(state.settings.minPayoutPoints)} points`;
  const day = data.today || {};
  $("rwToday").textContent = fmt(day.earned);
  $("rwLifetime").textContent = fmt(data.lifetimeEarned);
  $("rwReversed").textContent = fmt(data.lifetimeReversed);
}

function renderHistory() {
  const rows = state.transactions || [];
  if (!rows.length) {
    $("rwTxnBody").innerHTML =
      '<tr><td colspan="5" class="rwEmpty">No reward activity yet. Points appear here after a partner confirms a completed activity.</td></tr>';
    return;
  }
  $("rwTxnBody").innerHTML = rows
    .map((txn) => {
      const points = Math.round(Number(txn.points) || 0);
      const down = points < 0 || txn.kind === "reversal";
      const when = Number(txn.ts) > 0 ? new Date(Number(txn.ts)).toLocaleString() : "—";
      return `<tr>
        <td>${esc(when)}</td>
        <td>${esc(txn.providerId || "—")}</td>
        <td class="rwStatus">${esc(txn.kind === "reversal" ? "reversal" : txn.status || "credit")}</td>
        <td class="rwAmount" data-dir="${down ? "down" : "up"}">${down ? "−" : "+"}${fmt(Math.abs(points))}</td>
        <td class="rwStatus">${esc(String(txn.providerTxnId || txn.key || "").slice(0, 40))}</td>
      </tr>`;
    })
    .join("");
}

/* ------------------------------------ data --------------------------------- */

async function loadUserData() {
  try {
    const auth = await idToken();
    state.uid = auth.uid;
    state.signedIn = true;
    const [user, txns] = await Promise.all([
      readDbAuthed(`rewards/users/${auth.uid}`, auth.t),
      readDbAuthed(`rewards/transactions/${auth.uid}`, auth.t),
    ]);
    state.balance = user || {};
    state.transactions = Object.entries(txns || {})
      .map(([key, value]) => ({ key, ...(value && typeof value === "object" ? value : {}) }))
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      .slice(0, 100);
  } catch (error) {
    state.signedIn = false;
    state.balance = null;
    state.transactions = [];
    if (String(error && error.message) !== "denied") {
      setNotice(
        "Your balance could not be loaded right now. Rewards still work; reload the page in a moment.",
        "warn",
      );
    }
  }
}

/* ----------------------------------- actions ------------------------------- */

let lastFocus = null;

function openModal(url, title) {
  lastFocus = document.activeElement;
  $("rwModalTitle").textContent = title || "Partner wall";
  $("rwModalOpen").href = url;
  $("rwFrame").src = url;
  $("rwModal").hidden = false;
  document.body.style.overflow = "hidden";
  $("rwModalClose").focus();
}

function closeModal() {
  $("rwModal").hidden = true;
  $("rwFrame").src = "about:blank";
  document.body.style.overflow = "";
  if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  refreshUser();
}

async function startWall(providerId, button) {
  if (state.busy) return;
  state.busy = true;
  if (button) {
    button.disabled = true;
    button.dataset.label = button.textContent;
    button.textContent = "Opening…";
  }
  try {
    const auth = await idToken();
    const response = await fetch("/api/rewards/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.t}` },
      body: JSON.stringify({ provider: providerId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setNotice(
        payload.error ||
          "This partner could not be opened. Please try again in a moment.",
        "warn",
      );
      return;
    }
    if (!payload.url) {
      setNotice("This partner is not fully configured yet.", "warn");
      return;
    }
    if (payload.mode === "link") {
      window.open(payload.url, "_blank", "noopener,noreferrer");
    } else {
      openModal(payload.url, payload.provider && payload.provider.name);
    }
  } catch {
    setNotice("You appear to be offline. Check your connection and try again.", "warn");
  } finally {
    state.busy = false;
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.label || "Start";
    }
  }
}

async function refreshUser() {
  if (!state.settings || state.settings.enabled !== true) return;
  await loadUserData();
  if (state.signedIn) {
    renderBalance();
    renderHistory();
  }
  $("rwBalance").hidden = !state.signedIn;
  $("rwHistorySec").hidden = !state.signedIn;
}

/* ------------------------------------ wire --------------------------------- */

$("rwTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-cat]");
  if (!button) return;
  state.category = button.dataset.cat;
  renderWalls();
});

$("rwGrid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-provider]");
  if (!button) return;
  startWall(button.dataset.provider, button);
});

$("rwModalClose").addEventListener("click", closeModal);
$("rwModal").addEventListener("click", (event) => {
  if (event.target === $("rwModal")) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("rwModal").hidden) closeModal();
});
$("rwRefresh").addEventListener("click", (event) => {
  event.preventDefault();
  refreshUser();
});

(async function init() {
  const { settings, providers } = await loadConfig();
  state.settings = settings;
  state.providers = providers;
  if (settings.termsUrl) $("rwTerms").href = String(settings.termsUrl);
  renderStatus();
  renderWalls();
  await refreshUser();
})();
