# OpenTUI dual-output 完整交付

[English](2026-10-21-opentui-dual-output.md) | [简体中文](2026-10-21-opentui-dual-output.zh-CN.md)

## 状态与依赖

**STACKED DRAFT / 当前验证检查点。** 本文与 [Vim/history](2026-10-21-opentui-vim-history.zh-CN.md) 是同一 Draft #15067 的输出部分，基于统一 UI `c1f802b0c1d237d9641b8217bdc97e8d37049f51`。已审源码为 `7a1ab30f616c5f688224b1dac1fcf0fc76e26966`；相对实际构建的 `194bfffcdd45e19f007aa28ceeb8dfea8402f84f` 只改四处可见模式夹具等待，字面/12 秒限制不变。生产和依赖输入一致；runtime 测试保留真实 194b stamp 和受守卫产物，不声称重新构建 7a1。本检查点的已记录本地验证已完成：映射的 source/native 门禁、194b 新 build/type/bundle，以及 7a1 全部八个后续阶段。完整三腿 108 个测试行通过，其中 106 个功能通过、两个保留的 Ink deny 缺口；有重叠的 strict 四案另列。prepare 和真实 npm tar 六项执行位检查通过，但不证明统一 R3+B 安装产物或音频录制验收。已接受安装在依赖/工具/runtime 守卫下复用。原 A/v6、ba04/f93、d677、aab54、b4 与 194b 失败均作不可变证据保留。不复制 R3 signal 改动；统一安装产物验证仍未关闭，UI 依赖尚未合并，因此本 PR 保持 Draft。reset 仍在失效前收尾已接纳输出，只通过 discard 释放 composer 取消锁，不取队列或恢复旧草稿。

已验收 A bundle（`8473becd7f80960bc28d9fbb7b0690332609bc28c94f894bb1afaab017bfaf46`）使用 Node 24.19.0 和 Bun 1.3.14 完成基线：Node/Ink 五案通过、一案明确权限缺口；strict OpenTUI 首个 text/thought 案显示回答，却只写 session_start/session_end。后续独立守卫下的 Bun/Ink 参考确认同样的 Esc 全拒绝缺口（request 1 / response 0，原测试 FAIL 保留），active-exit 为 0，双 CtrlC 实测间隔 302.45ms。因此两种 Ink runtime 都使用这个精确拒绝 characterization；strict OpenTUI 仍须返回一次拒绝 response。全部原始失败与冻结夹具版本保留在 R3 的 U4 基线记录中。

## 问题与证据

原 OpenTUI 基线创建并关闭 DualOutputBridge，但实际 prompt/model/tool 循环未向桥传事件。已验收的 R3 npm 产物完成一次模型请求并显示完整回答，`--json-file` 却只有 `session_start`。同产物 Node/Ink 产生了真实 user/assistant/stream 记录。原 Ink 整案失败是另一项错误的统一退出码断言（实际 0、预期 130）；两份原始失败都保留。

该遗漏早于 R3：live loop、runtime 和 bridge 与 R1 底座相同。构造器存在或文件可写不代表事件已经送达。完整实现进入新真实产物并通过验证之前，R3 的 JSON-file ready 门禁持续开放。

## 目标与边界

接通 OpenTUI 已接纳 live prompt 路径的全部现有输出类别：准备后的用户内容、原始 assistant 流与完成、逻辑工具结果、许可请求与决定、取消及正常 writer 关闭。复用既有 bridge、adapter、permission helper、scheduler 和 cleanup owner。

不新增事件总线、schema、配置、core API 或文件 writer。不从 ANSI 或 transcript 投影反推协议。不排除 `jsonFile` 或静默回退 Ink 来规避失败。远程 `--input-file` 输入、Goal 编排、多 interaction owner 和 duplicate-provider 调度属于另列的既有 live parity 缺口；输出接线不等于实现这些 producer。

## 既有合同及其限制

Ink 在 prompt 准备后发初始 user 记录，ToolResult/Goal continuation 除外。每个真实模型流启动 assistant adapter、传递原始 core 事件，并在 `finally` 完成。共享 adapter 可能随内容 block 类型切换分出多条消息；一次模型 hop 不必恰好对应一条 assistant。零事件流不能伪造 assistant/message_stop/result。

正常工具完成使用真实 request/response ID 和既有有界内容/artifact 投影生成 `tool_result` block。MOD native 重试不等于逻辑完成，不能每次都发结果。Ink 的 secondary-owner 与 duplicate-provider 分支另有 producer，目前 OpenTUI live loop 没有相同分支。

