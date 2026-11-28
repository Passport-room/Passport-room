/* Monetag Direct Link: open only when a visitor intentionally starts a download. */
(function () {
  const directLink = 'https://uplcm.com/4/12374644';
  document.addEventListener('click', function (event) {
    if (!event.isTrusted) return;
    const link = event.target && event.target.closest ? event.target.closest('a[download]') : null;
    if (!link) return;
    // Keep the original download intact; open the advertiser landing page separately.
    window.open(directLink, '_blank', 'noopener,noreferrer');
  }, true);
})();
