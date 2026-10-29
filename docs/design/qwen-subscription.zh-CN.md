# Qwen Subscription 接入

[English](qwen-subscription.md) | [简体中文](qwen-subscription.zh-CN.md)

关联 Issue：[#15180](https://github.com/QwenLM/qwen-code/issues/15180)。

## PRD 后续调整（2026-10-29）

本轮从预发网关 `GET /compatible-mode/v1/models` 获取完整模型 ID 列表，不按客户端固定名单过滤。真实读取已返回 `qwen3.8-max`、`qwen3.7-flash`、`qwen3.7-plus`。首次优先选择服务端返回的 `qwen3.8-max`，否则选择首项；已有选择下线时保留选择并提示通过 `/model` 重选，不能自动替换。认证弹窗只显示该提示，不额外列出模型选项；CLI 按 Esc、GUI 点击取消即可保留登录态并返回输入框，即使会话尚未初始化，也能通过 `/model` 打开已有选择器。CLI 启动时出现这类模型错误也必须允许 Esc 返回。模型加载失败保留账号凭证和上次成功列表；没有缓存时明确报错，不虚构可用模型。

列表缓存归属同一会员会话，随退出或新账号授权清除。Core 负责获取、缓存与注册；CLI 的 `/model` 和 GUI 现有模型刷新操作更新列表，继续使用工作区运行时，不增加进程级配置写入路由。购买重查期间保留查看套餐和退出账号，重复查询仍禁用。

桌面端复用现有 ModelReasoningControls 和 ACP 设置通路。已探测 Max 网关接受 `enable_thinking=false`，以及开启时 `thinking_budget=4096/16384/32768`；关闭响应无 reasoning_content，开启有 reasoning_content。这仅验证参数接受及开关表现，不证明长推理严格遵守预算。其余模型能力不能从名称推断；本轮先记录方案与证据，不自动向全部模型注入能力。会员搜索已通过预发 MCP 接口接入，详见[会员 MCP 联网搜索](subscription-mcp-web-search.zh-CN.md)。`DEV=true` 继续作为现有预发开发入口开关。

验证覆盖完整服务端列表、未知新模型、失败与空列表的缓存恢复、无缓存错误、模型下线不自动切换、取消与账号变化、重查/套餐并存及其他鉴权回归；构建、类型检查、打包和定向测试后自审。官网文档说明调试状态及搜索边界，不执行发布。

### 思考控件：后续接入方案

复用共用 Web Shell 编辑器里的 `ModelReasoningControls`。桌面端和 VS Code 已通过会话 actions 和 ACP `reasoning_effort` 传递选择，不需要新增会员设置页。只为真实网关确认支持的模型声明能力：默认开启、允许关闭、提供低／中／高三档。默认强度仍需产品确定；PRD 的默认开启并未指定默认强度。

在共用 Core 请求边界统一映射：关闭发送 `enable_thinking: false` 并移除 `thinking_budget`；低／中／高发送 `enable_thinking: true` 和 `thinking_budget: 4096/16384/32768`。不能用 OpenAI 的 `reasoning_effort` 或嵌套 `chat_template_kwargs` 替代已验证的顶层字段。现有 Qwen 仅开关 profile 无法表达三档预算，应增加限定于会员协议的映射和能力校验，避免改动其他 provider 的 DashScope 行为。

验收需从桌面控件切换一路核对最终请求，确认关闭后再开启、会话恢复能保留所选强度，切换模型不会携带不支持的能力。真实网关目前仅探测 Max；其他模型支持情况与长推理预算执行仍待确认。本项是设计与探测结论，尚未实现思考功能。

## 范围与状态

会员授权视图与旧 OAuth 进度视图分离，保留旧流程的标题、倒计时和取消行为。会员授权过期由 Core 负责，视图只展示状态，并仅在设备授权原始 expiresAt 截止前允许复制链接。删除无调用的初始查询状态及 CLI 付费摘要分支，保留现有 CLI 历史成功摘要和 GUI 付费摘要。

桌面端只在现有 `/auth` 弹窗中增加 Qwen 登录方式。PRD 已划掉的独立登录引导页和固定订阅按钮直接跳过，不列入开发任务。

CLI（Ink、OpenTUI）、VS Code、桌面端使用新版设备授权协议。已实现真实 OAuth 请求处理、凭证保存、会员查询和购买等待，供显式开启的开发环境联调。
产品中的 Mock 入口、模拟购买和模拟模型列表已删除。单测替身和本地合成 HTTP 服务保留，用于回归验证。

开发模式下，确认 Plus/Pro 后可通过共用 OpenAI Chat 管线激活服务端返回的会员模型。确认 Plus/Pro 后，登录流程自动保存选定工作区的配置并初始化运行时，成功后返回对话，不再要求点击 Connect；真实网关是否可用由首次对话请求验证。动态模型发现及[会员 MCP 联网搜索](subscription-mcp-web-search.zh-CN.md)已接入开发环境。已停用的旧 OAuth provider 及其推理实现保持不变。

## 登录与购买流程

1. 申请设备码，显示授权链接并打开浏览器，同时轮询 Token 接口。
2. 网页确认后，保存 Token 对，调用 `/api/oauth/userinfo` 获取身份和 `member_type`。首次查询失败保留凭证，显示查询错误和 `Check again`，只重查身份与会员，不重新授权；确认 Free/Go 后才打开购买页。不需要网页回调 CLI。
3. Plus/Pro 显示账号信息；Free/Go 打开购买页，每 5 秒查询会员，从首次确认 Free/Go 并进入购买等待起最多自动查询 120 秒。
4. 正常等待购买时显示 `Open plans again`；查询失败或超时后显示 `Check again`，同时保留 `Open plans again`。手动查询期间禁用重复点击。
5. 关闭流程取消待完成任务；退出登录先清理本地凭证，再调用 revoke。远端撤销失败显示本地已退出但远端未撤销，本地清理失败单独报错。Access Token 过期时自动刷新，只有刷新阶段的 invalid_grant 才表示刷新凭证失效；临时网络错误保留凭证并允许重查。授权、兑换、凭证读写、会员查询、刷新和退出按阶段显示安全错误，不显示任意后端正文。429 遵守 Retry-After，申请授权、刷新和会员查询的冷却期限保存在共享凭证中，重复操作不提前请求。

使用已确认的 PRD/PD 文案。不增加倒计时、单独的设备码标签或初始会员查询卡片。GUI 使用按钮，终端快捷键提示只用于 CLI。会员状态由后端判断。授权期限由 Core 按设备码 expires_in 截止，GUI 不另设固定 600 秒限制；CLI 到期后保留超时框，用户按键才返回。GUI 的重新授权使用 `Sign in again`，`Check again` 仅查询身份与会员。

## 协议与凭证归属

| 用途             | 接口                          |
| ---------------- | ----------------------------- |
| 申请设备码       | `POST /api/oauth/device/code` |
| Token 兑换与刷新 | `POST /api/oauth/token`       |
| 身份与会员       | `GET /api/oauth/userinfo`     |
| 退出登录         | `POST /api/oauth/revoke`      |

预发认证域名为 `https://pre-auth.qwen.ai`，OAuth 的 `client_id=qwen-code-cli`。
浏览器链接为 `https://pre4-chat.qwen.ai/authorize?user_code=<code>&client=qwen-code`。
网页参数 `client` 与 OAuth `client_id` 是两个参数。
购买页为 `https://pre4-chat.qwen.ai/?memberPlan=qwen_code`。
`/upgrade`、登录后购买和再次查看套餐共用此地址，桌面端使用的 daemon 配置也返回该地址。购买链接不会复用设备授权 URL，也不带 `user_code` 或 `client` 参数。
此入口已对照 `qwen-chat-fe` 的 `feat/qcode_authorize` 分支提交 `127d20ad8`（2026-10-29）确认；网页端需要已登录账号。

core 的 `QwenSubscriptionSession` 负责私有权限的原子凭证保存、恢复、跨进程刷新锁和撤销。各端仅在使用相同有效 `QWEN_HOME` 时共享会话。新凭证文件与旧 OAuth 凭证分开；刷新后完整替换返回的 Token 对。Token 和设备码不进入 GUI 响应。

GUI 通过带鉴权的本地 daemon `/auth/subscription` 路由查询能力、开始、读取、取消登录、查询身份和退出。这些操作属于进程级账号，与对话或工作区配置无关。会员请求使用原 daemon 地址及 Token 创建短生命周期 client，工作区连接关闭不会打断晚到的登录响应，也不会向新 daemon 取消旧登录。关闭视图也会取消晚到的开始登录结果。

VS Code 在用户发起登录时查询能力；等待期间不打开其他登录流程，失败时显示已有登录错误并允许再次尝试。Web Shell 只在能力查询成功后展示入口。能力关闭时仍可使用已有服务商登录。

## 开发配置

在仓库根目录直接运行 `npm run dev`。会员登录使用 `packages/core/src/qwen/oauth-config.ts` 中固定的预发配置：认证地址 `https://pre-auth.qwen.ai`、客户端 ID `qwen-code-cli`、网页地址 `https://pre4-chat.qwen.ai`。不需要配置 OAuth 环境变量或独立目录；授权链接携带 `user_code` 和 `client=qwen-code`。发布前，将此处替换为后端确认的正式配置。

GUI 宿主设置 `DEV=true`，由本地 daemon 继承，并使用同一份固定配置。
重新构建及打包后，执行 `node packages/vscode-ide-companion/scripts/copy-bundled-cli.js` 同步 VS Code 使用的 CLI，再启动插件开发宿主。桌面端在 `packages/desktop` 执行 `npm run build:runtime`，然后 `npm run dev`。已有 daemon 需要重启才能使用新代码和环境。本配置不开放生产入口。

## 验证与剩余依赖

验收覆盖首次会员查询失败后仅重查、各阶段错误、跨实例 Retry-After、短于和长于 600 秒的授权期限、超时框停留及按键返回、远端撤销与本地清理失败，以及两种终端渲染器、VS Code 能力查询等待与失败、Web Shell 切换连接与取消、购买与重查按钮并存、凭证刷新与退出，以及其他服务商登录不受影响。定向测试和本地 HTTP/浏览器合成服务验证这些流程，不使用用户凭证。原生 VS Code/桌面宿主及真实预发授权需要单独验证，本地合成测试不代表这些场景已通过。

发布前需确认服务端模型 ID 与默认模型、推理和搜索地址、Token 支持、额度及错误响应、购买生效。完成对应适配和端到端验证后，才能将会员登录视为可用的模型会话，并更新官网文档宣布开放。

## 会员推理接入

状态：本地实现，验证结果记录在测试计划中。预发网关为 `https://pre-api.qwen.ai/compatible-mode/v1`，使用 OpenAI Chat Completions，使用服务端模型列表。2026-10-29 后端修复后，使用真实 Pro Token 的 OpenAI SDK 对此网关发起流式、非流式请求，均返回 HTTP 200 和 `OK`，包含 usage。此前的 404/401 失败保留在验证记录中。这证明 SDK 对话链路可用；原生宿主及完整 agent/工具流程仍需单独验收。

增加独立鉴权类型 `qwen-subscription`，保持旧 OAuth 不变。仅在开发模式注册服务端返回的会员模型，拒绝任意网关覆盖。复用现有 OpenAI Chat 管线和默认兼容 provider，不自动启用 DashScope 专属字段、搜索或未经验证的模型能力。配置和设置只保留鉴权选择、模型 ID、固定网关和凭证占位符。

会员会话通过现有凭证文件、跨进程锁和冷却机制提供有效 Access Token。提取现有刷新操作，使会员查询和推理共享。HTTP 401 时可刷新被拒绝的 Token 并重试一次；在锁内比较当前 Token 与被拒绝的 Token，避免重复轮换。HTTP 403、404、429 不触发刷新，响应开始交付后不重放流。模型 HTTP 请求在凭证锁外执行。在传输边界注入 Bearer 凭证，保留取消及代理行为，在凭证发出前拒绝重定向和其他目标地址。

确认 Plus/Pro 后，各端通过现有工作区或会话选择机制自动激活选定的服务端模型，成功后返回对话；已有模型下线时允许返回输入框执行 `/model`，不显示激活成功，GUI 宿主退出认证前刷新已有模型目录。账号登录路由仍为进程级；如需增加激活路由，必须属于选定 runtime，解析目标工作区，遵守信任及 generation 生命周期，不能回退主 runtime。CLI Ink/OpenTUI 和 GUI 宿主共享 Core 凭证，只更新选定对话或工作区。CLI 激活写入已信任的工作区范围，不能回退用户全局设置。取消会终止提交前检查；安装事务开始后保持完整提交，已取消的视图不再应用迟到的成功回调。缺失凭证时直接失败，不隐式发起设备授权。重启可恢复已选会员鉴权；退出后后续请求不能复用缓存 Access Token。

涉及 Core 会员配置、会话、传输、鉴权与模型解析，CLI/SDK 鉴权字面量、终端登录激活、daemon 工作区激活和共用 GUI 登录。定向测试覆盖过期、并发轮换、退出、路由归属、普通及流式请求和工具结果回传。同步维护中英文设计，在 `.qwen/e2e-tests/qwen-subscription-inference.md` 记录基线及本地验证；完成构建、类型检查、打包、相关包测试后自审和独立评审。搜索、生产开放和旧 OAuth 改动不在本次范围内。网关路由和业务错误码仍依赖后端确认。

## 会员确认后自动激活

CLI（Ink/OpenTUI）、VS Code 和桌面端删除额外的 Connect 确认。首次登录或恢复会话、会员查询失败后重查成功、购买轮询发现 Plus/Pro 时，均自动开始激活。Free/Go 保留现有购买流程。

每个授权或 transport 生命周期只自动尝试一次。父组件重渲染、回调函数身份变化不能重复触发。激活期间显示进度，不提前返回对话；失败时保留安全错误和显式 Retry，不自动循环重试或重新授权。成功后复用已有宿主完成回调，关闭认证并返回对话。CLI 认证完成时同时从当前 Config 同步模型显示，使顶部和底部立即显示所选模型。

GUI 激活必须属于确认会员的生命周期和 transport，新的 transport 不能消费旧的 ready 状态。取消、卸载和归属变化仍需抑制迟到的成功回调。首次会话尚未创建时，激活成功还需在关闭认证前，通过既有模型选择回调更新欢迎页输入框的待用模型，避免首条消息重新应用旧供应商的模型。保留现有工作区安装事务、账号凭证和 daemon 路由。改动仅涉及终端 hook/视图、共用 GUI 会员流程及 hook、相关宿主测试、重试/进度文案和两份设计。回归覆盖 Plus/Pro、Free/Go、购买/查询恢复、等待/错误/重试、回调重渲染、transport 切换和取消。

## CLI 登录成功与账号命令

确认 Plus/Pro 会员后，两种 CLI 渲染器自动激活选定的服务端模型。激活成功后关闭认证界面，并在会话中保留账号、套餐以及 `Model: <所选模型> · Run /usage to see your plan usage` 摘要。一般激活失败保留重试入口；模型下线时只提示 `/model` 并允许返回输入框。取消后不再显示迟到的成功结果。选择订阅鉴权时，正常输入框提示 `Type your request, or /usage`，并显示 `Try: /usage /status /upgrade /auth`。

复用现有 `/usage`（`/stats` 的别名）和 `/status`。`/usage` 继续显示 CLI 本地用量统计，不查询服务端套餐剩余额度。新增仅开发模式可用的交互命令 `/upgrade`，打开现有 Qwen Code 套餐页；禁止自动打开浏览器或打开失败时仍提供 URL。账号管理继续使用现有 `/auth` 命令，不修改其行为，也不新增独立 `/logout` 命令。本次只修改 CLI。

验收：恢复付费账号、新授权、购买轮询和查询重试确认会员后，都无需再次选择 Connect；激活失败或取消不能显示成功；正常输入可用；已有用量、状态和认证命令保持不变，升级命令在两种渲染器中可用。通过定向测试、构建、类型检查、打包及 `.qwen/e2e-tests/subscription-login-success.md` 中的隔离测试脚本验证。
