# Hook 执行记录 E2E 计划

[English](hook-execution-records-e2e.md) | [简体中文](hook-execution-records-e2e.zh-CN.md)

## 环境与基线

使用 macOS、Node.js >=22、独立临时工作区、QWEN_HOME、QWEN_RUNTIME_DIR、trusted-folders 文件和本地 OpenAI 兼容模拟服务器。在临时配置中关闭自动更新、后台记忆和定时任务。不使用个人配置、凭据或会话记录。每组结束后终止 daemon 和模拟服务器。

先执行 `qwen --version`、`qwen serve --help`，再启动 `qwen serve --no-web --workspace <temporary-workspace> --port <free-port>` 确认基线。完成 `npm run build && npm run typecheck && npm run bundle` 后用 `node dist/cli.js serve` 重复验证。已安装基线版本为 0.22.0：command Hook 能执行，但缺少 Hook 生命周期记录与查询接口。该版本还没有 turn-index，不将此差异视为当前 main 的回归。

配置真实 command Hook：从 stdin 读取 JSON，在隔离探针文件中每次追加一行事件／会话／prompt 身份，然后输出可控 JSON 或退出码。本地模型返回确定性流式结果；retry/continue 首次返回已结束的 HTTP 400 错误。始终区分 daemon admission ID 和用户记录的规范 promptId。

## 验收分组

| 分组       | 操作                                                                                                    | 预期                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 基础传输   | 新建会话、订阅 SSE，配置 UserPromptSubmit、MessageDisplay、Stop 后提问；检查 JSONL 与 Hook 接口。       | 实际执行三次、生命周期记录六条、唯一 UUID 三个；实时与持久化身份一致。                                                       |
| 结果状态   | 验证成功、exit-2／策略阻止、exit-1 错误、一秒超时、取消和异步 Hook。                                    | 各状态分开；成功交接异步任务为 dispatched，交接被拒为 error。派发耗时不计入执行耗时或成功次数。                              |
| 次数       | 并行 Hook、重叠 MessageDisplay 批次；三条串行 Hook 在第一条执行时取消；信号在开始前已取消。             | 只计实际开始，无 UUID 冲突或终态漏记；未开始的 Hook 不计数。                                                                 |
| 轮次身份   | retry:true、普通 continue，以及首次阻止的 Stop Hook。                                                   | 新 admission ID 仍归原历史 promptId；普通 continue 不重复 UserPromptSubmit。                                                 |
| 归属       | 多会话／工作区并发，Hook 运行中切换会话，以及子 Agent Hook。                                            | 开始／结束归属不变；子 Agent、无归属及会话生命周期 Hook 不进入主轮次汇总。                                                   |
| 恢复       | 重连、重启 daemon、冷会话查询、load，以及重复、乱序、end-only、start-only 重放。                        | 唯一次数与终态一致；start-only 为 unknown/partial；冷查询不启动会话。                                                        |
| 分支变化   | fork；遥测到达时删除轮次；自定义 /advisor 的 UserPromptExpansion 先于用户记录时回退；重启/load 后重复。 | fork 重映射身份；删除／回退记录及晚到结束事件不得重新出现。                                                                  |
| 分页       | 持久化 1,001 次执行，读取 50 条，再追加一次，使用原 snapshot 跟随 nextStart。                           | 旧快照每页均汇总 1,001 次；新快照看见追加执行；跨工作区 snapshot 和无 snapshot 的 start 被拒绝。                             |
| 安全与兼容 | 命令／环境／错误／阻止理由加入秘密哨兵；元数据输入现有聊天 normalizer 和文本重放。                      | 新记录／网络字段没有哨兵；无空白聊天行，模型历史／导出无诊断文本；旧轮次 unrecorded、托管历史 unsupported，summary 为 null。 |

同时验证 `GET /session/:id/turns/:promptId/hooks` 和 `GET /workspaces/:workspace/session/:id/turns/:promptId/hooks`。promptId 需 URL 编码。后续页携带返回的 `snapshot` 和 `nextStart`，比较全轮汇总。

reader 性能验证使用 1,000、5,000 和 10,000 次合成执行，测量首页和冻结页；再将目标轮次固定为一次执行，仅增加其他轮次的执行数。全程断言页内次数和汇总正确，记录耗时，不设置依赖硬件的测试阈值。确认目标轮次仍包含提问前 Hook、保留轮内冲突检测，并忽略其他轮次的执行身份。此类合成探针与真实命令 E2E 证据分开报告。

## 确定性回归命令

构建工作区依赖后，在各自包目录执行：

- Core：`npx vitest run src/telemetry/hook-lifecycle-contract.test.ts src/telemetry/hook-lifecycle.test.ts src/hooks/hook-execution-context.test.ts src/hooks/hookPlanner.test.ts src/hooks/hookEventHandler.test.ts src/services/session-hook-history.test.ts src/services/sessionService.test.ts src/services/chat-recording-message-deletion.test.ts src/services/chatRecordingService.test.ts src/services/session-turn-state.test.ts`。
- ACP bridge：`npx vitest run src/bridge.test.ts src/compactionEngine.test.ts src/execution-lifecycle.test.ts`。
- CLI：`npx vitest run src/acp-integration/session/Session.test.ts src/serve/multi-workspace-sessions.test.ts -t 'lifecycle subscriptions|reads hook pages'`。
- SDK：`npx vitest run test/hook-lifecycle.test.ts test/hook-history-api.test.ts test/unit/daemon-public-surface.test.ts`，然后 `npm run typecheck:public-surface`。

同一包不要并行运行两个启用 coverage 的 Vitest 进程，也不要在测试读取依赖时清理构建产物。确认 SDK 浏览器入口能以 platform=browser 打包，公开声明没有 Core 导入。PR 的独立 E2E 报告记录真实 command Hook 的观察结果，并区分单元／集成测试。
