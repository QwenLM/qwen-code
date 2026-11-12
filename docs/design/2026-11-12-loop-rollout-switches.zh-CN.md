# Loop 灰度开关与信号

[English](2026-11-12-loop-rollout-switches.md) | [简体中文](2026-11-12-loop-rollout-switches.zh-CN.md)

- **状态**：切片 1（nightly 组）已交付为 draft PR #17050；切片 2（按入口默认值）实现中；切片 3–4 未开始。
- **跟踪**：#17045 的 B 块。阶梯、灰度规则与能力台账属于统一 loop 设计（`2026-10-23-unified-agent-loop.md`）、事件总线设计（`2026-11-11-event-bus-agent-loop.md`）和 #17045 的 A 块；本文档只设计 B 块负责的开关机制与信号。
- **核对提交**：upstream `acc07c2eb0`（2026-11-12）。

## 问题

共享 agent loop 及其事件总线内核由两个实验性设置承载，但灰度机制无法一次一个入口地放开它们：

1. **一个布尔值管所有入口。**`experimental.unifiedAgentLoop` 同时覆盖 headless、ACP、两个 TUI 和 AgentCore；`experimental.eventBusAgentLoop` 覆盖 headless。今天改一次默认值，所有入口一起动。
2. **环境变量只能强制开启。**`QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP === '1'` 时 `Config.isUnifiedAgentLoopEnabled()` 返回 `true`，否则返回设置值（`packages/core/src/config/config.ts:10833`）；事件总线 getter 同形（`:10838`）。没有办法从环境变量把某个入口强制关回去，而灰度规则要求环境变量作为切回手段。
3. **没有按入口解析。**所有调用方读同一个无参 getter：headless（`packages/cli/src/nonInteractiveCli.ts:2742`）、ACP（`packages/cli/src/acp-integration/session/Session.ts:7559`）、Ink（`packages/cli/src/ui/hooks/use-llm-stream.ts:5063`）、OpenTUI（`packages/cli/src/ui/opentui/live-session.ts:1087`）、AgentCore（`packages/core/src/agents/runtime/agent-core.ts:1101`，经由 `runtimeContext`）。
4. **nightly 信号不完整。**Linux E2E 矩阵在 schedule/dispatch 时跑 `unified` 组（`.github/workflows/e2e.yml:270`）；OpenTUI 任务（`:617`）没有 agent-loop 矩阵，也没有任何一组开着事件总线内核。OpenTUI 的 14 晚计数和每个内核默认值都在等这些组。
5. **两个对拍 off 臂没有被强制。**ACP 对拍的 off 臂删除环境变量（`integration-tests/cli/acp-agent-loop-parity.test.ts:331`），TUI 对拍的 off 臂只是不设置它（`integration-tests/interactive/tui-agent-loop-parity.test.ts:500`）。默认值一旦开启，这两个 off 臂都会跑新路径，对比就悄悄变成了同一条路径自己比自己。headless 对拍已经用显式的按臂设置强制了两臂（`integration-tests/cli/agent-loop-parity.test.ts:243`）。
6. **会话不说自己走了哪条 loop。**内核有 `[EVENT_BUS]` debug 标记（`packages/core/src/event-bus/adapter.ts:23`）；共享过程式路径和旧路径没有对等标记，`/about` 和 `/bug` 也没有 loop 行。

## 切片

除注明外，每个切片一个 PR。期限取自 #17045。

| 切片 | 内容                                                            | 期限  |
| ---- | --------------------------------------------------------------- | ----- |
| 1    | nightly 组：OpenTUI 开共享 loop；Linux 与 OpenTUI 两个开关都开  | 11-16 |
| 2    | 两个开关的按入口默认值、环境变量强制开/关、对拍两臂强制         | 11-19 |
| 3    | loop 可见性：每个入口的 debug 标记，`/about` 与 `/bug` 里的一行 | 11-19 |
| 4    | 修复 #16710；#16505、#16787、#16947 分类后关闭                  | 11-19 |

切片 2 与切片 3 在 diff 仍可评审时可以合成一个 PR；切片 4 是调查加修复，与其他切片相互独立。

## 切片 1：nightly 组

