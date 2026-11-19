// Vercel serverless function: Offerwall.GG conversion postback -> Firebase coin balance.
// Configure OFFERWALL_SECRET_KEY, FIREBASE_SERVICE_ACCOUNT and optional FIREBASE_DATABASE_URL in Vercel.
import admin from 'firebase-admin';
import { readPostback, signatureValid, isTest, validate, applyReward } from '../lib/offerwall.js';

const DB_URL = process.env.FIREBASE_DATABASE_URL || 'https://passport-48389-default-rtdb.firebaseio.com';

function getDatabase() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      databaseURL: DB_URL,
    });
  }
  return admin.database();
}

async function requestParams(req) {
  const params = { ...(req.query || {}) };
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') body = Object.fromEntries(new URLSearchParams(body));
    Object.assign(params, body || {});
  }
  return params;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).send('0');
  const postback = readPostback(await requestParams(req));

  if (!signatureValid(process.env.OFFERWALL_SECRET_KEY, postback)) return res.status(403).send('0');
  if (isTest(postback)) return res.status(200).send('1'); // acknowledge dashboard test, never credit it
  const error = validate(postback);
  if (error) return res.status(400).send('0');

  try {
    const walletRef = getDatabase().ref(`wallets/${postback.userId}`);
    // Balance and dedupe marker commit together; concurrent/retried postbacks cannot double-credit.
    const result = await walletRef.transaction(wallet => applyReward(wallet, postback, Date.now()));
    return res.status(200).send(result.committed ? '1' : '1');
  } catch (error) {
    console.error('Offerwall credit failed', error);
    return res.status(500).send('0');
  }
}
