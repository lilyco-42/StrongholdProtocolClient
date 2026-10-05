# Stronghold Protocol · 端侧客户端打包

把《卫戍协议：盟约》的浏览器客户端打成 **Windows 客户端**（Electron）和 **Android `.apk`**（Capacitor）：素材与代码从本地读（进对局不用重新下载约 260 MB 素材），房间、回合、联机仍然走服务器。

`tools/package-client.mjs` 的代码默认值是 `localhost:3000`（自己开服用），但**发出去的产物不用它**：CI 打包时传 `--server sp.lain42.top`，所以你现在下载的 exe/apk 里那份 `js/runtime-config.js` 写的是 `globalThis.__SP_SERVER__ = "sp.lain42.top"`（2026-10-05 从发布 APK 里解出来核过）。想临时换服务器用 `--server <地址>` 或 `?server=`。

游戏本体（Node 服务器 + 浏览器客户端，GPL-3.0）是**另一个仓库**：上游 <https://github.com/sganggs/Stronghold-Protocol>。
本仓库只放"壳"和打包流程，**从不修改游戏仓库**——客户端要的那 3 处改动以补丁形式打在 payload 上（见下）。

```
npm run release             # 一键发布：对齐上游版本号 → 跑测试 → 打 exe(+zip) 与 apk → git 提交（入口 package.bat / package.sh）
npm run client:desktop      # → build/desktop/win-unpacked/（exe + 依赖目录，约 585 MB，双击即开）
npm run client:android      # → mobile/android/app/build/outputs/apk/debug/app-debug.apk（约 192 MB）
npm run client:build        # 只生成 build/client/www（想用自己的静态托管时用）
npm test                    # 打包流程的单元/契约测试（无游戏 checkout 时相关用例自动跳过）
```

详细说明（Android SDK 准备、签名、**服务器公告**、排错、**部署与重启**、**查服务器忙不忙**）见 **[docs/PACKAGING.md](docs/PACKAGING.md)**；服务器上的发版自动化（钩子/定时器脚本 `deploy/`）见 **[docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md)**。

## 玩家上手（不用会编译，只要装和玩）

东西在 GitHub 的 **Releases** 里（仓库页 → Releases → 最新的 `v0.1.3-c11`），一共两个文件，下自己那台设备要用的那个：

| 你要玩的设备 | 下载 | 大小 | 怎么装 |
|---|---|---|---|
| Windows 10/11（64 位） | `StrongholdProtocol-desktop-win-x64-0.1.3-c11.zip` | 360,850,482 B（约 344 MiB） | 解压，**整个文件夹一起放着**，双击里面的 `StrongholdProtocol.exe` |
| 安卓手机（Android 7.0 及以上） | `Stronghold-0.1.3-c11-android-debug.apk` | 232,320,951 B（约 222 MiB） | 传到手机 → 点开除 → 允许"未知来源/安装未知应用" |

国内下载慢就用 OSS 镜像（同一批字节，文件名一致）：

```
https://dl.lain42.top/downloads/stronghold-protocol/0.1.3-c11/StrongholdProtocol-desktop-win-x64-0.1.3-c11.zip
https://dl.lain42.top/downloads/stronghold-protocol/0.1.3-c11/Stronghold-0.1.3-c11-android-debug.apk
```

不确定下到的文件是不是完好的，对一下指纹（GitHub 每个资产的 `digest` 就是 sha256）：

```
sha256sum StrongholdProtocol-desktop-win-x64-0.1.3-c11.zip
gh api repos/lilyco-42/StrongholdProtocolClient/releases/tags/v0.1.3-c11 --jq '.assets[]|[.name,.digest]|@tsv'
```
两个 sha256 必须**逐字节相等**才算下载完好（不相等多半是没下全，重下即可）。

### 第一次打开

