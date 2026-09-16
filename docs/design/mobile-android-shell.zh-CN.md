# Android 移动端 Shell（技术验证）

[English](mobile-android-shell.md) | [简体中文](mobile-android-shell.zh-CN.md)

状态：遵循 [issue #11704](https://github.com/QwenLM/qwen-code/issues/11704) 的开发用途技术验证，正在评审。它不是生产级移动客户端。

## 问题与目标

在 Android WebView 中使用 daemon 已提供的 Web Shell，不创建第二套原生会话 UI，也不本地打包 H5。在添加生产凭据和后台连接前，建立可构建的原生启动流程和准确的 origin 边界。

## 已实现范围

- `qwen_profiles` SharedPreferences 中的一个开发配置：`daemon_url` 和可选 `daemon_token`。尚无配置编辑器、稳定配置键或多配置切换。
- 保存的 URL 必须是 HTTP(S) origin，不能包含用户信息、非根路径、查询或 fragment。编码后的令牌通过 `#token=` 传入；fragment 不包含在导航请求中，Web Shell 随后会在已认证 API 请求中发送令牌。
- WebView 内导航比较解析后的 scheme、host 和有效端口。相似域名前缀、用户信息和不同端口不属于同源。仅 HTTP(S) 和 mailto 的外部主框架链接可打开其他应用；缺少处理程序或设备策略限制不使 Activity 崩溃。
- 在创建 WebView 前检查 provider。缺失或低于 111 的 provider 显示原生升级提示。缺少/无效配置和连接失败也显示原生启动提示；连接失败提供 Retry。
- 保留浏览器返回历史和缩放，禁用 file/content 访问及 mixed content。网络安全配置全局拒绝明文，仅明确允许 loopback。
- 云备份和设备迁移均排除开发凭据，同时保留 `allowBackup=false`。
- 从 npm 和 pnpm workspaces 中排除这个 Gradle 包。使用 JDK 17、Android SDK 34，以及固定版本且含分发校验和的 Gradle 8.2.1 wrapper 构建。

## 设计决策

WebView 直接导航到 daemon origin，因此沿用同源 API 行为，直接同源 HTTP API 无需 `--allow-origin`。反向代理和远程 terminal/voice WebSocket 连接仍须遵守 [qwen serve](../users/qwen-serve.md) 的 origin 要求。Chrome/WebView 111 是基于 Tailwind v4 的 CSS 最低版本，与 ES2021 JavaScript target 独立。

开发时静态 daemon 令牌（`--token` 或 `QWEN_SERVER_TOKEN`）避免重启后失效。SharedPreferences 只是临时开发方案，并不具备 Keystore 支持的生产凭据保护。远程连接应使用 HTTPS；额外的 HTTP 局域网主机需要显式网络安全配置。

本技术验证不启动前台服务。没有 SSE 连接的服务只会消耗资源并显示误导性的持续通知，因此占位服务及其权限推迟到后续阶段。

## 约束与生产前提

Daemon 的按设备可撤销凭据属于维护者负责的前提，不能将本技术验证描述为已经解决。仅使用 Android Keystore 并不能使共享静态 bearer 按设备撤销。

第二阶段需要 N 个配置，包含客户端生成的稳定键和显示名；切换时导航到新的 origin。原生工作区缓存必须按配置和工作区 ID 隔离，capability 检查必须按配置和连接执行。迁移至批准的凭据存储后，必须删除开发阶段明文令牌。

文件选择器、麦克风权限桥接、下载、新窗口处理、渲染进程恢复、生命周期感知 SSE 和通知尚未实现。系统字体缩放集成及完整的双指缩放和无障碍验收也属于后续工作。H5 能在浏览器运行，不意味着这些原生集成已经可用。

## 评审测试计划

1. 使用提交的 wrapper 构建 debug APK 并运行 JVM origin-policy 测试。
2. 在 WebView 111+ 模拟器/真机上配置开发 origin，确认加载 daemon 提供的 UI，并确认发往 daemon 的导航 URL 不含令牌 fragment。
3. 同源链接保留在 WebView；域名后缀、userinfo 和不同端口不视为同源。没有对应应用的外链不能造成崩溃。
4. 无配置或可用 WebView provider 时启动，应看到不依赖网页渲染的原生提示。
5. 停止 daemon 后导航，恢复服务并点击 Retry。主框架错误提供恢复入口；子资源错误不替换整个 UI。
6. 打开或关闭 Activity 时均不运行前台服务或通知。

## 验证证据

JVM 测试覆盖 origin 比较、配置根 URL 验证和外链 scheme 限制。构建结果及准确版本记录在 PR 验证报告中。模拟器/真机交互和 provider 升级行为需要设备证据，本文不声明已经完成。

## 后续工作

生产配置 UI 和凭据迁移；维护者提供按设备撤销；Keystore 存储；capability 协商；生命周期感知 SSE、原生通知及运行时权限；文件选择、麦克风、下载、新窗口及渲染进程恢复；字体缩放和无障碍验收。
