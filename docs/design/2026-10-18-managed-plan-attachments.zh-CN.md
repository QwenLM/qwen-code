# Managed 会话 Plan 模式与输入附件

[English](2026-10-18-managed-plan-attachments.md) | [简体中文](2026-10-18-managed-plan-attachments.zh-CN.md)

## 问题与范围

Managed Web Shell 目前禁用了输入框的附件与 Plan 控件。Java API 和私有 Hosted prompt 路由仅接收文本，单独打开界面控件仍会丢失附件内容或无法准入。Hosted 团队成员的规划协议用于向组长提交计划，不等于公开会话中由用户审批计划。

为新建和已有 Managed 会话补齐 Plan 与有大小限制的内联附件。复用共享输入框、现有 owner 与 Workspace 授权、不可变 Turn 输入、Action 决策和恢复机制。执行权限与 Plan 保持独立。不改变普通 DAC/CLI 规划、团队成员规划、AgentDefinition 身份，也不因添加附件就写入 Workspace 文件系统。

## 当前状态

Java 将归一化输入存入 `ma_turn.input_json`，对完整输入计算摘要，并生成用于记录回放的用户 Item。Hosted 将已接收的 prompt 与 admission 存为不可变资源。模型回放历史时使用持久消息 parts，但当前首轮 prompt 仍被展平为文本。单个资源与预备模型快照均受 64 KiB 内联上限约束。

会话权限选择已有 owner 授权、Workspace OPERATOR 权限、空闲与恢复屏障、幂等回执、CAS 修订号和逐 Turn 冻结的执行策略。原生文件工具审批已有持久 v3 continuation；普通 Shell、MCP 和 Hook 批次并非都能通过该格式恢复。

## Plan 状态与公开 API

新增迁移 `V10__session_plan_mode.sql`，不重写已发布迁移。新增默认 false 的 `ma_session.plan_enabled` 和用于不可变快照、允许为空的 `ma_turn.plan_enabled`。复用 `approval_revision`，统一标识执行权限与 Plan 状态。切换 Plan 递增修订号，并将当前执行模式写入 `selected_approval_mode`，保持既有选择约束。Turn 准入在原会话行锁内复制模式、修订号与 Plan。

在现有 Web Shell 权限查询、变更、摘要和创建契约中增加 `planMode`，另行返回 `planModeSupported`。变更请求省略该字段时保留当前 Plan。定义初始权限不变。切换复用 owner 加 OPERATOR 要求及空闲屏障；活动 Turn 或待审批期间不能手动切换。空闲时手动退出不批准任何计划。修改执行权限保留 Plan，也不会代答 Action。

Plan 仅覆盖已有权限选择能力的公开 Workspace profile：`hosted-workspace-files/1`、`hosted-workspace-shell/1` 和 `/2`，支持内置及已保存定义。本次不扩展 child、team、workflow、unbound、MCP、Hook profile；保留其既有行为。

## Hosted Plan 执行与审批

增加能力 `plan-mode/1`，在不可变私有权限选择中增加可选的 `planMode: true`。false 和旧 Turn 省略该字段，保持旧 wire 身份。Java 在派发或推进携带 Plan 的活动 Turn 前必须检查能力。缺失能力时拒绝执行，绝不把 Plan Turn 降为执行模式。

工具 Turn 从 admission 和本 Turn 已持久批准的公开 `exit_plan_mode` Action 推导 Plan 覆盖层。仅允许 `read_file`、profile 已有的 `glob`，以及独立的公开 `exit_plan_mode` 控制调用。写入、编辑、Shell 命令、后台任务、child/workflow/team/message/MCP/skill 副作用均在执行前拒绝，`yolo` 和 Hook allow 不得绕过。Plan 阻止的 profile 内工具返回只读拒绝；底层 profile 以外的工具保留现有保护并使 Turn 失败。两条路径均不产生效果，也不退出 Plan。模型指令说明限制。首版明确不对远程 Shell 命令做只读分类。

