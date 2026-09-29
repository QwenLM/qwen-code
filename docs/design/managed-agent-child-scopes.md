# Managed 子任务执行与持久文件历史

状态：2026-09-09，本阶段实现及下列 macOS 验收已完成；daemon 默认入口尚未切换。代码基线为 `174e072ac4`，本文件随其后续实现提交。完整迁移目标见 [daemon 默认替换方案](managed-agent-daemon-default.md)，工具调用契约见 [Runtime invocation v2](managed-agent-runtime-invocations.md)。

2026-09-10 三层设计调整：逻辑父/子 Session、历史与结果归 Session authority；完整父/子模型编排归 Harness；实际工具、独立读取缓存与原父文件历史 owner 归 Runtime。coordinator 保留稳定 binding 和清理责任，接管不重新生成原 Runtime ID。详见[Harness](managed-agent-harness.md)、[私有协议](managed-agent-control-protocol.md)和[coordinator](managed-agent-coordinator.md)。下文 Gateway 表述及冷恢复生成新 UUID 是既有终结后重建行为，不能套用到未决原调用的 Harness 接管；新可恢复 child/后台能力仍按后续范围验收。

## 目标与实际入口

父 Agent 只调用 Agent 工具时，子任务也必须能通过独立 Runtime 读写文件。Harness 继续负责模型、权限交互和最终回复，通过 Session client 提交对话；每个实际子任务有自己的执行 Session、读取缓存和关闭责任，文件历史仍归属持久的父会话。

独立作用域已接入 AgentTool 的前台、后台和 fork、后台 cold resume、InProcessBackend、带工具的 runForkedAgent（包括自动记忆），以及 SubagentManager 的直接调用。先建立作用域，再重建绑定工具的 registry。权限、模型等配置 overlay 继承所属作用域；调用者已经提供作用域时不重复分配。热继续沿用作用域，冷恢复或 respawn 在旧资源清理成功后使用新 UUID。本文的真实进程验收范围见后表，其余入口另有定向单元测试，不能把两者混为同一种证据。

## 执行身份与文件历史

一个持久父 Session 对应一个 Runtime 文件历史 owner。owner 使用原 FileHistoryService，并以 Gateway 父 Session ID 作为备份目录身份；Runtime 的临时执行 UUID 和 outputRoot 不成为备份身份。实际备份仍位于可信 QWEN_HOME 下的 `file-history/<父 Session ID>`，不创建第二套备份存储。

每个子 Runtime 保持独立 cwd 和 FileReadCache；不同 cwd 的执行 Config 引用同一个父 FileHistoryService，不能改写其 cwd 或恢复索引。父先读过文件并不赋予子任务 prior-read 记录。

沿用普通 daemon 的最新父快照语义：父 P1 启动后台任务，父 P2 开始后子任务才编辑文件，该修改归入 P2。子任务自己的模型 prompt 不创建额外父快照，也不把所有编辑固定在启动轮次。现有 Shell 仅特定编辑路径参与文件历史，本文不新增任意 Shell 写入都可回滚的承诺。

当前 owner 将实际工具执行和 checkpoint 放入同一队列，工具真正启动前再次检查取消与身份。这样能确定快照和编辑的先后；长前台 Shell 也会阻塞同 owner 的其他工具及 checkpoint。普通 daemon 的并发和吞吐等价性仍需后续验证，不能由本阶段的读写验收推断。

## 父轮次与持久化

ACP Session 和 Core 主循环的实际用户轮次入口统一调用 Config.makeFileHistorySnapshot。尚无 Runtime、历史中也没有已跟踪文件时，Gateway 只记录空父快照，不激活 worker。已有 Runtime 或文件历史时，父轮次发送真实 checkpoint；模型可并行开始，后续工具等待该 checkpoint。

首次子工具调用先绑定父 history owner，再取得独立子执行 Session。父绑定从当前 Gateway Config 的真实恢复历史生成；子绑定引用父 owner 并携带空 snapshots，不能覆盖父索引。

Runtime 通过单调 revision 回传快照。Gateway 原 ChatRecordingService 串行等待严格批写 ACK，成功后才更新本地镜像和已接受 revision；失败可重试，旧 revision 不能覆盖新状态。执行、状态查询、取消和关闭都会同步历史。Runtime 不取得父 JSONL 的第二个 writer。失败 checkpoint 保留顺序屏障，后续工具不能绕过它继续执行。

历史 bind/state 的限额为 8 MiB，普通工具输入限额保持原值。超过该额度的旧会话、全量历史同步成本及分页或增量方案尚待完成，不能把当前有限传输能力当作完整旧会话兼容承诺。

## 私有接口与关闭

新增 v2 `bind-history`、`checkpoint`、`history`，贯通 Bridge、Local/Remote/AutoLocal Provider、owned worker 路由和真实 HTTP 白名单。它们属于 owned worker 内解析后的 workspace/live Session owner，保留 tenant、canonical cwd、Session、lease、epoch 和可信父进程校验。bind/checkpoint 只允许活动绑定；history 可在 draining 阶段读取当前状态。只有父 Runtime 可以推进父 checkpoint。

