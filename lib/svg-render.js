'use strict';

// Extracted from api.js, where it was only reachable via its own HTTP routes
// (/render/svg-token GET/POST). Needed directly, in-process, by
// lib/images.js's extractPngFromSvg when that code runs WITHIN the API
// service's own process (confirmed live: the metadata-update poller's
// catch-up scan, triggered via an API-service endpoint, tried to call back
// out to itself over HTTP using RAILWAY_API_URL — a URL that was never
// configured for that direction, since the API service never previously
// needed to know its own address). Sharp/libvips still never runs in the
// long-lived bot process (the original reason this moved to the API service
// at all — accumulated native memory there caused real OOM crashes after
// several hours) — this module is only ever require()'d from within the API
// service's own process, never from bot.js.
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(2);

async function renderSvgTextToPng(svgText, size = 500){
  const SIZE = size;
  const bgBuf = await sharp(Buffer.from(svgText))
    .resize(SIZE, SIZE, { kernel: 'nearest', fit: 'fill' })
    .png()
    .toBuffer();

  // Extract embedded character PNG and composite, same as original extractPngFromSvg
  const pngMatch = svgText.match(/src=["']data:image\/png;base64,([A-Za-z0-9+/=\s]+)["']/);
  let finalBuf = bgBuf;
  if (pngMatch) {
    try {
      const rawPng = Buffer.from(pngMatch[1].replace(/\s/g, ''), 'base64');
      const charBuf = await sharp(rawPng).resize(SIZE, SIZE, { kernel: 'nearest' }).png().toBuffer();
      finalBuf = await sharp(bgBuf).composite([{ input: charBuf, blend: 'over' }]).png().toBuffer();
    } catch (e) {
      console.warn('[svg-render] char composite failed, using full SVG render:', e.message);
    }
  }
  return finalBuf;
}

module.exports = { renderSvgTextToPng };