1. 会先看到一个菜单页（不是直接进游戏）。选**多人游戏**。
2. 列表里已经有几条可用的服务器了：`默认服务器 sp.lain42.top`（我们自己那台）＋ 五条**网友服**（`网友服 · misyra / rainya / rainya:10166 / linxia / xiaolubao`，第一次启动自动列进来）。哪条绿灯点哪条；网友服随关随开，**点了 × 就永久删掉**，不会下次又冒回来。
3. 绿灯才是真能连进去（探测直接开 `/ws`，和进游戏用的是同一条通道；协议与路径的几种可能同时都试）。红灯会多说一句"对方在线，但 `/ws` 没通"，那是对方服务器的问题，不是你的地址写错了。双击进入。
4. 想加自己知道的别的服：点**添加服务器**，名字随便填，地址**直接粘贴别人给你的网页链接**就行（`https://host/play` 这种也认）——**不用写 `ws://` 前缀**，也不用猜它挂在根路径还是 `/play`，程序两种都试。
5. 之后想换服务器：桌面按 **F2**（或给 exe 加 `--choose-server`）；手机每次都回到这个菜单，属于有意为之——手机没有 F2，免得选完回不去。

### iPhone 玩家看这里（.ipa 要自己签）

安卓和 Windows 是下完就能装；**iOS 不行** —— 苹果要求每个 app 都有签名。我们**没有**开发者账号，也不会去向苹果申请，
所以发的是**未签名 `.ipa`**，由玩家用**自己的免费 Apple ID** 签一下再装（工具：AltServer / Sideloadly / SideStore 任一，
需要一台电脑）。这是 Apple 侧的规则，不是我们偷懒。

| 你要知道的 | 事实 |
|---|---|
| 最低系统 | **iOS 15 及以上**（Capacitor 8.5.2 的 SPM 声明 `.iOS(.v15)`，不是随手写的数字） |
| 有效期 | 免费 Apple ID 签出来的包 **7 天过期**，到期要连电脑重签一次 |
| 数量限制 | 同一个免费 Apple ID 最多 **3 个**自签应用（其中还要占一个给签名工具本身） |
| 体积 | 约 300 MB（美术音频全在包里，进对局不下载），建议 WiFi 下装，手机留出 1 GB 空闲 |
| 声音 | 首次点一下屏幕才有 BGM —— iOS 要求音频必须由用户手势解锁，游戏里已做（`audio.js` 的 `pointerdown/touchend/click/keydown`） |
| 方向 | 锁横屏（`Info.plist` 只声明 LandscapeLeft/Right）；刘海区已按 `viewport-fit=cover` + safe-area 处理 |
| 连自建服 | 已放开 ATS，所以 `ws://192.168.1.9:3000` 这种明文地址能连（对应安卓的 `allowMixedContent`） |

下载（和 exe/apk 在同一个 Release 页 `v0.1.3-c12`）：

```
https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/v0.1.3-c12/Stronghold-0.1.3-c12-ios-unsigned.ipa
```

装到手机的步骤（玩家自己做，我们不提供证书也不代签）：

1. 电脑装 **AltServer**（macOS / Windows 都有）或 **Sideloadly**，登录**你自己的 Apple ID**（免费账号即可，不用开发者账号）。
2. 手机数据线连电脑 → 信任这台电脑 → 把上面那个 `.ipa` 拖进 AltServer / Sideloadly → 它会用你的 Apple ID 现签再装。
3. 手机上「设置 → 通用 → VPN 与设备管理」里点开你那个 Apple ID 的描述文件 → 信任 → 打开 App。
4. **每 7 天要重复一次第 2 步**（免费签名的有效期是 Apple 定的）；同一个免费 Apple ID 名下最多 3 个自签应用。

**签名请自己完成：我们不提供证书、不代签、也不要拿这个包去上架** ——
包里的《明日方舟》素材版权归鹰角/Yostar，仅供个人非商业自用。

### 桌面版几个省事的小知识

