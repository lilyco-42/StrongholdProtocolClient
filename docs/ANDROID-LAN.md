# Android 内置 EasyTier（开发分支）

> **验证级别：Node、Java/Kotlin JNI ABI 测试通过；GitHub Actions 已成功构建并校验原生 Rust JNI/FFI APK，Android 真机 VPN/实际联机尚未验证。**
> 不可把此分支当成已向玩家交付的功能。现有正式版 v0.2.5-c44 **没有**内置 Android EasyTier。

## 目标

在原 Capacitor APK 内提供选服页「开启联机」，走 Android 的 **VpnService** 系统授权，
通过 **EasyTier 官方 JNI/FFI v2.6.4** 启动网络实例，透传 Android TUN FD。
无需 root、无需另装 EasyTier APK，也不修改上游游戏逻辑。

Android 首次开启时必须经由系统确认 VPN；这一步不能静默绕过。
服务使用低优先级前台通知；用户可在选服页主动关闭。
仅把 \`10.126.126.0/24\` 导入 VPN，避免影响普通互联网访问和 EasyTier 自己的公网 peer 连接。

## 实现

- \`mobile/android/app/src/main/java/com/easytier/jni/EasyTierJNI.java\`：与官方 v2.6.4 JNI 符号对齐。
- \`StrongholdLanVpnService.java\`：前台服务、TUN 管理、实例启动/停止、动态 IP 获取、官方服健康检查。
- \`StrongholdLanBridge.java\`：仅可信 Capacitor \`https://localhost\` 暴露状态与开关；网络密钥不返给网页。
- \`shell/lanRooms.js\`：Android 优先走本地 JNI 桥，桌面继续 \`/lan/*\`；旧浏览器/iOS 404 时隐藏卡片。
- \`tools/write-android-lan-config.mjs\`：将原有 CI \`SP_LAN_NETWORK_NAME\` / \`SP_LAN_NETWORK_SECRET\` / \`SP_LAN_PEERS\` 写到 Android assets，**文件被 gitignore，不能提交**。
- \`build-clients.yml\`：从官方 EasyTier \`v2.6.4\` 源码编译 \`arm64-v8a\` 的 \`libeasytier_ffi.so\` 和 \`libeasytier_android_jni.so\`；构建时使用既有 Android 长期签名钥匙，产物闸门检查 JNI / FFI / 非空配置与选服页。

## 安全与边界

1. 和现有桌面版一样，网络口令在分发 APK 内可被提取；不等于单用户零信任认证。
2. 目前只编译 \`arm64-v8a\`，其他 Android ABI 尚未实现。
3. \`VpnService\` 会与其他 VPN 应用争用 Android 唯一的 VPN 授权。
4. 拆包检查证明的是“字节齐全”，**不证明**真机打洞或局域网开房可用。
5. 生产服务不能重启：\`systemctl restart stronghold\` 会踢掉活跃对局。
6. JNI 本机没签名和安装验证；必须走 GitHub Actions，逐层实测真实 APK。
7. EasyTier 原生库遵循上游许可；发版须附上上游 LICENSE 与可供替换/重建的源代码版本信息。

## 验收闸门（前两项已在 CI 验证；第 3—6 项待真机）

1. Node 单测、Android CI 构建成功（Rust JNI / FFI）。
2. APK 内含两个 \`.so\`、网络配置、\`StrongholdLanBridge\` 页面模块；签名指纹与前版相同。
3. Android ARM64 实机覆盖安装（旧 \`localStorage\` 不丢），开启联机触发一次 VPN 授权。
4. 发现官方 \`10.126.126.1:5150\`、\`/lan/v1/rooms\` 公开目录，加入房间一局。
5. 关闭联机后系统 VPN 清理；断网/拒绝授权/权限被别的 VPN 收回时给出正确反馈。
6. UDP 11010 打洞与中继情况分别在 Wi-Fi 和移动数据下实测，避免承诺必直连。

正式发版前不得勾选上面尚未跑过的项。