逻辑完成与 JSON 内容投影是两个边界。最终 MOD response parts 只传给模型 continuation、录制和 bridge 一次。对普通成功结果，共享 JSON adapter 优先使用非空 display 字符串；display 为空时才回退到最终 response parts。错误、vision 和 MCP display 的优先级保持不变，因此最终模型 parts 不必与 JSON 显示文本相同。

Ink 主路径的 continuation-cancelled 和 all-tools-cancelled 分支在常规 `emitToolResult` 前返回。保留并测量这个基线，不能以 parity 为名增加 OpenTUI 独有取消结果。同样，握手广告有 top-level `result`，但 interactive bridge 没有 `emitResult` producer。这些共享广告/实际缺口单列记录；真实 `tool_result` 内容 block 仍是本批必验范围。

## 接线方案

把已创建的 bridge 从 entry 传到 `useOpenTuiLiveTurn` 和当前 `livePromptEvents`。优先使用窄类型，不另建 context 或 writer。每个新增可选字段的真实调用方与读取方同批交付。

在 @/vision 接受后的最终 prepared parts 上、UserQuery send 前发一次初始 user。每个原始流事件先传 adapter，再进入中立 UI 映射。所属 assistant 流在 `finally` 完成，包括 throw 与同 generation abort。复用现有 adapter，不复制事件转换或 usage 计算。

在逻辑工具完成边界按实际 Ink 分支策略发一次 request/response。复用 `buildPermissionSuggestions`，在真实 scheduler 状态转换处关联 callId/requestId。读取同步 scheduler updates 和完成调用，不依赖 React 渲染的 pending 列表。只有实际存在且离开 awaiting 的工具可决定 allowed/denied；清空数组或卡片消失不能当批准。MOD 逻辑 scheduled 占位没有 invocation，不提供权限决定，包括没有 abort 的普通拒绝。真正 native scheduled 调用保留 invocation，可在 hook 再次 ask 前确认批准。abort 后忽略非终态更新，等实际终态调用提供决定。再次 ask 产生独立 request/response。已验收 Node/Ink 和 Bun/Ink Esc/all-denied 参考均丢失 response（request 1 / response 0）；本批通过既有 API 有意纠正该镜像遗漏，OpenTUI 必须 request 1 / response 1 且 allowed=false。不改 Ink，不新增协议。

## 输入、取消与输出所有权

保留 U2A 的结构化附件、typed @ 展开、generated input、defer 策略和 boolean admission。SteerInput accept/restore 表示 core history 接受，不是 HTTP 接受或首帧出现；它继续负责队列恢复与录制。UI user echo 和恢复的 draft 不能制造 JSON user 记录。Ink 当前因 continuation 为 ToolResult 而遗漏已接纳 steer 的 JSON；U4 有意在既有 carrier accept callback 中补一次 prepared user 记录。排队、恢复或失效输入不发事件。此项和拒绝 response 配对都是相对当前 Ink 镜像的明确改进，不声称输出逐字相同。

保留 U2B-A 的 active turn 身份和 cancellation-settled 所有权。同 generation abort 可能需要完成已发 partial；旧 generation 不能写入或结束后继 adapter 状态。使用既有 generation/turn owner，不增加通用并行 stream registry。明确 @/vision decline 保持既有消费并提示策略。

## 关闭顺序与文件安全

既有 bridge 的顺序是：最终接纳记录、session_end、停用 writer、stream.end、close。当前 OpenTUI entry 在 bridge shutdown 前 unmount，而 unmount 会使 turn 失效并 abort。接线后若仅按 generation 限制 `finally`，可能丢掉 partial 尾部。在 reset/unmount 使 generation 失效之前同步 finalize 当前 adapter。entry cleanup 也在调用原生 React root unmount 前 finalize，因为不能假定 concurrent reconciler 在 writer shutdown 前已经完成 passive effects。generator 只在仍拥有当前 generation 时于 finally 完成。共享 adapter 的重复 finalize 幂等，随后 runtime shutdown 排空既有 writer。晚到事件不能结束后继，无需额外 promise drain。

保持现有每项 cleanup 2 秒、总计 5 秒边界。不增加无界 drain 或新 signal supervisor。记录 timeout/cleanup 失败，不能把应急强杀改记成功。不把 R3 signal 处理复制到本 UI 基底批次；分发整合后再验证终端恢复。

writer 的路径/fd/FIFO、信任、权限和失败语义不变。JSON 文件沿用 mode/umask，不声称统一 0600 或新增路径 sandbox。已有文件不自动 truncate 属另列共享问题。测试只用独占 0700 根、隔离 HOME/config/cache/runtime，不碰用户 shell rc。

