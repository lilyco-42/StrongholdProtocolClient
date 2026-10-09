// Drive the game repo's own /dev/spine-probe.html through real browser engines and compare them.
//
// What this adds over tools/art-probe-check.mjs (which already proved webkit ≡ chromium on *static image* loading):
// that probe loads PNGs with `<img>` and `fetch`. A player's report is about **立绘 not appearing at all, only the
// avatar**, and a portrait is a Spine skeleton — `.skel` + `.atlas` + textures handed to pixi-spine, which then needs
// a WebGL context and enough memory to hold several skeletons at once. None of that is on the static-image path, so
// an engine that passes art-probe-check can still be the place where the real thing dies. This tool runs the page
// that walks those layers, inside a served payload tree, and diffs WebKit against Chromium row by row.
//
//   npm i -D playwright && npx playwright install --with-deps chromium webkit
//   node tools/spine-probe-check.mjs --root stage/web                    # the ipa/apk web root, unpacked
//   node tools/spine-probe-check.mjs --root stage/web --ids 112,134 --many 12
//
// Same three exit codes as art-probe-check, because "the lane is green" and "the lane measured anything" are
// different claims:
//   0  WebKit's load/parse rows agree with Chromium's (the WebGL and memory rows are reported, not gated — see below)
//   1  REPRODUCED — WebKit failed a row Chromium passed; the row names are printed
//   2  the probe is not load-bearing: the page is missing from the tree, `__SPINE_PROBE__` never appeared, the
//      清单 row is bad, the negative control (a deliberately absent skeleton) did NOT fail as it must,
//      a gated row-family is absent, **or a path inside the payload 4xx'd while the page ran** (that is a missing
//      art/css/js file — the thing players report as 「立绘不见了」 — and it must not hide behind a green verdict)
//
// Why ② WebGL and ⑦ 连续加载 are not gates. Both are properties of the runner, not of the payload: headless Linux
// WebGL is a software pipeline no iPhone shares, and ⑦ pushes allocation until the engine gives up, which on a
// shared CI box depends on how much RAM the job happened to get. A gate that flips for that reason teaches everyone
// to re-run the lane instead of reading it. They are printed for every engine so a real pattern is still visible.

import fs from 'node:fs';
import path from 'node:path';
import { pageUrlOf, startProbeServer } from './art-probe.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const root = path.resolve(arg('--root', process.cwd()));
const outDir = path.resolve(arg('--out', 'spine-probe'));
const engines = (arg('--engines', 'chromium,webkit')).split(',').filter(Boolean);
const pagePath = arg('--page', '/dev/spine-probe.html');
const WAIT_MS = Number(arg('--wait-ms', 300000));
const qs = new URLSearchParams();
if (arg('--ids')) qs.set('ids', arg('--ids'));
if (arg('--many')) qs.set('many', arg('--many'));

