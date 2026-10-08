// Serve a packaged client's own web root to a real browser engine, and hand that engine the list of art
// files the app actually asks for.
//
// Why this exists: a player reported 「ipa 没有立绘，只显示了干员头像」 (iPhone, 0.2.1-c24). The shipped
// bundle turned out to hold every file — all 9,855 manifest URLs resolve case-exactly inside the ipa, and the
// iOS and Android web roots are the same 13,968 files — so "the file is missing" was ruled out without a
// device, and what is left is all *runtime*: WebKit's image loading, the `loading="lazy"` attribute, the
// custom scheme handler, device memory. Windows has no WebKit, so the only way to ask those questions is a
// real engine pointed at the shipped tree. `tools/art-probe-check.mjs` drives it and
// `.github/workflows/probe-ios-art.yml` runs that in CI; docs/IOS-ART.md records what it showed.
//
//   node tools/art-probe.mjs --root <extracted web root> --list     # print the case list, no server
//   node tools/art-probe.mjs --root <extracted web root>            # serve it, print the probe URL
//
// The server deliberately matches what the packaged shells do, not what a dev server does: no
// `Accept-Ranges`, no `ETag`, no caching, MIME looked up from our own extension table — because Capacitor's
// iOS scheme handler answers exactly like that, and a probe that advertised range support would be testing a
// server the player does not have.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Extension → Content-Type. Only what the payload tree actually holds (plus the probe's own pages). */
const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.dat': 'application/octet-stream',
}));

export function mimeFor(file) {
  return MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
}

const isUrl = (v) => typeof v === 'string' && v.startsWith('/');

/**
 * Only what an `<img>` can be asked to load. `.skel` / `.atlas` / `.woff2` / `.obj` are in the manifests too, and
 * feeding them to an `<img>` fails in *every* engine — which the reference-engine gate would then blame on the
 * tree. Spine data and fonts are their own questions, not the 立绘 one.
 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

/** Every URL inside one record, as ['<field.path>', url] — depth-bounded, arrays allowed. */
function recordUrls(rec, prefix = '', depth = 3) {
  const found = [];
  if (depth < 0) return found;
  if (isUrl(rec)) return [[prefix, rec]];
  if (Array.isArray(rec)) {
    for (const x of rec) found.push(...recordUrls(x, prefix, depth - 1));
    return found;
  }
  if (rec && typeof rec === 'object') {
    for (const [k, v] of Object.entries(rec)) found.push(...recordUrls(v, prefix ? `${prefix}.${k}` : k, depth - 1));
  }
  return found;
}

/**
 * The art files the running app can ask for, sampled one group per field the UI reads.
 *
 * The group list is not invented here: it mirrors `public/js/ui/assetUrls.js`, the client's only URL
 * resolver, plus the local-art manifest `js/data.js` loads — so the probe asks for what the game asks for.
 * @param {{ assets?: any, local?: any }} manifests parsed `data/assets.json` / `data/local-assets.json`
 * @param {{ perGroup?: number }} [opt] samples kept per group (the largest member always survives)
 * @returns {{ group: string, id: string, url: string, px: number | null }[]}
 */
