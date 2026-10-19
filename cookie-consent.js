/* Passport Room cookie consent banner (Google Consent Mode v2) */
(function () {
  var KEY = "pr_cookie_consent";
  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function apply(v) {
    window.dispatchEvent(new CustomEvent("pr:consent", { detail: v }));
    var g = v === "accepted" ? "granted" : "denied";
    if (typeof gtag === "function") {
      gtag("consent", "update", { ad_storage: g, ad_user_data: g, ad_personalization: g, analytics_storage: g });
    }
    (window.adsbygoogle = window.adsbygoogle || []).requestNonPersonalizedAds = v === "accepted" ? 0 : 1;
  }
  var css = "#prCookie{position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:560px;margin:0 auto;background:#111827;color:#f9fafb;border-radius:14px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.35);font:14px/1.5 Inter,system-ui,sans-serif}#prCookie p{margin:0 0 12px}#prCookie a{color:#93c5fd;text-decoration:underline}#prCookie .b{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}#prCookie button{border:0;border-radius:10px;padding:9px 16px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}#prCookie .r{background:#374151;color:#f9fafb}#prCookie .a{background:#3b82f6;color:#fff}.prCookieLink{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit}";
  function show() {
    if (document.getElementById("prCookie")) return;
    var d = document.createElement("div");
    d.id = "prCookie"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Cookie consent");
    d.innerHTML = '<p>We use essential storage to keep the site working. If you accept, Firebase assigns a persistent visitor ID to recognise this browser; a random name and visit counts are stored on your device. This is not complete anonymity. Google and its partners may use cookies to personalise ads. Your photos never leave your device. See our <a href="/privacy-policy">Privacy Policy</a>.</p><div class="b"><button class="r" type="button">Reject</button><button class="a" type="button">Accept all</button></div>';
    d.querySelector(".a").onclick = function () { set("accepted"); apply("accepted"); d.remove(); };
    d.querySelector(".r").onclick = function () { set("rejected"); apply("rejected"); d.remove(); };
    document.body.appendChild(d);
  }
  function init() {
    var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    var foot = document.querySelector(".pgFooter nav, .siteFooter nav, .siteFooter, .pgFooter");
    if (foot) {
      var l = document.createElement("button"); l.type = "button"; l.className = "prCookieLink"; l.textContent = "Cookie settings";
      l.onclick = show; foot.appendChild(l);
    }
    if (!get()) show();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
