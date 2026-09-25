import { FIREBASE_CONFIG } from "./firebase-config.js";

// Local Account & Settings Engine (localStorage & IndexedDB fallback)

const ACCOUNT_KEY = "cubit_account_v2";
const HISTORY_KEY = "cubit_history_v2";

export function getDefaultAccount() {
  const randomId = Math.floor(1000 + Math.random() * 9000);
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return {
    id: `usr_${randomId}`,
    displayName: `Passport Creator #${randomId}`,
    avatar: null, // null means use default generated initials avatar
    avatarColor: "#6366f1",
    createdDate: dateStr,
    createdTimestamp: now.toISOString(),
    stats: {
      photosProcessed: 0,
      printSheetsCreated: 0,
      singleDownloads: 0,
      lastActive: now.toISOString(),
    },
    settings: {
      defaultSpec: "bd-passport",
      defaultFormat: "png",
      autoDownload: false,
      notifications: true,
      theme: "dark",
    },
  };
}

export function loadAccount() {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) {
      const fresh = getDefaultAccount();
      saveAccount(fresh);
      return fresh;
    }
    const acc = JSON.parse(raw);
    // Ensure stats structure exists
    if (!acc.stats) acc.stats = getDefaultAccount().stats;
    if (!acc.settings) acc.settings = getDefaultAccount().settings;
    return acc;
  } catch (err) {
    console.warn("Failed to load account from localStorage:", err);
    return getDefaultAccount();
  }
}

export function saveAccount(account) {
  try {
    account.stats.lastActive = new Date().toISOString();
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch (err) {
    console.error("Failed to save account:", err);
  }
}

export function updateProfile(displayName, avatarDataUrl = null) {
  const acc = loadAccount();
  if (displayName && displayName.trim()) {
    acc.displayName = displayName.trim();
  }
  if (avatarDataUrl !== undefined) {
    acc.avatar = avatarDataUrl;
  }
  saveAccount(acc);
  return acc;
}

export function updateSettings(partialSettings) {
  const acc = loadAccount();
  acc.settings = { ...acc.settings, ...partialSettings };
  saveAccount(acc);
  return acc;
}

export function recordActivity(type, extra = {}) {
  const acc = loadAccount();
  if (!acc.stats) acc.stats = getDefaultAccount().stats;

  if (type === "photo_processed") {
    acc.stats.photosProcessed = (acc.stats.photosProcessed || 0) + 1;
  } else if (type === "print_sheet") {
    acc.stats.printSheetsCreated = (acc.stats.printSheetsCreated || 0) + 1;
  } else if (type === "single_download") {
    acc.stats.singleDownloads = (acc.stats.singleDownloads || 0) + 1;
  }

  saveAccount(acc);
  return acc;
}

export function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

export function addHistoryItem(item) {
  try {
    const isSaveEnabled = localStorage.getItem("cubit_save_photos_enabled") !== "false";
    if (!isSaveEnabled) {
      return getHistory();
    }
    const history = getHistory();
    const newItem = {
      id: "hist_" + Date.now(),
      timestamp: new Date().toISOString(),
      formattedDate: new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      specLabel: item.specLabel || "Passport Photo",
      specId: item.specId || "bd-passport",
      thumbnail: item.thumbnail || null, // data URL thumbnail
    };
    // Keep last 15 items
    history.unshift(newItem);
    if (history.length > 15) history.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    return history;
  } catch (e) {
    console.warn("Failed to add history item:", e);
    return [];
  }
}

export function clearAllLocalData() {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem("cubit_photo_edits"); // photo editor settings
    return getDefaultAccount();
  } catch (e) {
    console.error("Error clearing data:", e);
  }
}


// Passport Room — accounts.
//
// Three-step sign-in screen: email  ->  password  ->  email verification.
// Works with an email + password, or with Google. The session is kept on this
// device, so a returning visitor is signed back in automatically.


