// Interactive UI test of the webviews through the dev harness (headless Chrome).
// Requires the harness (HARNESS_URL, default http://localhost:8766) and python/dds_demo.py
// running on the same isolated domain.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'fs';

const base = process.env.HARNESS_URL ?? 'http://localhost:8766';
const shots = process.argv[2] ?? 'test-shots';
mkdirSync(shots, { recursive: true });
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  -> ${detail}`}`);
  if (!cond) fails.push(name);
};
async function open(view, args) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`${base}/view/${view}${args ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''}`);
  return page;
}

// ---- graph ------------------------------------------------------------------
{
  const p = await open('graph');
  await p.waitForFunction(() => window.__cy?.nodes('.part').length >= 3 && window.__cy.edges('.bad').length >= 2, null, { timeout: 15000 });
  const count = () => p.evaluate(() => ({ parts: window.__cy.nodes('.part').length, topics: window.__cy.nodes('.topic').length, bad: window.__cy.edges('.bad').length, edges: window.__cy.edges().length }));
  const mode = async (label) => {
    await p.click(`.seg button:has-text("${label}")`);
    await p.waitForTimeout(400);
  };
  const all = await count();
  check('graph: participants, topics and 2 mismatch edges', all.parts === 3 && all.topics === 5 && all.bad === 2, JSON.stringify(all));
  check('mismatch counter', /2\s*QoS mismatches/.test(await p.textContent('.chip')));
  await mode('Active');
  const active = await count();
  check('active hides one-sided topics', active.topics === 4, JSON.stringify(active));
  await mode('Participants');
  const pm = await count();
  check('participants mode: participant edges incl. mismatches', pm.topics === 0 && pm.edges >= 3 && pm.bad >= 1, JSON.stringify(pm));
  await mode('All topics');
  check('cycles drawn as arcs', (await p.evaluate(() => window.__cy.edges('.back').length)) >= 1);
  await p.evaluate(() => window.__cy.getElementById('t:rt/imu').emit('tap'));
  await p.waitForTimeout(200);
  const side = await p.innerText('.side-panel');
  check('topic panel explains the mismatch', /reliability: reader requests reliable, writer offers best effort/.test(side), side.slice(0, 300));
  await p.evaluate(() => window.__cy.getElementById(window.__cy.nodes('.part').filter((n) => n.data('label') === 'monitor')[0].id()).emit('tap'));
  await p.waitForTimeout(200);
  const ps = await p.innerText('.side-panel');
  check('participant panel: process, GUID, readers', /GUID/.test(ps) && /process/.test(ps) && /Readers · 3/i.test(ps), ps.slice(0, 300));
  await p.mouse.click(5, 300);
  await p.fill('input[type=search]', 'device');
  await p.waitForTimeout(700);
  const filtered = await p.evaluate(() => window.__cy.nodes('.topic').map((n) => n.data('topic')));
  check('filter by topic', filtered.join() === 'rt/device_status', filtered.join());
  await p.fill('input[type=search]', '');
  await p.waitForTimeout(600);
  await p.click('button:has-text("Filters")');
  await p.check('.popover label:has-text("Group by host") input');
  await p.waitForTimeout(400);
  check('group by host', (await p.evaluate(() => window.__cy.nodes('.hostbox').length)) === 1);
  await p.uncheck('.popover label:has-text("Group by host") input');
  check('graph no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

// ---- topic monitor ------------------------------------------------------------
{
  const p = await open('topics', { topic: 'rt/imu' });
  await p.waitForSelector('.warnbox', { timeout: 10000 });
  check('mismatch shown in topic detail', /reliability/.test(await p.innerText('.warnbox')));
  const rows = await p.locator('.scroll table.grid').last().locator('tbody tr').count();
  check('endpoint table (1 writer, 2 readers)', rows === 3, rows);
  await p.waitForFunction(() => /gyro/.test(document.querySelector('.msgtree')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  check('live sample tree', /gyro/.test((await p.textContent('.msgtree')) ?? ''));
  await p.click('summary:has-text("IDL")');
  await p.waitForFunction(() => /struct demo::Imu/.test(document.querySelector('details pre')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  check('IDL from XTypes', /double stamp;/.test(await p.textContent('details pre')), await p.textContent('details pre'));
  await p.click('td:has-text("rt/device_status")');
  await p.waitForFunction(() => (document.querySelector('select[title^="Keyed topic"]')?.options.length ?? 0) >= 4, null, { timeout: 10000 }).catch(() => undefined);
  const opts = await p.$$eval('select[title^="Keyed topic"] option', (o) => o.map((x) => x.textContent));
  check('keyed topic instance picker', opts.length === 4 && opts.some((o) => /name="base"/.test(o)), opts.join(' | '));
  await p.click('text=Monitor all');
  await p.waitForTimeout(3500);
  const hz = Number((await p.locator('tr:has(td:text-is("rt/lowstate")) td.num').nth(2).textContent()) ?? 0);
  check('rate of every topic (lowstate > 150 Hz)', hz > 150, hz);
  await p.screenshot({ path: `${shots}/e2e-dds-topics.png` });
  check('topics no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

// ---- plot -----------------------------------------------------------------------
{
  const p = await open('plot', { topic: 'rt/lowstate', field: 'motors[0].q' });
  await p.waitForTimeout(2500);
  const v1 = await p.textContent('.legend-swatch + span + span');
  await p.waitForTimeout(500);
  const v2 = await p.textContent('.legend-swatch + span + span');
  check('plot series updates', v1 && v2 && v1 !== v2, `${v1} ${v2}`);
  await p.fill('input[list="topics-dl"]', 'rt/imu');
  await p.dispatchEvent('input[list="topics-dl"]', 'change');
  await p.waitForFunction(() => document.querySelectorAll('#fields-dl option').length > 3, null, { timeout: 10000 }).catch(() => undefined);
  const fields = await p.$$eval('#fields-dl option', (o) => o.map((x) => x.value));
  check('numeric field discovery', fields.includes('gyro[0]') && fields.includes('stamp'), fields.join(','));
  check('plot no page errors', !p.errors.length, p.errors.join('\n'));
  await p.close();
}

await browser.close();
console.log(`\n${fails.length} failure(s)`);
process.exit(fails.length ? 1 : 0);
