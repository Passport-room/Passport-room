// Firebase connection for the studio (official JS SDK).
//
// These values are the public web config from the Firebase console — they are
// meant to ship in the page. Who may read or write what is decided by the
// database rules (see firebase-rules.json in the project root).
//
// Visitor writes go through the SDK so that the anonymous sign-in token is
// attached automatically and counters can be raised with real transactions.
// The admin panel keeps using plain REST with the database secret.

import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { getDatabase } from "firebase/database";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM",
  authDomain: "passport-48389.firebaseapp.com",
  projectId: "passport-48389",
  storageBucket: "passport-48389.firebasestorage.app",
  messagingSenderId: "222961536167",
  appId: "1:222961536167:web:618360108d616b8f129f82",
  databaseURL: "https://passport-48389-default-rtdb.firebaseio.com",
};

export const DB_URL = FIREBASE_CONFIG.databaseURL;

let cached = null;

/** Lazily creates the Firebase app, auth and database handles. */
export function getFirebase() {
  if (cached) return cached;
  const app = getApps()[0] || initializeApp(FIREBASE_CONFIG);
  cached = { app, auth: getAuth(app), db: getDatabase(app) };
  return cached;
}

/**
 * Signs the visitor in anonymously and resolves with the Firebase user.
 * The UID is kept by Firebase itself and survives reloads, browser restarts
 * and a cleared site storage, so it is the visitor's permanent identity.
 *
 * Resolves with `null` when anonymous sign-in is switched off in the console
 * or the network is blocked — tracking then disables itself silently.
 */
export function ensureAnonymousUser() {
  const { auth } = getFirebase();
  return new Promise((resolve) => {
    let settled = false;
    const done = (user) => {
      if (settled) return;
      settled = true;
      resolve(user);
    };

    const stop = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          stop();
          done(user);
        }
      },
      () => done(null),
    );

    signInAnonymously(auth).catch(() => done(null));
    // Never hang the studio waiting for the network.
    setTimeout(() => done(auth.currentUser || null), 15000);
  });
}