Linux 矩阵增加第三个 `agent-loop` 值 `kernel`，OpenTUI 任务加上它从未有过的同款矩阵。push 仍保持每个沙箱一组、OpenTUI 一组，push 的池与 hosted 负载不变；schedule 与 dispatch 跑全集。

**Linux（`e2e-test-linux`）。**

- 矩阵：`agent-loop` 在 push 时解析为 `["current"]`，其他事件解析为 `["current","unified","kernel"]`（今天是 `["current","unified"]`）。
- 排除：`sandbox:docker` 同时排除 `unified` 和 `kernel`（今天只排除 `unified`）；开关组与既有 unified 组一样无沙箱运行。
- `Run E2E tests` 步骤的环境变量：
  - `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP`：`matrix.agent-loop != 'current'` 时为 `'1'`，否则 `''`。
  - `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP`：`matrix.agent-loop == 'kernel'` 时为 `'1'`，否则 `''`。
- 任务名后缀：`unified` 为 ` - unified agent loop`（不变），`kernel` 为 ` - event-bus kernel`。

**OpenTUI（`e2e-interactive-opentui`）。**

- 同款 `agent-loop` 矩阵表达式、`fail-fast: false`，以及 `Run interactive E2E tests (OpenTUI)` 步骤上的同两个环境变量。
- 任务名加同款后缀。
- 渲染器仍由运行命令里既有的 `QWEN_E2E_RENDERER=opentui` 钉住；矩阵加的是 loop 臂，不是渲染器臂。

**内核组今天实际跑什么。**内核开关目前只到达 headless，所以 Linux 内核组让 headless 跑事件总线路径、其他入口跑共享过程式路径；OpenTUI 内核组让 OpenTUI 跑共享 loop（内核开关在第 3 步落地前对它无效）。这些组现在就存在，是为了让 nightly 计数开始累积，并在任何入口的第 3 步落地之前先验证接线。

**元测试。**`scripts/tests/e2e-workflow.test.js` 新增一个 describe 块，像并发 pin 求值自己的表达式那样，对 `push`、`schedule`、`workflow_dispatch` 求值真实的矩阵与环境变量表达式：push 在两个任务上都只产生 `current`；schedule/dispatch 产生全部三个值；docker 排除两个开关组；每个矩阵值在两个任务上映射到期望的一对环境变量值。既有的任务结构 pin（install 重试清单、artifact 时限、单一 build）不变，因为没有增删任务。

**headless 对拍的内核维度也被强制。**headless 对拍会 stub `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` 并用按臂设置强制两臂，但把 `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP` 留给了环境。在新的内核组里这个变量是 `1`，共享臂就会悄悄跑内核，套件对比的就和其他组不是同一对了。套件现在把内核变量也 stub 成 undefined，让它在每个组里都测量「旧路径 vs 共享过程式路径」；内核路径仍由套件里继承组环境的其他用例跑到。ACP 对拍删除 unified 变量、且不读内核变量；TUI 对拍从零构建子进程环境（`inheritEnv: false`）——两者都不泄漏。

**体积棘轮。**`e2e.yml` 当前 45412 字节，基线 45412，容差 4096 字节；新增的矩阵、env 行与后缀必须留在容差内，否则在同一 PR 里更新 `.github/workflows/.size-baseline` 并说明原因。

## 切片 2：按入口默认值与强制的对拍两臂

**解析顺序。**对每个入口、每个开关，第一条能回答的规则生效：

1. 环境变量，当它指向该入口时；
2. 显式设置（`experimental.unifiedAgentLoop` / `experimental.eventBusAgentLoop`），当它被设置时；
3. 该入口的内置默认值——今天每个入口都是 `false`；之后的 PR 一次翻转一个入口的默认值，且只翻转那一个。

**入口标识符。**`headless`、`acp`、`ink`、`opentui`、`agent-core`、`speculation`。它们命名的是 loop 入口，不是包：Ink TUI 是 `ink`，OpenTUI 渲染器是 `opentui`，跑在 AgentCore 上的子代理是 `agent-core`。

**环境变量文法。**`QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` 与 `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP` 都接受：

