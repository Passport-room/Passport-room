/* ------------------------------------------------------------------ *
 * Smart link gate
 *
 * Every real download (single photo, A4 sheet image, direct print) first
 * shows a confirmation popup. When the visitor confirms, the sponsor smart
 * link is opened in a new tab and the download continues in this tab.
 *
 * Safety rules:
 *  - The popup never blocks a download: if the markup is missing, or the
 *    sponsor tab is blocked by the browser, the download still runs.
 *  - window.open() is called synchronously inside the click handler so it
 *    counts as a user gesture and is not treated as an unwanted popup.
 * ------------------------------------------------------------------ */

const SMART_LINK =
  "https://www.profitableratecpmnetwork.com/pd2a2zda6e?key=16765294f014d52c604afec50ac6a85a";

const $ = (id) => document.getElementById(id);

function openSmartLink() {
  try {
    const win = window.open(SMART_LINK, "_blank", "noopener,noreferrer");
    if (win) return;
  } catch {
    /* fall through to the anchor fallback below */
  }
  try {
    const a = document.createElement("a");
    a.href = SMART_LINK;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    /* the sponsor tab is optional — never break the download */
  }
}

let pending = null; // resolve fn of the currently open popup

function close(result) {
  const modal = $("smartLinkModal");
  if (modal) modal.classList.add("hidden");
  const resolve = pending;
  pending = null;
  if (resolve) resolve(result);
}

let wired = false;
function wire() {
  if (wired) return;
  const modal = $("smartLinkModal");
  if (!modal) return;
  wired = true;

  const go = $("smartLinkGo");
  if (go)
    go.addEventListener("click", (e) => {
      e.preventDefault();
      openSmartLink(); // synchronous — keeps the user-gesture context
      close(true);
    });

  const cancel = $("smartLinkCancel");
  if (cancel)
    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      close(false);
    });

  const x = $("smartLinkClose");
  if (x)
    x.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) close(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pending) close(false);
  });
}

/**
 * Shows the "you are about to leave" popup.
 * @param {"single"|"sheet"|"print"} kind
 * @returns {Promise<boolean>} true when the visitor confirmed.
 */
export function confirmSmartDownload(kind = "single") {
  wire();
  const modal = $("smartLinkModal");
  if (!modal) return Promise.resolve(true); // never block the download

  // A popup is already open — refuse the second request instead of stacking.
  if (pending) return Promise.resolve(false);

  const sub = $("smartLinkSub");
  if (sub) {
    const what =
      kind === "print"
        ? "your A4 print sheet"
        : kind === "sheet"
          ? "your A4 print sheet"
          : "your passport photo";
    sub.textContent =
      `When you tap Continue, a sponsor page opens in a new tab and ${what} ` +
      `starts saving to this device automatically. Just close the new tab and come back — ` +
      `your file will be waiting in your Downloads folder.`;
  }

  const goBtn = $("smartLinkGo");
  if (goBtn) goBtn.textContent = kind === "print" ? "Continue & print" : "Continue & download";

  modal.classList.remove("hidden");
  return new Promise((resolve) => {
    pending = resolve;
  });
}
