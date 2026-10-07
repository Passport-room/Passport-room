// First-visit "free forever" banner, Hint smart link, and the HilltopAds
// VAST video ad shown on the loading screen (minimum 10 seconds).
export const AD_URL =
  "https://app.trcefy.com/sl?id=6a2050db46d3cf0d62f32aa4&pid=2&sub2=u834079&sub6=s2smartLink&sub5=s1SUBID1HERE";
const BANNER_KEY = "pr_free_banner_dismissed";
const $ = (id) => document.getElementById(id);
const safe = (fn) => { try { return fn(); } catch { return null; } };

function initBanner() {
  const banner = $("prFreeBanner");
  if (!banner || safe(() => localStorage.getItem(BANNER_KEY))) return;
  banner.classList.remove("hidden");
  $("prFreeOk")?.addEventListener("click", () => {
    safe(() => localStorage.setItem(BANNER_KEY, "1"));
    banner.classList.add("hidden");
  });
}

function initHint() {
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("#hintBtn")) safe(() => window.open(AD_URL, "_blank", "noopener"));
  }, true);
}

/* ---------- HilltopAds VAST video zone ---------- */
const VAST = {
  impression: "https://second-director.com/d.m-FVzWdXGYV_2aZbWc5d0-Pf2gFhkiS_WkQl9mNnD-Ip1qOrDsM_wuJvmwFxk-dznANB1CY_mElFkGPHS-ZJhKcL2MM_9OMPiQZRl-dTmUVVuWd_FYRZ5acbG-Ud9eNfSgZ_wiYjXkllv-dnXoQp9qM_CsZtyuZvX-ZxlybznAV_lCPDTEAFm-cHnIJJpKZ_DM1NjOMPD-YR5SOTTUh_hWNXWYJZm-ZbDcZdheN_zghhiiMjD-JljmNnDoI_3qNrGsMty-ZvmwUx5yN_GAZBjCODS-ZFyGcH3IJ_jKPLXMZNh-cP3QRRjSb_2URVlWJXn-NZJaZbDc0_mecf0glhk-Mjjk0lmmc_0olpkqMrz-0tmucv3wM_9yNzSAZBz-dDDE0FxGJ_nIRJvKaL2-VNuOPPSQZ_1SbTmUlVx-QXnYlZaab_2c5dlePfT-EhmidjWk5_pmcnUoJp5-Wrms9tuuZ_VwRx5yczG-UB9CMDSEZ_2GYHXINJ0-VLGM9NrOZ_WQ4R9SQT2-dVKWQX1YJ_CaSbUcpdZ-bfkgph2iW_VkdlSmanV-lpXqNrWst_LuavUwFx4-WzWA1BZCM_kE1FqGQHX-lJZKVLEM0_yOWPlQdRS-aTFUlVqWa_3YlZNaRbF-JdteTfWgp_aibjEk9lE-Zn3oppOqM_lsVt4uTvX-pxFyezEA1_qCRDFENF4-WHmI5JXKQ_mMpNqOUP0-RRBSLTSU0_mWeXmY9Zu-ZbUcldkeP_Tgch0iOjT-Ul4mMnjoE_",
  start: "https://second-director.com/dvmwF.zxd-GzVA2BZCW_5E0FPG2HF-kJSKWLQM9_NODPIQ1RO-DTMUwVJWm_FYkZdanbN-1dYemflgk_PiSjZkhlc-2nMo9pMqi_ZsltdumvV-uxdyFzRA5_cCGDUE9FM-iHZIwJYKX_lMvNdOXPQ-9RMSCTZUy_ZWXXZYlZb-nbVcldPeT_AgmhcinjJ-plZmDn1oj_MqDrYs5tO-TvhwhxNyW_JAmBZCDDZ-hFNGzHhIi_MKDLJMjNN-DPIQ3RNSG_MUyVZWmXU-5ZNaGbZcj_OeSfZgyhc-3jJkjlPmX_Zohpcq3rR-jtbu2vRwl_JynzNAJBZ-DD0EmFcG0_lIkJMKjL0-mNcO0PlQk_MSzT0UmVc-3XMY9ZNaS_ZczddeDf0-xhJinjRkv_am2nVoupP-SrZs1tbum_lwxxQynzl-aBbC2D5El_PGTHEImJd-WL5MpNcOU_JQ5RWSmT9-uVZWVXRY5_caGbUc9dM-SfZg2hYiX_Nk0lVmGn9-rpZqWr4s9_Qu2vdwKxQ-1zJACBSCU_pEZFbGkHp-2JWKVLdMS_aOVPlQXRN-WTtULVaWU_FY4ZWaWb1-ZdMekf1gq_QiXjlkZlV-En0oypWql_dsStauFvl-qxay3zlAN_RCFDJEtFT-WHpIaJbKE_9MENZO3Pp-ORMSlTVU4_TWXXpYFZe-Eb1cqdReF_Ng4hWimj5-XlQmmnpoq_bqHrRsBtV-Sv0wmxeym_9AuBZCUDl-kFPGTHcI0_OKTLUM4NM-jPEQ",
  error: "https://second-director.com/ddm-Ffzgd.GhViy_ckml9mynP-2pFqkrSsW_Qu9vNwDxI-1zOADBMCw_JEnFpGvHb-mJVKJLZMD_0O3PNQDRk-1TOUDVIWx_?code=",
  click: "https://second-director.com/dZmaF.zbd-GdVe2fZgW_5i0jPk2lF-knSoWpQq9_NsDtIu1vO-DxMywzJAm_FCkDdEnFN-1HYImJlKk_PMSNZOhPc-2RMS9TMUi_ZWlXdYmZV-ubdcFdRe5_cgGhUi9jM-ylZmwnYoX_lqvrdsXtQ-9vMwCxZyy_ZAWBRCpDc-mFVGjHdIF_VKyLbMDN1-oPdQHRRSw_cUyVUWzXQ-SZUaybRci_UeyfRgnhZ-pjZk2l9my_bo3pVqzrc-2thuvvdw2_VyyzLAmBN-vDbESFUGy_RImJJK5LM-1NJOWPLQj_BS5TUUGVc-zXRYHZBa0_dcidUeyfR-mhJizjbkX_VmWnboUpp-krWsntZuE_ZwzxByvzM-lBRCPDcEU_QGtHWIXJM-wLbMEN9Os_VQERZSZTT-TVVWvXTYH_daUbUcFdk-lfMgkhYi0_VkUl5mRna-mppqRrWsD_VuTvTwnxN-6zdAEB1CZ_JETFNGGHc-0JlKkLJMT_NOEPWQkR9-OTRUVV9WJ_RYCZZaybZ-XdZelfbgn_ViljPkTlA-mnconpJqp_ZsDt1ujvM-DxYy5zOAT_hChDNEWFJ-mHZIDJZKh_NMzNhOiPM-DRJSjTNUD_IW3XNYGZM-ybZcmdUe5_NgGhZijjO-SlZmynco3_JqjrPsXtZ-hvcw3xRyj_bA2BRClDJ-nFNGJHZID_0KmLcM0Nl-kPMQjR0Sm_cU0VlWkXM-zZ0ambcc3_Me9fNgShZ-zjdkDl0mx_JonpRqvra-2tVuuvPwS_Zy1zbAmBl-xDQEnFlGa_bI2J5KlLP-TNEOmPdQW_5SpTcUUVJ-5XWYmZ9au_ZcVdRe5fc-GhUi9jMkS_Zm2nYoXpN-0rVsGt9ur_ZwWx4y9zQ-2BdCKDQE1_JGCHSIUJp-ZLbMkNpO2_WQVRdSSTa-VVlWXXNYW_taLbacUdF-4fWgWh1iZ_Mkkl1mqnQ-XplqZrVsE_0uyvWwlxd-SzaAFBlCq_aE3FlGNHR-FJJKtLTMW_pOaPbQER9-ETZU3VpWO_MYlZVa4bT-XdpeFfegE_1iqjRkFlN-4nWomp5qX_QsmtpupvO-DxNyRzVAS_0CmDeEmF9-uHZIUJlKk_PMTNcO0PO-TRUS4TMUj_EW",
  base: "https://www.silent-basis.pro/152327/199275/425826_abc27y",
};
const MIN_MS = 10000;
let startedAt = 0;
let failed = false;
const ping = (url) => safe(() => { new Image().src = url; });

