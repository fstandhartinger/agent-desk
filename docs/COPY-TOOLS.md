# Explainer copy controls

The loaded explainer's title bars, fullscreen player and recent-explainer rows show a compact card chip when the
page publishes `card.json` with a positive integer `card_id`. Both browser and gateway bypass caches for this file. Clicking it copies `Karte <number>` and confirms with
`kopiert`. Older recent entries look up the card when the picker opens; no page-listing endpoint is introduced.

The camera control and unmodified **C** key copy the current scene's final PNG. The narration clock selects the
scene, including a boundary and the very end of the video. Copying does not seek or pause the live player. Typing
and text selection leave C to the browser. C also works while focus is in the animation iframe. The adjacent copy control copies the scene's title and narration.

The publisher supplies `metadata.json` with `scenes: [{id,start,end,endFrame,text}]`, where `endFrame` is exactly
`end-frames/000.png` through `end-frames/999.png`. The gateway proxies these named public files under its normal
login gate; context.json and deepdive.md remain private. No credential is sent to the public player. Missing metadata
reports that the end frame is not available. Missing/denied image clipboard support downloads the same PNG.

`ClipboardItem` receives a promise immediately in the click/key event, so loading the PNG does not lose user
activation. The response must have a PNG signature. A successful write is verified by the browser regression via
`navigator.clipboard.read()` and `createImageBitmap`; it checks desktop and phone widths, C, typing, recent chips,
fullscreen feedback, and download fallback without calling production inference services.

Validation: `npm run build`, `npm test` in web; `node --test test/explainer.test.js` in gateway. On LeChonk, run
`node scripts/test-copy-tools.mjs <evidence-directory>` from web (Playwright in `/srv/heavy/tools/pw`).