const $ = (id) => document.getElementById(id);
const KEY = "pr_auth_v1";
const API = "https://identitytoolkit.googleapis.com/v1/accounts";
const TOKEN_API = "https://securetoken.googleapis.com/v1/token";
const KEYQ = `?key=${FIREBASE_CONFIG.apiKey}`;

const listeners = new Set();
let session = read();

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function notify(message, type = "info") {
  safe(() => window.__prToast?.(message, type));
}

function read() {
  const raw = safe(() => JSON.parse(localStorage.getItem(KEY) || "null"));
  if (!raw || !raw.refreshToken) return null;
  return raw;
}

function write(next) {
  session = next;
  safe(() => {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  });
  listeners.forEach((fn) => safe(() => fn(session)));
}

function store(data, extra = {}) {
  write({
    uid: data.localId || data.user_id || session?.uid,
    email: data.email || session?.email || "",
    displayName: data.displayName || session?.displayName || "",
    photoURL: data.photoUrl || data.photoURL || session?.photoURL || "",
    provider: extra.provider || session?.provider || "password",
    emailVerified: Boolean(data.emailVerified ?? extra.emailVerified ?? false),
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000,
  });
  return session;
}

/** Turns Firebase's error codes into something a person can read. */
function friendly(code) {
  const map = {
    EMAIL_EXISTS: "That email already has an account. Please sign in instead.",
    EMAIL_NOT_FOUND: "No account found with that email.",
    INVALID_PASSWORD: "Wrong password. Please try again.",
    INVALID_LOGIN_CREDENTIALS: "Email or password is not correct.",
    INVALID_EMAIL: "Please enter a valid email address.",
    MISSING_PASSWORD: "Please enter your password.",
    WEAK_PASSWORD: "Password must be at least 6 characters.",
    USER_DISABLED: "This account has been disabled.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Please try again in a moment.",
    OPERATION_NOT_ALLOWED: "Email sign-in is turned off for this project.",
    INVALID_OOB_CODE: "That verification link is not valid or has already been used.",
    EXPIRED_OOB_CODE: "That verification link has expired. Send a new email.",
  };
  const key = String(code || "").split(" : ")[0];
  return map[key] || "Something went wrong. Please try again.";
}