const PAGE = path.join(root, pagePath.replace(/^\//, ''));
if (!fs.existsSync(PAGE)) {
  console.error(`[spine-probe-check] 包里找不到 ${PAGE} —— 先解一个含自检页的产物（payload ≥ c28 才有这一页）`);
  process.exit(2);
}

let pw;
try {
  pw = await import('playwright');
} catch {
  console.error('[spine-probe-check] 需要 Playwright：npm i -D playwright && npx playwright install --with-deps chromium webkit');
  process.exit(2);
}

// The page lives inside the served tree (that is the point: it must load the payload's own modules), so the probe
// server's injected copy doubles as the existence check above.
const server = await startProbeServer({ root, probeHtml: PAGE, cases: [] });
// pageUrlOf 而不是字符串拼接：`http://host:P` + `/dev/...` 拼出双斜杠时，服务端的 `new URL(req.url, base)`
// 会把它当协议相对地址（host 变成 "dev"），于是包内明明有的那一页答 404（CI 第一次跑就是这样）。
const pageUrl = pageUrlOf({ serverUrl: server.url, pagePath, query: qs.toString() });
console.log(`[spine-probe-check] ${pageUrl}  root=${root}`);

/** Rows the gate compares: everything about *getting the art and parsing it*, plus the control. */
const GATED = ['① 运行时', '③ 图片', '④ fetch .skel', '④ fetch .atlas', '⑤ acquire', '⑥ 阴性对照'];
/** Rows printed for every engine but never gated (they measure the runner, not the payload). */
const REPORT_ONLY = ['② WebGL', '⑦ 连续加载'];
/**
 * Paths that have to come out of the payload itself. A 4xx on one of these is a missing file —— which is exactly
 * what "立绘不见了" is made of —— while `/favicon.ico` and friends are the browser knocking on its own.
 */
const INTERNAL_PATH = /^\/(assets|data|js|css|vendor|fonts|webfonts|sim|packs|dev)\//;

const matches = (rows, prefixList) => rows.filter((r) => prefixList.some((p) => r.name.startsWith(p)));
const badRows = (r, prefixList) => matches(r.rows.filter((x) => x.cls === 'bad'), prefixList);

async function runEngine(name) {
  const browser = await pw[name].launch(name === 'chromium'
    ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] }
    : {});
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    // 一次 `console errors(3): … 404 … · Spine: error in texture loader` 说明有文件没取到，却不说是哪个 ——
    // 而"哪个文件"正是这一页存在的全部理由（CI 第一次给出真结论时就撞到了两条 404）。
    // 记下每一条非 2xx 的响应 URL；只有包内路径（/assets /data /js …）才算"包缺文件"，
    // favicon 之类浏览器自己发的不算。
    const badResponses = [];
    page.on('response', (r) => {
      const st = r.status();
      if (st < 400) return;
      let p = '';
      try { p = new URL(r.url()).pathname; } catch { p = r.url(); }
      badResponses.push({ status: st, path: p });
    });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message || e).slice(0, 200)));
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    // 文档本身不是 200 就立刻收：那一页没打开，等多久都不会有结论，而白等 5 分钟 × 2 个引擎会把这条 lane 的
    // 一次"配置错了"变成十分钟的等待（CI 第一次跑就是这样）。
    const status = resp ? resp.status() : 0;
    if (status !== 200) {
      return {
        name, httpStatus: status, done: false, rows: [], consoleErrors, badResponses,
        fatal: `打开 ${pageUrl} 得到 HTTP ${status || '无响应'} —— 文档本身就没起来，后面不必等`,
      };
    }
    const deadline = Date.now() + WAIT_MS;
    let done = false;
    for (;;) {
      done = await page.evaluate(() => !!(window.__SPINE_PROBE__ && window.__SPINE_PROBE__.done)).catch(() => false);
      if (done) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const result = await page.evaluate(() => window.__SPINE_PROBE__ || null);
    return {
      name,
      httpStatus: resp ? resp.status() : 0,
      done,
      fatal: done ? '' : `等了 ${WAIT_MS} ms，window.__SPINE_PROBE__ 没有出现`,
      verdict: result ? result.verdict : '',
      cls: result ? result.cls : '',
      ua: result ? result.ua : '',
      protocol: result ? result.protocol : '',
      rows: result ? result.rows : [],
      consoleErrors: consoleErrors.slice(0, 20),
      badResponses,
    };
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
      byEngine[name] = { name, done: false, fatal: String((e && e.message) || e), rows: [], consoleErrors: [] };
    }
    console.log(byEngine[name].fatal ? `FATAL ${byEngine[name].fatal}` : `${byEngine[name].rows.length} rows · ${byEngine[name].cls}`);
    fs.writeFileSync(path.join(outDir, `spine-probe-${name}.json`), JSON.stringify(byEngine[name], null, 1));
  }
} finally {
  await server.close();
}

const byName = (r) => new Map(r.rows.map((x) => [x.name, x]));
const bad = (r, prefixList) => starts(r.rows.filter((x) => x.cls === 'bad'), prefixList);

console.log('');
for (const n of engines) {
  const r = byEngine[n];
  console.log(`[${n}] HTTP ${r.httpStatus} · protocol=${r.protocol || '—'} · ${r.rows.length} rows · 结论 cls=${r.cls || '—'}`);
  console.log(`     UA: ${String(r.ua || '').slice(0, 120)}`);
  for (const p of REPORT_ONLY) {
    for (const row of matches(r.rows, [p])) console.log(`     ${row.name} → ${row.value} [${row.cls}]`);
  }
  if ((r.consoleErrors || []).length) console.log(`     console errors(${r.consoleErrors.length}): ${r.consoleErrors.slice(0, 3).join(' | ')}`);
  for (const h of (r.badResponses || []).slice(0, 8)) {
    console.log(`     响应 ${h.status} ${h.path}${INTERNAL_PATH.test(h.path) ? '  ← 包内路径' : ''}`);
  }
  console.log(`     verdict: ${r.verdict || '(无)'}`);
}

