/* Page-link bar: hide while scrolling down, slide back down when scrolling up
   or when the page is back near the top. Runs directly from the scroll event
   (no requestAnimationFrame) so it also works when the tab is throttled. */
(function () {
  var nav = document.querySelector('.pgNav');
  if (!nav) return;

  var hidden = false;
  var lastY = window.scrollY || window.pageYOffset || 0;
  var THRESHOLD = 6;

  function render(hide) {
    if (hide === hidden) return;
    hidden = hide;
    nav.classList.toggle('pgNavHidden', hide);
  }

  function onScroll() {
    var y = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    var dy = y - lastY;
    if (y <= 64) render(false);
    else if (dy > THRESHOLD) render(true);
    else if (dy < -THRESHOLD) render(false);
    lastY = y;
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () {
    if ((window.scrollY || window.pageYOffset || 0) <= 64) render(false);
  });

  // Start in the shown state even when the page opens already scrolled.
  onScroll();
})();
