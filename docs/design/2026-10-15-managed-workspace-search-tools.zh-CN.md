# Managed Workspace 搜索工具

[English](2026-10-15-managed-workspace-search-tools.md) | [简体中文](2026-10-15-managed-workspace-search-tools.zh-CN.md)

## 状态与范围

本设计为公开 API 和 WebShell 的 Workspace Session 扩展 `glob`、`grep_search` 和 `list_directory`。基线为 `a0e6678d66`。Web Fetch 和 Web Search 不在范围内。实现及本地验证不代表生产发布验收。

在上述基线上，`/2` profile 已有受限 glob 执行，Runtime worker 尚未注册 grep 和目录列表。普通 grep 后备实现及目录列表不能直接注册：它们缺少所需的 Session 目录边界、取消和资源上限。若干 Hosted 恢复与生命周期读点也只识别原文件 profile 或原工具名称。

## Profile 与准入

新增 `hosted-workspace-files/3` 和 `hosted-workspace-shell/3`。Files/3 包含 Read、Write、Edit、Glob、Grep 和目录列表。Shell/3 在现有 Shell 工具集合上增加相同的只读工具，保留现有前台、后台、Monitor、审批和公开生命周期准入规则。`/1` 与 `/2` 的工具集合保持不变。

`QWEN_MANAGED_AGENT_WORKSPACE_SEARCH_ENABLED` 默认为 `false`。对于内置 `qwen-code` 新建的 Workspace Session，开启后根据原 Shell 开关选择 files/3 或 shell/3；否则保留当前创建逻辑。开关不改变已有 Session，包括幂等重试、加载、后续 Turn 和恢复。已保存的 AgentDefinition 仍通过原部署 allowlist 选择一个 profile，此开关不覆盖其定义。

使用原 Session 列与定义资源保存所选 profile。不新增数据库迁移、公开请求字段或路由。创建、加载、checkpoint 恢复、审批 continuation、Workspace 迁移和生命周期消费者必须显式识别新 profile。Files/3 继承文件生命周期；Shell/3 保留当前公开 Shell 的生命周期限制。不支持的 profile 必须拒绝，不能降级到 Legacy 或更弱 profile。

## 工具契约

| 工具             | 参数与行为                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glob`           | 现有 `pattern` 与可选 `path`；保留当前语义。                                                                                                                                            |
| `grep_search`    | 必填 `pattern`；可选 `path`（文件或目录）、`glob`、`limit`。默认上限 200，最大 1000。正则与大小写处理沿用 Core RipGrep。`glob` 是 rg 文件过滤器，支持排除和大括号分支，不是第二搜索根。 |
| `list_directory` | 可选 `path`，默认保存的 Session 目录。仅列直接子项。最多收集 1000 项，对收集项按目录优先、名称排序，最多展示 100 项。显式报告扫描和展示截断。不开放绕过 ignore 的参数。                 |

所有模型可见路径均相对于保存的 Session 目录。Harness 在获取 Runtime 前拒绝绝对路径与 `..` 遍历；worker 独立解析路径，拒绝真实位置越界，并执行现有安装目录 ownership 检查。搜索根若覆盖其他已安装 Session 的私有子目录，则在扫描前统一拒绝，不受匹配模式或过滤器影响；调用方可以将路径缩小到无归属冲突的目录。Grep 不跟随软链接；目录列表可以展示链接名称，但不检查其目标。展示切片前校验全部收集结果路径，覆盖嵌套和兄弟 Session ownership。不将此能力宣称为新的 OS 沙箱或跨 worker 保密边界。

Grep 格式化只修改结构化结果路径，不替换匹配正文中的目录字符串。搜索命中不满足完整 read-before-write 检查，不新增持久化文件已读缓存。对应 search profile 的原生工具在 default/auto-edit 下预批准，该许可不能授权同名 MCP 工具。

## Runtime 执行与持久结果

复用 Core GlobTool、RipGrepTool 和 LSTool，并传入显式的内部 Managed 限制；普通 CLI 调用保留当前行为。Grep 仅使用随包 rg，带 `--no-config` 和 `--no-follow`，不经过 shell 拼接，不调用系统 grep、Git grep 或 JS 正则后备实现。缺少 rg 时明确返回工具失败。

每次操作具有五秒执行期限。Grep 取消或超时必须停止并等待真实子进程退出。目录枚举沿用 Glob 的可终止 worker 方式，不允许仅返回超时而继续扫描。报告已知取消或失败前，必须释放目录句柄和子进程。

Grep 原始输出上限为 1 MiB，超限失败并提示缩小范围，不能声称没有匹配。worker 编码结果连同状态元数据限制在 48 KiB。所有权路径保留在内部，在展示截断前完成校验，不进入 worker 响应。Harness 继续按实际 UTF-8/JSON 编码检查原有 64 KiB outcome 资源与完整工具消息预算。保留可用前缀并明确标记截断，保留原执行状态；字节上限覆盖长行、特殊文件名和多字节内容。

沿用现有 Harness → Broker → 所选 Runtime 的 prepare/dispatch/status/cancel/result 链路。扩展原生只读、审批 continuation 与 replay 名单，以及新工具结果裁剪。持久结果提交后才能继续推理。丢失 dispatch 响应后只观察原执行身份，不能通过重新搜索完成恢复。未知结果与持久写入失败继续阻塞。模型主动发起的新调用仍正常执行。

## 验证与发布

按两个可审查切片实施：受控 Core/Runtime 执行，然后接通 Hosted profile 与公开准入。同步维护本中英文设计，并将 E2E 计划与结果保存在 `.qwen/e2e-tests/managed-workspace-search-tools.md`。

验证目录和单文件 grep、过滤器、无效正则、空结果、ignore、软链接、目录逃逸、兄弟和嵌套 Session ownership、含其他 Session 私有子目录的根目录，以及可见切片之外的私有匹配。覆盖大目录、长行和多字节输出、各字节上限、执行中取消、超时清理及之后成功调用。匹配正文包含物理根目录字符串时保持原文。

覆盖公开 API 与 WebShell 创建、后续 Turn、展示、取消、冷恢复、丢失响应恢复和文件生命周期。验证开关开启和关闭时的新建、`/1`、`/2`、`/3` Session 不可变、AgentDefinition 选择，以及原生与 MCP 审批隔离。执行相关 Core/CLI/Java 测试、build、typecheck、bundle 和 Checkstyle。先对全局 `qwen` 做基线验证，区分前置条件不可用和功能失败。

先升级 Java、Harness 及所有 worker/provisioner，验证随包 rg，排空旧 worker 后再启用开关。与 `/2` 相同，当前 worker capability 身份无法证明搜索支持，公开链路探针成功是运维发布门禁。关闭开关只影响内置 Agent 新会话，必须继续用兼容版本服务已有 `/3` Session。真实 MySQL 和部署验收必须与本地测试证据分别报告。