## 文件与交付规模

| 范围                             | 预计 changed lines | 原因                                      |
| -------------------------------- | -----------------: | ----------------------------------------- |
| entry                            |              20–45 | 注入既有 bridge 并接通 cleanup            |
| live-turn                        |             70–120 | 传递依赖、generation 与当前 turn settle   |
| live-session                     |            150–240 | user/raw stream/finally/tools/permissions |
| runtime                          |               0–30 | 仅在确需现有 owner 的小 teardown 接口时   |
| Core、scheduler、bridge、adapter |                  0 | 复用不变行为                              |
| focused 与真实 PTY 测试          |          1200–1680 | 输出断言、取消/所有权和生命周期           |
| 双语设计、矩阵与测试发现登记     |            180–270 | 完整一致要求与证据                        |

原输出部分估算为 **1.6–2.4k 变更行**，v6 冻结为 1869 行。整合交互/输出清单报告实际净规模，包含保留的 Vim/history 测试和文档。这是同一后继 review 批次，不拆成两个小 PR。不能为行数删除必要断言；新增 core/scheduler 依赖必须由协调者重新评估范围。

## 验证与验收

E2E 计划和正式交互测试定义六个 PTY 场景，分别运行 Node/Ink、Bun/Ink 和 strict OpenTUI：text/thought、工具 continuation、许可允许、全部拒绝、partial 取消后再次提交、active stream 退出。同一真实产物、精确 runtime，对照真实模型 HTTP、JSONL、终端、退出与捕获进程清理。模型服务是合成的；CLI、工具实现、文件系统和 runtime 是真实的。历史全局 CLI 检查为独立证据，不代表已验证此输出合同。精确 A 产物基线是本批权威参考；如另做 global dry-run，必须先解析实际安装 launcher/runtime。

focused 使用真实 bridge/adapter 和独占 JSONL，仅控制 core/scheduler 时间。覆盖图片/@ 准备及既有 adapter 投影（非文本 part 转为 JSON 文本）、明确 decline、零事件/core limit 事件、错误、混合工具终态、最终 MOD 逻辑结果、再次 ask、calls 清空、SteerInput accepted/restored、旧 generation 晚到和 shutdown 顺序。完整 middleware 重试执行与独立进程清理仍需另行动态证据。这些路径不能由六个 PTY 场景推定通过。

MOD 投影用例先在真实 bridge、模型 continuation 和录制消费者处核对最终 parts，再检查 JSON。非空 display 与空 display 两个变体都要求逻辑结果仅出现一次，且位于 tool use 与下一条 assistant 之间；两者均不改变共享序列化合同。保留原先只检查 JSON 而预期错误的失败记录，将其归为测试断言证据，不称为生产修复。

验收要求支持路径匹配真实 Ink 的事件类别/顺序/ID，queue/replay/retry 不重复，旧流不污染后继，正常关闭 session_start/session_end 各一次，正常退出后没有捕获的产品活体。只解析完整 flush 的行，拒绝坏 JSON/ANSI。普通 `/quit` 和确认的 active raw CtrlC 键盘退出，在三个 profile 均须完成共享清理后以 0 退出。保留历史 Ink 0/OpenTUI 130 基线，作为本次修正的差异；真实 OS signal 终止保留原信号码。任意非零码和 harness 清理均不等于优雅退出。

准备夹具独立版本化并锁 hash。原 R3 v2 结果与 manifest 不变。基线收集、实现验证、独立审查是不同证据阶段。后续 commit 不可声称旧 R3 tarball 包含变更后的源码。

## 验证检查点与剩余门禁

1. 映射的 source/native 门禁和 194b 新 build/type/bundle 已通过。7a1 源码下 strict 四案、变更文件 lint/format、完整 Node/Ink、Bun/Ink、strict OpenTUI 三腿、prepare 及 npm tar 六项执行位检查通过（完整三腿 108 行：106 个功能通过、两个 Ink deny 缺口）。 保留每阶段的 source/artifact 身份；映射早期门禁不等于重新执行 7a1。
2. 两条 Ink deny 继续记为已刻画缺口，与 strict 配对拒绝 response 区分；exit 130 和清理 HUP 不等于正常 exit 0。
3. 真实 middleware 重试、通过安装产物真实按键/HTTP/JSON 的 accepted/restored/stale steering 仍为 NOT_RUN；focused carrier 测试不关闭这些门禁。
4. 整合 R3 后才能关闭安装产物 JSON-file 验收。其他平台、runtime modes、IPC 和资源门禁继续独立排期。
