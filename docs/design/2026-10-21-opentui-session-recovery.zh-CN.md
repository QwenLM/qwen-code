# OpenTUI 会话恢复、重试与记录

[English](2026-10-21-opentui-session-recovery.md) | [中文](2026-10-21-opentui-session-recovery.zh-CN.md)

## 状态与源码边界

**当前检查点（2026-10-23）：#14959 已合并；#15283 仍为 Draft，现已整合 main `56733c35`。** restore 接纳/自有历史行发布与工具本地完成修复均已提交。整合后的 `5cb491f5` 通过正常 build、包含集成测试的完整 typecheck、fresh bundle、382 项受影响 CLI 测试及 65 项受影响 core 测试，均零跳过。此前 902 案完整 CLI 回归和 Node+Ink/Bun+Ink/严格 OpenTUI 的 H11e 对照保留精确源码归属。H11e 在新整合的严格 OpenTUI bundle 上再次通过：工具执行一次、自动模型请求为零、显式后续请求一次、checkpoint 不变、自然退出为 0。另一个真实模型 read→edit 探针确认了剩余缺陷：Ink 在待审批时生成完整 checkpoint，OpenTUI 到达相同审批状态却未创建文件。完整 checkpoint 创建/恢复、最终组合安装产物及平台验收仍待完成，PR 尚不能正式送审。本次 main 已包含 #15305 对继承的 Java CI 问题的修复。

已完成的审查修复保留现有 history 与 turn 所有权。剩余门禁包括完整 checkpoint producer/consumer 链、真实挂起 restore 的取消与后继保护、当前 head CI，以及最终 npm/standalone 安装产物和受支持平台/PTY 验收。历史结果继续保留对应源码与运行时身份。C 批次不改 Bun/OpenTUI pin、默认 renderer 或 recording schema。

**历史 shell 修复检查点（提交 `044c1073` 前）：#15283 当时仍为 Draft，基于已提交的 `3301fee0` 加 shell 生命周期、本地键盘取消及重试文案工作变更。** 精确已提交 head 的 Linux CI 通过 no-flicker、20 个组件 validator 和三腿每腿 42 个产品用例；这些重叠执行不与历史本地总数相加。当前工作修复通过三个受影响的完整 CLI unit 文件（482 案、零跳过）；未改变的受影响 workflow 元测试文件通过 41 案。此前工作产物通过正常 build/type/bundle、Node22 + Ink 与 strict Bun + OpenTUI 的 held-shell Retry 接纳门禁，以及 Ink 英文倒计时精确文案。随后真实 OS 取消合同在 Node22 + Ink 上通过，在 strict OpenTUI 上失败：Ctrl+C 后已观察的 shell 仍存活，直到 fixture 清理时释放才结束。新增实际捕获 signal 的回归也在本地按键接线修复前失败。因此该整合迭代要求重新执行正常 build/type/bundle，并在精确同一新产物上验证真实终端取消、后继及自然退出合同。原产品失败和 fixture 未完成观察继续分别记录，不算本修复的通过结果。既有源码 bundle 与安装结果保留原产物归属；不改 runtime pin、依赖、默认 renderer 或记录 schema。

**上一交付检查点（保留）：基于 `4d57a2d218` 加三处生产修复的会话恢复 Draft 批次。** 修后源码通过三个完整 unit 文件的 736 案及 fresh build/type/bundle 验证。最终采用 readiness helper 的持久测试结果为 **18 案通过、零跳过、24 次完成 HTTP 和 30 次自然 exit0**。六案覆盖具名 H02a/H02b 冷恢复、H01b rewind/rollback selector 与冷召回，以及 Node24 + Ink、Bun1.3.14 + Ink、strict Bun1.3.14 + OpenTUI 的 H15 quit/exit summary。这些属于源码 bundle 结果，不是完整 H01–H15 或安装产品验收。本批次及父 PR #14959 仍未合并；最终安装产物与平台门禁仍未关闭。不改生产运行时、依赖、默认 renderer 或记录 schema。

**早期验证检查点（保留）：** 此处证据归属本地 `6c3c63584c01cf0a5b421aa719e6ff1df8a23700` 加冻结的七文件 v4 工作补丁 `1c4f3277b4b0e7364b5e0cee706a2750db02cbade38c66e092202feb6c7d8319`，不是已提交的最终候选。Build、typecheck 已通过；25 个 CLI 完整文件共 1,514 案全部通过，无失败、跳过或 bail 未执行。Native 组件验证通过 26 个捕获帧、19 次输入和两个精确回调。新的 WIP 源码 bundle 已通过，CLI SHA 为 `53859bf54605e32e3c594c95fc6f040d6e53644bb69f79ffad467ac95d911cf1`；它不是已安装的 npm 或 standalone 产物。不新增 core API、依赖、记录 schema 或第二个历史 owner。

本状态检查点已通过 Node 22 + Ink、Bun 1.3.14 + Ink 和 strict Bun 1.3.14 + OpenTUI 三腿各自的 `/quit` 与 `/exit`，共六案源码 bundle H15。每案恰好一个真实模型 HTTP 请求，在 teardown 前展示告别标题、交互统计和墙钟时长且无输入框，并自然退出 0。六案源码 bundle 汇总 SHA 为 `1cde10ab1e7593eb86282014b5c870ed8313e177aab5658cfd915f1bb3b65dfc`。六案通过不关闭其他退出别名、持久日志冷召回、H01–H14、安装产物或平台门禁。精确收据汇总见下文。

PR #15067（交互/输出）、#14046 和 npm 分发 PR #14959 均已合并。#14959 的早期 stacked 基线为 `cf0bb9d6db84594020951c88d9970ff46d357856`，当前 C 已整合其合并后的 main。早期本地依赖验证仍归属此前基线，不是新的整合候选验收。早期父批次失败保留其历史归属，不能在对应修复已被接受后继续误列为当前阻断。

Phase 4 固定历史参考（`~/.local/bin/qwen` 0.22.0 及其私有 Node 22.23.2）已一次通过 H01a、H01b、H09a：7 个真实 PTY、7 个模型请求、7 次 `/quit` exit 0。该参考不是操作者当前默认 global 命令，也不代表当前 C 或 Ink 验收。原失败与 blocked 版本保留于 ignored 证据；最终汇总为 `.qwen/investigations/session-recovery-global-outer-v6/historical-baseline-summary.json`。

