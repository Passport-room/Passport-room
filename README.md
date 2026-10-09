# Passport Room — updated website

This is the complete standalone static website. Upload the contents of this folder to your existing static host. No installation or build is required. Use HTTP/HTTPS (not file://) for browser AI modules.

## Updates
- Broken video creatives, video timers, and AdSense banners removed.
- All five original ad positions use the exact HilltopAds home-page publisher zone and load only when visible.
- Single-photo and final A4 image exports show the Download Your Picture confirmation.
- Confirm opens https://affectionatestorage.com/uC8nGv in a new tab when allowed and saves the prepared image independently of popup success.
- Keyboard close, focus handling, duplicate-click protection, and mobile layouts included.
- Original AI engine, local history, outfit editor, enhancement, static information pages, reviews and external services are preserved.

## Important: live banner code required
The exact original HilltopAds URL returned HTTP 404 during testing. Layout and initialization were tested with a clearly marked simulated creative, not claimed as a live ad. Unavailable slots collapse rather than showing broken content. In HilltopAds, open your site's banner zone and copy fresh integration code; replace NETWORK_URL in hilltop-banners.js with its script URL. A valid banner zone and account/domain approval are required for live fill. No replacement publisher ID was invented.

## Verification
- Real single-photo export: passport-bd-passport.png, valid PNG bytes.
- Real A4 export: passport-A4-sheet.png, valid PNG bytes.
- Both exported after confirmation with window.open blocked.
- Normal new-tab request and independent image save checked.
- Mobile 390px popup, desktop popup, Escape and Tab focus checks passed.
- Banner desktop/mobile containment checked with a simulated network response.
- No runtime JavaScript errors in export checks; no video elements remain.

Testing used synthetic on-device canvas imagery to exercise the existing export engine; the unchanged external AI models, reviews and provider services were not fully end-to-end verified. No production records or provider settings were modified.
