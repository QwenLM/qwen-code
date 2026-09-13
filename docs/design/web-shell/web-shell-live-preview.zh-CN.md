# Web Shell 实时开发预览

[English](web-shell-live-preview.md) | [简体中文](web-shell-live-preview.zh-CN.md)

## 问题与现有行为

右侧面板可以在沙箱 `srcDoc` 中渲染 HTML 文件内容，但不能打开正在运行的开发服务器。
用户必须离开对话才能查看应用，已发布 Web Shell 的框架策略也会阻止其他端口。

本次增量在现有面板中加入浏览器可直接访问的开发 URL，提供地址输入、刷新、响应式宽度
切换和外部打开。服务器仍通过现有终端或 shell 工具运行。

预览历史属于对话，与查看面板相互独立。启用功能后，从某一轮打开 Artifact 发布的
HTTP/HTTPS 网页，会在预览中打开其 URL。普通 `record_artifact` 链接仍展示元数据和
外部打开操作。关闭面板或标签不会删除产物卡片，用户可以从原消息重新打开。
在面板中手动输入地址不会创建对话记录。

这些是实时 URL 的历史入口，不是冻结的网站版本。预览会明确标注这个区别。
复用开发 URL 时，即使从旧轮次打开，也会显示当前应用。现有产物元数据也会按身份更新，
因此不是版本档案。重现过去的网站需要不可变的当轮 HTML 与依赖资源副本，或独立的
版本化部署。自包含 Artifact 交付的存储已在 `web-shell-preview-snapshots.md` 中实现；
面板 localStorage 只保存查看状态。

## 设计

| 层次   | 改动                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 面板   | 在代码审查和终端操作旁新增 `web_preview` 标签和 `webPreview` 操作。独立 Web Shell 默认开启；嵌入式接入方通过 `rightPanel.items` 选择开启。 |
| 预览   | 新增内部 `WebPreviewPanel`，复用输入框和按钮原语。桌面模式填满面板，手机模式使用 390 CSS 像素视口。                                        |
| 状态   | 在现有按工作区和会话区分的面板状态中保存入口 URL 和视口。面板打开期间，非活动预览框架保持挂载。                                            |
| 导航   | 地址代表请求的入口 URL。没有页面桥接时，跨域应用内部导航不能更新该字段。刷新返回入口 URL。                                                 |
| 服务器 | 在 Web Shell 文档策略中允许 HTTP/HTTPS 框架，同时保留其他 CSP 指令、frame-ancestor 策略和权限策略。不新增 daemon 路由。                    |

面板接受不含登录凭据的绝对 HTTP/HTTPS URL，拒绝 Web Shell 和配置的 daemon 来源。
本次不支持 IPv6 字面量 URL，因为 CSP 主机来源不能可靠支持它们；请改用主机名。
渲染已持久化的状态时会再次验证 URL。预览不会转发 daemon 凭据，请求也不携带 referrer。

创建与恢复使用相同的工作区上下文和宿主选择开启条件。Live 或独立会话中的卡片保留
现有产物面板行为，包括工作区可用性限制。Web Shell 的框架策略同时允许现有 PDF 附件
所需的 blob URL；预览包装层继续执行各自更严格的子框架策略。

可信且不执行脚本的 `srcDoc` 包装层包含应用 iframe。包装层 CSP 把 `frame-src` 固定
为已验证的开发来源，阻止直接子应用框架重定向或导航到 Web Shell 或其他来源。
验证也会拒绝其 CSP 允许的 HTTPS 升级可到达受保护来源的 HTTP 地址。内层框架允许
脚本、表单及其自身来源，使普通模块和 web storage 可用，但不能导航祖先或打开弹窗。
所有插入标记的值均转义。验收前，浏览器测试必须验证重定向和脚本导航都被阻止。
包装层不是递归的来源防火墙：应用自身的后代框架使用各自的策略。Web Shell HTML
必须保留现有 `frame-ancestors` 保护，文件端点必须保留 attachment/nosniff 保护。
嵌入式接入方必须防止预览来源嵌入宿主应用文档。Vite 开发服务器通过
`frame-ancestors 'self'` 策略维持同一边界。
离线 HTML 产物预览使用单独的可信父框架，其 `frame-src 'none'` 策略包围具有不透明
来源的内容 iframe。即使 Web Shell 允许实时 URL，父框架限制也会阻止离线内容自身导航。

iframe 的 load 事件不能证明响应成功。界面提供外部打开的备用操作，并简要说明页面
被阻止或不可访问的情况，不声称开发服务器健康。限制嵌入的应用可能需要外部打开。
嵌入式 Web Shell 接入方还必须在自己的 CSP 中允许所需 HTTP/HTTPS 框架来源。

预览由现有面板持久化键管理，包括多工作区和会话切换流程。现有轮次产物回调把记录的
网页请求路由到查看面板，标签 ID 区分来源会话和轮次。不增加文件系统请求或标注反馈
路由。关闭预览会移除 iframe，不会终止用户的服务器。关闭后重开整个面板或切换会话
会从已保存入口 URL 重建浏览器状态；在打开的面板内切换标签则保留状态。

## 受影响文件

- `packages/web-shell/client/components/preview/WebPreviewPanel.tsx`、URL/文档辅助函数和定向测试。
- `packages/web-shell/client/components/artifacts/ArtifactPanel.tsx` 及测试。
- `packages/web-shell/client/App.tsx` 及创建和持久化测试。
- `packages/web-shell/client/customization.tsx`、`main.tsx` 和 `i18n.tsx`。
- `packages/web-shell/README.md` 和定向浏览器 E2E 用例。
- `packages/cli/src/serve/web-shell-static.ts` 及策略测试。这是进程全局的 Web Shell 文档策略变更；所有静态与深层链接入口共用同一个策略构建器。工作区运行时路由不变。

## 后续增量

元素或区域标注需要受控的页面桥接，并正确路由到所属会话的输入框。浏览器验证需要
与 CUA/CDP 共享页面绑定。远程开发需要独立来源的认证代理，转发 HTTP 和 HMR
WebSocket。本次打开入口 URL 不包含这些能力：用户浏览器必须已经能够通过直连或
现有隧道访问目标。

## 验证与开放问题

使用全局 `qwen` 二进制验证基线，再用本地构建的 bundle 验证生产 CSP。
覆盖真实开发服务器、模块、存储、WebSocket 更新、视口尺寸、标签切换、刷新、外部
打开、持久化和无效来源。针对恶意重定向和脚本验证可信包装层策略。详细计划及观察
结果位于 `.qwen/e2e-tests/web-shell-live-preview.md`。

实现前的浏览器试验已在 Chromium 和 Firefox 上通过模块、存储、Vite HMR 以及直接
重定向/脚本导航拦截验证。后代框架探针确认了上述宿主策略要求。由于已安装浏览器与
运行时版本不匹配，未验证 WebKit。
