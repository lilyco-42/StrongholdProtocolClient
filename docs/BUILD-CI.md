# 用 GitHub Actions 出桌面版 / Android 版

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
              （win-unpacked.zip）        （app-debug.apk）
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

```bash
gh workflow run build-clients.yml -R lilyco-42/StrongholdProtocolClient
# 取产物
gh run download -R lilyco-42/StrongholdProtocolClient
```

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

## 版本对齐

**客户端必须和服务器跑同一个提交。** payload 里含 `sim/`（自走棋模拟）与 `shared/`，
版本错开会导致客户端本地预测与服务器权威结果不一致。

`build.json` 记录了构建来源，可在客户端内查：

```json
{ "server": "sp.lain42.top",
  "game": { "app": "0.1.1", "protocol": 1, "commit": "8b10625d3cce...", "dirty": false } }
```

服务器升级后（`git -C /opt/Stronghold-Protocol log -1`），按上面的步骤重新生成 payload 即可；
补丁若因上游改动失效，用 `-U1` 重新 `git diff` 生成。
