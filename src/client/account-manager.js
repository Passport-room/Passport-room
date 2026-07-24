// Local Account & Settings Engine (localStorage & IndexedDB fallback)

const ACCOUNT_KEY = "cubit_account_v2";
const HISTORY_KEY = "cubit_history_v2";

export function getDefaultAccount() {
  const randomId = Math.floor(1000 + Math.random() * 9000);
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return {
    id: `usr_${randomId}`,
    displayName: `Passport Creator #${randomId}`,
    avatar: null, // null means use default generated initials avatar
    avatarColor: "#6366f1",
    createdDate: dateStr,
    createdTimestamp: now.toISOString(),
    stats: {
      photosProcessed: 0,
      printSheetsCreated: 0,
      singleDownloads: 0,
      lastActive: now.toISOString(),
    },
    settings: {
      defaultSpec: "bd-passport",
      defaultFormat: "png",
      autoDownload: false,
      notifications: true,
      theme: "dark",
    },
  };
}

export function loadAccount() {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) {
      const fresh = getDefaultAccount();
      saveAccount(fresh);
      return fresh;
    }
    const acc = JSON.parse(raw);
    // Ensure stats structure exists
    if (!acc.stats) acc.stats = getDefaultAccount().stats;
    if (!acc.settings) acc.settings = getDefaultAccount().settings;
    return acc;
  } catch (err) {
    console.warn("Failed to load account from localStorage:", err);
    return getDefaultAccount();
  }
}

export function saveAccount(account) {
  try {
    account.stats.lastActive = new Date().toISOString();
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch (err) {
    console.error("Failed to save account:", err);
  }
}

export function updateProfile(displayName, avatarDataUrl = null) {
  const acc = loadAccount();
  if (displayName && displayName.trim()) {
    acc.displayName = displayName.trim();
  }
  if (avatarDataUrl !== undefined) {
    acc.avatar = avatarDataUrl;
  }
  saveAccount(acc);
  return acc;
}

export function updateSettings(partialSettings) {
  const acc = loadAccount();
  acc.settings = { ...acc.settings, ...partialSettings };
  saveAccount(acc);
  return acc;
}

export function recordActivity(type, extra = {}) {
  const acc = loadAccount();
  if (!acc.stats) acc.stats = getDefaultAccount().stats;

  if (type === "photo_processed") {
    acc.stats.photosProcessed = (acc.stats.photosProcessed || 0) + 1;
  } else if (type === "print_sheet") {
    acc.stats.printSheetsCreated = (acc.stats.printSheetsCreated || 0) + 1;
  } else if (type === "single_download") {
    acc.stats.singleDownloads = (acc.stats.singleDownloads || 0) + 1;
  }

  saveAccount(acc);
  return acc;
}

export function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

export function addHistoryItem(item) {
  try {
    const isSaveEnabled =
      localStorage.getItem("cubit_save_photos_enabled") !== "false";
    if (!isSaveEnabled) {
      return getHistory();
    }
    const history = getHistory();
    const newItem = {
      id: "hist_" + Date.now(),
      timestamp: new Date().toISOString(),
      formattedDate: new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      specLabel: item.specLabel || "Passport Photo",
      specId: item.specId || "bd-passport",
      thumbnail: item.thumbnail || null, // data URL thumbnail
    };
    // Keep last 15 items
    history.unshift(newItem);
    if (history.length > 15) history.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    return history;
  } catch (e) {
    console.warn("Failed to add history item:", e);
    return [];
  }
}

export function clearAllLocalData() {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem("cubit_photo_edits"); // photo editor settings
    return getDefaultAccount();
  } catch (e) {
    console.error("Error clearing data:", e);
  }
}
