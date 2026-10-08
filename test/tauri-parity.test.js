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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIME, AUDIO_EXTS, LONG_CACHE_DIRS, DEFAULT_PORT, PORT_SEARCH, cacheControlFor, createStaticServer } from '../desktop/serve.mjs';

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

// 2026-10-08 玩家真机报的两条：启动有个黑控制台窗口；按 F2 没反应。
// 第一条是 Rust 二进制的默认子系统；第二条是"原生快捷键只在 Electron 里实现过"。两条都必须有钉，
// 否则下一次改壳又会悄悄退回去（黑窗好看见，F2 失效不好看见）。
test('the release shell has no console window, and still tells the player when it cannot start', () => {
  const main = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'main.rs'), 'utf8');
  assert.match(main, /#!\[cfg_attr\(all\(not\(debug_assertions\), not\(test\)\), windows_subsystem = "windows"\)\]/,
    'release 必须用 windows 子系统（否则双击启动会带一个黑控制台）');
  assert.ok(!/#!\[cfg_attr\(not\(debug_assertions\), windows_subsystem/.test(main),
    '不能漏掉 not(test)：cargo test --release 的测试可执行文件也要能正常打日志');
  // 属性必须在任何 item 之前（Rust 的 inner attribute 规则），否则编译直接红。
  const at = main.indexOf('#![cfg_attr');
  const firstItem = main.search(/^\s*(?:mod|use|fn|const|struct) /m);
  assert.ok(at > 0 && firstItem > at, 'windows_subsystem 要写在 mod/use/fn 之前');

  // 没有控制台了，致命错误就必须走原生框；而 CI 的探针模式绝不能弹（模态框会挂住那一步）。
  assert.match(main, /fn die\(msg: &str\) -> !/, '启动失败要有统一的出口');
  assert.match(main, /popup\(msg, MB_ICONERROR\)/, '失败弹错误框（对应 Electron 的 dialog.showErrorBox）');
  assert.match(main, /fn notice\(msg: &str\) -> !/, '"已经有一个在跑"是正常情况，不能当错误报');
  assert.match(main, /popup\(msg, MB_ICONINFORMATION\)/, '正常情况用信息图标');
  assert.match(main, /if std::env::var\("SP_TAU_BOOT_PROBE"\)\.is_err\(\)/,
    '探针模式下绝不弹框：CI 会被模态框挂住');
  assert.match(main, /std::process::exit\(0\)/, 'notice 走 0 退出（不是失败）');
  // 不新增 windows 绑定 crate：直接 link user32。
  assert.match(main, /#\[link\(name = "user32"\)\]/, 'MessageBoxW 用 #[link] 声明，别为它加依赖');
  const cargo = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.ok(!/windows-sys|windows = /.test(cargo), 'Cargo.toml 里不该出现 windows 绑定 crate（这条路径刻意不用）');
});

test('the boot probe is a real gate now that the console is gone', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-tauri.yml'), 'utf8');
  // 按步骤边界切块："以前是 continue-on-error" 这句话就写在上面的注释里，拿整段文本匹配会自相矛盾。
  const lines = wf.split('\n');
  const from = lines.findIndex((l) => /^\s*- name: 启动探针/.test(l));
  assert.ok(from >= 0, '要有"启动探针"这个步骤');
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) if (/^\s*- name: /.test(lines[i])) { to = i; break; }
  const step = lines.slice(from, to).filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/continue-on-error/.test(step), '探针不能再 continue-on-error：去掉控制台后它是 stdout 是否还可达的唯一证据');
  assert.match(step, /Select-String[\s\S]{0,120}main_js_ms/, '要真的按 boot_probe 行的形状去读，而不是"文件里有字"');
  assert.match(step, /exit 1/, '读不到就红');
});