公开退出工具接收非空 Markdown 计划，且必须独占批次。即使执行权限为 `yolo` 也必须询问用户。本 Turn 初始为 Plan 时始终保留该工具的稳定声明。Action 批准后仅解除本 Turn 的覆盖层，后续调用仍使用冻结的执行模式。因此 `default` 写入仍可能再次询问，`yolo` 才免普通工具审批。拒绝、过期和取消不授予执行权。批准后重复退出只返回已经结束规划的提示。

仅为精确的单个公开 Plan 退出控制调用扩展 v3 原生 continuation 的捕获和校验，保留普通 Shell/MCP/Hook 批次的原有限制。保存精确输入、工具声明、assistant 批次、模型轮次、Action 和 Runtime generation。该控制调用必须跳过 Runtime reserve、prepare、intent 和 execute。恢复时继续原 Action 并写入其结果，不重新询问，也不从内存标志猜测授权。保留既有 Runtime 获取、清理与 fencing 要求。

Java 投影有效且已批准的公开 Plan Action 时，验证其输入与 Turn 关联、`plan_enabled` 快照以及匹配的权限修订号。在同一 SQL 事务中清除会话 Plan 并递增会话修订号，Turn 快照保持不变。无论文件或 Shell profile，公开 Plan 退出都要求记录的会话 owner 且当前具备 OPERATOR 权限。迟到或无关 Action 不能清除较新的选择。刷新和进程重启因此能观察到已经完成的状态转换。

## 附件契约与模型输入

扩展封闭的公开输入联合类型：`input_file` 包含 `name`、`mime_type`、UTF-8 `text`，`input_image` 包含 `mime_type` 和 base64 `data`。保留 `input_text` 与旧 `text` 行为。拒绝混用或未知字段、空附件、任意 URL、宿主机路径、二进制文件、非法 base64 和不匹配的图片签名。文本附件使用保守的文本 MIME/扩展名白名单，并拒绝 NUL。图片支持 PNG、JPEG（含 `image/jpg` 别名）、GIF 和 WebP，与普通 Qwen Code 的 `PIPELINE_IMAGE_MIME_TYPES` 保持一致。PDF、Office、音频和视频不在范围内。

在 Managed 输入框及草稿恢复、公开 OpenAPI 契约、Java 准入与 Hosted 解析中使用相同的图片格式。接受 `GIF87a` 和 `GIF89a` 两种签名，使用 JPEG 签名校验 `image/jpg`。构建持久化输入、模型 parts 以及恢复输入框缩略图时，将 JPEG 别名规范为 `image/jpeg`，与普通图片接入及下游模型、展示要求一致。摘要、重放和投影保留原始图片字节及规范 MIME。对齐普通模型输入链路，而非其更宽的文件识别列表；BMP、TIFF、HEIC 和 SVG 图片块仍不支持。无需转码或新增存储。依赖 GIF 或 `image/jpg` 前，同步部署 UI、Java 服务与 Harness；旧校验器会拒绝这些格式。

文件归一为带生成的非宿主 URI 的内联 ACP 文本资源，图片归一为 ACP image。语义摘要和 payload 摘要覆盖每个附件字节及名称、MIME。带附件请求的整份 canonical JSON 含文字最多 8 MiB，Java 与 Hosted 使用同一上限。Hosted 精确检查带附件的真实用户消息是否满足 9 MiB 预算，并使用既有消息分片保存。[附件容量设计](2026-10-18-managed-attachment-budget.zh-CN.md)定义专用输入、模型资源和浏览器持久化预算。普通资源保留既有上限，不增加上传服务或存储表，不自动截断或省略内容。

声明 `input-attachments/1`；非文本派发必须具备该能力，纯文本兼容旧 Harness。已接收的不可变输入转换为同一组模型 parts，用于用户消息、首次生成、Hook 和恢复。文本资源带明确文件名边界，图片转为 `inlineData`。Hook 修改用户文字时保留附件 parts。应用最终定义 pin/会话模型选择后检查图片支持，包括保留的图片历史；纯文本模型明确失败，不能收到“图片不支持”的占位内容。

用户 Item 通过既有 JSON attributes 和资源引用保留 canonical 附件元数据及内容。实时事件、记录分页、snapshot/resync 和刷新重建相同的文件/图片展示。添加附件不写入 Workspace；之后模型发起的工具调用仍受 Plan 与执行权限约束。

## 输入框与重试行为