d677 的正常依赖 setup 已通过，使用固定 Node 24.19/pnpm 11.24 和共享 store，安装了 Husky，但未运行 build 或测试。收据为 `.qwen/investigations/c-d677-setup-v1/20261021T143821Z-7fc8df-install/independent-receipt.json`。并行源码改动明确不在该安装守卫的验收范围内。

源码对照为 Ink/main `a0e414945502b1d08ec969d7d3f59d6a1e96bdd7`。只读调查已将 42 个文件与精确提交核对；16 个共享文件中 15 个与 main 逐字相同，剩余 AppContainer 差异是父批次 Vim 提交时清空 buffer。这是源码证据，不是新的运行结果。这是最初计划检查点；其中父批次阻断已由后来合并的 #15067 处理。当前验证使用上文独立列明的源码与补丁边界。

本方案沿用既有会话/记录/恢复/transcript 提案及全部 H01–H14 案组。早期结果，包括 Markdown 下划线差异与同会话 reset 修复，保留为历史证据，不能当作新树验收。原调查 checkout 中的 ignored 记录为 `.qwen/investigations/session-record-recovery-transcript-20261021/` 和 `.qwen/investigations/session-recovery-scope-b23f1-main-a0-v1/`。本树新的可执行基线规格位于 `.qwen/e2e-tests/2026-10-21-opentui-session-recovery.md`。

早期验证检查点收据锚点：build `c3a38ed7`、typecheck `4dd86b41`、完整 CLI `9b3c8648`、native 组件 `01ec0686`、WIP bundle `ff4aaabb`；H15 NodeInk quit `edf27265`、NodeInk exit `f2a36835`、BunInk quit `b00925a3`、BunInk exit `4c776a6e`、strict OpenTUI quit `557c6a49`、strict OpenTUI exit `1ca2f20c`。完整路径与 SHA 保留在 ignored 控制台账。原 logger 环境、transcript/routing 与 native fixture 的 FAIL/BAIL 证据全部保留；后续通过仅覆盖明确绑定的后继组合。

## 问题与完整交付边界

OpenTUI 已经能加载会话、持有结构化输入队列、运行模型/工具轮次并写入双路输出。剩余会话操作尚未一致使用同一 prompt 身份、输入来源、可见历史、core 历史及项目输入日志。因此，用户可能看到恢复后的对话，而历史资格、重试或后续 rewind 仍使用不完整投影。

一个完整交付将贯通输入记录与回忆、resume/branch 投影、取消恢复、失败 attempt 重试与跳过重试延迟、真实 rewind、checkpoint `/restore` 及已删会话日志清理，同时保留 Markdown 和长 transcript 的既有验收范围。这些操作共享会话与 turn owner；按按键或对话框拆成多个 PR 会留下跨版本的不完整事务。

最初预计整体约 **3,000–4,550 行变更**，包括生产代码、定向测试和双语设计。当前完整批次为 **8,240 行变更**、56 个文件（净增 6,830 行），包含完整恢复事务、审查修复和回归覆盖。共享会话事务与大量回归保持整批，不删测试或拆成零碎 PR 凑行数。较窄的事务核心本身更小，但不能在 `/restore`、Markdown 或长 transcript 案组被遗漏时宣称完成。若已验证的 Markdown 缺陷需要修改库或重构渲染器，应保留失败证据并重新裁定该依赖范围。

### 包含

- 普通、slash、shell 的适当处理点恰好写一次输入日志；跨重启与删除后回忆顺序正确。
- 当前轮次、重放、branch、restore、rewind 全链保留 prompt 身份及显示/来源元数据。
- 安全的无输出取消回滚与恢复，不消费后继草稿或过期会话。
- Ctrl+Y 跳过重试延迟，以及通过现有 core 行为重试实际失败 payload。
- 接通真实会话/文件 rewind selector、操作及 checkpoint 工具重放。
- 保留 H13 Markdown 语料与 H14 长 transcript/picker/window 回归范围。

### 不包含

不新增运行时、依赖包、渲染器、记录格式、core API、daemon route、通用 session controller 或平行队列。Node/Bun 支持与 OpenTUI `0.5.10` 保持不变。现有 native undo、parser 所有权、权限决定及双路输出协议保持不变。尚未成为 OpenTUI 实际 producer 的后台 Goal/teammate 重试协议不在本批新增。语音作为同一草稿/会话 owner 的后续消费者保留，本批不实现麦克风或 ASR。

## 现有 owner 与具体缺口

除特别说明外，下表路径均位于 `packages/cli/src/ui/`。这些是最初计划基座的源码观察。下述接线保留最初计划基座的观察。当前完整文件和组件验证仅覆盖具名源码接缝；历史校准与源码测试不关闭真实产品义务。

| 范围               | 现有 producer 与 consumer                                                                                                                                               | 最小接线                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 草稿/来源          | `opentui/input-submission.ts`、composer、`live-turn.ts`、`live-session.ts` 已传递 model/display/submitted 文本、human/unknown 标志、paste 映射、图片及 restored draft。 | 恢复与重试继续保留这些字段；不发明 `InputSource` 协议，也不从展开后的模型内容推断真人输入。                |
| 输入日志           | `hooks/use-llm-stream.ts` 在 Ink slash/shell 处理前写日志。OpenTUI 在 `start-opentui-ui.tsx` 创建 `useLogger`，但没有 `logMessage` producer。                           | 将现有 logger 交给实际处理 owner；区分普通、命令、shell、队列接管与 Retry。                                |
| 删除               | `dialogs-misc.tsx` 使用 `useDeleteCommand` 时未传其已有可选 logger；共享 hook 已按成功 session ID 清日志。                                                              | 从真实挂载链传入 logger；保留部分失败、活跃会话拒绝和现有持久化回滚。                                      |
| Resume/branch      | `session-switch.ts` 已加载恢复状态、切换 core、重建 turn boundary、初始化、提交 UI，并回滚失败。启动 replay 也已存在。                                                  | 复用该事务，修复 replay 投影，不另写会话 loader。                                                          |
| Replay 身份        | `transcript-adapter.ts` 丢失 user prompt ID 与模型 turn 资格；共享 `utils/resumeHistoryUtils.ts` 已投影这些字段和附件。                                                 | 复用标准分类/投影，将元数据保留在已有 neutral event 中。未被调用的 `resumeUserPrompts*` 不能证明生产覆盖。 |
| Slash 资格         | `commands-dispatch.ts` 后续将 host invocation 标记为 `sentToModel`，但 `opentui-host.ts` 的更新未同步初始为 false 的 live row。                                         | 更新同一个已标识行，并对生成提交使用同一 prompt ID；回忆资格与模型 turn/rewind 资格仍分别处理。            |
| Cancel/retry       | Composer 已恢复结构化输入并保护 pending successor；live-turn 有 tool-start guard，但缺少 Ink 完整无输出回滚。RetryInfo 保存 `skipDelay`，键盘没有 consumer。            | 只在现有 turn owner 补充下述操作真正需要的所有权和失败 attempt 信息。                                      |
| Rewind             | `opentui-dialog-mount.tsx` 仍挂载占位组件；`session-rewind.tsx` 中已有完整 selector 没有生产调用。                                                                      | 挂载 selector，复用标准身份映射、文件 rewind、core 截断及 recording 分支操作。                             |
| Checkpoint restore | 共享 `commands/restoreCommand.ts` 恢复文件/历史并返回工具重放；OpenTUI host 替换历史没有替换 live row，shell 也没有执行返回的 `schedule_tool`。                         | 将现有历史替换、scheduler 工具重放恰好接通一次；区分本地结束与显式模型提交，与 rewind 分开验收。           |

