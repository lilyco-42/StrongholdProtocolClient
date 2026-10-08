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
| **Spine 模型**在 iOS 上取 `.skel`/贴图超时或解析/上传失败 → 4 次重试后永久菱形（units.js:128/611） | 真机；或一个能在手机上打开的自检页 | 探测流水线只到"图片能取回并解码"，没走到 pixi-spine |
| Capacitor iOS 的 `capacitor://localhost` 走 `WKURLSchemeHandler`，高并发请求会丢 | 真机 | 探测用的是 Node 静态服务，天生不复现这一条 |
| 手机内存（app 落地 865 MB，WebContent 进程有上限，一局要同时挂好几个骨架） | 真机 | 同上 |
| iOS 版本（下限 15.0 是实测值；`loading="lazy"` 到 16.4 才被理睬，之前等于忽略=照样加载） | 一句话 | 能 |
| 现场其实是"所有图都读不到"，或者根本没进到有立绘的界面 | 一张截图 | 能 |

**不改代码就能分岔的那一步**：同一台 iPhone 用 Safari 打开网页版 <https://sp.lain42.top/>，
分别看 干员调配 的半身立绘 和 一局战斗里的干员模型。

- 两处都没有 → 与 ipa 的壳无关，问题在 iOS WebKit 配我们这套渲染（回到引擎/内存）；
- 只有战斗里没有、详情页有 → 嫌疑集中在 Spine 那一条（`PIXI / pixi-spine` 没就绪、或骨架上传失败），
  下一步是给 `assets.js` 的失败原因加一条能看见的出口（现在只在 console 里，手机上看不见）；
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

相关的另两份文档：`docs/PACKAGING.md`（五个形态与闸门顺序）、`docs/ANDROID-SIGNING.md`（另一条真机反馈）。
