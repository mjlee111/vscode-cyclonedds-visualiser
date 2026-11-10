// Renders media/src/icon.svg to media/icon.png (256x256) with headless Chrome.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'fs';

const svg = readFileSync('media/src/icon.svg', 'utf8');
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator('svg').screenshot({ path: 'media/icon.png', omitBackground: true });
const big = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await big.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="256" height="256"', 'width="512" height="512"')}</body></html>`);
await big.locator('svg').screenshot({ path: process.argv[2] ?? 'media/src/icon-512.png', omitBackground: true });
await browser.close();