- **一定要整个文件夹一起用**。只把 `StrongholdProtocol.exe` 拷走会打不开（缺 DLL 和 `resources/`）。换机器就重新解压一份，别拷单个 exe。
- **进度、身份、设置不会丢**：桌面壳固定用 `127.0.0.1:47821` 这个本地地址提供服务（`localStorage` 按地址隔离，端口每次随机等于每次都是全新安装）。如果 47821 被别的程序占了，会自动往后试 16 个端口。
- **存档/日志位置**（要报告问题时把它的前几十行发过来）：

  ```
  %APPDATA%\StrongholdProtocol\client.log        ← 出问题时看这个，1 MB 自动滚动
  %APPDATA%\StrongholdProtocol\trusted-certs.json ← 你手动信任过的自建服务器证书
  ```
- 自己开服（frp / 内网 / 自签证书）：第一次连会弹一次窗，写明域名 + 证书指纹 + 风险，点"仍然连接"只信任**这一台的这张证书**，其它服务器照旧严格校验；证书换了会再问。完全不想被问就加 `--insecure-tls`（等于对所有证书放行，只建议自己玩用）。
- 其他命令行参数：`--server <地址>`（本次强制走某个服务器）、`--choose-server`（强制显示菜单）、`--fullscreen`。快捷键 F2 / F11 / F5 / F12。
- **卸载**：删掉那个文件夹即可；想连本地记录一起清掉再删 `%APPDATA%\StrongholdProtocol`。

### 安卓版几个省事的小知识

- 这个 APK 是 **debug 签名**（`applicationId` = `site.starst.stronghold`，最低 `minSdk 24`）。所以：
  - 手机上**已经装了别的签名的同名版本**会装不上——先卸载旧的（卸载会清掉那台手机上的本地进度与设置）。
  - 它不能上架应用商店，也不该期待"自动更新"；换新版本就是再下一份覆盖安装（同签名可以覆盖）。
- 横屏启动，状态栏/导航栏会被隐藏（划一下边缘仍能临时唤出），刘海区域会被游戏画面使用——HUD 本身按安全区排版，不会被裁。
- 首次进菜单加服务器时，连局域网的 `ws://`（明文）是可以的：本 APK 打开了混合内容允许。
- **切到后台再回来可能会掉线**（这是当前实现里已知的一段窗口，不是你的手机坏了）：服务器每 30 秒检查一次心跳，一轮没回应就断开；客户端要等自己那 15 秒的静默判定才会开始重连。所以息屏/切微信回来卡十几秒属预期，之后会自动重连并带回你的座位（重连凭据存在本地）。

### 想要 .msi 安装程序？

现在**没有**，也不是漏了：构建配置里 Windows 的目标是 `dir`（`desktop/package.json` → `build.win.target: ["dir"]`），因为目录版启动约 0.3 秒，而单文件 portable 每次启动都要解压整包（实测约 24 秒）。
要 MSI/NSIS 安装版，需要把那个 target 改成 `["nsis"]`（或加 `msi`）并让 CI 重跑一次；代价请一并考虑：安装后约 585 MB 落在 `Program Files`、每次更新走"卸载旧版再装"，以及**我们没有代码签名证书**——SmartScreen 会弹"未知发布者"警告（zip 版同样有这层提示，但安装程序会更显眼）。想开这个口子就说一声，改动很小但需要一次出厂。

### 已知还没好的两处（当前发布的这两个文件）

1. **首屏可能因为外部字体慢**：已发布的桌面/APK 里那份 `index.html` 仍然引用 Google Fonts（实测：2 次 `fonts.googleapis.com` + 1 次 `fonts.gstatic.com`）。国内网络下这会让首屏变慢甚至短时间字体不齐。修复已经把字形逐字节镜像进构建里了，**只是还没出厂**——出新一版 exe/apk 之后这段会消失。
2. **单人模式还是占位**：菜单里的"单人游戏"点了只给提示。大厅、房间、模拟都在服务端，还没有纯前端单机实现。


