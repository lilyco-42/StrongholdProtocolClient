# 用 GitHub Actions 出桌面版 / Android 版

## ✅ 验证结果（2026-10-04，run 37204756625）

两个 job 全部成功，产物已下载校验：

| 产物 | 大小 | 校验 |
|---|---|---|
| `stronghold-desktop-win` | **315.6 MB** | 4994 条目；`StrongholdProtocol.exe` ✓；`resources/app.asar` ✓；**4972 个内嵌 web 资源** ✓ |
| `stronghold-android-apk` | **193.0 MB** | 4634 条目；`AndroidManifest.xml` / `classes.dex` / `resources.arsc` ✓；**4196 个内嵌 web 资源** ✓ |

两者的 `runtime-config.js` 都是 `globalThis.__SP_SERVER__ = "sp.lain42.top"` ✓

**注意：客户端的 `index.html` 里是 `/js/main.js`（本地路径），不是 OSS 地址。**
这是**正确的** —— 客户端把全部资源内嵌（4972 / 4196 个文件），
**完全不依赖 OSS**，离线也能跑。服务器上那份 index.html 才指向 OSS。

### 过程中修掉的 CI 问题

`android-actions/setup-android@v3` 会去装**早已从 SDK 仓库下架的 legacy `tools` 包**，
报 `Warning: Failed to find package 'tools'` 然后 exit 1，整条 job 直接挂。

**修法：弃用这个 action，改用 ubuntu-latest 预装的 SDK。**

```yaml
- name: 安装 Android SDK 组件
  run: |
    set -euo pipefail
    SDK="${ANDROID_HOME:-/usr/local/lib/android/sdk}"
    SDKMANAGER=$(find "$SDK/cmdline-tools" -maxdepth 3 -name sdkmanager -type f | sort | tail -1)
    echo "ANDROID_HOME=$SDK" >> "$GITHUB_ENV"
    echo "ANDROID_SDK_ROOT=$SDK" >> "$GITHUB_ENV"
    echo "$(dirname "$SDKMANAGER")" >> "$GITHUB_PATH"
    yes | "$SDKMANAGER" --licenses > /dev/null 2>&1 || true
    "$SDKMANAGER" --install "platforms;android-36" "build-tools;36.0.0" "platform-tools"
```

要点：**动态定位 `sdkmanager`**（不同 runner 镜像的版本目录名不一样，如 `16.0` / `latest`），
并**显式把 `ANDROID_HOME` 写进 `$GITHUB_ENV`** 供 gradle 使用。

### ⚠️ 产物有效期

GitHub Actions artifact 默认保留 **7 天**。要长期保存需另传（OSS / Release）。


本文说明 `lilyco-42/StrongholdProtocolClient` 这条构建链：**payload 在服务器上本地生成 → 传 OSS → CI 只负责打包成 exe / apk**。

## 为什么不把 payload 生成放进 CI

payload = 游戏代码 + **266 MB 素材**。素材不在游戏仓库的 git 里（`.gitignore` 掉 `public/assets/`），
官方做法是 `npm run assets` 现从上游拉。但我们的实例有两处不能靠上游现拉：

1. **补过 17 个上游 fetch 列表里没有的文件**（boss 骨架 `enemy_1001_bigbo.skel`、3 个 enemy 三件套、
   11 个 token 皮肤、`bond/kazimierzShip.png`、`band/band_pepe.png`）。CI 现拉会得到缺这些的素材集，
   表现就是 **boss 渲染成菱形占位符**。
2. **素材 URL 形态不同**：我们服务器上的 `data/assets.json` 指向 OSS 绝对 URL（为省 590 KB/s 出口带宽），
   而**客户端要的是相对路径版**，否则「素材本地化」白做（客户端还会去 OSS 拉 266 MB）。
   客户端必须用上游原版（0 个 http URL）。

所以 payload 由服务器本地生成，CI 只做「拿 payload → 打包」。

## 流程

```
服务器 /opt/sp-client              服务器 /opt/sp-game-src
  tools/package-client.mjs  ──►   （8b10625 干净 checkout + 硬链接素材）
        │
        ├─► /tmp/sp-payload/www   4194 文件 / 266.4 MB
        │
        ├─► tar czf  →  183 MB
        │
        └─► ossutil cp  →  oss://lain42-downloads/.../client/sp-client-payload.tar.gz
                                │
                                ▼  https://dl.lain42.top/downloads/stronghold-protocol/client/sp-client-payload.tar.gz
                     GitHub Actions: build-clients.yml
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            stronghold-desktop-win   stronghold-android-apk
              （win-unpacked.zip）        （app-release.apk）
```

