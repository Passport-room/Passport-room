/* Balance ledger.
 *
 * One reward event = one atomic write to /rewards/users/{uid}, guarded by an
 * ETag. The write carries the new balance, the lifetime totals, the daily
 * tally and the transaction key, so "was this already credited?" and "credit
 * it" are the same indivisible operation. A separate create-only lock under
 * /rewards/ledger prevents the same provider transaction id being credited to
 * two different accounts.
 *
 * There is no code path in which a browser can write a balance: the database
 * rules deny every client write to /rewards, and this server authenticates
 * with a service account.
 */
import { dbDelete, dbGet, dbPatch, dbPut } from "./google.js";
import { pointsForPayout } from "./config.js";

const MAX_TXNS_KEPT = 200;
const MAX_DAYS_KEPT = 30;
const LOCK_STALE_MS = 5 * 60 * 1000;

export function safeKey(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 160);
}

export function txnKey(providerId, providerTxnId, kind = "credit") {
  const prefix = kind === "reversal" ? "rv" : "cr";
  return `${prefix}_${safeKey(providerId)}_${safeKey(providerTxnId)}`;
}

function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function normalizeUser(data) {
  const value = data && typeof data === "object" ? data : {};
  return {
    balance: Math.max(0, Math.round(Number(value.balance) || 0)),
    lifetimeEarned: Math.max(0, Math.round(Number(value.lifetimeEarned) || 0)),
    lifetimeReversed: Math.max(0, Math.round(Number(value.lifetimeReversed) || 0)),
    updatedAt: Number(value.updatedAt) || 0,
    days: value.days && typeof value.days === "object" ? value.days : {},
    txns: value.txns && typeof value.txns === "object" ? value.txns : {},
  };
}

function prune(state, now) {
  const txnEntries = Object.entries(state.txns)
    .sort((a, b) => (Number(b[1]?.ts) || 0) - (Number(a[1]?.ts) || 0))
    .slice(0, MAX_TXNS_KEPT);
  state.txns = Object.fromEntries(txnEntries);

  const dayEntries = Object.entries(state.days)
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .slice(0, MAX_DAYS_KEPT);
  state.days = Object.fromEntries(dayEntries);
  state.updatedAt = now;
  return state;
}

/**
 * Compare-and-swap the user node. `mutate` receives a plain state copy and
 * returns either { done } or { next }.
 */
async function casUser(uid, mutate) {
  const path = `rewards/users/${uid}`;
  let lastError = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = await dbGet(path);
    const state = normalizeUser(snapshot.data);
    const outcome = mutate({ ...state, days: { ...state.days }, txns: { ...state.txns } });
    if (outcome.done) return outcome.done;
    if (!outcome.next) throw new Error("Internal error: ledger mutation produced no write.");

    const etag = snapshot.data === null ? "null_etag" : snapshot.etag;
    if (!etag) {
      lastError = new Error(
        "The database did not return an ETag, so a safe balance update is impossible. " +
          "Check that the Realtime Database REST API is reachable from the deployment.",
      );
      continue;
    }

    const write = await dbPut(path, outcome.next, { ifMatch: etag });
    if (write.ok) return { ...outcome.result, balance: outcome.next.balance };
    if (write.status === 412) {
      // Someone else changed the node between read and write. The 412 body is
      // the current value, so the next loop iteration works from fresh state.
      lastError = null;
      continue;
    }
    throw new Error(`Writing the reward balance failed (${write.status}): ${String(write.text).slice(0, 200)}`);
  }
  throw lastError || new Error("The reward balance changed too often to update; the provider will retry.");
}

/**
 * Apply a provider event.
 *
 * @param {object} input
 * @param {string} input.uid              Firebase anonymous UID (from the postback)
 * @param {object} input.provider         normalized provider config
 * @param {object} input.settings         normalized reward settings
 * @param {string} input.providerTxnId    provider's transaction id
 * @param {"credit"|"reversal"} input.kind
 * @param {number} input.rawAmount        payout in the provider's unit
 * @param {number} [input.rawPoints]      payout already expressed in points
 * @param {object} input.raw              sanitized provider parameters (audit)
 * @param {string} [input.reason]
 */
