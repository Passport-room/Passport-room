/* Resilient Firebase Realtime Database REST sender for Passport Room.
 *
 * Fixes dropped reviews on slow or unstable connections:
 *  - every request has a timeout (no more "Sending…" that hangs forever),
 *  - failed requests are retried automatically with backoff,
 *  - if every attempt fails, the payload is queued on the device and
 *    delivered automatically on the next page load / when the connection
 *    comes back — the visitor's review is never lost. */
(function () {
  var DB_URL = "https://passport-48389-default-rtdb.firebaseio.com";
  var QUEUE_KEY = "pr_firebase_queue_v1";
  var MAX_QUEUE = 25;
  var TIMEOUT_MS = 8000;
  var ATTEMPTS = 3;
  var FLUSH_ATTEMPTS = 2;

  function readQueue() {
    try {
      var list = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }
  function writeQueue(list) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-MAX_QUEUE)));
    } catch (e) { /* storage unavailable; nothing more we can do */ }
  }

  function isRetryable(err) {
    var status = err && err.status;
    if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
    return true; /* timeout, abort, DNS failure, offline, CORS hiccup… */
  }

  async function attemptOnce(path, payload, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    try {
      var res = await fetch(DB_URL + "/" + path + ".json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) {
        var err = new Error("firebase append " + path + " failed (" + res.status + ")");
        err.status = res.status;
        throw err;
      }
      var data = await res.json();
      return (data && data.name) || null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function sendNow(path, payload, attempts) {
    var last = null;
    for (var i = 0; i < attempts; i++) {
      try {
        return await attemptOnce(path, payload, TIMEOUT_MS);
      } catch (err) {
        last = err;
        if (i === attempts - 1 || !isRetryable(err)) break;
        await new Promise(function (r) { setTimeout(r, 500 * Math.pow(2, i) + Math.random() * 300); });
      }
    }
    throw last;
  }

  var flushing = false;
  async function flush() {
    if (flushing) return;
    var queue = readQueue();
    if (!queue.length) return;
    flushing = true;
    try {
      var remaining = [];
      for (var i = 0; i < queue.length; i++) {
        try {
          await sendNow(queue[i].path, queue[i].payload, FLUSH_ATTEMPTS);
        } catch (e) {
          remaining.push(queue[i]);
        }
      }
      writeQueue(remaining);
    } finally {
      flushing = false;
    }
  }

  async function send(path, payload) {
    if (!payload || typeof payload !== "object") payload = {};
    try {
      return await sendNow(path, payload, ATTEMPTS);
    } catch (err) {
      var queue = readQueue();
      queue.push({ path: path, payload: payload, ts: Date.now() });
      writeQueue(queue);
      scheduleFlush();
      return { queued: true, name: null };
    }
  }

  var flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flush(); }, 4000);
  }

  window.prSend = send;
  window.prSendFlush = flush;
  window.addEventListener("online", scheduleFlush);
  window.addEventListener("load", scheduleFlush);
  if (document.readyState !== "loading") scheduleFlush();
})();
