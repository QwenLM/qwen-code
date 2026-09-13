# Web Shell PWA 可安装性与浏览器兼容性

[English](web-shell-pwa-installability.md) | [简体中文](web-shell-pwa-installability.zh-CN.md)

状态：已在本地实现并验证（2026 年 9 月）。依据：QwenLM/qwen-code 议题
#11704 中维护者的方向指示。

## 问题

Web Shell 目前不可安装为应用（没有 PWA manifest，没有 service worker），
也没有声明浏览器支持下限。轻量 Android 壳（见 `mobile-android-shell.md`）
将同一份 H5 嵌入我们无法控制的 Android System WebView 引擎；引擎过旧时，
失败表现为白屏（Chrome 107 以下的 JS 语法）或静默的布局损坏（Chrome 105
以下的 `:has()` / `@container`，以及 Android 地址栏下的 `100vh`）。

## 现状

- 包内没有任何 `browserslist`、运行时引擎检测或「浏览器不受支持」页面。
- `:has()` 与 `@container` 密集用于移动端关键组件（侧边栏会话列表、消息
  时间线、workspace 分区、管理面板），且没有 `@supports` 回退。
- 22 处 `100vh`，零处 `dvh`；在 Android 上 `100vh` 等于大视口，composer
  会被压在地址栏下面。`mobile-chromium` Playwright 项目抓不到这个问题
  （固定视口等于假绿灯）。

## 目标

1. 让 Web Shell 可安装：在 daemon origin 上提供 manifest + service
   worker，不引入新工具链，pre-auth 路由与现有静态资源并列。
2. 声明支持矩阵（`browserslist` + README）并让降级显式化：为
   `:has()`/`@container` 加 `@supports` 回退、`dvh` 成对声明、运行时引擎
   下限页面。

## 不在范围内

- 离线工作、Web Push 投递、应用关闭时的通知。
- 任何形式的第二套 UI；原生壳仍是唯一的额外界面。
- 为下限以下的缺失 CSS/JS 特性做 polyfill；低于下限的引擎统一显示更新
  页面。

## 方案

### PWA 可安装性

- `public/manifest.webmanifest`：`start_url: "/"`、standalone 展示、PNG
  192/512 图标加 SVG 标识、Qwen 品牌色。
- `client/sw.js`：经典（非 module）脚本，作为 Vite 第二个入口构建，输出
  到根目录（无哈希）。仅对 `/assets/*` 缓存优先；缓存名
  `qwen-code-shell-v1-<version>` 分版本；daemon API 路由、SSE、非 GET 请求
  以及携带 `Authorization` 头的请求一律纯网络。不预缓存、无离线 app
  shell。
- `main.tsx` 中注册延迟到 `load` 事件，且仅限 standalone 入口（嵌入式
  库不注册 worker）。
- daemon 路由 `GET /manifest.webmanifest` 与 `GET /sw.js` 挂在
  `bearerAuth` 之前，发送 `no-cache`（worker 还带
  `Service-Worker-Allowed: /`），并在 `isPreAuthWebShellRequest` 中同步，
  冷启动 daemon 也能应答。

### 浏览器兼容性

- `packages/web-shell/package.json` 增加 `browserslist`：Chrome/Edge 107+、
  Firefox 104+、Safari 16+（与 Vite baseline-widely-available 一致），
  README 增加 Browser Support Matrix 章节。
- 每个 `:has()` 选择器包进 `@supports (selector(:has(*)))`，每个
  `@container` 包进 `@supports (container-type: inline-size)` —— 7 个块内
  40 处 `:has()`，12 个块内 23 处 `@container`。
- 每条 `100vh` 声明紧邻一行 `100dvh` 回退（8 个文件 15 对，含对话框
  shell）。
- `client/index.html` 增加 ES5、无依赖的引擎检查，在模块图加载前运行：
  Chromium 低于 107 时渲染明确的「请更新浏览器 / Android System
  WebView」页面。

## 设计决策

- PWA 从 daemon origin 提供服务，而不是本地打包；本地打包会使所有 API
  调用跨域并迫使运维配置 `--allow-origin`。
- 只缓存带哈希的 `/assets/*`：内容寻址文件不会过期，缓存优先安全，缓存
  名版本键处理升级。
- 其余一律纯网络，让会话状态、SSE 流与 bearer 鉴权不进任何缓存，与
  daemon 的信任模型一致。
- 引擎下限 107 由 Vite 的 baseline-widely-available 推导而来，并非自行
  选定；`dvh` 用成对回退、`:has()`/`@container` 用 `@supports` 守卫。
- worker 入口用 `format: 'es'`：单块无 import 时输出经典脚本；Vite 拒绝
  多输入下的 `iife`（`inlineDynamicImports`）。

## 约束

- 现有 CSP 已允许 `worker-src 'self'`，无需改策略。
- daemon 只服务 `/assets/*` 与根路径；manifest 和 worker 必须位于
  `/manifest.webmanifest` 与 `/sw.js`。
- SW 注册需要安全上下文；纯 HTTP LAN 部署拿不到 worker（已写进文档；
  TLS 是主路径）。

## 风险

- SW 缓存优先的 bug 会把旧 JS 发给所有客户端；用哈希文件名、版本化缓存
  名与 activate 时的清理来缓解。
- Android Chrome 会忽略纯 SVG 安装图标；PNG 192/512 与 SVG 一起发布。

## 验证

- 全仓 `npm run build`；检查 `dist/sw.js`（版本已注入）、
  `dist/manifest.webmanifest`、`dist/assets/icon-192.png`、
  `dist/assets/icon-512.png`。
- 在 `packages/cli` 运行 `npx vitest run src/serve/web-shell-static.test.ts`
  （pre-auth PWA 路由）；扫描全部客户端 CSS，确保没有裸的
  `:has()`/`@container` 以及无 `dvh` 配对的 `100vh`（花括号平衡解析器
  检查）。
- 页面检查：Chrome 桌面/Android 出现安装提示；过旧 WebView 显示更新页。

## 验收标准

1. 所有 `:has()` 与 `@container` 都在 `@supports` 块内；每条 `100vh` 都有
   `dvh` 配对行。
2. `browserslist` 与 README 矩阵一致：Chrome/Edge 107+、Firefox 104+、
   Safari 16+。
3. `/manifest.webmanifest` 与 `/sw.js` 以 `no-cache` 完成 pre-auth 应答。
4. worker 只缓存 `/assets/*`；daemon 路由与带授权的请求永不被拦截。
5. Chromium 107 以下显示更新页面而非白屏。

## 后续

- `sw.js` 中已预留 Web Push 注册，目前引用已发布的 PNG 图标；等 daemon
  或 Android 壳原生发送通知后再接通推送。
- 在 iOS 上复验可安装性（Safari 需要显式「添加到主屏幕」；Web manifest
  在其上仅部分生效）。
