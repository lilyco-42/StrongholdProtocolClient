// Drive tools/art-probe.html through real browser engines and compare them.
//
// The question this answers (docs/IOS-ART.md): do the art files inside a *shipped* payload load in WebKit the
// way they load in Chromium? If WebKit fails somewhere Chromium passes, the iPhone report 「ipa 没有立绘，只显示
// 了干员头像」 is reproduced without an iPhone. If both pass, the payload and the engine are innocent and the
// remaining suspects are the device (its scheme handler, its memory) — which is a different fix.
//
//   npm i -D playwright && npx playwright install --with-deps chromium webkit
//   node tools/art-probe-check.mjs --root stage/web --out art-probe
//
// Exit codes, because a check nobody can distinguish from a pass is not a check:
//   0  WebKit behaves exactly like Chromium on every case (and the negative control failed as it must)
//   1  REPRODUCED — WebKit failed at least one case Chromium passed; the failing URLs are printed
//   2  the probe itself is not load-bearing (a control did not behave, an engine crashed, the tree 404s)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtCases, readManifests, startProbeServer } from './art-probe.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const root = path.resolve(arg('--root', process.cwd()));
const outDir = path.resolve(arg('--out', 'art-probe'));
const perGroup = Number(arg('--per-group', 2));
const engines = (arg('--engines', 'chromium,webkit')).split(',').filter(Boolean);
const WAIT_MS = Number(arg('--wait-ms', 420000));

if (!fs.existsSync(path.join(root, 'data', 'assets.json'))) {
  console.error(`[art-probe-check] ${root}: no data/assets.json — extract a payload/ipa web root first (see the workflow)`);
  process.exit(2);
}

let pw;
try {
  pw = await import('playwright');
} catch {
  console.error('[art-probe-check] needs Playwright: npm i -D playwright && npx playwright install --with-deps chromium webkit');
  process.exit(2);
}

const cases = buildArtCases(readManifests(root), { perGroup });
const groups = new Set(cases.map((c) => c.group));
console.log(`[art-probe-check] ${cases.length} cases in ${groups.size} groups, root=${root}`);

const server = await startProbeServer({
  root,
  probeHtml: path.join(path.dirname(fileURLToPath(import.meta.url)), 'art-probe.html'),
  cases,
});

async function runEngine(name) {
  const browser = await pw[name].launch(name === 'chromium'
    ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] }
    : {});
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message || e).slice(0, 200)));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const done = await page.evaluate(() => !!(window.__ART_PROBE__ && window.__ART_PROBE__.done)).catch(() => false);
      if (done) break;
      if (Date.now() > deadline) throw new Error(`timeout after ${WAIT_MS} ms waiting for the probe to finish`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const result = await page.evaluate(() => window.__ART_PROBE__);
    result.consoleErrors = consoleErrors.slice(0, 20);
    return result;
  } finally {
    await browser.close();
  }
}

const byEngine = {};
try {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of engines) {
    process.stdout.write(`[${name}] running… `);
    try {
      byEngine[name] = await runEngine(name);
    } catch (e) {
      byEngine[name] = { done: false, fatal: String(e && e.message || e), groups: {}, results: [] };
    }
    console.log(byEngine[name].fatal ? `FATAL ${byEngine[name].fatal}` : `${byEngine[name].caseCount} cases in ${byEngine[name].ms} ms`);
    fs.writeFileSync(path.join(outDir, `art-probe-${name}.json`), JSON.stringify(byEngine[name], null, 1));
  }
} finally {
  await server.close();
}

// The missing-file control is asserted on its own below, so it must not be counted as a failure of the tree.
const realGroups = (name) => Object.entries(byEngine[name].groups || {}).filter(([g]) => g !== '__control__');
const tally = (name, field) => realGroups(name).reduce((a, [, r]) => a + r[field], 0);
const total = (name) => realGroups(name).reduce((a, [, r]) => a + r.total, 0);

const head = ['engine', 'cases', 'fetch', 'eager', 'lazy', 'scrolled', 'dropped→error', 'console errors'];
const rows = engines.map((n) => {
  const r = byEngine[n];
  return [n, total(n), tally(n, 'fetch'), tally(n, 'eager'), tally(n, 'lazy'), tally(n, 'scrolled'),
    tally(n, 'droppedErrored'), (r.consoleErrors || []).length];
});
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
console.log('');
console.log(head.map((h, i) => String(h).padEnd(widths[i])).join('  '));
for (const r of rows) console.log(r.map((v, i) => String(v).padEnd(widths[i])).join('  '));
console.log('');

// 1) controls first: a probe that cannot fail is not measuring anything
for (const n of engines) {
  const r = byEngine[n];
  if (r.fatal) { console.error(`[${n}] FATAL ${r.fatal}`); process.exit(2); }
  const control = (r.results || []).find((x) => x.group === '__control__');
  if (!control) { console.error(`[${n}] the missing-file control is absent from the run`); process.exit(2); }
  if (control.eager.ok) { console.error(`[${n}] the missing-file control LOADED (${control.url}) — this run proves nothing`); process.exit(2); }
}
// 2) the reference engine must pass: if Chromium cannot load the tree, the tree/server is the problem
const ref = engines.includes('chromium') ? 'chromium' : engines[0];
const refTotal = total(ref);
const refEager = tally(ref, 'eager');
if (refEager !== refTotal) {
  console.error(`[${ref}] reference engine failed ${refTotal - refEager}/${refTotal} cases — the served tree or the probe server is broken, not WebKit`);
  for (const x of (byEngine[ref].results || []).filter((y) => !y.eager.ok).slice(0, 10)) {
    console.error(`   ${x.url} → ${x.eager.why} (fetch ${x.fetch.status} ${x.fetch.type} ${x.fetch.bytes}B)`);
  }
  process.exit(2);
}
// 3) compare every other engine against it
let reproduced = 0;
for (const n of engines) {
  if (n === ref) continue;
  for (const field of ['fetch', 'eager', 'lazy', 'scrolled']) {
    const a = tally(ref, field);
    const b = tally(n, field);
    if (a !== b) {
      console.error(`REPRODUCED: [${n}] ${field} ok=${b} but [${ref}] ${field} ok=${a} of ${refTotal}`);
      const refOk = new Map((byEngine[ref].results || []).map((x) => [x.url, x]));
      for (const x of byEngine[n].results || []) {
        if (!x[field].ok && refOk.get(x.url)?.[field]?.ok) {
          console.error(`   ${x.url}  group=${x.group} why=${x[field].why} fetch=${x.fetch.status}/${x.fetch.type}/${x.fetch.bytes}B size=${x.px}`);
        }
      }
      reproduced++;
    }
  }
}
if (reproduced) { console.error(`\nWebKit-family engine(s) differ from ${ref} on ${reproduced} measurement(s) — see the failing URLs above.`); process.exit(1); }

// 4) the mechanism, reported whether or not it is a failure
for (const n of engines) {
  const r = byEngine[n].groups?.['chars.portrait'];
  console.log(`[${n}] re-render case: of ${r ? r.total : 0} portraits whose first element was dropped mid-load, ${r ? r.droppedErrored : 0} fired an error event`);
}
console.log(`\nOK — ${ref} and ${engines.filter((n) => n !== ref).join(', ')} behave identically on all ${refTotal} art cases.`);
const written = engines.map((n) => path.join(outDir, `art-probe-${n}.json`)).join(', ');
console.log('wrote ' + written);
