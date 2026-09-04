// Single Firebase entry point for the whole site.
// Realtime Database only — no Firestore.
import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBwTzFmMTHEfdX0ZqqXNP29EcQoLud1hrM",
  authDomain: "passport-48389.firebaseapp.com",
  projectId: "passport-48389",
  storageBucket: "passport-48389.firebasestorage.app",
  messagingSenderId: "222961536167",
  appId: "1:222961536167:web:618360108d616b8f129f82",
  databaseURL: "https://passport-48389-default-rtdb.firebaseio.com",
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);