父关闭先封锁子任务准入，取消并等待后代及已启动工作，再同步索引、终结释放 Runtime，最后运行登记的 Gateway registry、Hook 和 writer 清理回调。等待的是实际执行 Promise，不包含会反过来等待同一 close 的 finally。失败资源和回调继续归父会话所有，后续关闭可以重试；取消 ACK 本身不构成排空证据。

普通非 managed 路径保持原清理时序。审查发现的前台任务等待异步 MCP 清理、从而延迟结果和 AUTO 权限恢复的问题已修复，并保留红绿回归。

## 验证结果

完整 build、bundle、typecheck（含 integration）、变更文件 lint/格式检查通过。本阶段去重为 23 个文件、2,191 项定向测试通过；两个筛选文件另有 1,203 项未运行，非全仓套件。审查采用 Codex 人工代码与实际消费者核对，不声称通过 Qwen 私有 review harness。

真实验收使用完整 Gateway ACP host、真实 Agent/Memory 入口、独立 owned worker 和本地确定性模型服务；只由模型夹具控制工具选择，工具、文件、历史和进程均走实际实现。五组共用相同的 42 个基础构建摘要；Memory 组补充至 50 个，恢复组补充至 49 个，均验证前后不变。

| 组                      | 实际结果                                                                                                                                                                              | 证据目录后缀                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| A：父未使用文件工具     | 父只调用 Agent；子首次取得 Runtime，Read/Write 成功，父返回正式最终回复；仅一个父快照                                                                                                 | `child-fixed-1788907112993`        |
| B：父子读取隔离         | 父 Read 后子直接覆盖被 prior-read 拒绝，现场仍为 V0；子自己 Read 后写为 V1，磁盘备份为 V0                                                                                             | `child-prior-read-1788907147164`   |
| C：后台跨父轮次         | P1 已结束、P2 checkpoint 返回后，后台子连续写入 V1/V2；两次都归 P2，保留同一份 V0 备份，始终只有两个父快照；真实后台任务完成并通知                                                    | `child-background-1788907482733`   |
| D：默认自动记忆真实写入 | 实际用户轮次触发 extractor；通过子 Runtime 读取已有索引、写项目记忆和索引，任务 completed、touchedTopics 包含 project、游标推进并排空；文件位于 Gateway 原 trusted 根                 | `child-memory-write-1788907943261` |
| E：关闭与冷加载         | 旧 Bridge/worker 真正退出且旧 outputRoot 删除后，真实 loadSession 加载同一逻辑会话；新 Runtime UUID/租约恢复父 JSONL 的快照，子工具实际读到旧 V0 备份和当前 V1 文件，没有重放旧 Write | `child-restore-1788908406093`      |

证据位于 `.qwen/e2e-tests/managed-agent-child-scopes-evidence/`，汇总与过程报告位于同目录上一级的 `managed-agent-child-scopes-validation.json` 和 `managed-agent-child-scopes.md`。每组均核对真实 terminal v2 release、Config shutdown、自有进程退出、端口释放及临时目录删除；恢复组覆盖两代 worker。没有依赖兜底强杀取得通过结果，也没有访问或重启当前 4170 预览。

最初 unbound child 的真实失败已保留。另保留 external-v1 夹具失败：现有外部 guard 要求 invocation context，隐藏子 Agent 按既有设计不携带该 context，因此被拒绝。上述五组采用现有 builtin guard，不能据此声明 external-v1 子任务已兼容。Memory taskType 和 JSON undefined 等测试夹具修正亦保留原始失败记录。

## 剩余工作

本阶段没有迁移 Gateway 的物理 snapshots/diff/rewind、分支备份复制和删除；E 仅证明真实 cold load、索引与备份可达，不证明回滚或分支完成。自动记忆的 scaffold、索引重建等既有文件操作仍在 Gateway；D 只证明工具写入的身份、原路径和完成结果，未覆盖 USER/team memory、Dream 或全部越界规则。

2026-09-10 状态校正：Glob/可选 LS、Grep、NotebookEdit、媒体 M1 与 PDF 物理取消已有后续专项实现及限定验收；完整清单见[默认替换总方案](managed-agent-daemon-default.md)。子作用域仍需实际验证 cold background resume、不同 cwd 的完整组合、并发长 Shell、external-v1 guard、USER/team memory/Dream/scaffold/index，以及后台 Shell/PTY/TaskStop 和 Git/物理历史等未覆盖边界。当前先按[全局架构](managed-agent-session-harness-runtime.md)设计并实现 Session/Harness/Runtime 拆分，再完成有效配置与四处普通入口（三处 workspace factory 加自有嵌入入口）的兼容接线及有限启用；MCP/Skills/Hooks 和其余完整迁移按后续阶段推进。既有五组验收不证明这些剩余项或普通默认切换完成。

## 全量子任务与后台恢复

[自动任务专项](managed-agent-automation.md)补齐 childRunId、父接受/消费、后台 Shell/PTY/Monitor、Goal/Live 和 Memory 的领域提交与恢复；[工具与历史专项](managed-agent-tools-history.md)定义 worktree、备份及历史资源归属；[恢复与运行专项](managed-agent-recovery-operations.md)规定持久原调用账本。现有同进程子作用域与局部取消验收不代表这些增强已经完成。
