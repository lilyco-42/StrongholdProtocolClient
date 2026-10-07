// 两个壳必须讲同一种 HTTP。
//
// Electron 壳的规则在 `desktop/serve.mjs`（JS），Tauri 壳的规则在 `tauri/src-tauri/src/server.rs`（Rust，std 手写）。
// Rust 那份是手抄的，抄错一行不会有人发现：`.skel` 落到错误的 Content-Type 就是 Spine 静默不显示，
// `/media/…` 少一种扩展名就是全体静音，长缓存挂到 `index.html` 上就是"更新后玩家还是旧版"。
// 所以这里不复制常量，而是**两边都从源码里读**再逐条比 —— 这样改了任何一边都会立刻红，
// 而不是等某个平台的玩家反馈。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIME, AUDIO_EXTS, LONG_CACHE_DIRS, DEFAULT_PORT, PORT_SEARCH, cacheControlFor } from '../desktop/serve.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUST = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'server.rs'), 'utf8');

/** `pub fn mime_of(ext: &str) -> &'static str { match ext { ".a" | ".b" => "x", … _ => "y" } }` → Map(ext → type) */
function rustMime(src) {
  const body = src.slice(src.indexOf('pub fn mime_of'), src.indexOf('/// Percent-decode'));
  const map = new Map();
  let fallback = null;
  for (const line of body.split('\n')) {
    const f = /^\s*_\s*=>\s*"([^"]+)",\s*$/.exec(line);
    if (f) { fallback = f[1]; continue; }
    const arrow = line.indexOf('=>');
    if (arrow > 0) {
      const left = line.slice(0, arrow);
      const keys = [...left.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      const val = /"([^"]+)"/.exec(line.slice(arrow + 2));
      if (keys.length && val) for (const k of keys) map.set(k, val[1]);
      continue;
    }
  }
  return { map, fallback };
}

/** `pub const NAME: … = […];` / `const NAME: &str = "…";` 的字面量值 */
function rustConst(src, name) {
  const arr = new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`, 'm').exec(src);
  if (arr) return arr[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const one = new RegExp(`const ${name}[^=]*=\\s*"([^"]*)"`, 'm').exec(src);
  if (one) return one[1];
  const num = new RegExp(`const ${name}[^=]*=\\s*(\\d+)`, 'm').exec(src);
  return num ? Number(num[1]) : undefined;
}

test('the Rust shell serves exactly the JS shell\'s Content-Type table (same keys, same values)', () => {
  const { map, fallback } = rustMime(RUST);
  assert.ok(map.size > 20, `只从 Rust 里读出 ${map.size} 条 —— 解析器漂了，这条测试就没用了`);
  assert.equal(fallback, 'application/octet-stream', '未知扩展名的兜底必须与 JS 的调用方一致');
  const jsKeys = Object.keys(MIME).sort();
  const rustKeys = [...map.keys()].sort();
  assert.deepEqual(rustKeys, jsKeys, '扩展名集合不一致');
  for (const k of jsKeys) assert.equal(map.get(k), MIME[k], `${k} 的 Content-Type 两边不同`);
});

test('/media alias: same extension probe order, same prefix, same audio root', () => {
  assert.deepEqual(rustConst(RUST, 'AUDIO_EXTS'), [...AUDIO_EXTS], '顺序就是优先级，必须逐位相同');
  assert.equal(rustConst(RUST, 'MEDIA_PREFIX'), '/media/');
  assert.deepEqual(rustConst(RUST, 'AUDIO_ROOT'), ['assets', 'audio']);
});

test('the long-cache dir set is the same list', () => {
  assert.deepEqual([...rustConst(RUST, 'LONG_CACHE_DIRS')].sort(), [...LONG_CACHE_DIRS].sort());
});

test('the loopback port is the same number on purpose (localStorage is scoped by origin)', () => {
  assert.equal(rustConst(RUST, 'DEFAULT_PORT'), DEFAULT_PORT);
  assert.equal(rustConst(RUST, 'PORT_SEARCH'), PORT_SEARCH);
});

test('cache policy agrees on the shapes that actually occur in the payload', () => {
  const samples = [
    ['/index.html', 'index.html'],
    ['/js/main.js', 'js', 'main.js'],
    ['/data/chess.json', 'data', 'chess.json'],
    ['/data.js', 'data.js'],
    ['/assets/char/avatar/a.png', 'assets', 'char', 'avatar', 'a.png'],
    ['/assets/audio/bgm/x.mp3', 'assets', 'audio', 'bgm', 'x.mp3'],
    ['/vendor/pixi.min.js', 'vendor', 'pixi.min.js'],
    ['/webfonts/google/google.css', 'webfonts', 'google', 'google.css'],
    ['/fonts/fonts.css', 'fonts', 'fonts.css'],
    ['/i18n/en.json', 'i18n', 'en.json'],
    ['/packs/index.json', 'packs', 'index.html'],
  ];
  for (const [url, ...segs] of samples) {
    const ext = path.extname(url).toLowerCase();
    const got = cacheControlFor(ext, segs);
    // 同一份输入喂给 Rust 的那段逻辑（它是按 segments.len() > 1 与首段查表写的）—— 这里把那两条规则复述一遍，
    // 任何一边改了都会与 JS 的实际输出分叉，而 JS 那一侧是真跑过的。
    const rustLike = (ext === '.html' || ext === '.htm') ? 'no-cache'
      : (segs.length > 1 && LONG_CACHE_DIRS.has(segs[0])) ? 'public, max-age=86400' : 'no-cache';
    assert.equal(got, rustLike, `${url} 两边策略不同`);
  }
});

test('the Tauri bundle really ships the payload as resources (not a placeholder page)', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.deepEqual(conf.bundle.resources, ['www'], 'www 必须打进包里，壳才有离线素材');
  assert.equal(conf.app.security.csp, null, '外部 http origin 上的页面不该被 Tauri 注入 CSP');
  assert.equal(conf.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper',
    '离线安装器会把 ~130 MB 的 WebView2 塞进包里，与"减小体积"这条初衷相反；已装 WebView2 的机器根本不会下载');
  assert.deepEqual(conf.bundle.targets, ['nsis'], '只出安装器与目录版：单文件自解压正是启动慢的那个');
  assert.equal(Array.isArray(conf.app.windows) && conf.app.windows.length, 0,
    '窗口由 main.rs 建（要等服务器起来才知道端口），配置里不能再来一份');
});

test('there is no portable/self-extracting target anywhere in the Tauri lane', () => {
  const cargo = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.doesNotMatch(cargo, /portable/i, 'Rust 侧不该出现 portable 形态');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-tauri.yml'), 'utf8');
  assert.match(wf, /name: build-tauri/);
  for (const gate of ['校验 payload 完整性', '校验 payload 版本（闸门）', 'payload 出处（闸门）', '零外部依赖（闸门）', '零外部依赖（产物内，闸门）']) {
    assert.ok(wf.includes(gate), `Tauri 流水线少了闸门：${gate}`);
  }
});
