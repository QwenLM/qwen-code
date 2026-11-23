# 按宿主支持能力注册 Legacy Agent Team 工具

Legacy Agent Team 工具注册门禁是 [#13785 总体设计](2026-11-23-managed-multi-agent-public-api.zh-CN.md) 的第 1 步。宿主必须具备团队报告和队友审批的处理能力，并在初始化时显式声明支持，工具注册表才会考虑向模型提供团队工具。

## 问题

在设计基线 `b62d4ab7` 上，`Config.isAgentTeamEnabled()` 先检查 Shell 执行沙箱，再检查环境变量或实验设置。ACP 使用同一个 Legacy 工具注册表，但尚未绑定 Legacy 团队的 leader 消息回调或审批监听器。TeamManager 会让报告留在收件箱里未读，轮询也不会发送团队结束通知。队友的工具审批可能一直等到停滞超时。[#14855](https://github.com/QwenLM/qwen-code/pull/14855) 直接构造 TeamManager，记录了报告投递和团队结束的现有行为。

Ink TUI 绑定 leader 消息回调，并使用交互式队友审批。非交互 CLI 同样绑定 leader 消息回调，并通过 stream-json 控制通道或现有非交互兜底处理审批。这两种路径都支持 Legacy Agent Team。Hosted Harness 通过自己的 `teamsAdmitted()` 声明团队工具，并使用持久记录和 Session 消息。

## 宿主声明与工具注册

为 `ConfigInitializeOptions` 添加内部选项 `agentTeamHostSupported?: true`。首次初始化通过取消检查后，在开始异步初始化之前严格读取 `true`，并将结果保存在 Config 中供该注册表的生命周期使用。宿主声明支持，表示它能接收团队报告并处理队友审批请求，也可以通过现有的非交互兜底处理审批。应用代码负责声明宿主能力。用户仍使用原有设置或环境变量选择是否启用实验功能。

| Config 初始化入口                                                                            | 声明                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ink `AppContainer` 挂载                                                                      | 传入 `true`。Ink 绑定 leader 回调并提供交互式审批。                                                                       |
| `llm.tsx` 的文本或 JSON headless 路径，以及 stream-json 的 `Session.ensureConfigInitialized` | 传入 `true`。两者都使用非交互 CLI 的 leader 回调和审批处理。stream-json 声明支持时保留原有初始化选项，包括 SDK MCP 回调。 |
| OpenTUI、ACP 引导和各 ACP Session、其他 Config 调用方                                        | 省略。daemon bridge 的 ACP 会话也走同一条逐会话的初始化路径。                                                             |
| Hosted Harness                                                                               | 使用自己的 `teamsAdmitted()` 路径。                                                                                       |

OpenTUI 在开始初始化 Config 前启动失败时，回退到 Ink 后由 Ink 正常声明。如果 OpenTUI 已开始初始化共享 Config，注册表和能力声明由首次调用确定，后续回退遵循现有的单次初始化规则并沿用首次能力声明。同一宿主的派生 Config 通过原型继承声明。普通环境变量、设置和客户端元数据单独都无法声明宿主支持。

把宿主检查加入 `Config.isAgentTeamEnabled()`，使现有沙箱条件和用户开关只有在宿主声明支持时才能放行。现有注册代码以及 `AgentTool` 的参数和说明已经使用这一判断。团队工具与专用参数 `name`、`plan_mode_required` 和 `read_only` 共用准入结果。普通 Agent、查询、停止和跟进工具保留原有声明。执行团队操作仍需有活跃的 TeamManager。Hosted 的工具声明和持久化团队执行继续走原有的准入路径。

## 与 #15658 的衔接

在 [`c752f6b1`](https://github.com/QwenLM/qwen-code/pull/15658/files)，ACP Session 在 `isAgentTeamEnabled()` 为真时绑定消息接收回调和审批路由。回调负责报告投递和 TeamManager 更换时的重新绑定。审批通过会话级 ACP 请求中继，并通过 bridge 通知撤下已失效的请求。#15658 后续若要启用 ACP 团队工具，需在共用的 `newSessionConfig()` 传入宿主支持声明，使创建、加载和恢复会话遵循同一条首次初始化规则。握手只声明支持，审批仍由 #15658 的所有权检查授权。

ACP 可沿用 `initialize.clientCapabilities._meta` 协商。后续可以使用明确的布尔位 `qwen.agentTeam`，由能向其使用方投递团队报告、展示会话级队友审批的 bridge 或客户端声明。ACP 服务端应同时要求客户端提供严格的 `true`，以及本地具备报告接收和审批接线。旧客户端和通用客户端继续使用普通工具集。本次只引入内部初始化选项。协议协商和 ACP 启用随实际接线一起交付。公共 `multi_agent` 能力、任务输入接口和团队投影按总体设计的后续步骤推进。

## 验证

- 省略宿主声明，分别开启实验设置和环境变量覆盖，在内置工具注册表中确认没有团队工具和 Agent 的团队专用参数，普通子 Agent 工具仍可用。
- 在支持的宿主上分别检查设置和环境变量启用，两者都关闭时不注册团队工具。确认支持宿主上的 Shell 执行沙箱仍排除团队工具，并保留原有的受限工具集。确认派生的队友 Config 仍有成员工具，`request_shutdown` 仍只向 leader 提供。
- 使用本地确定性的 OpenAI 兼容服务，在 stdio ACP 和非交互 CLI 的真实模型请求中检查工具声明。先用已安装的 CLI 复现 ACP，再用新构建的 bundle 重测。本切片中，客户端仅传入 `qwen.agentTeam: true` 不会放行，加载或恢复后也一样。同时检查普通 Agent 工具、它的团队参数以及 `team_create`。测试配置显式要求显示 Agent 和七个团队工具，避免把工具延迟加载误当成门禁。固定 Ink 渲染器运行队友报告测试。检查 stream-json 直连和 SDK 启动都传入能力并保留 SDK MCP 回调，运行现有队友审批测试。OpenTUI 的渲染层验证需实际通过 Bun 运行 OpenTUI。检查支持的入口传入选项，OpenTUI 与 ACP 省略选项。第二次初始化即使加入不支持宿主的在途初始化，也无法补加能力。
- 宿主分类测试证明 TeamManager 的行为。由于它直接构造 TeamManager，仍需在注册边界增加断言。检查 Hosted 的准入逻辑，并运行现有的针对性工具声明测试。