## 共享状态与操作合同

### Prompt 身份与输入来源

继续使用 `OpenTuiInputSubmission`、`OpenTuiRestoredDraft` 及现有字段。`text`/model parts、`displayText`、`submittedPrompt`、`humanInput`、`hasUnknownInput`、paste expansions 与图片所有权是不同事实。当前会话取消保留完整结构；历史导入和 rewind 草稿在来源未知时继续标记 unknown。展开后的 `@` 内容、系统提醒及 placeholder 文本不能证明是真人输入。

代表模型 turn 的可见 user row 必须保留 prompt 身份与资格。重复的相同文本不是身份键。UI-only slash 可以进入输入回忆，同时仍不具备 rewind 资格；当前会话内发给模型的 slash 保留原始 invocation 用于回忆，并对生成内容使用同一已标识 turn。压缩边界及旧版/缺失 ID 按共享标准映射处理，不得用位置扫描或文字匹配替代。

当前 core 的 slash-record writer 不在 invocation record 上写入 prompt ID。存在该字段时保留它只是兼容读取，不代表 writer 合同已经闭环。模型 slash 的冷重放可能同时包含 invocation 与稍后的 generated user record；H01/H02 必须以真实当前 Ink journal 和 rewind 资格校准后才能关闭。本批不新增 core recording 字段，也不按相同文本推断身份。

保留父批次已稳定的 user-message 投影：实际 user 序列未变时，assistant/info delta 不能重置 Ctrl+R 选择；真实 user、`recallText`、`sentToModel` 或顺序变化仍必须使投影更新。

### 记录、回忆与删除

使用现有项目 logger，不建第二份日志。实施前明确每条路径唯一的写入 owner：

| 路径                         | 计划日志行为                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| 开始处理的普通 prompt        | 在对应 Ink 处理点恰好写一次 display/原始 submitted 文本。                           |
| 已处理的 slash 或 shell 输入 | 恰好写一次原始输入，不再另记生成的模型展开内容。                                    |
| 队列输入                     | 仅接管不写日志；后续处理时由实际 owner 写一次。                                     |
| 拒绝接管、恢复草稿或 render  | 不写日志。                                                                          |
| 显式 Retry 或跳过重试延迟    | 不重复输入日志；JSON attempt event 有下述独立合同。                                 |
| 已接受 steering              | 在现有 core 实际接受点记录一次输入；不重复其 JSON event 或 conversation recording。 |

Slash/shell 失败的精确记录时机属于基线，不可据此静默丢弃失败命令输入。保留 newest-first 去重后按时间顺序呈现，以及旧 prompt 再次提交后提升为最新。操作捕获对应 logger/session；旧完成回调不能删除新会话的最后一条日志。

Accepted-steering 输入记录明确补齐 Ink 的遗漏：已检查的 Ink 接受回调写 conversation recording，但没有写项目输入日志。C 只在实际接受后对每个条目写一次，同时使旧 prompt 失去删除最后输入日志的资格。拒绝、恢复和取消的队列项不写；既有 accepted-user JSON 和 journal producer 不变。这是显式 parity 例外，不声称与 Ink 完全相同。

删除复用现有 batch hook 和 logger purge，只移除实际成功删除的非活跃 session ID。活跃会话拒绝、部分成功、cache 失效、重启持久性与 logger 写入失败均保持可观察；不无条件宣称成功，不新增全局订阅。

### 取消与 reset

遵循真实 Ink 无输出合同：只有当前 attempt 实际拥有的 user row、没有有意义输出、没有已启动工具、没有队列/后继冲突，并满足对应空草稿条件，才允许回滚。使用同步的 meaningful-content 观察，不等待下一次 React render。文本/图片输出有意义；纯 thought 在当前 Ink 取消逻辑中是 synthetic，必须单独校准。

标准命令结果投影为普通 info 行时，保留共享 Ink 对原始记录的 synthetic 分类。`/status` 等有意义结果携带 `historyIsSynthetic: false`，经过实时、重放及 rewind 消息的折叠仍保留，包括没有 history ID 的事件。普通 info 保持原有未标注形状和 synthetic 缺省行为。此元数据来自原始 history item，不根据文本或 ID 猜测，也不是可配置选项或 JSON 输出协议变更。有无 logger 时取消都保留有意义结果；普通 synthetic 通知仍可回滚。磁盘日志的删除资格保持独立。

符合条件时删除精确的可见行、调用现有 core orphan-user 清理，并移除匹配的输入日志。否则保留已有内容，通过既有结构化 composer settlement 恢复输入。保留父批次 generation guard、同 ID 的 `kind: 'reset'`、pending-image 所有权、accepted steering 和 successor 恢复。Reset 只清理过期 claim，不能当取消去 pop/restore queue。旧 `finally` 不得清理或 finalize 下一轮。