## 生成 payload（服务器上）

```bash
# 1) 按服务器正在跑的提交建干净 checkout
cd /opt/Stronghold-Protocol
git worktree add --detach /opt/sp-game-src 8b10625

# 2) 叠加不在 git 里的素材（硬链接，不占额外磁盘）
cd /opt/sp-game-src
cp -al /opt/Stronghold-Protocol/public/assets public/assets
cp -a  /opt/Stronghold-Protocol/public/vendor public/vendor
cp -a  /opt/Stronghold-Protocol/public/fonts  public/fonts
cp -a  /opt/Stronghold-Protocol/data/local-assets.json data/local-assets.json

# 3) 生成 payload（--server 会写进 js/runtime-config.js）
cd /opt/sp-client
node tools/package-client.mjs --game /opt/sp-game-src --out /tmp/sp-payload/www --server sp.lain42.top

# 4) 打包上传
tar -czf /var/tmp/sp-client-payload.tar.gz -C /tmp/sp-payload/www .
ossutil cp -f /var/tmp/sp-client-payload.tar.gz \
  oss://lain42-downloads/downloads/stronghold-protocol/client/sp-client-payload.tar.gz \
  -e oss-cn-shanghai-internal.aliyuncs.com
```

## 触发 CI

**这条流水线只在 `tags: v*` 与 `workflow_dispatch` 上跑**，而且它读的是**触发它的那个 ref 里的工作流文件**，
所以从分支构建必须显式 `--ref`（不发 tag 也能出一条新链路，这是 c13/c21 的实际做法）：

```bash
# payload 先作为一个不带玩家资产的 Release 传上去（资产名 sp-client-payload-<ver>-cNN.tar.gz）
gh release create payload-v0.2.0-c21 -R lilyco-42/StrongholdProtocolClient --notes-file notes.md   # 不带资产
gh release upload payload-v0.2.0-c21 -R lilyco-42/StrongholdProtocolClient sp-client-payload-0.2.0-c21.tar.gz

# 再用它的下载直链触发三端；expect_app 会跟 payload 的 build.json.app 对，对不上就红
gh workflow run build-clients.yml -R lilyco-42/StrongholdProtocolClient --ref feat/payload-assets \
  -f payload_url=https://github.com/lilyco-42/StrongholdProtocolClient/releases/download/payload-v0.2.0-c21/sp-client-payload-0.2.0-c21.tar.gz \
  -f expect_app=0.2.0 -f server=sp.lain42.top

# 跟完 + 取产物（--json artifacts 不是合法字段，用 run download -D）
gh run watch <run-id> -R lilyco-42/StrongholdProtocolClient --exit-status
gh run download <run-id> -R lilyco-42/StrongholdProtocolClient -D out/
```

**发布玩家 Release 的两条硬规矩**（都是踩出来的）：

1. `gh release create v0.2.0-c21 <600 MB 资产>` 会先建 draft、资产失败就把**整个 Release 连同 tag 删掉**；
   两个大资产并发上传还会互相踩（`HTTP 404 …/releases/<id>/assets`）。
   所以：**先建不带资产的 Release，再一个一个 `gh release upload`**（实测约 3 分钟 / 500 MB）。
2. `gh release create` **不带 `--target` 时把 tag 打在默认分支的 HEAD 上**，不是打在你正在发布的分支。
   c21 就因此把 `v0.2.0-c21` 落在了 `main` 的旧提交 `34a31bc`，而构建它用的是 `feat/payload-assets` @ `fc513b4` ——
   拆出来的 tag 复现不出这一版。已发布的 tag 不要动（下载链接是永久的），要修的是流程：
   **发版前先把工具与补丁快进进默认分支**（`git push origin feat/payload-assets:main`），或者干脆 `--target <sha>`。

顺带：创建一个 `v*` 的 tag 会自动再触发一次完整矩阵，它会用默认 `payload_url`（OSS 那份 `v0.1.3-dirty`）
并**必然在 `payload 出处（闸门）` 处变红**（c11/c12/c21 分别记为 run `37328202572` / `37336247919` / `37634418034`）。
那是预期噪音，不会发出坏产物；`payload-*` 的 tag 不匹配 `v*`，所以切 payload 时不会多跑一次。

## 补丁为什么是 `-U1`

`patches/game-client.patch` 用 **1 行上下文**（`git diff -U1`）而不是默认的 3 行。

