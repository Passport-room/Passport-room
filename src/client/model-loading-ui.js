// First-run model download UI — owns *only* the loading-state presentation for
// the on-device CodeFormer model. It knows nothing about enhancement itself.

const CARD_ID = "modelLoadingCard";

const el = (id) => document.getElementById(id);

function refs() {
  return {
    card: el(CARD_ID),
    bar: el("modelLoadingBar"),
    percent: el("modelLoadingPercent"),
    label: el("modelLoadingLabel"),
  };
}

/** Shows the glass card in indeterminate mode. */
export function showModelLoadingCard(label = "Preparing the AI enhancer…") {
  const { card, bar, percent, label: labelEl } = refs();
  if (!card) return;
  card.classList.remove("hidden");
  card.classList.add("indeterminate");
  if (bar) bar.style.width = "";
  if (percent) percent.textContent = "";
  if (labelEl) labelEl.textContent = label;
}

/** Feeds real download progress into the card. */
export function updateModelLoadingProgress(progress) {
  const { card, bar, percent, label } = refs();
  if (!card || card.classList.contains("hidden")) return;

  if (progress.stage === "download") {
    if (progress.total > 0) {
      const pct = Math.max(1, Math.min(99, Math.round((progress.loaded / progress.total) * 100)));
      card.classList.remove("indeterminate");
      if (bar) bar.style.width = `${pct}%`;
      if (percent) percent.textContent = `${pct}%`;
    } else {
      card.classList.add("indeterminate");
      if (percent) percent.textContent = "";
    }
    if (label) label.textContent = "Downloading the AI enhancement model…";
  } else if (progress.stage === "compile") {
    card.classList.remove("indeterminate");
    if (bar) bar.style.width = "100%";
    if (percent) percent.textContent = "100%";
    if (label) label.textContent = "Preparing the model on your device…";
  } else if (progress.stage === "ready") {
    hideModelLoadingCard();
  }
}

/** Hides the card once the model is ready (or on failure). */
export function hideModelLoadingCard() {
  const { card, bar, percent } = refs();
  if (!card) return;
  card.classList.add("hidden");
  card.classList.remove("indeterminate");
  if (bar) bar.style.width = "";
  if (percent) percent.textContent = "";
}