- `1`——强制所有入口开启（今天唯一的行为，不变）；
- `0`——强制所有入口关闭（新增；切回手段）；
- 逗号分隔的 token 列表，每个 token 是 `<surface>`（强制开）或 `<surface>=0` / `<surface>=1`（强制关/开）；列表没有点名的入口落到规则 2–3。例：`headless,acp=0` 强制 headless 开、ACP 关，其余交给设置与默认值。

token 去除首尾空白；空 token 忽略；未知入口名忽略并记 debug 日志，这样为新版 CLI 写的列表不会弄坏旧版 CLI。畸形 token（`surface=2`）同样忽略，而不是在启动时抛错。

**getter 形状。**`Config.isUnifiedAgentLoopEnabled(surface)` 与 `Config.isEventBusAgentLoopEnabled(surface)` 接收入口标识符；每个调用点写明自己的入口。AgentCore 的 `runtimeContext` 钩子传 `agent-core`。#17029 带来的 speculation 读取点传 `speculation`；两个 PR 就共享的 getter 签名协调落地顺序（后落地方适配）。共享 loop 关闭时内核开关仍然无效——解析按开关各自进行，内核只作用于 `runAgentLoop` 内部。

**设置在运行时变为三态。**CLI 不再把未设置塌缩成 `false`（今天 `packages/cli/src/config/config.ts:2920` 是 `?? false`）；core 参数变为 `boolean | undefined`。合并后的设置对未设置的键本来就保持 undefined——加载器不会物化 schema 默认值（`packages/cli/src/config/settings.test.ts:4624` 钉住了这一点）——所以运行时不需要任何 schema 改动就能区分「未设置」和「显式关闭」。schema 条目暂时**保留** `default: false`：当 schema 默认值为 undefined 时，`nextBooleanSettingValue`（`packages/cli/src/config/settingsUtils.ts:687`）对未设置布尔值的第一次切换会写入 `false`，这会翻转今天两个设置对话框「第一次切换即开启」的行为。schema 默认值在第一个入口的内置默认值翻转时一并移除，同时给对话框的未设置态一个呈现方式；Web Shell 设置面板读的是生效值而不是 schema 默认值，两种情况下都不受影响。

**对拍两臂强制。**同一 PR 内：ACP 对拍的 off 臂把环境变量设为 `'0'` 而不是删除；TUI 对拍的 off 臂设为 `'0'` 而不是省略。headless 对拍保留显式的按臂设置。有了切片 2 的强制关闭语义，`'0'` 无论默认值如何都钉住 off 臂；在切片 2 落地前，`'0'` 是惰性的（只读 `'1'`），所以对拍改动可以与机制同 PR 落地，但不能先于机制落地。

## 切片 3：loop 可见性

- 每个入口在 loop 入口处记一条 debug 标记，写明入口与解析出的路径（`legacy`、`shared`、`kernel`），走内核 `[EVENT_BUS]` 标记所用的同一个 `debugLogger` 通道，让每个入口的运行路径都能从 debug 日志证明，而不是靠假设。
- `/about` 增加一行，写明当前入口解析到的 loop；`/bug` 在它构建的报告里包含同一行。这一行由入口所用的同一个解析函数导出，不是规则的第二份副本。

## 切片 4：CI 失败 issue

- **#16710**（headless 对拍，`parallel read-only batch`，sandbox:docker）：两臂列出了不同的启动目录树。从该次运行的 artifact 复现，找出是什么在两臂之间写进了工作区（候选：rig 运行时文件、debug 日志、chat recording），修复 harness 或 loop，并分类。在证明 otherwise 之前，这一条按真实差异对待。
- **#16505 / #16787**（`an approved write, then a declined one`，Ink macOS / OpenTUI）：审批等待已由 #16881 修稳。核实该合入之后的 nightly 运行里这些场景通过，然后以「harness flake，已由 #16881 修复」的分类加证据关闭。
- **#16947**（`a retry after a model error`，Ink macOS）：启动日期已由 #16961 修稳。同样处理：核实、分类、关闭。

## 设计决定

