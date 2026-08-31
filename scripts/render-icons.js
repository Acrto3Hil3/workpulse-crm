// Renders the WorkPulse icon set from the SVG mark, at exact pixel sizes, via Chromium.
const { chromium } = require('playwright-core');
const path = require('path');

const OUT = require('path').join(__dirname, '..', 'public', 'icons');

const MARK = `<rect width="64" height="64" rx="15" fill="#2456d6"/>
  <path d="M10 25l6.5 19 6.5-13 6.5 19 7-29 5.5 13h5" fill="none" stroke="#fff"
        stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="52" cy="34" r="4" fill="#7ee2a8"/>`;

// Android maskable: art must sit inside the middle 80% (safe zone), full-bleed background.
const MASKABLE = `<rect width="64" height="64" fill="#2456d6"/>
  <g transform="translate(32 32) scale(.74) translate(-32 -32)">
    <path d="M10 25l6.5 19 6.5-13 6.5 19 7-29 5.5 13h5" fill="none" stroke="#fff"
          stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="52" cy="34" r="4" fill="#7ee2a8"/>
  </g>`;

// Small sizes: thicker stroke and a slightly larger dot so it survives at 32px and below.
const SMALL = `<rect width="64" height="64" rx="14" fill="#2456d6"/>
  <path d="M10 25l6.5 19 6.5-13 6.5 19 7-29 5.5 13h5" fill="none" stroke="#fff"
        stroke-width="6.4" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="52.5" cy="34" r="4.6" fill="#7ee2a8"/>`;

const JOBS = [
  { file: 'icon-192.png', size: 192, art: MARK },
  { file: 'icon-512.png', size: 512, art: MARK },
  { file: 'icon-maskable-512.png', size: 512, art: MASKABLE },
  { file: 'apple-touch-icon.png', size: 180, art: MARK },
  { file: 'favicon-32.png', size: 32, art: SMALL },
  { file: 'favicon-16.png', size: 16, art: SMALL }
];

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
  for (const job of JOBS) {
    const page = await browser.newPage({ viewport: { width: job.size, height: job.size } });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${job.size}" height="${job.size}">${job.art}</svg>`,
      { waitUntil: 'load' }
    );
    await page.screenshot({ path: path.join(OUT, job.file), omitBackground: true });
    await page.close();
    console.log(`  ${job.file}  ${job.size}x${job.size}`);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