```
npm run server:status                                  # 现在多少人在线 / 多少对局在跑
npm run server:status -- --watch --under 40             # 蹲空窗：humans ≤ 40 时提示可以重启
```

## 前置

| | 需要 |
|---|---|
| 通用 | Node.js 22+；一个**游戏仓库 checkout**（默认同级 `../Stronghold-Protocol`，可用 `--game` / `SP_GAME_ROOT` / `client.config.json` 指定），且已 `npm install` + `npm run assets`（素材不在 GitHub 仓里） |
| exe | 无额外要求（`electron` / `electron-builder` 由 `desktop/` 的 `npm install` 装，首次约 500 MB） |
| apk | JDK 17+（`JAVA_HOME`）+ Android SDK（`ANDROID_HOME`，`platforms;android-36`、`build-tools;36.0.0`） |

## 目录

| 路径 | 内容 |
|---|---|
| `tools/package-client.mjs` | 把游戏仓库的挂载点摊平成 `build/client/www`，生成 `data.js` / `js/runtime-config.js` / `js/shell/*` / `css/shell-display.css` / `build.json`，并应用 payload 补丁 |
| `tools/game-contract.mjs` | 游戏仓库路径解析 + `DATA_SHIM_JS` / `SIM_PRIVATE` 的对照校验 + 版本读取 |
| `tools/payload-patches.mjs`、`tools/unified-diff.mjs` | 把 `patches/game-client.patch` 打在 payload 副本上（自带极简 diff 应用器，不依赖 git） |
| `patches/game-client.patch` | 客户端改动（3 个文件、7 个 hunk —— `index.html` 2 / `js/net.js` 3 / `js/screens/room.js` 2，见下），`git diff` 生成 |
| `shell/picker.js`、`shell/picker-core.js` | 端侧进游戏前的菜单：主页"单人游戏 / 多人游戏"，多人页可添加服务器（名称 + 地址）、直接连接、探测服务器（协议 × 挂载路径同时试）并记住上次选择，首次启动把实测能连的网友服播种进玩家自己那份可删列表；`picker-core.js` 是纯逻辑（可单测） |
| `shell/display.css` | 端侧显示修正：横屏手机的 HUD/棋盘比例（见下"手机端适配"） |
| `desktop/` | Electron 壳：只监听 `127.0.0.1` 的静态服务（固定端口 47821，让 `localStorage` 跨重启保留，见 §4.4）+ 窗口；`icon.ico`。默认出**目录版**（`win-unpacked/`），`--portable` 才出单文件 exe。日志在 `%APPDATA%\StrongholdProtocol\client.log`（见 §4.3） |
| `mobile/` | Capacitor 工程（`webDir` → `../build/client/www`）+ 生成的 `android/` Gradle 工程与 `ios/` Xcode 工程（iOS 出**未签名 .ipa**，玩家自签，见 [docs/PACKAGING.md](docs/PACKAGING.md) §5.5） |
| `client.config.json` | `gameRoot`、`defaultServer` |
| `tools/package-release.mjs` | 一键发布驱动：读上游 `APP_VERSION` → 对齐本仓库版本号 → 跑测试 → 打桌面 + APK → 复制到 `build/dist/` → `git commit`（入口 `package.bat` / `package.sh`，见 [docs/PACKAGING.md](docs/PACKAGING.md) §13） |
| `tools/server-status.mjs` | 查服务器忙不忙（`/healthz`）：单次采样、滚动观察、`--under N` 等空窗（见 §11） |
| `test/packaging.test.js`、`test/picker.test.js`、`test/picker-probe.test.js` | 补丁/契约/摊平/增量的测试；选择页规则的测试；探测逻辑（脚本化 `fetch` / `WebSocket` 跑真实 payload 模块图，需游戏 checkout，否则跳过） |

## 与游戏仓库的契约（重要）