四种记录必须分开：可见 transcript、内存 core history、项目输入日志、持久化 conversation journal。当前 Ink 取消链没有调用 `rewindRecording`，所以本设计不承诺无输出取消会物理删除 journal 记录。冷 resume 行为需先做 characterization；若是共享 Ink 缺口，应明确裁决，不能只给 OpenTUI 偷加 journal 删除。Dual-output JSON 保持 append-only，不追溯擦除已输出事件。

### 重试与跳过延迟

Shell 执行会晚于提交预处理结束。直到执行 promise settle 前，保留其既有 generation activity，并将捕获的 controller 登记在现有取消集合中。取消必须到达实际传给 shell 的 signal；旧的已取消 shell 完成时，不得清除后继的 busy 状态或 controller。复用现有活动计数和 same-controller 检查，不新增第二个 controller 或历史 owner。OpenTUI 独立拥有 shell 执行：既有 shell-controller 集合必须在进入 live 模型重试回调前拒绝 Retry，与普通提交和队列排空已有门禁一致。OpenTUI 倒计时采用 Ink 既有翻译模板及 attempt 格式，不能用放宽测试匹配替代真实可见差异的修复。 本地 shell 取消仍由该既有 controller 集合负责：普通 composer 按下 Ctrl+C 或 Esc 时 abort 集合，key-release、前台模型 turn 及活动中的对话框或确认框保留既有 owner。不能为了清空重试状态而把本地取消错误转交模型 interrupt。普通 pipes shell 合同不证明内层 PTY 输入、resize 或 focus 一致性（H13）。

Ctrl+Y 优先恰好消费一次当前重试延迟 callback；不 abort 请求，不产生新提交或 user event。Reset/cancel 使 callback 失效。正在提交、等待权限、没有失败 attempt、重复按键均有明确结果，不能意外落入默认重试。

终态失败保存该 model/tool-result hop 实际送出的 prepared payload 及 prompt ID，再使用已有 `SendMessageType.Retry`。不能重新展开 slash、再读 `@` 文件、重转图片、重复 accepted steering，或把 Retry 当 Enter/`UserQuery`。复用 core 的 orphan 处理、文件读取失效、turn 预算和 tool-call/result 配对。在已接受 steering 合并后捕获最终 payload；未接管的队列项仍可恢复。

遵循当前模型选择行为：inline override 清回 session model 并提示，skill override 保留。显式 Retry 每个 attempt 恰好发一次已有 JSON user event；跳过延迟不发新 user。权限与 accepted-steering 输出仍在真实决定/接受点产生，不能为复制 Ink 镜像缺口而回退父批次已经明确修正的 deny response 和 accepted-steering 行为。

### Resume、branch 与 checkpoint restore

Resume/branch 保留现有 core-before-UI 事务和失败回滚。复用共享 resumed-history 投影，让可见行、附件、prompt ID、模型 turn 资格、title/usage 和下一请求指向同一选定会话。Branch 创建独立会话，原会话不变。启动 `--resume`/`--continue` 与交互 resume 仍分别验收。 启动只转换一次标准历史并应用现有折叠策略，将完全相同的来源 ID 同时交给 command host 与 live projection，再添加警告。新会话历史为空；旧记录沿用共享的缺失 ID/模型资格 fallback。转换失败走启动已有的清理和回退路径。新增 host 行不得与已恢复 ID 冲突。

每个投影的 host 行携带原有 `historyId`；rewind 同时截断来源 host 前缀与 live 前缀，后续 `/history expand-now` 不能复活被移除的命令输出。这是来源关联，不是新历史存储。已检查的基座没有注册 `/chat save` writer，本批不发明该能力。

折叠恢复行在同一个 live 数组保留原有 display 元数据；只有 transcript renderer 过滤隐藏行，selector 和 rewind boundary 仍读取它们。Rewind 与 `/history expand-now` 去掉 suppression 和 summary 行，并保留富记录内容。只有 expand 命令向现有 history-load seam 传显式 `expand` mode：OpenTUI 在当前 live 数组折叠仅改变显示的 event，保留后续 turn、行 ID、stream 状态及排队输入。普通 restore 仍执行替换/reset，Ink 原有完整 history loader 保持兼容。现有 context-files announcement latch 按 startup、恢复或回退后保留行重算，已有公告不会重复，回退移除公告后允许下一次公告。Compression 保留完整 kind/status，边界 ID 使用原始完整快照的下标。

Checkpoint `/restore` 是另一种操作。记录携带 `promptId` 和 history 时，保留共享次序：恢复自有文件、拒绝部分恢复、替换 pending/history、恢复 API prompt ID，然后恰好执行一次返回的工具重放。将 host 历史替换接到 live view，同时避免对已有显式 reset 的 resume/branch 再次 reset。缺失 checkpoint 文件、无效 `toolCall` 及旧版 `commitHash && !promptId` 格式按现有拒绝语义处理。只有合法 toolCall 的 checkpoint 仍受支持：恰好调度一次工具，不执行文件 rewind 或 UI/core history 替换；工具在本地结束，不自动请求模型，显式后续输入可请求模型一次且不得重复执行该工具。不能将可选 history 或 `promptId` 缺失一律变成新的拒绝条件。

Checkpoint 的迟到结果守卫核对现有 session、idle、取消信号和来源历史快照。Ink 经 React 发布 `loadHistory`，OpenTUI context 则复制 host 数组，因此守卫接受明确请求的标准行引用，以及尚未发布时未变化的旧快照和本操作自己的 notice。同会话的新历史或新 turn 不能重放旧工具。使用真实 history hook 的 deferred 测试覆盖发布时序与后继拒绝。

### 会话与文件 rewind

将 `/rewind`、`/rollback` 和现有空输入 double-Esc 路径接到真实 selector，保留 dialog/IDE 门禁。已由共享提交 owner 接纳的内置命令，可以在自身预处理产生的 Responding 状态打开 selector。通过命令注册表克隆后仍保留的内置 action 引用识别，并沿已有 callback 桥接传递内部命令来源；同名替换命令不享有例外。工具确认和默认/键盘路径仍要求 idle。在等待 recall 写入后、修改 undo 所有权或派发命令前，重新检查该次提交捕获的取消信号，避免旧的已取消提交在后继请求上打开 selector。其他异步命令的预处理仍保持 busy，模型响应进行中也不接纳新的 rewind。已标识的当前 turn 来自 live transcript，不能只用命令 host history。变更前调用 `computeApiTruncationIndex` 和 `isIdentifiedRetainedTurn`，按共享 helper 拒绝歧义或压缩后的身份。

