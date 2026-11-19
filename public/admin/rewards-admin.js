/* Rewards configuration screen for admins.
 *
 * Configuration (rates, limits, provider definitions) is written straight to
 * /rewards/config; the database rules allow only UIDs listed under /admins.
 * Provider secrets are written to /rewardsSecrets, a node with no client read
 * access at all — once saved, a secret can only be replaced, never displayed.
 *
 * Balances are never written here. Lookups and reversals call
 * /api/rewards/admin, which uses the service account and the atomic ledger.
 */
const config = {
  apiKey: "AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM",
  authDomain: "passport-48389.firebaseapp.com",
  projectId: "passport-48389",
  appId: "1:222961536167:web:618360108d616b8f129f82",
};
const DB = "https://passport-48389-default-rtdb.firebaseio.com";
const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const val = (id) => ($(id) ? $(id).value.trim() : "");
const num = (id) => {
  const n = Number($(id) ? $(id).value : "");
  return Number.isFinite(n) ? n : 0;
};
const checked = (id) => Boolean($(id) && $(id).checked);

const [appSdk, authSdk] = await Promise.all([
  import("https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js"),
  import("https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js"),
]);
const app = appSdk.initializeApp(config, "passport-rewards-admin");
const auth = authSdk.getAuth(app);
await authSdk.setPersistence(auth, authSdk.browserSessionPersistence);

const state = { settings: {}, providers: [], status: {}, adminUid: "" };

function message(id, text, tone = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.dataset.tone = tone;
}

async function authToken() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in.");
  return user.getIdToken();
}

async function dbRead(path) {
  const token = await authToken();
  const response = await fetch(`${DB}/${path}.json?auth=${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Read failed (${response.status}).`);
  return response.json();
}

async function dbWrite(path, value, method = "PUT") {
  const token = await authToken();
  const response = await fetch(`${DB}/${path}.json?auth=${encodeURIComponent(token)}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Permission denied by the database rules. Publish the updated database.rules.json first."
        : `Write failed (${response.status}): ${detail.slice(0, 200)}`,
    );
  }
}

async function api(action, body = {}) {
  const token = await authToken();
  const response = await fetch("/api/rewards/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Server error (${response.status}).`);
  }
  return payload;
}

/* --------------------------------- settings -------------------------------- */

function fillSettings() {
  const s = state.settings || {};
  $("setEnabled").value = s.enabled === true ? "true" : "false";
  $("setPointsPerUnit").value = Number(s.pointsPerUnit) || 0;
  $("setUnit").value = s.unit || "USD";
  $("setDailyCap").value = Number(s.dailyEarnCapPoints) || 0;
  $("setMinPayout").value = Number(s.minPayoutPoints) || 0;
  $("setTerms").value = s.termsUrl || "/terms-of-service";
  $("setMaintenance").value = s.maintenanceMessage || "";
}

async function saveSettings() {
  const button = $("saveSettings");
  button.disabled = true;
  message("settingsMsg", "Saving…");
  try {
    const next = {
      enabled: val("setEnabled") === "true",
      pointsPerUnit: Math.max(0, num("setPointsPerUnit")),
      unit: val("setUnit") || "USD",
      dailyEarnCapPoints: Math.max(0, num("setDailyCap")),
      minPayoutPoints: Math.max(0, num("setMinPayout")),
      termsUrl: val("setTerms") || "/terms-of-service",
      maintenanceMessage: $("setMaintenance").value.trim().slice(0, 400),
      updatedAt: Date.now(),
      updatedBy: state.adminUid,
    };
    await dbWrite("rewards/config/settings", next);
    state.settings = { ...state.settings, ...next };
    message(
      "settingsMsg",
      next.enabled
        ? "Saved. Rewards are now open to visitors — but only partners with a configured secret can credit."
        : "Saved. Rewards are closed: the page and the postback endpoint refuse every credit.",
      "ok",
    );
  } catch (error) {
    message("settingsMsg", error.message, "bad");
  } finally {
    button.disabled = false;
  }
}

