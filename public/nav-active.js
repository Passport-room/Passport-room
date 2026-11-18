/* Active page link inside a rounded liquid-glass container.
 *
 * One small element is positioned behind the current page's link. It is
 * placed with transform + width only (never top/left) and repositioned once
 * per layout change, so scrolling and resizing never trigger a layout loop.
 * The page's existing aria-current="page" link wins; otherwise the URL is
 * matched, and the nearest section link (e.g. /documents for a country page)
 * is used as a fallback.
 */
(function () {
  var nav = document.querySelector('.pgNavLinks');
  if (!nav) return;

  var links = [].slice.call(nav.querySelectorAll('a'));
  if (!links.length) return;

  var pill = document.createElement('span');
  pill.className = 'pgNavPill';
  pill.setAttribute('aria-hidden', 'true');
  nav.insertBefore(pill, nav.firstChild);

  function pathOf(a) {
    try {
      var p = new URL(a.href, location.origin).pathname.replace(/\/index\.html$/, '');
      return p.replace(/\/+$/, '') || '/';
    } catch (e) {
      return '';
    }
  }

  var here = location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '') || '/';

  var active = links.filter(function (a) {
    return a.getAttribute('aria-current') === 'page';
  })[0];

  if (!active) {
    active = links.filter(function (a) {
      return pathOf(a) === here;
    })[0];
  }
  if (!active) {
    links.forEach(function (a) {
      var p = pathOf(a);
      if (p === '/' || p === '') return;
      if (here === p || here.indexOf(p + '/') === 0) {
        if (!active || p.length > pathOf(active).length) active = a;
      }
    });
  }
  if (!active) return;
  if (!active.hasAttribute('aria-current')) active.setAttribute('aria-current', 'page');

  var frame = 0;
  function place() {
    frame = 0;
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.transform =
      'translate3d(' + active.offsetLeft + 'px,' + active.offsetTop + 'px,0)';
    pill.classList.add('pgNavPillIn');
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(place);
  }

  schedule();
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.addEventListener('pageshow', schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  if (window.ResizeObserver) {
    new ResizeObserver(schedule).observe(nav);
  }
})();
