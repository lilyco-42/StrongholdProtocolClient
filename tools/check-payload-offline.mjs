// Gate for a shipped client: no third-party host may appear in the boot path, and the font mirror must be inside.
//
// Two rules, both learned the expensive way:
//   * no fonts.googleapis.com / fonts.gstatic.com — a mainland-reachable or LAN/offline player stalls on them,
//     and the mirror in the game repo is byte-identical to what Google serves (fetch-webfonts.mjs --check
//     --verify-bytes measured 112/112 identical), so reaching out buys nothing;
//   * no dl.lain42.top — that is the *web* build's asset prefix. A packaged client that carries it binds itself
//     to the CDN and renders blank offline, which is the one thing an exe/apk is supposed to guarantee.
//
// Three targets, because the bytes live in three different places in a build:
//
//   node tools/check-payload-offline.mjs build/client/www                        # the payload as assembled
//   node tools/check-payload-offline.mjs build/desktop/win-unpacked/resources/www # inside the built exe (asar is
//                                                                                  # only the shell; the game www
//                                                                                  # ships next to it)
//   node tools/check-payload-offline.mjs --zip app-debug.apk                      # inside the built APK
//     (an APK is a zip whose entries are deflate-compressed, so grepping the file finds nothing — measured on the
//      published apk: whole-file count of "fonts.googleapis.com" is 0, while the entry itself contains it twice)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;
export const OSS_HOST = /dl\.lain42\.top/;
/**
 * Reference forms that actually leave the device. Deliberately NOT a bare-URL grep: vendored three.js/pixi carry
 * dozens of doc and licence URLs inside comments, and `xmlns="http://www.w3.org/2000/svg"` is an identifier, not a
 * request — flagging those would train everyone to ignore the gate.
 */
