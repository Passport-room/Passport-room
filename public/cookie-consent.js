/* Passport Room cookie consent banner (Google Consent Mode v2)
 *
 * Both "Accept all" and "Reject all" are offered with equal prominence, and
 * both choices are honoured:
 *   accept -> ad_storage/ad_user_data/ad_personalization/analytics_storage granted,
 *             Firebase anonymous visitor identity allowed to start.
 *   reject -> every consent signal denied, non-personalised ads only, Firebase
 *             visitor identity stopped and its local profile cleared.
 * The decision is remembered, and the footer "Cookie settings" link reopens the
 * banner so the choice can be changed or withdrawn at any time.
 */
(function () {
  var KEY = "pr_cookie_consent";
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function apply(v) {
    var granted = v === "accepted";
    var g = granted ? "granted" : "denied";
    if (typeof gtag === "function") {
      gtag("consent", "update", {
        ad_storage: g,
        ad_user_data: g,
        ad_personalization: g,
        analytics_storage: g,
      });
    }
    window.adsbygoogle = window.adsbygoogle || [];
    window.adsbygoogle.requestNonPersonalizedAds = granted ? 0 : 1;
    window.dispatchEvent(new CustomEvent("pr:consent", { detail: v }));
    if (granted) window.dispatchEvent(new CustomEvent("pr:accepted"));
    else window.dispatchEvent(new CustomEvent("pr:rejected"));
  }

  // Choosing "reject" must also undo a previous acceptance: clear the local
  // visitor profile the site created while consent was granted.
  function clearLocalProfile() {
    try {
      localStorage.removeItem("pr_anonymous_visitor_v1");
      localStorage.removeItem("pr_counted_visitor_v1");
      localStorage.removeItem("pr_counted_day_v1");
    } catch (e) {}
  }

  var css = [
    "#prCookie{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:600px;margin:0 auto;",
    "background:linear-gradient(150deg,rgba(126,82,208,0.3),rgba(46,24,84,0.78));",
    "backdrop-filter:blur(20px) saturate(150%);-webkit-backdrop-filter:blur(20px) saturate(150%);",
    "border:1px solid rgba(196,165,255,0.25);color:#f1ecff;border-radius:18px;padding:16px 18px;",
    "box-shadow:inset 0 1px 0 rgba(240,228,255,0.14),0 10px 30px rgba(0,0,0,.35);",
    "font:14px/1.5 Inter,system-ui,sans-serif}",
    "#prCookie h2{margin:0 0 8px;font:700 15px/1.35 Inter,system-ui,sans-serif;color:#f6f2ff}",
    "#prCookie p{margin:0 0 14px}",
    "#prCookie a{color:#c4b5fd;text-decoration:underline}",
    "#prCookie .prCookieActions{display:flex;gap:10px;flex-wrap:wrap}",
    "#prCookie .prCookieBtn{flex:1 1 140px;border-radius:12px;padding:11px 16px;font:600 14px Inter,system-ui,sans-serif;",
    "cursor:pointer;transition:transform .18s ease,box-shadow .18s ease,background .18s ease,border-color .18s ease}",
    "#prCookie .prCookieBtn:active{transform:translateY(1px)}",
    "#prCookie .prCookieBtn:focus-visible{outline:2px solid #d8c7ff;outline-offset:2px}",
    "#prCookie .prCookieAccept{border:1px solid transparent;color:#fff;",
    "background:linear-gradient(150deg,#7c3aed,#a855f7 55%,#c084fc);",
    "box-shadow:inset 0 1px 0 rgba(250,245,255,0.4),0 10px 30px -10px rgba(147,51,234,0.65)}",
    "#prCookie .prCookieAccept:hover{background:linear-gradient(150deg,#8b5cf6,#b06cf8 55%,#c98dfd)}",
    "#prCookie .prCookieReject{border:1px solid rgba(196,165,255,0.38);color:#f1ecff;",
    "background:rgba(167,139,250,0.16);box-shadow:inset 0 1px 0 rgba(240,228,255,0.14)}",
    "#prCookie .prCookieReject:hover{background:rgba(167,139,250,0.28);border-color:rgba(202,175,255,0.6)}",
    "#prCookie .prCookieNote{margin:12px 0 0;color:#d5cbe9;font-size:12px}",
    "@media (max-width:460px){#prCookie .prCookieActions{flex-direction:column}#prCookie .prCookieBtn{flex:1 1 auto;width:100%}}",
    ".prCookieLink{display:inline-block;margin-top:10px;background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit}",
  ].join("");

  function hide() {
    var el = document.getElementById("prCookie");
    if (el) el.remove();
  }

  function decide(v) {
    set(v);
    if (v !== "accepted") clearLocalProfile();
    apply(v);
    hide();
  }

  function show() {
    if (document.getElementById("prCookie")) return;
    var choice = get();
    var d = document.createElement("div");
    d.id = "prCookie";
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-modal", "false");
    d.setAttribute("aria-labelledby", "prCookieTitle");
    d.setAttribute("aria-describedby", "prCookieText");
    d.innerHTML =
      '<h2 id="prCookieTitle">Cookies and ads</h2>' +
      '<p id="prCookieText">We use essential storage to keep the site working. If you accept, Firebase assigns a persistent visitor ID to recognise this browser; a random name and visit counts are stored on your device. This is not complete anonymity. Google and its partners may use cookies to personalise ads. If you reject, no visitor tracking starts and ads are requested without personalisation. Your photos never leave your device. See our <a href="/privacy-policy">Privacy Policy</a>.</p>' +
      '<div class="prCookieActions">' +
      '<button class="prCookieBtn prCookieAccept" type="button">Accept all</button>' +
      '<button class="prCookieBtn prCookieReject" type="button">Reject all</button>' +
      "</div>" +
      (choice
        ? '<p class="prCookieNote">Your current choice: ' +
          (choice === "accepted" ? "accepted" : "rejected") +
          ". You can change it at any time.</p>"
        : "");
    d.querySelector(".prCookieAccept").onclick = function () { decide("accepted"); };
    d.querySelector(".prCookieReject").onclick = function () { decide("rejected"); };
    document.body.appendChild(d);
    var first = d.querySelector(".prCookieAccept");
    if (first) first.focus();
  }

  function init() {
    var st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);

    // Append under the copyright line, as the footer designs place it.
    var foot = document.querySelector(".pgFooter, .siteFooter") || document.querySelector(".pgFooter nav");
    if (foot) {
      var l = document.createElement("button");
      l.type = "button";
      l.className = "prCookieLink";
      l.textContent = "Cookie settings";
      l.onclick = show;
      foot.appendChild(l);
    }

    if (!get()) show();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
