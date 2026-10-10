// One post-download controller for photo and print-sheet exports.
const SKIP_AFTER_MS = 5000;
export function remainingSkipSeconds(startedAt, now) {
  return Math.max(0, Math.ceil((SKIP_AFTER_MS - (now - startedAt)) / 1000));
}

function boot() {
  const modal = document.getElementById('downloadModal');
  const video = document.getElementById('prDownloadVideo');
  const skip = document.getElementById('prDownloadSkip');
  const home = document.getElementById('modalHome');
  const status = document.getElementById('prDownloadStatus');
  if (!modal || !video || !skip || !home || !status) return;
  let startedAt = 0;
  let timer;
  let previousFocus;
  let unavailable = false;
  const update = () => {
    const seconds = remainingSkipSeconds(startedAt, performance.now());
    skip.disabled = seconds > 0;
    home.disabled = seconds > 0;
    skip.textContent = seconds ? `Skip · ${seconds}s` : 'Skip';
    status.textContent = seconds ? `${unavailable ? 'Video unavailable. ' : ''}Skip available in ${seconds} second${seconds === 1 ? '' : 's'}` : (unavailable ? 'Video unavailable' : '');
    if (!seconds) clearInterval(timer);
  };
  const close = () => {
    if (modal.classList.contains('hidden') || remainingSkipSeconds(startedAt, performance.now()) > 0) return false;
    clearInterval(timer);
    video.pause();
    modal.classList.add('hidden');
    previousFocus?.focus?.();
    return true;
  };
  window.__prCloseDownload = close;
  skip.addEventListener('click', close);
  video.addEventListener('error', () => { unavailable = true; update(); });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (!skip.disabled) (document.activeElement === skip ? home : skip).focus();
    }
  });
  window.addEventListener('pr:download', () => {
    clearInterval(timer);
    previousFocus = document.activeElement;
    startedAt = performance.now();
    unavailable = false;
    modal.classList.remove('hidden');
    modal.tabIndex = -1;
    modal.focus();
    update();
    timer = setInterval(update, 100);
    // Use the supplied HilltopAds creative. No click-through overlay or redirects.
    if (!video.src) video.src = 'https://www.silent-basis.pro/152327/199275/425826_abc27y360.mp4';
    video.currentTime = 0;
    video.muted = true;
    video.play()?.catch(() => { unavailable = true; update(); });
  });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
