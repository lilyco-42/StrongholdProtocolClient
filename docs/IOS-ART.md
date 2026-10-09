# iPhone 只剩头像 —— 立绘在 iOS 上不显示（2026-10-08）

玩家报告（v0.2.1-c24 的 ipa）：**「ipa 没有立绘，只显示了干员头像」**。
这份文档只写测到的东西，以及每条结论用哪条命令可以再跑一遍。

## 0. 现场可能落在哪两处（先别选一个当结论）

「只显示了干员头像」这句话对上两处不同的 fallback，两处都在游戏仓里，都能产出这个画面：

1. **半身立绘（`<img>`）**：`public/js/ui/gameComponents.js:65` 的 `Img` ——
   `if (!src || bad === src) return fallback;`，fallback 是 `UnitThumb`，用的正是头像图；
   头像图再失败才是字母（:141）。走到这条只能是"那张 `<img>` 报过错"或"URL 是 null"。
2. **战场上的干员（Spine 模型）**：`public/js/render/units.js:3-5` —— 单位先画"头像 + 稀有度菱形"，
   Spine 模型加载好再交叉淡入。模型失败或**超时**会按 `SPINE_RETRY_MS = [2000, 6000, 15000, 30000]`
   （units.js:128）**重试有限 4 次**，之后这个视图就一直是菱形（units.js:611），直到 `retryAssets()`
   被"清单迟到 / 标签页重新可见"重新唤起。

第 2 条值得单独记一句：它天生是**系统性**的观感 —— 一次失败扩散成整局都没有模型，
所以"整个 iPhone 都没有立绘"和"某一次战斗开始就没"这两种描述都指向它，而这两者在真机上不好区分。

## 0.5 代码层面已经排掉的三条（不用真机就能定）

| 猜想 | 为什么排除 |
| --- | --- |
| Capacitor 的 iOS 服务对 `.atlas` / `.skel` 给了错的 `Content-Type`，pixi 的加载器因此不走文本/字节 | 不是 mime 判断：`public/vendor/pixi-spine.js` 里两个解析扩展按**扩展名**匹配 —— `test(c){return checkExtension(c,".atlas")}` 且 `load` 是 `(await settings.ADAPTER.fetch(c)).text()`，`.skel` 同理走 `.arrayBuffer()`。服务器回什么 mime 都拿得到正确的字节 |
| iOS 15 缺 `Object.hasOwn` / `.at` / `findLast` / `structuredClone`，协议层或 UI 层直接抛 | `public/js/ui/compat.js` 在 `main.js` 最前面装好这几个（按能力检测，不按 UA），Safari 15.0–15.3 的缺口是已知并已补的 |
| `/vendor/three.core.js` 里有 6 处 class static block（要 Safari 16.4），iOS 15 会整块炸白 | 它是**动态** import 且带 `.then(…, () => null)`（`render/board3d/load.js:22`），解析失败就返回 null → 走注释里写明的 2D 棋盘 fallback。而 Spine 单位是 Pixi 画的，不依赖 three —— 所以这条影响棋盘，不影响立绘 |

ipa 的 `Info.plist` 实测：`MinimumOSVersion=15.0`、`CFBundleShortVersionString=0.2.1`、`CFBundleVersion=201`、
`NSAppTransportSecurity={NSAllowsArbitraryLoads:true}`（自签分发要连各种自签服务器，所以是全放行）。


## 1. 排除「文件没打进包」——用闸门，不是用临时脚本

`tools/check-payload-offline.mjs` 现在多了一项：两份美术清单里每个以 `/` 开头的 URL，都必须在产物里
**逐大小写**命中一个同名文件。用 `readdir` 出来的名字比，不用 `existsSync` —— 打包那台 Windows 机器分不清
`c1_1.png` 和 `C1_1.png`，而 iPhone 的 bundle 与线上 Linux 都分。

```
node tools/check-payload-offline.mjs --zip Stronghold-0.2.1-c22-ios-unsigned.ipa --prefix Payload/App.app/public/
node tools/check-payload-offline.mjs --zip Stronghold-0.2.1-c24-android-release.apk        # 默认前缀 assets/public/
node tools/check-payload-offline.mjs build/client/www                                       # 打包前的 payload 目录
```

2026-10-08 实测（ipa sha256 `2fa871d83daed60917b6a0d68e23b85cc3d84d54d34cf4b8e105c1847d1d801b`，604,431,076 B）：

