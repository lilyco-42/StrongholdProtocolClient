# 打包客户端（exe / apk）

把浏览器客户端和本机素材打进**桌面 / Android 可执行文件**：素材和代码从本地读取，房间、回合、联机仍然连服务器——`tools/package-client.mjs` 的代码默认值是 `localhost:3000`（自己开服用），**但发出去的产物不用它**：CI 传 `--server sp.lain42.top`，产物里的 `js/runtime-config.js` 写死 `globalThis.__SP_SERVER__ = "sp.lain42.top"`（2026-10-05 从发布 APK 解出核过）。

```
npm run client:desktop      # → build/desktop/win-unpacked/（exe + 依赖目录，约 585 MB）
npm run client:android      # → mobile/android/app/build/outputs/apk/debug/app-debug.apk
npm run client:build        # 只生成 build/client/www（想用自己的静态托管时用）
```

## 1. 原理

浏览器客户端是按服务器的挂载布局写的（游戏仓库的 `server/index.js`）：`/`→`public/`、`/data/`→`data/`、`/shared/`→`shared/`、`/sim/`→`server/sim/**/*.js`，0.2.0 起再加一条可选的 `/packs/`→`packs/`（`server/http/static.js`：`/packs/index.json` 是这台服务器的内容包登记，口语包（界面译文 + 游戏文本）由它列出来，实际文件在 `public/i18n/` 与 `data/`；`/packs/<id>/<file>` 只放登记点名的文件），外加服务器现生成的 `/data.js`（`server/data.js` 的浏览器替身）。打包好的客户端没有 Node 服务器，所以：

1. `tools/package-client.mjs` 把**游戏仓库 checkout** 的这些挂载点**摊平**成一个目录 `build/client/www/`——任何静态文件服务器或 Android WebView 都能直接托管，`/js/...`、`/data/...`、`/sim/...` 这些绝对路径照常解析；顺带生成 `data.js`（垫片）、`js/runtime-config.js`（服务器地址）、`js/shell/*`（选择服务器页）与 `build.json`（构建来源）。
2. 客户端要连远程服务器，需要几处源码级改动：`js/net.js` 的 `defaultWsUrl()` 读 `globalThis.__SP_SERVER__`、`js/screens/room.js` 的邀请链接指向远程网页版、`index.html` 在模块图之前载入 `/js/runtime-config.js` 与 `/js/shell/picker.js`。**这些改动不在游戏仓库里**，而是以 `patches/game-client.patch` 的形式打在 payload 副本上（见 §7），游戏仓库保持与上游逐字节一致。
3. 桌面壳（`desktop/`）用 Electron 起一个**只监听 127.0.0.1** 的静态服务器托管 `www/`，再打开窗口；Android 壳（`mobile/`，Capacitor）把 `www/` 作为原生 assets 打进 APK。

所以：进对局不用再下载约 260 MB 素材，但服务器地址、协议版本仍然跟着远程服务器走。

> 客户端和服务端的协议版本必须一致（游戏仓库 `shared/constants.js` 的 `PROTOCOL_VERSION`）。服务器升级后请重新打包，否则客户端会提示「客户端版本与服务器不一致」。

## 2. 先决条件

| 目标 | 需要 |
|---|---|
| 通用 | Node.js 22 / 24；一个**游戏仓库 checkout**（`Stronghold-Protocol`，默认同级 `../Stronghold-Protocol`，可用 `--game` / `SP_GAME_ROOT` / `client.config.json` 指定），且已 `npm install` + `npm run assets` 下载素材——**没有素材的客户端只是个空壳** |
| gitignore 的派生登记 | `public/assets/`、`public/fonts/`、`public/vendor/`、`data/local-assets.json` 都**不入 git**，所以**每个 checkout 各有一份**。新开一个 worktree 直接打包，包里就没有立绘（不静音，是整层不长出来）。语音语言这一层 0.2.x 换了写法：可选项现在是树里的常量（`public/js/ui/gameLogic/settings.js` 导出的 `VOICE_LANGS`，`audio.js` 按 `settings.voiceLang` 选 `audio.voice` / `audio.voiceJp`），不再是"扫一遍素材再写出来的登记文件"；`data/voice-langs.json` 与 `tools/voice-langs.mjs` 在 0.2.2 的树里**已经不存在**，也没有代码读它（整树 grep 零命中）。旧 payload 里那份是 0.1.4 时代（fork 自己那套 `public/js/ext/voiceLang*.js`，也被上游吸收掉了）的遗留文件，`cut-payload.yml` 明确不再从上一版把它拷回来。至于 UI 文案的多语言，那是另一套：`packs/` + 打包时由游戏仓 `tools/packs.mjs index` 现生成的 `packs/index.json`。 |
| exe | 无额外要求（`electron` / `electron-builder` 由 `desktop/` 的 `npm install` 装）；出 zip 用资源管理器右键，出 7z/zip 更小可用 7-Zip（可选） |
| apk | JDK 17+（`JAVA_HOME`）、Android SDK（`ANDROID_HOME`）含 `platforms;android-36` 与 `build-tools;36.0.0`、并已接受许可协议（见 §5） |

## 3. 命令与参数

```bash
npm run client:build                                    # 只生成 build/client/www
npm run client:desktop -- --server 192.168.1.9:3000     # 换成局域网服务器
npm run client:android -- --server 192.168.1.9:3000
npm run client:desktop -- --portable                    # 单文件便携 exe（启动慢，见 §4）
npm run client:desktop -- --skip-install                # 不自动 npm install
npm run client:android -- --release                     # 未签名 release APK
node tools/package-client.mjs --game D:\gits\Stronghold-Protocol --out D:\client-www
```

`--dir` 仍被接受，但它现在就是默认值（目录版）。

`--server` 接受 `host`、`host:port`、`http(s)://…`、`ws(s)://…`。私有地址（`localhost`、`127.*`、`10.*`、`192.168.*`、`172.16–31.*`）自动用 `ws://`，其余用 `wss://`。

`--game` 指定游戏仓库 checkout（也可以设环境变量 `SP_GAME_ROOT`，或改 `client.config.json` 的 `gameRoot`）。

网页版也可以临时改服务器：`https://<你的站点>/?server=192.168.1.9:3000`（只对本次会话生效）。

## 4. 桌面版

| 文件 | 说明 |
|---|---|
| `desktop/main.mjs` | Electron 主进程：起本地静态服务、开窗口、外链走系统浏览器、F2（选择服务器）/ F11 / F5 / F12 快捷键、`--choose-server`、`--insecure-tls`（接受自签证书，仅桌面版、默认关） |
| `desktop/serve.mjs` | 只监听 `127.0.0.1` 的静态服务，默认端口 `DEFAULT_PORT`（47821，见 §4.4）；MIME 表与游戏仓库 `server/index.js` 一致，由 `test/packaging.test.js` 锁定 |
| `desktop/package.json` | electron / electron-builder 与打包配置（`extraResources` 把 `build/client/www` 放进 `resources/www`；`electronLanguages` 只保留 `zh-CN`/`en-US`） |
| `desktop/icon.ico` | 应用图标（取自客户端自带的盾牌图标） |

### 4.1 产物形态：默认目录版，不是单文件

```
build/desktop/win-unpacked/     ← 分发这个目录
  StrongholdProtocol.exe        234 MB   ← Electron 本体（改名 + 图标 + 版本信息）
  resources/www/                265 MB   ← 游戏 payload（素材与代码，见 §1）
  locales/                      ~2 MB    ← 只留 zh-CN / en-US（默认 55 个语言包约 48 MB）
  *.dll, *.pak, *.bin           ~80 MB   ← Chromium / V8 运行时（一个都不能少）
```

| 形态 | 体积 | 启动到首屏 | 说明 |
|---|---|---|---|
| **目录版（`npm run client:desktop`）** | 585 MB | **约 0.3 s** | 双击 `win-unpacked/StrongholdProtocol.exe` |
| 目录版打成 zip 分发 | 321 MB | 解压一次后同上 | 资源管理器右键"压缩到 zip"即可（本机实测：585 MB → 321 MB，28 s） |
| 单文件 `--portable` | 261 MB | **约 24 s** | 每次启动都把整包解压到 `%TEMP%`（本机实测解压 389 MB 时已用 14 s） |

分发就用**目录版 + 手动 zip**：下载 321 MB，解压一次，之后每次启动都是 0.3 s。单文件只小 60 MB，却要每次启动等你 24 s，所以它退成了 `--portable` 选项（`desktop/` 里也有 `npm run pack:portable`）。

