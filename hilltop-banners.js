/* Original HilltopAds home-page publisher zone; mount only visible placements. */
(function () {
  const NETWORK_URL = 'https://peacefulbicycle.com/b/X/V.sxd/GNlT0/YFWyce/Eevmi9fuOZQUHlrkgPFTlcf0ROiT/Yg2/NWD/E/t/NuzCQ/5BN/j/Y/0WNqQo';
  const slots = Array.from(document.querySelectorAll('[data-hilltop-banner]'));
  function mount(slot) {
    if (slot.dataset.bannerMounted || !slot.getClientRects().length || slot.clientWidth < 20) return;
    if (document.body.classList.contains('is-pro')) return;
    slot.dataset.bannerMounted = 'loading';
    // Isolate each zone so hidden placements do not compete for one document.
    // Same-origin, unsandboxed frame preserves the network's actual integration.
    const frame = document.createElement('iframe');
    frame.title = 'HilltopAds advertisement';
    frame.className = 'pr-banner-frame';
    frame.scrolling = 'no';
    frame.setAttribute('aria-label', 'Advertisement');
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (doc?.body.dataset.networkError === '1') {
        slot.dataset.bannerMounted = 'unavailable';
        slot.closest('.pr-ad')?.classList.add('pr-banner-unavailable');
      }
      const script = doc?.querySelector('script[src]');
      script?.addEventListener('error', () => {
        slot.dataset.bannerMounted = 'unavailable';
        slot.closest('.pr-ad')?.classList.add('pr-banner-unavailable');
      });
    });
    frame.srcdoc = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;width:100%;overflow:hidden}body{display:flex;justify-content:center;align-items:center;min-height:90px}iframe,img{max-width:100%}</style></head><body><script>(function(sswmepg){var d=document,s=d.createElement("script"),l=d.currentScript||d.scripts[d.scripts.length-1];s.settings=sswmepg||{};s.src=' + JSON.stringify(NETWORK_URL) + ';s.async=true;s.onerror=function(){d.body.dataset.networkError="1";};s.referrerPolicy="no-referrer-when-downgrade";l.parentNode.insertBefore(s,l);})({})<\/script></body></html>';
    slot.appendChild(frame);
    frame.addEventListener('load', () => {
      if (slot.dataset.bannerMounted !== 'unavailable') slot.dataset.bannerMounted = 'requested';
      const doc = frame.contentDocument;
      if (!doc) return;
      const resize = () => {
        const creatives = Array.from(doc.querySelectorAll('body > :not(script)'));
        const height = Math.max(90, ...creatives.map(node => node.getBoundingClientRect().height));
        frame.style.height = Math.ceil(height) + 'px';
      };
      new MutationObserver(resize).observe(doc.body, { childList: true, subtree: true, attributes: true });
      new ResizeObserver(resize).observe(doc.body);
      resize();
    });
  }
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) mount(entry.target);
  }));
  slots.forEach(slot => observer.observe(slot));
  const scan = () => slots.forEach(mount);
  window.addEventListener('pr:banner-visible', scan);
  window.addEventListener('pr:phase', () => requestAnimationFrame(scan));
  new MutationObserver(scan).observe(document.getElementById('app') || document.body, {
    subtree: true, attributes: true, attributeFilter: ['class']
  });
})();