| 项 | 值 |
| --- | --- |
| `data/assets.json` 里的 URL | 9,855 个，**缺失 0** |
| `data/local-assets.json` 里的 URL | 1,475 个，**缺失 0** |
| ipa 与 apk 的 web 根 | 同一批 **13,968** 个文件（865,509,668 / 865,509,692 B），唯一差异 `js/runtime-config.js`（363 / 387 B，平台配置） |
| 立绘的编码 | `char_003_kalts_1.png` 115,421 B：IHDR 180×360、8-bit RGBA、非隔行，chunk 只有 `IHDR IDAT IDAT IEND` —— 不是 APNG，不是 webp/avif |
| 最大的图 | 5 张 2048×2048 棋盘贴图（其中 1 张是 `.webp`，iOS 14 起支持），也都在包里 |

这个闸门以后每次打包都跑（desktop / android / ios 三个 job 都调它），测试在 `test/packaging.test.js`
的「art manifests …」5 条里；把比较换成 `existsSync`，那条只差大小写的用例立刻变红。

## 2. 排除「WebKit 读不了这批文件」——新流水线 probe-art-engines

`.github/workflows/probe-art-engines.yml`（手动触发）下载**已发布的那个 ipa**、解出 web 根，用一个和打包壳
行为一致的静态服务（不声明 `Accept-Ranges`、不发 `ETag`、`no-store`、MIME 自查表），让 chromium 与 webkit
各自把 127 个真实美术 URL 按四种方式加载一遍：

| 方式 | 问的问题 |
| --- | --- |
| `eager` | 引擎能不能解码并显示这些字节 |
| `lazy` | 加上客户端真正用的 `loading="lazy"`（`gameComponents.js:68`）有没有区别 |
| `scrolled` | 懒加载放在滚动容器里、先出视口再滚进来，会不会永远不加载 |
| `rerender` | 加载到一半把元素换成新的：被取消的那次会不会发 `error` |

run **37735653403**（2026-10-08，ubuntu-24.04，探的 ipa sha256 `41ddc05c36fe1d3323d37604ce363c0ada8a4c4a8f23a53aaa14ff01c91024ad`，604,432,277 B，解出 13,968 个文件）：

| engine | cases | fetch | eager | lazy | scrolled | dropped→error |
| --- | --- | --- | --- | --- | --- | --- |
| chromium | 127 | 127 | 127 | 127 | 127 | 0 |
| webkit | 127 | 127 | 127 | 127 | 127 | 0 |

- **阴性对照**：不存在的 `/assets/char/portrait/__art_probe_no_such_file__.png` 两个引擎都必须失败，
  驱动脚本在它"加载成功"时直接 exit 2 —— 否则这轮什么都证明不了。
- **阳性对照**：chromium 127/127，所以 webkit 的 127/127 不是"两边一起坏"。
- 退出码：0 一致 / 1 复现了（打印具体 URL）/ 2 探测本身不成立。这次是 0。

也就是说：**iOS 那个引擎读这批静态图字节是没问题的**，包括懒加载和滚动容器两种写法；
连 Spine 的贴图页（`assets/spine/op/.../<name>.png`，多为 512×512）也全部加载成功。
顺带否证了我自己的一个猜想：如果"取消加载"会让 WebKit 发 `error`，`Img` 里 `bad === src` 那个闩就会把
一次取消变成永久 fallback（正好是"头像顶掉立绘"的样子）—— 实测 0/2 触发。

**这条测量的边界要写清楚**：它测的是"浏览器能不能把这张图取回来并解码"，
用的是 Node 静态服务 + 软件渲染的 Linux WebKit。它**没有**覆盖：
`.skel` 取回来之后 pixi-spine 的解析、WebGL 贴图上载、iOS 的 GPU/内存上限、
以及 `capacitor://localhost` 这个自定义 scheme 自己会不会丢请求。
后四条是剩下的嫌疑人，也都是只有真机能回答的。

## 3. 还剩下的嫌疑，和分辨它们最便宜的办法

| 嫌疑 | 需要什么证据 | 现在能拿到吗 |
| --- | --- | --- |
| **Spine 模型**在 iOS 上取 `.skel`/贴图超时或解析/上传失败 → 4 次重试后永久菱形（units.js:128/611） | 真机；或一个能在手机上打开的自检页 | **自检页已存在**（游戏仓 `public/dev/spine-probe.html`，commit `66fb7151`），随 c27 的 payload 才到玩家手里 |
| Capacitor iOS 的 `capacitor://localhost` 走 `WKURLSchemeHandler`，高并发请求会丢 | 真机 | 探测用的是 Node 静态服务，天生不复现这一条 |
| 手机内存（app 落地 865 MB，WebContent 进程有上限，一局要同时挂好几个骨架） | 真机 | 同上 |
| iOS 版本（下限 15.0 是实测值；`loading="lazy"` 到 16.4 才被理睬，之前等于忽略=照样加载） | 一句话 | 能 |
| 现场其实是"所有图都读不到"，或者根本没进到有立绘的界面 | 一张截图 | 能 |

