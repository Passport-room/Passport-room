// First-visit "free forever" banner + Smart Link ad gate on Hint and every
// Download button. Dismissal is stored in localStorage so it never repeats.
export const AD_URL =
  "https://app.trcefy.com/sl?id=6a2050db46d3cf0d62f32aa4&pid=2&sub2=u834079&sub6=s2smartLink&sub5=s1SUBID1HERE";
const BANNER_KEY = "pr_free_banner_dismissed";
const $ = (id) => document.getElementById(id);
const safe = (fn) => { try { return fn(); } catch { return null; } };

function openAd() {
  safe(() => window.open(AD_URL, "_blank", "noopener"));
}

function initBanner() {
  const banner = $("prFreeBanner");
  if (!banner || safe(() => localStorage.getItem(BANNER_KEY))) return;
  banner.classList.remove("hidden");
  $("prFreeOk")?.addEventListener("click", () => {
    safe(() => localStorage.setItem(BANNER_KEY, "1"));
    banner.classList.add("hidden");
  });
}

const DOWNLOAD_IDS = ["dlSingle", "dlSheet", "dlPrint", "confirmDownloadSheet", "confirmPrintPdf"];
let pending = null;
let passThrough = false;

function initAdGate() {
  const modal = $("prAdModal");
  const close = () => { modal?.classList.add("hidden"); pending = null; };
  $("prAdClose")?.addEventListener("click", close);
  modal?.addEventListener("click", (e) => { if (e.target === modal) close(); });
  $("prAdGo")?.addEventListener("click", () => {
    const btn = pending;
    modal?.classList.add("hidden");
    pending = null;
    openAd();
    if (btn) { passThrough = true; btn.click(); passThrough = false; }
  });

  document.addEventListener(
    "click",
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (t.closest("#hintBtn")) {
        openAd();
        return;
      }
      const btn = t.closest(DOWNLOAD_IDS.map((id) => "#" + id).join(","));
      if (!btn || passThrough || btn.disabled) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pending = btn;
      modal?.classList.remove("hidden");
    },
    true,
  );
}

function boot() { initBanner(); initAdGate(); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
