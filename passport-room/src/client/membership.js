// Payments, Pro plans and daily limits have been removed: Passport Room is
// 100% free forever. These stubs keep the old API so callers keep working.
export const FREE_DAILY_LIMIT = Infinity;
export function isPro() { return false; }
export function canGenerate() { return true; }
export function consumeGeneration() {}
export function showLimitReached() {}
export function initMembership() {}
