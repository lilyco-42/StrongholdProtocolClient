# FREE-LAN.md — 「一键联机」：玩家之间直连，不经过我们的服务器

> **状态**：桌面端已发布 v0.2.5-c43。Android 内置 VPN/JNI 正在独立分支开发，尚未真机验收或发版，参见 docs/ANDROID-LAN.md。
> 已发布 Android APK 仍需外装 EasyTier；iOS 不变。
> 缺什么、以及为什么。
> **服务端那半在另一个仓库**：运维仓 `lilyco-42/lain42-stronghold-ops` 的
> `docs/20-easytier-lan-m1.md`（M1 方案）与 `extensions/sp-lan-directory/`（房间目录服务）。
> 本文只讲**客户端这一侧**，以及三端的差距。
> **本文不碰游戏本体**：M1 全程游戏仓零改动、零重启（见 §2）。

---

## 0. 要解决什么

三件事，按用户报上来的顺序：

1. **朋友之间想一起玩，但没人会开服务器。** 上游 `docs/DEPLOY.md` §2.1 本来就推荐
   Tailscale / ZeroTier，§2.2 的 cloudflared 是"朋友什么都不用装"那条路 —— 也就是说
   **组网这件事上游已经认了**，只是没把"玩家怎么用"接进客户端。
2. **服务器压力大。** 线上是一台 2 vCPU / 1.7 GB 的小机器，`docs/08` 记的带宽上限 3 Mbps，
   而 2026-10-11 实测 eth0 TX 已经 **394 KB/s ≈ 3.15 Mbps** —— **贴着天花板**。
   一局对战的 WS 流量占出口约 76%（运维 `docs/06`）。把它挪到玩家之间直连，
   是这台机器上**唯一**量级够大的减负手段。
3. **用户是小白。** 不能让他填虚拟 IP、不能让他装第二个软件、不能让他配密钥。
   他要的是：下载 exe → 双击 → 点一下「开启联机」→ 房间里出现别人的服。

**做成的样子**：选服页顶部一张「联机」卡片，未开启时是一个按钮，开启后局域网里的房间
直接出现在服务器列表里，包括我们自己的官方服（以 `10.126.126.1:5150` 出现，标注
「官方服 · 局域网直连」）。玩家全程不需要知道 `10.126.126.x` 是什么。

---

## 1. 为什么是 EasyTier，不是自研 P2P

先说已经作废的那条路：`feat/p2p-match`（PR #9，CI 全绿）是自研的浏览器内 WebRTC 大厅
（Trystero）。它的**唯一**优势是"玩家免安装"—— 浏览器里直接跑。**已关闭。**

关掉的原因是用户拍板的一句话：*"别吧 p2p 那个不成熟 用成熟的"*。而更关键的是，
**我们根本不需要自研**：

* 上游 `docs/DEPLOY.md` §2.1 已经推荐 Tailscale / ZeroTier —— 组网是既定答案，我们的
  增量只是**把它接进客户端**，不是发明一种组网。
* EasyTier（★14k，Rust/Tokio，Apache-2.0 / LGPL-3.0）满足全部硬条件：
  **去中心化**、**免账号**、**控制面不在海外**、网络只用「网络名 + 密码」标识，
  Windows 有安装包与绿色版、**Android 有官方 APK**。
* 国内 Tailscale / ZeroTier 的控制面不稳，而 EasyTier 的公共共享节点是社区可自建的。

⚠️ **EasyTier 官方公共节点已经全死**，这不是故障是政策：`public.easytier.top` /
`public2.easytier.cn` / `public.easytier.net` 三个域名 **NXDOMAIN**（三家 DoH 一致）。
上游 issue **#1566** 说得很直接：MC 社区的需求"超出承载极限"，请游戏社区别过度混用共享节点。
所以 M1 用的是**我们自己的节点**（`sp.lain42.top:11010`），公共节点只当备选。

---

## 2. 服务端那半（简述，细节在运维仓）

拓扑一行说清：

```
玩家 A 的 EasyTier ──┐
                     ├── P2P 直连（打不通时走 sp.lain42.top 中转）
玩家 B 的 EasyTier ──┘
        │
        └─ 虚拟网段 10.126.126.0/24

服务器：easytier-lan.service    tun0 = 10.126.126.1/24
        easytier-lan-bridge     socat 10.126.126.1:5150 → 127.0.0.1:5150
```

