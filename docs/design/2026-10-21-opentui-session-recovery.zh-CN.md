# OpenTUI checkpoint 捕获与完整恢复

[English](./2026-10-21-opentui-session-recovery.md)

## 状态与依赖

本 B 源码提案依赖完整重放/恢复批次 [#15384](https://github.com/QwenLM/qwen-code/pull/15384) 及 A 的完整共享恢复修复。C 已提交；B 现以 [#15386](https://github.com/QwenLM/qwen-code/pull/15386) 的 A 已提交源码 83213983 进行整合。干净 B 6b92fc5c 的具名本地 session 与冷热 checkpoint suite 已通过；compact-summary 修复及最终 runtime/安装/平台联合仍须独立验证。精确源码绑定记录在候选 manifest 和验证报告中。B 补齐 OpenTUI 的生产消费链，不假定已验收组合产物。历史 aggregate 证据保留在调查目录，不代表本次抽取通过。

## 问题与交付边界

编辑等待审批时必须产生完整 checkpoint。恢复须回退真实文件与 UI/API 历史，在当前 owner 下执行合法 fresh Read，仅执行一次选中工具，将真实新响应绑定原 logical call，并在冷恢复后保持该分支。创建、native 捕获、writer、本地调度与热/冷验收一起交付；无人设置的 snapshot port 或仅 writer 改动均不完整。

本批保留 D 的取消、prepared Retry、shell 所有权和退出合同，C 的重放与普通模型工具记录，以及当前上游 native validator 和 CI 预算。不改依赖、runtime pin、默认 renderer 或 journal schema。

## Canonical 捕获

重放 fanout 保留原始 source。新增 native 行在事件来源保留 canonical user、assistant、thought、image、tool、info/error/warning、compression、goal、advisor、arena、stop-hook、recap 和 shell 字段，不能从格式化文字重建元数据。工具组通过既有 mapper 保留原请求和 scheduler 最终显示，也包括 mention 结果。

Canonical 数字 ID 与 host ID 区分。恢复 source 为分配器播种，避免首个 goal/blocked 事件覆盖恢复的负 ID。后续批次重用 wire call ID 时使用独立 group/render identity。实际 response-end 标记重置首个 assistant 与图片上限。补齐 native thought 时长及 scheduler 拒绝后的终态，不覆盖已完成的重放元数据。

真实 live-turn snapshot port 仅排除临时 retry/task、pending 工具组及未完成 native 行，再要求完整 canonical source。零可见重放来源仍进入 snapshot；缺少元数据则捕获失败，不能发布残缺 checkpoint。保留现有 viewport/fence 布局，不在此重写精确分段策略。

## 紧凑工具摘要展示

成功 Read 在热恢复及冷恢复后都应保持 Ink 的 `Read` 紧凑摘要。两 renderer 复用既有纯 summary builder 和类别判定，不能重命名 canonical `ReadFile` 元数据、请求、结果或 journal。搬移原 helper 函数体，保持翻译、清理和描述数量规则，保留 Ink 既有导出。

对完整、连续的 canonical 工具组，在 viewport 分段前推导展示行。group 身份及 calls 顺序匹配后，才把成功 read/search/list 行替换为一个摘要。原 live rows 和 canonical source 对象仍供 snapshot、checkpoint 捕获及持久化使用。紧凑与独立展示使用不同的测量高度身份，避免切换真实 detail 设置时复用旧几何信息。

审批、错误、取消和图像保持独立展示。完整详情、被请求的非空参数、用户发起批次、pending owner、memory badge 和交互 subagent/PTY 组沿用既有独立路径。复用真实 subagent 判定：父调度 call 成功后仍可能存在 nested confirmation。native transcript 目前没有 Ink shell-focus 端口，不能从无关字段猜 focus。本修复不关闭迁移清单中其余 active/memory/subagent 布局一致性义务。

先证明单 Read 及同组多 Read 的失败；修复后要求一个精确共享摘要、状态负控、空与非空参数、不同 source 重用 call ID、source snapshot 不变，以及真实测量输入下 frame/scroll/detail 切换。完整 checkpoint 测试在三个 renderer/runtime 路径重新执行，冷热恢复都要求相同成功 Read 标签，保留全部原审批、payload、backup 和 active ancestry 断言。全局 Ink 基线与精确候选证据分开，旧 6b92 产品通过不能证明修改后源码。

## 审批与 writer 权威

仅在 checkpointing 开启、模型来源 edit 请求进入真实审批时创建 checkpoint。先排入 scheduler 原始工具组 source 和 confirmation，consumer fold 后再恢复 writer，避免读取未消费的 transcript。真正重新进入审批会替换 capture owner；同一次入口的快批准不会作废已经捕获且正在写入的恢复点。

在文件系统 await 前捕获 UI 历史、API 历史、prompt identity、原 logical call ID 和获授权的执行参数。API 历史独立保留原模型参数，不受 hook 或审批改写影响。在既有 checkpoint 目录使用临时文件与 UUID 后缀最终文件名。发布前复核 turn、session、abort 和审批入口 owner。短 rename 同步执行，最终复核与完整文件发布之间不能插入取消。清理未发布临时文件。关闭功能、client 来源和未提供 snapshot port 的旧 caller 不得访问 checkpoint storage 或写文件。

## 本地恢复与共享权威

真实命令 dispatcher 将 A 的 restore binding 和 invocation identity 传给 shell、startup entry 和 live-turn scheduler。本地工具使用新的 physical request ID、client execution origin，以及现有 scheduler 权限/hooks。在调度前绑定该 execution ID，让授权参数改写仍能按捕获的原 logical identity 完成。不产生新的模型 user prompt，不自动请求模型 HTTP。保留 terminal UI、dual-output、取消、后继和排队输入。

仅当前捕获 binding 可以完成。复用 A 的合法 scheduler Read、read-generation fence、真实 chat replacement revision、session/turn/abort 与 recorder identity、单次完成准入、原 logical call 匹配和 durable branch 发布。新 physical ID 保留给 UI/telemetry。普通模型/native 结果继续由 C 路径记录一次；本地恢复先通过 A 严格 durable binding，再将真实 response parts 加入 API 历史。

保留完整 assistant 消息与兄弟 calls。重放 A 不能复制已丢弃的 B 旧 success，也不能伪造 B 执行。冷 UI 将缺失结果标为真实的 Error、明确取消标为 Canceled；既有 wire repair 可以报告缺失兄弟。新 checkpoint 保留原 call ID，支持多个 pending call；不含 ID 的旧 checkpoint 要求只有一个同名 pending call，不能用参数相等消除授权改写带来的歧义。

## 测试与验收

保留全部独特 D/C/A 回归、原图像/typed-file helper 和严格 media oracle。执行 dispatcher、event adapter、model、native output/session、live-turn、shell/host、checkpoint writer、tool-history 完整受影响测试文件。包括真实 checkpoint 发布、关闭/client/no-port 负控、同 call 重入、写入期间快批准、abort/session/turn 失效、重复 call ID、response 边界、thought 收尾、取消组和真实 snapshot getter。组合接口变化时复测 A 的共享恢复、history revision、recorder/fence 和 Read generation consumers。

正常 build、含 integration 的完整 typecheck、lint、格式检查及全新 split-dist inventory 先于产品验收。永久完整 checkpoint 测试须在精确产物上执行 Node+Ink、Bun+Ink 和 strict OpenTUI：真实 HTTP/PTY、原 logical 与新 physical ID、OLD1 对真实 NEW2 payload、文件回退、热 snapshot 不变、冷 active ancestry/backup 字节、无旧 answer 重放及两次自然退出。同 assistant 双编辑在 Ink 与 strict 对照：按实际参数选 A、批准 A、回退两文件、仅重放 A，检查冷 A success/B 真实 Error。冷启动清理临时 checkpoint JSON，因此应检查存续 backup 和 active branch，不能要求旧临时 JSON 继续存在。

保留原始失败、有限超时与清理证据。静态 syntax/apply 检查不等于 unit、产品、安装或平台验收；历史 aggregate 绿不能替代新组合源码。交付仍需两次 fresh clean review 和 current-head CI；安装 runtime 与支持平台证据保持各自源码范围。