export async function applyEvent(input) {
  const { uid, provider, settings, providerTxnId, kind, raw } = input;
  const now = Date.now();
  const key = txnKey(provider.id, providerTxnId, kind);
  const lockPath = `rewards/ledger/${provider.id}/${safeKey(providerTxnId)}${kind === "reversal" ? "~r" : ""}`;

  // A credit is derived from the provider's payout using the configured rate;
  // a reversal takes back exactly the points that were credited.
  let points;
  if (kind === "reversal") {
    points = Math.max(0, Math.round(Number(input.rawPoints) || 0));
    if (!points) {
      // Most networks reverse by re-sending the original transaction id with a
      // reversal status. In that case the amount to take back is whatever the
      // original credit was worth, not the number in this request.
      const { data: original } = await dbGet(
        `rewards/transactions/${uid}/${txnKey(provider.id, providerTxnId)}`,
      );
      if (original && Number(original.points) > 0) points = Math.round(Number(original.points));
    }
    if (!points) points = Math.max(0, pointsForPayout(provider, settings, input.rawAmount, undefined));
  } else {
    points = Math.max(0, pointsForPayout(provider, settings, input.rawAmount, input.rawPoints));
  }
  if (!points && kind === "credit") {
    return { status: "invalid-amount", points: 0, txnKey: key };
  }

  /* ---- 1. Claim the provider transaction id (create-only lock). ---- */
  const claim = await dbPut(
    lockPath,
    {
      uid,
      providerId: provider.id,
      providerTxnId: String(providerTxnId),
      kind,
      txnKey: key,
      points,
      status: "applying",
      ts: now,
    },
    { ifMatch: "null_etag" },
  );

  if (!claim.ok) {
    if (claim.status !== 412) {
      throw new Error(`Could not claim the transaction lock (${claim.status}).`);
    }
    const existing = claim.data && typeof claim.data === "object" ? claim.data : null;
    if (existing && existing.uid && existing.uid !== uid) {
      return { status: "conflict", points: 0, txnKey: key, reason: "transaction belongs to another account" };
    }
    if (existing && existing.status === "applied") {
      return { status: "duplicate", points: 0, txnKey: key };
    }
    if (existing && now - Number(existing.ts || 0) < LOCK_STALE_MS) {
      // Another invocation is in flight. Ask the provider to retry instead of
      // risking a double credit.
      return { status: "processing", points: 0, txnKey: key };
    }
    await dbPatch(lockPath, { status: "applying", ts: now, recoveredAt: now });
  }

  /* ---- 2. Credit or reverse inside the user node. ---- */
  const day = today(now);
  let outcome;
  try {
    outcome = await casUser(uid, (state) => {
      if (state.txns[key]) {
        return { done: { status: "duplicate", points: 0, txnKey: key, balance: state.balance } };
      }

      const dayState = state.days[day] && typeof state.days[day] === "object" ? state.days[day] : {};
      const earnedToday = Math.max(0, Math.round(Number(dayState.earned) || 0));

      if (kind === "credit") {
        let credit = points;
        let capped = false;
        const cap = Number(settings.dailyEarnCapPoints) || 0;
        if (cap > 0 && earnedToday >= cap) {
          credit = 0;
          capped = true;
        } else if (cap > 0 && earnedToday + credit > cap) {
          credit = cap - earnedToday;
          capped = true;
        }

        const next = {
          ...state,
          balance: state.balance + credit,
          lifetimeEarned: state.lifetimeEarned + credit,
          days: {
            ...state.days,
            [day]: {
              ...dayState,
              earned: earnedToday + credit,
            },
          },
          txns: {
            ...state.txns,
            [key]: { p: credit, ts: now, t: "credit", provider: provider.id },
          },
        };
        prune(next, now);
        return {
          next,
          result: {
            status: capped ? (credit > 0 ? "credited-capped" : "capped") : "credited",
            points: credit,
            requestedPoints: points,
            txnKey: key,
            balance: next.balance,
          },
        };
      }

      const requested = points;
      const clawback = Math.min(state.balance, points);
      const next = {
        ...state,
        balance: state.balance - clawback,
        lifetimeReversed: state.lifetimeReversed + clawback,
        days: {
          ...state.days,
          [day]: {
            ...dayState,
            reversed: Math.max(0, Math.round(Number(dayState.reversed) || 0)) + clawback,
          },
        },
        txns: {
          ...state.txns,
          [key]: { p: -clawback, ts: now, t: "reversal", provider: provider.id },
        },
      };
      prune(next, now);
      return {
        next,
        result: {
          status: "reversed",
          points: clawback,
          requestedPoints: requested || points,
          uncollectedPoints: Math.max(0, points - clawback),
          txnKey: key,
          balance: next.balance,
        },
      };
    });
  } catch (error) {
    // Release the lock so a provider retry can try again.
    await dbDelete(lockPath).catch(() => {});
    throw error;
  }

  /* ---- 3. Finalise the lock and write the audit record. ---- */
  const finalStatus = outcome.status === "duplicate" ? "duplicate" : "applied";
  await dbPatch(lockPath, {
    status: finalStatus,
    appliedAt: now,
    points: outcome.points,
    balanceAfter: outcome.balance,
  }).catch(() => {});

  if (outcome.status !== "duplicate") {
    await dbPut(`rewards/transactions/${uid}/${key}`, {
      uid,
      providerId: provider.id,
      providerTxnId: String(providerTxnId),
      kind,
      status: outcome.status,
      points: outcome.points,
      requestedPoints: outcome.requestedPoints ?? points,
      balanceAfter: outcome.balance,
      amount: Number(input.rawAmount) || 0,
      unit: settings.unit || "USD",
      raw: raw || {},
      reason: input.reason || "",
      ts: now,
    }).catch(() => {});
  }

  return outcome;
}

/** Balance + recent transactions for the rewards page or an admin lookup. */
export async function readUser(uid) {
  const [{ data: user }, { data: txns }] = await Promise.all([
    dbGet(`rewards/users/${uid}`),
    dbGet(`rewards/transactions/${uid}`),
  ]);
  const state = normalizeUser(user);
  return {
    balance: state.balance,
    lifetimeEarned: state.lifetimeEarned,
    lifetimeReversed: state.lifetimeReversed,
    updatedAt: state.updatedAt,
    today: state.days[today()] || {},
    transactions: Object.entries(txns || {})
      .map(([key, value]) => ({ key, ...(value && typeof value === "object" ? value : {}) }))
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      .slice(0, 200),
  };
}