**为什么是 socat 而不是改游戏服的 HOST**：游戏服只监听 `127.0.0.1:5150`，而改监听地址
要重启 —— 重启就丢掉所有进行中的对局（状态只在内存里）。socat 桥接让**游戏仓零改动、
游戏服零重启**。

`--private-mode true` + `--foreign-relay-bps-limit 262144`：前者拒绝外部中转我们的流量，
后者把"替别人转发"的带宽钉在 256 Kbps —— 这台机器贴着 3 Mbps 天花板，不能变成公共中继。

**唯一的外部阻塞**：阿里云安全组放行 TCP/UDP `11010` + TCP `11011`（AI 开不了，需要人来点）。

房间目录服务在运维仓 `extensions/sp-lan-directory/`，读 `easytier-cli peer` 的输出 →
按 CIDR 过滤 → 并发探每个 peer 的 `:5150/healthz` → 汇总成一份只读 JSON，
挂在 `https://sp.lain42.top/api/lan/v1/rooms`。它**只回环监听**（`127.0.0.1:5188`），
由 pingap 转出去。

---

## 3. 客户端这一半

### 3.1 四个端点，同一个 origin

两个壳各自起一个只监听 `127.0.0.1` 的静态服务，页面就跑在 `http://127.0.0.1:<port>` 上。
联机这条路**复用同一个 origin**，所以页面不需要第二个 origin、也不需要任何 CORS 规则：

| 端点 | 谁答 | 说明 |
|---|---|---|
| `GET /lan/status` | 两个壳 | `{ ok, state, message, hint, directoryUrl, … }`，**永远不含密钥** |
| `POST /lan/up` | 两个壳 | 拉起隧道（幂等） |
| `POST /lan/down` | 两个壳 | 拆掉隧道（幂等） |
| `GET /lan/rooms` | **只有 Electron** | 代理房间目录；Tauri 刻意不做，见下 |

**Tauri 为什么不做 `/lan/rooms`**：那个壳存在的理由就是省体积（`desktop/` 目录版里有
320 MiB 是 Electron 自带的运行时，换成系统 WebView2 只剩十几 MB），它刻意零依赖 ——
而目录是 `https://…`，自己发这个请求就得拉进一整套 TLS。目录服务本来就带
`access-control-allow-origin: *`，所以页面直接取它更省。为此 `shell/lanRooms.js` 的
`fetchLanRooms` 是两段：**先试壳的代理，拿不到就回落到 `/lan/status` 给的 `directoryUrl`**。
Electron 那条路没变。

### 3.2 三条不可让步的原则

与 `docs/SERVER-LIST.md` 完全同源，因为这是同一类"从外面拿服务器地址"的东西：

* **P1 端点不存在是正常的。** 浏览器版、Android WebView、iOS 根本没有壳，`/lan/*` 答 404。
  那是"这个构建不能联机"，不是错误、不重试，选服页**直接不显示**这张卡片 ——
  不给玩家一个点了注定失败的按钮。
* **P2 目录给的地址在这里重新校验，永不自动连接。** 必须过 `isPrivateIPv4`（只有
  `0/127/10/192.168/172.16-31` 算私网，与游戏自己的 `tools/ws-url.mjs` 同一套判据）
  且必须有显式端口。一份被投毒、有 bug 或单纯写错的目录，**不能**把玩家的客户端指到任意主机上。
  不可达的 peer 直接丢掉，而不是灰着显示一个点不动的条目。
* **P3 纯增量。** 隧道没开时，选服页与以前逐像素相同。

### 3.3 密钥怎么传

**网络口令是所有玩家共用的**（EasyTier 只用「网络名 + 密码」标识一个网络）。所以：

* 它**不进仓库**：CI 从 secrets 注入（`SP_LAN_NETWORK_NAME` / `SP_LAN_NETWORK_SECRET` /
  `SP_LAN_PEERS`），`tools/fetch-lan-core.mjs` 把它写进构建期的 `lan-config.json`。