selector 消费父弹窗区域的真实高度，保留正常尺寸的七项上限及已有 label/value 样式。紧小终端与 resize 复用现有 frame/chrome 和选择窗口 helper：只有当前窗口实际绘制了 target/action label，Enter 才能推进或恢复；空字符串、纯空白及截断后仅剩省略号的 label 不得提交；源首行本身就是省略号时，只要未被截断并实际绘制，仍是合法 target。区域扩大后，同一选择重新可用。确认画面与按键仍由 phase 状态持有，现有 restore/session/history 事务 owner 不变。三个定向完整文件已通过 68 案，后续对 25 个受影响 CLI 测试文件的完整运行通过 1,514 案。Native 组件验证捕获 26 帧并观察到预期有界区域。这些源码/组件结果不证明安装产物 PTY 的 viewport 裁切或完整 H09 渲染一致性；原 routing 与 native fixture 失败仍保留。

存在 model client 时复用当前 Ink 次序：校验会话切点、按选择 rewind 文件，然后才截断允许的 core/UI 状态，并通过 `rewindRecording` 移动记录分支。保留没有 client 时的明确分支：conversation-only 失败；combined 仍尝试恢复文件、保留会话/snapshot 历史，并提示已跳过会话 rewind。Code-only 保留会话和 snapshot 历史；combined 操作部分文件失败时不得截断会话。Recording rewind 重新挂接已有 journal ancestry，而非删除任意 JSONL 后缀。若需避免复制验证与失败次序，可小范围抽取已有 CLI 操作供两 UI 共用；不计划改变 core API 或大范围搬迁 hook。

共享 CLI 事务由两个真实 consumer 使用。迟到文件操作核对现有 session 与当前历史身份；OpenTUI 同步读取 live refs，包含 React 尚未 commit 的窗口。Rewind 返回真实保留数组，每条自有 notice 再返回下一个真实快照，供延迟草稿注入核验。同 ID reset 或新 turn 使两者失效，不向后继恢复旧草稿或写入 notice。失效前已恢复的文件仍是实际副作用，stale 不等于文件已回滚。UI 截断先于 conversation recording rewind，记录移除数量取自真实 live 前缀。

### Markdown 与长 transcript

保留 H13/H14。早期真实 PTY 对照发现 OpenTUI 显示 `HELD_HEAD_1HELD_TAIL_1` 时丢失下划线，这是可见渲染观察，不是 HTTP 或取消丢字节的证据。应在新 artifact 上先捕获 streaming/settled 的 source/output 阶段，再选择最小修复；同时覆盖合法 emphasis、code、path、CJK、link、table，防止保留字面下划线破坏正常 Markdown。

长 resume、head/tail 导航、滚动、resize、展开代码和 render failure 复用已合并的 transcript windowing 与 picker。不能复制原 checkout 的旧 dirty patch，也不替换虚拟化视图。若缺陷无法在不改锁定库或架构的前提下处理，保留失败案组并重新请求范围裁定。

## 实施顺序与依赖

1. 冻结已接受的父批次后继、共享源码引用、fixture 数据及分支清单；先跑 global 基线，再跑当前本地 Ink 校准，保留真实失败与有意差异。
2. 接通 logger 和标准 replay/host projection 身份；复用现有挂载服务，每个新 callback/字段均有实际 producer 和 reader。
3. 扩展现有 attempt owner，完成无输出回滚、prepared-payload Retry 与延迟消费；保留 composer/native undo、queue、reset、dual-output 所有权。
4. 接通真实 rewind selector 和已有操作、checkpoint 历史替换/工具重放、delete purge；仅在避免重复事务确有必要时抽取小范围 CLI 共用过程。
5. 根据实测失败完成保留的 Markdown/长 transcript 范围，再运行完整矩阵并做两次干净的全 diff 审阅。

预期生产触点为现有 entry/shell/composer、live-turn/live-session、event/item/replay projection、host、dialog mount/delete、rewind 接线。Core Logger、SessionService、FileHistoryService、client history、recording 方法是复用依赖，不是计划改动。若需要新 core 合同、记录 schema、daemon route 或整体搬迁 `useLlmStream`，应停止扩大并交维护者审查。

## 验收矩阵

Ignored Phase 3 计划将下列稳定案组展开成命名分支。当前源码/补丁组合上的 H01–H14 **完整产品案组仍为 NOT_RUN**；具名完整文件/组件结果和六案 H15 源码 bundle 通过不关闭这些案组。上文 H01a/H01b/H09a dry-run 继续只归属历史参考。基线例外与候选通过分别报告；跳过一个分支不能关闭其案组。

| 案组                     | 必须验证的行为与反例                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01 — 记录与回忆         | 普通/重复输入、local slash、model-sent slash、shell、重启顺序、原始文本及不同的 rewind 资格。                                                      |
| H02 — 来源重放           | 图片、typed `@`、accepted/restored steering、重复文本、prompt ID、display/model 分离与 resume 后 known/unknown 来源。                              |
| H03 — 无输出取消         | 真实请求取消、精确 owned row/core/log 回滚、结构化重提、纯 thought/info 与冷 journal characterization。                                            |
| H04 — 内容取消与后继     | 保留 text/image/tool 内容；queued/accepted/restored 输入、pending paste/image、late callback、同 ID reset 与新会话后继隔离。                       |
| H05 — 重试延迟           | 真实 RetryInfo 倒计时、Ctrl+Y 一次、reset/cancel 失效、无额外请求/user event、busy/permission 门禁。                                               |
| H06 — 终态重试           | 同一 prepared parts/prompt ID；普通、image/`@`、tool-result、steering、model override；重复按键/无失败正控。                                       |
| H07 — Resume             | 交互及启动 resume/continue、visible/core context、title/usage、异常/缺失数据、late callback、失败回滚。                                            |
| H08 — Branch             | 独立 session/ancestry/title、原会话不变、fork 失败清理与提交前回滚。                                                                               |
| H09 — 会话 rewind        | 真实命令/alias/double-Esc、折叠隐藏 turn 与重复文本身份、unknown 草稿、同步 stale/new-turn/notice 守卫及 cancel/busy/IDE/压缩/歧义门禁。           |
| H10 — 文件 rewind        | 工具真实编辑文件、code-only 与 combined、snapshot、精确文件字节/模式、部分失败、无 client 时仅恢复文件、不错误截断会话。                           |
| H11 — Checkpoint restore | 真实 checkpoint、精确替换 history/API ID、一次工具重放、toolCall-only 零自动模型请求及一次显式后续请求与精确 missing/legacy/partial-failure 拒绝。 |
| H12 — 删除               | 非活跃成功与重启 purge、活跃拒绝、部分 batch 和持久化失败对照。                                                                                    |
| H13 — Markdown           | 字面下划线回归、真实 emphasis/code/path/CJK/link/table 对照、streaming/settled frames、source 字节及 render-error 归属。                           |
| H14 — 长 transcript      | 长 resume 与 picker preview、head/tail/window/scroll/resize/expanded code、稳定选择与有界渲染。                                                    |

