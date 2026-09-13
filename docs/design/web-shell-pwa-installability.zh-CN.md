# Web Shell PWA 安装能力与浏览器兼容性

[English](web-shell-pwa-installability.md) | [简体中文](web-shell-pwa-installability.zh-CN.md)

状态：实现正在评审。遵循 [issue #11704](https://github.com/QwenLM/qwen-code/issues/11704) 中可选 PWA 方案的方向。

## 问题

由 daemon 提供的 Web Shell 需要安装元数据和明确的浏览器支持约定。不受支持的引擎应显示升级提示，而不是白屏。发布 CLI 时必须保留 Web Shell 构建生成的 PWA 文件。

## 目标

- 为独立 Shell 增加同源安装元数据和 service worker。
- 声明同时覆盖 JavaScript 和生成 CSS 的最低版本。
- 不在 worker 缓存中存储 daemon 状态、令牌、事件流或 HTML。

## 范围外

离线会话、Web Push 投递、关闭应用后的通知，以及最低版本以下的引擎 polyfill。嵌入式组件库不注册 service worker，也不安装独立页面的浏览器检查。

## 设计

### 构建和公开路由

Vite 将独立 UI 输出到 `packages/web-shell/dist`，包含 `index.html`、`manifest.webmanifest`、`sw.js` 和 `assets/`。Worker 是不含 import/export 的第二入口；虽然 Rollup 使用 ES 输出，该入口仍可作为经典 worker 加载。Bundle 复制步骤将两个 PWA 文件保留到 `dist/web-shell`；发布检查拒绝缺少这些文件的产物。

Daemon 在 bearer 认证之前响应 manifest 和 worker 的 GET/HEAD 请求。这些资源属于进程全局，不携带工作区数据或凭据。冷启动请求判定与 Express 的大小写不敏感路径和可选尾部斜杠一致。Manifest 使用 `application/manifest+json`；worker 使用 `application/javascript` 和 `Service-Worker-Allowed: /`。两者均设置 `no-cache` 和 `nosniff`；文件缺失返回 404，而非 Shell HTML。

### Worker 生命周期与缓存

仅生产版独立入口在页面加载后注册 `/sw.js`。注册失败不影响普通在线使用。注册需要 HTTPS 或可信的 loopback origin，普通 HTTP 局域网 origin 不支持注册。

Worker 通过 `skipWaiting` 和 `clients.claim` 立即激活，删除旧的 `qwen-code-shell-*` 缓存并保留无关缓存。当前缓存名包含包版本；带内容哈希的 chunk 文件名区分同一版本下的不同构建。

只有同源构建资源使用 cache-first。不带哈希的 `icon.svg` 和 `icon-*.png` 绕过 worker 缓存，HTTP 响应要求重新验证。Manifest 同样走浏览器网络路径，因此同版本部署也能更新它。非 GET、跨源、带认证和 SSE 请求均不拦截；普通 API fetch 也不拦截。HTML 导航走网络，连接失败时返回静态 503 重试页面，不恢复缓存的会话 HTML。缓存读写失败不能阻止可用网络资源加载。

### 浏览器约定与布局

最低版本为 Chrome/Edge/Android System WebView 111+、Firefox 128+、Safari/iOS 16.4+。此约定源于 [Tailwind v4 的 CSS 要求](https://tailwindcss.com/docs/compatibility)，而非 Vite 默认 target。显式 JavaScript 构建目标仍为 ES2021，兼容 xterm 的生成语法；语法目标本身无法证明 CSS 兼容性。

ES5 内联检查在模块图启动前检查已知浏览器版本，并在可用时检查必要 CSS 能力。检查标记不支持的引擎，由现有启动 watchdog 在 `#root` 内显示一个跟随主题的升级面板；主入口保留该面板。未知 UA 可以尝试启动，失败时由现有 watchdog 显示提示。

修改的 viewport 规则保留 `vh` 回退，并在实际渲染元素需要时使用 `dvh`。对话框尺寸作用于当前 Radix dialog content，覆盖全屏状态。Tooltip 中带 viewport 单位的自定义属性放入 `@supports`，因为不支持的单位会使整条计算后的声明失效。现有 `:has` 和 container 条件只是渐进 CSS 行为，不是 polyfill，也不承诺支持旧引擎。

## 约束与风险

- Manifest 不保证自动安装提示；浏览器策略、使用条件、安全上下文和平台 UI 都有影响。
- Worker 立即接管已打开标签页。带哈希的资源保持内容身份，API 状态和 HTML 不缓存。
- 动态 viewport 单位处理工具栏缩放，但不证明所有移动键盘行为一致。
- 浏览器矩阵是支持约定，不代表已测试所有最低版本或真机。

## 评审测试计划

1. 用打包后的 CLI 启动带令牌保护的 daemon。无 bearer 打开 Shell 并获取 manifest、worker 和图标；无 bearer 的 API 请求必须仍被拒绝。
2. 使用相同包版本部署修改后的元数据。重新加载后 manifest 和所有公开图标应更新，带哈希的 chunk 可以继续缓存。
3. 停止 daemon 后导航，应看到可读的重试页面，不能恢复会话或缓存 API 响应；恢复连接后重试。
4. 分别模拟不支持的浏览器版本和模块加载失败；主题根节点中应只有一个对应提示，不出现第二个提示或白屏。
5. 在受支持的移动浏览器改变 viewport 高度，检查普通/全屏对话框和输入框 tooltip。
6. 通过浏览器提供的安装或“添加到主屏幕”入口验证，记录实际浏览器和设备；固定 viewport 自动测试不能证明真机可安装性。

## 验证证据

定向自动测试覆盖 HTTP 路由、打包、worker 行为和完整 HTML 解析后的启动。PR 验证报告记录命令、结果和准确版本。真机安装、最低版本渲染和移动键盘行为需要单独设备证据，此处不作已通过声明。