* 它**不进 argv**：`--network-secret` 在命令行上是 `ps` / 任务管理器一眼可见的。
  壳把配置写成用户数据目录里一份 0600 的 TOML，子进程只拿到 `-c <file>`。
* 它**不进日志**：两个壳都有一份 `redact()`，子进程 stdout/stderr 在落盘前先抹掉密钥。
  有一条测试专门钉这个（让 sidecar 把密钥回显到 stderr，断言状态里搜不到）。

⚠️ **诚实说清这条模型保护什么、不保护什么**：它防的是"陌生人误连进我们的虚拟网络"。
它**不防**"有人把客户端拆开、把密钥抠出来"—— 密钥就在安装包里，任何拿到 exe 的人都能拿到它。
这是 EasyTier 网络名+密码模型的固有性质，不是实现缺陷。真要更强的隔离，
得换成"每人一份凭证 + 一个会鉴权的入口"，那是另一个量级的工程。
**现实里的兜底**：游戏服自己的房间密钥（邀请链接里的 `?room=XXXX`）仍然有效 ——
进了虚拟网络 ≠ 能进任何一局。

### 3.4 Windows 需要管理员权限

建 TUN 网卡要管理员权限，而**这件事的表现不是 `spawn` 失败**：easytier-core 起得来、
拿不到网卡、一两秒内退出。

所以两个壳的判据都是**"刚启动就死了"（< 8 s）**，提示直接写：

> 最常见的原因是 Windows 需要管理员权限才能创建虚拟网卡：关掉客户端，右键图标 →
> 「以管理员身份运行」。

并把**子进程自己最后一行 stderr** 带进消息里 —— 那是"为什么起不来"唯一的真线索。
（原来只在 `spawn` 报 `EPERM` 时才提示，也就是说那条提示几乎永远不会触发。已修。）

**刻意不静默提权**：UAC 弹窗忽然出现，对小白来说比"点了没反应"更吓人。
游戏本身照常能玩，只是没有隧道。

### 3.5 体积与构建

`tools/fetch-lan-core.mjs` 从 GitHub Release 拉固定的 **EasyTier v2.6.4**，只取 4 个文件：

| 平台 | 文件 |
|---|---|
| win32 | `easytier-core.exe` + `wintun.dll` + `Packet.dll` + `WinDivert64.sys` |
| linux / darwin | `easytier-core` |

**不发 `easytier-cli`、不发自带 web 控制台**（省约 10 MB）：壳判断"官方服通不通"靠的是
探 `10.126.126.1:5150/healthz`，不需要 CLI。

实测（2026-10-13）：release zip 32,657,720 B → 抽出 4 个文件，`easytier-core.exe` 24.4 MB，
解压后合计约 25 MB。相对 709 MB 的桌面 zip 是 **+3.5%**。

**下载走镜像**：GitHub Release 直连在国内不可用（我们服务器实测 34 KB/s 后被 reset），
默认镜像是实测最快的 `gh.dev.438250.xyz`（**1.88 MB/s**，对比 ghfast.top 253 KB/s /
gh-proxy.com 118 KB/s / ghproxy.net 76 KB/s）。`SP_LAN_MIRROR` 可覆盖，
`SP_LAN_DIRECT_URL=1` 强制直连。

**三条防线，都是为了"镜像抽风不能拖垮整个客户端构建"**：

1. **失败不致命**：默认打出不含联机组件的客户端，其余功能不受影响。正式构建加
   `--require` 让它红 —— 配了密钥还下载失败，那是真问题。
2. **有超时**（元数据 15 s、包 300 s）。实测镜像可以接下 TCP 然后一直不吐字节；
   没有超时就是等 GitHub 那 6 小时的作业上限。
3. **目录一定存在**：electron-builder 的 `extraResources` 与 tauri 的 `bundle.resources`
   缺目录都会直接中断构建，所以无论成败都先把目录建出来。

### 3.6 CI 的产物闸门

两个流水线各有一步**在产物里**核对 `lan/` 真的存在且配置完整：

* `build-clients.yml` → `build/desktop/win-unpacked/resources/lan/`
* `build-tauri.yml` → `out/StrongholdProtocolTauri/lan/`