async function call(path, body) {
  const res = await fetch(`${API}:${path}${KEYQ}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendly(data?.error?.message));
  return data;
}

/* ------------------------------- public API ------------------------------- */

export function getUser() {
  return session
    ? {
        uid: session.uid,
        email: session.email,
        name: session.displayName,
        photoURL: session.photoURL || "",
        provider: session.provider || "password",
        emailVerified: Boolean(session.emailVerified),
      }
    : null;
}

export function isSignedIn() {
  return Boolean(session && session.refreshToken);
}

export function onAuthChange(fn) {
  listeners.add(fn);
  safe(() => fn(session));
  return () => listeners.delete(fn);
}

/** Does this email already have an account, and how does it sign in? */
export async function lookupEmail(email) {
  try {
    const data = await call("createAuthUri", {
      identifier: String(email || "").trim(),
      continueUri: safe(() => window.location.origin, "https://passportroom.app") || "/",
    });
    const known = Object.prototype.hasOwnProperty.call(data, "registered");
    return {
      registered: Boolean(data.registered),
      methods: data.signinMethods || data.allProviders || [],
      known,
    };
  } catch {
    // Email-enumeration protection can hide this — decide later from the
    // password step instead.
    return { registered: false, methods: [], known: false };
  }
}

export async function signUp(email, password) {
  const data = await call("signUp", {
    email: String(email || "").trim(),
    password: String(password || ""),
    returnSecureToken: true,
  });
  store(data, { provider: "password", emailVerified: false });
  return session;
}

export async function signIn(email, password) {
  const data = await call("signInWithPassword", {
    email: String(email || "").trim(),
    password: String(password || ""),
    returnSecureToken: true,
  });
  store(data, { provider: "password" });
  await refreshProfile();
  return session;
}

export async function sendPasswordReset(email) {
  await call("sendOobCode", {
    requestType: "PASSWORD_RESET",
    email: String(email || "").trim(),
  });
  return true;
}

/** Emails the verification link / code to the signed-in account. */
export async function sendVerificationEmail() {
  const token = await getIdToken();
  if (!token) throw new Error("Please sign in first.");
  await call("sendOobCode", { requestType: "VERIFY_EMAIL", idToken: token });
  return true;
}

/** Confirms the code copied out of the verification email. */
export async function confirmVerificationCode(code) {
  const clean = String(code || "").trim();
  if (!clean) throw new Error("Please paste the code from your email.");
  await call("update", { oobCode: clean });
  await refreshProfile();
  return Boolean(session?.emailVerified);
}

/** Re-reads the account from Firebase (name, photo, verified state). */
export async function refreshProfile() {
  const token = await getIdToken();
  if (!token) return null;
  try {
    const data = await call("lookup", { idToken: token });
    const u = data?.users?.[0];
    if (!u) return null;
    write({
      ...session,
      email: u.email || session.email,
      displayName: u.displayName || session.displayName,
      photoURL: u.photoUrl || session.photoURL || "",
      emailVerified: Boolean(u.emailVerified),
    });
    return session;
  } catch {
    return null;
  }
}

export function signOut() {
  write(null);
  notify("You have been signed out.", "info");
}

/** Swaps the stored refresh token for a fresh ID token. */
async function refresh() {
  if (!session?.refreshToken) return null;
  const res = await fetch(`${TOKEN_API}${KEYQ}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) write(null);
    return null;
  }
  const data = await res.json();
  write({
    ...session,
    uid: data.user_id || session.uid,
    idToken: data.id_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  });
  return session;
}

/** A valid ID token, refreshed when needed (useful for database writes). */
export async function getIdToken() {
  if (!session) return null;
  if (session.expiresAt - 60000 < Date.now()) await refresh();
  return session?.idToken || null;
}

/** Restores the previous account on this device, if there is one. */
export async function restoreSession() {
  if (!session) {
    listeners.forEach((fn) => safe(() => fn(null)));
    return null;
  }
  if (session.expiresAt - 60000 < Date.now()) await refresh();
  else listeners.forEach((fn) => safe(() => fn(session)));
  if (session) refreshProfile();
  return session;
}

/* ------------------------------ Google sign-in ----------------------------- */

const SDK = "https://www.gstatic.com/firebasejs/10.12.0/";
let googleAuthPromise = null;

async function loadGoogleAuth() {
  if (!googleAuthPromise) {
    googleAuthPromise = (async () => {
      const appUrl = `${SDK}firebase-app.js`;
      const authUrl = `${SDK}firebase-auth.js`;
      const [{ initializeApp, getApps }, authMod] = await Promise.all([
        import(/* @vite-ignore */ appUrl),
        import(/* @vite-ignore */ authUrl),
      ]);
      const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
      const auth = authMod.getAuth(app);
      auth.useDeviceLanguage();
      return { auth, mod: authMod };
    })();
  }
  return googleAuthPromise;
}

function storeGoogleUser(user) {
  const tokens = user?.stsTokenManager || {};
  write({
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || "",
    photoURL: user.photoURL || "",
    provider: "google.com",
    emailVerified: Boolean(user.emailVerified),
    idToken: tokens.accessToken || "",
    refreshToken: tokens.refreshToken || "",
    expiresAt: Number(tokens.expirationTime) || Date.now() + 3600000,
  });
  return session;
}

