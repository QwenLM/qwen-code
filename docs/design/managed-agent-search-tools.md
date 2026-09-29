# Managed 搜索工具：Glob 与可选 LS

状态：2026-09-09，基于 `aad95e62aa` 完成本阶段实现与 macOS 限定验收。属于 [daemon 默认替换](managed-agent-daemon-default.md) 的工具迁移步骤；本阶段不切换普通会话 factory。完整工具契约沿用 [Runtime invocation v2](managed-agent-runtime-invocations.md)，子执行与父文件历史沿用 [已有作用域](managed-agent-child-scopes.md)。

## 问题与目标

本阶段之前，完整 Gateway Config 只为 Read/Write/Edit/Shell 注册 RuntimeBackedTool。Glob 和 LS 回落本地 factory，并在 warmAll 构造真实工具；子任务重建 registry 时也会发生。搜索仍依赖 Gateway 的工作区文件系统，因此需要迁移到已有 Tool-only Runtime。

将 Glob 和显式启用的 LS 接入已有代理与实际 Runtime 内核，保持普通工具的 schema、描述、参数规范化、权限、结果及取消行为。没有工具的空会话不等待 Runtime；已有父文件历史 checkpoint 可以提前获取 Runtime 的既有例外继续适用。

## 实现边界

在现有 builtin-tool-definitions 提取两个工具的纯声明，由本地工具构造器和代理共用。声明生成只返回数据，不扫描目录、不调用文件服务，也不激活 Runtime。两工具目前沿用基类 AUTO 输入空串；代理保留该语义，不额外转发搜索参数。

在 createManagedBuiltinTool 加入 Glob/LS 分支；Config 的 disabled/deferred/eager 判定、bare 模式和 LS opt-in 条件保持不变。未显式启用的 LS 不因 Runtime 支持而出现在 Gateway 或 Runtime 的可用工具集合中。

createBuiltinManagedToolRuntime 的真实构造器集合加入 Glob/LS，仍以所属 Config registry 的实际工具构造器为准。独立 child toolConfig 使用自己的 cwd、WorkspaceContext、读取与文件发现服务；不能用父工具实例执行子调用。不同 cwd 的 owned toolConfig 派生现已传入所属 Config 的 customIgnoreFiles：普通 Agent 原已这样构建 FileDiscoveryService，本次补齐了 Runtime 派生此前漏传的配置。仅在 Glob execute 中传过滤选项不能补救服务初始化时丢失的自定义规则。实际 build、路径规范化、L3 权限、确认和执行留在 Runtime。Gateway 沿原两处调度器完成权限决策、preflight、guard、授权与结果投影。

在已有 file-history bind DTO 增加可选 executionContext；新 Gateway 总是发送每个实际 Config 的目录列表、记忆根、文件过滤选项及 LS 启用状态。保留目录顺序和显式空列表，不合并父目录；自定义 ignore 使用现有标准化规则。Runtime 严格解析并复制上下文，在同 cwd 时也派生独立工具视图、读取缓存和文件发现服务，文件历史仍共享既有 owner。工作目录和搜索目录检查真实规范路径；记忆根保持原有绝对词法路径语义，允许尚未创建，不通过 realpath 改变权限范围。

LS 可能只通过 Gateway 命令行 coreTools 启用。Runtime 视图接收实际 isLsToolEnabled，并在原 registry 未包含同名 eager/lazy 工具时，按 Runtime PermissionManager 的注册结果补入原生 LS factory。disabled 或权限检查失败不补注册；deferred 使用原有 deferred factory，disabledTools 和构造器身份校验继续有效。此布尔值不代表完整 CLI 配置快照；Gateway argv 与 Runtime settings.coreTools 冲突时仍拒绝，需要后续对齐有效配置。

上下文固定在 Session 绑定上并纳入摘要。Gateway 配置变化后，既有客户端拒绝继续 prepare/confirm/preflight/execute 等活动操作，仍允许状态查询、取消、历史同步和关闭。当前必须创建新绑定才能应用变化；同会话 add-dir/配置热更新的完整兼容仍待实现。旧调用方未提供上下文时保持原行为；旧严格 worker 不认识新字段时直接报错，不剥离字段重试或回落 Gateway 执行。

不新增 RPC 路由、认证方式或产品配置项；不放宽 manifest 摘要、Session/lease/generation 校验及关闭规则。共享父 history owner 的执行队列继续适用，新增搜索调用不改变 checkpoint 和关闭的顺序。

## 必须保持的行为

