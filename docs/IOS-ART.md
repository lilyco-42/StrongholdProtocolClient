# iPhone 只剩头像 —— 立绘在 iOS 上不显示（2026-10-08）

玩家报告（v0.2.1-c24 的 ipa）：**「ipa 没有立绘，只显示了干员头像」**。
这份文档只写测到的东西，以及每条结论用哪条命令可以再跑一遍。

## 0. 现场落在哪一行

立绘的 `<img>` 在 `public/js/ui/gameComponents.js:65` 的 `Img` 里：

```js
if (!src || bad === src) return fallback;      // fallback = UnitThumb = 头像图
```

只有两种情况会显示 fallback：URL 是 null，或者这张 `<img>` **报过错**。
所以玩家看到的不是"版式把图挤掉了"，而是"立绘那张图失败了，代码按设计退回头像"。
（`UnitThumb` 自己图片再失败就只剩一个字母，见 :141 —— 所以"能看到头像"这件事本身也是一条信息。）

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

也就是说：**iOS 那个引擎读这套文件是没问题的**，包括懒加载和滚动容器两种写法。
顺带否证了我自己的一个猜想：如果"取消加载"会让 WebKit 发 `error`，`Img` 里 `bad === src` 那个闩就会把
一次取消变成永久 fallback（正好是"头像顶掉立绘"的样子）—— 实测 0/2 触发。至少在 Linux 的 WebKit 上不成立；
iOS 上的同一条没测（这一条是这次测量唯一没覆盖到的方向）。

## 3. 还剩下的嫌疑，和分辨它们最便宜的办法

| 嫌疑 | 需要什么证据 | 现在能拿到吗 |
| --- | --- | --- |
| Capacitor iOS 的 `capacitor://localhost` 走 `WKURLSchemeHandler`，高并发图片请求会丢 | 真机 | 探测脚本用的是 Node 静态服务，天生不复现这一条 |
| 手机内存（app 落地 865 MB，WebContent 进程有上限） | 真机 | 同上 |
| iOS 版本（README 的下限是 iOS 15；`loading="lazy"` 到 16.4 才被理睬，之前等于忽略=照样加载） | 一句话 | 能 |
| 现场其实是"所有图都读不到"，或者根本没进到有立绘的界面 | 一句话 | 能 |

**不改代码就能分岔的那一步**：同一台 iPhone 用 Safari 打开网页版 <https://sp.lain42.top/>，进 干员调配 看立绘。

- 网页版也没有立绘 → 与 ipa 的壳无关，问题在 iOS WebKit 配我们这套 DOM/图片，方向回到引擎；
- 网页版正常 → 差别就在打包壳（scheme handler / 内存），下一步才轮到改 `server.iosScheme`。
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
