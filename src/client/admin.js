// Passport Room — Admin Panel (Firebase Realtime Database, live).
// Access requires Firebase Authentication + an entry under /admins/<uid> = true.
import { db, auth } from "./firebase.js";
import { ref, onValue } from "firebase/database";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";

const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const panelView = $("panel-view");
const loginForm = $("login-form");
const loginError = $("login-error");
const adminEmail = $("admin-email");

let unsubCustomers = null;
let unsubStatus = null;
let customers = {};
let statuses = {};

function fmt(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  const n = new Date();
  return (
    d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear()
  );
}

function render() {
  const list = Object.values(customers);
  const online = list.filter((c) => statuses[c.id]?.online === true);
  const today = list.filter((c) => isToday(c.lastVisit));
  const mobile = list.filter((c) => c.deviceType === "mobile" || c.deviceType === "tablet");
  const desktop = list.filter((c) => c.deviceType === "desktop");

  $("stat-lifetime").textContent = list.length;
  $("stat-online").textContent = online.length;
  $("stat-today").textContent = today.length;
  $("stat-mobile").textContent = mobile.length;
  $("stat-desktop").textContent = desktop.length;

  const q = ($("search").value || "").trim().toLowerCase();
  const rows = list
    .filter(
      (c) =>
        !q ||
        c.id.toLowerCase().includes(q) ||
        (c.deviceType || "").includes(q) ||
        (c.os || "").toLowerCase().includes(q) ||
        (c.browser || "").toLowerCase().includes(q),
    )
    .sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));

  $("row-count").textContent = `${rows.length} customer${rows.length === 1 ? "" : "s"}`;
  $("tbody").innerHTML =
    rows
      .map((c) => {
        const on = statuses[c.id]?.online === true;
        return `<tr>
        <td data-label="Status"><span class="dot ${on ? "on" : "off"}"></span>${on ? "Online" : "Offline"}</td>
        <td data-label="Customer ID"><strong>${c.id}</strong></td>
        <td data-label="Device">${c.deviceType || "—"}</td>
        <td data-label="OS">${c.os || "—"}</td>
        <td data-label="Browser">${c.browser || "—"}</td>
        <td data-label="Visits">${c.visitCount || 0}</td>
        <td data-label="First visit">${fmt(c.firstVisit)}</td>
        <td data-label="Last visit">${fmt(c.lastVisit)}</td>
      </tr>`;
      })
      .join("") || `<tr><td colspan="8" class="empty">No customers yet.</td></tr>`;
}

function subscribe() {
  unsubCustomers = onValue(
    ref(db, "customers"),
    (snap) => {
      customers = snap.val() || {};
      render();
    },
    (err) => {
      $("live-error").textContent =
        "Cannot read customers: " + err.message + " (check database rules / admin uid).";
      $("live-error").hidden = false;
    },
  );
  unsubStatus = onValue(ref(db, "status"), (snap) => {
    statuses = snap.val() || {};
    render();
  });
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    adminEmail.textContent = user.email || user.uid;
    loginView.hidden = true;
    panelView.hidden = false;
    subscribe();
  } else {
    unsubCustomers?.();
    unsubStatus?.();
    customers = {};
    statuses = {};
    panelView.hidden = true;
    loginView.hidden = false;
  }
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const btn = $("login-btn");
  btn.disabled = true;
  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (err) {
    loginError.textContent = err.message.replace("Firebase: ", "");
    loginError.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("logout").addEventListener("click", () => signOut(auth));
$("search").addEventListener("input", render);