// 两个壳讲的得是同一种 HTTP，"一条连接能装几个请求"也算在内。Electron 那边的 keep-alive 是 Node 的
// http.Server 白送的，Rust 这份是手写的：一旦退回"一个连接一个请求"，一局游戏里几百个文件就要几百次
// TCP 连接加几百个线程，而日志上只会显示"变慢了"，看不出原因。
// 下面第二条是**实测对照**：我先写过一条"Node 续用连接时不多发任何头"的断言，那是猜的 —— 真跑一遍
// Node 回的是 `Connection: keep-alive` + `Keep-Alive: timeout=5`。猜错的方向是让两个壳各自漂走，
// 所以这里起 JS 那份服务自己问一遍，再要求 Rust 源码里出现同样的字。
test('the Rust server reuses connections, structurally', () => {
  const shipped = RUST.slice(0, RUST.indexOf('#[cfg(test)]'));
  assert.match(shipped, /fn serve_connection\(/, '服务的单位必须是连接，不是请求');
  assert.match(shipped, /stats\.connections\.fetch_add\(1/, '每条连接要计数（boot_probe 里那个 connections= 就是它）');
  assert.match(shipped, /thread::spawn\(move \|\| serve_connection\(/, 'accept 循环要交给连接级函数');
  assert.match(shipped, /Ok\(true\) => continue/, 'keep-alive 的回答之后必须回去读下一个请求');
  assert.match(shipped, /fn reusable\(&self\) -> bool/, '1.1 默认续用、1.0 默认不续用得有实现处');

  // 正文字节数必须与 Content-Length 一致。416 以前带整个文件：一次性连接时无所谓，
  // 复用连接时那堆字节会被下一个回答当成开头读，症状是"偶发的图片损坏"，最难查。
  assert.match(shipped, /status = "416 Range Not Satisfiable";\s*length = 0;/, '416 不许带正文');
  assert.match(shipped, /if length == 0 \|\| method == "HEAD" \{[\s\S]{0,80}return Ok\(keep\);/,
    '没有正文时也要把连接留着（304/416/HEAD 都算）');
});

/** 在同一条 socket 上连发两个 HTTP/1.1 请求，把收到的原始字节带回来。 */
function twoRequestsOneSocket(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let all = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error('两条请求没有都在同一条 socket 上得到回答')); }, 8000);
    s.on('data', (d) => {
      all += d.toString('latin1');
      if ((all.match(/HTTP\/1\.1/g) || []).length >= 2) {
        clearTimeout(timer);
        s.destroy();
        resolve(all);
      }
    });
    s.on('error', (e) => { clearTimeout(timer); reject(e); });
    s.write('GET /a.txt HTTP/1.1\r\nHost: x\r\n\r\n');
    setTimeout(() => s.write('GET /a.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 200);
  });
}

test('the Rust server answers connection reuse with the same bytes Node sends', async () => {
  const shipped = RUST.slice(0, RUST.indexOf('#[cfg(test)]'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ka-parity-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'HELLO-AAAA');
  const srv = await createStaticServer({ root: dir, port: 0, log: { log() {}, warn() {}, error() {} } });
  try {
    const raw = await twoRequestsOneSocket(srv.port);
    const heads = raw.split('HTTP/1.1').slice(1);
    assert.equal(heads.length, 2, 'Node 必须在同一条 socket 上答两个请求，否则整个前提要重写');
    assert.match(heads[0], /Connection: keep-alive/, 'Node 续用时发的头变了：请同步 Rust');
    const ka = /Keep-Alive:\s*timeout=(\d+)/.exec(heads[0]);
    assert.ok(ka, `Node 的 Keep-Alive 头形状变了：${heads[0].slice(0, 400)}`);
    const want = `"Connection: keep-alive\\r\\nKeep-Alive: timeout=${ka[1]}\\r\\n"`;
    assert.ok(shipped.includes(want), `Rust 那侧必须发同样的两行（要找的字面量：${want}）`);
    assert.ok(shipped.includes(`Duration::from_secs(${ka[1]})`), `Rust 空闲超时要与 Node 报的 ${ka[1]} 秒一致`);
    assert.ok(!/Duration::from_secs\(15\)/.test(shipped), '旧的 15 秒空闲值不该还留在文件里');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the boot probe prints connections, so "the page reused its sockets" is a number', () => {
  const main = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'main.rs'), 'utf8');
  assert.match(main, /requests=\{\} connections=\{\}/, 'boot_probe 那行必须同时报请求数与连接数');
  assert.match(main, /s\.connections\.load\(Ordering::Relaxed\)/);
  // 探针自己那发探测请求必须要求关闭，否则对面的 keep-alive 会让我们 read_to_end 挂到超时
  assert.match(main, /GET \/ HTTP\/1\.1\\r\\nHost: 127\.0\.0\.1\\r\\nConnection: close/);

  // 而且 CI 必须真的按这两个数判红绿："退回一个连接一个请求"时 boot_probe 行照样打印，
  // 只看"有没有这行"是抓不住的。
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-tauri.yml'), 'utf8');
  const lines = wf.split('\n');
  const from = lines.findIndex((l) => /^\s*- name: 启动探针/.test(l));
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) if (/^\s*- name: /.test(lines[i])) { to = i; break; }
  const step = lines.slice(from, to).join('\n');
  assert.match(step, /requests=\(\\d\+\) connections=\(\\d\+\)/, '探针步骤要按两个数去解析');
  assert.match(step, /if \(\$con \* 2 -gt \$req\)/, '平均每条连接不到 2 个请求时必须红 —— 那说明没复用');
});

// 玩家报"白屏 / 立绘没出来"时，出问题的只有那一台机器，而 release 壳没有控制台。
// WebView2 自带检查器，开它的代价只是一个 feature 名 —— 没有它，那台机器上没有任何地方能看见错误。
test('the release Tauri build keeps F12 (devtools)', () => {
  const cargo = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.match(cargo, /tauri = \{[^}]*features = \[[^\]]*"devtools"[^\]]*\]/,
    'Tauri 只在 debug 构建默认开 devtools；release 里 F12 需要这个 feature');
});

// 单实例：先看内核对象，再看端口。顺序错了就会开出第二个 origin —— 而 localStorage 是按 origin 存的。
test('a second launch is caught by a kernel object before the port is bound', () => {
  const main = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'main.rs'), 'utf8');
  assert.match(main, /#\[link\(name = "kernel32"\)\]/, 'CreateMutexW 用 #[link] 声明，和 MessageBoxW 一样不加依赖');
  assert.match(main, /fn CreateMutexW\(/);
  assert.match(main, /const ERROR_ALREADY_EXISTS: u32 = 183;/);
  const mutex = main.indexOf('if already_running()');
  const probe = main.indexOf('if occupied_by_us()?');
  const bind = main.indexOf('server::spawn_server(');
  assert.ok(mutex > 0 && mutex < probe && probe < bind, '必须是 互斥量 → 端口探针 → 绑端口');

  // 端口被挪走时不许静默：那等于换 origin，代号/编队/设置在这个窗口里就是空的
  assert.match(main, /if port != server::DEFAULT_PORT \{[\s\S]{0,600}?popup\(/,
    '换了端口必须弹一句解释（探针模式下 popup 自己会跳过）');
  const cargo = fs.readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.ok(!/windows-sys|windows = /.test(cargo), '这条路径刻意不用 windows 绑定 crate');
});