- **游戏仓库只读**：`git status` 永远干净，`git pull` 不会因为打包而冲突。客户端的改动是补丁：
  `js/net.js`（`defaultWsUrl()` 支持 `globalThis.__SP_SERVER__` / `?server=host`）、`js/screens/room.js`（邀请链接指向远程网页版）、`index.html`（模块图之前载入 `/js/runtime-config.js` 与 `/js/shell/picker.js`，`css/devices.css` 之后载入 `/css/shell-display.css`）。
- 上游改了这 3 个文件 → 补丁对不上 → **构建会失败**（而不是悄悄发出一个连错服务器的客户端）。此时重新生成 `patches/game-client.patch` 即可。
- `tools/game-contract.mjs` 里复制了游戏仓库的 `DATA_SHIM_JS` 与 `SIM_PRIVATE`（避免为打包在游戏仓库里 `npm install`），每次构建都会对照 `server/index.js` 校验。
- 产物里记录构建来源：payload 的 `build.json` 与 `build/client/manifest.json` 都有 `git describe` + commit + `PROTOCOL_VERSION`。

## 用法

```bash
npm run client:desktop -- --server 192.168.1.9:3000   # 换成局域网服务器
npm run client:android -- --server 192.168.1.9:3000
npm run client:desktop -- --portable                   # 单文件便携 exe（分发方便，启动慢，见下）
npm run client:android -- --release                    # 未签名 release APK
node tools/package-client.mjs --game ../Stronghold-Protocol --out D:\client-www
```

桌面客户端运行时也可以临时改服务器：`StrongholdProtocol.exe --server <地址>`（另有 `--choose-server`、`--fullscreen`、`--insecure-tls`，快捷键 F2/F11/F5/F12）。

**自签证书的服务器（自建 frp / 反向代理）**：两端都是**首次信任**策略——连到证书不受信任的服务器时会弹一次窗（域名 + 证书主题 + SHA-256 指纹 + 风险说明），点"仍然连接"就记住**这台服务器的这张证书**（桌面：`%APPDATA%\StrongholdProtocol\trusted-certs.json`；Android：应用私有 SharedPreferences），之后静默直连；**其它服务器照常严格校验**，证书换了（指纹变了）会再问一次。想完全不弹窗就用 `--insecure-tls`（仅桌面，等于对所有服务器放行）。详见 [docs/PACKAGING.md](docs/PACKAGING.md) §4.2 / §5。

## 桌面版为什么是"文件夹"而不是单文件 exe

```
npm run client:desktop            # 默认：build/desktop/win-unpacked/（exe + 依赖 + resources/）
```

| 形态 | 体积 | 启动到首屏 | 说明 |
|---|---|---|---|
| **目录版（默认）** | 585 MB（解压后） | **约 0.3 s** | 直接双击 `win-unpacked/StrongholdProtocol.exe` |
| 目录版打成 zip | 321 MB | 解压一次后同上 | 用资源管理器右键"压缩到 zip"即可（本机实测 28 s） |
| 单文件 `--portable` | 261 MB | **约 24 s** | 每次启动都把整包解压到 `%TEMP%`，所以慢 |

分发推荐"目录版 + 手动打 zip"：**下载 321 MB，解压一次，之后每次启动都是 0.3 s**；单文件 exe 虽然只大 60 MB 的差距，但每次启动都要解压 585 MB。打包时顺手把 Electron 的 55 个语言包裁到 `zh-CN` / `en-US`（省约 46 MB）。

## 手机端适配（APK）

两个独立的问题，都在本仓库解决，游戏仓库依旧零改动：

**1. 黑边（左/上/下）** —— Android 壳层。默认主题既没让窗口使用刘海区域（横屏时系统会把窗口 letterbox，那条刘海带就是左边的黑边），也没隐藏状态栏/导航栏（上下两条）。现在：