Managed 输入框显式启用共享添加菜单、Plan 控件和附件接入。新建会话在首个 Turn 前确定 Plan；已有会话以后台状态为准，切换复用现有可持久化的权限变更状态机与读回。计划审批使用现有覆盖层隐藏输入框，展示已提交计划，并用冻结执行权限标注批准操作。

允许只有附件的提交。在构建幂等 pending 请求前完成 Blob 编码与大小、MIME、UTF-8 校验。完整 canonical 输入与请求 key、会话身份共同持久化；刷新和投递未知重试复用原快照，不重读 Blob。收到准入成功后才清理输入框；错误保留草稿，不静默丢附件。pending 数据按 provider、tenant、actor 和 Session 隔离，保留现有不确定性处理。

## 影响范围

- Web Shell Managed provider 类型、生成的 Java API 类型、输入框接线、创建/pending 请求状态、Action 展示与记录投影。
- Java API/OpenAPI、输入校验、权限选择、Turn 准入、Action 投影与授权、读模型和能力校验。
- 共享 schema V10，以及 Server/Broker 初始化与校验。
- Java SDK 私有权限选择和 Hosted 客户端能力检查。
- Hosted prompt 解析、模型 parts/能力校验、公开 Plan 工具限制和精确单控制调用 continuation 恢复。

## 发布与限制

Java Harness 客户端构造时会固定能力快照。如果已经协商到不支持的 generation，恢复能力后需要重启控制面以构造新客户端；被阻断的 Turn 不会自动探测或绕过缺失能力。启用 Plan 前，停止或隔离共享 catalog 的旧 Server/Broker 二进制。备份并在隔离环境验证后，再应用 V9 到 V10 的增量迁移。同步部署兼容 Java、SDK、Harness 和 UI。旧二进制不能安全操作已经开启 Plan 的 catalog。保留已有数据、Workspace 绑定、凭据和不可变定义身份。

8 MiB 是单次输入预算，不保证无限会话。预备模型请求还包含历史、工具与系统指令，仍可能超过 32 MiB 快照预算。此时保留既有明确的恢复限制，不宣称完整恢复，也不静默删历史。本次不包括大文件/对象存储、远程 Shell 分类、其他输入框操作、跨 profile 继承、Linux Hook/cgroup 认证或真实上游模型认证。

## 验证与验收标准

使用隔离 worktree、一次性 MySQL 8.4 数据库、独立端口与 Workspace，以及确定性的本地模型响应。不在用户实际 Session 做工具副作用测试，不重置实际数据库。先用全局 `qwen` dry-run E2E 计划，如实记录不支持的基线路径，再由 test-engineer 验证本地构建产物。

覆盖新建/已有内置及自定义会话、三种执行权限、Plan 读取与零副作用拒绝、批准/拒绝/取消/过期、过期 CAS 与回执重放、owner/grant 隔离、Plan Action 刷新，以及决策/结果前后的崩溃恢复。确认批准后仍遵循冻结权限，旧 Action 不会解除新 Plan；回归团队成员规划与原生审批。

覆盖文本/图片/纯文件输入、非法形状、MIME/编码/签名与大小边界、完整输入摘要冲突、旧能力拒绝、最终模型图片能力、Hook 文字更新、投递未知后的刷新、记录/snapshot/resync 及后续历史。验证 GIF87a/GIF89a 与 `image/jpg` 准入，重放、投影及模型输入中的字节与规范 MIME 精确保留，草稿恢复时规范化别名，并与普通链路的格式列表保持一致。拒绝签名不匹配或头部截断的 GIF、非法 base64 和不支持的图片格式。验证一个可恢复的小型预备请求，并单独记录原有快照上限。

运行受影响的 Java 单测、API/SurfaceRegistry 检查、SDK 测试、完整 Java 验证、真实 MySQL 和对应 Hosted 恢复 profile；运行根 build/typecheck/bundle、重点 CLI/Web Shell 单测、生成契约一致性、格式检查与两轮干净自审。更新本地部署前独立评审完整变更，明确报告不可用的验证通道。

## 未决问题

当前范围无未决问题。实施带来的修正必须先同步两种语言及 E2E 计划，再进行验证。