> 让 zip 更小：装了 [7-Zip](https://www.7-zip.org/) 的话用 `7z a -mx=9 dist.7z build/desktop/win-unpacked`，LZMA2 通常比 zip 再小 10~15%，但要收件人装 7-Zip 才能解。

### 4.2 运行参数

`StrongholdProtocol.exe --server <地址>`、`--choose-server`、`--fullscreen`、`--insecure-tls`；快捷键 F2（选择服务器）/ F11 / F5 / F12。开发时：

```bash
node tools/package-desktop.mjs --skip-install   # 先生成 build/client/www
cd desktop && npm start
```

#### 自签证书的服务器（首次信任 / trust-on-first-use）

玩家自己开的服务器常常挂在 frp 隧道或反向代理后面，证书是自签的（SakuraFrp 的"自动 TLS"就是），Chromium 会直接拒绝（`ERR_CERT_AUTHORITY_INVALID`）。桌面壳因此**按服务器**做一次询问，而不是关掉校验：

1. `certificate-error` 拦下这次失败（`desktop/main.mjs` → `desktop/trust.mjs`）；
2. 弹窗给出 **域名 + 证书主题 + SHA-256 指纹**，并写明跳过的风险；
3. 点"仍然连接"→ 记住这台服务器的**这张证书**（`%APPDATA%\StrongholdProtocol\trusted-certs.json`，形如 `{"frp-boy.com:60751":"sha256/…"}`）→ 连接继续，以后静默直连；
4. 点"取消"→ 本次不连，且这一页不再弹（页面重载或切换服务器后会再问一次）。

要点：

- **其它服务器、其它请求照常严格校验**——和 `ignore-certificate-errors` 那种全局关闭不一样；
- 证书**换了**（指纹不同，例如隧道换节点重新签）会再问一次，而不是默默放行；
- 想撤销：删掉 `trusted-certs.json` 里的那一行（或整个文件）；
- `--insecure-tls` = 不再询问，对所有证书直接放行（日志里会留一行说明）。只给"自己开服、不想被问"的人用；
- 排错时看 `client.log`：`the certificate of <host> is not trusted … asking the player` / `player trusted … ` / `player declined …`。

Android 版是同一套策略，见 §5。

### 4.3 崩溃与日志

壳没有控制台在前台，所以一切异常都写进日志文件：

```
%APPDATA%\StrongholdProtocol\client.log        （1 MB 自动清空；启动时也会打印到 stderr）
C:\Users\<你>\AppData\Roaming\StrongholdProtocol\client.log
```

玩家反馈"客户端突然消失"时，让他把这个文件发过来。

壳对下面这些情况**不再退出**（以前任何一条都会让整个应用消失，看起来就是"闪退"）：

| 情况 | 现在的行为 |
|---|---|
| 渲染进程崩溃（GPU/内存，`render-process-gone`） | 记录原因（`reason=crashed/oom`）并**自动重载页面**；会话由服务器记住，玩家回到原来的界面 |
| 主进程未捕获异常 / 未处理的 Promise 拒绝 | 记录日志并继续运行（不再静默退出） |
| 首屏 `loadURL` 失败 | 记录日志，保留窗口 |
| 页面无响应（`unresponsive`） | 记录日志 |

> 排查 "打开某个界面就闪退"：先看 `client.log` 里有没有 `renderer gone: reason=…`。有 → 是渲染进程崩了（现在会自动恢复，原因也记下来了）；没有 → 是整个进程被别的东西结束了（例如**已有实例在跑**：单实例锁会让新启动的进程直接退出，`client.log` 里会有 `another instance was launched`）。

### 4.4 本地缓存（重启后不丢干员调配 / 登录 / 设置）

游戏把身份续连 token（`sp.tokens`）、干员调配（`sp.pref.loadout`）、设置（`sp.pref.settings`）等存在浏览器 `localStorage` 里，而 **`localStorage` 是按"源"（origin）隔离的**。壳把 payload 挂在 `http://127.0.0.1:<port>` 上，所以端口必须每次启动都一样：

| | 端口 | 源 | 重启后 |
|---|---|---|---|
| 以前 | `0`（系统每次随机分配） | `http://127.0.0.1:53471` → 下次 `http://127.0.0.1:58203` | 换了源 → 读回空值，看起来像"重装了一遍"：要重新登录、干员调配和设置都没了 |
| 现在 | `DEFAULT_PORT` = 47821（固定） | 每次都是 `http://127.0.0.1:47821` | 同一个源 → `localStorage` 原样读回 |

47821 被占用时按 `47821, 47822, …` **固定顺序**往后找（`serve.mjs` 的 `PORT_SEARCH`），顺序固定意味着下一次启动仍落在同一个端口，源依旧不变；只有这一小段端口全被占满才会退回随机端口（`client.log` 会有 `loopback port … is in use` 提示）。

Android 不需要这个处理：Capacitor 固定从 `https://localhost` 提供页面（`mobile/capacitor.config.json` 的 `androidScheme: https`），源本来就是稳定的，`localStorage` 随应用数据一起保留。

## 5. Android 版（apk）

| 文件 | 说明 |
|---|---|
| `mobile/capacitor.config.json` | `appId` / `appName`；`webDir` = `../build/client/www`；`android.allowMixedContent` = `true`（见下） |
| `mobile/android/` | Capacitor 生成的 Gradle 工程（可提交；`assets/public` 与 `local.properties` 已在 `.gitignore` 里忽略） |
| `mobile/android/app/src/main/AndroidManifest.xml` | `usesCleartextTraffic`（局域网 `ws://` 需要；默认仍是 `wss://`）、`screenOrientation="sensorLandscape"` |
| `mobile/android/app/src/main/res/values/styles.xml` | `windowLayoutInDisplayCutoutMode=shortEdges`（不这样系统会在横屏把窗口 letterbox，刘海那条就是左边的黑边） |
| `mobile/android/app/src/main/java/.../MainActivity.java` | 全屏：`setDecorFitsSystemWindows(false)` + 隐藏 system bars（划一下仍能唤出），失焦后重新隐藏 |

### 全屏与手机显示（两个独立问题）

**黑边**：模板给的主题既不让窗口使用刘海区，也没隐藏状态栏 / 导航栏。于是横屏时左边是刘海被 letterbox 出来的黑带，上/下是系统栏（游戏仓库 `test/ui/playtest5-ui.e2e.test.js` 里就记录着这台机器的实测：`2772×1272` 截图、页面 `756×366`、右侧 `141 px` 黑带 = DPR 3.48 下约 41 CSS px）。现在窗口画进刘海区、系统栏隐藏——游戏自己的 `css/devices.css` 已经把 HUD 放在 `env(safe-area-inset-*)` 里，所以这样是安全的。

**准备阶段场景过小**：横屏手机只有 ~366 px 高，而游戏用根字号缩放整个 HUD（`css/theme.css`：`clamp(40px, min(100vw/19.2, 100vh/10.8), 240px)`），`100vh/10.8 ≈ 33.9` 被 **40 px 下限**抬到 40，HUD 就比桌面相对高一截；准备阶段的镜头要避开 HUD（`js/ui/fieldHost.js hudBands` → `js/render/projection.js clearHud`），只能把场景缩小。`shell/display.css`（payload 里是 `/css/shell-display.css`，由补丁挂在 `css/devices.css` 之后）在 `orientation: landscape and max-height: 480px` 下用同一公式、去掉下限，比例回到桌面水平；自动战斗的镜头没有 HUD 约束，所以之前只有准备阶段显得小。

实测（`dev/game-mock.html?phase=PREP`，数字是每个备战格的屏幕像素，桌面基准 122 px；同一次测量还确认备战/临时/后排格在所有视口下 100 % 不被 HUD 遮挡）：

| 视口 | rem | 备战格 px（改前 → 改后） |
|---|---|---|
| 756×366 | 40 → 33.9 | 35 → 41.5（+19 %） |
| 798×366 + 41 px 刘海 | 40 → 33.9 | 35 → 41.5（+19 %） |
| 800×360 | 40 → 33.3 | 33.8 → 40.8（+21 %） |
| 915×412 | 40 → 38.1 | 44.5 → 46.7（+5 %） |
| 1920×1080 桌面 | 100 → 100 | 122.3 → 122.3（不变） |

> 桌面 / 平板不受影响：那些视口 `min(w/19.2, h/10.8) ≥ 40`，覆盖规则等于没写。真机上"系统栏是否消失、刘海是否被填满"需要装到手机上看（本仓库没有模拟器镜像），浏览器侧的比例是按上面这套测量的。

**选择页在手机上也要缩小**：选择页（`shell/picker.js`）是客户端自带的覆盖层，px 排版、不跟游戏的根字号缩放，所以在 366 px 高的横屏手机上原来和桌面一样大。现在 `shell/picker.js` 的 `@media (max-height:520px),(max-width:560px)` 把标题 / 模式按钮 / 卡片 / 按钮 / 表单整体缩小（756×366 实测：整块菜单 217 px 高，一屏放得下；桌面 1920×1080 不变）。

**自签证书的服务器**：Android 用同一套"首次信任"策略，实现是 `MainActivity` 里给 Capacitor 的 `BridgeWebViewClient` 加一个子类、只覆盖 `onReceivedSslError`（不清掉 Capacitor 自己的 client，本地 payload 与 JS 桥照常），证书信息与指纹在 `TrustedCerts.java`（`SslCertificate.getX509Certificate()` 是 API 29+，24–28 走 `SslCertificate.saveState` 的 `x509-certificate` 字节）。弹窗显示域名 + 证书主题 + SHA-256 指纹，"仍然连接"后按 `主机 = 指纹` 存进应用私有 `SharedPreferences`（`stronghold_trusted_certs`），之后静默直连；**其它服务器照常校验**，证书换了指纹变了会再问一次。Android 没有 `--insecure-tls` 那种"全部放行"的开关。

**关于 `allowMixedContent`**：WebView 的页面本身是 `https://localhost`（`androidScheme`），而自建的局域网服务器只有 `ws://`（没有证书），Chromium 会把它当 mixed content 拦掉——`usesCleartextTraffic` 只管系统层的明文策略，管不了这个。所以 APK 里打开了 `allowMixedContent`，让选择服务器页里的 `ws://<局域网地址>:3000` 能用。**代价**：这一层保护没了，页面里的其他连接也可以降级到明文；官方服务器仍然走 `wss://`。不想要局域网联机的话，把 `mobile/capacitor.config.json` 改回 `false` 重新打包即可（`localhost` 属于"可信来源"，不受影响）。

产物：`mobile/android/app/build/outputs/apk/release/app-release.apk`（release 签名，可直接安装）。安装：`adb install -r <apk>`，或把 APK 拷到手机点开（需允许「安装未知应用」）。

> 2026-10-07 之前这里写的是"debug 包，可直接安装；发布用的 release 需要自己签名"，并给了一条 `keytool -genkeypair`
> 的待办。**那条待办已经落地，而且落地方式是"必须有固定钥匙，否则 release 直接失败"**：
> debug 包签的是每个 CI runner 现生成的一次性钥匙，玩家覆盖安装必报 -7（要卸载重装，连带丢 localStorage）。
> 钥匙、指纹、闸门、玩家侧影响与轮换流程见 **`docs/ANDROID-SIGNING.md`**。
> 本地随手测试仍然可以 `./gradlew assembleDebug`（不需要那把钥匙），但**发给玩家的必须是 release**。

CI 那条路（`build-clients.yml` 的 android job）已经自带钥匙：它从仓库 secret 解出 `mobile/android/keystore/`，
跑 `assembleRelease`，再用 `apksigner` 核对产物指纹。本地跑 `node tools/package-android.mjs --release` 时需要自己写
`mobile/android/keystore.properties`（四个键的名字见 `docs/ANDROID-SIGNING.md` §3），缺它时 gradle 会 throw 而不是
出一个装不上的未签名包。

### 首次准备 Android SDK

如果机器上没有 SDK（`ANDROID_HOME` 不存在）：

```powershell
# 1. 下载并解压 cmdline-tools 到 %LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest
#    （zip 里是 cmdline-tools/ 目录，解压后改名为 latest）
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
curl.exe -L -o "$sdk\cmdline-tools.zip" https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip
tar -xf "$sdk\cmdline-tools.zip" -C "$sdk"; Move-Item "$sdk\cmdline-tools" "$sdk\cmdline-tools-latest"
New-Item -ItemType Directory -Force "$sdk\cmdline-tools" | Out-Null
Move-Item "$sdk\cmdline-tools-latest" "$sdk\cmdline-tools\latest"

# 2. 装依赖包。注意：在 PowerShell 里 `platforms;android-36` 的分号会被拆开，
#    用 --package_file 最稳（每行一个包名）。
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
"platform-tools`nplatforms;android-36`nbuild-tools;36.0.0" | Set-Content -Encoding ASCII packages.txt
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" --package_file=packages.txt
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" --licenses   # 全部输入 y

# 3. 持久化环境变量
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('JAVA_HOME', $env:JAVA_HOME, 'User')
```

macOS / Linux 同理，把 `commandlinetools-win` 换成 `commandlinetools-mac` / `commandlinetools-linux`，SDK 默认在 `~/Library/Android/sdk` / `~/Android/Sdk`。`tools/package-android.mjs` 会自己找 `ANDROID_HOME` / `ANDROID_SDK_ROOT` / 默认目录，并写 `mobile/android/local.properties`。

## 5.5 iOS 版（未签名 `.ipa`，玩家自己签）

有玩家用 iPhone，所以 2026-10-06 加了这一路。**它和另两路的根本差别是签名**：iOS 上任何 app 都要有签名才能装，
而我们没有 Apple 开发者账号，也不打算为这个 GPL 同人项目去申请 —— 所以 CI 产出**未签名 .ipa**，
玩家用自己的**免费 Apple ID** 签了再装（AltServer / Sideloadly / SideStore 任一，需要一台电脑）。
免费签名的两条限制是 Apple 定的：**7 天到期**、**同一 Apple ID 最多 3 个自签应用**。

**工程与产物**

| 项 | 事实 |
|---|---|
| 生成方式 | `cd mobile && npm i -D @capacitor/ios@^8.5.2 && npx cap add ios` → `mobile/ios/`（20 个文件入库；Capacitor 自带的 `mobile/ios/.gitignore` 已挡住 `App/public`、`capacitor.config.json`、`Pods`、`xcuserdata`，`git add -n` 逐条核过） |
| bundle id / 最低系统 | `site.starst.stronghold`（与安卓同一个 appId）；`CapApp-SPM/Package.swift` 声明 `.iOS(.v15)` → **iOS 15 起**，运行时按 `exact: 8.5.2` 从 GitHub 拉 `capacitor-swift-pm` |
| **共享 scheme 要手写提交** | 模板**不带** `.xcscheme`。Xcode 打开工程时会自建，但纯 CI 环境不会 —— 少了 `App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`，`xcodebuild -scheme App` 就直接找不到 scheme。里面 `BlueprintIdentifier` 是从 `project.pbxproj` 读出来的 target UUID（`504EC303…`，product `App.app`），别照抄网上的示例 |
| `Info.plist` 三处改动 | ① `NSAppTransportSecurity/NSAllowsArbitraryLoads=true`：iOS 默认禁明文，玩家自建服常常是 `ws://192.168.1.9:3000`、frp 的 `ws://211.71.60.138:3000`，不放开连握手都发不出去 —— 对应安卓的 `android.allowMixedContent`；② 方向只留 `LandscapeLeft/Right`（模板带 Portrait，而游戏是横屏设计，安卓侧是 `screenOrientation="sensorLandscape"`）；③ `UIStatusBarHidden=true` + `UIViewControllerBasedStatusBarAppearance=false`，对齐安卓的隐藏 system bars。入口页 meta 已带 `viewport-fit=cover`、`css/devices.css` 用 `env(safe-area-inset-*)`，所以画进刘海区是安全的 |
| 音频 | 不需要额外做：`public/js/audio.js` 已经在首次手势（`pointerdown/touchend/click/keydown`）时建 AudioContext，注释里明确写了 iOS Safari 只认 `touchend/click` 这个坑。表现就是"点一下屏幕之后才有 BGM" |

**CI（`build-clients.yml` 的 `ios` job，`runs-on: macos-latest`）**

前置四道闸门与 desktop/android **逐字一致**（GitHub 的 workflow 不支持 YAML 锚点，只能抄；抄漏一处就是发一份没把关的包）。
之后：`npm install` → **往 `runtime-config.js` 追加 `__SP_MEDIA_ALIAS__ = false`**（WKWebView 同样是纯静态宿主，
不关掉 `/media/…` 就 404，装机版全程静音 —— 和安卓那一步同一个道理，见 §5）→ `npx cap sync ios` →
`xcodebuild … CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY=` → 把 `App.app` 放进 `Payload/` 用 `ditto -c -k` 打成 .ipa。

产物内闸门扫的是 **`.app` 里的 `public/`**（那一步先 `find` 目录、再断言里面有 `index.html`、有 `js/shell/picker.js`、
`picker-core.js` 里有 `COMMUNITY_SERVERS`）—— 不这么写就可能拿一个空目录"通过"闸门。

**测试钉住的东西**（`test/packaging.test.js`）：ios job 存在且跑在 macOS runner、四道前置闸门都在、
media-alias flag 有写、**签名是关的**、共享 scheme 在库里、`Info.plist` 那三处。两个教训记在这里：
① 原来"android job 读到文件末尾"的切片在有第三个 job 后会让 android 的断言在 ios 的步骤上蒙对，已改成按 job 边界切；
② 第一版"不签名"的断言是整段匹配 `CODE_SIGNING_ALLOWED=NO`，结果命中了**注释里**那句话，把真实参数删掉测试照样绿 ——
现在只匹配非注释行，并用"改成要签名 / 只在注释里留着不签名"两种变异各验过一次。

**已知没做**：应用图标还是 Capacitor 模板的默认图（安卓侧同样是模板 `ic_launcher`，两边一致），要做要出 iOS 全套
`AppIcon.appiconset` + 启动图；这一步等有玩家反馈"找不到图标"再做。
**本地不编**：iOS 只能在 macOS 上编，正好符合"产物一律在 Actions 里出"的规矩（§3）。

## 6. 选择游戏模式 / 服务器（进游戏前）

打包客户端里多了一个 Minecraft 风格的菜单（`shell/picker.js` + `shell/picker-core.js`，被复制成 payload 里的 `/js/shell/*`），它在 `/js/main.js` 之前执行、盖住启动画面，把选择写进 `localStorage`（`sp.shell.*`）后重载页面。`js/net.js` 只认 `globalThis.__SP_SERVER__`，菜单只是给它赋值，所以不需要再改游戏源码。

| 行为 | 说明 |
|---|---|
| 主页 | 上下两个选项：**单人游戏**（预留——大厅 / 房间 / 模拟都在服务端，暂无"纯前端单机"实现，点击只给提示）、**多人游戏** |
| 多人页 | 服务器列表 + **添加服务器**（名称 + 地址）、**直接连接**（只填地址，不进列表；先用探测选通用那条地址再进入）、**编辑**（改选中的自建服务器；内置与打包默认服不可改）、**刷新**（重新测一遍所有延迟，放在"返回"左边）、**返回** |
| 地址写法 | `host`、`host:port`、`http(s)://…`、`ws(s)://…`，不用手写协议：不带协议时带端口的按 `ws://` 猜（`:443` 除外），公网域名默认 `wss://`。候选 = **协议 × 路径**：`toWsUrl()` 保留粘贴的路径（`https://host/play` → `wss://host/play/ws`），`picker-core.js` 的 `orderCandidates()` 再补上根挂载那条（`wss://host/ws`），地址没写协议时两种协议都补，最多 4 条。命中后把**通了的那条**存进 `sp.shell.server`（`ambiguousScheme` 决定哪些地址需要双协议，`pathOf` 决定失败文案提不提路径） |
| 列出的服务器 | 内置项只有 `本机 / 局域网 localhost:3000`（`shell/picker-core.js` 的 `BUILTIN_SERVERS`，给自己开服的人）；`--server` 打包指定的地址会标"默认"并排在前面（**当前发布的产物是 `sp.lain42.top`**）；玩家自己添加的服务器（按 `js/net.js` 的 `toWsUrl()` 归一化，存在客户端本地；旧的"只存地址字符串"列表在读取时会升级成 `{name, address}`） |
| 网友服播种 | `picker-core.js` 的 `COMMUNITY_SERVERS`（每条 `{name, address}`，收条目的门槛是**协议层**的 `hello`→`welcome`，不是 `/ws` 握手成功过 —— 见 §17；`test/picker.test.js` 钉住"表里不许出现已测死的 host"、地址能被 `addressError` 接受、而且没有两行归一成同一个 socket URL）由 `picker.js` 的 `seedCommunityServers()` 在模块加载时写进 `K_LIST`，并写 `sp.shell.seed = SEED_VERSION`。三个要点：① **播种到可删列表而不是 BUILTIN_SERVERS** —— 别人的服会关，玩家必须删得掉，内置项不给删；② 有标记才不会把删掉的那条又种回来（要推新一批就升 `SEED_VERSION`）；③ 去重键由调用方注入（传 `toWsUrl`），所以玩家自己手填过同一个服就不会重复。种子跑在覆盖层不显示的那条路径上，F2 打开时看到的是同一份列表 |
| 探测 | 直接开 `/ws`（和游戏同一条通道，因此不依赖服务器 CORS），4 条候选**同时**开，一轮结束后最佳猜测重试一次 → 死地址约 2×`PROBE_TIMEOUT_MS`（8 s）出结果；绿点 = 真的能连进去。握手失败在浏览器里拿不到原因，所以 `/healthz` 会用 `mode: 'no-cors'` 再问一次（它对任何 HTTP 状态都 resolve，只有主机没答才 reject）：答了 → 卡片写"对方在线，但 `/ws` 没通"（`probeReason`），没答 → 保持"无法连接"（安卓壳拦明文 `http://`，不能据此断言主机无响应）。服务器给了 `Access-Control-Allow-Origin` 还能读 JSON，显示 `v<app> · 在线 n · 房间 n`； socket 失败时会等 `/healthz` 落定再收（等不到就按 `PROBE_TIMEOUT_MS` 截止），否则秒断的握手永远抢在那句结论前面 |
| 记住上次 | 桌面端勾"记住并直接进入"后下次直接进游戏；想换服务器按 **F2**，或用 `--choose-server` 启动。Android 没有 F2，所以每次都显示、默认不记住（否则玩家换了服务器就回不去了） |
| 优先级 | `--server <地址>`（本次运行）> `?server=<地址>` > 菜单记住的地址 > 打包默认地址 |
| 网页版 | 没有这个页面（浏览器版的服务器永远是自己所在的站点） |

改动菜单后跑一遍 `test/picker.test.js`（规则单测，含 `customFrom` 的旧格式迁移，以及候选顺序 / 失败文案）和 `test/picker-probe.test.js`（探测：用脚本化的 `fetch` / `WebSocket` 跑真实的 payload 模块图，需要游戏 checkout，没有就自动跳过）。**渲染那半边仍没有自动化测试**，改动后请手动确认：桌面 `cd desktop && npm start`，Android 装 APK 后首启。

## 7. 服务器公告（`app.notice`）

服务端可以把一条公告推给所有在线玩家（"服务器 23:30 维护重启"），客户端在**任何界面**顶部显示一条胶囊，**标题页也显示**——玩家还没进大厅就能看到。

**发公告的地方在游戏仓库**（打包仓库不参与）：`server/notice.js` 轮询一个文件，`scripts/notice.mjs` 是操作命令，完整用法见游戏仓库的 [docs/DEPLOY.md §6](https://github.com/sganggs/Stronghold-Protocol/blob/master/docs/DEPLOY.md)。发公告**不需要重启服务器**。

```bash
# 在游戏仓库的服务器上
node scripts/notice.mjs --kind maintenance --for 30m "30 分钟后维护重启，预计 5 分钟"
node scripts/notice.mjs --clear        # 撤回
```

打包客户端要**重新打包**才能显示公告：

- 客户端代码（`public/js/ui/noticeBanner.js`、`main.js`、`css/components.css`）跟着 `public/**` 打进 payload，所以旧的 exe/apk 里没有这个横幅；
- 旧客户端收到未知的 S2C 类型只是没有监听器（`net.js` 按 `t` 分发，不会报错），会**安静地忽略**它——不会崩，但也看不到；
- 网页端由服务器直接提供文件，服务器一升级就生效，不需要重新打包。

验证（本仓库的流程）：`node tools/package-client.mjs` 后启动本地服务器并 `node scripts/notice.mjs "测试"`，用 `--server 127.0.0.1:3000` 启动 exe/apk 应当看到横幅出现/消失。实测：打包好的 exe 在公告发布后立刻显示「维护」胶囊，`--clear` 后消失。

## 8. 与游戏仓库的关系（契约）与打包内容

游戏仓库（`Stronghold-Protocol`）**只读**：本仓库从它读源码，从不修改它（`git status` 永远是干净的，`git pull` 不会冲突）。

| 文件 | 作用 |
|---|---|
| `client.config.json` | `gameRoot`（默认 `../Stronghold-Protocol`）与 `defaultServer` |
| `tools/check-payload-offline.mjs` | 离线闸门：payload / 桌面产物目录 / APK 三种目标都查「有没有外部字体主机、有没有 CDN 绝对地址、字体镜像在不在」。APK 走 `--zip` 按条目解开看 —— 整包 grep 是 0 命中，条目里才有 |
| `tools/game-contract.mjs` | 复制了游戏仓库的 `DATA_SHIM_JS` 与 `SIM_PRIVATE`（这样构建不需要在游戏仓库里 `npm install`）；每次构建都对照 `server/index.js` 校验，不一致直接报错 |
| `patches/game-client.patch` | 打在 payload 上的客户端改动（3 个文件、7 个 hunk，§1.2、§6）。它是 `git diff` 出来的普通补丁，由 `tools/unified-diff.mjs` 应用（不依赖 git）；**上游改了这个文件里的任一文件 → 补丁对不上 → 构建失败**，此时需要重新生成补丁 |
| `build/client/manifest.json`、payload 里的 `build.json` | 记录这次构建基于的游戏版本：`git describe` + commit + `PROTOCOL_VERSION` |

| | 打包进去什么 |
|---|---|
| 打包 | `public/**`（含 `assets`、`fonts`、`vendor`、`webfonts`）、`data/**`、`shared/**`、`server/sim/**/*.js`（去掉 Node 专用的 `nodeData.js`）、`packs/**` 与切包时由游戏仓自己的 `tools/packs.mjs index` 生成的 `packs/index.json`（0.2.0 的语言菜单读它；问的是 **checkout** 不是摊平后的 `www/`，因为 `public/` 已经并进根）、生成的 `data.js` / `build.json` / `js/runtime-config.js` / `js/shell/picker.js` / `js/shell/picker-core.js`、`local-assets.json`（没做本地提取时给空清单）、打补丁后的 `index.html` / `js/net.js` / `js/screens/room.js` |
| 不打包 | 游戏仓库的 `server/` 其余部分（HTTP / WS / 大厅 / 对局引擎）、`docs/`、`test/`、`.cache/`、`.tools/`、`node_modules/` |

`tools/package-client.mjs` 是**增量**的：文件大小与修改时间没变就跳过，源文件删掉后产物里的对应文件也会被删——重建很快（第二次通常 0 个文件被写入）。

## 9. 排错

| 现象 | 处理 |
|---|---|
| 弹窗「客户端资源缺失」 | 先运行 `npm run client:build` |
| 报「找不到游戏仓库」 | 用 `--game <目录>`、`SP_GAME_ROOT` 或 `client.config.json` 的 `gameRoot` 指定 checkout |
| 报 `hunk … does not match` / 补丁没改到文件 | 上游改了 `public/index.html`、`js/net.js` 或 `js/screens/room.js`：按新源码重新生成 `patches/game-client.patch`，再跑一次 |
| 选择服务器页里全部"无法连接" | 地址写错、服务器没开、或防火墙拦了 `/ws`；本机测试用 `npm start` 起游戏仓库（默认 3000），页面上的 `localhost:3000` 会变绿。写的是别人给的地址却报"**对方在线，但 `/ws` 没通**"，那就是对面（反代没转发到游戏端口 / 服务已停），客户端这边没问题 —— 这条结论来自 `/healthz` 有答而 `/ws` 没通，浏览器给不了更细的原因（404 / 503 / 403 在握手层长得一样） |
| 选择页每次启动都出现 / 想换服务器 | 桌面按 **F2**（或 `--choose-server`），取消勾选"记住并直接进入"；Android 每次都会问 |
| 重启后要重新登录 / 干员调配、设置被清空 | 旧版本客户端每次启动都换随机端口（换了源，`localStorage` 读不回来）：重新 `npm run client:desktop` 生成固定 `DEFAULT_PORT`（47821）的客户端，见 §4.4 |
| Android 上局域网地址连不上 | 先确认 APK 是打开 `allowMixedContent` 打的（§5）；地址用 `192.168.x.x:3000` 这种形式，手机与服务器要在同一个 Wi-Fi |
| 报 `DATA_SHIM_JS changed upstream` / `SIM_PRIVATE is now […]` | 游戏仓库那两处变了：同步 `tools/game-contract.mjs` |
| 打包后的客户端里图片 / 音频 404 | 游戏仓库的 `public/assets` 不完整：在那边 `npm run assets` |
| 连不上服务器 | 先确认服务器活着：`curl http://localhost:3000/healthz`；再用 `--server 127.0.0.1:3000` 指向本地 `npm start` 排除客户端问题。远程服务器同理，换成对应地址 |
| 提示「客户端版本与服务器不一致」 | 服务器更新过，重新打包客户端 |
| APK 报找不到 SDK / JDK | 检查 `ANDROID_HOME`、`JAVA_HOME`、`mobile/android/local.properties`；platform / build-tools 版本要匹配 `mobile/android/variables.gradle`（当前 36） |
| `sdkmanager` 报 “Package platforms not found” | 分号被 shell 拆开了，改用 `--package_file`（见 §5） |
| 想换服务器但不重新打包 | 桌面：选择服务器页按 F2（或启动时 `--choose-server`）、或 `StrongholdProtocol.exe --server <地址>`；Android：启动时的选择服务器页；网页：`?server=<地址>` |
| 桌面客户端启动很慢（几十秒） | 用的是单文件 `--portable`：它每次启动都要解压整包到 `%TEMP%`。改用默认的目录版（`win-unpacked/`），启动只要零点几秒 |
| 桌面客户端弹窗报缺少 DLL / 打不开 | 目录版必须整个文件夹一起拷贝，不能只拿 `StrongholdProtocol.exe`（运行时 DLL 与 `resources/` 在旁边） |
| APK 里左侧有黑边 / 上下有黑边 | 装的是旧 APK：现在的主题让窗口画进刘海区（`shortEdges`）并隐藏系统栏（`MainActivity` immersive）。重新 `npm run client:android` |
| 手机横屏时准备阶段场景偏小 | 旧 APK：`shell/display.css` 去掉根字号 40 px 下限后，准备阶段和战斗、和桌面同一个比例（见 §5 的实测表） |
| 用 puppeteer 量桌面壳时窗口总是 800×600 | puppeteer 的默认视口覆盖了真实窗口尺寸：`puppeteer.connect({ browserURL, defaultViewport: null })` |

## 10. 部署与重启（服务器侧）

线上跑的是 systemd 单元 `stronghold.service`（starst.site）：

```
WorkingDirectory=/home/ubuntu/webUI/Stronghold-Protocol
Environment=HOST=127.0.0.1  PORT=3000  SP_COMBAT=client  SP_VERIFY=off   # nginx 反代对外
ExecStart=/usr/bin/node server/index.js        ← 没有 --watch
Restart=always / RestartSec=3 / KillSignal=SIGINT / TimeoutStopSec=20
```

**什么要重启**：`server/**`、`shared/**`、`server/sim/**`（启动时 `import` 进内存）和 `data/*.json`（`server/data.js` 的 `getData()` 是单例）**都要重启**；`public/**` 不用——每次请求都 `fs.stat` + 读盘。仓库里没有任何 `fs.watch` / nodemon，`Restart=always` 只在进程崩了时拉起它。

**push 会不会自动生效**：starst.site 上已经装好 `post-receive` 钩子（`receive.denyCurrentBranch=ignore`）——**`git push workplace master` 就是部署**：公告 → 重启 → 校验 `/healthz` → 撤公告，日志直接打在你这次 push 的输出里，失败会自动回滚。脚本、安装方式、配置项和排错见 **[DEPLOY-SERVER.md](./DEPLOY-SERVER.md)**。**不要**再同时装 systemd 定时器（会重启两次）。仓库与远程的现状：

| 位置 | 指向 | 说明 |
|---|---|---|
| 本地 `origin` | `git@github.com:Starst796/Stronghold-Protocol` | 你的 fork，SSH 推送正常 |
| 本地 `upstream` | `https://github.com/sganggs/Stronghold-Protocol.git` | 上游项目（开发机直连 github.com:443 会超时） |
| 本地 `workplace` | `ubuntu@starst.site:/home/ubuntu/webUI/Stronghold-Protocol` | 服务器工作目录。**非裸仓库**、`master` 正被检出；已设 `receive.denyCurrentBranch=ignore` + 装了 post-receive 钩子 → **push = 部署** |
| 服务器 `origin` | `https://gh-proxy.com/https://github.com/sganggs/Stronghold-Protocol.git` | 服务器只跟**上游**同步（钩子模式下会显得"落后"，正常） |

一次发版 = 两次 push（`origin` 留档、`workplace` 部署）：

```bash
git push origin master        # 给别人看 / 开 PR
git push workplace master     # 部署（公告会等 --lead 秒，默认 60）
```

**重启会掉什么**：全部。会话 / 房间 / 对局都在内存里（`SessionRegistry` + `Lobby`），没有任何持久化。优雅停机会给每个房间发 `room.closed{reason:'shutdown'}`、socket 以 **1001** 关闭；客户端会自动重连（只有 4001「被顶替」不重连），但重启后注册表是空的 → `byToken()` 查不到 → **新建会话**（`resumed:false`，新 `playerId`）。昵称在客户端 `localStorage` 里所以还在，**房间与进行中的对局不恢复**（`reconnectWindowMs: 10 分钟` 只对"服务器活着、只是网络抖一下"有效）。停机时长 ≈ **5 秒**（优雅收尾 <1 s + `RestartSec=3` + 启动约 0.6 s，本机实测 `start → /healthz` 200 = 626 ms）。

**一个坑**：`data/assets.json` 是被跟踪的文件，而服务器上的进程会改写它（`git status` 里常驻 ` M data/assets.json`）。钩子的 `git reset --hard` 会把它一起清掉，所以自动发版不受影响；但如果你在服务器上手动 `git pull`，先 `git checkout -- data/assets.json` 再拉。

## 11. 查服务器忙不忙（挑空窗）

`/healthz` 是公开的，`tools/server-status.mjs` 把它变成能"蹲空窗"的工具：

```bash
npm run server:status                                  # 一次采样
npm run server:status -- --watch                       # 每 60 秒采样，每 10 次汇总（min/max/均值 + 最空时刻）
npm run server:status -- --watch --under 40            # 等到 humans ≤ 40 就打印"可以动手"并退出 0
npm run server:status -- --samples 20 --interval 30    # 采 20 次（10 分钟）后退出
npm run server:status -- --json                        # 原始 JSON，喂给别的脚本
```

字段：`humans` = 真人占座（最该看的）、`matches` = 进行中的对局、`rooms`、`sockets` = 打开的连接、`sessions` = 注册表里的会话（含 10 分钟重连窗口内已断开的，所以通常 ≥ sockets）、`uptimeSec` = 进程运行时长（重启后应归零，用来确认部署生效）。

## 12. 素材与许可
打包产物里包含《明日方舟》的美术 / 音频素材，版权归鹰角网络 / Yostar，**不适用**本仓库的 GPL-3.0，仅限个人非商业自用；请勿再分发这些素材或包含它们的整合包（见游戏仓库的 [声明](https://github.com/sganggs/Stronghold-Protocol#声明) 与 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)）。

## 13. 一键发布（`package.bat` / `package.sh`）

上游（`../Stronghold-Protocol`）更新后，**手动跑一次**这个入口，把"对齐版本号 → 测试 → 打包 → 提交"串起来：

```bat
package.bat                        :: Windows（双击或命令行都行）
```

```bash
./package.sh                       # Linux / macOS / Git Bash
npm run release                    # 等价，前提是 node 在 PATH 上
```

它按顺序做四件事（实现在 `tools/package-release.mjs`）：

1. 从上游 `shared/constants.js` 读 `APP_VERSION`（顺带 `PROTOCOL_VERSION`）；
2. 把本仓库的版本字段对齐到它：`package.json`（根 / `desktop/` / `mobile/`）、`desktop/package-lock.json` 与 `mobile/package-lock.json` 的根 + `packages[""]`（只动这两处，npm 传递依赖保持原样）、`mobile/android/app/build.gradle` 的 `versionName` 与 `versionCode`（语义化版本换算：`0.1.2` → `102`）；
3. 跑 `node --test`，再调 `tools/package-desktop.mjs` 出目录版并压成 `build/dist/StrongholdProtocol-<版本>-win-x64.zip`，接着调 `tools/package-android.mjs` 把 APK 拷成 `build/dist/StrongholdProtocol-<版本>-android-debug.apk`；
4. 在本仓库 `git add -A` + `git commit`（`build/` 已 gitignore，产物不会进库）。

常用开关：

```bash
package.bat --server 192.168.1.9:3000     # 把默认服务器换成局域网地址
package.bat --no-commit                   # 只对齐 + 打包，不提交
package.bat --skip-android                # 不打 APK
package.bat --no-zip                      # 只留 win-unpacked 目录，不压缩
package.bat --no-test --skip-install      # 赶时间
package.bat --portable                    # 桌面改出单文件便携 exe
```

说明：

- **不修改游戏仓库**：上游版本只读；补丁 / payload / 壳都在本仓库完成。
- 上游改了 `public/index.html`、`js/net.js`、`js/screens/room.js` 时补丁会先失败（这是设计好的报警）：按 §9 重新生成 `patches/game-client.patch` 再跑。
- 缺 JDK 17+ / Android SDK 时脚本**跳过 APK 并继续**（只报一句警告）。本机实测可用 `C:\Program Files\Java\jdk-21` 与 `%LOCALAPPDATA%\Android\Sdk`，脚本会自己找。
- Windows 下 zip 用系统自带的 `tar -a`（bsdtar）；想要更小就自己用 7-Zip 的 LZMA2（见 §4.1）。

## 14. Tauri 壳（`tauri/`，另一条流水线 `build-tauri.yml`）

玩家报的两条是**体积大**和**启动慢**，这两条各有各的账，得分开算：

| 账 | 实测 | 归谁 |
| --- | --- | --- |
| 目录版解包后 | 1,145.4 MiB，其中 payload（素材+代码）825.4 MiB | **素材** —— 离线进对局不下载换来的 |
| 同上，扣掉 payload | **320.0 MiB 是 Electron 自带的运行时** | 壳 —— Tauri 用系统 WebView2 替掉它 |
| payload 自己的首屏 | 153 个请求 / **5.47 MiB** / 到标题页可点 438 ms | 与壳无关；0.2.0→0.2.1 只涨到 5.47 MiB（c21 是 5.46 MiB / 409 ms） |
| `portable.exe` | 每次启动把整包自解压到临时目录（实测一个实例留下 **974 MB**） | 形态 —— 与 Electron/Tauri 都无关 |

所以 Tauri 治的是那 320 MiB，治不了 825 MiB 的素材；启动慢的主因是**单文件自解压形态**，
因此这条流水线**只出目录版与安装器，不出 portable**。

那 825.4 MiB 里都是什么（2026-10-08 对**已发布**的 c22 ipa 量的，sha256 `2fa871d8…`，13,968 个文件；
命令本身是出厂闸门脚本的一个模式，apk / 目录都能读）：

```
node tools/check-payload-offline.mjs --sizes --zip Stronghold-0.2.1-c22-ios-unsigned.ipa --prefix Payload/App.app/public/
```

| 目录 | 大小 | 文件数 | 是什么 |
| --- | --- | --- | --- |
| `assets/spine` | 394.3 MiB | 3,050 | 干员/敌人的骨骼与贴图页 —— **这就是"立绘"本身** |
| `assets/audio` | 188.3 MiB | 6,057 | BGM 与音效 |
| `assets/char` | 79.8 MiB | 976 | 头像 180×180 与半身立绘 180×360 |
| `assets/local` | 60.9 MiB | 1,488 | 从官方客户端抽出来的 3D 棋盘素材（含整包里最大的那几张 2048×2048 贴图） |
| `assets/ui` | 39.2 MiB | 602 | 界面图与攻略页大图 |
| 其余（`assets/enemy|skill|band|…`、`data` `dev` `webfonts` `sim` `vendor` `js` …） | 63.0 MiB | 1,795 | 剩下的图、数据、开发页、字体镜像、对局模拟、三方库 |

再想往下砍只有两条路，都不合现在的产品约定：素材改成按需下载（那就不是"离线进对局"了），
或者砍皮肤/语音档（那是玩家要的东西）。所以这一节的结论是**别在素材上动刀，壳侧的收益见 §16**。

壳的形态：`tauri/src-tauri/src/server.rs` 是一个 std 手写的只监听 `127.0.0.1:47821` 的静态服务器，
窗口加载 `http://127.0.0.1:47821/` —— **故意与 Electron 壳用同一个 origin**：Chromium/WebView2 按 origin 划分
localStorage，博士代号、干员调配、设置、记住的服务器全在里面，端口随机或改用 `tauri://localhost`
都会让玩家以为存档丢了。端口被占时先认清"占它的是不是本游戏自己的页面"（`occupied_by_us`），
是就退出而不是退到 47822 —— 那等于悄悄换了 origin；c26 起在这之前还先看一个**内核命名互斥量**
（`already_running`），因为端口探针只看得见已经在服务的实例，看不见正在启动的实例，
两次双击挤在一起时仍然会开出第二个 origin。真的挪了端口（别人占着 47821）时也不再静默：弹一句说明
"这个窗口里代号/编队/设置会是空的，因为那是按端口存的"。

`server.rs` 是 `desktop/serve.mjs` 的手抄，所以有 `test/tauri-parity.test.js` 把两边的
MIME 表、`/media` 扩展名**顺序**、长缓存目录集合、端口常量从**源码里各读一遍**再逐条比（抄错不会有人发现：
`.skel` 的 Content-Type 错就是 Spine 静默不显示，`/media` 少一种扩展名就是全体静音）。
Rust 侧的规则另有 `cargo test`（遍历、别名顺序、Range 钳制、ETag 与 `Date.toUTCString()` 逐字节一致）。
两条都在 `build-tauri.yml` 里当闸门用，不绿不打包。

`SP_TAU_BOOT_PROBE=1` 时窗口不抬起来，壳自己数"页面把 `js/main.js` 取走"用了多少毫秒、这中间收了几个请求、
用了几条 TCP 连接，打印
`boot_probe first_request_ms=… main_js_ms=… requests=… connections=…`。流水线里那一步现在**是硬闸门**
（c25 起，以前是 `continue-on-error`，等于装饰）：去掉控制台窗口之后，这一行同时是"stdout 还可达"的唯一证据；
connections 那半个字段是 c26 加的，并且**连接数不少于请求数就判红** —— 否则哪天退回到"一个连接一个请求"，
这一行照样打印，没人会去看数字（见 §16）。runner 上没有可用 WebView2 时这一步也会红，那是环境问题不是产物问题。

**c24 的两个形态实测大小**（同一份 payload，`build-tauri.yml` run `37671372625`）：

| 形态 | 字节 | 与 Electron 同形态差 |
| --- | --- | --- |
| `StrongholdProtocolTauri_0.2.1_x64-setup.exe`（发布时资产名 `StrongholdProtocolTauri-0.2.1-setup.exe`） | 549,072,012 B（523.6 MiB） | 比 `Setup.exe`（637,943,028 B）**少 84.8 MiB，−13.9 %** |
| 目录版 `out/StrongholdProtocolTauri` | 打成 `StrongholdProtocolTauri-0.2.1-dir.zip` = 598,017,671 B；解包 858 MB（含 www） | Electron 目录版解包是 1,145.4 MiB |

省下来的正是上面那张账里的那部分 Electron 运行时。同一次 runner 上的探针是
`first_request_ms=9148 main_js_ms=10107 requests=24` —— **这个数不能拿来当"启动快/慢"的结论**：
共享 runner 上 WebView2 是冷启动、没有硬件加速、运行时可能还得现下载。README 因此把这一行标成"试验"，
真实机器上的启动表现等玩家回报；装机版仍然只出目录版与安装器两种，**不出 portable**（自解压那条账与壳无关）。

内容侧这一轮也逐个对过：`StrongholdProtocolTauri-0.2.1-dir.zip` 里 `StrongholdProtocolTauri/www/**`
与本地 payload **13,966 / 13,966 一致（0 缺 0 多 0 字节差）**，和 Electron 目录版是同一标准。
CI 侧另有三道：`cargo test`（遍历/别名顺序/Range 钳制/日期格式）+ `test/tauri-parity.test.js`
（两张表从两边源码各读一遍再比）+ 对**产物内 www** 再跑一次零外链闸门。

## 15. c25：壳自己的两条真机反馈（黑控制台 + F2）

玩家自己装了 Tauri 版，报了两条，都是壳的问题，与游戏内容无关 —— 所以这一版**只重发 Tauri 那一个资产**
（Release `tauri-v0.2.1-c25`），Electron / apk / ipa 继续用 `v0.2.1-c24` 那五个，不让人白重下 3.5 GB。

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 启动时多一个黑色控制台，里面是 `[tauri] 静态服务 port=47821 root=…` | Rust 二进制默认是 **console 子系统**，`main.rs` 没有 `windows_subsystem` 属性 | `#![cfg_attr(all(not(debug_assertions), not(test)), windows_subsystem = "windows")]`。少了 `not(test)` 会连 `cargo test --release` 的日志一起关掉 |
| 按 F2 没反应 | F2/F5/F11/F12 只在 **Electron 壳的原生层**实现（`desktop/main.mjs` 的 `before-input-event`），Tauri 一条都没有，网页版也没有 | 改成页面级：规则进 `picker-core.js` 的 `isPickerHotkey`（只有不带修饰键、非连发的 F2 算），接线进 `picker.js`。Electron 那条原生路径保留（它先 `preventDefault`，所以不会重复触发；`showPicker()` 也幂等） |

两个连带点，别漏：

1. **没有控制台之后，启动失败就没人看得见**。所以致命错误改弹原生消息框（对齐 Electron 的
   `dialog.showErrorBox`）；`MessageBoxW` 用 `#[link(name = "user32")]` 直接声明，不为此引入 windows 绑定 crate。
   "47821 上已经是我们自己的页面"那一支单独走**信息框 + exit(0)**，它不是故障。
   **CI 的探针模式（`SP_TAU_BOOT_PROBE`）绝不弹框** —— 模态框会把那一步挂到超时。
2. **`picker.js` / `picker-core.js` 是逐字复制进 payload 的**，所以 F2 这一条必须重切 payload（c25）。
   这也是为什么"只修壳"仍然产生了一个新的 payload 标签。

c25 实测（`build-tauri.yml` run `37729406637`，全绿）：安装器 `StrongholdProtocolTauri-0.2.1-c25-setup.exe`
= **549,073,131 B**（比 c24 那份多 1,119 B，就是那两个 JS 文件的差）；目录版 zip 598,018,637 B，
里面 `www/**` 与 payload 13,966/13,966 一致；**从安装器里取出** `www/js/shell/picker.js`、
`picker-core.js`、`build.json` 三个文件，sha256 与本地树逐个相等，F2 接线在里面。
启动探针这次是 `first_request_ms=3132 main_js_ms=3217 requests=24` —— 与上一次的 9148/10107 差三倍，
**只能说明共享 runner 的冷热水位不同，不能当"变快了"**；那一步现在是从 `continue-on-error` 改成的硬闸门，
它同时是"去掉控制台之后 stdout 仍然可达"的唯一证据。

## 16. c26：壳侧的四个优化（连接复用 / F12 / 单实例 / 端口挪走不再静默）

payload 一个字节没动（还是 `payload-v0.2.1-c25` 那份 tar），所以这一版仍然只发 Tauri 一个资产，
其它四个形态继续用 `v0.2.1-c24`。

| 改了什么 | 为什么 | 实测 |
| --- | --- | --- |
| 静态服务改成按**连接**服务（keep-alive） | 每个回答都 `Connection: close` 是手抄漏的一条：Node 的 `http.Server` 白送连接复用。一局里几百个文件，在 Electron 上走 6 条 socket，在 Tauri 上就是几百次 TCP 连接 + 几百个 OS 线程，而日志只会显示"变慢了" | run `37770244660` 的启动探针：`requests=24 connections=6`（平均每条 4 个请求，正是 Chromium 对单源的 HTTP/1.1 连接上限）。c25 那次同一份 payload 也是 `requests=24`，当时没有 connections 这个字段，但按代码每个回答都关连接，那 24 个请求必然是 24 条连接 |
| 续用连接时发 `Connection: keep-alive` + `Keep-Alive: timeout=5`，空闲超时也从 15 秒改成同一个 5 秒 | 我先写的断言是"Node 续用时不多发任何头"，那是**猜的**；真跑一遍 `desktop/serve.mjs`（同一条 socket 连发两问）才看到它发的就是这两行。parity 测试现在起 JS 那份服务实测、把 timeout 秒数从 Node 的头里抠出来再要求 Rust 源码里有同样的字面量 —— Node 改主意会先红，而不是两边各自漂 | `test/tauri-parity.test.js` 两条（结构 + 实测对照）；Rust 侧另有 3 条真跑 socket 的用例（一条连接拿两个回答 / 1.0 与 POST 之后确实断 / 416 之后连接仍可用），`cargo test` 在 Windows runner 上全绿 |
| release 版打开 devtools（F12） | 玩家报"白屏 / 立绘没出来"时，有问题的只有那一台机器，而 release 壳没有控制台。Tauri 只在 debug 构建默认给 devtools | `tauri = { features = ["devtools"] }`；WebView2 自带检查器，所以安装器体积几乎不动（见下表）。**"按下去有没有面板"仍然只有装了的人能回答**，这条写在 Release 说明里请玩家回话 |
| 单实例先看内核命名互斥量；端口真被挪走时弹一句 | 端口探针只看得见已经在服务的实例，看不见正在启动的实例 —— 两次双击挤在一起时第二个会退到 47822 开出一个新 origin；而换 origin 等于换 localStorage（代号/编队/设置都在里面） | 顺序钉在测试里：互斥量 → 端口探针 → 绑端口。15 秒那个旧空闲值也被断言禁掉，防止回退 |

大小账（三个形态的安装器都来自同一份 payload，所以差的是壳自己的字节）：

| Release | Tauri 安装器 | 与上一版差 |
| --- | --- | --- |
| `v0.2.1-c24`（`StrongholdProtocolTauri-0.2.1-setup.exe`） | 549,072,012 B | — |
| `tauri-v0.2.1-c25` | 549,073,131 B | +1,119 B（那两个 shell JS 文件） |
| `tauri-v0.2.1-c26`（`…-c26-setup.exe`，sha256 `214ac4b5…`） | 549,072,683 B | −448 B |

发布这一版时顺手修了一个玩家可见的配置错误：`gh release create` 默认会把新 Release 标成 **Latest**，
于是 c25 那个"只有一个资产"的 Release 抢走了本该属于 `v0.2.1-c24`（五个形态）的 Latest 标签 ——
仓库页的"最新.release"点进去只剩 Tauri 安装器。已 `gh release edit v0.2.1-c24 --latest=true` 改回，
c26 起用 `--latest=false` 创建，并且每次发完都要用 `gh release list` 看一眼标签在哪
（`gh release view --json` 根本没有 `isLatest` 字段，查不了）。

没做的两条也记在这儿：**F11 全屏**当时仍然只在 Electron 的原生层有（要页面能调壳的能力，等于必须重切 payload，
见任务里的说明）—— 这一条已在 §18 实现，但 `picker.js` 是逐字复制进 payload 的，所以要随下一次重切（c27）才到玩家
手里；第二次双击仍然只提示、不把已开的窗口抬到前面（那需要跨进程喊话 + 一次主线程调用）。

## 17. 网友服复测：门槛是 `hello`→`welcome`，而且要两个出口

`tools/probe-community-servers.mjs` 把"这台是不是真的还在跑 Stronghold"变成一条能重跑的测量。它只做一件事：
开一条 `/ws`，发一个 `hello`，读回帧，然后关掉 —— 不进房、不发别的动词、不拉字节。

**为什么不能只看握手**：任何反向代理都会回 `101`，源站没了也照样回。所以判定只有一个 —— 服务器在 `hello` 之后
回 `welcome`。

**探针自己必须先是对的**，否则健康的服务器会把它读成客户端坏了。三条来自游戏仓的规则：

- `rid` 给了就必须是**整数**（`shared/protocol.js:435`）—— 这次最初写的是 `rid: 'probe1'`，于是**每台**健康服务器
  都回 `BAD_MSG`，本机报出「10 台全死」。改成 `rid: 1` 之后，之前显示"被拒"的五台全部回 `welcome`。
- `name` 非空且 ≤ `NAME_MAX_LEN = 12`（`shared/constants.js:22`，`validateC2S` 用 `v.length`，一个汉字算 1）。
  默认名因此是「探针」而不是「探针 · 只测连接」。
- 拒绝的原因在 error 帧的 **`detail`** 里（`server/net.js:328` 的 `errorMsg(code, rid, detail)`），`code` 只是
  `BAD_MSG` 这种机器码。原来只打印 `code`，等于把唯一那句诊断丢掉。

`--control`（默认官方服）是**阳性对照**：它证明发出去的帧本身合法，所以对照失败时整张表的排名不作数（`exit 1`）。
`test/probe-community-servers.test.js` 里那三条阴性对照跑的是一个手写的 RFC 6455 服务端（不是探针自己的代码）：
按协议回 `welcome` ⇒ 必须报 `welcome` 并带 `app`；回 `BAD_MSG` ⇒ `verdict` 与 `detail` 都要能看出是被拒；只握手
不回帧 ⇒ 报超时而不是 `welcome`。另外端口没人听时 `TCP:ECONNREFUSED` 会出现在诊断列里 —— WebSocket 的 `error`
事件不带原因，所以 `连不上（error）` 那句话本来是没信息量的。

**出口（vantage）和帧一样重要。** 本机走 TUN 代理，代理给每个域名发一个 `198.18.0.x` 的假 IP：这一行里所有诊断
（连 TCP 通不通）都只是在描述代理自己，所以工具直接把解析到的 IP 打出来并标「本行不可信」。2026-10-08 两个出口的
实测：

| 条目 | GitHub runner（海外，干净出口） | 本机（代理） | 处理 |
|---|---|---|---|
| 对照 `sp.lain42.top` | `welcome` 5358 ms（→ 8.153.102.122） | `welcome`（本地源码服的阳性对照 17 ms） | — |
| linxia / nekotc / chiruno / ausevaywstr | `welcome` 1076–8395 ms | `welcome` 561–1387 ms | 保留（两个出口都通过） |
| **103.205.253.194:27527** | `welcome` 1440 ms | `welcome` 53 ms | **本次新增**，`SEED_VERSION` 2→3 |
| 183.66.27.19:20522 | `TCP 超时` 15496 ms | `welcome` 108 ms | 保留 —— 海外连不到那个端口，直连 IP 那一侧是有效测量 |
| misyra / rainya / xiaolubao | `TCP 通`但 `/ws` 握手被拒 | 连不上（假 IP） | 保留，但**记下待复测** |
| rainya:10166 | `TCP 超时` | 连不上（假 IP） | 同上 |
| cranepaul:8443 | `TLS:ERR_SSL_TLSV1_UNRECOGNIZED_NAME` | 同错（假 IP） | 同上 |

那四行"沉默"的条目**没有删**，理由是后果不对称：列表里一行死的服务器只是玩家看到的一个灰点、而且他自己删得掉；
删掉一行则所有新装玩家再也看不见它。而"从海外 runner 连不到一台中国大陆的服务器"根本不是对方宕机的证据。要删就得
再有一个大陆出口复测一次（线上那台机器可以，但那要动服务器，先不做）。

重跑：

```bash
node tools/probe-community-servers.mjs --timeout 6000                  # 本机（看每行解析到的 IP 才知可信度）
node tools/probe-community-servers.mjs --control http://127.0.0.1:<本地源码服端口>   # 阳性对照，不依赖外网
gh workflow run probe-servers.yml -R lilyco-42/StrongholdProtocolClient --ref main \
  -f timeout_ms=12000 -f 'extra=网友服 · foo=https://foo.example/'        # 干净出口；红的是测量结果，不是流水线坏了
```

**`tools/ws-url.mjs` 现在是被钉住的逐字拷贝**。它是播种条目的去重键（`picker.js` 把 `js/net.js` 的 `toWsUrl` 注入
`missingSeeds`），而它原来是对补丁里那段代码的改写版 —— 改写版把不带端口的 `[::1]` 归一成 `wss://`，补丁里的代码
给出 `ws://`。`test/ws-url.test.js` 从 `patches/game-client.patch` 重新抽出新增行、逐个函数按文本比对，再让两份
实现跑同一批输入对答案；`test/picker.test.js` 另外钉住"没有两行种子归一成同一个 socket URL"。

## 18. F11 全屏：页面 → 壳的一条命令路由（任务 #64）

Electron 壳早就有 F11（`desktop/main.mjs:168` 在 `before-input-event` 里 `win.setFullScreen()` 再 `preventDefault()`），
网页版有浏览器自己的 F11，只有 Tauri 壳两头都没实现 —— 玩家按下去什么都不会发生。

**为什么不走 HTML5 全屏**：`document.documentElement.requestFullscreen()` 在 WebView2 里只铺满客户区，标题栏和
任务栏都还在（宿主得响应 `ContainsFullScreenElementChanged` 才会真的全屏，而 wry 不响应）。那样两个壳按同一个键
得到两种不同的东西，比"另一个没有"更糟。

**为什么不走 Tauri 的 JS 窗口 API**：capability 要按 **origin** 授权，而这个壳的 origin 是"它抢到的那个环回端口"
（47821 起、连找 16 个、都不行就交给系统）。写成 allowlist 的后果是端口被占满的那名玩家静默失去 F11，
而且换到的是整个窗口 API 的权限，不是一件事。

所以走的是**页面自己 origin 上的一条路由**：`POST /__shell__/fullscreen`。静态服务与窗口在同一个进程里，
`server.rs` 收到就通过 `run_on_main_thread` 把动作递给窗口（窗口操作只能在事件循环那根线程做），并**等它回话**
再答 —— 响应正文是 `fullscreen=on|off|error|…`，不是 `accepted`，这样"命令排上了队"与"窗口真的变了"在日志里
是两种话。窗口还没建好时答 503：`picker.js` 把状态码记进 `globalThis.__SP_F11_STATE__`，于是
`sending / sent:200 / sent:503 / no-shell` 四种"按了没反应"互相能分辨。

页面这一侧只在**环回主机**上问（`shellFullscreenUrl()`）：其它主机上没有这条路由，往别人的服务器发一个 404 请求
是纯噪音。命令名两边各写一遍字符串会静默错开 —— 症状就是"按了没反应"而两套测试都绿，所以
`test/picker.test.js` 里有一条跨语言钉：从 `server.rs` 里正则取出 `SHELL_FULLSCREEN_PATH`，与
`shellFullscreenUrl('127.0.0.1')` 逐字比。

CI 能证明与不能证明的，说清楚：

| 段 | 谁证明 |
|---|---|
| 路由 ↔ 命令名 ↔ 状态码 | `server.rs` 的三个测试（`FakeShell` 记命令名、GET 被 405 拒、没有处理器时 503） |
| JS 与 Rust 的路由字符串一致 | `test/picker.test.js` 跨语言比对 |
| 命令通道 ↔ **真实窗口** | `build-tauri.yml` 的启动探针：CI 里没有键盘，所以壳自己调两次，打印 `fullscreen_probe first=… second=…`，缺行或答 `pending/rejected/unavailable/no-window` 都判红 |
| 真实按键 F11 → 页面收到 keydown | **没有人能证明**：Windows runner 上没有人手按键，而合成 `KeyboardEvent` 只能证明我自己的处理器，不能证明 WebView2 会把 F11 送进页面。要这条得真机按一次 |

这条也因此必须**随 payload 重切**才生效：`picker.js` 是逐字复制进 payload 的。壳这一侧（路由 + 窗口调用）单独发
上去也不会亮，两边要在同一个 c27 里。

## 19. c27 → c28：为什么切了两刀，以及上传为什么必须一个一个来

**c27 是"切完才发现玩家点不到"**。那一版已经把自检页打进了 payload，但 ipa/apk 只加载 `index.html`，
没有任何东西链到 `/dev/spine-probe.html` —— 一张没人能打开的诊断页等于没有。所以加了选择页多人页右上角的
「立绘自检」按钮（`picker.js`，同样是逐字进 payload 的内容），c27 的两条构建直接 cancel，重切 c28。
教训写成了闸门：**四条 payload 完整性检查现在都收 `dev/spine-probe.html|js`**，按钮链到一个不存在的页面会在
打包阶段判红，而不是等玩家报"点了没反应"。

| Release | 内置资源 tar | 说明 |
| --- | --- | --- |
| `payload-v0.2.1-c27` | 599,992,393 B `c0d18363102445f2…` | 三件事齐了，但诊断页没有入口 → 不发货 |
| `payload-v0.2.1-c28` | 599,991,734 B `31a55af76ff8684f…` | 同一个游戏提交 `v0.2.1-64-g309c42fc`（dirty:false），只多了那个按钮 |

**玩家版 `v0.2.1-c28` 是六个形态在同一个 Release**（以前 Tauri 安装器单独放在 `tauri-v0.2.1-c2*`）。理由不是整洁：
F11 要"新壳 + 新内置资源"两边都齐才生效，分两个 Release 就一定有人装错一半。

**大文件上传要一个一个传，并且别看退出码。** `gh release create` 一次性带 6 个文件（约 3.8 GB）时被外层
`timeout 1700` 中途杀掉，结果是**一个 untagged 的 Draft、assets=0**：`gh release view v0.2.1-c28` 按名字仍然能查到它
（`tagName` 已经是这个值，但 git tag 没建），所以"查不到就是没建到一半"这个判断是错的 —— 要看 `isDraft` 和
`url` 里的 `untagged-…`。改成单个文件上传后实测 549 MB / 3m09s（≈2.9 MB/s），digest 与本地逐字节一致，
剩下的按序传完再 `gh release edit --draft=false` 发布（那一步才建 tag，也才会触发 `on: push: tags: v*` 那条矩阵）。

---

## 20. 打包与测试搬到 runner 上（`cut-payload.yml` / `test-game-branch.yml`）

规矩是用户定的：**只有 GitHub Actions 可以编译、运行、测试**。这一条改变了本仓库的一个老前提 ——
`build-clients.yml` 顶上写着「为什么不在 CI 里生成 payload」，理由是素材不在 git 里、CI 现拉上游会少掉我们补齐的那
17 个文件。理由本身没错，但它假设的是「素材只能从上游拉」。现在我们自己发布的 payload tar 就是那批补齐过的素材，
它已经在 GitHub 上，所以**素材从上一版 payload 取，代码从游戏仓取**，两者在 runner 上合体就够了。

两条 lane 各管一半：

| lane | 管什么 | 素材从哪来 |
| --- | --- | --- |
| `test-game-branch.yml` | 游戏仓 `npm test`（fork 自己没有 CI，这是唯一的兜底） | 上一版 payload tar 的 `public/assets\|fonts\|vendor` + `data/local-assets.json` |
| `cut-payload.yml` | 打出 payload 本体并过六道闸门 | 同上（`data/voice-langs.json` 不再拷，见 §1 那一行），然后 `tools/fetch-assets.mjs` 补增量 |

`cut-payload.yml` 存在的直接理由是 **`patches/game-client.patch` 的锚点**：补丁按上下文行匹配（`tools/unified-diff.mjs`
允许 ±200 行漂移，但上下文内容变了就红）。上游 0.2.2 往 `public/js/screens/room.js` 的 import 区插了
`openStats` / `SettingsButton` 两行，于是 `@@ -20,7 @@` 那一块再也不是连续的七行 —— 打包在
`hunk @@ -20,7 @@ does not match` 处红。这个红是好事：它拦住的是一份**邀请链接仍然指向本机地址**的包。
重锚的办法不改补丁语义，只换 hunk 头与上下文行（`@@ -22,7 @@` / `@@ -84,10 +84,11 @@`），改完必须在 runner 上重新打一次
才算数，本机跑一次不算。

闸门里最容易误解的两条：

* **游戏树必须干净**（`git status --porcelain` 为空）。`build.json` 的 `game.dirty` 就是这条命令的非空判断，
  provenance 闸门只接受 `dirty:false`。所以这一步**不装 npm 依赖** —— `npm install` 会改 `package-lock.json`，
  树一脏这份包就追不到 commit（实测过：只有 ` M package-lock.json` 一行，看起来无害，闸门却红）。
  packer 与 `fetch-assets` 只用 node 内建和游戏仓自己的相对模块，不需要依赖。
  同理，如果 `data/assets.json` 被 `fetch-assets` 改写，那是**要回游戏仓提交**的东西，不能烤进 payload。
  第一次跑被一条 `?? data/voice-langs.json` 挡下：那是 0.1.4 时代从上一版 payload 拷回来的派生登记，而 0.2.2 的树里
  既没有生成它的工具也没有读它的代码（本文件 §1 那一行已经改成现实）。第一反应是"给它加 exclude"，但那会让包多带一个
  没人读的文件、还让闸门为它弯一次规则 —— 正确的做法是不拷它：包应当正好反映那棵树。闸门红得对，改的是 lane。
* **失败要能指名道姓**。`test-game-branch.yml` 原本是 `npm test 2>&1 | tail -60`：它把红的那条用例连同报错一起
  扔掉了，日志里只剩 `# fail 1`，谁也不知道是哪一条。现在整份输出落盘、上传成 artifact，只把 `not ok` 行与
  `error:/expected:/actual:` 打进日志。一个只会说「红了」的闸门不是闸门。

`publish` 默认 `no`：第一次跑只验「补丁能不能打上、闸门过不过」，不产生任何对外可见的东西。
要出包时先 `draft`（玩家看不到），核对 `build.json` 与 digest 之后再 `gh release edit --draft=false`。

**收口这一步也在 runner 上（`publish-client.yml`）**：c28 那次是我本机 `gh run download` 三个 artifact（约 3.8 GB）
再逐个上传 —— 那是纯中转，还差点把盘写满。这条 lane 的输入是两条流水线的 run id，产物在对象存储里内部搬一趟即完成。
它第一次真跑教了三件事，都写进了 lane：① artifact 里的文件名是构建工具的默认名（`app-release.apk`、
`Stronghold-ios-unsigned.ipa`），玩家报障说的是包名，所以 lane 要按 tag 自己改名，并且**形态核对要对最终文件名判**
（`\.apk$` 对任何 apk 都成立，等于没判）；② 没有 checkout 的步骤里每个 `gh` 调用都要显式 `-R` 与 `GH_TOKEN`
（`gh run download` 会先 `git rev-parse`，不是仓库就直接死）；③ Draft 的资产 URL 只有带 token 才取到，
所以"匿名 200"这一条在 draft 模式下永远红 —— 它属于 `--draft=false` 之后，不是之前。

已发布：`v0.2.2-c32` 六个形态，每条 URL 匿名 200，sha256 与 lane 里算的逐条一致
（apk `72c54be5…`、ipa `e98795f9…`、desktop zip `fc8411dd…`、portable `1384760e…`、Setup `9a69cd7a…`、Tauri `6d397666…`）。
Tauri 那份 `-dir.zip`（598 MB 解开的整棵树）不再发给玩家，与 c28 起的六个形态保持一致。
tag 已存在就直接失败 —— 绝不覆盖已发布的资产。

**第一份由这条 lane 出的包**：`payload-v0.2.2-c30`，资产 `sp-client-payload-0.2.2-c30.tar.gz`
600,297,895 B，`sha256:c425763375674a7633a71428966035edbca737322f63e5a8e844e2d48d175035`，
`build.json` 的 sha256 是 `bad91eb716f9e4c65e353a8236efd0ccce875c396ec5262f95528795c28d4cb3`
（游戏 `0.2.2` / commit `b7dfc082` / dirty:false / describe `v0.1.3-646-gb7dfc08`）。
它之后 exe / apk / ipa / Tauri 安装器都只从这一个 tar 出，`build-clients` 与 `build-tauri` 的 `payload_url`
填 Release 的公开下载地址即可 —— 那条 URL 匿名 200，不再依赖欠费中的 `dl.lain42.top`。

**c30 / c31 / c32 为什么是三刀**：c30 是第一刀（补丁重锚，闸门全绿，已公开）；c31 是第二刀，带的是
`spine-probe` 页的"清单没加载不许报全通过"那一修（`feat/skins@642a8bb4`），它只到 Draft；WebKit 那一步第一次真跑
又把这一页的第二个自坏挖出来（问美术索引用 chessId 而不是 charId，见 `docs/IOS-ART.md` §6），于是第三刀 c32
（`feat/skins@082fc0a8`，600,300,419 B，`sha256:2043e9cfd58f…`）才是玩家拿到的那一份。已公开的东西一个都不动：
payload Release 只增不改，编号跳号是有记录的（c16 也这样决定过不发玩家版）。

**fork 的 tag 少了一截**：runner 里 `git describe` 报 `v0.1.3-648-g082fc0a`，而本机是 `v0.2.2-68-g082fc0a8` ——
因为 fork 的 `origin` 只有到 `v0.1.3` 的 tag，上游的 `v0.2.0/v0.2.1/v0.2.2` 从来没推过去。已补推
（`git push origin refs/tags/v0.2.2` 等三个）。这不改包的内容：provenance 认的是 `game.commit`（完整 sha）与
`dirty:false`，describe 只是给人读的近似坐标 —— 但它读起来像 0.1.3 时代，就没人会信它，所以值得修。

`--target` 这一脚踩过：`--target` 这一脚踩过：`gh release create --target <游戏的 sha>` 得到 `HTTP 422 Release.target_commitish is invalid`。
Release 建在**客户端仓**上，target 必须是那个仓里的 ref/commit；游戏的出处由 `build.json` + provenance 闸门 + notes 承担，
不需要（也不应该）由 tag 指向哪个 commit 来说。