- `res/values/styles.xml`：`windowLayoutInDisplayCutoutMode=shortEdges`（游戏仓库的 `css/devices.css` 本来就把 HUD 放在 `env(safe-area-inset-*)` 里，所以画进刘海区是安全的）
- `MainActivity.java`：`setDecorFitsSystemWindows(false)` + 隐藏 system bars（`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`，划一下仍能临时唤出）
- `AndroidManifest.xml`：`screenOrientation="sensorLandscape"`（游戏本来就是横屏设计，自带"请横屏"提示）

**2. 准备阶段场景过小** —— 视口比例问题。游戏用根字号缩放整个 HUD：`clamp(40px, min(100vw/19.2, 100vh/10.8), 240px)`。横屏手机只有 ~366 px 高，`100vh/10.8 ≈ 33.9` 被 **40 px 下限**抬上去，于是 HUD 相对屏幕比桌面高 ~15%，而准备阶段的镜头要"避开 HUD"（`js/ui/fieldHost.js hudBands` → `js/render/projection.js clearHud`），只能把准备场景缩小。自动战斗的镜头没有这个约束，所以你看到"战斗正常、准备阶段小"。

`shell/display.css` 在横屏矮屏（`orientation: landscape and max-height: 480px`）用同一个公式但**去掉 40 px 下限**，HUD 与棋盘回到桌面的比例：同一个页面上（`dev/game-mock.html?phase=PREP`，每个备战格的屏幕像素，桌面基准 122 px）：

| 视口 | rem | 备战格 px（改前 → 改后） |
|---|---|---|
| 756×366（你那台的可用区） | 40 → 33.9 | 35 → **41.5**（+19%） |
| 798×366 + 41 px 刘海 | 40 → 33.9 | 35 → **41.5**（+19%） |
| 800×360 | 40 → 33.3 | 33.8 → **40.8**（+21%） |
| 915×412 | 40 → 38.1 | 44.5 → 46.7（+5%） |
| 1920×1080 桌面 | 100 = 100 | 122.3 → 122.3（**不变**） |

同一套测量还确认：所有视口下备战格/临时格/后排仍然 **100 % 不被 HUD 遮挡**（这正是当初 `clearHud` 缩小的原因），页面无报错。

**3. 开屏菜单太大** —— 选择页是客户端自己的覆盖层，用 px 排版，不跟游戏的根字号缩放，所以在 756×366 的横屏手机上原本和桌面一样大（模式按钮接近 80 px 高）。`shell/picker.js` 里的 `@media (max-height:520px),(max-width:560px)` 把标题、模式按钮、卡片、按钮与表单整体缩小（实测 756×366：整块菜单 217 px 高、模式按钮 68 px、标题 16 px，**一屏放得下不用滚**；桌面 1920×1080 不变）。

## 选择游戏模式 / 服务器（exe / apk 首次启动）

端侧客户端进游戏前有一个 Minecraft 风格的菜单（`shell/picker.js`），盖住启动画面：

