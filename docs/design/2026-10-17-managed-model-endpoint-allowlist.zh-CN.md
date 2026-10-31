# 托管模型端点白名单（`model.allowedBaseUrls`）

[English](2026-10-17-managed-model-endpoint-allowlist.md) | [简体中文](2026-10-17-managed-model-endpoint-allowlist.zh-CN.md)

## 状态与范围

已在 PR #14231 中实现（第 1–4 轮修复）。`model.allowedBaseUrls` 是模型端点 baseUrl 的托管白名单。这是一个纯配置机制：没有新的 CLI 参数，没有新的协议。范围之外：SDK 内部逐请求的端点策略执行，以及把 workspace 不可覆盖语义推广到整个 `modelProviders` 映射（见“开放问题”）。

## 问题

在此 PR 之前，尚不存在任何托管端点策略：出站端点通过另一条路径（`resolveCliGenerationConfig` → `resolveModelConfig`）解析，没有操作员的端点白名单可查，因此托管部署仍可能通过 `--model`、`--openaiBaseUrl`、环境变量、`security.auth` 或凭据的 preserve/capture 路径拨向任意端点。本 PR 的第一次迭代加入了只在注册阶段过滤的白名单，以下缺口即在该迭代上度量：workspace（受信仓库）可以替换操作员配置的白名单；非数组值会以裸 `TypeError` 崩溃启动；退化条目（例如 `"https://"`）会静默匹配所有 HTTPS URL；qwen-oauth 空列表 pin 会被任何 scope 生效且无警告；advisor-model 错误从不点名责任设置项，还把原始选择器（含凭据）插值进 stderr。

## 匹配语义

匹配基于 `new URL()` 的 URL 语义：

- Scheme 和 host 不区分大小写比较；path 区分大小写。
- 显式默认端口视为不存在：`https://corp.example:443/v1` 匹配条目 `https://corp.example`。非默认端口（`:8443`）必须精确匹配。
- Path 按路径边界做前缀匹配：条目 `https://corp.example` 匹配 `https://corp.example/v1`，但不匹配 `https://corp.example.evil.com`（不同 host），也不匹配仅字符串前缀相同的兄弟路径。尾部斜杠两侧都忽略。
- 两侧都必须能解析为带 host 的 URL：退化值（不是 URL 或无 host）不匹配任何东西 —— 一条畸形条目绝不可能把控制放宽成 fail-open。
- query 与 fragment 在两侧都被忽略。带 query/fragment 的条目会被保留（加载时给出警告），只按 scheme、host 与 path 匹配，因此 `https://corp.example/v1?tenant=acme` 放行 `https://corp.example/v1` 下的所有端点 —— 应按路径而不是按 query 收窄。
- 没有显式 `baseUrl` 的模型按其协议默认端点（SDK 实际会拨向的端点）判定。空列表拦截一切（fail closed）；`undefined` 表示无策略。

## 执行点

同一个谓词（`isBaseUrlAllowed`）在出站模型端点生效的每个位置执行：

1. **注册** — `ModelRegistry` 在注册时丢弃白名单外的模型（选择器/`--model` 列表只提供允许的端点），并记录每个被丢弃项（`getAllowlistDroppedModels`）。daemon 的模型配置列表（GET /workspace/models）读取各 scope 的原始 `modelProviders`，不受注册表过滤，因此仍可能列出白名单外的端点；设置写入路由对这些写入执行门控，因此来自 Web Shell 的白名单外 `advisorModel`/`imageModel` 选择器（带端点、空后缀或裸形态）都无法被持久化（策略拒绝以 400 返回并携带原因）。
2. **解析** — 当有效端点（显式 `baseUrl`，未设置时为协议默认端点）不在白名单内时，`resolveModelConfig` 抛出点名 `model.allowedBaseUrls` 的 `FatalConfigError`。这堵住了 `--model`/`--openaiBaseUrl`/env/`security.auth` 的旁路。`qwen batch` 判定的是它实际拨向的端点（未解析出 `baseUrl` 时回退的 DashScope 端点），而不是 resolver 的协议默认端点。
3. **凭据恢复/捕获** — `ModelsConfig`（`syncAfterAuthRefresh` 的 preserve 分支、`detectAndCaptureRuntimeModel`）拒绝白名单外的端点，使已存凭据无法重新放行注册表从未注册的端点。
4. **兄弟 `ModelsConfig` 站点** — voice 模型源、daemon voice 配置、workspace provider 状态与设置写入路由都由同一个策略对象（`readModelPolicyOptions`：白名单连同其仅工作区豁免与操作员内置模型禁用开关）构建注册表；每个持有工作区设置的 `loadCliConfig` 调用方（交互式、ACP）都传递仅工作区豁免，因此任何站点都不可能只传白名单而遗漏其余部分。provider 安装冲突探测接收白名单（`undefined` = 无策略；绝不强转为 `[]`）。
5. **Live Voice** — 实时 wss 路径读原始配置、从不接触注册表，因此对最终端点应用策略（wss 按其 HTTPS 形式判定）。被拒绝的路由直接抛错，不能回落到 free-standing `liveVoice.endpoint`；Live 设置状态卡对被拒绝的 free-standing 端点给出同样的提示。现有 DashScope 主机校验作为附加控制保留。

