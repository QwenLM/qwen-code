# Android 移动端壳（技术验证）

[English](mobile-android-shell.md) | [简体中文](mobile-android-shell.zh-CN.md)

状态：已在本地实现并验证（2026 年 9 月）。依据：QwenLM/qwen-code 议题
#11704 中维护者的方向指示。

## 问题

为 `qwen serve` 做一个手机客户端。要求的形态是包住现有 Web Shell 的原生
壳，而不是第二套 UI：H5 已经带有受维护的移动端支持（mobile-chromium
Playwright 项目、触屏 composer、移动端抽屉、响应式断点、浏览器回合通知），
所以原生层只能补浏览器确实做不到的东西。

## 现状

- 仓库没有 Android 客户端包；`packages/desktop-shell`（Tauri 2）是唯一的
  原生壳先例，其 Android 工程仍是空白。
- Web Shell 的浏览器下限在兼容性工作之后才有声明（见
  `web-shell-pwa-installability.md`）：Chrome 107+ 语法、`@supports`
  回退、`dvh`。
- daemon 侧：主 listener 上还没有逐设备可撤销凭据（维护者前置项）；
  目前唯一的客户端侧缓解是把 bearer token 存进 Keystore。

## 目标

1. 在 WebView 中加载 daemon 提供的 Web Shell：不本地打包、不需要
   `--allow-origin` 配置。
2. 支持 N 组 (URL, token, 显示名) 配置文件；切换 daemon 就是把 WebView
   导航到另一个 origin（同源路径，与现有扫码手机接入一致）。
3. 启动时检测 WebView 引擎版本，低于 Chrome 107 时显示明确的「请更新
   Android System WebView」页面。
4. Keystore 凭据存储与前台服务的骨架（Phase 2）：保活 SSE、弹原生通知。

## 不在范围内

- 任何原生（Compose）UI；会话、权限、工具活动、diff 等画面全部留在
  Web Shell。
- 让一个已加载页面同时连多个 daemon（代价高且今天不支持）；切换走导航。
- 基于 `/acp` 构建；客户端只用 H5 的文档化 REST+SSE 面。

## 方案

`packages/mobile-shell`（不加入 npm workspace；Gradle Kotlin DSL）：

- `MainActivity`：WebView 壳，同源导航留在 WebView，外部链接交给系统
  浏览器；token 由 URL fragment 传入（`#token=<value>`，Web Shell 从
  `window.location.hash` 读取，永不上送服务器）；返回键驱动 WebView
  历史。
- 配置文件存 `SharedPreferences`：`(daemon_url, daemon_token,
profile_name)`；Phase 2 把 token 移入 Android Keystore。
- `QwenForegroundService`（`dataSync` 前台服务类型）、通知渠道，由
  Activity 启动；SSE 客户端在 Phase 2 落地。
- `network_security_config.xml`：全局禁止明文，仅 loopback 放行；LAN 主机
  由运维显式添加（Android 自 API 28 起默认禁止明文）。
- WebView 版本检查：`WebViewCompat.getCurrentWebViewPackage`，在加载任何
  网页内容前把主版本号与 107 比较。

## 设计决策

- 加载 profile 指向的任意 daemon：不本地打包 H5，因此每个请求与 daemon
  自带的 Web Shell 同源，零跨域配置。
- profile 自己生成稳定 key：`/capabilities` 不携带 daemon 身份，`runId`
  每次重启都会重新生成，所以 app 必须自己持久化 profile key 与显示名。
- 每台 daemon 用静态 token（`--token` / `QWEN_SERVER_TOKEN`）：自动生成
  的 token 每次重启都会轮换，会让已存 profile 失效。
- 公网 TLS 是文档化的主路径（安全上下文可让 SW 与语音输入生效）；HTTP
  LAN 需要 network security config 条目。
- WebView 下限 107 与 Web Shell 的 `browserslist` 一致；原生检查比支持旧
  引擎便宜一个数量级，但承认无法更新 WebView 的设备无法补救。

## 约束

- `denyBrowserOriginCors` 会拒绝跨域请求，除非白名单化；同源导航避开
  整类问题。
- daemon token 在其宿主机上等同于代码执行权限；一部手机存 N 个静态
  bearer，在 daemon 侧逐设备撤销出现之前风险更高。
- workspace id 跨主机会碰撞（`sha256(cwd).slice(0,16)`）；任何原生缓存
  或草稿都必须以 `(profile, workspaceId)` 为键。
- 能力探测必须按 profile、按连接进行，绝不能全局缓存。

## 风险

- WebView 版本由设备决定；原生检查覆盖下限，但救不了无法更新的设备。
- 无条件启动前台服务会在没有 profile 时也常驻通知；spike 阶段可接受，
  Phase 2 加开关。

## 验证

- 手动：模拟器/真机用 loopback daemon profile 启动；在 daemon 访问日志
  中确认 `#token=` 片段不会上送。
- 版本门：强制低 WebView 版本，确认在任何网页内容加载前出现更新页。
- `npm run build` 不得触碰本包（已排除出 workspace）。
- Kotlin 文件对照维护者的「壳形态」清单评审：无第二 UI、无本地 H5
  打包、不用 `/acp`。

## 验收标准

1. 已存 profile 加载 daemon 提供的 Web Shell，token 从 URL fragment 读取。
2. WebView 低于 107 时显示更新页；达到或超过时加载壳。
3. profile 是 (URL, token, 显示名) 元组；切换即导航到另一个 origin。
4. 运维添加 LAN 主机之前，明文只对 loopback 放行。
5. 前台服务运行并显示通知；SSE 尚未实现（Phase 2）。

## 后续

- Phase 2：profile 选择 UI、Android Keystore 存储、前台服务内的 OkHttp
  SSE 客户端、回合/权限的原生通知、带说明的 POST_NOTIFICATIONS 运行时
  申请。
- daemon 逐设备凭据工作落地后（维护者前置项），把客户端工作重放到其上。
