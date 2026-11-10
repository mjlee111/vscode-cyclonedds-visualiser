// Captures README screenshots from the dev harness (python/dds_demo.py must be running).
//   node scripts/screenshots.mjs [outDir=media/screenshots] [name ...]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'fs';

const base = process.env.HARNESS_URL ?? 'http://localhost:8766';
const out = process.argv[2] ?? 'media/screenshots';
const only = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

async function shot(name, view, args, prepare) {
  if (only.length && !only.includes(name)) return;
  const page = await ctx.newPage();
  await page.goto(`${base}/view/${view}${args ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''}`);
  await page.waitForTimeout(2500);
  if (prepare) await prepare(page);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
  await page.close();
}

await shot('graph', 'graph', null, async (p) => {
  await p.waitForFunction(() => window.__cy?.edges('.bad').length >= 2);
  await p.evaluate(() => window.__cy.getElementById('t:rt/imu').emit('tap'));
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    window.__cy.resize();
    window.__cy.fit(undefined, 40);
  });
  await p.waitForTimeout(300);
});
await shot('topics', 'topics', { topic: 'rt/imu' }, async (p) => {
  await p.click('text=Monitor all');
  await p.waitForTimeout(3500);
});
await shot('keyed', 'topics', { topic: 'rt/device_status' }, async (p) => {
  await p.click('summary:has-text("IDL")');
  await p.waitForTimeout(2000);
});
await shot('plot', 'plot', { topic: 'rt/lowstate', field: 'motors[0].q' }, async (p) => {
  for (const f of ['motors[1].q', 'motors[0].tau']) {
    await p.fill('input[list="topics-dl"]', 'rt/lowstate');
    await p.fill('input[list="fields-dl"]', f);
    await p.click('text=+ Add');
  }
  await p.selectOption('select[title="Time window"]', '10');
  await p.waitForTimeout(9000);
});
await browser.close();
