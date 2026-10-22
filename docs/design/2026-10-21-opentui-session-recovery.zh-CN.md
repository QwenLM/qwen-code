# OpenTUI 会话恢复、重试与记录

[English](2026-10-21-opentui-session-recovery.md) | [中文](2026-10-21-opentui-session-recovery.zh-CN.md)

## 状态与源码边界

**Phase 5：实施中；当前 C 的 build、typecheck、单测、native 与产品验证均为 NOT_RUN。** 隔离的 `feat/opentui-session-recovery` 工作树已从最初 `23f1cd5` 计划基座快进至 `d677b8df38eb4c3fd955618d14e720ac70efa783`（tree `3c229e79e17734677323bb2ed3032e7b1fd62225`）。这是开发基座，不是已接受父提交：B 的 combining-character native 失败仍未关闭，Ready 前必须整合修复并验证。不新增 core API、依赖、记录 schema 或第二个历史 owner。

Phase 4 固定历史参考（`~/.local/bin/qwen` 0.22.0 及其私有 Node 22.23.2）已一次通过 H01a、H01b、H09a：7 个真实 PTY、7 个模型请求、7 次 `/quit` exit 0。该参考不是操作者当前默认 global 命令，也不代表当前 C 或 Ink 验收。原失败与 blocked 版本保留于 ignored 证据；最终汇总为 `.qwen/investigations/session-recovery-global-outer-v6/historical-baseline-summary.json`。

d677 的正常依赖 setup 已通过，使用固定 Node 24.19/pnpm 11.24 和共享 store，安装了 Husky，但未运行 build 或测试。收据为 `.qwen/investigations/c-d677-setup-v1/20261021T143821Z-7fc8df-install/independent-receipt.json`。并行源码改动明确不在该安装守卫的验收范围内。

源码对照为 Ink/main `a0e414945502b1d08ec969d7d3f59d6a1e96bdd7`。只读调查已将 42 个文件与精确提交核对；16 个共享文件中 15 个与 main 逐字相同，剩余 AppContainer 差异是父批次 Vim 提交时清空 buffer。这是源码证据，不是新的运行结果。父级交互/输出批次仍有自身验证阻断；Ready 前必须继承其已接受的后继提交，重新绑定基线后才能宣称完成整合。

本方案沿用既有会话/记录/恢复/transcript 提案及全部 H01–H14 案组。早期结果，包括 Markdown 下划线差异与同会话 reset 修复，保留为历史证据，不能当作新树验收。原调查 checkout 中的 ignored 记录为 `.qwen/investigations/session-record-recovery-transcript-20261021/` 和 `.qwen/investigations/session-recovery-scope-b23f1-main-a0-v1/`。本树新的可执行基线规格位于 `.qwen/e2e-tests/2026-10-21-opentui-session-recovery.md`。

## 问题与完整交付边界

OpenTUI 已经能加载会话、持有结构化输入队列、运行模型/工具轮次并写入双路输出。剩余会话操作尚未一致使用同一 prompt 身份、输入来源、可见历史、core 历史及项目输入日志。因此，用户可能看到恢复后的对话，而历史资格、重试或后续 rewind 仍使用不完整投影。

一个完整交付将贯通输入记录与回忆、resume/branch 投影、取消恢复、失败 attempt 重试与跳过重试延迟、真实 rewind、checkpoint `/restore` 及已删会话日志清理，同时保留 Markdown 和长 transcript 的既有验收范围。这些操作共享会话与 turn owner；按按键或对话框拆成多个 PR 会留下跨版本的不完整事务。

预计整体约 **3,000–4,550 行变更**，包括生产代码、定向测试和双语设计。这是估算，不是配额。较窄的事务核心本身更小，但不能在 `/restore`、Markdown 或长 transcript 案组被遗漏时宣称完成。若已验证的 Markdown 缺陷需要修改库或重构渲染器，应保留失败证据并重新裁定该依赖范围。

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

除特别说明外，下表路径均位于 `packages/cli/src/ui/`。这些是最初计划基座的源码观察。下述 Phase 5 接线仍是未验证 WIP；历史版本校准不关闭这些义务。

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
| Checkpoint restore | 共享 `commands/restoreCommand.ts` 恢复文件/历史并返回工具重放；OpenTUI host 替换历史没有替换 live row，shell 也没有执行返回的 `schedule_tool`。                         | 将现有历史替换、scheduler continuation 恰好接通一次；与 rewind 分开验收。                                  |

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

Ctrl+Y 优先恰好消费一次当前重试延迟 callback；不 abort 请求，不产生新提交或 user event。Reset/cancel 使 callback 失效。正在提交、等待权限、没有失败 attempt、重复按键均有明确结果，不能意外落入默认重试。

