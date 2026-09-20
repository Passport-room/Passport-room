// Drawer & Modal Controller for Passport Room
import {
  loadAccount,
  saveAccount,
  updateProfile,
  updateSettings,
  getHistory,
  clearAllLocalData,
} from "./account-manager.js";
import { PASSPORT_SPECS } from "./passport-specs.js";

const $ = (id) => document.getElementById(id);

// Toast Notification System
export function showToast(message, type = "info", duration = 3200) {
  let box = $("toastBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "toastBox";
    box.className = "toastBox";
    document.body.appendChild(box);
  }

  const toast = document.createElement("div");
  toast.className = `toastItem ${type}`;

  const iconMap = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };

  toast.innerHTML = `
    <span class="toastIcon">${iconMap[type] || iconMap.info}</span>
    <span class="toastMsg">${escapeHtml(message)}</span>
  `;

  box.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, duration);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
  });
}

// Drawer Controller
let activeDrawer = null;
let activeModal = null;

export function openDrawer(drawerId) {
  closeActiveDrawer();
  closeActiveModal();

  const drawer = $(drawerId);
  const backdrop = $("drawerBackdrop");

  if (!drawer) return;

  drawer.classList.remove("hidden");
  if (backdrop) backdrop.classList.remove("hidden");

  // Force reflow for smooth transform transition
  void drawer.offsetWidth;
  drawer.classList.add("open");
  if (backdrop) backdrop.classList.add("active");

  activeDrawer = drawerId;
  document.body.style.overflow = "hidden";

  if (drawerId === "accountDrawer") {
    renderAccountPanel();
  } else if (drawerId === "menuDrawer") {
    renderMenuDrawerHeader();
  }
}

export function closeActiveDrawer() {
  if (!activeDrawer) return;
  const drawer = $(activeDrawer);
  const backdrop = $("drawerBackdrop");

  if (drawer) {
    drawer.classList.remove("open");
    setTimeout(() => {
      drawer.classList.add("hidden");
    }, 280);
  }

  if (backdrop && !activeModal) {
    backdrop.classList.remove("active");
    setTimeout(() => {
      if (!activeDrawer && !activeModal) backdrop.classList.add("hidden");
    }, 280);
  }

  activeDrawer = null;
  if (!activeModal) document.body.style.overflow = "";
}

// Modal Controller
export function openModal(modalId) {
  closeActiveModal();

  const modal = $(modalId);
  const backdrop = $("drawerBackdrop");

  if (!modal) return;

  modal.classList.remove("hidden");
  if (backdrop) backdrop.classList.remove("hidden");

  void modal.offsetWidth;
  modal.classList.add("open");
  if (backdrop) backdrop.classList.add("active");

  activeModal = modalId;
  document.body.style.overflow = "hidden";

  if (modalId === "presetsModal") {
    renderPresetsGuide();
  } else if (modalId === "historyModal") {
    renderHistoryModal();
  }
}

export function closeActiveModal() {
  if (!activeModal) return;
  const modal = $(activeModal);
  const backdrop = $("drawerBackdrop");

  if (modal) {
    modal.classList.remove("open");
    setTimeout(() => {
      modal.classList.add("hidden");
    }, 280);
  }

  if (backdrop && !activeDrawer) {
    backdrop.classList.remove("active");
    setTimeout(() => {
      if (!activeDrawer && !activeModal) backdrop.classList.add("hidden");
    }, 280);
  }

  activeModal = null;
  if (!activeDrawer) document.body.style.overflow = "";
}

