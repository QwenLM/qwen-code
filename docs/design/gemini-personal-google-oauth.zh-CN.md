# Gemini 个人 Google OAuth 与 Code Assist

[English](gemini-personal-google-oauth.md) | [简体中文](gemini-personal-google-oauth.zh-CN.md)

**状态：** 实现及聚焦离线验证完成；真实账号验收待完成。此工作树内容尚不代表已合入或发布。
**日期：** 2026-11-21

## 1. 问题与现状

Qwen Code 已在核心层广泛使用 `@google/genai` 的请求和响应类型，并通过 `LlmContentGenerator` 原生发送 Gemini Developer API 与 Vertex AI 请求。该路径支持 Gemini API key、Vertex API key 或 Vertex Application Default Credentials。

它尚未提供 Gemini CLI 式个人 Google 登录：没有个人 Google OAuth `AuthType`、OAuth 回调流程、Google refresh token 存储、Code Assist onboarding，也没有 Code Assist `ContentGenerator`。

不能简单地把 OAuth access token 填入现有 `apiKey` 字段。个人 Google 登录使用 Code Assist 服务及其 project/tier 生命周期，而不是 Gemini Developer API key 端点。

目标是与 Gemini CLI 相同类型的个人 Google 登录及 Code Assist 资格和配额链路。资格和配额由服务端决定；本功能不能为不符合资格的账号创造配额。

### 参考证据