终态失败保存该 model/tool-result hop 实际送出的 prepared payload 及 prompt ID，再使用已有 `SendMessageType.Retry`。不能重新展开 slash、再读 `@` 文件、重转图片、重复 accepted steering，或把 Retry 当 Enter/`UserQuery`。复用 core 的 orphan 处理、文件读取失效、turn 预算和 tool-call/result 配对。在已接受 steering 合并后捕获最终 payload；未接管的队列项仍可恢复。

遵循当前模型选择行为：inline override 清回 session model 并提示，skill override 保留。显式 Retry 每个 attempt 恰好发一次已有 JSON user event；跳过延迟不发新 user。权限与 accepted-steering 输出仍在真实决定/接受点产生，不能为复制 Ink 镜像缺口而回退父批次已经明确修正的 deny response 和 accepted-steering 行为。

### Resume、branch 与 checkpoint restore

Resume/branch 保留现有 core-before-UI 事务和失败回滚。复用共享 resumed-history 投影，让可见行、附件、prompt ID、模型 turn 资格、title/usage 和下一请求指向同一选定会话。Branch 创建独立会话，原会话不变。启动 `--resume`/`--continue` 与交互 resume 仍分别验收。 启动只转换一次标准历史并应用现有折叠策略，将完全相同的来源 ID 同时交给 command host 与 live projection，再添加警告。新会话历史为空；旧记录沿用共享的缺失 ID/模型资格 fallback。转换失败走启动已有的清理和回退路径。新增 host 行不得与已恢复 ID 冲突。

每个投影的 host 行携带原有 `historyId`；rewind 同时截断来源 host 前缀与 live 前缀，后续 `/history expand-now` 不能复活被移除的命令输出。这是来源关联，不是新历史存储。已检查的基座没有注册 `/chat save` writer，本批不发明该能力。

折叠恢复行在同一个 live 数组保留原有 display 元数据；只有 transcript renderer 过滤隐藏行，selector 和 rewind boundary 仍读取它们。Rewind 与 `/history expand-now` 去掉 suppression 和 summary 行，并保留富记录内容。只有 expand 命令向现有 history-load seam 传显式 `expand` mode：OpenTUI 在当前 live 数组折叠仅改变显示的 event，保留后续 turn、行 ID、stream 状态及排队输入。普通 restore 仍执行替换/reset，Ink 原有完整 history loader 保持兼容。现有 context-files announcement latch 按 startup、恢复或回退后保留行重算，已有公告不会重复，回退移除公告后允许下一次公告。Compression 保留完整 kind/status，边界 ID 使用原始完整快照的下标。

Checkpoint `/restore` 是另一种操作。记录携带 `promptId` 和 history 时，保留共享次序：恢复自有文件、拒绝部分恢复、替换 pending/history、恢复 API prompt ID，然后恰好执行一次返回的工具重放及 continuation。将 host 历史替换接到 live view，同时避免对已有显式 reset 的 resume/branch 再次 reset。缺失 checkpoint 文件、无效 `toolCall` 及旧版 `commitHash && !promptId` 格式按现有拒绝语义处理。只有合法 toolCall 的 checkpoint 仍受支持：恰好调度一次工具，不执行文件 rewind 或 UI/core history 替换。不能将可选 history 或 `promptId` 缺失一律变成新的拒绝条件。

Checkpoint 的迟到结果守卫核对现有 session、idle、取消信号和来源历史快照。Ink 经 React 发布 `loadHistory`，OpenTUI context 则复制 host 数组，因此守卫接受明确请求的标准行引用，以及尚未发布时未变化的旧快照和本操作自己的 notice。同会话的新历史或新 turn 不能重放旧工具。使用真实 history hook 的 deferred 测试覆盖发布时序与后继拒绝。

### 会话与文件 rewind

将 `/rewind`、`/rollback` 和现有空输入 double-Esc 路径接到真实 selector，保留 idle/dialog/IDE 门禁。已标识的当前 turn 来自 live transcript，不能只用命令 host history。变更前调用 `computeApiTruncationIndex` 和 `isIdentifiedRetainedTurn`，按共享 helper 拒绝歧义或压缩后的身份。

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

Ignored Phase 3 计划将下列稳定案组展开成命名分支。当前 C 全部案组均为 **NOT_RUN**；只有上文明确标注历史参考的 H01a/H01b/H09a dry-run 已完成。基线例外与候选通过分别报告；跳过一个分支不能关闭其案组。

