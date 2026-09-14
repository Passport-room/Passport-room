// /payment — everything about Pro access lives here: buy, status, renew,
// expiry notice and "restore on another device".

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, ShieldCheck, Zap } from "lucide-react";
import {
  EMPTY_STATE,
  FREE_DAILY_LIMIT,
  PLAN_DAYS,
  fetchMembership,
  fetchPaddleConfig,
  freeRemainingToday,
  getSavedEmail,
  openCheckout,
  readCachedState,
  restoreWithEmail,
  type MembershipState,
  type PaddleConfig,
} from "@/lib/membership-client";

const TITLE = "Donate a little to feel the unlimited — Passport Room Pro";
const DESCRIPTION =
  "Free: 3 passport photos every day. Pro: one $0.99 payment gives 30 days of unlimited photo generation with no ads and no credits.";

export const Route = createFileRoute("/payment")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PaymentPage,
});

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function PaymentPage() {
  const [state, setState] = useState<MembershipState>(EMPTY_STATE);
  const [config, setConfig] = useState<PaddleConfig | null>(null);
  const [freeLeft, setFreeLeft] = useState(FREE_DAILY_LIMIT);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [restoring, setRestoring] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await fetchMembership();
      setState(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    setState(readCachedState());
    setFreeLeft(freeRemainingToday());
    setEmail(getSavedEmail() ?? "");

    let cancelled = false;
    (async () => {
      const [cfg] = await Promise.allSettled([fetchPaddleConfig(), reload()]);
      if (cancelled) return;
      if (cfg.status === "fulfilled") setConfig(cfg.value);
      setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [reload]);

  // Coming back from a successful checkout: the webhook may land a second or
  // two later, so poll briefly until access is unlocked.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("paid")) return;
    setMessage("Payment received — unlocking your unlimited access…");
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      const next = await reload();
      if (next?.pro) {
        clearInterval(timer);
        setMessage("You're Pro! Unlimited photos are unlocked and ads are switched off.");
      } else if (tries >= 12) {
        clearInterval(timer);
        setMessage(
          "Payment received. Access usually unlocks within a minute — tap “Refresh status” if it hasn't.",
        );
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [reload]);

  const buy = async () => {
    setError(null);
    setMessage(null);
    if (!config?.configured) {
      setError(
        config?.missing?.length
          ? `Payments are not switched on yet (missing: ${config.missing.join(", ")}). Please try again a little later.`
          : "Payments are not switched on yet. Please try again a little later.",
      );
      return;
    }
    setBusy(true);
    try {
      await openCheckout(config, email.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the payment window.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!email.trim()) {
      setError("Enter the email address you paid with.");
      return;
    }
    setRestoring(true);
    try {
      const next = await restoreWithEmail(email.trim());
      setState(next);
      setMessage(
        next.pro
          ? "Membership restored on this device. Enjoy unlimited photos!"
          : "No active membership was found for that email address.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore your membership.");
    } finally {
      setRestoring(false);
    }
  };

  const priceLabel = config?.priceLabel ?? "$0.99";
  const expiringSoon = state.pro && state.daysLeft <= 5;

  const proButtonLabel = state.pro
    ? `Renew for ${priceLabel}`
    : state.status === "expired"
      ? `Renew Pro — ${priceLabel}`
      : `Get Pro — ${priceLabel}`;

  return (
    <main className="studio-theme min-h-screen bg-background px-4 py-6 text-foreground sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-4xl">
        <a href="/index.html" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to photo studio
        </a>

        <header className="mx-auto mt-8 max-w-xl text-center sm:mt-12">
          <span className="inline-flex rounded-full border border-border bg-secondary px-3 py-1 text-xs font-semibold uppercase text-secondary-foreground">
            Simple pricing
          </span>
          <h1 className="mt-4 text-3xl font-semibold leading-tight sm:text-5xl">Choose your plan</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
            Make passport photos for free, or unlock unlimited, ad-free access for one small payment.
          </p>
        </header>

        <section className="mx-auto mt-8 grid max-w-3xl gap-4 sm:mt-10 sm:grid-cols-2 sm:items-stretch">
          <article className="flex min-h-96 flex-col rounded-2xl border border-border bg-card p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Free</p>
                <div className="mt-3 flex items-end gap-2">
                  <span className="text-4xl font-semibold">$0</span>
                  <span className="pb-1 text-sm text-muted-foreground">forever</span>
                </div>
              </div>
              {!state.pro && state.status !== "expired" && (
                <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-secondary-foreground">Current</span>
              )}
            </div>
            <div className="my-5 h-px bg-border" />
            <ul className="space-y-3 text-sm text-muted-foreground">
              {[`${FREE_DAILY_LIMIT} photos every day`, "All passport sizes and tools", "Your photos stay on your device", "Small ads support the site"].map((item) => (
                <li key={item} className="flex gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <a href="/index.html" className="mt-auto inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-secondary px-4 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-accent">
              Continue free
            </a>
          </article>

          <article className="relative flex min-h-96 flex-col overflow-hidden rounded-2xl border border-primary bg-card p-5 shadow-2xl sm:p-6">
            <div className="absolute inset-x-0 top-0 h-1 bg-primary" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Zap className="size-4 text-primary" aria-hidden="true" />
                  <p className="text-sm font-semibold">Pro</p>
                </div>
                <div className="mt-3 flex items-end gap-2">
                  <span className="text-4xl font-semibold">{priceLabel}</span>
                  <span className="pb-1 text-sm text-muted-foreground">/ {PLAN_DAYS} days</span>
                </div>
              </div>
              <span className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">Best value</span>
            </div>
            <div className="my-5 h-px bg-border" />
            <ul className="space-y-3 text-sm text-muted-foreground">
              {[`Unlimited photos for ${PLAN_DAYS} days`, "No ads anywhere", "All editing and AI tools", "One-time payment, no subscription"].map((item) => (
                <li key={item} className="flex gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <button type="button" onClick={buy} disabled={busy} className="mt-auto min-h-11 w-full rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60">
              {busy ? "Opening secure checkout…" : proButtonLabel}
            </button>
          </article>
        </section>

        <section className="mx-auto mt-5 max-w-3xl rounded-xl border border-border bg-secondary p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {state.pro ? (
                <><strong>Pro active.</strong> {state.daysLeft} day{state.daysLeft === 1 ? "" : "s"} left, ending {formatDate(state.expiresAt)}.</>
              ) : state.status === "expired" ? (
                <><strong>Pro expired.</strong> You have {freeLeft} free photos left today.</>
              ) : (
                <><strong>Free plan active.</strong> You have {freeLeft} of {FREE_DAILY_LIMIT} photos left today.</>
              )}
            </p>
            <button type="button" onClick={async () => { setChecking(true); await reload(); setFreeLeft(freeRemainingToday()); setChecking(false); }} className="text-sm font-semibold text-primary hover:underline">
              {checking ? "Checking…" : "Refresh status"}
            </button>
          </div>
          {expiringSoon && <p className="mt-3 text-muted-foreground">Renew now and your new {PLAN_DAYS} days will be added after your remaining time.</p>}
          {message && <p className="mt-3 text-secondary-foreground">{message}</p>}
          {error && <p className="mt-3 text-destructive">{error}</p>}
          {config && !config.configured && <p className="mt-3 text-muted-foreground">Payments are being set up. Free photos keep working in the meantime.</p>}
        </section>

        <section className="mx-auto mt-8 max-w-3xl border-t border-border pt-7">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
            <h2 className="font-semibold">Already paid?</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">Enter the email used at checkout to restore Pro on this device.</p>
          <form onSubmit={restore} className="mt-4 flex flex-col gap-3 sm:flex-row">
            <label className="sr-only" htmlFor="proEmail">Payment email address</label>
            <input id="proEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="min-h-11 flex-1 rounded-lg border border-input bg-card px-3 text-sm outline-none focus:border-ring" />
            <button type="submit" disabled={restoring} className="min-h-11 rounded-lg border border-border bg-secondary px-5 text-sm font-semibold transition-colors hover:bg-accent disabled:opacity-60">
              {restoring ? "Checking…" : "Restore access"}
            </button>
          </form>
        </section>

        <p className="mx-auto mt-8 max-w-3xl text-center text-xs leading-5 text-muted-foreground">
          Secure payment by Paddle. Pro unlocks automatically after payment. Your photos always stay on your device.
        </p>
      </div>
    </main>
  );
}