参考矩阵先解析实际 launcher/runtime 后运行 global `qwen`，再用同一本地 artifact 分别运行 Node 24.19 + Ink、Bun 1.3.14 + Ink、Bun 1.3.14 + strict OpenTUI。历史参考版本来自实际执行发现。早期六案 H15 检查点使用其绑定 WIP 源码 bundle 的 Node 22 + Ink、Bun 1.3.14 + Ink 和 strict Bun 1.3.14 + OpenTUI。当前具名六案、三腿范围已在上文说明；这些通过不证明其余 C/Ink 产品合同。Strict readiness 必须证明所选渲染器；仅证明没有 fallback 还不能证明所有操作合同。

使用自有配置/工作区、真实 PTY 输入与模型 HTTP、实际日志/journal/文件证据、精确请求数量和值、fresh PID/start 身份。普通完成用 `/quit` 并精确断言 exit 0；raw Ctrl+C 与 active cancel 分别校准。以有界 deadline 等待真实协议/退出事件，不以固定 sleep 或已可见 prompt 判断完成。测试在共享 heavy lease 下串行执行，retry 0、单 worker、unhandled error 致失败、保留首败并提供清理证据。

## 风险、例外与完成门槛

- 已合并的 #15067/#14046 与本地整合、已 Ready 但仍未合并的 #14959 具有不同依赖状态。父源码改变后需重新绑定源码/产物证据；本地验收不证明远端已合并。
- Ink 已知 deny JSON 镜像缺口与父批次 accepted-steering 事件补齐仍是明确有意差异，不新造协议，也不为逐字 parity 削弱已有修复。
- 无输出取消后的 journal 冷重放、retry 后 rewind 身份、纯 thought 时序和命令失败日志需精确当前 Ink 校准；本设计未宣称新增已实证 Ink bug。
- 具名 CI 用例以外的 Linux 场景、Windows、sandbox 文件系统行为、真实麦克风/权限/音频设备、WebSocket ASR，以及本恢复批次的安装版/发布版本升级验收仍为 NOT_RUN；macOS 自有 fixture 或组件测试不覆盖这些能力。
- 即使 renderer 依赖延迟交付，H13/H14 仍可见；没有预先授权新增库、版本或默认行为变更。

Ready 需要已接受父批次、完整同步双语设计、global/当前 Ink 基线、变更路径的有意义复现、正常 full build/typecheck、定向 owner/projection/native 测试、三个本地腿的所有适用 H01–H14 分支、明确例外处置、source/artifact/runtime 身份和清理，以及两次连续干净的全 diff/consumer 审阅。实现和最终 PR 仍作为一个完整会话事务交付。历史 dry-run 与 setup 收据只满足各自具名前置条件；当前具名源码/组件门禁和六案 H15 源码 bundle 已通过，但完整 H01–H14、其余 H15 分支、冷日志/journal、安装产物与非宿主平台仍未关闭。同候选 Ink 与 OpenTUI 的真实 held-shell/Ctrl+Y 安全合同均失败。另行构建的 main `7547326` 与生产源码等价于 `3301fee0` 的历史 bundle 也在原 Node22 + Ink held-shell 接纳合同上失败：真实 pipes shell 持有期间 HTTP 从 1 增至 2，随后自然 exit0。这确立了实测的共享 Node 行为，既不豁免安全门禁，也不确立 main 的 Bun 行为。工作修复必须在新构建的实际产物上通过未放宽的原 Node 与 strict OpenTUI 合同。

### 清理前的退出展示

共享 quit/exit 结果提供用户消息、时长和 ID。OpenTUI 入口用当前会话统计快照投影这些原始消息，交给已有 transcript view，替换普通应用和输入框。临时展示不追加 host history、logger、录制、JSON 输出或模型输入。第一次退出请求独占转换；展示提交后保留与 Ink 相同的 100 ms 呈现窗口，然后调用既有退出生命周期。卸载会取消该定时器。设置重启传入空消息时立即退出，不制造摘要。既有 Ctrl+C/Ctrl+D 中断退出及渲染错误退出保持退出码和清理路径。

验收必须观察实际安装的 strict renderer，在离开 alternate screen 前展示告别标题、交互统计与墙钟时长，并在恰好一次模型请求后自然 exit 0。退出后的 resume 回显是独立证据。入口测试覆盖传入时长、输入框替换、录制/提示计数控制的 resume 提示、重复请求、空重启与定时器清理。在旧 c395 源码加候选 patch 622bcbc8d769170a9505f0441165d3315db878881ac9bc0ebd33939cfa2ecd3a 的组合上，四个完整源码测试文件的 217 案全部通过；原 stock-status 取消探针的 1 个选中用例通过，另 66 案精确未选中。这些结果仅覆盖该旧源码组合。当前 v4 组合已有上文具名 build/type、1,514 CLI、native 26 帧、WIP bundle 及六案 H15 源码 bundle 通过；真实安装产物 PTY 与其他 H15 分支仍为 NOT_RUN；原始失败与后续源码修复证据全部保留。

### 回放中的结构化压缩标记