**自检页（现在最便宜的那一步）**：游戏仓 `public/dev/spine-probe.html` + `.js`，在手机浏览器或 app 里打开
`/dev/spine-probe.html` 就行，它把四件事分开测、每层单独 try/catch（一层炸了不带走整页 —— 那行正是要读的东西）：

1. **静态图片**（`new Image`）——玩家报"头像能显示"，所以这层必须是好的；它坏了后面三层无从谈起；
2. **`fetch` `.skel` / `.atlas`** ——字节数、Content-Type、用的哪个 scheme，这是传输层（scheme handler / ATS）；
3. **`assets.spine.acquire()`** ——走**生产同一条路径**（`PIXI.Assets.load` + pixi-spine），报动画个数或错误原文；
4. **连续 acquire 多个不释放** ——内存/驱逐那一层，附带 `spine.stats()` 与 JS 堆（有的浏览器才报得出）。

页顶那句结论按"哪一层先坏"给，于是 §0 那两处现场、以及上表三条嫌疑，第一次有了互相分得开的读数。
两条对照也在：**阴性**是一个不存在的骨架，必须失败（它要是成功，上面所有"成功"都没意义），而且它从
**真实条目改文件名**构造 —— 自造对象会被 `validSpine`（`assets.js:227`，还要求 `anims` 是对象）先拦下，
那行报的失败就是校验器的功劳而不是加载器的；**探针自身**在 PIXI / PIXI.spine 缺失时直接把结论标成不可读。
①②各带 12 秒超时并单独报"12 秒没回（挂住）"，因为"请求永远不返回"本身就是 iOS 上一种可能的故障形状，
让它挂住就等于没有报告。结果同时挂在 `window.__SPINE_PROBE__`，所以 `probe-art-engines.yml` 以后能在 CI 里
跑同一页 —— 同一份数字有真机与 CI 引擎两个来源。

**不改代码也能分岔的第二步**：同一台 iPhone 用 Safari 打开网页版 <https://sp.lain42.top/>，
分别看 干员调配 的半身立绘 和 一局战斗里的干员模型。

- 两处都没有 → 与 ipa 的壳无关，问题在 iOS WebKit 配我们这套渲染（回到引擎/内存）；
- 只有战斗里没有、详情页有 → 嫌疑集中在 Spine 那一条（`PIXI / pixi-spine` 没就绪、或骨架上传失败），
  这时候直接开上面那个自检页读 ③④ 两行（失败原因以前只在 console 里，手机上看不见 —— 页面上现在看得见）；
- 网页版两处都正常 → 差别就在打包壳（scheme handler / 内存），才轮到改 `server.iosScheme`。
  **不要盲改**：换 scheme 会换 localStorage 的来源，而玩家的编队自选、皮肤解锁、服务器选择都存在那里 ——
  改之前要先量清楚，改之后要验证老数据还在。

## 4. 重跑

```
gh workflow run probe-art-engines.yml --ref main \
  -f release_tag=v0.2.1-c24 \
  -f asset=Stronghold-0.2.1-c24-ios-unsigned.ipa \
  -f web_subpath=Payload/App.app/public
```

apk 就换成 `-f asset=…apk -f web_subpath=assets/public`；桌面 zip 同理。结果 JSON（每个 URL 的事件序列、
`naturalWidth`、fetch 的 status/type/bytes）在 artifact `探测结果-art-probe` 里，跑一次约 3 分钟。
本地想只看清单不看浏览器：`node tools/art-probe.mjs --root <解出的 web 根> --list`（128 条，65 组，
每组按声明尺寸留最大的，所以 2048×2048 那张一定在列表里）。

**自检页**（四层分开测，见 §3）不需要任何工具，浏览器打开就行；本地想先看一眼：

```
cd <游戏仓> && PORT=47993 HOST=127.0.0.1 SP_NO_BROWSER=1 node server/index.js   # 只读地起一份源码服
# 然后开 http://127.0.0.1:47993/dev/spine-probe.html
```

参数 `?ids=<chessId,…>` 指定要测的干员（默认取清单里前三个有 spine 的，按 id 排序，所以不同人报的号能对上同一批），
`?many=<n>` 改第 ⑦ 层（不释放地连加载）的数量。它随 payload 进 app，因此**要到 c27 之后**玩家那边才点得开。