// Everything below is matched by **reference form**, not by a bare URL: a URL in a comment or an SVG `xmlns`
// identifier never leaves the device, while these five families do issue a request. Protocol-relative forms
// (`src="//host/x.png"`) are included on purpose — they inherit whatever scheme the page has, so they are just as
// external as an absolute one, and an offline LAN start would hang on them.
export const OUTBOUND = [
  /(?:href|src|action|poster|data-src)\s*=\s*["'](https?:\/\/[^"'\s]+)/g,
  /url\(\s*["']?(https?:\/\/[^)'"\s]+)/g,
  /(?:fetch|import|axios\.get)\s*\(\s*["'](https?:\/\/[^'"\s]+)/g,
  /new\s+WebSocket\s*\(\s*["'`](https?:\/\/[^'"`\s)]+)/g,
  /@import\s+(?:url\()?\s*["']?(https?:\/\/[^)'"\s]+)/g,
  // 协议相对写法：省略了 scheme，host 仍然在设备外
  /(?:href|src|srcset|action|poster|data-src|imagesrcset)\s*=\s*["'](\/\/[^"'\s]+)/g,
  /url\(\s*["']?(\/\/[^)'"\s]+)/g,
  /@import\s+(?:url\()?\s*["']?(\/\/[^)'"\s]+)/g,
  /(?:fetch|import|axios\.get)\s*\(\s*["'](\/\/[^'"\s]+)/g,
  /new\s+(?:WebSocket|EventSource)\s*\(\s*["'`]\s*(?:wss?:|https?:)?(\/\/[^"'`\s)]+)/g,
  /\.open\(\s*["'](?:GET|POST|HEAD|PUT|DELETE)["']\s*,\s*["']((?:https?:)?\/\/[^'"\s]+)/gi,
  /navigator\.sendBeacon\(\s*["']((?:https?:)?\/\/[^'"\s]+)/g,
];
/** Text formats that can carry a URL. Binary assets (.png/.woff2/.skel/.mp3 …) are not scanned. */
export const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.atlas', '.csv']);
export const SHEET = 'webfonts/google/google.css';
export const MIN_SLICES = 100;

function collectProblems(read, exists, listDir, listSheetUrls, mirrorNames) {
  const problems = [];
  const files = listDir().filter((rel) => TEXT_EXT.has(path.extname(rel).toLowerCase()));
  for (const rel of files) {
    const text = read(rel);
    const host = FONT_HOST.exec(text);
    if (host) problems.push(`${rel} 引用外部字体主机 ${host[0]}`);
    const oss = OSS_HOST.exec(text);
    if (oss) problems.push(`${rel} 引用 CDN 绝对地址 ${oss[0]}（payload 必须用相对清单，否则离线白屏）`);
    const outbound = [...new Set(OUTBOUND.flatMap((rx) => [...text.matchAll(rx)].map((m) => m[1])))];
    if (outbound.length) {
      problems.push(`${rel} 会向站外发请求：${outbound[0].slice(0, 96)}` + (outbound.length > 1 ? `（另有 ${outbound.length - 1} 处）` : ''));
    }
  }

  if (!exists(SHEET)) {
    problems.push(`缺自托管字体表 ${SHEET} —— 镜像没进产物？`);
    return { files: files.length, woff2: 0, slices: 0, problems };
  }
  const sheet = read(SHEET);
  const urls = [...new Set(sheet.match(/url\(\/webfonts\/google\/[^)]+\.woff2\)/g) || [])];
  const names = urls.map((u) => /^url\(\/webfonts\/google\/(.+)\)$/.exec(u)[1]);
  if (names.length < MIN_SLICES) problems.push(`字体表只有 ${names.length} 个本地切片`);
  if (!/font-display:\s*swap/.test(sheet)) problems.push('字体表丢了 display=swap 时序');
  // Case-EXACT membership, deliberately not existsSync(): the desktop job runs on windows-latest and the game repo
  // lives on a case-insensitive checkout, while Android serves these from ext4 — a name that only differs in case
  // passes the file check on Windows and 404s on a phone. Same for two files differing only by case.
  const disk = mirrorNames();
  const exact = new Set(disk);
  const lower = new Map();
  for (const n of disk) lower.set(n.toLowerCase(), (lower.get(n.toLowerCase()) || 0) + 1);
  const collisions = [...lower.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  if (collisions.length) problems.push(`镜像目录里有只差大小写的同名文件（Windows 打得开、Android/Linux 只认一个）：${collisions.slice(0, 3).join(', ')}`);
  const missing = names.filter((n) => !exact.has(n));
  if (missing.length) {
    const caseOnly = missing.filter((n) => lower.has(n.toLowerCase()));
    problems.push(`${missing.length} 个切片文件缺失，例如 ${missing[0]}`);
    if (caseOnly.length) {
      problems.push(`其中 ${caseOnly.length} 个只差大小写（字体表要 ${caseOnly[0]}，盘上是另一套大小写）—— 手机上是 404`);
    }
  }
  const woff2 = listSheetUrls();
  if (woff2 && woff2 < names.length) problems.push(`目录里只有 ${woff2} 个 woff2，字体表引用了 ${names.length} 个`);
  return { files: files.length, woff2, slices: names.length, problems };
}

/** Recursively list every scannable file under `root`, relative to `root` (not to the directory being walked). */
export function textFiles(root, base = root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { out.push(...textFiles(p, base)); continue; }
    if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * @param {string} root payload root (the flattened game public/ + data/ + shared/ + server/sim)
 * @returns {{ files: number, woff2: number, slices: number, problems: string[] }}
 */
export function checkPayloadOffline(root) {
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    return { files: 0, woff2: 0, slices: 0, problems: [`不是 payload 根目录：${root} 里没有 index.html`] };
  }
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const dir = path.join(root, 'webfonts', 'google');
  const names = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const list = () => textFiles(root);
  const woff = () => names().filter((f) => f.endsWith('.woff2')).length;
  return collectProblems(read, exists, list, woff, names);
}

/** Minimal zip reader: central directory + stored/deflate entries. Enough for an APK's assets/. */
export function zipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x0605_4b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file}: 找不到 zip EOCD（不是 zip？）`);
  const count = buf.readUInt16LE(eocd + 10);
  const entries = [];
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x0201_4b50) throw new Error(`${file}: 中央目录第 ${n} 项签名不对 —— 解析越界`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return { buf, entries };
}

export function zipRead(z, e) {
  if (e.method === 0) return z.buf.subarray(e.dataStart, e.dataStart + e.compSize).toString('utf8');
  if (e.method === 8) return zlib.inflateRawSync(z.buf.subarray(e.dataStart, e.dataStart + e.compSize)).toString('utf8');
  throw new Error(`${e.name}: 未支持的压缩方法 ${e.method}`);
}

/**
 * Check an APK (or any zip) by its entry names under `prefix`.
 * @param {string} file
 * @param {{ prefix?: string }} [o]
 */
export function checkZipOffline(file, o = {}) {
  const prefix = o.prefix ?? 'assets/public/';
  const { buf, entries } = zipEntries(file);
  for (const e of entries) {
    if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name}: 未支持的压缩方法 ${e.method}`);
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    e.dataStart = e.localOff + 30 + nameLen + extraLen;
  }
  const byName = new Map(entries.filter((e) => !e.name.endsWith('/')).map((e) => [e.name, e]));
  const relOf = (rel) => prefix + rel;
  const exists = (rel) => byName.has(relOf(rel));
  if (!exists('index.html')) {
    return { files: 0, woff2: 0, slices: 0, problems: [`${file} 里没有 ${relOf('index.html')} —— 这不是 APK 的 www 前缀？`] };
  }
  const read = (rel) => {
    const e = byName.get(relOf(rel));
    if (!e) throw new Error(`缺条目 ${relOf(rel)}`);
    return zipRead({ buf }, e);
  };
  const list = () => [...byName.keys()].filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length));
  const mirror = () => list().filter((n) => n.startsWith('webfonts/google/')).map((n) => n.slice('webfonts/google/'.length));
  const woff = () => mirror().filter((n) => n.endsWith('.woff2')).length;
  const r = collectProblems(read, exists, list, woff, mirror);
  return { ...r, entries: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zipAt = process.argv.indexOf('--zip');
  let r;
  let target;
  if (zipAt >= 0) {
    target = process.argv[zipAt + 1] || 'mobile/android/app/build/outputs/apk/debug/app-debug.apk';
    r = checkZipOffline(target);
  } else {
    target = path.resolve(process.argv[2] || 'build/client/www');
    r = checkPayloadOffline(target);
  }
  console.log(`离线闸门（${zipAt >= 0 ? 'apk' : '目录'} ${target}）：扫描 ${r.files} 个文本文件，woff2 镜像 ${r.woff2} 个，字体表引用 ${r.slices} 个`);
  if (r.problems.length) {
    for (const p of r.problems) console.error('  ✗ ' + p);
    process.exit(1);
  }
  console.log('  ✓ 零外部字体主机、零 CDN 绝对地址，字体镜像完整');
}