| 案组                     | 必须验证的行为与反例                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| H01 — 记录与回忆         | 普通/重复输入、local slash、model-sent slash、shell、重启顺序、原始文本及不同的 rewind 资格。                                            |
| H02 — 来源重放           | 图片、typed `@`、accepted/restored steering、重复文本、prompt ID、display/model 分离与 resume 后 known/unknown 来源。                    |
| H03 — 无输出取消         | 真实请求取消、精确 owned row/core/log 回滚、结构化重提、纯 thought/info 与冷 journal characterization。                                  |
| H04 — 内容取消与后继     | 保留 text/image/tool 内容；queued/accepted/restored 输入、pending paste/image、late callback、同 ID reset 与新会话后继隔离。             |
| H05 — 重试延迟           | 真实 RetryInfo 倒计时、Ctrl+Y 一次、reset/cancel 失效、无额外请求/user event、busy/permission 门禁。                                     |
| H06 — 终态重试           | 同一 prepared parts/prompt ID；普通、image/`@`、tool-result、steering、model override；重复按键/无失败正控。                             |
| H07 — Resume             | 交互及启动 resume/continue、visible/core context、title/usage、异常/缺失数据、late callback、失败回滚。                                  |
| H08 — Branch             | 独立 session/ancestry/title、原会话不变、fork 失败清理与提交前回滚。                                                                     |
| H09 — 会话 rewind        | 真实命令/alias/double-Esc、折叠隐藏 turn 与重复文本身份、unknown 草稿、同步 stale/new-turn/notice 守卫及 cancel/busy/IDE/压缩/歧义门禁。 |
| H10 — 文件 rewind        | 工具真实编辑文件、code-only 与 combined、snapshot、精确文件字节/模式、部分失败、无 client 时仅恢复文件、不错误截断会话。                 |
| H11 — Checkpoint restore | 真实 checkpoint、精确替换 history/API ID、一次工具重放/continuation、合法 toolCall-only 支持与精确 missing/legacy/partial-failure 拒绝。 |
| H12 — 删除               | 非活跃成功与重启 purge、活跃拒绝、部分 batch 和持久化失败对照。                                                                          |
| H13 — Markdown           | 字面下划线回归、真实 emphasis/code/path/CJK/link/table 对照、streaming/settled frames、source 字节及 render-error 归属。                 |
| H14 — 长 transcript      | 长 resume 与 picker preview、head/tail/window/scroll/resize/expanded code、稳定选择与有界渲染。                                          |

参考矩阵先解析实际 launcher/runtime 后运行 global `qwen`，再用同一本地 artifact 分别运行 Node 24.19 + Ink、Bun 1.3.14 + Ink、Bun 1.3.14 + strict OpenTUI。历史参考版本来自实际执行发现；当前 C/当前 Ink 验证尚未运行。Strict readiness 必须证明所选渲染器；仅证明没有 fallback 还不能证明所有操作合同。

使用自有配置/工作区、真实 PTY 输入与模型 HTTP、实际日志/journal/文件证据、精确请求数量和值、fresh PID/start 身份。普通完成用 `/quit` 并精确断言 exit 0；raw Ctrl+C 与 active cancel 分别校准。以有界 deadline 等待真实协议/退出事件，不以固定 sleep 或已可见 prompt 判断完成。测试在共享 heavy lease 下串行执行，retry 0、单 worker、unhandled error 致失败、保留首败并提供清理证据。

## 风险、例外与完成门槛

- 当前父源码是依赖，不是完成验收的声明；任何已接受父修复后，实施与新 artifact 验证都需重新绑定。
- Ink 已知 deny JSON 镜像缺口与父批次 accepted-steering 事件补齐仍是明确有意差异，不新造协议，也不为逐字 parity 削弱已有修复。
- 无输出取消后的 journal 冷重放、retry 后 rewind 身份、纯 thought 时序和命令失败日志需精确当前 Ink 校准；本设计未宣称新增已实证 Ink bug。
- Linux、Windows、sandbox 文件系统行为、真实麦克风/权限/音频设备、WebSocket ASR、发布版升级均 NOT_RUN；macOS 自有 fixture 或组件测试不覆盖这些能力。
- 即使 renderer 依赖延迟交付，H13/H14 仍可见；没有预先授权新增库、版本或默认行为变更。

Ready 需要已接受父批次、完整同步双语设计、global/当前 Ink 基线、变更路径的有意义复现、正常 full build/typecheck、定向 owner/projection/native 测试、三个本地腿的所有适用 H01–H14 分支、明确例外处置、source/artifact/runtime 身份和清理，以及两次连续干净的全 diff/consumer 审阅。实现和最终 PR 仍作为一个完整会话事务交付。历史 dry-run 与 setup 收据只满足各自具名前置条件；当前 C 的动态门禁仍未关闭。

### 清理前的退出展示

