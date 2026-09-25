// /account — self-service billing.
//
// The page mints a Paddle-hosted customer portal session and sends the buyer
// there. Paddle's portal is where payment details, cancellation and invoices
// live, so we never build those screens ourselves.
//
// Security: the POST handler below authenticates the visitor FIRST (they must
// have a membership record for their device / email), then resolves their
// Paddle customer id SERVER-SIDE from the mirrored webhook data. A customer id
// sent by the browser is ignored completely.
//
// Nothing here deletes or changes any Paddle object — it only creates a
// short-lived portal session for the signed-in buyer.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CreditCard, ExternalLink, ShieldCheck } from "lucide-react";
import {
  EMPTY_STATE,
  fetchMembership,
  getDeviceId,
  getSavedEmail,
  readCachedState,
  type MembershipState,
} from "@/lib/membership-client";

const TITLE = "Your account — Passport Room billing & invoices";
const DESCRIPTION =
  "Manage your Passport Room Pro access: update your payment method, view invoices or cancel, in the secure portal hosted by Paddle.com, our Merchant of Record.";

export const Route = createFileRoute("/account")({
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
  server: {
    handlers: {
      POST: async ({ request }) => {
        const {
          createPaddlePortalSession,
          findPaddleCustomerIdByEmail,
          isEmail,
          listSubscriptionsForCustomer,
          resolveMembership,
          safeDeviceId,
          subscriptionGrantsAccess,
        } = await import("@/lib/membership.server");

        let body: { deviceId?: unknown; email?: unknown } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ error: "invalid request" }, { status: 400 });
        }

        const deviceId = safeDeviceId(body.deviceId);
        const email = isEmail(body.email) ? String(body.email).trim().toLowerCase() : null;
        if (!deviceId && !email) {
          return Response.json({ error: "not signed in" }, { status: 401 });
        }

        // 1. Authenticate: only a known buyer gets a portal session.
        const member = await resolveMembership(deviceId, email).catch(() => null);
        const memberEmail = member?.email ?? email;
        if (!member || !memberEmail) {
          return Response.json(
            { error: "We couldn't find a purchase for this device or email address." },
            { status: 403 },
          );
        }

        // 2. Resolve the Paddle customer id server-side. Never from the client.
        const customerId = await findPaddleCustomerIdByEmail(memberEmail).catch(() => null);
        if (!customerId) {
          return Response.json(
            { error: "No billing profile found yet. It appears shortly after a payment." },
            { status: 404 },
          );
        }

        const subscriptions = await listSubscriptionsForCustomer(customerId).catch(() => []);
        const subscriptionIds = subscriptions.filter(subscriptionGrantsAccess).map((s) => s.id);

        try {
          const session = await createPaddlePortalSession({ customerId, subscriptionIds });
          const url = session.manageUrl ?? session.overviewUrl;
          if (!url) return Response.json({ error: "portal unavailable" }, { status: 502 });
          return Response.json(
            { url, hasSubscription: subscriptionIds.length > 0 },
            { headers: { "cache-control": "no-store" } },
          );
        } catch (err) {
          console.error("[account] portal session failed", err);
          return Response.json({ error: "Billing portal is temporarily unavailable." }, {
            status: 502,
          });
        }
      },
    },
  },
  component: AccountPage,
});

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function AccountPage() {
  const [state, setState] = useState<MembershipState>(EMPTY_STATE);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(readCachedState());
    const saved = getSavedEmail();
    if (saved) setEmail(saved);
    fetchMembership()
      .then(setState)
      .catch(() => undefined);
  }, []);

  const openPortal = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: getDeviceId(),
          email: (email || state.email || "").trim().toLowerCase() || undefined,
        }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not open the billing portal.");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not reach the billing portal. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [email, state.email]);

  return (
    <main className="min-h-screen bg-background px-4 py-12 text-foreground">
      <div className="mx-auto w-full max-w-xl">
        <a
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Passport Room
        </a>

        <h1 className="mt-6 text-3xl font-bold tracking-tight">Your account</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Update your payment method, download invoices or cancel — in the secure portal hosted by
          Paddle.com, our Merchant of Record.
        </p>

        <div className="mt-8 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {state.pro ? "Pro access is active" : "No active Pro access"}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium capitalize">{state.status}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Valid until</dt>
              <dd className="font-medium">{formatDate(state.expiresAt)}</dd>
            </div>
          </dl>
        </div>

        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <label htmlFor="account-email" className="text-sm font-medium">
            Email used at checkout
          </label>
          <input
            id="account-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={openPortal}
            disabled={busy}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            <CreditCard className="h-4 w-4" />
            {busy ? "Opening secure portal…" : "Manage billing"}
            <ExternalLink className="h-4 w-4" />
          </button>
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
          <p className="mt-3 text-xs text-muted-foreground">
            We look your billing profile up on our side — you never need a customer number.
          </p>
        </div>
      </div>
    </main>
  );
}
