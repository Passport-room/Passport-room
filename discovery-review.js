/* Post-creation discovery + review flow.
 * Opens once per browser, immediately after a photo is created (pr:photo-created).
 * Step 1: "How did you find us?" — the answer is saved to Firebase (/discovery.json).
 * Step 2: the same review box as the homepage — saved to Firebase (/reviews.json).
 * Mandatory 2-step flow: no skip, no close. */
(function () {
  var ANSWER_KEY = "pr_discovery_done_v1";
  var DB_URL = "https://passport-48389-default-rtdb.firebaseio.com";

  var SOURCES = [
    { id: "search", label: "Search engine", hint: "Google, Bing, etc." },
    { id: "social", label: "Social media", hint: "Facebook, Instagram, TikTok, YouTube" },
    { id: "ai", label: "AI agents", hint: "ChatGPT, Gemini, Perplexity, etc." },
    { id: "other", label: "Other", hint: "" }
  ];
  var LEVELS = [
    { n: 1, emoji: "\uD83D\uDE21", label: "Disappointed" },
    { n: 2, emoji: "\uD83D\uDE22", label: "Sad" },
    { n: 3, emoji: "\uD83E\uDD14", label: "Confused" },
    { n: 4, emoji: "\uD83D\uDE42", label: "Satisfied" },
    { n: 5, emoji: "\uD83D\uDE0D", label: "Happy" }
  ];

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function done() { return read(ANSWER_KEY) === "1"; }
  function markDone() { try { localStorage.setItem(ANSWER_KEY, "1"); } catch (e) {} }

  function ids() {
    var deviceId = read("pr_device_id") || "";
    var customerId = read("pr_customer_code") || "";
    return { deviceId: deviceId, customerId: customerId };
  }
  function displayName(customerId) {
    return customerId ? "Customer " + customerId.replace("CUS-", "") : "Guest";
  }
  async function post(path, payload) {
    if (window.prSend) return window.prSend(path, payload);
    var res = await fetch(DB_URL + "/" + path + ".json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("firebase post " + path + " failed (" + res.status + ")");
    return res.json();
  }

  var css =
    "#prDiscoveryOverlay{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;font:14px/1.5 Inter,system-ui,sans-serif}"
    + "#prDiscovery{background:#fff;color:#111827;border-radius:18px;max-width:460px;width:100%;max-height:calc(100vh - 32px);overflow:auto;padding:22px 22px 18px;box-shadow:0 20px 60px rgba(0,0,0,.35)}"
    + "#prDiscovery .prStep{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin:0 0 6px}"
    + "#prDiscovery h2{margin:0 0 14px;font:700 19px/1.3 Inter,system-ui,sans-serif}"
    + "#prDiscovery .prOptions{display:grid;gap:8px;margin:0 0 14px}"
    + "#prDiscovery .prOption{display:flex;gap:10px;align-items:flex-start;text-align:left;border:1px solid #e5e7eb;border-radius:12px;padding:11px 12px;background:#fff;cursor:pointer;font:14px/1.4 Inter,system-ui,sans-serif;color:#111827}"
    + "#prDiscovery .prOption:hover{border-color:#93c5fd}"
    + "#prDiscovery .prOption.sel{border-color:#2563eb;box-shadow:0 0 0 1px #2563eb}"
    + "#prDiscovery .prOption input{margin-top:3px;accent-color:#2563eb}"
    + "#prDiscovery .prOption strong{display:block;font-weight:600}"
    + "#prDiscovery .prOption small{color:#6b7280}"
    + "#prDiscovery .prOtherWrap{margin:-6px 0 14px;display:none}"
    + "#prDiscovery .prOtherWrap.show{display:block}"
    + "#prDiscovery .prOtherWrap input{width:100%;box-sizing:border-box;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;font:14px Inter,system-ui,sans-serif}"
    + "#prDiscovery .prOtherWrap input:focus{outline:2px solid #93c5fd;outline-offset:0;border-color:#2563eb}"
    + "#prDiscovery .prActions{display:flex;justify-content:flex-end;gap:8px}"
    + "#prDiscovery .prNext{border:0;border-radius:10px;padding:10px 22px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer;background:#111827;color:#fff}"
    + "#prDiscovery .prNext:disabled{opacity:.6;cursor:default}"
    + "#prDiscovery .prReviewNote{margin-top:10px;color:#6b7280}"
    + "#prDiscovery .prThanks{text-align:center;color:#111827;font-weight:600;padding:10px 0 2px}";

  var root = null, step = 0, picked = null, rating = 0, busy = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function build() {
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "prDiscoveryOverlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Quick questions about your experience");
    root.innerHTML = '<div id="prDiscovery"></div>';
    document.body.appendChild(root);
    document.body.style.overflow = "hidden";
  }

  function renderStep1() {
    step = 1;
    var box = root.firstElementChild;
    box.innerHTML =
      '<p class="prStep">Step 1 of 2</p>' +
      '<h2>How did you find us?</h2>' +
      '<div class="prOptions" role="radiogroup" aria-label="How did you find us?">' +
      SOURCES.map(function (s) {
        return '<button type="button" class="prOption" data-source="' + s.id + '" role="radio" aria-checked="false">' +
          '<strong>' + esc(s.label) + '</strong>' +
          (s.hint ? '<small>' + esc(s.hint) + '</small>' : '') +
          '</button>';
      }).join("") +
      '</div>' +
      '<div class="prOtherWrap"><input id="prDiscoveryOther" type="text" maxlength="120" placeholder="Tell us where you heard about us" aria-label="Other referral source"></div>' +
      '<div class="prActions"><button type="button" class="prNext" id="prDiscoveryNext">Next</button></div>';
    var otherWrap = box.querySelector(".prOtherWrap");
    var otherInput = box.querySelector("#prDiscoveryOther");
    box.querySelectorAll(".prOption").forEach(function (btn) {
      btn.addEventListener("click", function () {
        picked = btn.dataset.source;
        box.querySelectorAll(".prOption").forEach(function (b) {
          var on = b === btn;
          b.classList.toggle("sel", on);
          b.setAttribute("aria-checked", String(on));
        });
        otherWrap.classList.toggle("show", picked === "other");
        if (picked === "other") otherInput.focus();
      });
    });
    box.querySelector("#prDiscoveryNext").addEventListener("click", async function () {
      if (busy) return;
      var note = null;
      if (!picked) note = "Please choose an option to continue.";
      var otherText = "";
      if (picked === "other") {
        otherText = (otherInput.value || "").trim();
        if (!otherText) note = "Please tell us where you heard about us.";
      }
      if (note) { flash(note); return; }
      busy = true;
      var nextBtn = box.querySelector("#prDiscoveryNext");
      nextBtn.disabled = true;
      var id = ids();
      var label = (SOURCES.find(function (s) { return s.id === picked; }) || {}).label || picked;
      try {
        await post("discovery", {
          source: picked,
          sourceLabel: label,
          other: otherText,
          deviceId: id.deviceId,
          customerId: id.customerId,
          ts: Date.now()
        });
      } catch (e) { /* the flow must continue even if the log write fails */ }
      busy = false;
      if (nextBtn) nextBtn.disabled = false;
      renderStep2(label, otherText);
    });
    function flash(msg) {
      var n = box.querySelector(".prReviewNote");
      if (!n) {
        n = document.createElement("p");
        n.className = "prReviewNote";
        box.appendChild(n);
      }
      n.textContent = msg;
    }
  }

  function renderStep2(sourceLabel, sourceOther) {
    step = 2;
    var box = root.firstElementChild;
    box.innerHTML =
      '<p class="prStep">Step 2 of 2</p>' +
      '<h2>Rate your experience</h2>' +
      '<div class="reviewChatForm">' +
      '<fieldset class="reviewRatingField">' +
      '<legend class="srOnly">Your rating</legend>' +
      '<div class="reviewStars" role="radiogroup" aria-label="Your rating">' +
      LEVELS.map(function (l) {
        return '<button type="button" class="reviewStar" data-star="' + l.n + '" role="radio" aria-checked="false" aria-label="' + esc(l.label) + ', ' + l.n + ' star' + (l.n > 1 ? "s" : "") + '"><span aria-hidden="true">' + l.emoji + '</span><small>' + esc(l.label) + '</small></button>';
      }).join("") +
      '</div>' +
      '</fieldset>' +
      '<label class="reviewInputLabel" for="prDiscoveryReviewText">Tell us more</label>' +
      '<div class="reviewChatInputRow">' +
      '<textarea id="prDiscoveryReviewText" class="reviewChatInput" maxlength="300" rows="3" placeholder="Write your review\u2026"></textarea>' +
      '<button type="button" class="reviewSendBtn" id="prDiscoverySubmit">Submit review</button>' +
      '</div>' +
      '<div class="reviewNote muted small" id="prDiscoveryNote"></div>' +
      '</div>';
    var stars = box.querySelectorAll(".reviewStar");
    stars.forEach(function (s) {
      s.addEventListener("click", function () {
        rating = Number(s.dataset.star);
        stars.forEach(function (b) {
          var on = Number(b.dataset.star) === rating;
          b.classList.toggle("on", on);
          b.setAttribute("aria-checked", String(on));
        });
      });
    });
    box.querySelector("#prDiscoverySubmit").addEventListener("click", async function () {
      if (busy) return;
      var note = box.querySelector("#prDiscoveryNote");
      var text = (box.querySelector("#prDiscoveryReviewText").value || "").trim();
      if (!rating) { note.textContent = "Please pick a rating first."; return; }
      if (text.length < 2) { note.textContent = "Please write a few words."; return; }
      busy = true;
      var send = box.querySelector("#prDiscoverySubmit");
      send.disabled = true;
      note.textContent = "Sending\u2026";
      var id = ids();
      try {
        await post("reviews", {
          deviceId: id.deviceId,
          customerId: id.customerId,
          name: displayName(id.customerId),
          rating: rating,
          text: text.slice(0, 300),
          source: sourceLabel,
          sourceOther: sourceOther || "",
          ts: Date.now()
        });
        markDone();
        note.textContent = "";
        box.innerHTML = '<p class="prThanks">Thanks for your review!</p>';
        setTimeout(close, 1200);
      } catch (e) {
        note.textContent = "Could not send your review. Please try again.";
        busy = false;
        send.disabled = false;
      }
    });
  }

  function close() {
    if (root) { root.remove(); root = null; }
    document.body.style.overflow = "";
  }

  function open() {
    if (done() || root || step) return;
    build();
    renderStep1();
  }

  window.addEventListener("pr:photo-created", open);
  window.addEventListener("storage", function (e) {
    if (e.key === ANSWER_KEY && e.newValue === "1") close();
  });
})();
