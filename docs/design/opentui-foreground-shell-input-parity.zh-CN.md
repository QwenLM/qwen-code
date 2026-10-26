# OpenTUI 前台 Shell 输入对齐

[English](opentui-foreground-shell-input-parity.md) | [简体中文](opentui-foreground-shell-input-parity.zh-CN.md)

状态：实现候选，2026-10-26。改动正在同一冻结候选上进行 Node+Ink、Bun+Ink、strict Bun+OpenTUI 验证。本文不授权发布、切换默认 renderer 或移除 Ink。窄窗口语音边框回归包含在同一输入框批次中。

## 问题与证据

Ink 支持用 Ctrl+B 将唯一运行中的前台 Shell 转到后台，用 Ctrl+F 将键盘焦点切到其真实 PTY，保留输入框草稿，并在 Shell 结束后释放焦点。本次变更前，OpenTUI 已运行真实交互工具调度器并绘制结构化 Shell 输出，但未将执行中的 Shell owner 接到这些交互。历史记录中的 PID 不能作为控制进程的依据。

变更前的真实前台 Shell fixture 已复现差距。全局 Ink、Node+Ink、Bun+Ink 都能在原来的子进程持续运行时完成转交并发布后台任务 ID，strict Bun+OpenTUI 未发布该转交。main64 加窄窗口输入框修复上，Node+Ink 和 Bun+Ink 能准确传递 INNER_A、Left、Return、INNER_B 的字节，并保留独立的输入框草稿；strict OpenTUI 在首次切换焦点时未传递任何字节。这些证据使用假的回环模型、真实调度器、真实 PTY 和真实按键，不代表安装产物或其他平台通过。

加强后的缩放测试在三个 Ink 对照中也失败：外层视口从 100 列变为 72 列后，内层仍为 89 列。保留该失败，作为仍在调查的参考实现限制，不能描述为 OpenTUI 独有回归，也不能用此前切换焦点造成的高度变化充当缩放成功。初版测试的宽泛 PASS 不证明缩放通过。

## 范围与约束

将前台 Shell 的既有交互作为一个完整输入批次恢复，复用 InteractiveModToolScheduler、CoreToolScheduler、ShellExecutionService、原命令匹配器及 keyToAnsi。复用现有结构化 ANSI 输出绘制和后台任务注册。不新增 PTY 实现、运行时切换、依赖升级、Shell 命令或独立任务注册表。空输入时的 ! Shell 模式继续使用自己的 owner。

同批携带小型语音边框修复：语音标签无法容纳时复用已计算的 topBorderLine。宽度 1、5、6 有回归覆盖，实际编译后的五列原生输入框也已验证。这不解决另四个窄屏录音帧差异，也不代表真实麦克风或模型服务验收。

## 执行所有权

由 live-session 的调度器回调发布真实执行中的 Shell 调用快照，通过生产环境实际填充的回调传到 live-turn。控制器和 PID 不进入序列化 transcript 事件或持久化历史。live-turn owner 必须拒绝旧 turn 序号的更新，并在批次结束、中断、重置、卸载时清空快照。旧回调不能清空新 owner。

仅当执行中的 PTY 唯一时选择输入 owner。后台转交另行选择唯一具有有效转交控制器的执行中 Shell，与 Ink 的选择规则及 core 守卫一致。不能从最后一张工具卡、排队或已批准的调用、已完成调用、进程级列表或 ! Shell 控制器推断 owner。每个新增回调都必须在 renderer 入口有实际生产 setter，仅声明并在测试中填充不算接线完成。

通过既有控制器的 background reason 完成转交，不中断前台 turn、不终止子进程、不伪造工具结果。后台注册、响应和任务生命周期仍由 core 负责。现有 /tasks、task_stop 必须观察到该真实记录。

## 键盘与焦点

焦点身份绑定当前 call 和 PID，不能用会转移给后续进程的单一布尔值。Ctrl+F 在选中的 PTY 和内容未变的输入框草稿之间切换，焦点按键自身必须被消费，不能进入 PTY、编辑器或模型。在自然完成、后台转交、取消、重置和 owner 替换等身份失效时清除焦点。

Shell 获得焦点时，通过 toOriginalKey、keyToAnsi 转发与 Ink 相同的可打印字符、导航键、Return 和控制字符。Ctrl+Shift+Up/Down 复用既有 PTY 滚动行为。避免全局 handler 和 textarea 双重投递。切回输入框后恢复普通编辑、Vim、历史、粘贴及草稿提交，不能将子进程输入复制到草稿。

