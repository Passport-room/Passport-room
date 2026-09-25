// Starts the membership engine once the page is ready.
import { initMembership } from "./membership.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initMembership());
} else {
  initMembership();
}
