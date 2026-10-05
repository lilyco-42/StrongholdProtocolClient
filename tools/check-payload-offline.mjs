// Gate for an assembled payload: a packaged client must run with no third-party host in its boot path.
//
// Two rules, both learned the expensive way:
//   * no fonts.googleapis.com / fonts.gstatic.com — a mainland-reachable or LAN/offline player stalls on them,
//     and the mirror in public/webfonts/google/ is byte-identical to what Google serves (fetch-webfonts --check
//     --verify-bytes), so there is nothing to gain by reaching out;
//   * no dl.lain42.top — that is the *web* build's asset prefix. A payload that carries it binds the installed
//     client to the CDN and it renders blank offline, which is the one thing an exe/apk is supposed to guarantee.
//
//   node tools/check-payload-offline.mjs [build/client/www]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/;
export const OSS_HOST = /dl\.lain42\.top/;
/** Text formats that can carry a URL. Binary assets (.png/.woff2/.skel/.mp3 …) are not scanned. */
export const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.atlas', '.csv']);

/** Recursively list every scannable file under `root`. */
export function textFiles(root) {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { out.push(...textFiles(p)); continue; }
    if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

/**
 * @param {string} root payload root (the flattened game public/ + data/ + shared/ + server/sim)
 * @returns {{ files: number, woff2: number, slices: number, problems: string[] }}
 */
export function checkPayloadOffline(root) {
  const problems = [];
  if (!fs.existsSync(path.join(root, 'index.html'))) return { files: 0, woff2: 0, slices: 0, problems: [`不是 payload 根目录：${root} 里没有 index.html`] };

  const files = textFiles(root);
  for (const p of files) {
    const text = fs.readFileSync(p, 'utf8');
    const host = FONT_HOST.exec(text);
    if (host) problems.push(`${path.relative(root, p)} 引用外部字体主机 ${host[0]}`);
    const oss = OSS_HOST.exec(text);
    if (oss) problems.push(`${path.relative(root, p)} 引用 CDN 绝对地址 ${oss[0]}（payload 必须用相对清单，否则离线白屏）`);
  }

  const sheetPath = path.join(root, 'webfonts', 'google', 'google.css');
  let slices = 0;
  if (!fs.existsSync(sheetPath)) {
    problems.push('缺自托管字体表 webfonts/google/google.css —— 镜像没进 payload？');
  } else {
    const sheet = fs.readFileSync(sheetPath, 'utf8');
    const urls = [...new Set(sheet.match(/url\(\/webfonts\/google\/[^)]+\.woff2\)/g) || [])];
    slices = urls.length;
    if (slices < 100) problems.push(`字体表只有 ${slices} 个本地切片`);
    if (!/font-display:\s*swap/.test(sheet)) problems.push('字体表丢了 display=swap 时序');
    const missing = urls
      .map((u) => /^url\(\/webfonts\/google\/(.+)\)$/.exec(u)[1])
      .filter((n) => !fs.existsSync(path.join(root, 'webfonts', 'google', n)));
    if (missing.length) problems.push(`${missing.length} 个切片文件缺失，例如 ${missing[0]}`);
  }
  const woff2 = fs.existsSync(path.join(root, 'webfonts', 'google'))
    ? fs.readdirSync(path.join(root, 'webfonts', 'google')).filter((f) => f.endsWith('.woff2')).length : 0;
  if (woff2 && slices && woff2 < slices) problems.push(`镜像目录只有 ${woff2} 个 woff2，字体表引用了 ${slices} 个`);

  return { files: files.length, woff2, slices, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || 'build/client/www');
  const r = checkPayloadOffline(root);
  console.log(`payload 离线闸门：扫描 ${r.files} 个文本文件，woff2 镜像 ${r.woff2} 个，字体表引用 ${r.slices} 个`);
  if (r.problems.length) {
    for (const p of r.problems) console.error('  ✗ ' + p);
    process.exit(1);
  }
  console.log('  ✓ 零外部字体主机、零 CDN 绝对地址，字体镜像完整');
}