/* -------------------------------- providers -------------------------------- */

const blankProvider = (id) => ({
  id,
  name: id,
  category: "survey",
  enabled: false,
  mode: "iframe",
  launchUrl: "",
  appId: "",
  height: 720,
  pointsPerUnit: 0,
  rewardMode: "payout",
  maxPerEventPoints: 5000,
  minPayoutForCredit: 0,
  description: "",
  notes: "",
  postback: {
    uidParam: "user_id",
    amountParam: "amount",
    txnParam: "trans_id",
    statusParam: "status",
    reversalValues: "reversed,chargeback,reversal,declined,refund",
  },
  signature: { scheme: "shared-secret", param: "token", secretEnv: "", params: [], encoding: "hex" },
  allowUnsigned: false,
});

const slug = (id) => String(id).replace(/[^A-Za-z0-9]/g, "_");

function postbackUrl(id) {
  return `${location.origin}/api/rewards/postback?provider=${encodeURIComponent(id)}`;
}

function providerForm(provider) {
  const p = { ...blankProvider(provider.id), ...provider, postback: { ...blankProvider(provider.id).postback, ...(provider.postback || {}) }, signature: { ...blankProvider(provider.id).signature, ...(provider.signature || {}) } };
  const s = slug(p.id);
  const status = state.status[p.id] || {};
  const secretState = status.secretConfigured
    ? `Saved (${esc(status.secretSource || "server")}) — replace it below if it changed.`
    : "No secret saved yet. A postback without a secret is rejected.";
  const launchState = status.launchConfigured === false
    ? `Missing: ${esc((status.missingLaunchFields || []).join(", "))}`
    : "Launch URL looks complete.";
  return `
  <div class="rwAdmProv" data-provider="${esc(p.id)}">
    <div class="rwAdmProvHead">
      <div>
        <b>${esc(p.name || p.id)}</b>
        <span class="rwAdmTag" data-on="${p.enabled === true}">${p.enabled === true ? "enabled" : "disabled"}</span>
        <span class="rwAdmTag">${esc(p.id)}</span>
      </div>
      <div class="rwAdmRow">
        <button class="rwAdmBtn ghost" type="button" data-act="check" data-id="${esc(p.id)}" style="margin:0">Check setup</button>
        <button class="rwAdmBtn danger" type="button" data-act="delete" data-id="${esc(p.id)}" style="margin:0">Delete</button>
      </div>
    </div>
    <div class="rwAdmGrid">
      <label class="rwAdmField">Display name
        <input id="p_${s}_name" type="text" maxlength="80" value="${esc(p.name)}" />
      </label>
      <label class="rwAdmField">Category
        <select id="p_${s}_category">
          ${["survey", "offer", "video"]
            .map((c) => `<option value="${c}" ${p.category === c ? "selected" : ""}>${c}</option>`)
            .join("")}
        </select>
      </label>
      <label class="rwAdmField">Wall mode
        <select id="p_${s}_mode">
          <option value="iframe" ${p.mode !== "link" ? "selected" : ""}>Embedded in a modal (iframe)</option>
          <option value="link" ${p.mode === "link" ? "selected" : ""}>Open in a new tab</option>
        </select>
      </label>
      <label class="rwAdmField">Max points per single activity
        <input id="p_${s}_maxPerEvent" type="number" min="1" step="1" value="${Number(p.maxPerEventPoints) || 5000}" />
      </label>
      <label class="rwAdmField">Points per 1 ${esc(state.settings.unit || "USD")} (0 = inherit)
        <input id="p_${s}_ppu" type="number" min="0" step="1" value="${Number(p.pointsPerUnit) || 0}" />
      </label>
      <label class="rwAdmField">Reward reported as
        <select id="p_${s}_rewardMode">
          <option value="payout" ${p.rewardMode !== "points" ? "selected" : ""}>Money (converted by the rate)</option>
          <option value="points" ${p.rewardMode === "points" ? "selected" : ""}>Points already</option>
        </select>
      </label>
      <label class="rwAdmField">Iframe height (px)
        <input id="p_${s}_height" type="number" min="320" max="4000" step="10" value="${Number(p.height) || 720}" />
      </label>
      <label class="rwAdmField">Provider app id / placement id
        <input id="p_${s}_appId" type="text" maxlength="120" value="${esc(p.appId)}" />
        <small>Used for <code>{app_id}</code> in the launch URL.</small>
      </label>
    </div>
    <label class="rwAdmField" style="margin-top:12px">Launch URL template
      <input id="p_${s}_launchUrl" type="text" maxlength="2000" placeholder="https://wall.provider.com/?app_id={app_id}&user_id={uid}" value="${esc(p.launchUrl)}" />
      <small>Must contain <code>{uid}</code>. It is built on the server, so a hash placeholder is filled without exposing the secret.</small>
    </label>
    <label class="rwAdmField" style="margin-top:12px">Description shown on the rewards page
      <textarea id="p_${s}_description" maxlength="300">${esc(p.description)}</textarea>
    </label>

    <div class="rwAdmGrid" style="margin-top:12px">
      <label class="rwAdmField">UID parameter
        <input id="p_${s}_uidParam" type="text" maxlength="40" value="${esc(p.postback.uidParam)}" />
      </label>
      <label class="rwAdmField">Amount parameter
        <input id="p_${s}_amountParam" type="text" maxlength="40" value="${esc(p.postback.amountParam)}" />
      </label>
      <label class="rwAdmField">Transaction id parameter
        <input id="p_${s}_txnParam" type="text" maxlength="40" value="${esc(p.postback.txnParam)}" />
      </label>
      <label class="rwAdmField">Status parameter
        <input id="p_${s}_statusParam" type="text" maxlength="40" value="${esc(p.postback.statusParam)}" />
      </label>
    </div>
    <label class="rwAdmField" style="margin-top:12px">Status values meaning “reversal”
      <input id="p_${s}_reversal" type="text" maxlength="200" value="${esc(p.postback.reversalValues)}" />
    </label>

    <div class="rwAdmGrid" style="margin-top:12px">
      <label class="rwAdmField">Postback signature scheme
        <select id="p_${s}_scheme">
          ${[
            ["shared-secret", "Shared secret in a parameter"],
            ["hmac-sha256", "HMAC-SHA256 over parameters"],
            ["md5-uid", "MD5(uid + secret)"],
            ["none", "Unsigned (provider IP allowlist)"],
          ]
            .map(([v, label]) => `<option value="${v}" ${p.signature.scheme === v ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </label>
      <label class="rwAdmField">Signature parameter name
        <input id="p_${s}_sigParam" type="text" maxlength="40" value="${esc(p.signature.param)}" />
      </label>
      <label class="rwAdmField">Signature field order (comma separated)
        <input id="p_${s}_sigParams" type="text" maxlength="200" value="${esc((p.signature.params || []).join(","))}" />
        <small>Only for HMAC. Empty = uid:trans_id:amount.</small>
      </label>
      <label class="rwAdmField">Secret environment variable name
        <input id="p_${s}_secretEnv" type="text" maxlength="80" value="${esc(p.signature.secretEnv)}" />
        <small>Optional. Defaults to <code>REWARDS_SECRET_${esc(p.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_"))}</code>.</small>
      </label>
    </div>

    <label class="rwAdmCheck" style="margin-top:10px">
      <input id="p_${s}_enabled" type="checkbox" ${p.enabled === true ? "checked" : ""} />
      Show this partner on the rewards page and accept its postbacks
    </label>
    <label class="rwAdmCheck">
      <input id="p_${s}_allowUnsigned" type="checkbox" ${p.allowUnsigned === true ? "checked" : ""} />
      Allow unsigned postbacks (only when the provider calls from a fixed IP we cannot share a secret with)
    </label>

    <div class="rwAdmRow" style="margin-top:10px">
      <button class="rwAdmBtn" type="button" data-act="save" data-id="${esc(p.id)}">Save provider</button>
    </div>
    <p class="rwAdmNote" style="margin:10px 0 4px">Postback URL for this partner's dashboard:<br /><code>${esc(postbackUrl(p.id))}</code></p>
    <p class="rwAdmNote" style="margin:0 0 8px">${launchState}</p>

    <div class="rwAdmRow" style="margin-top:8px">
      <label class="rwAdmField" style="flex:1;min-width:220px">Provider secret
        <input id="p_${s}_secret" type="password" autocomplete="new-password" placeholder="Paste the secret from the provider" />
        <small>${secretState} Stored at a path no browser can read.</small>
      </label>
      <button class="rwAdmBtn ghost" type="button" data-act="secret" data-id="${esc(p.id)}" style="align-self:flex-end">Save secret</button>
    </div>
    <p class="rwAdmMsg" data-msg="${esc(p.id)}" aria-live="polite"></p>
  </div>`;
}

function renderProviders() {
  if (!state.providers.length) {
    $("providerList").innerHTML =
      '<p class="rwAdmNote">No providers yet. Add one above, then paste its launch URL and secret.</p>';
    return;
  }
  $("providerList").innerHTML = state.providers.map(providerForm).join("");
}

function collectProvider(id) {
  const s = slug(id);
  return {
    id,
    name: val(`p_${s}_name`) || id,
    category: val(`p_${s}_category`) || "survey",
    enabled: checked(`p_${s}_enabled`),
    mode: val(`p_${s}_mode`) || "iframe",
    launchUrl: val(`p_${s}_launchUrl`),
    appId: val(`p_${s}_appId`),
    height: Math.min(4000, Math.max(320, num(`p_${s}_height`) || 720)),
    pointsPerUnit: Math.max(0, num(`p_${s}_ppu`)),
    rewardMode: val(`p_${s}_rewardMode`) || "payout",
    maxPerEventPoints: Math.max(1, num(`p_${s}_maxPerEvent`) || 5000),
    description: $("p_" + s + "_description").value.trim().slice(0, 300),
    postback: {
      uidParam: val(`p_${s}_uidParam`) || "user_id",
      amountParam: val(`p_${s}_amountParam`) || "amount",
      txnParam: val(`p_${s}_txnParam`) || "trans_id",
      statusParam: val(`p_${s}_statusParam`) || "status",
      reversalValues: val(`p_${s}_reversal`),
    },
    signature: {
      scheme: val(`p_${s}_scheme`) || "shared-secret",
      param: val(`p_${s}_sigParam`) || "token",
      secretEnv: val(`p_${s}_secretEnv`),
      params: val(`p_${s}_sigParams`)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      encoding: "hex",
    },
    allowUnsigned: checked(`p_${s}_allowUnsigned`),
    updatedAt: Date.now(),
  };
}

async function saveProvider(id) {
  const provider = collectProvider(id);
  if (!provider.launchUrl) {
    message(`providerMsg`, "Add the partner's launch URL before saving.", "bad");
    return;
  }
  if (!/\{uid\}|\{user_id\}|\{subid\}|\{subid1\}/.test(provider.launchUrl)) {
    message(`providerMsg`, "The launch URL must contain {uid} so the completion is tied to the visitor.", "bad");
    return;
  }
  try {
    await dbWrite(`rewards/config/providers/${encodeURIComponent(id)}`, provider);
    const index = state.providers.findIndex((p) => p.id === id);
    if (index >= 0) state.providers[index] = provider;
    message(`providerMsg`, `Saved ${provider.name}.`, "ok");
    await refreshStatus();
    renderProviders();
  } catch (error) {
    message("providerMsg", error.message, "bad");
  }
}

async function saveSecret(id) {
  const s = slug(id);
  const input = $(`p_${s}_secret`);
  const secret = input ? input.value.trim() : "";
  if (!secret) {
    message(`providerMsg`, "Paste the secret first.", "bad");
    return;
  }
  try {
    await dbWrite(`rewardsSecrets/providers/${encodeURIComponent(id)}/secret`, secret);
    input.value = "";
    message(`providerMsg`, "Secret saved. It cannot be displayed again — replace it if the provider rotates it.", "ok");
    await refreshStatus();
    renderProviders();
  } catch (error) {
    message("providerMsg", error.message, "bad");
  }
}

async function deleteProvider(id) {
  if (!window.confirm(`Delete provider “${id}” and its settings? Existing balances and history are untouched.`)) return;
  try {
    await dbWrite(`rewards/config/providers/${encodeURIComponent(id)}`, undefined, "DELETE");
    state.providers = state.providers.filter((p) => p.id !== id);
    renderProviders();
    message("providerMsg", `Deleted ${id}.`, "ok");
  } catch (error) {
    message("providerMsg", error.message, "bad");
  }
}

async function checkProvider(id) {
  message("providerMsg", "Checking server-side configuration…");
  try {
    const payload = await api("test", { provider: id, params: {} });
    const bits = [
      payload.secretConfigured ? "secret configured" : "NO secret configured",
      payload.missingLaunchFields && payload.missingLaunchFields.length
        ? `missing: ${payload.missingLaunchFields.join(", ")}`
        : "launch URL complete",
      payload.sampleLaunchUrl ? `sample launch URL: ${payload.sampleLaunchUrl}` : "",
    ].filter(Boolean);
    message("providerMsg", bits.join(" · "), payload.secretConfigured ? "ok" : "bad");
  } catch (error) {
    message("providerMsg", error.message, "bad");
  }
}

async function addProvider() {
  const id = val("newProviderId").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!id) {
    message("providerMsg", "Enter an id such as “bitlabs”.", "bad");
    return;
  }
  if (state.providers.some((p) => p.id === id)) {
    message("providerMsg", "That provider already exists.", "bad");
    return;
  }
  const provider = blankProvider(id);
  provider.name = id;
  state.providers.push(provider);
  state.providers.sort((a, b) => a.id.localeCompare(b.id));
  $("newProviderId").value = "";
  renderProviders();
  message("providerMsg", `Added ${id}. Fill in the launch URL, postback parameters and secret, then save.`, "ok");
}

/* --------------------------------- lookup ---------------------------------- */

function renderLookup(user, uid) {
  const rows = (user && user.transactions) || [];
  const balance = Math.max(0, Math.round(Number(user && user.balance) || 0));
  $("lookupResult").innerHTML = `
    <p class="rwAdmNote" style="margin-top:12px">
      UID <code>${esc(uid)}</code> · balance <b>${balance.toLocaleString()}</b> points ·
      lifetime earned ${Number((user && user.lifetimeEarned) || 0).toLocaleString()} ·
      reversed ${Number((user && user.lifetimeReversed) || 0).toLocaleString()}
    </p>
    <div style="overflow-x:auto">
      <table class="rwAdmTable">
        <thead><tr><th>When</th><th>Provider</th><th>Kind</th><th>Points</th><th>Reference</th><th></th></tr></thead>
        <tbody>
          ${
            rows
              .map(
                (txn) => `<tr>
                  <td>${txn.ts ? new Date(Number(txn.ts)).toLocaleString() : "—"}</td>
                  <td>${esc(txn.providerId || "—")}</td>
                  <td>${esc(txn.kind || "credit")}</td>
                  <td>${Number(txn.points) > 0 ? "+" : ""}${Number(txn.points) || 0}</td>
                  <td class="mono">${esc(String(txn.providerTxnId || txn.key || "").slice(0, 40))}</td>
                  <td>${
                    txn.kind === "credit" && Number(txn.points) > 0
                      ? `<button class="rwAdmBtn danger" type="button" data-act="reverse" data-uid="${esc(uid)}" data-key="${esc(txn.key)}" style="margin:0">Reverse</button>`
                      : ""
                  }</td>
                </tr>`,
              )
              .join("") || '<tr><td colspan="6" class="rwAdmNote">No transactions for this account.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;
}

async function lookup() {
  const uid = val("lookupUid");
  if (!uid) {
    message("lookupMsg", "Enter a visitor UID.", "bad");
    return;
  }
  message("lookupMsg", "Loading…");
  try {
    const payload = await api("lookup", { uid });
    renderLookup(payload.user, uid);
    message("lookupMsg", "");
  } catch (error) {
    message("lookupMsg", error.message, "bad");
  }
}

async function reverse(uid, key) {
  const reason = window.prompt("Reason for the reversal (shown in the audit record):", "Provider chargeback");
  if (reason === null) return;
  message("lookupMsg", "Reversing…");
  try {
    const payload = await api("reverse", { uid, txnKey: key, reason });
    const result = payload.result || {};
    message(
      "lookupMsg",
      `Reversed ${Number(result.points) || 0} points. New balance ${Number(result.balance) || 0}.`,
      "ok",
    );
    await lookup();
  } catch (error) {
    message("lookupMsg", error.message, "bad");
  }
}

/* --------------------------------- lifecycle ------------------------------- */

async function refreshStatus() {
  try {
    state.status = {};
    const payload = await api("status");
    for (const provider of payload.providers || []) state.status[provider.id] = provider;
  } catch {
    state.status = {};
  }
}

async function loadPanel() {
  const user = auth.currentUser;
  if (!user || user.isAnonymous) return;
  const token = await user.getIdToken();
  let isAdmin = false;
  try {
    const response = await fetch(`${DB}/admins/${user.uid}.json?auth=${encodeURIComponent(token)}`);
    isAdmin = (await response.json()) === true;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) {
    await authSdk.signOut(auth);
    showLogin(`This account is not an admin. Add UID ${user.uid} under /admins first.`);
    return;
  }
  state.adminUid = user.uid;
  $("who").textContent = user.email || "";
  $("login").hidden = true;
  $("panel").hidden = false;
  try {
    const configData = (await dbRead("rewards/config")) || {};
    state.settings = configData.settings || {};
    state.providers = Object.entries(configData.providers || {})
      .map(([id, provider]) => ({ ...blankProvider(id), ...(provider || {}), id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    message("settingsMsg", `Could not read /rewards/config: ${error.message}`, "bad");
  }
  fillSettings();
  await refreshStatus();
  renderProviders();
}

function showLogin(msg = "") {
  $("panel").hidden = true;
  $("login").hidden = false;
  $("loginErr").textContent = msg;
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginErr").textContent = "";
  $("loginBtn").disabled = true;
  try {
    await authSdk.signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    $("password").value = "";
  } catch {
    $("loginErr").textContent = "Sign-in failed. Check the email and password.";
  } finally {
    $("loginBtn").disabled = false;
  }
});
$("logout").addEventListener("click", () => authSdk.signOut(auth));
$("reload").addEventListener("click", loadPanel);
$("saveSettings").addEventListener("click", saveSettings);
$("addProvider").addEventListener("click", addProvider);
$("lookupBtn").addEventListener("click", lookup);

$("providerList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.act === "save") saveProvider(id);
  if (button.dataset.act === "secret") saveSecret(id);
  if (button.dataset.act === "delete") deleteProvider(id);
  if (button.dataset.act === "check") checkProvider(id);
});

$("lookupResult").addEventListener("click", (event) => {
  const button = event.target.closest('[data-act="reverse"]');
  if (!button) return;
  reverse(button.dataset.uid, button.dataset.key);
});

authSdk.onAuthStateChanged(auth, (user) => {
  if (user && !user.isAnonymous) {
    $("login").hidden = true;
    $("panel").hidden = false;
    loadPanel();
  } else {
    showLogin($("loginErr").textContent);
  }
});