// 1) controls and the reference engine first — a run that cannot fail has not measured anything.
for (const n of engines) {
  const r = byEngine[n];
  if (r.fatal) { console.error(`[${n}] FATAL ${r.fatal}`); process.exit(2); }
  // 包内路径 4xx 优先于一切结论：这一页可以"四层全通过"而 pixi-spine 的贴图回调里报 baseTexture 为 null
  // —— 那就是立绘少了一块。CI 第一次给出真结论时正是这样（两条 404 + texture loader 报错，页面却说全通过），
  // 所以名字必须打出来，并且不能让它被"通过"盖过去。
  const holes = (r.badResponses || []).filter((x) => INTERNAL_PATH.test(x.path));
  if (holes.length) {
    console.error(`[${n}] 跑这一页的过程中有 ${holes.length} 个包内路径取不到 —— 这就是"立绘不见了"的那类文件：`);
    for (const h of holes.slice(0, 12)) console.error(`   ${h.status} ${h.path}`);
    process.exit(2);
  }
}
const ref = engines.includes('chromium') ? 'chromium' : engines[0];
const refRows = byEngine[ref].rows;
const listRow = refRows.find((x) => x.name === '清单');
if (!listRow || listRow.cls === 'bad') {
  console.error(`[${ref}] 清单这一行不成立（${listRow ? listRow.value : '该行缺失'}）—— 下面的结论都不作数`);
  process.exit(2);
}
const control = refRows.find((x) => x.name.startsWith('⑥ 阴性对照'));
if (!control) { console.error(`[${ref}] 这一趟没有跑阴性对照`); process.exit(2); }
if (control.cls !== 'ok') {
  console.error(`[${ref}] 阴性对照没有「如期失败」（${control.value}）—— 这一趟证明不了任何事`);
  process.exit(2);
}
const refBad = badRows(byEngine[ref], GATED);
// 3) 闸门自己也要有东西可判:如果 GATED 里任何一族在参照引擎里一行都没出现(改名、页面换了写法、
//    或者干脆跑到一半就红),那"两边一致"就是"什么都没比"—— 一条永远绿的闸门比没有闸门更糟。
const families = ['① 运行时', '③ 图片', '④ fetch', '⑤ acquire', '⑥ 阴性对照'];
const missing = families.filter((p) => !refRows.some((x) => x.name.startsWith(p)));
if (missing.length) {
  console.error(`[${ref}] 这一趟里这些类一行都没有：${missing.join(' / ')}`);
  console.error('GATED 的族名与页面的 row() 名字对不上(或页面提前死了)—— 比较没有比到任何东西，判探针不成立。');
  process.exit(2);
}
if (refBad.length) {
  console.error(`[${ref}] 参照引擎在 ${GATED.join('/')} 上就红了 ${refBad.length} 行 —— 那是包或服务的问题，不是 WebKit 的：`);
  for (const x of refBad.slice(0, 10)) console.error(`   ${x.name} → ${x.value}`);
  process.exit(2);
}

// 2) every other engine against it.
let reproduced = 0;
const refMap = byName(byEngine[ref]);
for (const n of engines) {
  if (n === ref) continue;
  const diff = [];
  for (const [key, row] of byName(byEngine[n])) {
    if (!GATED.some((p) => key.startsWith(p))) continue;
    if (row.cls !== 'bad') continue;
    const base = refMap.get(key);
    if (base && base.cls !== 'bad') diff.push([key, row.value, base.value]);
  }
  if (diff.length) {
    reproduced++;
    console.error(`REPRODUCED: [${n}] 在这些行红了而 [${ref}] 是绿的 ——`);
    for (const [k, v, b] of diff) console.error(`   ${k}\n      ${n}: ${v}\n      ${ref}: ${b}`);
  }
}
if (reproduced) {
  console.error(`\nWebKit 系引擎与 ${ref} 在加载/解析层不一致（见上）。`);
  console.error('若差异只在 ⑤ acquire 而 ③④ 都绿：文件取得到、Spine 解析过不去 → 运行时问题，不是打包也不是网络。');
  process.exit(1);
}
console.log(`\nOK — ${engines.join(' / ')} 在 ${GATED.join('/')} 这些行上结论一致（阴性对照如期失败，参照引擎全绿）。`);
console.log(`wrote ${engines.map((n) => path.join(outDir, `spine-probe-${n}.json`)).join(', ')}`);