export async function signInWithGoogle() {
  const { auth, mod } = await loadGoogleAuth();
  const provider = new mod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    const result = await mod.signInWithPopup(auth, provider);
    return storeGoogleUser(result.user.toJSON ? result.user.toJSON() : result.user);
  } catch (err) {
    const code = String(err?.code || "");
    if (
      code.includes("popup-blocked") ||
      code.includes("popup-closed-by-user") ||
      code.includes("cancelled-popup-request") ||
      code.includes("operation-not-supported")
    ) {
      await mod.signInWithRedirect(auth, provider);
      return null;
    }
    if (code.includes("unauthorized-domain")) {
      throw new Error(
        "This web address is not allowed in Firebase yet. Add it under Authentication → Settings → Authorized domains.",
      );
    }
    throw new Error(err?.message?.replace(/^Firebase:\s*/, "") || "Google sign-in failed.");
  }
}

/** Picks up a Google sign-in that finished through a full page redirect. */
async function collectGoogleRedirect() {
  if (!safe(() => sessionStorage.getItem("pr_google_redirect"))) return;
  safe(() => sessionStorage.removeItem("pr_google_redirect"));
  try {
    const { auth, mod } = await loadGoogleAuth();
    const result = await mod.getRedirectResult(auth);
    if (result?.user) {
      storeGoogleUser(result.user.toJSON ? result.user.toJSON() : result.user);
      notify(`Signed in as ${session.email}`, "success");
    }
  } catch {
    /* nothing to collect */
  }
}

/* ------------------------------- the screen -------------------------------- */

// Two clear choices: "Log in" for people who already have an account and
// "Sign up" for new ones. New email accounts must confirm the code we email
// them before the account is finished.

let mode = "login"; // login | signup
let step = "form"; // form | verify
let pendingSignup = false; // true while a brand-new account is unverified
let busy = false;
let pollTimer = null;

function el() {
  return $("authView");
}

function setMsg(text, kind = "error") {
  const box = $("authMsg");
  if (!box) return;
  box.textContent = text || "";
  box.classList.toggle("hidden", !text);
  box.classList.toggle("ok", kind === "ok");
}

function show(id, on) {
  $(id)?.classList.toggle("hidden", !on);
}

/** Checks a new password and explains what is still missing. */
function passwordProblem(pw) {
  const value = String(pw || "");
  if (value.length < 8) return "Use at least 8 characters.";
  if (!/[a-z]/.test(value)) return "Add at least one lowercase letter.";
  if (!/[A-Z]/.test(value)) return "Add at least one capital letter.";
  if (!/[0-9]/.test(value)) return "Add at least one number.";
  return "";
}

function paintStep() {
  const title = $("authTitle");
  const sub = $("authSub");
  const submit = $("authSubmit");
  const signup = mode === "signup";

  show("authTabs", step === "form");
  show("authStepEmail", step === "form");
  show("authStepPassword", step === "form");
  show("authStepVerify", step === "verify");
  show("authGoogleWrap", step === "form");
  show("authForgot", step === "form" && !signup);
  show("authBack", step === "verify");
  show("authSubmit", step === "form");
  show("authPasswordConfirmRow", signup);
  show("authPwHint", signup);
  show("authVerifyLater", step === "verify" && !pendingSignup);

  $("authTabLogin")?.classList.toggle("on", !signup);
  $("authTabSignup")?.classList.toggle("on", signup);

  const pw = $("authPassword");
  if (pw) {
    pw.autocomplete = signup ? "new-password" : "current-password";
    pw.placeholder = signup ? "Create a strong password" : "Your password";
  }

  if (step === "form") {
    if (title) title.textContent = signup ? "Create your account" : "Welcome back";
    if (sub)
      sub.textContent = signup
        ? "Sign up with your email, or continue with Google."
        : "Log in with your email and password, or continue with Google.";
    if (submit) submit.textContent = signup ? "Create account" : "Log in";
  } else {
    if (title) title.textContent = "Verify your email";
    const inbox = session?.email || "your inbox";
    if (sub)
      sub.textContent = pendingSignup
        ? `Almost done. We sent a verification link to ${inbox}. Open that email and tap the link to finish creating your account.`
        : `Your email isn't verified yet. We sent a verification link to ${inbox}. Open that email and tap the link.`;
    const help = $("authVerifyHelp");
    if (help)
      help.textContent =
        "Can't find it? Check your spam folder, or resend the email below. This page updates by itself once you've tapped the link.";
  }
  const back = $("authBack");
  if (back) back.textContent = pendingSignup ? "← Cancel sign up" : "← Back";
  setMsg("");
}

