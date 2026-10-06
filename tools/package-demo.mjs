// 组装「P2P 直连自检」demo 的静态站点。
//
// 为什么写进 build/client/www：Capacitor（mobile/capacitor.config.json）和 Electron（desktop/package.json 的
// extraResources）本来就都指向这个目录。把 demo 铺在那里，两个壳的配置一行都不用改 —— 只覆盖应用名/包名，
// 让 demo 和游戏本体在手机上能共存。少改一个共享文件，就少一处冲突面。
//
// 用法: node tools/package-demo.mjs [--out build/client/www]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTBOUND } from './check-payload-offline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const checkIdx = args.indexOf('--check');
const out = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : 'build/client/www');
const checkDir = checkIdx >= 0 ? path.resolve(ROOT, args[checkIdx + 1]) : null;

/** [源（相对仓库根）, 目标（相对 out）]。路径关系是硬约束：index.html 导入 ./p2p/link.js，
 *  link.js 导入 ./rooms.js 与 ./vendor/trystero.js，rooms.js 导入 ../picker-core.js。 */
const FILES = [
  ['demo/index.html', 'index.html'],
  ['shell/p2p/link.js', 'p2p/link.js'],
  ['shell/p2p/rooms.js', 'p2p/rooms.js'],
  ['shell/p2p/vendor/trystero.js', 'p2p/vendor/trystero.js'],
  ['shell/picker-core.js', 'picker-core.js'],
];

/** demo 页面必须出现在出厂字节里。少了它，壳会打开一个空窗口，而打包这一步是绿的。 */
const MARKER = 'p2p-connect-check-v1';

const gateDir = (root, { assembled }) => {
  const problems = [];

  for (const [, dst] of FILES) {
    if (!fs.existsSync(path.join(root, dst))) problems.push(`缺 ${dst}`);
  }

  const html = path.join(root, 'index.html');
  if (fs.existsSync(html) && !fs.readFileSync(html, 'utf8').includes(MARKER)) {
    problems.push(`index.html 里没有 ${MARKER} —— 这不是 demo 页面`);
  }

  // 外链闸门只跑 OUTBOUND 那部分。完整的 check-payload-offline 还要查自托管字体镜像，
  // 而这个 demo 没有字体、也不该有 —— 拿它跑完整闸门只会永远红。
  // 但"会向站外发请求"对 demo 一样致命：APK 里那个页面是在离线的 WebView 里打开的。
  for (const [, dst] of FILES) {
    const p = path.join(root, dst);
    if (!fs.existsSync(p)) continue;
    const hits = [...new Set(OUTBOUND.flatMap((rx) => [...fs.readFileSync(p, 'utf8').matchAll(rx)].map((m) => m[1])))];
    if (hits.length) problems.push(`${dst} 会向站外发请求：${hits.slice(0, 3).join(', ')}`);
  }

  console.log(`${assembled ? '组装目录' : '出厂字节'}: ${root}`);
  if (problems.length) {
    console.error('闸门未通过：');
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }
  console.log('闸门: 通过（文件齐全 + 0 处站外引用）');
};

if (checkDir) {
  gateDir(checkDir, { assembled: false });
} else {
  let written = 0;
  for (const [src, dst] of FILES) {
    const from = path.join(ROOT, src);
    if (!fs.existsSync(from)) {
      console.error(`缺少源文件 ${src}`);
      process.exit(1);
    }
    const to = path.join(out, dst);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const body = fs.readFileSync(from);
    const same = fs.existsSync(to) && fs.readFileSync(to).equals(body);
    if (!same) {
      fs.writeFileSync(to, body);
      written++;
    }
    console.log(`${same ? '  ' : '写 '}${dst}  ${body.length} B  ← ${src}`);
  }
  console.log(`\n写入 ${written} 个文件（其余字节相同，未动）\n`);
  gateDir(out, { assembled: true });
}