function pickSources(video) {
  const w = window.innerWidth || 640;
  const tier = w >= 1000 ? "" : w >= 600 ? "480" : "360";
  const webm = video.canPlayType('video/webm; codecs="vp9"');
  return [webm ? `${VAST.base}${tier}.webm` : null, `${VAST.base}${tier}.mp4`].filter(Boolean);
}

function initVideoAd() {
  const box = $("prVideoAd");
  const video = $("prVideoAdEl");
  const link = $("prVideoAdClick");
  if (!box || !video || !link) return;
  link.href = VAST.click;

  // Remaining ms the loading screen must stay visible for the ad.
  window.__prVideoAdHold = () => {
    if (!startedAt || failed || document.body.classList.contains("is-pro")) return 0;
    return Math.max(0, MIN_MS - (Date.now() - startedAt));
  };

  const start = () => {
    if (document.body.classList.contains("is-pro")) return;
    failed = false;
    startedAt = Date.now();
    box.classList.remove("hidden");
    if (!video.dataset.loaded) {
      video.dataset.loaded = "1";
      for (const src of pickSources(video)) {
        const s = document.createElement("source");
        s.src = src;
        s.type = src.endsWith(".webm") ? "video/webm" : "video/mp4";
        video.appendChild(s);
      }
      video.addEventListener("playing", () => {
        if (video.dataset.counted) return;
        video.dataset.counted = "1";
        ping(VAST.impression);
        ping(VAST.start);
      });
      video.addEventListener("error", () => fail(400), true);
      video.load();
    } else {
      safe(() => { video.currentTime = 0; });
    }
    video.muted = true;
    const pr = safe(() => video.play());
    pr?.catch?.(() => {});
  };
  const fail = (code) => {
    if (failed) return;
    failed = true;
    ping(VAST.error + code);
    box.classList.add("hidden");
  };
  const stop = () => {
    startedAt = 0;
    safe(() => video.pause());
    box.classList.add("hidden");
  };

  window.addEventListener("pr:phase", (e) => (e.detail === "processing" ? start() : stop()));
}

function boot() { initBanner(); initHint(); initVideoAd(); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