- Glob 未指定 path 时搜索原 WorkspaceContext 的所有目录；显式路径继续规范化、验证和按原规则申请外部目录权限。保留 git/qwen/custom ignore、去重、近期 mtime 排序、条数限制及不完整扫描提示。
- LS 仍要求绝对目录路径，保留路径反转义、显式 ignore、文件过滤选项、目录优先排序、截断和错误结果。原有工作区、skills、extensions、memory 根的权限规则在 Runtime 工具视图执行，workspace 和 memory 使用绑定的实际作用域，不用 Gateway 自动批准替代。
- Glob 沿现有 AbortSignal 停止遍历。LS 当前 fs 操作不消费信号；取消必须等待其真实操作结束，不能把早返回 ACK 当作排空。本阶段不顺带重写普通 LS 的取消契约。
- 子任务注册及执行使用自己的 Runtime Session；同一个父 history owner 的最新快照语义、索引持久化和终结释放保持。

## 验证与退出条件

设计 E2E 与前后证据写入 `.qwen/e2e-tests/managed-agent-search-tools.md`。实现前确认当前全局 CLI 与私有完整 host 接口的适用性，并用支持该入口的既有构建观察真实 Gateway 本地执行；实现后在隔离 HOME、QWEN_HOME、工作区、端口和可控模型服务中复验。不得访问或重启当前 4170 预览。

定向单元测试覆盖真实本地声明与代理一致、声明生成不等待 Runtime、不构造 Gateway 本地工具、默认 LS 不注册、显式与 deferred LS、子 Config 绑定和已有 Glob/LS 行为回归。运行完整 build、bundle、typecheck，以及变更文件 lint/格式检查。

真实验收需要通过完整 ACP host 的模型与父/子工具调用，观察独立 owned worker 实际命中文件、Gateway 两工具本地 build/execute 为零、结果返回原模型并正式结束。Core 调度与外路径权限、ignore/排序/错误/取消用相应真实工具链验证；测试可以选择既有审批选项，但不能以自动允许证明 ask/拒绝行为。逐组保存构建摘要和清理证据；没有实际覆盖的场景如实列为剩余项。

## 2026-09-09 验收结果

完整 build、bundle、typecheck、变更 ESLint/Prettier 与 diff 检查通过；定向去重 17 文件 322 项测试通过（Core 231、CLI 91，非全仓套件）。Glob/LS 的共享声明摘要与改动前原生工具一致。CLI 的旧 Config 替身补齐上下文接口后通过；另一次未改动的 release HTTP 测试出现 400/404 状态差异，完整文件复跑通过，首轮日志保留，未以修改产品绕过。

| 真实进程组                 | 已观察结果                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认 Glob                  | 父子真实模型共 5 次请求，两次 Glob 在独立 owned worker 成功；Gateway 本地 build/execute 为零，LS 在声明、registry 和 manifest 均未启用。                                                        |
| argv 显式 LS               | 7 次模型请求，父子各 Glob/LS 四次实际成功；仅 Gateway argv.coreTools 启用 LS，worker 按原权限规则注册。                                                                                         |
| worktree 与附加目录        | 实际 AgentTool.working_dir 使用注册 linked worktree；父默认 Glob 搜索 cwd 和 argv.includeDirectories，子只搜索自己的 worktree；子 Glob/LS 均尊重自定义 ignore。                                 |
| 记忆与外部路径权限         | 同一真实 Session 三个用户轮次：memory Glob/LS prepare=allow 并实际成功、正式结束；外部 Glob 和 LS 各自 prepare=ask，真实 reject_once 后 settled/not_started、无 execute，并按既有契约结束该轮。 |
| 既有子任务 prior-read 回归 | 父 Read 不授权子盲写；子实际 Write 返回 edit_requires_prior_read 且 V0 不变；子 Read 后 Write 成功成为 V1，备份仍为 V0，父子正式结束。                                                          |

权限组首个夹具错误地期待拒绝后模型继续回答；源码确认会话在 permission cancel 后结束当前轮次，改为上述三个真实轮次，未改产品或放宽权限断言。首红证据保留。各组均核对自有 worker/进程退出、端口释放、临时根删除及构建摘要稳定；没有访问或重启 4170。记录位于 `.qwen/e2e-tests/managed-agent-search-tools-build.json`、搜索验收目录和既有 child-scopes 验收目录。验收仅覆盖本机 macOS，Windows/Linux 未实测；运行中搜索取消、Core scheduler 专项组合、超大/截断/故障组合仍待补足，不能由准备阶段拒绝的 not_started 推断运行中取消已排空。

## 后续范围

本阶段不处理 Grep/RipGrep 后端选择和不同声明，也不处理 NotebookEdit、媒体、MCP/Skills/Hooks、后台进程/Git、物理 rewind/branch 或可信初始化快照。其余 Gateway 工作区 I/O、完整消费者兼容和共享 history owner 的并发限制仍需接通后才能切换 daemon 默认实现。搜索工具局部通过不构成完整替换完成。