## 输入校验

- `model.allowedBaseUrls` 必须是数组。非数组值是点名该键的启动期 `FatalConfigError`（CLI 在构造前校验；注册表也防御性地 fail closed）。
- 条目必须是非空字符串且可解析为带 hostname 的 URL。非字符串、空值、无法解析、无 hostname 的条目（例如 `"https://"`）会被警告并跳过 —— 退化条目绝不可能变成匹配一切的通配。
- 带 query 或 fragment 的条目不会被拒绝：它被保留并给出警告，因为其 host 与 path 仍然约束着控制（见“匹配语义”）。
- 列表在启动时冻结：模型 reload 重新应用启动时的列表 —— 白名单根本不是 `reloadModels` 的参数（与 reload API 可以替换的 `providerProtocol` 映射不同），因此会话中途修改策略只在重启后生效。

## Scope 优先级与禁用内置 Qwen OAuth 模型

- System scope 优先于 user；**workspace-scope 的列表只有在 User、System、SystemDefaults 均未定义时才生效**（该设置在 `WORKSPACE_NON_OVERRIDING_SETTINGS` 中，与 `security.allowedHttpHookUrls` 同一机制），workspace 值被剥离时发出警告。
- 内置 Qwen OAuth 模型是硬编码的。只能通过**操作员 scope 设置 `model.qwenOAuthBuiltinsDisabled`** 禁用（在 System、User、SystemDefaults 配置中设为 `true`；`false`/缺省保留内置模型）。已退役的 pin —— 把某个经生效 `providerProtocol` 映射解析到 `qwen-oauth` 的 provider id 的模型列表显式置空 —— 现已失效：`[]` 只表示"没有列出模型"，且配置迁移与 provider 删除路径都会在没有操作员意图的情况下合成 `[]`，因此它不能再兼作禁用开关。workspace-scope 尝试设置新键会在合并时剥离并发出警告（仓库不得替其用户禁用个人 Qwen 登录），操作员 scope 中设置的键在加载时产生点名该 scope 的警告。
- 键设置后，Qwen OAuth 解析以 `FatalConfigError` fail closed，而不是回落到默认内置模型，因此 `--model` 和持久化的 `model.name` 无法重新放行动态端点。
- 注意：**操作员 scope** 的 `model.allowedBaseUrls` 也会禁用内置 Qwen OAuth 模型，因为其端点在登录时动态发现、无法列入白名单（仅 workspace 的列表不会 —— 内置模型豁免 workspace 级策略）。需要个人 Qwen 登录的部署既不应设置操作员白名单，也不应设置 `model.qwenOAuthBuiltinsDisabled`。

## Advisor-model 诊断

当白名单是 advisor 模型不可用的原因时（端点不在名单内，或模型被注册表丢弃），advisor-model 启动错误会点名 `model.allowedBaseUrls`；选择器用于展示时会被脱敏：endpoint-qualified 选择器（`modelId\0baseUrl`）以剥离凭据的形式展示，绝不原样输出。被丢弃项按路由匹配（模型 id、auth type、被判定的端点 —— 记录中已做凭据清洗）：路由已在允许端点上注册的选择器绝不会被报告为已丢弃，即使同一 id 在另一端点上被丢弃。同一规则也让 `/advisor <model>` 拒绝被丢弃的模型（即使它是当前运行时模型），因此会话无法持久化一个会让下次启动失败的选择器。所有白名单外端点的回显（resolver 错误、注册表丢弃警告与记录）都以 fail-closed 方式清洗凭据：只有可解析的 http(s) URL 会被回显（剥离 userinfo），其他任何形态都会屏蔽其 userinfo 形前缀。

## 验证计划与验收标准

- 每个执行点都有单元测试/行为测试，且各自配有一个命名 mutant，使其在变异后转红：默认端口匹配、退化条目跳过、非数组启动错误、workspace 列表不可覆盖、workspace-scope 键剥离、仅 workspace 列表时内置模型豁免、qwen-oauth `--model`/持久化名称 fail closed、带协议默认端的解析门、Live Voice 路由门、advisor 消息内容、以及 `loadCliConfig` → `Config` → `ModelsConfig` 交接。
- 按仓库测试策略在 Docker 中运行全部受影响套件（core + CLI 的 `tsc`/eslint/vitest）。

## 开放问题与后续工作

- **动态 Qwen OAuth 端点**：任何白名单都会禁用内置 Qwen OAuth 模型（动态端点无法列入）。此行为已记录、未改动；让内置模型可被白名单覆盖是另一个独立设计决策。
- **推广 workspace 不可覆盖**：受信 workspace 仍可用空列表（或其他列表）替换非 qwen-oauth provider id 的非空操作员 `modelProviders` 列表。把操作员专属剥离推广到所有 provider id 是行为影响更大的后续工作。
- **workspace 提供的端点**：解析门自身创建了一条 workspace 通道 —— 受信仓库可以提供门所判定的端点（`security.auth.baseUrl`，或经 `model.name` 选中的带 `baseUrl` 的 `modelProviders` 条目）。白名单约束这类端点可以是什么，但在名单之内选择端点仍是仓库的权力。
- Live Voice 路径还额外把端点限制在 DashScope 主机；托管部署若想要非 DashScope 实时端点，需要单独的设计决策。