// Render Account Panel
export function renderAccountPanel() {
  const acc = loadAccount();

  // Avatar rendering
  const avatarEl = $("accAvatarImg");
  const avatarInitialsEl = $("accAvatarInitials");
  if (acc.avatar) {
    avatarEl.src = acc.avatar;
    avatarEl.classList.remove("hidden");
    if (avatarInitialsEl) avatarInitialsEl.classList.add("hidden");
  } else {
    avatarEl.classList.add("hidden");
    if (avatarInitialsEl) {
      avatarInitialsEl.classList.remove("hidden");
      avatarInitialsEl.textContent = getInitials(acc.displayName);
    }
  }

  // Name & badge
  const nameInput = $("accNameInput");
  if (nameInput) nameInput.value = acc.displayName;

  const dateEl = $("accCreatedDate");
  if (dateEl) dateEl.textContent = `Member since ${acc.createdDate || "July 2026"}`;

  // Statistics
  if ($("statPhotosCount")) $("statPhotosCount").textContent = acc.stats.photosProcessed || 0;
  if ($("statSheetsCount")) $("statSheetsCount").textContent = acc.stats.printSheetsCreated || 0;
  if ($("statSingleCount")) $("statSingleCount").textContent = acc.stats.singleDownloads || 0;

  const lastActiveEl = $("statLastActive");
  if (lastActiveEl) {
    const d = new Date(acc.stats.lastActive || Date.now());
    lastActiveEl.textContent = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // Settings sync
  const formatSelect = $("settingFormatSelect");
  if (formatSelect) formatSelect.value = acc.settings.defaultFormat || "png";

  const specSelect = $("settingSpecSelect");
  if (specSelect) specSelect.value = acc.settings.defaultSpec || "bd-passport";

  // Header quick profile update
  updateHeaderProfileWidget(acc);
}

function getInitials(name) {
  if (!name) return "P";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function updateHeaderProfileWidget(acc = loadAccount()) {
  const nameEl = $("topProfileName");
  const subEl = $("topProfileSub");
  if (nameEl) nameEl.textContent = acc.displayName;
  if (subEl) subEl.textContent = `${acc.stats.photosProcessed || 0} photos created`;
}

function renderMenuDrawerHeader() {
  const acc = loadAccount();
  const menuName = $("menuDrawerUserName");
  const menuStats = $("menuDrawerUserStats");
  if (menuName) menuName.textContent = acc.displayName;
  if (menuStats)
    menuStats.textContent = `Local Citizen • ${acc.stats.photosProcessed || 0} created`;
}

// Render Presets Guide Modal
export function renderPresetsGuide(filterRegion = "ALL", searchQuery = "") {
  const grid = $("presetsGuideGrid");
  if (!grid) return;

  grid.innerHTML = "";

  const q = searchQuery.toLowerCase().trim();

  const filtered = PASSPORT_SPECS.filter((spec) => {
    const matchesSearch =
      !q || spec.label.toLowerCase().includes(q) || spec.country.toLowerCase().includes(q);
    return matchesSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="emptyNotice">No passport specs found matching "${escapeHtml(searchQuery)}".</div>`;
    return;
  }

  filtered.forEach((spec) => {
    const card = document.createElement("div");
    card.className = "presetCard";
    const isBD = spec.id === "bd-passport";

    card.innerHTML = `
      <div class="presetCardHead">
        <div>
          <h4 class="presetTitle">${escapeHtml(spec.label)}</h4>
          <span class="presetCountry">${escapeHtml(spec.country)}</span>
        </div>
        ${isBD ? `<span class="badge bdBadge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="display:inline-block; vertical-align:-1px; margin-right:3px;"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg> Official BD</span>` : `<span class="presetDimBadge">${spec.widthMM}×${spec.heightMM} mm</span>`}
      </div>
      <div class="presetDetails">
        <div class="presetRow"><span>Dimensions:</span> <strong>${spec.widthMM} × ${spec.heightMM} mm</strong></div>
        <div class="presetRow"><span>Resolution:</span> <strong>${spec.dpi} DPI (300 DPI Standard)</strong></div>
        <div class="presetRow"><span>Head Fill:</span> <strong>${Math.round((spec.subjectFill || 0.65) * 100)}% Frame Height</strong></div>
        <div class="presetRow"><span>Background:</span> <strong>Plain White or Sky Blue</strong></div>
      </div>
      <button class="btn primarySmall usePresetBtn" data-spec-id="${spec.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg>
        Apply This Spec
      </button>
    `;

    grid.appendChild(card);
  });
}

// Check and show save photos notice modal after 1st image creation when returning home
export function checkAndShowSavePhotosNotice() {
  const prompted = localStorage.getItem("cubit_save_notice_prompted");
  if (prompted) return; // Only show notice once!

  const saveCheckbox = $("noticeSaveCheckbox");
  if (saveCheckbox) {
    saveCheckbox.checked = true;
  }

  openModal("savePhotosNoticeModal");
}

// Render History Modal
export function renderHistoryModal() {
  const toggle = $("historyAutoSaveToggle");
  if (toggle) {
    const isSaveEnabled = localStorage.getItem("cubit_save_photos_enabled") !== "false";
    toggle.checked = isSaveEnabled;
    toggle.onchange = (e) => {
      const checked = e.target.checked;
      localStorage.setItem("cubit_save_photos_enabled", checked ? "true" : "false");
      localStorage.setItem("cubit_save_notice_prompted", "true");
      updateSettings({ savePhotos: checked });
    };
  }

  const list = $("historyList");
  if (!list) return;

  const history = getHistory();
  list.innerHTML = "";

  if (history.length === 0) {
    list.innerHTML = `
      <div class="emptyHistory">
        <div class="emptyIcon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5-9 9"/></svg></div>
        <h3>No saved photos yet</h3>
        <p class="muted">Your processed photos will be saved locally on this device if enabled.</p>
      </div>
    `;
    return;
  }

  history.forEach((item) => {
    const card = document.createElement("div");
    card.className = "historyCard";

    card.innerHTML = `
      <div class="historyThumb">
        ${item.thumbnail ? `<img src="${item.thumbnail}" alt="Thumbnail" />` : `<div class="noThumb">Photo</div>`}
      </div>
      <div class="historyMeta">
        <div class="historyTitle">${escapeHtml(item.specLabel)}</div>
        <div class="historyDate">${escapeHtml(item.formattedDate)}</div>
      </div>
      <div class="historyActions">
        ${item.thumbnail ? `<a href="${item.thumbnail}" download="${item.specId}-photo.png" class="btn ghostSmall">Download</a>` : ""}
      </div>
    `;

    list.appendChild(card);
  });
}

// Initialize all Drawer & Modal Event Listeners
export function initModalsManager(onSelectPreset) {
  const backdrop = $("drawerBackdrop");
  if (backdrop) {
    backdrop.addEventListener("click", () => {
      closeActiveDrawer();
      closeActiveModal();
    });
  }

  // Save photos notice modal confirmation
  const noticeConfirmBtn = $("noticeConfirmBtn");
  if (noticeConfirmBtn) {
    noticeConfirmBtn.addEventListener("click", () => {
      const checkbox = $("noticeSaveCheckbox");
      const isChecked = checkbox ? checkbox.checked : true;
      localStorage.setItem("cubit_save_photos_enabled", isChecked ? "true" : "false");
      localStorage.setItem("cubit_save_notice_prompted", "true");
      updateSettings({ savePhotos: isChecked });
      closeActiveModal();
    });
  }

  // Close buttons
  document.querySelectorAll("[data-close-drawer]").forEach((btn) => {
    btn.addEventListener("click", closeActiveDrawer);
  });

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", closeActiveModal);
  });

  // ESC key listener
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeActiveDrawer();
      closeActiveModal();
    }
  });

  // Account form submit / save name
  const saveNameBtn = $("accSaveNameBtn");
  const nameInput = $("accNameInput");
  if (saveNameBtn && nameInput) {
    saveNameBtn.addEventListener("click", () => {
      const newName = nameInput.value.trim();
      if (newName) {
        updateProfile(newName);
        showToast("Display name updated successfully!", "success");
        renderAccountPanel();
      }
    });
  }

  // Avatar upload
  const avatarFile = $("accAvatarFile");
  if (avatarFile) {
    avatarFile.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          updateProfile(null, evt.target.result);
          showToast("Profile avatar updated!", "success");
          renderAccountPanel();
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Clear data button
  const clearDataBtn = $("accClearDataBtn");
  if (clearDataBtn) {
    clearDataBtn.addEventListener("click", () => {
      if (
        confirm(
          "Are you sure you want to clear all locally saved statistics, history, and settings on this device?",
        )
      ) {
        clearAllLocalData();
        showToast("All local account data cleared.", "info");
        renderAccountPanel();
        closeActiveDrawer();
      }
    });
  }

  // Settings change handlers
  const formatSelect = $("settingFormatSelect");
  if (formatSelect) {
    formatSelect.addEventListener("change", (e) => {
      updateSettings({ defaultFormat: e.target.value });
      showToast(`Default export format set to ${e.target.value.toUpperCase()}`, "success");
    });
  }

  const specSelect = $("settingSpecSelect");
  if (specSelect) {
    specSelect.addEventListener("change", (e) => {
      updateSettings({ defaultSpec: e.target.value });
      showToast("Default passport specification saved.", "success");
    });
  }

  // Preset guide search
  const presetSearch = $("presetSearchInput");
  if (presetSearch) {
    presetSearch.addEventListener("input", (e) => {
      renderPresetsGuide("ALL", e.target.value);
    });
  }

  // Preset card click delegate
  const presetGrid = $("presetsGuideGrid");
  if (presetGrid && onSelectPreset) {
    presetGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".usePresetBtn");
      if (btn) {
        const specId = btn.dataset.specId;
        onSelectPreset(specId);
        closeActiveModal();
        showToast(`Applied preset: ${specId}`, "success");
      }
    });
  }

  // Initial widget update
  updateHeaderProfileWidget();
}