共享 quit/exit 结果提供用户消息、时长和 ID。OpenTUI 入口用当前会话统计快照投影这些原始消息，交给已有 transcript view，替换普通应用和输入框。临时展示不追加 host history、logger、录制、JSON 输出或模型输入。第一次退出请求独占转换；展示提交后保留与 Ink 相同的 100 ms 呈现窗口，然后调用既有退出生命周期。卸载会取消该定时器。设置重启传入空消息时立即退出，不制造摘要。既有 Ctrl+C/Ctrl+D 中断退出及渲染错误退出保持退出码和清理路径。

验收必须观察实际安装的 strict renderer，在离开 alternate screen 前展示告别标题、交互统计与墙钟时长，并在恰好一次模型请求后自然 exit 0。退出后的 resume 回显是独立证据。入口测试覆盖传入时长、输入框替换、录制/提示计数控制的 resume 提示、重复请求、空重启与定时器清理。在旧 c395 源码加候选 patch 622bcbc8d769170a9505f0441165d3315db878881ac9bc0ebd33939cfa2ecd3a 的组合上，四个完整源码测试文件的 217 案全部通过；原 stock-status 取消探针的 1 个选中用例通过，另 66 案精确未选中。这些结果仅覆盖该旧源码组合。当前 main/B5f916 整合后的构建、类型检查、native 测试和真实安装产物 PTY 回归均仍为 NOT_RUN；原始失败与后续源码修复证据全部保留。

### 回放中的结构化压缩标记

canonical 回放将每个压缩标记保留为一个已有 compaction 行，携带完整 token 数、估计标志、状态、类型、canonical history ID 和恢复展示策略。折叠标记保持隐藏但仍供 rewind 使用；展开标记使用已有压缩渲染。fast 与摘要压缩保持可区分，共享 rewind 映射因此仍能排除 fast 作为 API 截断边界。live 命令 info 投影与 provider 的上下文自动压缩通知保持不变；回放重置整个 transcript，不追加第二份。原 collapsed fast/summarize 回归断言未改。旧 c395 加 patch 622bcbc8 的 217 案源码结果包含原 fast/summarize 断言及新增精确事件/身份回归，不能算作当前 main/B 整合通过。新整合后的构建/类型检查、native 渲染与安装产物 PTY 验收仍为 NOT_RUN；两次原四文件失败均保留。

### 裸退出与持久输入召回

仅既有 normalizer 识别的精确裸退出 token 绕过 dispatcher USER 日志，使新 Logger 冷加载后仍召回最后一条真实 prompt。带参数的 quit/exit、带空格的 slash 输入和无关 help/clear/reset/new 命令仍保留精确 trimmed 召回及原 await 后 session guard。这与 transcript 的 slash 录制排除策略分离。原 1a2a 八别名失败和普通 prompt/help 正控均保留；在源码 1a2a703cfba99d8bfaf54ee1acf0a7e0b543411c 加 patch 1272d01a2b986080d603d46b018b3884560a3c6fd40caaffac3dd51beb9a138d 上，未改的原诊断两案通过（另 90 案精确未选中），dispatcher/gateway 两个完整文件 126 案全部通过，包含新增 15 案真实文件系统回归。此候选的 build/typecheck、native 与安装 PTY 尚未通过；与 R3 整合后仍需新源码/产物绑定。旧 217 案证据仍只归属原 c395/patch622b 组合。

### 重复模型 slash 的身份

命令 host 仅在前一条调用尚未送达模型时抑制连续同文用户回显。一旦前条 `sentToModel` 为 true，后续同文调用必须获得实际入库的 host 行及自己的 history ID，既有 dispatcher 更新才能附上下一轮 prompt ID。live 投影保留两行，共享 rewind 接收到两个 prompt 身份，即使 assistant 输出只存在于 live transcript。local/未送模型的重复回显继续保持原去重和分配新 ID 后返回的行为。ID 分配、dispatcher 提交、fold/replay 匹配、logger admission 和录制策略均不改。

在整合源码 c0cd94c0f2ecb89dce9f9b6f7620de406a362e7a 上，独立组件诊断的一个正控通过，重复模型 slash 案失败（另 105 案精确未选中）：两个不同提交结果仅产生一个 host/live 用户行与一个 rewind 边界。原始失败保留。候选增加实际 fold 的 host 回归及显式未送模型重复正控；候选准备时，源码验证和整合后的 build/type/native/安装产物 PTY 验收均为 NOT_RUN。随后在 c0cd 加候选 patch f9d535 上，不变的原诊断两案通过（另 105 案未选中）；仅校准旧 info 投影断言以精确包含既有 historyId 后，c0cd 加 patch 0958e48 的 host/dispatcher 两完整文件 136 案通过，无跳过或 bail 未运行，两项新增回归实际执行。原 124 通过、1 失败、11 bail 未运行结果保留。当前整合后的 build/type/native/安装产物 PTY 仍为 NOT_RUN。先前 217 案和裸退出冷召回结果继续只归属其具名旧源码/patch 组合。
