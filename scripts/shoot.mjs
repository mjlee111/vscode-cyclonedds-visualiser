// Screenshots harness views with headless Chrome (dev/test aid).
//   node scripts/shoot.mjs <outDir> <view>[:<argsJson>][@<waitMs>] ...
// Requires the harness running on HARNESS_URL (default http://localhost:8765).
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'fs';

const base = process.env.HARNESS_URL ?? 'http://localhost:8765';
const [outDir, ...specs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
let failed = 0;
for (const spec of specs) {
  const m = /^(\w+)(?::(.*?))?(?:@(\d+))?(?:#(\w+))?$/.exec(spec);
  if (!m) continue;
  const [, view, args, wait, tag] = m;
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/favicon|404/.test(msg.text() + (msg.location()?.url ?? ''))) errors.push(msg.text());
  });
  const q = args ? `?args=${encodeURIComponent(args)}` : '';
  await page.goto(`${base}/view/${view}${q}`);
  await page.waitForTimeout(Number(wait ?? 3000));
  const file = `${outDir}/${view}${tag ? '-' + tag : ''}.png`;
  await page.screenshot({ path: file });
  console.log(`${errors.length ? 'ERR ' : 'OK  '} ${file}${errors.length ? '\n     ' + errors.join('\n     ') : ''}`);
  if (errors.length) failed++;
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
