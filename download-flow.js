/* The photo Blob stays on-device. Advertising never controls the download. */
(function () {
  const AD_URL = 'https://affectionatestorage.com/uC8nGv';
  const modal = document.getElementById('downloadModal');
  const confirm = document.getElementById('prDownloadConfirm');
  const closeButton = document.getElementById('prDownloadClose');
  const status = document.getElementById('prDownloadStatus');
  if (!modal || !confirm || !closeButton || !status) return;
  let pending = null;
  let previousFocus = null;
  let previousOverflow = '';
  let background = [];
  function close() {
    modal.classList.add('hidden');
    pending = null;
    document.body.style.overflow = previousOverflow;
    background.forEach(([element, wasInert]) => { element.inert = wasInert; });
    background = [];
    previousFocus?.focus?.();
    return true;
  }
  window.__prCloseDownload = close;
  window.__prQueueDownload = function (blob, filename, onDownloaded) {
    if (!(blob instanceof Blob) || !blob.size) return;
    if (modal.classList.contains('hidden')) {
      previousFocus = document.activeElement;
      previousOverflow = document.body.style.overflow;
      // Prevent focus from escaping the dialog, including into ad frames.
      const app = document.getElementById('app');
      background = Array.from((app || document.body).children)
        .filter(element => element !== modal && !element.contains(modal))
        .map(element => [element, element.inert]);
      background.forEach(([element]) => { element.inert = true; });
    }
    pending = { blob, filename, onDownloaded };
    status.textContent = '';
    confirm.disabled = false;
    document.body.style.overflow = 'hidden';
    modal.classList.remove('hidden');
    confirm.focus();
    window.dispatchEvent(new CustomEvent('pr:banner-visible'));
  };
  confirm.addEventListener('click', function () {
    if (!pending || confirm.disabled) return;
    const { blob, filename, onDownloaded } = pending;
    confirm.disabled = true;
    // Call synchronously within the click so browsers can permit the new tab.
    try { window.open(AD_URL, '_blank', 'noopener,noreferrer'); } catch (_) { /* blocked: continue */ }
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Safari and slow mobile devices need time to consume the Blob URL.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      close();
      try { onDownloaded?.(); } catch (_) { /* analytics must not affect export */ }
    } catch (_) {
      status.textContent = 'Your image could not be downloaded. Please try again.';
      confirm.disabled = false;
    }
  });
  closeButton.addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      (document.activeElement === confirm ? closeButton : confirm).focus();
    }
  });
})();