modal、权限、命令对话框和退出 owner 优先，不能向无关 modal 后面的 Shell 转发按键。除了输入框 handler，还需检查入口 Ctrl+C/退出路径：Shell 获得焦点时 Ctrl+C 和空草稿 Ctrl+D 应像 Ink 一样先交给全局退出/取消 guard，再决定终端输入。草稿非空时 Ctrl+D 保留终端输入且不停止全局广播。首次 Ctrl+C 取消并显示提示，后续按键遵循既有退出时间窗口。Shift+Tab 仍须到达应用级审批模式轮换，Ctrl+O/Alt+T 仍须到达全局思考展开；Shell 焦点不能吞掉这些广播。在适用处保留其原终端字节映射。没有合格 Shell 时，空闲 Ctrl+B/F 保留原编辑语义。按键 release 不执行动作。

## 尺寸与显示

根据原生视口初始化真实 Shell 的执行尺寸，仅缩放当前有效 owner。在适用处匹配 Ink 声明的尺寸约定：终端列数的 0.89，行数扣除布局留白后保持正值。如实记录参考实现失败；在改共享基础设施前先查明外层缩放的投递。测试不能直接调用 resizePty 制造产品结果。

继续在既有工具卡中展示结构化 Shell 输出，焦点与快捷键信息应符合参考行为。保留 ANSI token 颜色与有界视口处理。没有真实 fixture 和帧证据时，本批不声称完整 curses/备用屏兼容。

## 涉及层次

- live-session.ts：观察真实执行中调用，并关闭批次 owner。
- live-turn.ts：持有当前 turn 的选择、操作和旧更新守卫。
- start-opentui-ui.tsx：实际填充应用的 live-shell props 和操作。
- opentui-app-shell.tsx、input-prompt.tsx：处理 modal/输入框/PTY 焦点、按键消费、视口尺寸。
- 相邻测试与交互集成场景：验证回调实际接到生产消费者，覆盖 owner 转移、字节、任务转交及清理。

不计划重构 core。若确认的共享缺陷确实需要 core 改动，应追踪全部受影响消费者，并在扩大本批范围前取得必要的维护者审查。

## 验证与验收

运行全局 Ink 基线，并将同一个冻结候选分别运行于 Node+Ink、Bun+Ink、strict Bun+OpenTUI。受控模型必须调度真实 run_shell_command，且 is_background:false。在评估焦点或转交前，要求唯一存活子进程 PID 和真实 TTY 输入输出。

Ctrl+B 必须使精确调用的工具响应包含真实后台 ID，原来的子进程继续运行，/tasks 能显示该 ID 的运行中和随后完成状态。释放子进程后得到普通响应不算后台转交。Ctrl+F 对照独立字面 hex 494e4e45525f411b5b440d494e4e45525f42，不得泄漏焦点字节或增加请求；保留草稿、子进程自然退出，随后草稿恰好产生一次请求。

缩放前记录子进程事件边界，执行外层 resize72x28 后要求同 PID 的新事件，列数为 64 且行数为正。缩放前事件或同宽高度变化不能通过。当前 Ink 失败在调查期间保持 FAIL；被更早失败阻止的后续断言为 NOT_RUN，不能默认为绿。

覆盖零/一/多个合格调用、非 Shell 调用、未设置 PID/控制器、旧 turn 回调、控制器替换、转交失败或无操作、正常及中断结束、对话框、Ctrl+C、按键 release、反复焦点切换，以及 Vim/历史/粘贴/语音行为保留。集成测试保留原始帧、HTTP 请求、子进程字节和缩放事件、精确源代码/运行时/bundle 身份及自然退出证据。永久 interactive/tui-foreground-shell.test.ts 及其 owned-shell-child.mjs fixture 在三个 renderer/runtime 腿覆盖转交、真实焦点/草稿输入及首个 Ctrl+C 取消。缩放 case 明确只针对 OpenTUI：此回归文件中两个 Ink skip 不替代另行保留的 Ink 缩放 FAIL 证据。fixture 使用 POSIX exec，Windows 产品验收另行保留。既有三腿 TUI workflow 无重试地运行该整文件并保存证据。最终验证包含 build、typecheck、改动整文件测试、lint 和两轮干净的完整 diff 自审。

真实 npm/npx/standalone 安装验收、Windows 等声明平台、真实终端 IME/无障碍、复杂 VT 和最终 rollout 门槛仍是独立且必需的迁移工作，不能将本地源码 bundle 证据填入这些验收项。

## 待决问题

在提出共享改动前，查明为什么 Ink 对照中的实际外层缩放没有改变内层宽度。既有双按中断退出策略也存在差异（Ink 为 0、OpenTUI 为 130）；观测到当前策略不等于最终兼容性批准。四个窄屏语音录音场景的最终帧对齐也仍待处理。Windows Shell 获得焦点后的 bare Tab 审批轮换还需要完整的 Tab consumer 信号与真实平台验证；本批不声称已实现或验收。上述待决问题不意味着允许永久兼容性豁免或未经验证地扩大本 PR。
