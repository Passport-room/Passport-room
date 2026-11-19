import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isFirebaseUid,
  isReversal,
  normalizeParams,
  verifySignature,
} from "../../public/api/rewards/_lib/verify.js";
import { DEFAULT_PROVIDER, normalizeProvider, pointsForPayout } from "../../public/api/rewards/_lib/config.js";

const provider = normalizeProvider({
  ...DEFAULT_PROVIDER,
  id: "demo",
  name: "Demo",
  category: "survey",
  maxPerEventPoints: 5000,
  postback: { uidParam: "user_id", amountParam: "amount", txnParam: "trans_id", statusParam: "status" },
  signature: { scheme: "shared-secret", param: "token", params: [], encoding: "hex" },
});

const settings = { pointsPerUnit: 1000, unit: "USD", dailyEarnCapPoints: 5000, minPayoutPoints: 1000 };

describe("postback signature verification", () => {
  it("accepts a matching shared secret and rejects a wrong one", () => {
    expect(verifySignature(provider, { token: "s3cret" }, "s3cret").ok).toBe(true);
    expect(verifySignature(provider, { token: "nope" }, "s3cret").ok).toBe(false);
    expect(verifySignature(provider, {}, "s3cret").ok).toBe(false);
  });

  it("rejects a shared-secret postback when no secret is configured", () => {
    const verdict = verifySignature(provider, { token: "anything" }, "");
    expect(verdict.ok).toBe(false);
  });

  it("verifies md5(uid + secret) providers", () => {
    const md5 = normalizeProvider({
      ...provider,
      signature: { scheme: "md5-uid", param: "secure_hash", params: [], encoding: "hex" },
    });
    const expected = crypto.createHash("md5").update("uid-123abcSup3r").digest("hex");
    expect(verifySignature(md5, { user_id: "uid-123abc", secure_hash: expected }, "Sup3r").ok).toBe(true);
    expect(verifySignature(md5, { user_id: "uid-123abc", secure_hash: "deadbeef" }, "Sup3r").ok).toBe(false);
  });

  it("verifies HMAC-SHA256 over the configured field order", () => {
    const hmac = normalizeProvider({
      ...provider,
      signature: {
        scheme: "hmac-sha256",
        param: "sig",
        params: ["user_id", "trans_id", "amount"],
        encoding: "hex",
      },
    });
    const params = { user_id: "uid-abc123", trans_id: "TX-1", amount: "0.42" };
    const digest = crypto
      .createHmac("sha256", "topsecret")
      .update(`uid-abc123:TX-1:0.42:topsecret`)
      .digest("hex");
    expect(verifySignature(hmac, { ...params, sig: digest }, "topsecret").ok).toBe(true);
    expect(verifySignature(hmac, { ...params, sig: digest }, "other").ok).toBe(false);
  });

  it("refuses unsigned postbacks unless the operator explicitly allows them", () => {
    const unsigned = normalizeProvider({
      ...provider,
      signature: { scheme: "none", param: "token", params: [], encoding: "hex" },
    });
    expect(verifySignature(unsigned, {}, "").ok).toBe(false);
    expect(verifySignature({ ...unsigned, allowUnsigned: true }, {}, "").ok).toBe(true);
  });
});

describe("reward amounts", () => {
  it("converts a payout with the configured rate", () => {
    expect(pointsForPayout(provider, settings, 0.5)).toBe(500);
    expect(pointsForPayout({ ...provider, pointsPerUnit: 2000 }, settings, 0.5)).toBe(1000);
  });

  it("caps a single event and ignores non-positive payouts", () => {
    expect(pointsForPayout(provider, settings, 99)).toBe(5000);
    expect(pointsForPayout(provider, settings, 0)).toBe(0);
    expect(pointsForPayout(provider, settings, -3)).toBe(0);
  });

  it("uses points directly when the provider reports points", () => {
    expect(pointsForPayout({ ...provider, rewardMode: "points" }, settings, 0, 250)).toBe(250);
  });

  it("recognises reversal statuses and rejects malformed user ids", () => {
    expect(isReversal(provider, { status: "reversed" })).toBe(true);
    expect(isReversal(provider, { status: "credited" })).toBe(false);
    expect(isFirebaseUid("AbCdEf1234567890")).toBe(true);
    expect(isFirebaseUid("bad uid!")).toBe(false);
    expect(isFirebaseUid("short")).toBe(false);
  });

  it("normalises array and object parameters without throwing", () => {
    expect(normalizeParams({ a: ["1", "2"], b: null, c: 3 })).toEqual({ a: "1", b: "", c: "3" });
  });
});

describe("rewards database rules", () => {
  const rules = JSON.parse(readFileSync("public/database.rules.json", "utf8")).rules;

  it("lets anyone read the public config but only admins write it", () => {
    expect(rules.rewards.config[".read"]).toBe(true);
    expect(rules.rewards.config[".write"]).toContain("admins");
  });

  it("never lets a client write a balance, history row or ledger lock", () => {
    expect(rules.rewards.users.$uid[".write"]).toBe(false);
    expect(rules.rewards.transactions.$uid[".write"]).toBe(false);
    expect(rules.rewards.ledger[".read"]).toBe(false);
    expect(rules.rewards.ledger[".write"]).toBe(false);
  });

  it("lets a visitor read only their own balance and history", () => {
    expect(rules.rewards.users.$uid[".read"]).toBe("auth != null && auth.uid === $uid");
    expect(rules.rewards.transactions.$uid[".read"]).toBe("auth != null && auth.uid === $uid");
  });

  it("keeps provider secrets unreadable from any client", () => {
    expect(rules.rewardsSecrets[".read"]).toBe(false);
    expect(rules.rewardsSecrets[".write"]).toContain("admins");
  });

  it("preserves the existing review and stats rules", () => {
    expect(rules.reviews[".read"]).toBe(true);
    expect(rules.stats[".read"]).toBe(true);
  });
});