function focusStep() {
  setTimeout(() => {
    if (step === "verify") $("authCodeSubmit")?.focus();
    else if (($("authEmail")?.value || "").trim()) $("authPassword")?.focus();
    else $("authEmail")?.focus();
  }, 60);
}

function setMode(next) {
  mode = next === "signup" ? "signup" : "login";
  step = "form";
  paintStep();
  focusStep();
}

export function openAuth(nextMode = "login") {
  mode = nextMode === "signup" ? "signup" : "login";
  step = "form";
  paintStep();
  const view = el();
  if (!view) return;
  view.classList.remove("hidden");
  document.body.classList.add("authOpen");
  focusStep();
}

export function closeAuth() {
  el()?.classList.add("hidden");
  document.body.classList.remove("authOpen");
  stopPolling();
}

/** True when the visitor may continue; otherwise the sign-in screen opens. */
export function requireAuth() {
  if (isSignedIn()) return true;
  openAuth("login");
  return false;
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    await refreshProfile();
    if (session?.emailVerified) {
      stopPolling();
      finishVerified();
    }
  }, 4000);
}

function finishVerified() {
  pendingSignup = false;
  notify("Email verified. You're all set!", "success");
  closeAuth();
}

async function goToVerify() {
  step = "verify";
  el()?.classList.remove("hidden");
  document.body.classList.add("authOpen");
  paintStep();
  try {
    await sendVerificationEmail();
    setMsg("Verification email sent. Check your inbox (and spam).", "ok");
  } catch (err) {
    setMsg(err?.message || "Could not send the verification email.");
  }
  startPolling();
  focusStep();
}

function setBusy(on, label) {
  busy = on;
  const btn = $("authSubmit");
  if (!btn) return;
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label || "Please wait…";
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

async function submit(e) {
  e?.preventDefault();
  if (busy || step !== "form") return;

  const email = ($("authEmail")?.value || "").trim();
  const password = $("authPassword")?.value || "";
  if (!/^\S+@\S+\.\S+$/.test(email)) return setMsg("Please enter a valid email address.");
  if (!password) return setMsg("Please enter your password.");

  if (mode === "signup") {
    const problem = passwordProblem(password);
    if (problem) return setMsg(`Please choose a stronger password. ${problem}`);
    if (password !== ($("authPasswordConfirm")?.value || ""))
      return setMsg("The two passwords don't match.");

    setBusy(true, "Creating account…");
    try {
      await signUp(email, password);
      pendingSignup = true;
      const pw = $("authPassword");
      if (pw) pw.value = "";
      const pwc = $("authPasswordConfirm");
      if (pwc) pwc.value = "";
      notify("Account created. Verify your email to finish.", "success");
      await goToVerify();
    } catch (err) {
      const msg = err?.message || "Could not create your account.";
      if (/already has an account/i.test(msg)) {
        setMode("login");
        setMsg("That email already has an account. Please log in instead.");
      } else {
        setMsg(msg);
      }
    } finally {
      setBusy(false);
    }
    return;
  }

  setBusy(true, "Logging in…");
  try {
    await signIn(email, password);
    const pw = $("authPassword");
    if (pw) pw.value = "";
    notify(`Signed in as ${email}`, "success");
    pendingSignup = false;
    if (!session?.emailVerified) await goToVerify();
    else closeAuth();
  } catch (err) {
    const msg = err?.message || "Could not log you in.";
    if (/No account found/i.test(msg)) {
      setMsg("No account found with that email. Tap “Sign up” to create one.");
    } else if (/not correct|Wrong password/i.test(msg)) {
      setMsg("Wrong email or password. Please try again, or use “Forgot password?”.");
    } else {
      setMsg(msg);
    }
  } finally {
    setBusy(false);
  }
}

/** "I've verified my email" — re-check the account with Firebase. */
async function checkVerified() {
  const btn = $("authCodeSubmit");
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Checking…";
  }
  try {
    await refreshProfile();
    if (session?.emailVerified) finishVerified();
    else
      setMsg(
        "We can't see the verification yet. Tap the link in the email, then try again in a moment.",
      );
  } catch (err) {
    setMsg(err?.message || "Could not check your email verification. Please try again.");
  } finally {
    if (btn) {
      btn.disabled = false;
      if (label) btn.textContent = label;
    }
  }
}

