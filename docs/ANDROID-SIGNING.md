# Android 的固定签名钥匙（upload key）

> 一句话：装机版的 APK 现在**每次都用同一把钥匙签**。这把钥匙在仓库的 secret 里，指纹记在
> `mobile/android/upload-key-sha256.txt`，每次构建由 CI 从产物里读出来对拍。

## 1. 为什么要加这一层（不是预防性设计，是修一个已经发生的事故）

2026-10-07 有玩家发截图：从 0.2.0 升到 0.2.1 装不上，系统报
「版本: 0.2.0 -> 0.2.1 / 安装失败(-7) / 与已安装应用签名不同 / 卸载当前已安装版本, 再重新安装」。

`-7` 是 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。Android 判断"能不能覆盖安装"只看**签名证书**，
和版本号、包名都对不上没关系。而当时的状况是：

- `mobile/android/app/build.gradle` 里**一个 `signingConfigs` 都没有**（`git show` 当时的文件可以看到）；
- `build-clients.yml` 的 android job 跑的是 `./gradlew assembleDebug`。

`assembleDebug` 用的是 Gradle 自动生成的 debug keystore，位置在 runner 的 `~/.android/debug.keystore` —
**GitHub Actions 每次都是一个全新的 runner，于是每次构建都是一把新钥匙**。玩家每跟一次版本就要卸载重装一次，
而卸载会连带清掉 localStorage：代号、干员调配、设置、记住的服务器全没（这三样都按 origin 存在 WebView 的
localStorage 里，见 `docs/PACKAGING.md` 关于固定 `DEFAULT_PORT` 的那段）。

所以这不是" nicer to have"，是一个每发一版就重复一次的玩家侧数据损失。

实测坐实（用 `node tools/check-apk-signature.mjs` 读五份**已发布**的包，都是 `CN=Android Debug`，
指纹两两不同 —— 也就是每一次发版都换了一把钥匙）：

| Release 资产（永久 URL，字节数与本表一致） | 签名证书 SHA-256 |
|---|---|
| `Stronghold-0.1.4-c14-android-debug.apk` (343,864,512 B) | `a9b5b81f90460ea8fd09d6c2b740d18ac4f6d4ade0f30f9bdf4eb05a274806e2` |
| `Stronghold-0.1.4-c17-android-debug.apk` (352,235,688 B) | `1efb4b959198b153c24171764301d385a9a754539fde833114b6f899f75d029d` |
| `Stronghold-0.1.4-c20-android-debug.apk` (498,622,939 B) | `1a41523195c137883748c6505d71e6a4dc1336a23fd4398ccdc4d67bc60d664d` |
| `Stronghold-0.2.0-c21-android-debug.apk` (639,375,426 B) | `38cacdd8e07aaa94dcf08d83443ab4c79f932a617db152f9a50cd1246b0d842f` |
| `Stronghold-0.2.1-c22-android-debug.apk` (639,415,274 B) | `7866fba188de719cc3973b80f91ac80671aae35263a6cd5532e1cbc760e2866a` |
| 从 **c24** 起（release，固定 upload key） | `f9da457649cb966f75833c4b95add260c2fbad8f4104de39bc9ab16646c61c62` |

最后那一行就是 `mobile/android/upload-key-sha256.txt` 的值，以后每一版都必须是它。
（`payload-v0.2.1-c23` 那轮**也**用这把钥匙打出来了、指纹也过了，但它有一个一次点击就能遇到的假「已同步」，所以没有晋升成玩家版 —— 见 Release `v0.2.1-c24` 的说明。）

## 2. 现在的机制

| 项 | 值 |
|---|---|
| 钥匙类型 | PKCS12，RSA 2048，`SHA256withRSA` |
| 别名（`keyAlias`） | `stronghold` |
| 证书主题 | `CN=Stronghold Protocol Client, OU=sp.lain42.top, O=lilyco-42, L=Shanghai, ST=Shanghai, C=CN` |
| 有效期 | 2026-10-07 → **2056-09-29**（`keytool -list -v` 实测，validity 10950 天） |
| 证书 SHA-256 指纹 | `f9da457649cb966f75833c4b95add260c2fbad8f4104de39bc9ab16646c61c62`（947 字节 DER 的 sha256） |
| 记录指纹的文件 | `mobile/android/upload-key-sha256.txt`（**提交进仓库**，只有一行 64 位小写十六进制，不能有注释） |
| 私钥在哪 | 仓库 secret `ANDROID_KEYSTORE_BASE64`（base64 的 .p12）+ `ANDROID_KEYSTORE_PASSWORD`（口令） |
| 私钥的离线备份 | `~/.android/stronghold-upload-keystore.p12` 与同目录的 `.password`（**不在仓库里**，见 §5） |
| CI 解出的位置 | `mobile/android/keystore/upload-keystore.p12` + `mobile/android/keystore.properties` |
| 这两个位置 | 已 `gitignore`（`mobile/android/.gitignore`） |

**本仓库是 PUBLIC 的**：私钥一旦提交，任何人都能签出一个"老玩家会自动接受"的更新包。所以私钥只走 secret，
`keystore.properties` 与 `keystore/` 都被 gitignore 钉住，并由 `test/packaging.test.js` 里那条
`the Android lane signs with one fixed upload key…` 断言这两条 ignore 规则还在。

