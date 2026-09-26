# W0d：WebShell 工作区选择与固定绑定

[English](managed-workspace-w0d-web-shell-binding.md) | [简体中文](managed-workspace-w0d-web-shell-binding.zh-CN.md)

## 状态与问题

W0b 已能在创建 Session 时保存经过授权的 Workspace 绑定，但已有鉴权的嵌入式 WebShell 宿主还无法发现 Workspace 或创建空的绑定 Session。Java 客户端在读取时丢弃绑定，并将没有 Turn 的 Session 当作运行中。W0d 开放元数据选择与固定绑定；消息执行仍未开放。

## 范围与决策

宿主通过 `enableWorkspaceBinding: true` 显式启用，并提供非空 `productScope`。tenant 或 actor 改变时，宿主必须更换此 scope。provider 的浏览器存储键包含服务地址、产品 scope、Agent ID 和功能版本；不会保存凭据。未启用的宿主保留现有先发送消息的流程。

新能力 `workspaceBinding` 仅表示服务支持发现、空会话创建和读取固定绑定。完整执行链路就绪之前，`workspaceContext` 仍为 `false`。客户端只有看到窄能力才允许创建；旧服务缺少能力时不会悄悄创建无绑定 Session。

## 发现接口契约

公共路由为 `GET /v1/agents/workspaces` 和 `GET /v1/agents/workspaces/{workspaceId}`。WebShell BFF 路由为 `POST /api/agent/web-shell/v1/workspaces/query` 和 `/workspaces/get`。两者共用服务与 Registry。公共字段使用 snake_case，BFF 字段使用 camelCase。列表返回 `data`、`hasMore`/`has_more`、`nextCursor`/`next_cursor`、`defaultWorkspace`/`default_workspace` 和两个能力标志。默认每页 50，允许范围为 1–100。

发现接口要求现有可信 `AuthenticatedTenantActor`；缺少 actor 返回 401，作用域不符返回 403。SQL 先按读取授权过滤再分页，并按 Workspace ID 的精确字节顺序排序。游标绑定 tenant 与 actor 的摘要、有效页大小和末项 ID；每页重新检查授权。单项查询对不可读或不存在的 ID 都返回 404。显式租户默认项独立于当前页返回，但必须可读、可创建且处于 `ACTIVE`。可读但无创建权或非 active 的条目仍可见，但不能选择。创建事务内仍会复查授权与状态。

响应只暴露逻辑 ID、展示名、状态和创建资格，并设置 `Cache-Control: no-store`。发现过程不解析物理存储、不访问文件系统，也不启动 Runtime。沿用现有 Registry、授权、默认项与创建回执表，无需迁移。

## 创建与展示流程

新建表单的相对目录初始为 `.`。刷新时保留仍有效的选择，否则使用服务端显式默认项；绝不隐式选择列表首项。不在当前页的已选项或默认项只展示一次，“加载更多”读取后续页。非根目录已经编辑时，切换 Workspace 需确认，并将目录重置为 `.`。相对目录原样提交，不 trim，也不 URL 解码；服务端沿用 W0a 的规范化和校验。表单说明同 Workspace 的 Session 共享文件，目录可用性在执行前检查。

创建复用现有 BFF Session create 命令，传入 `input: []` 和显式 `workspace`。空会话响应只要求 `sessionId`，不要求 `turnId`；先发送消息的 create 与 submit 命令仍要求 `turnId`。成功后客户端读取 Session，核对保存的 Workspace ID 与请求一致。展示的 Workspace ID 和规范化相对目录只取自服务端保存的 Session。缺少或不匹配绑定属于协议错误；已知 Session ID 保留以供再次读取。绑定 Session 使用静止的 `created` 阶段，禁用发送与取消，不显示 Turn 计时或环境准备提示。

## 重试与身份隔离

发送前，客户端立即在 `sessionStorage` 保存冻结请求：Agent ID、Workspace ID、原始相对目录、空 input、client ID 和幂等键。首次写入失败时不会发送创建请求。响应丢失后使用完全相同的请求重试。一旦返回 Session ID，客户端先保存它，此后只重试读取 Session。首次明确的 4xx 恢复编辑；发生结果不明的请求后，后续 4xx 不能证明原请求没有提交。用户可以明确放弃本地确认记录，界面提示原空会话可能仍存在；不会自动删除服务端记录。

tenant、actor 或 Agent 改变时，宿主 scope 或 provider 存储键随之变化，表单重新挂载、取消旧请求并忽略迟到响应。新 provider 发起请求前会清除旧的已选 Session ID；宿主新提供的 Session ID 仍可打开。同一身份下的凭据刷新保留待确认请求。普通未提交草稿和最近使用目录不持久化。

## 验证与边界

HTTP 与 SQL 测试覆盖鉴权、授权过滤先于分页、独立于当前页的默认项、精确 ID 匹配、物理路径不泄漏以及空会话创建。WebShell 测试覆盖静止状态、能力门控、固定请求重试及提交后只重试读取。浏览器验收应覆盖桌面与移动布局，并使用仅在测试代码中定义的 principal 适配器连接真实 Spring/SQL 路由。完整执行链路仍需 Hosted 工具编排、审批与历史结算、产品身份传递，以及 W0e 对重启、回收和旧写入者隔离的验证。W0d 不声称这些能力。

验收标准是用户选择有权使用的 Workspace 和相对目录，即使响应丢失也只创建一个空 Session，并看到服务端保存的固定绑定，且界面没有运行指示或执行控件。