相关的另两份文档：`docs/PACKAGING.md`（五个形态与闸门顺序、§17 网友服复测、§18 F11）、`docs/ANDROID-SIGNING.md`（另一条真机反馈）。

## 5. 静态图之外：让两个引擎各跑一遍**包里的** Spine 自检页

§2 那条流水线证明的是「同一批文件在 webkit 里 load 得和 chromium 一样」。但玩家说的是**立绘整层不见**，
而立绘不是 `<img>`：它是 `.skel` + `.atlas` + 贴图交给 pixi-spine，还要一个 WebGL 上下文，以及一次装下好几个骨架的内存。
这条路径静态探针碰不到，所以 `probe-art-engines.yml` 现在有第二步，跑 `tools/spine-probe-check.mjs`：
它把 payload 的 web 根用同源静态服务起起来，让 chromium 与 webkit 各自打开**包里那一页**
`/dev/spine-probe.html`（同一个页面，玩家在 app 里点「立绘自检」看到的就是它），读 `window.__SPINE_PROBE__` 逐行对照。

* 参与判定：① 运行时、③ 图片、④ fetch .skel/.atlas、⑤ acquire、⑥ 阴性对照。
* 只报告不判定：② WebGL、⑦ 连续加载。② 在这台 runner 上是软件管线，跟 iPhone 的 GPU 不是一回事；
  ⑦ 会把内存顶到引擎放手为止，共享 runner 给多少 RAM 决定它在哪一步停 —— 这两条当闸门只会让人学会重跑。
* 三道 fail-closed：包里没有那一页 / `__SPINE_PROBE__` 一直没出现 / 阴性对照没有「如期失败」，都退 **2**
  （探测本身不成立），不会伪装成 0。还有一道是给闸门自己的：`GATED` 里任何一族在参照引擎里一行都没出现，
  也退 2 —— 否则「两边一致」等于「什么都没比」。

退出码与 §2 一致：0 两边结论一致；1 = 复现（打印是哪几行、两边各说什么）；2 = 探测不成立。
本地读结果：`gh run download <run> -n 探测结果-art-probe` 里有 `spine-probe-chromium.json` / `spine-probe-webkit.json`。

## 6. 第一次真跑就抓到的两个自坏（2026-10-09，游戏仓 `feat/skins` 642a8bb4 / 082fc0a8）

两个引擎都 HTTP 200、都跑完了这一页，然后各报一句「四层全通过」而只有 4 行 —— 红的是这一页自己：

1. **问美术索引用错了键**。`candidates()` 拿 chess 记录的 `rec.id`（`chess_char_1_01_a`）去问 `assets.spineEntry`，
   而 `data/assets.json` 的 `chars` 是按 charId（`char_498_inside`）键的。照这一页自己的谓词（`validSpine(front)`：
   `skel` 要匹配 `/...skel`、要有 `atlas` 字符串、`anims` 得是对象）实测这份树：266 条 chess 记录里按 charId
   去重后有 **121** 个干员合格，按 chessId 一个都问不到。于是这一页从 c27 进包起，对任何设备都只会说
   「没找到任何带 spine 的干员」。干员在棋盘上取模型用的是同一条规则（`render/units.js` 的 `info.spine || info.defId`）。
2. **「空」被报成「没问题」**。两处载入写成 `loadAll('chess').then(() => assets.ready()).catch(() => null)` 一个
   catch —— 失败被伪装成"清单里没有这一项"；而 `finish()` 的结论梯子根本没有 `清单` / `探针异常` 这一格，
   于是后面全空的时候落到最后那句「四层全通过」。

所以这一页现在：① 运行时与 ② WebGL 先跑（它们不依赖清单，"PIXI 缺失"往往正是清单为空的原因），两处载入各自
try/catch 并把 `ready=` · 棋盘条数 · 报错原文写进 `清单` 那一行，`finish()` 第一条分支就是"清单没起来 / 探针炸了 →
这一页什么都没证明"。`test/client-static.test.js` 钉住键与这两条形状（不许 `spineEntry(rec.id`、不许
`.catch(() => null)`、必须有那一格），由客户端仓的 `test-game-branch` lane 跑 —— 游戏 fork 自己没有 CI。

**这一层仍然只有真机能定论**：CI 的两个引擎都在 Linux 上，iPhone 的 Capacitor 自定义 scheme 与手机内存压力不在
这条路上。修好的意义是让玩家点「立绘自检」能拿到一句**可信**的话，而不是"看着一切正常"。
