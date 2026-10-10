# 自动更新（客户端自己升级，不再每次重发安装器）

写这份的动机是一句需求：**"我以后不想维护这个项目客户端了。"** 现在每次上游同步要走完
`cut-payload → build-clients → build-tauri → publish-client` 四步、发六个形态，玩家每次下 600 MB。
这条路径要变成"机器自己做，人只看结果"，缺的不是 CI（那部分已经能跑），是**客户端能不能只取真正变了的那几 MB**。

## 1. 一刀切在美术上，不切在版本号上

payload 里 99% 的字节是美术：一条 `assets/` 就 13,342 个文件、约 800 MB，而上游同步真正改的是 `js/ css/ data/ dev/`
这几百个文件。分界写死成一条，CI 与壳共用同一个约定：

| 半边 | 内容 | 谁提供 | 多大 |
| --- | --- | --- | --- |
| **art** | payload 根下的 `assets/` 一条目录 | 装机时那份，或某一次"美术也换"的完整包 | ~800 MB |
| **code** | 其余全部（含 `vendor/`、`webfonts/`、`data/`、`js/`、`css/`、`index.html`、`build.json`） | 每次出包都能重下 | 待测（几个 MB 量级） |

`vendor/` 归代码那边是有意的：上游换 pixi / pixi-spine 版本必须能随增量走，否则"代码新、pixi 旧"会装出一个坏包。

**这条分界是被闸门证明的，不是被注释相信的**：`cut-payload.yml` 里"拆成两半"那一步把代码包解出来、原样放回
`assets/`，再与整份 payload `diff -r` —— 必须逐字节一致（阳性对照）；同时要求代码包的文件数少于整包的四分之一，
否则"什么都没拆出去"也会让 `diff -r` 永远成立（阴性对照）。少任何一个都是假绿。

## 2. 清单（客户端读的那一个文件）

每次出包上传 `sp-client-manifest-<版本-刀号>.json`，字段：

| 字段 | 含义 | 壳怎么用它 |
| --- | --- | --- |
| `schema` | 清单格式版本 | 不认的 schema 一律不应用（宁可不更） |
| `version` / `game` | payload 的游戏版本与 commit | 显示给玩家、写进日志 |
| `code.file` / `code.sha256` / `code.files` | 代码增量的名字与校验 | 下载后**先验 sha256 再解包**，不符就丢弃 |
| `art.digest` / `art.files` / `art.bytes` | 这份包对应的美术指纹（名字+内容，`sha256` 链） | 手里的美术指纹不等 → 不能吃增量，回到"请下完整包" |
| `artFrom` | 美术是从哪个已发布 payload 拷来的 | 出问题时能一眼说清"这批素材是哪一刀的" |
| `minShell` | 能吃这份增量的最旧壳 | 壳版本不够就不推：壳自己不走这条路 |

美术指纹是"名字 + 每个文件的 sha256 再聚一次"，不是 mtime —— mtime 在解包/打包里会变，用它做判据会把好包判成不同。

## 3. 壳侧的落地顺序（还没做完，按这个顺序做）

1. ✅ **payload 位置能被换（已做，run 38024617803：cargo test + 那条一致性闸门都过）** —— Tauri 侧已经有 `locate_www()`：`$SP_WWW` → 安装目录 `www/` → exe 旁边 → 开发 checkout。
   Electron 侧是写死的 `process.resourcesPath/www`（`desktop/main.mjs:32`），要补成同一条链 + `<userData>/payload/current`。
   这一步不改任何行为，只是让"外面那份"能被选中。
2. **解析与切换**：`<userData>/payload/<cut>/` 解包，成功后原子地把 `current` 指针换过去；失败留在上一份。
   启动时如果 `current` 指向的目录不合法（缺 `index.html` 或 `build.json` 读不出），回落到安装目录内置那份。
   回落到内置是硬要求：**自动更新绝不能变成"有人打不开游戏"**。
   实现：`desktop/payload-path.mjs`（一份纯函数，`test/payload-path.test.js` 直接跑它）与
   `tauri/src-tauri/src/main.rs` 的 `locate_www()` / `payload_problem()` / `app_data_dir()`。
   两条规则由 `test/tauri-parity.test.js` 钉住：`$SP_WWW` → 已应用的更新 → 内置 → 开发 checkout 的次序，
   以及"合格 = 有 `index.html` **和** `build.json`"。Electron 每次启动把选中的来源与被跳过的原因写进
   `<userData>/client.log`，所以"我更新了没生效"有地方可查。
   已发布的 `v0.2.2-c32` 里那批壳**不含**这条链（它比这条改动早）—— 不回头覆盖它，改动随下一刀出。
   两边的 userData 不是同一个目录（Electron 按产品名，Tauri 按 identifier），也就是各管各的更新 —— 目前不共享，
   共享要先把落点从各家的数据目录里搬出来，那是另一笔账。
3. **取清单与下载**：读 `https://github.com/.../releases/…`（公开仓，匿名可读）。超时/失败静默，不挡启动、不弹全屏错误。
4. **完整性**：sha256 是底线。真正要防的是"仓库被写到就能给所有客户端推代码"，所以清单本身要签：
   一把 ed25519 私钥在 CI secret 里，公钥烤进壳，验签不过就不应用。没有这一步之前，这条链路只能算"预发布"。
5. **canary / stable 两个指针**：自动出的包先进 canary；stable 由人（或"绿满 N 天且没人报障"的规则）往前挪。
   在线玩家 300 多，上游一次坏合并直接自动全量是拿玩家试错。

## 4. 三个平台的现实（决定了"自动"能到什么程度）

| 平台 | 能做到 | 做不到 |
| --- | --- | --- |
| Windows（Electron / Tauri） | 真自动：后台查清单 → 下代码增量 → 下次启动生效；整包升级可交给各自官方 updater | 没有代码签名证书，安装时 SmartScreen 仍会警告（与更新无关） |
| Android | 发现新版本 → 下载 APK → 玩家点一下安装。签名钥匙已固定（#59），覆盖安装不会再来一次 `-7 签名不同` | 静默自装不行，系统不允许 |
| iPhone（未签名 ipa） | 只能把"更新"变成 AltStore/SideStore 那类定时重签，玩家仍需自己的 Apple ID 参与 | **不可能真自动**，这是签名机制的限制，不是我们的实现问题 |

还有一个共同前提：自动更新要求玩家连得到 GitHub。大陆住宅网络对 GitHub 是时好时坏（实测过 Node 直连被
`ECONNRESET` 而 curl 同一 URL 200），所以第 3 步的每一项都必须是"可选、后台、失败退回内置那份"。

## 5. 还有一层"自动"是人这一步

上游发新 tag → 检测到 → 开同步分支 → 跑游戏套件与 EXT-SURFACE 反查 → 出 payload。这一段现在全都还是手点
（`cut-payload.yml` 是 `workflow_dispatch`）。把它改成 `schedule`/上游 tag 触发，"不想维护"才真正成立；
但要留住一件事：**合并本身仍然要人看**。0.2.2 这一刀的实际过程是"合并 + 两处测试红 + 自检页两个自坏"，
全自动合并会把这一步的返工直接推到玩家身上。
