# AGENTS.md — 给 AI 的开发说明书（本仓库 = Stronghold 客户端打包壳）

本项目**完全由 AI 开发**。因此这里的每条约定都必须**可执行、可验证**：不写"通常/大概/应该"，
只写命令能证伪的事实。改代码前先读这份，改完必须让下面的闸门真的跑过。

## 1. 三个仓库，职责不重叠

| 仓库 | 角色 | 硬约束 |
|---|---|---|
| `sganggs/Stronghold-Protocol`（游戏本体，GPL-3.0） | 游戏代码/数据 | **本仓库永不修改它**。`docs/PACKAGING.md:375` |
| 本仓库 `lilyco-42/StrongholdProtocolClient` | 壳 + 打包 + CI | 只放壳、补丁、payload 流程 |
| `lilyco-42/lain42-stronghold-ops` | 线上运维改动集 | 服务器侧改动记在这里 |

对游戏仓库只有 `pull` 权限 → 改动走 **fork + PR**（`gh repo fork` → 推分支 → PR）。

## 2. 线上是不可动的（真实代价）

- `systemctl restart stronghold` = **杀掉所有进行中的对局**（房间在单进程内存里；晚高峰实测 ~281 人 / 162 场）。
- `pingap` reload 只断线 1–3 秒，对局不丢。**别把两者混为一谈。**
- `public/`、`data/`、`pages/` 是**从磁盘直读**的，改一行立刻打到在线玩家。
- `dl.lain42.top/downloads/stronghold-protocol/**` 是**线上网页正在用的素材源**（`data/assets.json` 被
  运维改成 OSS 绝对地址）。CI 默认 payload 就在那儿 —— **不要覆盖**，新版本 payload 发到自己仓库的 Release。

## 3. 构建流程（顺序不能换，也不许本地编译）

```bash
# 1) 生成 payload（在素材齐全的游戏 checkout 上；只有这一步在本机/服务器做）
node tools/package-client.mjs --server sp.lain42.top --game <游戏仓库checkout> --out <dir>
#    → build.json 记录 game.app / commit / dirty；素材来自 git（不进 repo）需 `npm run assets`
tar -czf payload.tar.gz -C <dir> .            # 布局：./index.html ./js ./assets …（CI 直接 tar -xzf）

# 2) 发布 payload（自己的仓库，公开资产，CI 才能匿名 302 拉取；draft 会 403）
gh release create payload-<ver> <tar.gz> --repo lilyco-42/StrongholdProtocolClient --title … --notes …

# 3) 出 Windows + Android（**只能在 GitHub Actions**，不在本机）
gh workflow run build-clients.yml -f payload_url=<release 资产 URL> -f expect_app=<ver>
```

`build-clients.yml` 的两个校验步骤是**闸门**，不是装饰：
`assets` 文件数 > 3000，以及 `expect_app` 必须等于 payload 的 `game.app`。
**没有第二条闸门时，CI 会绿着发布旧 payload**（0.1.1 就这么混出去过两次，见 `docs/BUILD-CI.md`）。

## 4. `patches/game-client.patch`：漂移会大声失败，这是设计

补丁只放**打包特有部分**（服务器地址注入、短屏 HUD 缩放、邀请链接指向远程站）；游戏行为一律提上游 PR。

上游一改 `public/index.html` / `js/net.js` / `js/screens/room.js`，`package-client.mjs` 就会抛
`hunk @@ -N,M @@ does not match`。正确修法是**改那一条上下文**，别放宽匹配。

改完必须同步这三处，否则数字会互相说谎：

| 位置 | 内容 |
|---|---|
| `test/packaging.test.js` `files.length` | 被打补丁的文件数（现 3） |
| `test/packaging.test.js` hunk 总数 | 现 7（`index.html` 2 + `net.js` 3 + `room.js` 2） |
| `docs/PACKAGING.md` "N 个文件、N 个 hunk" | 同上 |

## 5. 跨版本兼容：唯一信号是 `/healthz.app`

`PROTOCOL_VERSION` **不能**区分版本（0.1.1 和 0.1.3 都是 `1`，上游没升它）。实测：

- 版本只在 `GET /healthz` → `{app, protocol, …}`；`server/index.js:665`
- 服务器**没有**在 socket 的 welcome 里回传版本
- 旧服务器遇到新动词回：`{t:'error', code:'BAD_MSG', detail:'unknown type <verb>'}`
  （`server/net.js:588` 在协议表层就拦下；`server/lobby.js:296` 的 `unhandled type` 只有"表里有、switch 没接"才走得到。
  两个形状都要认 —— 只写后者会让整条学习路径静默失效，我踩过。）
