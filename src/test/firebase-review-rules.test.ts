import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rules = JSON.parse(readFileSync("public/database.rules.json", "utf8")) as {
  rules: {
    reviews: {
      ".read": boolean;
      $reviewId: {
        ".write": string;
        adminReply: { ".validate": string };
        adminReplyTs: { ".validate": string };
        $other: { ".validate": boolean };
      };
    };
  };
};

describe("Firebase review rules", () => {
  it("keeps public reads and authenticated visitor insertion while granting admins management access", () => {
    expect(rules.rules.reviews[".read"]).toBe(true);
    expect(rules.rules.reviews.$reviewId[".write"]).toBe(
      "auth != null && (root.child('admins').child(auth.uid).val() === true || (!data.exists() && newData.exists()))",
    );
  });

  it("validates admin replies and their timestamps without allowing unknown review fields", () => {
    expect(rules.rules.reviews.$reviewId.adminReply[".validate"]).toBe(
      "newData.isString() && newData.val().length >= 1 && newData.val().length <= 5000",
    );
    expect(rules.rules.reviews.$reviewId.adminReplyTs[".validate"]).toBe("newData.isNumber()");
    expect(rules.rules.reviews.$reviewId.$other[".validate"]).toBe(false);
  });
});