- Qwen Code 在 `packages/core/src/core/contentGenerator.ts` 和 `packages/core/src/core/llm-content-generator/` 将 `gemini`、`vertex-ai` 路由到 `GoogleGenAI`。
- 审查了 Gemini CLI 上游 HEAD `eecccfcd5aff25de5e78135ca20f7abe3f566955`：
  - [`oauth2.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/oauth2.ts)
  - [`setup.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/setup.ts)
  - [`server.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/server.ts)
  - [`converter.ts`](https://github.com/google-gemini/gemini-cli/blob/eecccfcd5aff25de5e78135ca20f7abe3f566955/packages/core/src/code_assist/converter.ts)
- 对本机 Antigravity 2.33.0 `language_server` 二进制的只读检查确认了对应的 OAuth scopes、`cloudaicompanionProject`、`user_prompt_id`、keychain token 处理及 Code Assist 方法。它只是辅助证据，不是可复制的源码或 API 契约。
- 用户已选择 Gemini CLI 公共 installed-app OAuth client，不复用 Antigravity 的 OAuth 身份。

## 2. 目标与范围边界

### 本次范围

1. 交互式个人 Google 登录与退出。
2. Offline access、refresh token 持久化、access token 刷新及缓存凭据启动。
3. Code Assist `loadCodeAssist`、`onboardUser` 与 long-running operation 处理。
4. 服务端决定的个人 tier 和 project 行为，包括 free tier 的托管项目。
5. 通过 Code Assist 原生生成文本和流式响应，同时保留 Qwen Code 的现有工具、历史、取消、日志和重试行为。
6. 两套交互式 CLI 认证界面：Ink 与 OpenTUI。
7. 通过 daemon 与专用 ACP flow 支持 Web Shell 认证，包括授权 URL 展示、手工授权码提交、取消及目标会话的模型激活。
8. 使用已有缓存凭据的非交互运行；缺少凭据时明确失败，而不是意外打开浏览器。
9. 内置本机 Antigravity 二进制中出现的 `gemini-4-argon`（默认）、`gemini-4-carbon`、`gemini-4-hydrogen` 路由，并保留稳定的 `gemini-2.5-pro` 兼容路由。

### 本次不做

- Antigravity OAuth 身份、专有 UI、AICode 特定路由或产品行为。
- 修改 Vertex AI 或 Gemini Developer API 行为。
- 动态模型实验、预览资格解析和远程模型目录。
- 付费 credits 自动启用、超额计费、credit 余额及专门的配额看板。
- Admin controls、插件 OAuth、MCP OAuth、企业网关行为及 service account impersonation。
- Code Assist embeddings。`embedContent` 必须明确报错，不能悄悄切换 provider。
- 新的操作系统 keychain 后端。第一版使用受保护的文件存储；keychain 可另行考虑。
- 复用或泛化 Qwen OAuth 的凭据文件或 `SharedTokenManager`。

## 3. 拟定架构

新增独立的 `AuthType.GOOGLE_OAUTH = 'google-oauth'` 与专用 Code Assist generator：

```text
/auth 或缓存启动
        ↓
Google OAuth2Client + 隔离的 Google 凭据存储
        ↓
setupUser：loadCodeAssist → 可选 onboardUser → project/tier
        ↓
CodeAssistContentGenerator
        ↓ 现有 LazyContentGenerator → LoggingContentGenerator
LlmChat、工具、历史、取消、重试和用量上报
        ↓
https://cloudcode-pa.googleapis.com/v1internal
```

此分支不得进入现有 `USE_GEMINI` / `USE_VERTEX_AI` 分支，也不得接受通用 provider `baseUrl` 或 API key。Code Assist 的 project 和 model 行为由新的 provider adapter 负责。

内部边界继续使用现有 `GenerateContentParameters` 与 `GenerateContentResponse` 类型，不引入 OpenAI 转换。

## 4. 组件设计

### 4.1 个人 Google OAuth

使用 `google-auth-library` 的 `OAuth2Client` 和用户选定的 Gemini CLI 公共 installed-app client 配置。保留上游关于 installed application 配置的说明；真正的秘密是 refresh token 和 access token，绝不能记录到日志。

请求的 scopes：

- `https://www.googleapis.com/auth/cloud-platform`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`

交互流程：

- 可打开浏览器的终端：只绑定 loopback，使用可用端口与 `/oauth2callback`，生成不可预测的 `state`，请求 offline access，打开授权 URL，完成后将浏览器重定向到成功或失败页。
- 无法打开浏览器的交互终端：采用 Gemini CLI 授权码回调和 PKCE S256，显示授权 URL 并让用户输入授权码。
- 非交互/headless 运行及派生 agent generator：只加载和刷新缓存凭据，不打开浏览器，也不等待授权码。

校验 callback path 和 `state`，支持取消，在所有结束路径关闭临时 HTTP server，并沿用上游五分钟交互授权超时。账号元数据可使用现有 `google_accounts.json` 路径，但 token 必须写入新的 `google_oauth_creds.json`，并使用独立 lock 名称。

通过 OAuth client 的 token 事件持久化刷新后的 token。缓存写入必须在刷新响应省略 refresh token 时保留原值，使用原子替换，并设置 `0600` 权限。绝不能把 Google 凭据写入 Qwen 的 `oauth_creds.json` 或 `oauth_creds.lock`。

### 4.2 Code Assist 用户初始化

默认 endpoint 为 `https://cloudcode-pa.googleapis.com`，API version 为 `v1internal`。`CODE_ASSIST_ENDPOINT` 和 `CODE_ASSIST_API_VERSION` 可用于受控测试和兼容环境；通用 `modelProviders` 与 `providerProtocol` 不得把个人 OAuth token 重定向到其他 endpoint。

初始化顺序遵循 Gemini CLI：

1. 依次读取 `GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_PROJECT_ID`；纯数字 project number 给出针对性错误。
2. 使用 Gemini plugin metadata 调用 `loadCodeAssist`。
3. 若已有 current 或 paid tier，优先选择 paid tier，再选择 current tier，并从响应或显式环境配置取得 project。
4. 否则选择默认 allowed tier，并调用 `onboardUser`。
5. 对 `free-tier` 省略用户 project，由 Code Assist 分配托管项目；其他 tier 在需要时传入配置的 project。
6. 对未完成的 operation 每五秒轮询一次，支持取消，并提取最终 project ID。
7. 明确呈现 validation-required、账号不符合资格、地区/年龄限制及缺少 project 的错误，不能静默更改 auth type 或 backend。

只按 OAuth client 和 project 短时缓存初始化结果，以避免重复 setup 调用。刷新初始化结果不得再次触发交互登录。

### 4.3 Code Assist 内容生成

`CodeAssistContentGenerator` 实现现有三方法 `ContentGenerator` 接口。

生成请求时，把现有 Gemini 形状封装为 Code Assist 请求：

- 顶层 `model`、`project`、`user_prompt_id`；
- 嵌套 `request.contents`、`systemInstruction`、`cachedContent`、`tools`、`toolConfig`、`labels`、`safetySettings`、`generationConfig`、`session_id`。

使用：

- 非流式生成：`POST /v1internal:generateContent`；
- 流式生成：`POST /v1internal:streamGenerateContent?alt=sse`。

解析 SSE `data:` 记录时正确处理跨 chunk 边界和多行事件。传递传输错误和 abort signal。不能静默丢弃损坏的最终 JSON，也不能把错误响应当成空的 successful response。

将 Code Assist 响应解包为标准 `GenerateContentResponse`，保留 candidates、automatic function-calling history、prompt feedback、usage metadata、model version，以及可用的 trace/response ID。这样现有日志和用量统计仍观察同一种响应形状。

`embedContent` 抛出明确的 unsupported-operation 错误，不回退到 Gemini Developer API 或 Vertex AI。

## 5. Runtime、模型与 UI 接线

### 认证与校验

- 在 core 和 CLI 中对 `google-oauth` 豁免 API key 校验。
- 不得为该 auth type 设置 `GOOGLE_GENAI_USE_VERTEXAI`。
- 在通用 API key/base URL 解析之前返回专用 content-generator 配置。
- `createContentGenerator` 先取得 Google OAuth client 并完成 setup，再构造 generator，保留现有 lazy 和 logging 包装。
- 对派生及无人值守 generator 遵守 `isInitialAuth` / cached-only 行为。
- 遥测分类为 Gemini `generate_content`，不能落入默认 OpenAI-compatible pipeline。

### 模型目录

默认使用 `gemini-4-argon`，同时内置 `gemini-4-carbon`、`gemini-4-hydrogen` 和稳定的 `gemini-2.5-pro`。这些不透明的模型 ID 原样传给 Code Assist，不根据 reasoning effort 后缀或显示名进行推断。不能经 `modelProviders.gemini` 路由，不能继承 `GEMINI_API_KEY`，也不能让自定义 provider 声明改变其 backend。远程目录、动态实验及资格解析留待这些路由验证之后处理。

### 交互认证

在 Ink 与 OpenTUI 认证对话框中增加“Sign in with Google”。共享控制器暴露授权 URL、pending/onboarding 状态、取消、账号身份及错误。只有 OAuth 和 Code Assist setup 全部成功后，才写入 `security.auth.selectedType` 并刷新当前 generator。

退出只清除 Google OAuth token、缓存的 Google account metadata，以及 Google client/setup caches。不得清除 Qwen OAuth 或其他 provider 凭据。

### Daemon 与 Web Shell 认证

显式 `browser: 'auto' | 'external' | 'manual'` 选项区分普通终端登录与宿主驱动登录。只有显式外部宿主模式允许 ACP runner 本身不是 TTY 时执行交互流程；没有这些选项的手动/headless 调用仍仅使用缓存。`external` 禁止 daemon 自动打开浏览器；`manual` 进一步选择授权码 + PKCE 流程，避免远程浏览器错误访问自己机器上的 `127.0.0.1`。

流程由真实 ACP runner 持有，而不是由 daemon 伪造 `Config`。四个命令（`qwen/google-oauth/start|status|code|cancel`）维护每个 flow 的 AbortController 和公开状态，解决手工 code 的 deferred，运行 setup，并在成功之后提交 provider。调用按字段限定：start、read、cancel 和 code 都通过专门的 workspace facade，并在前后校验 runtime generation。终态只短暂保留，再自动删除。独立的 Google 登录锁避免不同进程同时登录导致凭据互相覆盖。

严格 mutation 的 daemon 路由只转发命令，不读取凭据或授权码。`POST .../flows/:id/code` 只接受有大小上限的 JSON body，不在查询参数、状态视图或日志中暴露 code。SDK 对齐这四个操作。普通 provider installer 不接收占位 API key；同时不复用 Qwen device-flow registry 或 ACP `authenticate`。

Web Shell 在现有 provider 菜单末尾新增 Google 入口。它在客户端浏览器只自动打开一次授权 URL，使用同一个 workspace selector 轮询，需要时收集手工 code，并支持取消。收到 ready 后，使用现有 `setModel` 路径激活 `gemini-4-argon(google-oauth)`（或服务返回的模型），同时保持 standalone/draft 行为；如果会话或 workspace 目标已改变，则拒绝激活。

## 6. 兼容性与安全约束

- 保持现有 `gemini`、`vertex-ai` 行为和配置不变。
- 不复用 Qwen token 文件、锁、账号处理器或退出登录例程。
- 不记录授权码、access token、refresh token、凭据 JSON 或携带 token 的 URL。
- callback 只绑定 loopback，并在换取授权码之前校验 `state`。
- Code Assist endpoint 是 bearer credential 的目的地；不能把任意的 custom headers 或 provider endpoint 继承到此路由。
- OAuth、onboarding、HTTP 请求及 SSE 消费都必须保留 abort 行为。
- 对改编自 Gemini CLI Apache-2.0 实现的部分保留来源声明。
- 不复制 Antigravity 的 client ID、产品 metadata 或私有实现细节。

## 7. 预计涉及文件

新增实现及同目录测试：

- `packages/core/src/code_assist/oauth2.ts`
- `packages/core/src/code_assist/setup.ts`
- `packages/core/src/code_assist/server.ts`
- `packages/core/src/code_assist/converter.ts`
- `packages/core/src/code_assist/types.ts`
- `packages/core/src/code_assist/index.ts`

现有集成点包括：

- `packages/core/src/utils/auth-type.ts`
- `packages/core/src/core/contentGenerator.ts`
- `packages/core/src/models/{constants,modelRegistry,modelConfigResolver,modelsConfig}.ts`
- `packages/core/src/telemetry/gen-ai-provider.ts`
- `packages/core/src/config/storage.ts`
- `packages/cli/src/config/{auth,config,top-level-options}.ts`
- `packages/cli/src/utils/modelConfigUtils.ts`
- `packages/cli/src/ui/auth/AuthDialog.tsx`
- `packages/cli/src/ui/auth/useAuth.ts`
- `packages/cli/src/ui/opentui/dialogs-auth.tsx`
- `packages/cli/src/acp-integration/acpAgent.ts`
- `packages/cli/src/serve/routes/google-oauth.ts`
- `packages/cli/src/serve/server.ts`
- `packages/cli/src/serve/run-qwen-serve.ts`
- `packages/cli/src/serve/workspace-service/{types,index}.ts`
- `packages/sdk-typescript/src/daemon/{types,index,DaemonClient}.ts`
- `packages/web-shell/client/daemon/workspace/{types,actions}.ts`
- `packages/web-shell/client/components/messages/{AuthMessage,GoogleOAuthEntry,GoogleOAuthFlowPanel}.tsx`
- `packages/web-shell/client/components/dialogs/ModelDialog.tsx`
- `packages/web-shell/client/App.tsx`
- Web Shell i18n catalogs，以及实现期间通过符号搜索发现的 ACP/host 认证映射和用户文档。

这是一个多文件功能，而不是 provider preset 小改动。额外发现的消费者必须逐个分类，不能默认兼容。

## 8. 验证与验收标准

### 离线自动验证

1. OAuth loopback 成功、callback 拒绝、state 不匹配、取消、超时及 headless 拒绝。
2. PKCE 授权码流程及授权码脱敏。
3. 凭据权限、原子写入、refresh token 保留、刷新事件及与 Qwen token 文件的隔离。
4. 针对 fake Code Assist 服务验证现有 tier、free-tier onboarding、paid-tier/project onboarding、operation 轮询、validation-required 和账号不符合资格。
5. 非流式与流式请求封装、嵌套 SSE 边界、abort、HTTP 错误、损坏事件及响应/用量映射。
6. cached-only headless 启动、子代理不会意外触发交互登录，以及 embedding 明确失败。
7. Ink、OpenTUI 和 Web Shell 都只在 setup 成功后提交所选 auth type，失败或退出时保留其他 provider 状态。
8. 现有 Gemini、Vertex、Qwen OAuth 与 model-provider 回归套件保持通过。
9. ACP flow 完成、拒绝重复 start、取消、按 workspace 转发的 daemon 路由、严格 bearer 门禁、SDK JSON 契约，以及 Web DOM 模型激活。
10. `npm run build`、`npm run typecheck`、`npm run bundle`、lint/format 检查和相关包聚焦测试通过。

### 真实账号验收

使用真实 Google 账号在不配置 API key 的情况下完成登录、onboard/load、含工具调用的流式编码请求、缓存重启、token 刷新及退出。先验证 `gemini-4-argon`，再在账号可用时分别短请求 `gemini-4-carbon` 和 `gemini-4-hydrogen`。记录服务端返回的 tier/project 和任何 quota 结果作为证据。账号不符合资格或模型不可用时，应呈现对应服务错误，而不是承诺获得资格或配额。

离线 mock 无法证明 Google 的资格和配额。如果没有实际运行真实账号，只能声明已通过 unit/integration 测试，不能声明已验证线上 Code Assist 资格和配额。

## 9. 仍需用户配合的事项

OAuth client 决策已确定：使用 Gemini CLI 公共 installed-app client。最终线上验收需要一次真实账号浏览器登录；离线实现和测试不需要用户 token 或 Antigravity 凭据。