配了密钥就要求 `easytier-core.exe` / `wintun.dll` / `lan-config.json` 三件齐，
并解析 `lan-config.json` 确认 `networkName` / `networkSecret` / `peers` 都在；
没配则只核对目录存在并 `::notice::`。

为什么值得一条闸门：`extraResources` 漂了、或 fetcher 静默降级，玩家会下到一个
**「有联机按钮但点了没反应」**的客户端 —— 那比没有按钮更糟。

---

## 4. 实测证据

### 服务端（2026-10-11 / 10-13）

```
tun0            10.126.126.1/24
easytier-core   监听 0.0.0.0:11010，RSS 31.5 MB
socat           监听 10.126.126.1:5150
curl http://10.126.126.1:5150/healthz   → 真实游戏服 JSON
```

房间目录（2026-10-13 17:18 UTC 实测）：

```json
{"ok":true,"schemaVersion":1,
 "network":{"cidr":"10.126.126.0/24","port":5150,"peers":1,"reachable":1},
 "rooms":[{"virtualIp":"10.126.126.1","port":5150,"hostname":"Lain42","self":true,
           "link":{"cost":"Local","nat":"PortRestricted"},"reachable":true,
           "app":"0.2.4","rooms":61,"humans":75,"bots":26,"sockets":44,"joinable":true}]}
```

`access-control-allow-origin: *` 已确认（这正是 Tauri 那条回落能成立的前提）。

### 客户端

* `node --test` 全量 **263 tests / 262 pass / 1 skip / 0 fail**。
* `cargo check --all-targets`（Tauri crate，含测试代码）**通过**。
* `lan.rs` 的 14 条单元测试用 `--target x86_64-pc-windows-gnu` + mingw gcc 实跑：
  **14 passed**，含两个真实 socket 用例（读状态行 / 连不上时 false / 非 2xx 时 false）。
* `tools/fetch-lan-core.mjs` 真实下载过：32.6 MB → 4 个文件 → 22 s。
* 超时与 `--require` 都实测过：把镜像指到一个黑洞地址，默认退 0 并写出带 `error` 的
  `lan-core.json`；加 `--require` 退 1。

⚠️ **本机没有 MSVC 链接器**，所以 Tauri 那份只验证到"编译 + 单元测试逻辑"这一层，
**没有在本机产出过 exe**（红线：产物一律走 CI）。真机行为要等 CI 的产物。

---

## 5. 平台差距（**这一节是本文的重点**）

| 平台 | 状态 | 差什么 |
|---|---|---|
| Windows（Electron 壳） | ✅ 已落地 | 无。玩家点一下按钮，Windows 可能要一次管理员权限 |
| Windows（Tauri 壳） | ✅ 已落地 | 无 |
| **Android（已发布 c43）** | ⚠️ **手动可以，一键未发布** | 见 §5.1（手动装 EasyTier + 手填 `10.126.126.1:5150` 今天就能连） |
| **iOS** | ⛔ **做不到** | 见 §5.2 |

### 5.1 Android —— 能做，但和我们现在的分发方式冲突

**先说一件容易漏掉的事：Android 玩家今天就能联机，只是要手动。**
EasyTier 有官方 Android APK，装上、加进网络之后，在选服页手填 `10.126.126.1:5150`
（或任意 peer 的虚拟 IP）就能连上 —— **客户端零改动**。这是既有的行为，不是这次新加的：
选服页对"无 scheme 且带端口的地址"会**同时探 `ws://` 与 `wss://`**（`shell/picker-core.js`），
而 `10.126.126.x` 会被 `ws://` 那条探中。

所以 Android 的差距是**便利**，不是能力。要做成"一键"，还差三件事：

1. **把 APK 装到玩家机器上。** 客户端不能在后台静默装另一个 APK：需要
   `REQUEST_INSTALL_PACKAGES` 权限 + 一个 `FileProvider`，而且**玩家必须手动点确认**。
   也就是说这条路必然是"下载 → 跳系统安装器 → 玩家点一下"，不是一键。
2. **让 EasyTier 拿到网络配置。** 桌面端我们写一份 TOML 就够了，Android 上那份配置
   在**另一个 App 的沙盒**里，我们写不进去。上游的分享链接格式是
   `https://easytier.cn/comp_cfg?cfg=<压缩配置>`（配置全内嵌、本地解压，不依赖该域名可用），
   但这个格式主要是给 **OHOS** 用的 —— **Android 端能不能吃它，我们没实测过**，
   这是下一步要验的第一件事。