async function forgot() {
  const email = ($("authEmail")?.value || "").trim();
  if (!email) return setMsg("Enter your email first, then tap Forgot password.");
  try {
    await sendPasswordReset(email);
    setMsg("Password reset link sent. Check your inbox.", "ok");
  } catch (err) {
    setMsg(err?.message || "Could not send the reset email.");
  }
}

async function google() {
  const btn = $("authGoogleBtn");
  if (btn) btn.disabled = true;
  setMsg("");
  try {
    safe(() => sessionStorage.setItem("pr_google_redirect", "1"));
    const result = await signInWithGoogle();
    if (result) {
      pendingSignup = false;
      notify(`Signed in as ${result.email}`, "success");
      safe(() => sessionStorage.removeItem("pr_google_redirect"));
      closeAuth();
    }
  } catch (err) {
    safe(() => sessionStorage.removeItem("pr_google_redirect"));
    setMsg(err?.message || "Google sign-in failed.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function back() {
  stopPolling();
  if (pendingSignup) {
    // The account exists but is unverified — don't leave them half signed in.
    pendingSignup = false;
    write(null);
    step = "form";
    mode = "signup";
    paintStep();
    setMsg("Sign up cancelled. Your email must be verified to finish.");
    focusStep();
    return;
  }
  closeAuth();
}

/** Keeps the profile panel in sync with the signed-in account. */
function paintAccount() {
  const user = getUser();
  const signedIn = Boolean(user);

  $("accAuthBlock")?.classList.toggle("hidden", !signedIn);
  $("accAuthSignedOut")?.classList.toggle("hidden", signedIn);

  const email = $("accAuthEmail");
  if (email) email.textContent = user?.email || "";

  const name = $("accAuthName");
  if (name) name.textContent = user?.name || user?.email?.split("@")[0] || "Your account";

  const method = $("accAuthProvider");
  if (method)
    method.textContent = user?.provider === "google.com" ? "Google account" : "Email & password";

  const status = $("accAuthStatus");
  if (status) {
    const verified = Boolean(user?.emailVerified);
    status.textContent = verified ? "Email verified" : "Email not verified";
    status.classList.toggle("ok", verified);
    status.classList.toggle("warn", !verified);
  }
  show("accVerifyBtn", signedIn && !user?.emailVerified);

  const pic = $("accAuthPhoto");
  if (pic) {
    if (user?.photoURL) {
      pic.src = user.photoURL;
      pic.classList.remove("hidden");
    } else {
      pic.classList.add("hidden");
    }
  }

  // The old homepage "Signed in as …" line now lives in the profile panel.
  $("authAccountLine")?.classList.add("hidden");
}

export function initAuthUI() {
  $("authForm")?.addEventListener("submit", submit);
  $("authTabLogin")?.addEventListener("click", () => setMode("login"));
  $("authTabSignup")?.addEventListener("click", () => setMode("signup"));
  $("authForgot")?.addEventListener("click", forgot);
  $("authClose")?.addEventListener("click", () => {
    if (pendingSignup) back();
    else closeAuth();
  });
  $("authBack")?.addEventListener("click", back);
  $("authGoogleBtn")?.addEventListener("click", google);
  $("authCodeSubmit")?.addEventListener("click", checkVerified);
  $("authPassword")?.addEventListener("input", () => {
    const hint = $("authPwHint");
    if (!hint || mode !== "signup") return;
    const problem = passwordProblem($("authPassword")?.value || "");
    hint.textContent = problem
      ? `Password needs: 8+ characters, a capital letter, a lowercase letter and a number.`
      : "Strong password ✓";
    hint.classList.toggle("ok", !problem);
  });
  $("authResend")?.addEventListener("click", async () => {
    try {
      await sendVerificationEmail();
      setMsg("A new verification email is on its way.", "ok");
    } catch (err) {
      setMsg(err?.message || "Could not resend the email.");
    }
  });
  $("authVerifyLater")?.addEventListener("click", () => {
    if (pendingSignup) return back();
    notify("You can verify your email later from the profile panel.", "info");
    closeAuth();
  });
  $("accSignOutBtn")?.addEventListener("click", () => signOut());
  $("accSignInBtn")?.addEventListener("click", () => openAuth("login"));
  $("accSignUpBtn")?.addEventListener("click", () => openAuth("signup"));
  $("accVerifyBtn")?.addEventListener("click", async () => {
    try {
      openAuth("login");
      pendingSignup = false;
      step = "verify";
      paintStep();
      await sendVerificationEmail();
      setMsg("Verification email sent. Check your inbox.", "ok");
      startPolling();
    } catch (err) {
      setMsg(err?.message || "Could not send the email.");
    }
  });
  $("authSignOut")?.addEventListener("click", () => signOut());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el()?.classList.contains("hidden")) {
      if (pendingSignup) back();
      else closeAuth();
    }
  });

  onAuthChange(() => {
    paintAccount();
    if (isSignedIn() && !busy && step === "form" && !el()?.classList.contains("hidden")) {
      // A session appeared (restored or Google) while the form was open.
      closeAuth();
    }
  });

  paintStep();
  paintAccount();

  // Bring the saved account back, so a returning visitor stays signed in.
  restoreSession().then((s) => {
    const greeted = safe(() => sessionStorage.getItem("pr_greeted"));
    if (s && !greeted) {
      safe(() => sessionStorage.setItem("pr_greeted", "1"));
      notify(`Welcome back, ${s.displayName || s.email}`, "success");
    }
  });
  collectGoogleRedirect();
  applyVerifyLinkFromUrl();
  keepSessionAlive();
}

