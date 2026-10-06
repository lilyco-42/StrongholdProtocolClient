# vendor/trystero.js

**不要手改这个文件。** 它是构建产物，改了下一次重新 vendor 就没了。

| 项 | 值 |
|---|---|
| 上游 | [dmotz/trystero](https://github.com/dmotz/trystero) `trystero@0.26.0` |
| 许可 | MIT（GPL-3.0 兼容，可并入本仓库） |
| sha256 | `a7ca3dfd5765346f237ec8ec4ab463b773157bc0ee4025414801cab5608404f1` |
| 大小 | 75,324 B |
| 生成 | 2026-10-06 |

## 怎么重新生成

```bash
# 在一个装了 trystero 的目录里
echo "export * from 'trystero'" > vendor-entry.js
npx esbuild vendor-entry.js --bundle --format=esm --minify --target=es2022 --outfile=trystero.js
```

## 为什么要 vendor 而不是 npm 依赖

壳文件是被 `tools/package-client.mjs` 的 `shellSource()` **逐字节原样复制**进 payload 的，
没有打包步骤可以插进来；而这个仓库本身没有运行时依赖（`package.json` 里 `dependencies` 为空）。
vendor 一个自包含 bundle 是唯一不需要给打包流程加构建步骤的做法。

## 两条必须守住的性质（`test/p2p-rooms.test.js` 钉住了）

1. **自包含** —— 不能有裸 `import` 残留，否则 payload 里会 404。
2. **离线干净** —— 不能出现 `tools/check-payload-offline.mjs` 的 `OUTBOUND` 命中的引用形式。
   否则 CI 的 `零外部依赖（闸门）` 会在发布后才拦下来（那道闸门跑在产物之后，不在提交之前）。

重新 vendor 时，这两条由上面那个测试文件直接验证，不用靠人眼。

## 它在这里做什么

只做**信令**：把两个玩家的连接意向撮合到一起，走公共 Nostr 中继。
一旦 WebRTC 直连建立，中继上不再有任何数据 —— 游戏流量走的是 P2P 数据通道。
`shell/p2p/link.js` 是唯一的调用方，且是动态 `import()`，不开大厅就完全不加载。