- `/healthz` 的 URL 从**生效的 ws 地址**推导：页面源 == 服务器源 → 相对 `/healthz`；打包客户端（页面在
  `127.0.0.1:47821`，socket 在远程）→ 绝对地址。写死相对路径会让 exe/apk 里的 `buildGuard` 永远 404。
- 读不到（自建服没 CORS）= **unknown，一律乐观放行**，禁止把功能锁死；真正的权威是服务器那次拒绝本身。

## 6. 只有这些算证据（写结论时按此措辞）

1. `gh run view <id> --json conclusion` —— **不是** `gh run watch` 的 shell 退出码（末尾命令是 `tail` 时退出码毫无意义，踩过两次）。
2. 产物必须**下载拆开再看**：`unzip -p … resources/app.asar | grep -c <函数名>`、读 `resources/www/build.json`。
   只想确认"发布出去的那份字节里入口页还有没有外链"时，不用拉整包 —— 运维仓库 `scripts/spotcheck-release-entry.py`
   用 zip 中央目录 + 单条 Range 就能取出来（~1 MB）。2026-10-05 16:09 这样实测 `v0.1.3-compat`：
   桌面 `…/resources/www/index.html` 与 APK `assets/public/index.html` 未压缩都是 **6,684 B**，两份都是
   **2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com`、`/webfonts/google/google.css` 0 次** —— 字体镜像确实还没出厂。
   ⚠️ Git Bash 会把 `/webfonts/…` 这类前导斜杠参数改写成 Windows 路径，那个 0 就成了假 0，先 `export MSYS2_ARG_CONV_EXCL='*'`。
3. 界面行为要在真实页面里点出来（`document.querySelector('.join-spectate').disabled`），
   并**排除混淆变量**：观战按钮的表达式是 `!codeOk || !online || spectateBlocked`，密钥框空着时它本来就是灰的 ——
   我曾据此报过一次假阳性。
4. 任何状态里提到的文件名/分支/run 号，上面必须有一条命令的输出压着它。没有就先跑。
5. `node --test` 的通过数要写实际数字。**本仓库**当前 `npm test` = **75 项 / 75 过 / 0 失败**（2026-10-05 16:53，
   其中 3 项是镜像字体的行为/闸门测试：壳发镜像（mime+长缓存+逃逸）、纯静态等价道、payload 出处；
   把 `LONG_CACHE_DIRS` 里的 `webfonts` 删掉或把 `build.json` 的 `dirty` 改成 true，都会让对应那条红）。
   游戏仓库全量当前 **3643 项 / 3624 过 / 3 失败 / 16 跳过**（2026-10-05 16:41，`3dd1a2c`）：
   并行整跑时红的三条都是 CPU 阈值闸 —— `test/sim/perf.test.js:22`、`test/sim/perf.test.js:43`、`test/sim/robustness.test.js:739`；
   **这批文件单独复跑 37/37 全过**，且本分支没碰 `server/sim/**`、也没改这几个测试文件
   （`git diff upstream/master..HEAD -- server/sim test/sim` 为空）—— 是本机负载，不是回归。
   ⚠️ 同一天里整跑红的条数出现过 1、2、3 —— 别拿条数当判据，只看"红的是不是那几条阈值闸"。
   ⚠️ 这条**没有 CI 可依赖**：游戏 fork 的 Actions 开关虽开，workflow 从未注册（runs 为 0、`gh workflow run ci.yml`
   报 "not found on the default branch"），所以游戏侧证据只有本机 `npm test`；细节见游戏仓库 `AGENTS.md` §5。

## 7. 已知未修（别当成已解决）

- 打包 `index.html` 的 **Google Fonts 外链**：已在**源头**改掉（游戏 fork 分支把整套字形镜像进仓库，见 §8），
  但**已发布的产物仍带着外链**，直到用新 payload 重跑一次 CI。新闸门 `零外部依赖（闸门）`
  （`tools/check-payload-offline.mjs`，还能 `--zip` 读 APK 的 zip 条目 —— 整包 grep 是 0 命中，条目里才有）会拦住这种"旧 payload 出产物"，而且已在 CI 里咬过：用旧 payload `payload-v0.1.3-c5`
  跑的 run `37270463759` 结论 **failure**，desktop 与 android 两个 job 都恰好死在 `零外部依赖（闸门）`，
  日志点名 `index.html` / `dev/uikit.html` 引用 `fonts.googleapis.com` 且缺 `webfonts/google/google.css`；
  换成新 payload 就是绿的。网页版那份 `index.html` 仍带外链 —— 2026-10-05 14:20 的覆盖式升级把线上换成了**上游 0.1.3** 的 index.html，
  我的镜像与 OSS 前端改写都不在那份文件里（运维仓库 `docs/12-prod-0.1.3-overlay.md`），要重放而不是直接编辑热文件。
- Android 侧 `/media/…` 音频路由：已修好在**产物**层面 —— Capacitor 是纯静态宿主，解不了无扩展名的别名，
  所以不给它补等价机制，而是让 `public/js/media.js` 的 `mediaAliasEnabled()` 在 `__SP_MEDIA_ALIAS__ === false` 时
  直接保留 `/assets/audio/…` 真地址，Android job 在 `cap sync` 前把这行 flag 追加进 `build/client/www/js/runtime-config.js`
  （桌面那份必须没有，否则桌面反而丢音频）。核对过的证据：已发布 APK（sha256 `27eadc94…`，224,848,906 B）内
  `assets/public/js/media.js` 有 `mediaAliasEnabled` 2 处、`assets/public/js/runtime-config.js` 以
  `globalThis.__SP_MEDIA_ALIAS__ = false;` 结尾、`assets/public/assets/audio/` 下 **517 个 `.mp3`** 条目齐全；
  单元侧由游戏仓库 `test/media-url.test.js` 钉住。
  ⚠️ 这只到"拆包 + 单测 + 纯静态等价道"，**没有**真机 Android 跑过 BGM —— 要写"已验证"必须补真机。
- 大厅平台（另一套 Flask 服务，不在本仓库）：注册 400（`site.json` 与 `SKIP_EMAIL_VERIFY` 环境变量不一致）——
  修法与回归测试已备好在游戏运维仓库 `lain42-stronghold-ops`（`docs/10-lobby-register-400.md`、
  `scripts/patch-lobby-skip-email-verify.py`），**线上未部署**；库里 0 房间 / 1 用户、没有"从大厅选房→进游戏"的交接、
  商店在卖聊天发不出的 `表情包套装`。
- Actions artifact 只保 **7 天**；长期分发要另发 Release。

## 8. 当前发布状态（可核对，不要凭记忆写）

| 东西 | 位置 / 标识 | 怎么核对 |
|---|---|---|
| 玩家可下载的产物 | Release tag `v0.1.3-compat`（本仓库）：桌面 zip 353,439,776 B + android debug apk 224,848,906 B | `gh api repos/lilyco-42/StrongholdProtocolClient/releases/tags/v0.1.3-compat --jq '.assets[]|[,]'`，GitHub 的 `digest` 就是 sha256，与本机 `sha256sum` 逐字节相等才算上传完好 |
| CI 构建 | run `37225727424`（desktop + android 均 success），触发时传 `expect_app=0.1.3` | `gh run view <id> --json conclusion` —— **不要**用 `gh run watch` 的 shell 退出码 |
| CI 读的 payload | Release tag `payload-v0.1.3-c5`（游戏代码 = fork 分支 `feat/net-cross-version-capability` @ `a2ccc3a`，`v0.1.3-5-ga2ccc3a`，`dirty:false`） | 产物内 `resources/www/build.json` |
| **待发布的 payload**（含字体镜像） | 本机 `D:/Code/_artifacts/sp-client-payload-0.1.3-c10.tar.gz`：**221,350,850 B**，sha256 `234ee9625fb844789d82289cad4f9a2bdaf491c622db8c2151eea752ff1fec36`，游戏代码 `v0.1.3-16-g603b94c`（4368 个文件 / 295.3 MB，`webfonts/google/` 114 条目，含 #110 新增的 2 条 corrosion BGM）。c8（4366 文件 / `v0.1.3-8-g86719d1`）在合并上游 `bd892a4` 之后**已作废**；c9 也随之作废 —— 期间有人往本仓库推了 `f101ef3`（版本号对齐 0.1.3 + 重新生成 `patches/game-client.patch`），payload 是在**合并之后的仓库状态**上重打的（补丁仍是 3 文件 7 hunk，对 fork 树与纯净上游树都干净可打）。**尚未上传**，上传与 `gh workflow run` 需要人点头 | `node tools/check-payload-offline.mjs D:/Code/_artifacts/payload-c10`（0 问题）；`tar -xOf … ./build.json` 读 `game.describe`；`tar -tzf … | grep -c corrosion` 应为 2 |
| 线上服务器 | **0.1.3**（`/healthz.app`），且**线级能力已补齐**：15:59 实测三个 0.1.3 动词全部 `handled`（14:20:24 CST 别人覆盖式部署，15:33:25 CST 又重启过一次）| `systemctl show stronghold -p ExecMainStartTimestamp`；`node ../lain42-stronghold-ops/scripts/probe-server-capability.mjs wss://sp.lain42.top/ws room.spectate room.kick room.removeSpectator room.join room.notARealVerb` → rc=0。**注意**别拿线上那份 checkout 的 `git log` 当版本证据（HEAD 仍 `8b10625` 而有 177 个 ` M`），且 `shared/protocol.js`（md5 `a17f47ae…`）比 v0.1.3 多一条手写的 `hello.z` 校验 —— 整份覆盖会冲掉，详见运维 `docs/12` §5 |

CI 现在有**五道**闸门：payload 完整性、`expect_app` 版本、`payload 出处（闸门）`、`零外部依赖（闸门）`（暂存 payload）、`零外部依赖（产物内，闸门）`（出厂字节：桌面扫 `resources/www`，APK 用 `--zip` 按条目扫）。
⚠️ 出处那道是 2026-10-05 加的，起因是实测：workflow 的**默认** `payload_url`（OSS 上 `sp-client-payload.tar.gz`，195,809,375 B，15:40:49 CST 被换过）内嵌 `build.json` 是 `describe:"v0.1.3-dirty"`、`dirty:true` ——
版本号与离线两道闸门都会放行它，于是 CI 会绿着发一个**追不到 commit** 的产物。判据：`dirty` 必须 `false`，`describe` 必须以 `-g<7+ 位 hex>` 结尾（`git describe` 正好落在 tag 上时也没有这段，同样拦）。
产物内必须能查到这三样（每次发布都重验，别沿用旧结论）：`app.asar` 里 `resolveMediaPath` ≥1；payload `js/net.js` 里 `serverKey`；APK 内 `assets/public/js/runtime-config.js` 含 `__SP_MEDIA_ALIAS__ = false`（桌面那份必须**没有**）。

跨版本识别在生产上的实测（同一份产物，当时线上是 0.1.1）：连线上 0.1.1 → `serverApp='0.1.1'`、`probeFailed:false`，观战/移出成员/移出观战者三处 `ok:false reason:'older-server'`（点之前就识别到，因为生产 `/healthz` 有 CORS），`room.join` 仍 `ok:true`；连 0.1.3 → `确认本局信息` 正常开局。

⚠️ **`/healthz.app` 不等于服务器能力**（2026-10-05 一天里两个答案都实测到过，所以这条只能现跑、不能引用文档）：
15:09 线上 `/healthz.app` 报 `0.1.3`，但真 socket 问 `room.spectate` / `room.kick` / `room.removeSpectator` 三个全部回
`BAD_MSG unknown type …`，而 `room.join` 回业务级 `ROOM_NOT_FOUND` —— 因为运维那两次部署是混合文件
（`server/lobby.js` 已 0.1.3、`shared/protocol.js` 还是 0.1.1，`server/net.js:587` 查的是后者那张 `C2S` 表）。
**15:59 复测同一条命令：四个全部 `handled`、rc=0**（15:33:25 CST 有人重启过服务，本仓库这边全程只读没动它），
那张 `C2S` 表现在认得三个动词 —— 也就是对**生产**不再需要"点一次才灰"，被动学习那条路留给更老的自建服与分叉。
判定别只看版本号，用运维仓库的 `probe-server-capability.mjs`（自带正控制；注意 hello 的 `name` 要短，
`'CapabilityProbe'` 会收不到 welcome、探测全超时；脚本已改成**正控制不计入缺失能力**，早先每一次运行都固定报"缺 1 个"）。

自托管字体（已定案，不是待办）：**带 Chrome UA** 请求那条 css2 会得到 **421 个 @font-face / 112 个 woff2 / 4.84 MB**
（不带 UA 的 11 个 / 43.3 MB 是未切片的旧格式，别拿它做决策）。游戏仓库 `tools/fetch-webfonts.mjs` 按这个把整套字形
镜像进 `public/webfonts/google/`，`--check --verify-bytes` 逐个比 sha256 —— 实测 **112/112 与 Google 当前字节一致**，
所以"观感不变"是字节级的相等，不是"差不多"。payload 侧由 `tools/check-payload-offline.mjs` 守住镜像完整。
