// Pure Offerwall.GG postback helpers (no Firebase), so they can be unit tested.
import crypto from 'node:crypto';

const pick = (q, ...names) => {
  for (const name of names) {
    const value = q[name];
    if (value !== undefined && value !== null && value !== '') return String(Array.isArray(value) ? value[0] : value);
  }
  return '';
};

export function readPostback(q) {
  return {
    userId: pick(q, 'userId', 'user_id', 'user', 'subid'),
    transactionId: pick(q, 'transactionId', 'transaction_id', 'tx', 'txid', 'trans_id'),
    amount: pick(q, 'currencyAmount', 'currency_amount', 'amount', 'points', 'reward'),
    signature: pick(q, 'signature', 'sig', 'hash').toLowerCase(),
    status: pick(q, 'status') || 'credited',
    test: pick(q, 'test'),
  };
}

export function expectedSignature(secret, userId, transactionId, amount) {
  return crypto.createHmac('sha256', secret).update(`${userId}:${transactionId}:${amount}`).digest('hex');
}

export function signatureValid(secret, postback) {
  if (!secret || !/^[0-9a-f]{64}$/.test(postback.signature)) return false;
  const expected = expectedSignature(secret, postback.userId, postback.transactionId, postback.amount);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(postback.signature));
}

export const isTest = postback => postback.test === '1' || postback.test === 'true';

// Hash exact identifiers to avoid Firebase's forbidden key characters and collisions.
export const dedupeKey = postback => crypto.createHash('sha256')
  .update(`${postback.transactionId}:${postback.status}`)
  .digest('hex');

export function validate(postback) {
  if (!postback.userId || postback.userId.length > 128 || /[.#$\[\]\/]/.test(postback.userId)) return 'bad userId';
  if (!postback.transactionId || postback.transactionId.length > 256) return 'bad transactionId';
  if (!/^-?\d+(\.\d{1,4})?$/.test(postback.amount)) return 'bad amount';
  if (!['credited', 'reversed'].includes(postback.status)) return 'bad status';
  return '';
}

// Called within Firebase's atomic wallet transaction; a duplicate event is a no-op.
export function applyReward(current, postback, timestamp) {
  const wallet = current && typeof current === 'object' ? current : {};
  const transactions = wallet.transactions && typeof wallet.transactions === 'object' ? wallet.transactions : {};
  const key = dedupeKey(postback);
  if (transactions[key]) return undefined;

  const amount = Math.round(Number(postback.amount) * 10000) / 10000;
  const next = { ...wallet, coins: Math.round(((Number(wallet.coins) || 0) + amount) * 10000) / 10000 };
  next.transactions = { ...transactions, [key]: { transactionId: postback.transactionId, amount, status: postback.status, ts: timestamp } };
  return next;
}