canonical 回放将每个压缩标记保留为一个已有 compaction 行，携带完整 token 数、估计标志、状态、类型、canonical history ID 和恢复展示策略。折叠标记保持隐藏但仍供 rewind 使用；展开标记使用已有压缩渲染。fast 与摘要压缩保持可区分，共享 rewind 映射因此仍能排除 fast 作为 API 截断边界。live 命令 info 投影与 provider 的上下文自动压缩通知保持不变；回放重置整个 transcript，不追加第二份。原 collapsed fast/summarize 回归断言未改。旧 c395 加 patch 622bcbc8 的 217 案源码结果包含原 fast/summarize 断言及新增精确事件/身份回归，不能算作当前 main/B 整合通过。当前 v4 的 build/type、CLI 完整文件及有界 native 组件帧已在具名范围内通过；完整 replay/native/安装产物 PTY 产品验收仍为 NOT_RUN；两次原四文件失败均保留。

### 裸退出与持久输入召回

仅既有 normalizer 识别的精确裸退出 token 绕过 dispatcher USER 日志，使新 Logger 冷加载后仍召回最后一条真实 prompt。带参数的 quit/exit、带空格的 slash 输入和无关 help/clear/reset/new 命令仍保留精确 trimmed 召回及原 await 后 session guard。这与 transcript 的 slash 录制排除策略分离。原 1a2a 八别名失败和普通 prompt/help 正控均保留；在源码 1a2a703cfba99d8bfaf54ee1acf0a7e0b543411c 加 patch 1272d01a2b986080d603d46b018b3884560a3c6fd40caaffac3dd51beb9a138d 上，未改的原诊断两案通过（另 90 案精确未选中），dispatcher/gateway 两个完整文件 126 案全部通过，包含新增 15 案真实文件系统回归。当前 v4 组合已有上文具名 build/type、完整文件、native 组件及源码 bundle 通过；持久日志冷 CLI 召回与安装产物 PTY 仍为 NOT_RUN。旧 1a2a 源码结果不能替代这些产品门禁。旧 217 案证据仍只归属原 c395/patch622b 组合。

### 重复模型 slash 的身份

命令 host 仅在前一条调用尚未送达模型时抑制连续同文用户回显。一旦前条 `sentToModel` 为 true，后续同文调用必须获得实际入库的 host 行及自己的 history ID，既有 dispatcher 更新才能附上下一轮 prompt ID。live 投影保留两行，共享 rewind 接收到两个 prompt 身份，即使 assistant 输出只存在于 live transcript。local/未送模型的重复回显继续保持原去重和分配新 ID 后返回的行为。ID 分配、dispatcher 提交、fold/replay 匹配、logger admission 和录制策略均不改。

在整合源码 c0cd94c0f2ecb89dce9f9b6f7620de406a362e7a 上，独立组件诊断的一个正控通过，重复模型 slash 案失败（另 105 案精确未选中）：两个不同提交结果仅产生一个 host/live 用户行与一个 rewind 边界。原始失败保留。候选增加实际 fold 的 host 回归及显式未送模型重复正控；候选准备时，源码验证和整合后的 build/type/native/安装产物 PTY 验收均为 NOT_RUN。随后在 c0cd 加候选 patch f9d535 上，不变的原诊断两案通过（另 105 案未选中）；仅校准旧 info 投影断言以精确包含既有 historyId 后，c0cd 加 patch 0958e48 的 host/dispatcher 两完整文件 136 案通过，无跳过或 bail 未运行，两项新增回归实际执行。原 124 通过、1 失败、11 bail 未运行结果保留。当前 v4 的 build/type 及完整 CLI/native 组件运行已在具名范围通过。冷 replay/retry 到 rewind 身份及安装产物 PTY 仍为 NOT_RUN。先前 217 案和裸退出冷召回结果继续只归属其具名旧源码/patch 组合。

## 完整 checkpoint 创建修复（进行中）

选定 main 整合候选上的真实编辑确认对比已证明创建缺陷：Ink 写入完整恢复 checkpoint，OpenTUI 到达相同确认状态却没有 checkpoint。手工预置 checkpoint 的本地工具恢复用例不覆盖该边界。修复保留在原恢复批次，不改变持久化恢复格式。

原始历史随活动记录保留，不从格式化卡片反推。一条来源可以投影成多条文本、图片或工具记录；快照按记录顺序仅保留一次完整来源。零显示来源使用内部锚点，在视口几何计算前过滤。更新来源替换完整投影块，findings 合并同步每个已改变的来源。重置和回滚直接操作实际记录数组，不增加独立历史存储。展开恢复历史时，也清除原始来源上的折叠隐藏标记。

原生活动内容在显示格式化丢失字段之前保留原始数据。完成的工具组复用现有调度器显示映射，保留原始参数、结构化结果、图片和分组元数据。待完成工具整组排除，尚未提交的回答、思考及重试和任务临时卡片同样排除。任何已提交来源缺失时，在发布 checkpoint 前拒绝采集。

必须在确认事件队列被消费者处理后采集，使之前的历史更新已进入真实活动记录引用。只有启用 checkpoint 且由模型发起的可编辑工具调用符合条件。文件系统等待期间核对轮次、会话、取消状态及同一次确认入口。使用独占临时文件异步写入，最后检查所有者并短暂原子发布；取消时只清理自己的临时文件。checkpoint 保留 UI 历史、API 历史、平行提示词标识及原始工具请求。

验收仍待完成：完整历史往返及所有权负控、完整构建和类型检查、真实 checkpoint 创建、批准编辑后的备份与文件回滚、恰好一次恢复工具执行、显式后续请求和自然退出。API 提示词标识需真实联接测试直接验证，HTTP 请求不能观察 Symbol 元数据。热恢复不能证明冷启动日志截断。上述设计或历史保存层单测通过均不代表该批次已可转为 Ready。

## 恢复重放与合法读取状态

真实 Ink 校准成功回滚了文件，却拒绝编辑重放：替换 API 历史会清空读取缓存。真实工具对照进一步确认，正常读取后的编辑成功，相同编辑在 restore 后被 prior-read 检查拒绝。保留该检查和通用历史替换时的缓存清理。

重放可编辑 checkpoint 前，通过现有交互客户端工具调度器读取原工具参数指定的已有目标，等待真实完成。保留已记录的 client Mod 策略、正常读取权限与 hooks，以及原编辑独立的审批和新鲜度检查。目标不存在时保留原创建语义，仅 ENOENT 视为不存在。不信任 checkpoint 中独立的显示路径，不直接伪造读取缓存，不在自有 restore 内追加历史行，也不请求模型。