export function buildArtCases({ assets = null, local = null } = {}, { perGroup = 2 } = {}) {
  const out = [];
  const push = (group, id, url, px = null) => {
    if (isUrl(url) && IMAGE_EXT.test(url)) out.push({ group, id: String(id), url, px });
  };

  const chars = assets?.chars || {};
  for (const [id, rec] of Object.entries(chars)) {
    for (const field of ['avatar', 'avatarE2', 'portrait', 'portraitE2']) push(`chars.${field}`, id, rec?.[field]);
    for (const side of ['front', 'back']) {
      for (const [, url] of recordUrls(rec?.spine?.[side]?.textures)) push(`chars.spine.${side}`, id, url);
    }
  }
  for (const [id, rec] of Object.entries(assets?.enemies || {})) {
    push('enemies.icon', id, rec?.icon);
    for (const side of ['front', 'back']) {
      for (const [, url] of recordUrls(rec?.spine?.[side]?.textures)) push(`enemies.spine.${side}`, id, url);
    }
  }
  // audio is 4,026 URLs and is not art (its own story is /media aliasing, docs/PACKAGING.md); including it
  // would multiply every case below by a stage list for no information about 立绘.
  //
  // 'flat'     the key *is* the art (items/skills/…).
  // 'record'   the key is an id and the URLs are fields inside it (tokens).
  // 'category' the key is an art family and its members are the URLs (prof.icon.caster).
  // The last two look identical to a generic walk; naming the shape per group is what keeps the ~90 profession
  // icons in one sample bucket instead of 90 buckets of one (and 209 token records out of 209 buckets).
  const GROUP_SHAPE = {
    items: 'flat', bands: 'flat', bonds: 'flat', skills: 'flat', skillsById: 'flat', modules: 'flat',
    tokens: 'record',
    prof: 'category', fonts: 'category',
  };
  for (const [group, shape] of Object.entries(GROUP_SHAPE)) {
    const node = assets?.[group];
    if (!node || typeof node !== 'object') continue;
    if (shape === 'flat') {
      for (const [id, url] of Object.entries(node)) push(`assets.${group}`, id, url);
      continue;
    }
    if (shape === 'category') {
      for (const [cat, members] of Object.entries(node)) {
        for (const [, url] of recordUrls(members)) push(`assets.${group}.${cat}`, cat, url);
      }
      continue;
    }
    for (const [id, rec] of Object.entries(node)) {
      for (const [fields, url] of recordUrls(rec)) {
        const first = fields ? fields.split('.')[0] : '';
        push(first ? `assets.${group}.${first}` : `assets.${group}`, id, url);
      }
    }
  }
  // `ui` is keyed 'group/name' already
  for (const [key, url] of Object.entries(assets?.ui || {})) push(`assets.ui.${String(key).split('/')[0]}`, key, url);

  // local extraction manifest (board art, guide pages, emoticons): entries are { path, w, h }
  for (const [group, node] of Object.entries(local?.groups || {})) {
    for (const [name, rec] of Object.entries(node || {})) {
      const px = rec?.w && rec?.h ? rec.w * rec.h : null;
      push(`local.${String(group).split('/')[0]}`, `${group}/${name}`, rec?.path, px);
    }
  }

  // Sample per group, keeping the declared-largest member so the 2048×2048 board pages are always in the set.
  const byGroup = new Map();
  for (const c of out) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group).push(c);
  }
  const cases = [];
  for (const [group, list] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((x, y) => (y.px || 0) - (x.px || 0) || x.id.localeCompare(y.id));
    cases.push(...list.slice(0, perGroup));
  }
  // A URL that must NOT resolve. Every engine has to fail on it; if it loads, the probe proves nothing.
  cases.push({ group: '__control__', id: 'missing-file', url: '/assets/char/portrait/__art_probe_no_such_file__.png', px: null });
  return cases;
}

/** Read the two manifests off an extracted web root (both ship inside the payload). */
export function readManifests(root) {
  const read = (p) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return null; }
  };
  return { assets: read(path.join('data', 'assets.json')), local: read(path.join('data', 'local-assets.json')) };
}

/**
 * @param {{ root: string, probeHtml: string, cases: any[], port?: number }} o
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function startProbeServer({ root, probeHtml, cases, port = 0 }) {
  const webRoot = path.resolve(root);
  const html = fs.readFileSync(probeHtml, 'utf8');
  const caseBody = JSON.stringify({ cases });
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); return;
    }
    if (pathname === '/__art_probe__') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    if (pathname === '/__art_cases__.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(caseBody),
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : caseBody);
      return;
    }
    const file = path.resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return;
    }
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!st || st.isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': mimeFor(file), 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    const s = fs.createReadStream(file);
    s.on('error', () => res.destroy());
    s.pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        url: `http://127.0.0.1:${p}/__art_probe__`,
        port: p,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}

function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const root = arg('--root', argv) || process.cwd();
  if (!fs.existsSync(path.join(root, 'data', 'assets.json'))) {
    console.error(`[art-probe] ${root}: no data/assets.json — pass --root <the extracted web root of a payload/ipa>`);
    process.exit(2);
  }
  const cases = buildArtCases(readManifests(root), { perGroup: Number(arg('--per-group', argv) || 2) });
  if (argv.includes('--list')) {
    for (const c of cases) console.log([c.group, c.id, c.url, c.px ? `${c.px}px` : ''].join('\t'));
    console.error(`${cases.length} cases in ${new Set(cases.map((c) => c.group)).size} groups`);
    return;
  }
  const probeHtml = path.join(path.dirname(fileURLToPath(import.meta.url)), 'art-probe.html');
  const s = await startProbeServer({ root, probeHtml, cases });
  console.log(`[art-probe] ${cases.length} cases  url=${s.url}  root=${root}`);
}

// Guarded: test/art-probe.test.js imports the pure parts, and main() would exit the whole test process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
