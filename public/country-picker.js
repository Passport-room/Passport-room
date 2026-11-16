/* Passport Room — searchable country size picker for the editor (wraps #specSelect). */
(function () {
  function init() {
    var sel = document.getElementById("specSelect");
    var rows = window.PR_COUNTRIES;
    if (!sel || !rows || document.getElementById("prPick")) return;
    if (!sel.options.length) return void setTimeout(init, 300);

    var css = document.createElement("style");
    css.textContent =
      ".prPick{position:relative;margin-top:4px}.prPickBtn{width:100%;display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;border:1px solid rgba(168,85,247,.45);background:rgba(124,58,237,.12);color:inherit;font:inherit;font-size:14px;text-align:left;cursor:pointer}" +
      ".prPickBtn:after{content:'▾';margin-left:auto;opacity:.7}.prPickPanel{position:absolute;z-index:60;left:0;right:0;top:calc(100% + 6px);background:rgba(18,10,32,.97);border:1px solid rgba(168,85,247,.45);border-radius:14px;box-shadow:0 18px 40px rgba(0,0,0,.55);overflow:hidden;backdrop-filter:blur(12px)}" +
      ".prPickPanel[hidden]{display:none}.prPickSearch{width:100%;box-sizing:border-box;padding:11px 12px;border:0;border-bottom:1px solid rgba(168,85,247,.3);background:transparent;color:inherit;font:inherit;font-size:14px;outline:none}" +
      ".prPickList{max-height:320px;overflow:auto;padding:4px}.prPickHead{font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6;padding:8px 10px 4px}" +
      ".prPickItem{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;cursor:pointer;font-size:13.5px}.prPickItem:hover,.prPickItem.on{background:rgba(124,58,237,.25)}" +
      ".prPickItem .f{font-size:18px;width:22px;text-align:center}.prPickItem .s{margin-left:auto;opacity:.7;font-size:12px;white-space:nowrap}.prPickItem a{color:#c4b5fd;font-size:12px;text-decoration:none;padding:2px 4px}.prPickEmpty{padding:14px;opacity:.7;font-size:13px}";
    document.head.appendChild(css);

    var wrap = document.createElement("div");
    wrap.className = "prPick";
    wrap.id = "prPick";
    wrap.innerHTML =
      '<button type="button" class="prPickBtn" aria-haspopup="listbox"><span class="f">🌍</span><span class="t"></span></button>' +
      '<div class="prPickPanel" hidden><input class="prPickSearch" type="search" placeholder="Search 195 countries or size (e.g. Japan, 35x45)" aria-label="Search country or size"><div class="prPickList" role="listbox"></div></div>';
    sel.parentNode.insertBefore(wrap, sel);
    sel.style.display = "none";
    var btn = wrap.querySelector(".prPickBtn"), panel = wrap.querySelector(".prPickPanel"),
      q = wrap.querySelector(".prPickSearch"), list = wrap.querySelector(".prPickList");
    var label = "";

    function setLabel(flag, text) { btn.querySelector(".f").textContent = flag; btn.querySelector(".t").textContent = text; }
    function syncFromSelect() {
      if (label) return;
      var o = sel.options[sel.selectedIndex];
      setLabel("📐", o ? o.textContent : "Choose size");
    }
    syncFromSelect();
    sel.addEventListener("change", function () { label = ""; syncFromSelect(); });

    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function render() {
      var term = q.value.trim().toLowerCase().replace(/×/g, "x").replace(/\s+/g, " ");
      var h = "", n = 0;
      var builtin = [].slice.call(sel.options).filter(function (o) { return o.value !== "__custom__"; });
      var b = builtin.filter(function (o) { return !term || o.textContent.toLowerCase().replace(/×/g, "x").indexOf(term) > -1; });
      if (b.length) {
        h += '<div class="prPickHead">Built-in presets</div>';
        b.forEach(function (o) { n++; h += '<div class="prPickItem" data-v="' + esc(o.value) + '"><span class="f">⭐</span><span>' + esc(o.textContent) + "</span></div>"; });
      }
      var c = rows.filter(function (r) {
        return !term || (r[0] + " " + r[1] + " " + r[2] + "x" + r[3] + " " + r[2] + "x" + r[3] + "mm").toLowerCase().indexOf(term) > -1;
      });
      if (c.length) {
        h += '<div class="prPickHead">All countries — passport photo</div>';
        c.forEach(function (r) {
          n++;
          h += '<div class="prPickItem" data-c="' + esc(r[1]) + '"><span class="f">' + window.PR_FLAG(r[1]) + "</span><span>" + esc(r[0]) +
            '</span><span class="s">' + r[2] + "×" + r[3] + ' mm</span><a href="' + esc(window.PR_LINK(r)) + '" target="_blank" rel="noopener nofollow" title="Official requirements">ⓘ</a></div>';
        });
      }
      h += '<div class="prPickHead">Other</div><div class="prPickItem" data-v="__custom__"><span class="f">✏️</span><span>Custom size (mm)…</span></div>';
      if (!n && term) h = '<div class="prPickEmpty">No match for “' + esc(q.value) + '”. Use a custom size below.</div>' + h.slice(h.indexOf('<div class="prPickHead">Other'));
      list.innerHTML = h;
    }
    function open(v) { panel.hidden = !v; if (v) { q.value = ""; render(); setTimeout(function () { q.focus(); }, 30); } }
    btn.addEventListener("click", function () { open(panel.hidden); });
    q.addEventListener("input", render);
    q.addEventListener("keydown", function (e) {
      if (e.key === "Escape") open(false);
      if (e.key === "Enter") { var f = list.querySelector(".prPickItem"); f && f.click(); }
    });
    document.addEventListener("click", function (e) { if (!wrap.contains(e.target)) open(false); });
    list.addEventListener("click", function (e) {
      if (e.target.closest("a")) return;
      var it = e.target.closest(".prPickItem");
      if (!it) return;
      if (it.dataset.v) {
        label = "";
        sel.value = it.dataset.v;
        sel.dispatchEvent(new Event("change"));
      } else {
        var r = rows.find(function (x) { return x[1] === it.dataset.c; });
        var w = document.getElementById("mainCustomW"), h = document.getElementById("mainCustomH"), ap = document.getElementById("mainCustomApply");
        if (r && w && h && ap) {
          w.value = r[2]; h.value = r[3]; ap.click();
          label = r[0];
          setLabel(window.PR_FLAG(r[1]), r[0] + " passport · " + r[2] + "×" + r[3] + " mm · " + r[4] + " background");
        }
      }
      open(false);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
