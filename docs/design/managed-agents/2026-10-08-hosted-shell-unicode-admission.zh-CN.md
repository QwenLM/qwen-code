# Hosted Shell Unicode 准入

[English](2026-10-08-hosted-shell-unicode-admission.md) | [简体中文](2026-10-08-hosted-shell-unicode-admission.zh-CN.md)

## 1. 状态与证据

这是 [#13010](https://github.com/QwenLM/qwen-code/issues/13010) 的修复方案，
日期为 2026-10-08，已在本地工作区实施。第 9 节记录本机验证，
不代表生产发布授权或 issue 已关闭。

设计审计已完成两轮：第 1 轮发现两项问题并已修订；全新第 2 轮没有发现新的实质
问题。这不代表运行时验收通过。

已通过 `gh` 阅读 issue 及完整评论。历史证据是 `3da25b7c` 上的
[O2 第 9 轮报告](https://github.com/QwenLM/qwen-code/pull/12894#issuecomment-5888143498)：
Shell 参数中的孤立代理项使两条捕获路径都被阻塞，同 Workspace 的第二个 Session
在八分钟后仍收到 `workspace_busy`。应保留该报告及其日志链接。报告没有运行独立
main 构建，因此不算当前 main 的复现。

源码检查基于本地 `040f06c7b141235153d69c3c795da9f8550eb900`。查询时上游 main
为 `fe4d4e345c3f52fd6d8455646cdd3c782ca8b227`；GitHub 对比显示两者之间
`hosted-workspace-tool-turn.ts`、`hosted-workspace-broker.ts` 和
`managed-tool-protocol.ts` 未变。Hook 生命周期代码及 tool-turn 测试有所变化，
实施前已 fast-forward 到该上游 main，并阅读这些变化。
运行时复现与实施证据见第 9 节。

实施前的基线事实：

- `HostedWorkspaceToolTurn.executeNative` 同时构造 local capture 与 O2
  publication 请求。它检查 Shell 参数形状，但不检查 UTF-16 是否完整。
- 批次存在 `validationError` 时，已有路径会持久化 assistant 和配对的工具错误，
  无须获取租约或执行。O2 现在也走这条路径；历史上 O2 直接抛出普通校验错误的
  行为已经过时。
- `PermissionRequest` 当前在 `prepareRequests` 前运行。`PreToolUse` 在获取租约
  后运行，可以改写参数，随后再次调用 `prepareRequests`。`execute` 还会调用
  `completeHookResults`，其中包含 `PostToolBatch`。
- 构造时已经启动 `/runtimes:warm`。更早的 prompt Hook 或此前的合法批次可能已
  持有 Workspace 租约。
- Java 的 `BrokerValues` 以及 Broker/transport 已拒绝不完整文本，但晚期拒绝
  不能代替本 issue 要求的、提前且持久的模型可纠正拒绝。
- 评论中的 `packages/core/src/tools/managed-shell.ts` 已不存在；建议复用的
  `hasUnpairedSurrogate` 是 external-context integration 的私有函数，不能直接
  跨包导入。

## 2. 问题、目标与范围

JSON 参数可以携带转义的孤立 UTF-16 高代理项或低代理项。解析成功后，后续编码器
或 Java 边界可能拒绝或替换该值。若此前已经获取执行 owner，不确定结果就会保留
Workspace fence。因此应在进入该执行链路前拒绝错误的 Shell 调用。

目标：

1. 在两条 Hosted Shell 捕获路径中，拒绝不完整的 `command` 和字符串
   `description`，先于被拒批次的执行获取与预留。
2. 给模型持久、有序、可纠正的 function error；同一 turn 后续纠正的调用可以执行。
3. 保留合法 Unicode，以及 canonical digest 的算法和字节。
4. 覆盖 Hook 改写，避免将不完整的 Shell 输入转发给后续 command Hook 或 Runtime。
5. 对不确定的持久化和此前已准入的副作用继续保持阻塞。

范围为 Hosted `run_shell_command` 的 `/1`、`/2`、local capture 和 O2。
现有 H3 分支被选择时，同样的字段检查不能消失，但本修复不启用后台 Shell。
普通 CLI Shell、Monitor、MCP 参数、其他文件工具文本、通用 JSON 校验、已有阻塞
Session 的恢复、公开 Shell 准入和新协议版本不在范围内。合法的无关工具保持原行为。

## 3. 选定方案

在 `packages/cli/src/serve/hosted-shell-input.ts` 添加一个小型纯 Shell 文本校验
函数，由 tool turn 和 Hosted Hook session 两个真实消费者使用。不从 core 导出，
不建立通用 sanitizer。保留既有类型、必填字段和 profile 校验。对字符串字段使用
`/[\uD800-\uDFFF]/u` 检测孤立代理项：Unicode 标志使合法代理对成为一个补充
平面码点，不匹配代理项范围。不能遗漏 `u`。

使用固定错误消息，只指出字段，不包含其值：

- `Hosted Shell command contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.`
- `Hosted Shell description contains an unpaired UTF-16 surrogate. Provide valid Unicode and retry.`

不 trim、不规范化、不删除或替换码元。可打印的六字符 `\ud800` 序列是合法文本；
解析得到的孤立 `\uD800` 码元不是。省略或空的 description 仍合法。缺失或非字符串
command、非字符串 description 继续由已有错误处理；未知 key 和其他形状问题继续
由已有校验拒绝。

选择拒绝而不是替换：修改命令字节可能改变副作用，也会破坏输入、审批、执行之间
的对应关系。保持 `managedToolDigest`、payload JSON、Tool v3、Java 校验和资源
schema 不变。不为复用这一个检查而将 integration 的私有函数迁入 core。

## 4. 准入与 Hook 顺序

采用以下顺序，并保留既有 profile/identity、截断参数和 inline-size 拒绝语义：

1. 在 `PermissionRequest` 和任何携带参数的 Hook 前检查模型的 Shell 文本。
   任一调用失败时，通过持久化参数拒绝路径拒绝整个批次，包含合法 sibling。
2. 初始 Unicode 被拒批次不运行 command Hook、审批 Action，跳过
   `completeHookResults` 中的 post-tool callback，包含 `PostToolBatch`。
   共用 completion 入口仍重建拒绝证据，其 callback 不接收原始不完整命令。
3. 在 `HostedHookSession.fireOccurrence` 内，每次应用成功的顺序 Hook 结果后，
   先校验生效的 Shell 输入，再准入下一个 Hook。覆盖 `updatedInput` 和
   `sequentialInput` 执行的 `tool_input` 合并，不能仅检查最终 aggregate。
   首次出现非法生效输入即停止，即使后续 Hook 可以修正也不继续。保留已执行 child
   的结果及原 plan，通过既有 result resource 聚合已执行前缀；返回其非法生效输入，
   让 tool-turn 校验器生成固定、模型可纠正的错误。不引入通用 interrupt，不结束
   整个模型 turn，不准入后继 child。
4. `settleSavedMarker` 必须从保存的 child 结果重建相同顺序前缀及停止条件，先判断
   停止条件，再查找后继 child。这样在非法 child 结果已保存、plan marker 结果未
   提交时崩溃，可以从该前缀结束 marker，不会永远等待故意没有创建的 child。
   更早的 child 结果不确定时仍按既有规则阻塞。并行 Hook 继续接收原输入，在 native
   执行前校验最终 aggregate，不取消已准入的 sibling Hook，也不改变其排序。
5. `PermissionRequest` 返回 `updatedInput` 时，在发布审批输入或 native acquisition
   前再次校验生效的 Shell 文本。错误的改写拒绝整个 native 工具批次。该 Hook 本身
   可能已经获取 Runtime，保留原 owner，交给正常 settlement 处理。
6. 在 `prepareRequests` 中再次检查，包含 `PreToolUse` 后的调用。如果 Hook 引入
   不完整文本，不再询问审批、不预留 publication、不启动该批次的任何 native 工具，
   拒绝全部调用。acquisition、publisher registration 或第一次审批可能已经发生，
   不能宣称此前完全无活动，也不能强行清除 owner。
7. 对 Hook 改写导致的 Unicode 拒绝，不向 post-tool callback 转发不完整的生效
   参数；跳过该批次的 post-tool callback，保留已提交的 Hook 决定与结果，正常
   持久化工具拒绝。不能为被拒调用伪造已执行的 tool intent。
8. 只有校验通过的生效输入进入既有 reservation/start 路径。合法输入改写后重新
   审批的规则保持不变。

复用已有批次拒绝的持久化逻辑，仅在这些入口需要时提取。assistant 提交前的拒绝
写一次 assistant，并为每个调用写有序响应；assistant 提交后的拒绝只写响应，不能
再追加一份 assistant。

不能依赖临时 flag 跳过 post-tool callback。在实时 `execute` 和冷恢复
`resumeHookResults` 共用的 `completeHookResults` 入口，通过原始 occurrence/call
identity 重建原 assistant group 和该批次保存的 `PermissionRequest`/`PreToolUse`
结果，按准入的相同规则恢复生效输入，包含被 Unicode 检查终止的前缀。只有非法
Shell 文本、完整配对的拒绝 group，以及该批次没有 native tool intent 共同证明
Unicode 拒绝时，才返回保存的响应，不运行 callback，不重复提交 assistant/result。
不能仅用错误字符串判断，也不能跳过所有没有 intent 的批次；普通参数/审批拒绝
保持原 post-batch 行为。矛盾的 native intent 或不完整拒绝记录属于恢复错误，不能
当作安全拒绝的证据。不需要新增持久 flag 或 schema 字段，下一合法批次从自己的
记录重新判断。

## 5. 持久化、所有权与兼容性

错误响应仅包含固定原因、原 function-call identity 和既有响应形状；合法 sibling
收到既有的明确未执行错误。错误消息和诊断不回显非法字段值。通过既有 JSON 转义
持久记录保存原 assistant function-call group，不改写原命令，不声称已经执行。
必须使用真实 Java Store 证明该 group 原样持久化及 reload，不能仅使用内存 TS mock。

对于全新、无 Hook 的被拒批次，要求 acquire、publisher registration、publication
reservation、prepare、start/execute 和 worker 副作用均为零。Runtime warming 在
模型输出前已经发生，允许它并单独记录。因此方案不承诺完全没有 Broker HTTP 流量，
也不停止独立 provisioning。

后续非法批次不能再次 acquire/reserve/start，但可能继承先前合法工作持有的租约。
正常最终 settlement 释放 owner；校验器不释放 owner，也不将既有 execution 改为
`not_started`。拒绝提交成功时是模型可纠正结果，而非 recovery-blocked；assistant
或 result 提交失败、结果不确定时保留既有 recovery blocking。Shell 未执行不能
证明 journal 一致。

不完整命令先于它的审批被拒绝，不为该命令创建审批。不需要配置、迁移、公开 DTO、
协议版本、新错误码枚举或 Shell capability 启用。后续源码实施须遵循 core/跨包
改动的维护者审核规则；本设计不代表 PR 审批，也不授权 rollout。

## 6. 实施与验证计划

实施前由只读 `test-engineer` 使用独立的真实 Java Store/Broker/Harness/worker
环境，在当时 main 构建上复现。先尝试已安装的全局 `qwen`，private profile 不可达
时记录 unavailable，不能记为基线通过。用确定性模型 fixture 分别覆盖 local capture
与 O2；输入准入测试不要求真实 OSS bucket。保存第 9 轮日志和新 exact-head
before/after 结果，将 E2E 计划与报告放入 `.qwen/e2e-tests/`。

主要实施/测试文件：

- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`。
- `packages/cli/src/serve/hosted-shell-input.ts` 及 collocated tests。
- `packages/cli/src/serve/hosted-hook-session.ts` 及测试，仅修改 Shell 生效输入边界
  和 saved-marker 重建。
- `packages/cli/src/serve/hosted-workspace-tool-turn.test.ts`，并按需要增加 Hook 测试，
  证明 callback 顺序与抑制。
- 覆盖真实 Java 持久化、文件副作用和同 Workspace 第二个 Session 的 native Hosted
  集成 fixture。rebase 后选择确实能驱动两条捕获路径的既有 driver，不为测试该修复
  增设第二个生产准入入口。

| 测试            | 必须提供的证据                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unicode 反例    | 两个字段、两条路径：孤立高/低代理项、高代理项后 ASCII、逆序对、高高、低低、合法代理对后孤立代理项。覆盖任意位置，包含合法 emoji 后。                                                                                                                                                                                                                                     |
| Unicode 兼容性  | ASCII、中文、补充平面 emoji、合法代理对、组合字符、ESC、U+0001、DEL、U+2028/U+2029 和字面 `\ud800` 的 command/description 字节完全保留；命令语义保持。                                                                                                                                                                                                                   |
| 批次拒绝        | 非法调用位于首/尾，与合法 Shell、Write 混合；所有错误有序持久化，每个 sibling 明确未执行，无 tool intent 或 publisher reservation。                                                                                                                                                                                                                                      |
| 纠正            | 同 turn 纠正的调用恰好执行一次；结果到达下一次模型请求；最终 settlement 成功，reload 和后续 turn 正常。                                                                                                                                                                                                                                                                  |
| 所有权          | 新拒绝不持有 Workspace 租约，第二个 Session 的合法调用完成；已有租约时的后续拒绝保留 owner，直到正常 settlement。                                                                                                                                                                                                                                                        |
| 持久化失败      | 分别失败 assistant/result 写入，并丢失已提交操作的响应；无执行、无假成功、保留既有恢复阻塞、不重复历史。                                                                                                                                                                                                                                                                 |
| Hooks           | 原始非法输入不进入 permission/pre/post/batch Hook；PermissionRequest 与 PreToolUse 的非法改写不能 native start 或进入后续携带非法参数的 callback。真实双 Hook 顺序 plan 覆盖 updatedInput 与 tool_input 合并：H1 引入非法文本，H2 从未准入，即使 H2 能修复也不运行。H1 result 后、marker result 前崩溃，恢复无需 H2 child 即可结束 marker；合法改写仍重新审批并到达 H2。 |
| Hook 冷恢复完成 | 将原始非法和 Hook 改写拒绝 group、Hook 记录 reload 到新 tool-turn，走真实 resumeHookResults 调用方，证明无 post-batch callback、无重复历史、无 native 操作。普通拒绝 replay 和下一合法批次行为不变。                                                                                                                                                                     |
| 存储和模型传输  | 真实 Java Store 持久化/reload 原始转义 assistant group 和配对错误；确定性模型收到它们并纠正调用。编码改变或传输拒绝该 group 时验收失败。                                                                                                                                                                                                                                 |
| 限额与 identity | 既有 inline-size、unsupported-tool、duplicate-call 和 incomplete-argument 守卫仍适用；超出现有限额时不承诺可纠正。                                                                                                                                                                                                                                                       |
| 回归与变异      | 既有 local/O2 拒绝、审批、捕获和 Hook 测试通过；分别移除每个准入检查与 callback 抑制检查，对应反例必须失败；去掉 `u` 时合法 emoji 见证必须失败。                                                                                                                                                                                                                         |

在相应包目录运行：

```bash
# Repository root
npm run build && npm run typecheck

# packages/cli
npx vitest run src/serve/hosted-workspace-tool-turn.test.ts
npx vitest run src/serve/hosted-shell-input.test.ts src/serve/hosted-hook-session.test.ts
# Add the actually changed Hook/native driver suites, then the real-stack gate.
```

第 9 节记录已完成的检查。catalog-only 或 worker-only
结果不能证明 pre-acquisition admission；不要求运行无关完整测试集。

## 7. 验收与风险

只有上述全部验证在同一最终源码版本通过，两条捕获路径先于首次 native 副作用拒绝
非法输入，合法文本字节不变，纠正后的调用和第二个 Session 正常，拒绝持久化失败仍
安全阻塞，才算修复完成。公开 Shell 启用和历史阻塞 Session 恢复仍属独立工作。

主要风险是校验相对 Hook 的位置错误、post-batch completion 再次转发非法输入、
改写后重复提交 assistant，以及仅依赖 TS 持久化证据。inline 限额和此前仍在进行的
副作用可能合理地阻止可纠正 continuation，必须明确记录。

编写本设计不需要额外产品决策。源码交付前必须有当前 main 复现和 Java 历史原样
往返证据；任一失败都应修改实施/设计，不能静默替换非法命令或宣称 issue 已修复。

## 8. 独立审计记录

用户要求每轮由全新 Sub Agent 进行审计和反向审计，轮间更新，最多七轮。
每轮同时检查方案能否关闭 issue，以及新增拒绝/顺序是否破坏合法行为，或使验证
声明无法证明。

| 轮次 | 问题与处理                                                                                                                                                                                          | 结果                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | 新审计者 audit_round_1 发现外层检查前的顺序 Hook 传播（P1）和冷恢复丢失 callback 抑制（P2）。已补 Hosted 共用校验器、顺序前缀终态重建、持久 completion 判定，以及对应反例/兼容性见证。              | 两项均接受并修订；第 2 轮已独立复核。                              |
| 2    | 新审计者 audit_round_2 独立核对 issue/源码，审计正向行为与反向兼容性/恢复反例。未发现新实质问题，第 1 轮修正已覆盖。报告保留事件返回形状和嵌套 PermissionRequest 的实施约束，不扩大合法 Hook 语义。 | 满足用户“无新问题”停止条件，结束审计循环（最多 7 轮，实际 2 轮）。 |

本地审计报告：`.qwen/pr-reviews/issue-13010-design-round-1.md` 和
`.qwen/pr-reviews/issue-13010-design-round-2.md`（git-ignored 工作产物）。

## 9. 实施与本机验证

实施在 permission Hook 前和 request preparation 中使用共享纯校验器，
在 live 与 saved-marker 路径终止不完整的顺序 Hook 前缀，并在 callback 前
重建持久化 Unicode 拒绝证据。共享既有有序拒绝路径；未增加持久化 schema、
core 校验器、digest 算法或生产 Java 协议。

修复前 main 的打包产物在 local 路径将 U+D800 command 准入
acquire/prepare/start，30 秒后仍有活跃 prompt。8 项受控源码 fallback
独立观察到 acquisition。早期 O2 fixture 缺少 publication endpoint，
其 recovery block 不能单独证明 Unicode 导致锁死。这些观察未复现历史
八分钟事故。

最终真实进程 Maven verify gate 的 local 与 O2 两个参数均通过。每条路径
包括 8 个不完整 command/description 批次，以及同 turn 拒绝后纠正的另一个
批次。模型在 detach/load 前后检查原始参数和有序配对错误。Broker 与 Store
proxy 观察新鲜非法批次没有 native admission/publication 请求；主 Session
的 SQL 执行账本仅有一次纠正后的执行。同 Workspace 的第二个 Session
在两条路径均完成合法调用。

此栈使用临时 H2、Embedded Broker 和真实 Node worker 进程。O2 使用真实
Java SQL grant/data 服务和 publication controller，object store 为内存
测试适配器；这不是 MySQL、OSS 或 Linux 隔离验收。受控 CLI 回归另行覆盖
/1 与 /2、两条 capture 路径、非法首尾与合法 Shell/Write siblings、持久化
失败和提交后丢回复、已有 owner 保留、真实 Hook 改写和 cold completion。
7 项 mutation（原始准入、permission 改写 preparation、PreToolUse 改写、
live/cold 顺序停止、callback 抑制、Unicode 标志）分别使对应 witness 失败。
最终回归前，源码已逐字恢复。

精确命令、环境、成功条件、结果与排查见
[本地 E2E 文档](../../../HOSTED_SHELL_UNICODE_E2E.md)。本地实施代码审查
没有 Critical，有两项 E2E Suggestion，均接受并修复。