- **主页**：上下两个选项——**单人游戏**（预留：游戏的大厅 / 房间 / 模拟都在服务端，还没有"纯前端单机"的实现，点了只给提示）、**多人游戏**。
- **多人游戏页**：服务器列表 + **添加服务器**（填名称与地址）、**直接连接**（只填地址，连上后不进列表）、**编辑**（改选中的自建服务器；内置的"本机 / 局域网"与打包默认服不可改）、**刷新**（把所有服务器重新测一遍延迟）与"返回"。
- **列出的服务器**：内置项只有 `本机 / 局域网 localhost:3000`（`shell/picker-core.js` 的 `BUILTIN_SERVERS`，给自己开服的人）；打包时 `--server` 指定的地址作为"默认服务器"排在它前面（**当前发布的产物是 `sp.lain42.top`**）；再加上自己添加的服务器（存在客户端本地，旧的"只存地址"格式会自动升级成"名称 + 地址"）。每次打开都会**探测**：直接开 `/ws`（和游戏用同一条通道，所以不需要服务器支持 CORS），绿灯代表真的能连进去；如果服务器给 `/healthz` 加了 CORS 头，还会显示版本 / 在线人数。
- **网友服是"播种"进玩家自己那份列表的**（`picker-core.js` 的 `COMMUNITY_SERVERS` + `SEED_VERSION`，`picker.js` 的 `seedCommunityServers()`）：第一次启动把当时实测能连的几台写进 `sp.shell.list`，并写下 `sp.shell.seed` 标记。走 `K_LIST` 而不是 `BUILTIN_SERVERS` 是**有意的**——别人的服随时会关，玩家必须能删掉它，而内置项不给删；标记则保证删掉的那条不会下次启动又回来（要再推一批新的就升 `SEED_VERSION`）。列表里只放实测 `/ws` 握手成功的地址：`ark-proto.stardust.matce.cn`（HTTP 通、`/ws` 没服务）与 `xymx1234.github.io/stronghold-standalone/`（纯静态网页版，不是服务器）都**没有**写进去，`test/picker.test.js` 钉住这一条。
- **地址怎么写**：`host`、`host:port`、`http(s)://…`、`ws(s)://…` 都行，**不用手写协议**——不带协议时，带端口的地址先按 `ws://` 猜（`:443` 除外），公网域名默认 `wss://`。探测把**协议 × 路径**的几种可能**同时**试一遍：`host:3000/play` 会试 `ws://host:3000/play/ws`、`ws://host:3000/ws` 以及对应的 `wss://` 两条，哪个通用哪个，并把**真正通了的那条地址**记下来（所以粘贴别人给的网页地址也行）。失败重试一次，一轮试完才重试最佳猜测，所以一个死地址约 8 s 出结果。
- **连不上会说什么**：浏览器拿不到 WebSocket 握手失败的原因（404 / 503 / 拒绝连接长得一样），但 `/healthz` 用 `no-cors` 再问一次能判断"这台机器到底有没有在线"——在线就对了一句"**对方在线，但 `/ws` 没通**（多半没转发到游戏服务）"，让玩家知道不是自己填错了；问不出结论就还是原来的"无法连接"（不会瞎猜"主机无响应"，安卓壳拦掉明文 `http://` 时也是问不出结论）。
- **记住上次选择**：桌面端勾上"记住并直接进入"后，下次启动直接进游戏（想换服务器按 **F2**，或用 `--choose-server` 启动）。Android 没有 F2，所以每次都显示这个页面（默认不记住），免得换了服务器回不去。
- **网页版不受影响**：浏览器版没有这个页面，服务器永远是自己所在的站点。
- **重启后不丢本地缓存**：身份 token、干员调配、设置都存在 `localStorage` 里，而它是按"源"隔离的——所以桌面壳固定用 `127.0.0.1:47821`（`desktop/serve.mjs` 的 `DEFAULT_PORT`），每次启动都是同一个源，重启后原样读回（以前每次随机端口 = 每次换源，等于重装）。Android 本来就从固定的 `https://localhost` 提供页面，无需处理。详见 [docs/PACKAGING.md](docs/PACKAGING.md) §4.4。
- Android 上连局域网的 `ws://` 需要 APK 打开 `allowMixedContent`（本仓库默认打开，原因见 [docs/PACKAGING.md](docs/PACKAGING.md) §5）。
- 优先级：`--server <地址>`（本次运行强制）> 命令行/`?server=` > 选择页记住的地址 > 打包时的默认地址。选择页只是把选择写进 `localStorage`（`sp.shell.*`）并重载页面，`js/net.js` 一条代码都没多改。

## 许可

本仓库自有代码 GPL-3.0-or-later（与游戏本体相同）。打包产物里含《明日方舟》美术 / 音频素材，版权归鹰角网络 / Yostar，**不适用** GPL，仅限个人非商业自用，请勿再分发（见上游 [声明](https://github.com/sganggs/Stronghold-Protocol#声明) 与 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)）。
