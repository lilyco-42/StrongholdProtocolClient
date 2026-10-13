# iOS 上没有 3D 棋盘 —— three.js 的 ES2022 语法（2026-10-14）

**症状**：iPhone 上 3D 棋盘从不出现，只有 2D 棋盘。**没有报错**：控制台干净，`?board=3d` 也没用。
**影响面**：**iOS 15.0 – 16.3 全部**（含所有卡在 iOS 15 的设备：iPhone 6s/7/SE1 等）。iOS 16.4+ 正常。
**根因**：`vendor/three.core.js` 用了 class static block（ES2022），而 Safari 到 **16.4** 才支持；应用声明的
最低版本是 **15.0**。语法错误让 `import('/vendor/three.module.js')` 直接 reject，而 `load.js:22` 把任何 reject
都变成 `null`（它注释里写明的"没有 three 就走 2D"路径）→ 3D 层**根本不会被构建**。
**修法**：打包 payload 时把这个模块降级到 Safari 15 能解析的语法（`tools/safari15-syntax.mjs`）。

## 证据（每一行都能重跑）

```
# 1) 应用支持到 iOS 15，而 three 要 16.4
$ grep IPHONEOS_DEPLOYMENT_TARGET mobile/ios/App/App.xcodeproj/project.pbxproj | head -1
        IPHONEOS_DEPLOYMENT_TARGET = 15.0;

$ grep -c 'static *{' <payload>/vendor/three.core.js
6
# class static block = Safari 16.4（WebKit «Features in Safari 16.4» / caniuse mdn-javascript_classes_static_initialization_blocks）

# 2) 这个文件确实进了包（不是"少带了个文件"）
$ tar tzf sp-client-code-v0.2.5-c42.tar.gz | grep vendor/three
./vendor/three.module.js
./vendor/three.core.js

# 3) 语法级别：ES2021 解析器读不了它，ES2022 才行
$ acorn --module --ecma2021 <payload>/vendor/three.core.js
Unexpected token (… 3054:8)          # 3054 行就是 Vector2 的 static {
$ acorn --module --ecma2022 <payload>/vendor/three.core.js && echo ok
ok

# 4) 整个 payload 里只有这一个文件超标（其余全部 ≤ ES2021，Safari 15 可解析）
$ for f in <payload>/vendor/*.js <payload>/js/**/*.js; do acorn --module --ecma2021 "$f" || echo "$f"; done
# 只有 vendor/three.core.js 报错
```

`load.js` 那条链是**静默**的，所以这条 bug 之前没人报上来：

```js
// public/js/render/board3d/load.js
threePromise = import(url).then((m) => (m && m.WebGLRenderer ? m : null), () => null);   // ← 语法错误走这里
// …
const boardReady = Promise.all([threePromise, packPromise]).then(([THREE, pack]) => (THREE && pack ? enable3d(THREE, pack) : false));
```

`docs/IOS-ART.md` §0.5 当时把这条记成"**影响棋盘、不影响立绘**，可接受" —— 棋盘就是 3D 层，所以那其实是
"iOS 15 上永远没有 3D"，不是可接受的降级。该表已更正。

## 修法

`tools/safari15-syntax.mjs` 在 payload 组装时（`tools/package-client.mjs`，所有 `vendor/*.js`）把这些赋值从
class body 里搬到 class 声明之后 —— 时机完全不变（static block 就在类定义时执行，搬的又只是给原型挂标记）。

**为什么不用现成工具**（esbuild/babel 能一次降级整个文件）：这个仓是**零依赖**的，而这里要改的形态极其固定 ——
three 只用了 6 处 `static { X.prototype.isX = true; }`，且都在自己独占的一行上。所以改成**面向行**的定位：
不做 tokenize，就不必处理正则字面量（`three.core.js` 第 45238 行有个正则里含 `"`，任何朴素的字符扫描器
会在那里被带偏 32 000 个字符 —— 试过，扫丢了第 6 个块）。每一条假设都写成断言，形态不认识就**抛错**。

**为什么放在客户端仓而不是游戏仓**：游戏仓要保持与上游逐字节一致（见 `tools/payload-patches.mjs` 的说明），
平台适配一律在打包期做。

## 怎么复验

```bash
# 单元 + 集成（降级器本身、以及"降级真的落进了 payload"）
node --test test/safari15-syntax.test.js test/packaging.test.js

# 产物级：拿一份真实 payload 的 code tar，解出 vendor/three.core.js
tar xzf sp-client-code-*.tar.gz ./vendor/three.core.js
grep -c '^[ \t]*static[ \t]*{' vendor/three.core.js     # 必须是 0
acorn --module --ecma2021 vendor/three.core.js && echo "Safari 15 可解析"

# 行为等价：降级前后导出符号与 6 个 is* 标记必须完全一致（本次实测 REVISION 186 / 447 导出 / 6 标记）
node -e "import('./vendor/three.core.js').then(m=>console.log(m.REVISION,Object.keys(m).length))"
```

**真机验收（只能人来跑）**：iOS 15.x/16.3 的 iPhone 装新包，进一局战斗 —— 应能看到 3D 棋盘（不再是纯 2D）。
iOS 16.4+ 的机器本来就正常，可当对照。