| 决定                                    | 理由                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 矩阵值 `kernel`，该组两个环境变量都置 1 | 该组的契约是「两个开关都开」，与今天哪些入口读内核开关无关；任何入口的第 3 步落地时无需返工                                                                     |
| push 只保留 `current`                   | unified 组已经确立开关组是定时信号；给每次 push 再加两组会成倍增加池与 hosted 负载，而没有任何默认值修改会在白天读这个信号                                      |
| 环境变量列表文法带 `surface=0/1` token  | 灰度规则需要按入口强制关（切回）和按入口强制开（对拍臂、定向金丝雀）；裸 `1`/`0` 让所有既有脚本继续工作                                                         |
| 未知 env token 忽略而非报错             | 前向兼容：点名了旧版 CLI 没有的入口的列表，不能弄坏那个 CLI 的启动                                                                                              |
| 一个布尔设置仍是一个布尔                | 统一 loop 设计规定「设置被设置时用设置，否则用入口默认值」；按入口的设置会让 schema 副本（Web Shell、VS Code）成倍增加，换来的粒度环境变量列表已经提供          |
| schema 默认值保留到第一个入口翻转       | 运行时三态不需要 schema 改动（合并设置对未设置键保持 undefined）；更早移除 `default: false` 会经由 `nextBooleanSettingValue` 把对话框的第一次切换从开启翻成关闭 |
| 对拍 off 臂与强制关闭同 PR 切换到 `'0'` | 更早落地 `'0'` 是惰性的但有误导性；只落强制关闭而不修对拍，会让 off 臂在默认值翻转的那一刻开始泄漏                                                              |

## 约束与风险

- loop 契约（`AgentLoopHost`、`runAgentLoop` 选项）同一时间只有一个负责人（#17045 C 块）；切片 2 改的是 Config getter，不是契约，但 getter 签名与 #17029（speculation）共享——协调落地顺序。
- 内核组会在 K 块的取消与有界收尾落地之前每晚跑 headless 内核路径；那里的内核路径失败是信号，不是默认路径的回归，且不得阻塞其他组（`fail-fast: false` 已经保证）。
- schema 默认值保留到第一个入口默认值翻转：更早移除会改变设置对话框的第一次切换行为（`nextBooleanSettingValue`），超出切片 2 的范围。
- workflow 体积棘轮：`e2e.yml` 增长超过 4096 字节容差需要同 PR 更新基线。

## 验证计划

- **切片 1**：`npm run test:scripts:unit`（e2e-workflow 元测试，含新增的表达式求值 pin）、`actionlint .github/workflows/e2e.yml`、Prettier、workflow 体积门；然后在 PR 分支上 `workflow_dispatch` 跑一次 E2E workflow，证明三个新组启动并在开关接线下通过。
- **切片 2**：解析矩阵的单测（env × 设置 × 默认值 × 入口，两个开关，畸形与未知 token）、CLI config 接线测试、三个对拍套件本地关重试跑、`npm run build && npm run typecheck`。
- **切片 3**：`/about` 与 `/bug` 行及标记的单测；每个入口一次 debug 日志 E2E 检查。
- **切片 4**：从失败运行的 artifact 复现 #16710；三个 flake 分类的 nightly 证据。

## 验收标准

#17045 中 B 块的六个勾全部打上，每一个由已合入的 PR 或已记录的分类支撑：

1. OpenTUI + 共享 loop、Linux/OpenTUI + 两个开关的 nightly 组存在并按 schedule 运行；
2. 共享 loop 按入口解析，环境变量可强制开/关；
3. 内核以同样方式解析；
4. 每个对拍臂都被显式强制；
5. 每个入口的 loop 在 debug 日志、`/about` 与 `/bug` 中可见；
6. #16710 已修复，其余三个 issue 已分类关闭。

## 待解问题

- ~~设置加载器是否会把 schema 默认值注入合并后的设置对象？~~ 准备切片 1 时已解决：不会——合并后的设置对未设置的键保持 undefined（`packages/cli/src/config/settings.test.ts:4624` 对 `goals.modelProposed` 钉住了这一点），所以三态只需要 CLI 不再把未设置塌缩成 `false`，以及 schema 为对话框去掉 `default: false`。
- 环境变量列表文法是否接受列表内的裸 `0`/`1` token（如 `1,acp=0`）？本提案说不——整值形式已经覆盖「所有入口」；在有调用方需要更多之前保持文法最小。
- #17029 的 speculation 读取点：切片 2 在它之前还是之后落地？后落地方适配调用点；入口标识符 `speculation` 无论如何都预留。
