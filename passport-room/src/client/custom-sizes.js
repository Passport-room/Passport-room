/* Shared on-device custom photo sizes.
 * Used by BOTH the main result-view ratio selector (app.js) and the
 * A4 print editor (print-editor.js) so a size saved in one place is
 * immediately available in the other.
 *   localStorage key: printCustomSizes -> [{ name, widthMM, heightMM }]
 */
export const CUSTOM_SIZES_KEY = "printCustomSizes";

export function loadCustomSizes() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_SIZES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e && e.name && Number(e.widthMM) > 0 && Number(e.heightMM) > 0)
      .map((e) => ({
        name: String(e.name).slice(0, 40),
        widthMM: Number(e.widthMM),
        heightMM: Number(e.heightMM),
      }));
  } catch {
    return [];
  }
}

export function saveCustomSizes(list) {
  try {
    localStorage.setItem(CUSTOM_SIZES_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — keep working in-memory */
  }
}

export function customToSpec(entry) {
  return {
    id: "custom:" + entry.name,
    label: `${entry.name} (${entry.widthMM}×${entry.heightMM}mm)`,
    country: "Custom",
    widthMM: Number(entry.widthMM),
    heightMM: Number(entry.heightMM),
    dpi: 300,
    subjectFill: 0.72,
    custom: true,
  };
}