出货形态也从 debug 换成 release：`assembleRelease` + `signingConfig = signingConfigs.release`。
CI 里 `apksigner verify --print-certs` 读出产物内的证书，和仓库记录的指纹对拍，不一致就红
（换钥匙、误用 debug 钥匙、secret 被替换，都会在这里被抓住，而不是等玩家装不上）。

## 3. 缺钥匙时会怎样（两处都会拦，不会静默出货）

- **CI**：`准备固定签名钥匙（release）` 这一步排在 SDK 安装和 gradle 之前，secret 缺失/损坏 → 一分钟就红。
  它还会 `keytool -list -alias stronghold` 解一遍，确认"这把钥匙能用、别名在"（不打印任何私钥材料）。
- **本地/其它流水线**：`app/build.gradle` 在 `assembleRelease`（或任何任务名里带 release 的任务）且
  `keystore.properties` 缺失 / 指不到存在的 .p12 时**直接 throw**。这条是必要的：AGP 对"release 没配签名"
  的做法是**静默产出一个未签名 APK**，那个包会一路走到玩家手机上才报错。
- `assembleDebug` 不需要这把钥匙，本地随手打个测试包照旧可用。

本地要打 release 包时，自己写 `mobile/android/keystore.properties`：

```properties
storeFile=keystore/upload-keystore.p12
storePassword=<口令>
keyAlias=stronghold
keyPassword=<口令>
```

`storeFile` 按 `mobile/android/` 解析（gradle 里用的是 `rootProject.file(...)`），把 .p12 放到那里即可。

## 4. 玩家侧：这一版还需要卸载一次，之后不用了

**已经装过 c22 及更早 APK 的玩家，装第一个 release 签名包（c23）时仍会看到 -7，必须先卸载再装。**
这是因为旧包签的是某个 runner 的一次性 debug 钥匙，和新钥匙必然不同 — 这一次损失无法避免。
**从 c23 往后**，同一把钥匙，覆盖安装不再报错，代号/调配/设置都会留着。

卸载前可以先把手动的东西抄一下（代号是服务器侧的，重装后用同一个地址登录就能拿回来；干员调配与设置是本机的）。

顺带一条与此相关的变化：release 包没有 `android:debuggable=true`，所以插上 USB 也开不了 `chrome://inspect`
远程调试。需要调试 WebView 的话，在 `mobile/capacitor.config.json` 的 `android` 里加
`"webContentsDebuggingEnabled": true` 重新构建（这个键的效果本仓库没有在真机上验证过，只是 Capacitor 的配置项；
线上玩家排障优先用网页版/PWA，同一份代码）。

## 5. 钥匙丢了 / 泄露了

- **丢了**（secret 被删、且 §2 里那份离线 .p12 也没了）：只能生成新钥匙。后果是**所有装机玩家必须卸载重装一次**
  （§4 那件事会重演一遍），并且旧安装包永远无法再升级。所以：**把 `~/.android/stronghold-upload-keystore.p12`
  和 `.password` 一起备份到仓库之外**（GitHub secret 只有仓库管理员能读，仓库一旦转私有/删除就跟着没了）。
- **泄露了**：必须换。泄露的钥匙意味着第三方能推送玩家会自动接受的更新，这比"版本装不上"严重得多。
- **轮换流程**（有意为之，不是便利路径）：新 .p12 → `gh secret set` 两个 secret → 用 §6 的命令量出新指纹 →
  改 `mobile/android/upload-key-sha256.txt` → 同一次提交里在 README 写清"这版起需要卸载重装" → 发版。
  不改指纹文件的话，CI 的签名闸门会红 —— 这是好事。

## 6. 复核命令（都可重跑）

指纹的三个独立读取器（当时用它们互相印证，因为手抄一次抄错过一位）：

```bash
KS=~/.android/stronghold-upload-keystore.p12
keytool -list -v -keystore "$KS"            # 输出里的 "SHA256:" 一行
openssl pkcs12 -in "$KS" -nokeys -clcerts | openssl x509 -outform DER | sha256sum
```

仓库里到底还有没有那两个 secret（只看名字和更新时间，读不到值）：

```bash
gh secret list -R lilyco-42/StrongholdProtocolClient
```

已经发布给玩家的 APK 是谁签的。**装好这个仓库就能读，不需要 Android SDK**：

```bash
node tools/check-apk-signature.mjs --expect "$(cat mobile/android/upload-key-sha256.txt)" <apk>
```

它解 APK Signing Block（v2/v3）里的证书，`--expect` 不匹配就 exit 1
（实测：对已发布的 `Stronghold-0.2.1-c22-android-debug.apk` 回 exit 1 并打出 `7866fba1…`，
即 §1 表里那把我一次性钥匙；对 `v0.2.1-c24` 的 release 包回 exit 0）。
为什么不走 `keytool -printcert -jarfile`：minSdk 24 的包**没有 v1 签名**
（实测 `unzip -l` 里 `META-INF/` 只有 `.version` 与 `app-metadata.properties`，keytool 读不到任何东西）。
CI 侧用 Google 的 `apksigner`（每个版本的日志里都有完整输出），两边读到的应当是同一个指纹。