/** If the visitor came back through the email link, finish the verification. */
async function applyVerifyLinkFromUrl() {
  const params = safe(() => new URLSearchParams(window.location.search));
  const oob = params?.get("oobCode");
  const mode = params?.get("mode");
  if (!oob || (mode && mode !== "verifyEmail")) return;
  try {
    const ok = await confirmVerificationCode(oob);
    if (ok) {
      pendingSignup = false;
      notify("Email verified. You're all set!", "success");
      closeAuth();
    }
  } catch {
    /* the link was already used — nothing to do */
  }
  safe(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("oobCode");
    url.searchParams.delete("mode");
    url.searchParams.delete("apiKey");
    url.searchParams.delete("lang");
    url.searchParams.delete("continueUrl");
    window.history.replaceState({}, "", url.toString());
  });
}

/** Keeps the saved sign-in fresh, so people are never logged out unexpectedly. */
function keepSessionAlive() {
  const tick = () => {
    if (!session?.refreshToken) return;
    if (session.expiresAt - 300000 < Date.now()) refresh();
  };
  setInterval(tick, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
  window.addEventListener("focus", tick);
  window.addEventListener("storage", (e) => {
    // Signing in or out in another tab applies here too.
    if (e.key !== KEY) return;
    session = read();
    listeners.forEach((fn) => safe(() => fn(session)));
  });
}

// Boot: restore the saved account and wire up the sign-in screen.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initAuthUI());
  } else {
    initAuthUI();
  }
}