3. **VPN 权限与流量归属。** EasyTier 在 Android 上起的是 `VpnService`，第一次要玩家
   授权。授权之后虚拟网卡是系统级的，我们的 WebView 流量也会走它，理论上没问题 ——
   但**没在真机上验证过**。

**还有一条更根本的问题**：手机流量下 P2P 打洞的成功率。运营商 NAT 比家庭宽带更狠，
很可能退化到走中转，而中转带宽是我们那台贴着 3 Mbps 天花板的机器。
**在真机实测之前，不该对玩家承诺"手机也能联机"。**

> **建议**：Android 的"一键"排在 Windows 真机验证之后。它的收益是便利（省掉"自己装 EasyTier
> + 手填地址"），不是"从不能连变成能连"—— 后者今天已经成立。先做 §6 的第 3 步更划算。

### 5.2 iOS —— **做不到，别在这上面花时间**

未签名的 ipa **不可能**建立 VPN。iOS 上任何 VPN / 隧道能力都必须走 **Network Extension**，
而它需要 Apple 签发的 **Network Extension entitlement** —— 那是要开发者账号 + 审核的。
我们现在发的是未签名 ipa（`docs/ANDROID-SIGNING.md` 同一条链路上的 iOS 产物），
**连安装都要玩家自己想办法**，更不可能带一个网络扩展。

**iOS 玩家今天能做的**：连官方服（`sp.lain42.top`），一切照旧。
**将来若有签名分发**（Apple Developer Program + 真签名），才谈得上在 App 内起隧道。

---

## 6. 已知未做 / 下一步

按价值排序：

1. **给 CI 配上 secrets**（`SP_LAN_NETWORK_NAME` / `SP_LAN_NETWORK_SECRET` / `SP_LAN_PEERS`）。
   没配的话，打出来的客户端会**静默地**不含联机组件 —— 这正是产物闸门会 `::notice::` 的地方。
2. **阿里云安全组放行 TCP/UDP 11010 + TCP 11011**（需要人点，AI 开不了）。
3. **真机验证 Windows 全流程**：装 → 点「开启联机」→ UAC → 看到官方服 → 进去玩一局。
   这条没做过之前，后面几步都是空谈。
4. **Android 的"一键"**（§5.1）：先实测"Android 端能不能吃 `comp_cfg` 分享链接"，
   再决定是引导安装还是自己实现一个最小客户端。
   **注意这不是"让 Android 能联机"** —— 手动装 EasyTier 今天就能连（§5.1 开头）。
5. iOS：**不做**（§5.2）。

---

## 7. 代码在哪

| 东西 | 位置 |
|---|---|
| Electron 壳的 sidecar | `desktop/lan.mjs` + `desktop/serve.mjs` + `desktop/main.mjs` |
| Tauri 壳的 sidecar | `tauri/src-tauri/src/lan.rs` + `server.rs` + `main.rs` |
| 页面这一侧（两个壳共用） | `shell/lanRooms.js` + `shell/picker.js` |
| 构建期抓二进制 | `tools/fetch-lan-core.mjs` |
| 打包接线 | `desktop/package.json`（`extraResources`）、`tauri/src-tauri/tauri.conf.json`（`bundle.resources`） |
| CI | `.github/workflows/build-clients.yml`、`.github/workflows/build-tauri.yml` |
| 测试 | `test/lan.test.js`、`test/lan-rooms.test.js`、`test/fetch-lan-core.test.js`、`test/tauri-parity.test.js`（两个壳的契约不许漂移）、`lan.rs` 里的 `#[cfg(test)]` |

**两个壳是两份手写实现**，所以 `test/tauri-parity.test.js` 里有一条契约对齐测试钉着：
前缀、三条路由、状态词表、JSON 字段名、RPC 端口、网卡名、`-c` 传密钥，
以及两个打包配置里都必须有 `lan`。

漂移的症状特别难查 —— 字段名对不上，页面就永远停在"正在开启"，而两个壳的日志都干干净净。