读取授权复用现有确认队列，补充可选取消信号和当前所有者谓词。两个 renderer 仅撤销自有提示，恰好收口一次，拒绝迟到回答，并在卸载时清理。取消信号立即生效；会话或历史失效在实际 UI 重绘及回答时检查，不新增全局会话事件或轮询。读取完成或失败后清理残留自有提示。取消、拒绝、所有权失效或读取失败均不得派发编辑。

验收需先通过未改变合同的真实工具红案、权限/确认/取消/后继和新文件创建负控，再用相同完整热恢复夹具依次验证 Ink 和 strict OpenTUI。在同一候选上实际观察文件备份、物理回滚、恰好一次成功本地重放、零自动模型请求、一次显式后续及自然退出。读取状态修复不新增 renderer action 协议、运行时依赖或 checkpoint schema。

Read 在异步文件系统准入前捕获现有缓存清空代际。历史或会话清空后，旧读取不得使用缓存快捷路径、重新发布读取权限或在失败清理时失效健康后继的缓存；既不能重新授权未读文件，也不能覆盖同文件后继读取。复用 `getClearGeneration()`，保留真实读取结果与现有权限策略。描述符挂起回归覆盖后继读取相同文件及不同文件两种情况。

模型发起的原生及 Mod 工具完成后，必须像 Ink 一样，将最终响应与元数据准确记录一次，并保留已有 Goal 来源信息。本地客户端工具继续使用独立的本地完成策略。严格验收必须先观察到产品日志中的初次模型工具结果，再验证恢复；单独的 telemetry 成功事件不能证明模型会话结果已持久化。

## 真实恢复工具响应

实际第四次模型请求发现另一个共享缺陷：恢复的 API 历史以原模型工具调用结尾，本地重放使用新执行身份，却没有配回原调用响应。于是即使重放成功，下一次显式请求也会制造 orphan-call 失败。保留新的物理执行身份，只用真实完成 payload 关闭原选中 API 调用；不得复用较早成功结果，不得自动请求模型续轮。

沿已有命令与轮次端口携带一项临时 restore-only 绑定。Ink 放入现有按调用保存的 continuation owner，并在调度前登记，覆盖立即完成；strict OpenTUI 沿现有本地工具轮次携带。普通客户端工具及无挂起 API 调用的旧 checkpoint 保留本地完成语义。在末尾模型记录中按原 ID、规范工具名及参数指纹选择唯一匹配的挂起调用；拒绝不匹配、身份复用或歧义，保留兄弟调用。

绑定捕获会话、client/chat 实例、真实历史末尾及长度和最小历史替换版本。公开替换/破坏性操作即使复用同一对象也递增版本，普通追加不递增。这封闭同会话、同末尾对象替换的缺口，不新增 registry、后台事件机制或持久 schema。真实完成时核对当前执行 owner 和全部捕获条件，再复核挂起配对。复制真实响应容器，仅映射配对 ID/名称，保留 payload、媒体、错误和来源信息，标记原 API 提示词身份，沿既有历史处理同步追加。缺少、重复、外来响应及失效或重复完成均不得发布。真实失败/取消必须如实保留，不得制造成功。

验收增加真实 client/chat 所有权与替换负控、两个 renderer 的转发/完成测试、立即完成、错误/媒体及重复/歧义调用覆盖。真实完整热恢复还需检查显式后续 wire：原挂起 ID 对应真实重放响应，无错误 orphan 失败，不自动请求，物理重放身份仍为新 ID，并保留此前备份、回滚、可见内容、checkpoint 和自然退出断言。冷日志截断及安装/平台验收仍为独立门禁。

## 冷启动回放初始化

启动 resume/continue 必须在重建已记录工具历史前等待现有 Config 初始化 flight，此前工具注册表及其元数据尚不可用。等待后重新读取 writer lease 激活时安装的权威恢复会话，不能投影初始化前的旧快照。新会话保留提前首屏渲染。初始化拒绝沿现有 renderer/runtime 清理和 strict 回退拒绝路径处理，不能替换为空注册表或丢弃工具元数据。验收包含挂起和拒绝初始化、新会话提前首屏，以及真实同会话冷进程到达首个显式模型传输。该启动要求独立于持久 journal 分支正确性。

## 本地重放的持久分支

冷恢复中没有结果记录的工具显示 Error，与现有模型缺失结果修复语义一致，但不声称实际执行已取消。明确记录的取消显示 Canceled，且不暴露仅成功时展示的详细输出。旧版已有结果但缺少状态的记录保持成功兼容。同一 assistant 内没有新结果的兄弟工具不得继承选中重放工具的成功状态。

永久 checkpoint E2E 使用回环模型和真实 PostToolUse hook，驱动 Node+Ink、Bun+Ink 和 strict Bun+OpenTUI 的实际产品。检查初次与重放完整响应、原逻辑调用 ID、同会话冷恢复、活跃父链、备份及两次自然退出。CI 在失败时也保存各运行组合的原始证据；保留既有 no-flicker 步骤，并在其 job 中执行该有界回归。源码 bundle 门禁不能替代安装产物或平台验收。

冷恢复必须选择与实时 UI 和 API 历史一致的恢复分支。在文件或历史副作用之前，校验 checkpoint 选中的原调用及其活动 recorder 锚点、会话和所属真实用户 prompt。保留原 assistant 记录的全部调用及媒体 parts，不新增单挂起调用限制。真实重放完成时重新核对捕获的 owner 和 recorder，隔离并发写入、flush，通过现有 parent 链重新选定分支，只追加选中工具的真实终态响应并保留状态、输出元数据及媒体。旧后缀字节保留审计但不进入活动分支，不复制被丢弃兄弟工具的旧成功，也不静默重放兄弟调用；保留会话元数据及存续文件快照。

严格写入可能在出错前部分持久化：应报告失败并保留真实已确认写入 cursor，不能宣称文件/journal 原子回滚。缓冲的后继写入按序接在已接受分支，包括之后普通 rewind/title 投影。验收要求真实临时 JSONL 重建、挂起写入/owner 及首行/第二行写入失败负控，以及 Ink 和 strict OpenTUI 的真实 OLD1/NEW2 hook 热/冷完整流程。完整多工具交互及组合安装平台验收仍为独立门禁。
