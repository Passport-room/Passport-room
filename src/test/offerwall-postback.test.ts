import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module served by Vercel
import { readPostback, signatureValid, isTest, dedupeKey, validate, applyReward } from "../../public/lib/offerwall.js";

const SECRET = "test-secret";
const sign = (s: string) => createHmac("sha256", SECRET).update(s).digest("hex");

describe("Offerwall postback", () => {
  it("accepts HMAC-SHA256 of userId:transactionId:currencyAmount", () => {
    const p = readPostback({ userId: "u1", transactionId: "tx9", currencyAmount: "12.5", signature: sign("u1:tx9:12.5") });
    expect(signatureValid(SECRET, p)).toBe(true);
  });
  it("rejects a tampered amount", () => {
    const p = readPostback({ userId: "u1", transactionId: "tx9", currencyAmount: "999", signature: sign("u1:tx9:12.5") });
    expect(signatureValid(SECRET, p)).toBe(false);
  });
  it("flags test postbacks", () => {
    expect(isTest(readPostback({ test: "1" }))).toBe(true);
    expect(isTest(readPostback({}))).toBe(false);
  });
  it("dedupes on transaction and status, so a reversal is applied once", () => {
    const a = readPostback({ transactionId: "tx9", status: "credited" });
    const b = readPostback({ transactionId: "tx9", status: "reversed" });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
    expect(dedupeKey(a)).toBe(dedupeKey(a));
  });
  it("applies each signed event exactly once and permits its reversal once", () => {
    const credit = readPostback({ userId: "u1", transactionId: "tx9", currencyAmount: "12.5", status: "credited" });
    const reversal = readPostback({ userId: "u1", transactionId: "tx9", currencyAmount: "-12.5", status: "reversed" });
    const afterCredit = applyReward({ coins: 3 }, credit, 1);
    expect(afterCredit.coins).toBe(15.5);
    expect(applyReward(afterCredit, credit, 2)).toBeUndefined();
    const afterReversal = applyReward(afterCredit, reversal, 3);
    expect(afterReversal.coins).toBe(3);
    expect(applyReward(afterReversal, reversal, 4)).toBeUndefined();
  });
  it("rejects user IDs that are not valid database keys", () => {
    expect(validate(readPostback({ userId: "a/b", transactionId: "t", currencyAmount: "1" }))).toBe("bad userId");
  });
});
