// Passport / ID photo size presets.
export const PASSPORT_SPECS = [
  {
    id: "bd-passport",
    label: "Bangladesh Passport 45×55mm",
    country: "Bangladesh",
    widthMM: 45,
    heightMM: 55,
    dpi: 300,
    subjectFill: (34 / 55) * 1.05,
    headHeightMM: 34,
    bottomFlush: false,
  },
  {
    id: "us-passport",
    label: 'US Passport 2×2"',
    country: "United States",
    widthMM: 51,
    heightMM: 51,
    dpi: 300,
    subjectFill: 0.66,
  },
  {
    id: "schengen",
    label: "Schengen / EU Visa 35×45mm",
    country: "Europe",
    widthMM: 35,
    heightMM: 45,
    dpi: 300,
    subjectFill: 0.72,
  },
  {
    id: "uk-passport",
    label: "UK Passport 35×45mm",
    country: "United Kingdom",
    widthMM: 35,
    heightMM: 45,
    dpi: 300,
    subjectFill: 0.72,
  },
  {
    id: "india-passport",
    label: "India Passport 35×45mm",
    country: "India",
    widthMM: 35,
    heightMM: 45,
    dpi: 300,
    subjectFill: 0.72,
  },
  {
    id: "india-2x2",
    label: 'India / OCI 2×2"',
    country: "India",
    widthMM: 51,
    heightMM: 51,
    dpi: 300,
    subjectFill: 0.66,
  },
  {
    id: "canada-passport",
    label: "Canada Passport 50×70mm",
    country: "Canada",
    widthMM: 50,
    heightMM: 70,
    dpi: 300,
    subjectFill: 0.7,
  },
  {
    id: "china-visa",
    label: "China Visa 33×48mm",
    country: "China",
    widthMM: 33,
    heightMM: 48,
    dpi: 300,
    subjectFill: 0.72,
  },
  {
    id: "australia-passport",
    label: "Australia Passport 35×45mm",
    country: "Australia",
    widthMM: 35,
    heightMM: 45,
    dpi: 300,
    subjectFill: 0.72,
  },
];

export const BACKGROUND_OPTIONS = [
  { id: "blue", label: "Passport Blue", color: "#2563eb" },
  { id: "white", label: "White", color: "#ffffff" },
  { id: "off-white", label: "Off White", color: "#f3f4f6" },
  { id: "light-blue", label: "Light Blue", color: "#cfe0f2" },
  { id: "sky", label: "Sky Blue", color: "#a9c7e8" },
  { id: "grey", label: "Grey", color: "#d7dbe0" },
  { id: "red", label: "Red", color: "#e23b3b" },
];

export function specPixels(spec) {
  return {
    width: Math.round((spec.widthMM / 25.4) * spec.dpi),
    height: Math.round((spec.heightMM / 25.4) * spec.dpi),
  };
}
