# Managed 扩展进程验收

[English](2026-10-16-managed-extension-acceptance.md) | [简体中文](2026-10-16-managed-extension-acceptance.zh-CN.md)

状态：已实现；聚焦 Linux/MySQL 集成类已在本地通过，两条用例、零跳过。这是受控模型下的进程验收，不是生产验收。

## 问题与当前状态

PR #14319 将已发布的静态 Skill、MCP server pin 和独立 Hook catalog pin 接入 Managed Session。其打包进程检查覆盖 Skill 历史与恢复，但尚未建立 Linux 上真实 MCP/Hook 执行的证据。配置准入和模拟 Runtime 响应无法证明执行、不重放或清理。

## 建议的验收门禁

在现有 `hosted-harness-mysql` profile 中增加 Linux `HostedExtensionsIT`。通过公开 AgentDefinition 和 Session API，运行真实 Spring 控制面、SQL Session Store 与内嵌 Runtime Broker。Hosted Harness 和原生 Workspace worker 均使用打包 CLI。确定性的本地模型选择工具；真实 stdio MCP 子进程和 command Hook 在选定 Workspace 中执行。现有 Hosted CI 已为进程门禁委派 cgroup v2 子树。

测试独占唯一的 tenant、Workspace 根目录、manifest、证据文件、进程及 Hook cgroup 子树。管理员 manifest 选择测试程序；公开定义仅包含不可变 pin。fixture 为其配方计算摘要并使用匹配的公开 pin；不声称 Runtime 会独立重新计算配方摘要。

## 场景与证据

| 场景                    | 必需证据                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill 与 MCP 执行       | 模型请求声明已保存的 Skill 与 MCP 工具；Skill 响应包含精确的已发布正文；真实 MCP 进程记录选定 Workspace 的 cwd，并产生一次真实追加。                                |
| Hook 决策               | command Hook 记录实际 PID、输入及 cwd；allow 到达 MCP 进程，deny 不产生 MCP 执行。                                                                                  |
| 配置固定与 Harness 替换 | 发布新版定义，kill 原 Harness，以新 home 启动替代实例后继续原 Session；仍使用原 Skill 字节和扩展修订。                                                              |
| 取消                    | 阻塞一个带存活后代的 command Hook，经公开 API 取消，核对真实进程退出、没有 MCP 副作用，且后续可安全使用。                                                           |
| 关闭                    | 为 MCP profile 启用 lifecycle v2 后完成公开 close；核对终态 operation、原 MCP 和 worker 进程退出，以及 Hook unit 为空。                                             |
| 不确定结果              | 真实 MCP 进程在 fsync 副作用后、尚未回包时退出，保留原 worker 和 SQL 并替换 Harness；恢复必须拒绝自动重放，副作用次数保持一次，且不得在缺少结算证据时报告关闭成功。 |

联合使用 SQL 记录、模型消息、进程追加证据以及操作系统进程/cgroup 观测。公开状态本身不能证明物理清理。测试最终清理与产品 close 断言分开，避免强制收尾掩盖产品生命周期失败。

中断中的 MCP 故障分组省略可选 Hook catalog，以验证普通工具 takeover；当前在途 Hook Session 会拒绝 takeover。正常冷加载分组保留全部三种扩展。动态 MCP 工具调用使用普通 `ma_tool_execution` 账本，而不是独立的 MCP 控制操作 domain。将其 Harness prompt 身份连接到公开 Turn，要求替换前后仍为同一 `UNKNOWN` execution，没有已结算结果或第二次执行。必须观察替代 Harness 实际 load 被拒绝，并出现 `hosted_turn_recovery_required` 与 `runtime_broker_execution_unknown`；公开 Turn 保持 `RUNNING`，新输入和关闭均返回 `409 turn_active`。不能假定无法结算的已准入 Turn 会变成 `FAILED`。

## 范围与实现

变更仅包括验收 fixture 和验证说明。未确认产品源码缺陷，也无需修改生产代码。不新增公开协议、工具 profile、准入默认值、凭据 API 或 Runtime provider。复用当前 publisher、connector 和执行协议，保留显式 `hosted-workspace-mcp/1` allowlist 与生命周期协商。

文件包括独立 Java 集成测试、测试资源目录中的小型 MCP/Hook 进程 fixture、验证说明及本中英文设计。现有 `Hosted*IT` 发现规则会收集新增类，无需增加 CI job。在强制测试收尾之前，将模型请求、进程证据、实际写入、Harness 日志和选定 SQL 记录保留到 `target/failsafe-reports/hosted-extension-evidence/`，现有报告上传会同时保留成功和失败用例的证据。未实现的 MCP 方法返回 JSON-RPC `-32601`，不会使测试进程直接退出。

## 验证与边界

在隔离 home 中 dry-run 全局安装 CLI，记录精确版本及能力差异。候选版本执行根目录 build/typecheck/bundle、聚焦 Linux MySQL 集成类、Java 验证及连续两轮干净 diff 自审。独立测试工程师核验进程证据；独立审查核验门禁及负向对照。

门禁使用受控模型、同一 Linux 主机上的本地 stdio MCP server。不证明真实上游模型行为、生产凭据、远端 HTTP/SSE MCP transport、物理主机重启、跨机器恢复、SSH MCP/Hook 支持或生产验收。缺少前提必须可见；跳过测试不等于 Linux 门禁通过。

## 开放问题

本验收范围内暂无。变更预期前先记录观察到的不支持恢复或生命周期边界；不得为了绿色结果降低安全断言。