原因：上游 `public/js/screens/room.js` 的 import 块在版本间会增减行（例如上游后来插入了
`import { copyText } from '../ui/clipboard.js';`）。3 行上下文时，这个 hunk 的上下文窗口会把
那一行包进去，于是补丁**只对某一个提交有效**——上游一动就报
`hunk @@ -16,7 @@ does not match`。

改成 1 行上下文后，hunk 的上下文只剩：

```
 import { LoadoutButton } from './loadout.js';
-import { net } from '../net.js';
+import { net, resolveServerTarget, toHttpUrl } from '../net.js';
 import { store, useStore, shallowEqual, emptyMatch } from '../store.js';
```

这三行在 `8b10625` 与上游 HEAD 上是**连续且相同**的，所以同一份补丁对两个版本都能应用
（`tools/unified-diff.mjs` 另有 ±200 行 fuzz，行号漂移不影响）。

代价：上游若真改了这三行本身，补丁仍会失败（这是期望行为——失败得响亮，好过发一个连错服务器的客户端）。

**当前这份补丁的真实形状**（逐个 hunk 数上下文行数量出来的，不是推断的）：7 个 hunk，前 5 个是 `-U1`
（`index.html` 两枚 `@@ -42,2 +42,4 @@` / `@@ -95,2 +97,5 @@`，`net.js` 三枚 `@@ -2,3 +2,5 @@` /
`@@ -94,4 +96,80 @@` / `@@ -99,2 +177,4 @@`，它们的前后上下文都只有 1 行），
而 `room.js` 的两枚不是：`@@ -20,7 +20,7 @@` 前后各 3 行，`@@ -69,10 +69,11 @@` 前置 3 行、后置 5 行。
原因是 0.2.0 往 room.js 的 import 块里插了 `import { t, tc } from '../../../shared/i18n.js';`，
旧锚点整段对不上，`fc513b4` 用 `git diff --no-index` 对**合并后的真实文件**重生成这两段，默认就带了 3 行上下文。
下次重生成时应该显式 `-U1`，让整份补丁回到同一条规则上（`test/packaging.test.js` 只钉住"hunk 数 = 7"和
"上下文不匹配就拒绝应用"，不会替你发现这个漂移）。

## 版本对齐

**客户端必须和服务器跑同一个提交。** payload 里含 `sim/`（自走棋模拟）与 `shared/`，
版本错开会导致客户端本地预测与服务器权威结果不一致。

这条是原则，但"错开了会怎样"在 2026-10-07 被实测过一次（c21 = 客户端 0.2.0，线上仍是 0.1.4），
结论比"连不上"要细：**能连、能进大厅、能建房进对局 HUD**（`PROTOCOL_VERSION` 一直是 1，握手不看 app 版本），
新版本的动词才被旧服务器拒。要重跑这个判断，不需要任何专用脚本：

```bash
# 1) 用某个旧版本在本机起一份服务器（只监听回环，别碰线上）
git -C <游戏仓> worktree add /tmp/old <旧 tag> && cd /tmp/old && npm i --ignore-scripts ws
PORT=8139 HOST=127.0.0.1 SP_NO_BROWSER=1 node server/index.js    # /healthz 会报它的 app 版本

# 2) 把 payload 当静态站点托管，浏览器带 ?server= 覆盖指过去（?server= 优先于 __SP_SERVER__）
PORT=8138 node <静态宿主> <payload 目录>
# 打开 http://127.0.0.1:8138/?server=127.0.0.1:8139 → 标题页应显示「已连接服务器」
```

当时看到的三件事：大厅 / 创建房间 / 简报 / 对局 HUD 都正常；`net.js` 的 `VERB_MIN_APP` 只登记了三个 0.1.3 动词，
所以 0.2.0 新增的 `room.ownership`（干员持有）与 `room.diy`（自选编队）**不会提前灰显**，点进去表头显示「同步失败」；
以及**旧服务器若不在 `/healthz` 上回 `access-control-allow-origin`，打包客户端就永远读不到 `serverApp`**
（上游 v0.1.4 就是这样，线上那台会回 `*`），这时所有按版本灰显的判断都退化成"点了才知道"。

`build.json` 记录了构建来源，可在客户端内查：

```json
{ "server": "sp.lain42.top",
  "game": { "app": "0.1.1", "protocol": 1, "commit": "8b10625d3cce...", "dirty": false } }
```

服务器升级后（`git -C /opt/Stronghold-Protocol log -1`），按上面的步骤重新生成 payload 即可；
补丁若因上游改动失效，用 `-U1` 重新 `git diff` 生成。
