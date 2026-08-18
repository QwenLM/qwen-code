# PR 9388 评论评估

来源：https://github.com/QwenLM/qwen-code/pull/9388
生成日期：2026-08-18
评估基线：`c06b4e77f4f520853b0a1eea99683f2060a0c360`

## 摘要

- 值得修复：12
- 不值得修复：3
- 需要维护者判断：1

指定评论 `issuecomment-5324617504` 已被 GitHub 以 off-topic 最小化，且不包含可映射到本 PR 的技术主张。真正需要修复的是同一 review 中的 11 条行内 finding，以及 review summary 暴露的完整 typecheck 验证缺口。

## 实施结果

- 11 条成立的行内 finding 均已修复：补齐 NodeNext 导入、no-AK CI wiring、identity 唯一键与集合语义、manifest/schema/hash 门禁、冻结 error kinds、用户可见文本、Desktop wiring、never-export 字段和 rendererVersion 正向白名单。
- 指定的离题评论、生命周期通知和无视觉变化通知不触发代码改动。
- “是否在迁移前合入预验证基础设施”仍属于维护者方向判断；本次修复不伪造产品决策，也不把预期的 identity FAIL 改成 PASS。
- 定向验证通过：契约测试 5/5、Turn Output 回归 22/22、no-AK wiring 9/9（另有 1 项既有 skip）、integration TypeScript 编译和根级 typecheck。
- 首次完整 no-AK 运行因陈旧 `dist/cli.js` 导致既有 capabilities 用例为 145/146；按仓库规范重新执行 build 和 bundle 后复跑，最终 13 个测试文件、146 个测试全部通过，且契约测试明确出现在执行结果中。

## 评估结果

### 1. 与 PR 无关的离题评论

- 评论来源：danialzivehdadr，会话，https://github.com/QwenLM/qwen-code/pull/9388#issuecomment-5324617504
- 结论：不值得修复
- 理由：该评论没有引用 PR 行为、文件、测试或设计问题，GitHub 已将其标记为 off-topic 并最小化，无法从中导出技术修复。

原始评论：

> تو گوشیم آدم کار نمیکنه بگی نازر نیست صحاب میز متوجه نمیشه کار داریم تو وبسایت آپلود میکنیم دقیق هر مدون وبسایت متوجه میشه دار اجرا میکنه

### 2. Qwen Triage 生命周期状态通知

- 评论来源：qwen-code-ci-bot，会话，https://github.com/QwenLM/qwen-code/pull/9388#issuecomment-5324448218
- 结论：不值得修复
- 理由：这是 triage 完成状态通知，只提供 workflow 链接，没有提出缺陷、风险或修改请求。

原始评论：

> <!-- qwen-triage lifecycle -->
>
> ✅ **Qwen Triage finished** — [view run](https://github.com/QwenLM/qwen-code/actions/runs/32106878335). See the stage comments in this thread for the result.
>
> ✅ **Qwen Triage 已完成** —— [查看运行](https://github.com/QwenLM/qwen-code/actions/runs/32106878335)。结果见本线程中的各阶段评论。

### 3. 是否应在迁移前引入预验证基础设施

- 评论来源：qwen-code-ci-bot，会话，https://github.com/QwenLM/qwen-code/pull/9388#issuecomment-5324569450
- 结论：需要维护者判断
- 理由：评论准确指出本 PR 的收益取决于后续 VS Code 与 HTML Export 迁移方向，但是否批准该方向是产品和维护决策。当前 diff 已按 #9355 的反馈缩为证据型 MR；技术层面的可执行问题由下方行内 finding 单独处理，不能用代码改动伪造 maintainer 的方向结论。

原始评论：

> <!-- qwen-triage stage=1 -->
>
> Thanks for the PR — and for the rework: this is the evidence-only split of #9355 that review there asked about, and the ~3.1k lines of production-shaped surface (export builder, probes, wire-format fields) are indeed gone. A few honest gate observations before anyone goes deeper.
>
> - **Template**: complete ✓ (bilingual, test plan included).
> - **Problem**: no observed defect. The linked issue (#9387) was filed by the PR author shortly before this PR, is still `status/needs-triage`, and has no maintainer sign-off. The motivation is forward-looking — freeze evidence _before_ a future VS Code timeline / HTML export migration — not a user-visible break. For a `feat` that doesn't disqualify, but it puts all the weight on the direction question below.
> - **Direction**: this is the same direction question #9355 deferred to maintainers yesterday, and it is still unanswered: do we want prevalidation infrastructure — a closed V1 export schema, a capability matrix, gate fixtures — for migrations (VS Code timeline, HTML export rebuild) that have not been scoped or approved anywhere yet? The manifest declares `web`, `tauri`, `vscode`, `html` as the contract's consumers, which is a product-direction and public-contract call that belongs to a maintainer, not to the gate. Claude Code's CHANGELOG has no comparable prevalidation practice — no external signal either way.
> - **Size**: no core paths touched — the only non-test, non-doc code change is a 4-line vitest alias for an SDK subpath (`./daemon/transcript`) that already exists in the package exports. For the record: ~4 production-config lines, ~381 test lines, ~828 schema lines, ~955 design-doc/fixture lines. No size gate applies.
> - **Approach**: the split itself is the right response to #9355's review, and the new `write_file` full-diff regression test in web-shell has standalone value — it pins current behavior regardless of any migration. But the bulk of the diff still only pays off if MR2 happens: the "gate" result is largely hardcoded in the test (the blocker strings, the `overall: fail`, the matrix assertions); the one thing actually measured — ordinal block IDs shift when history is prepended — is inherent to ordinal IDs and doesn't need frozen fixtures to establish. If the direction gets a green light, consider landing the standalone regression test plus a compact current-semantics suite first, and keeping the export schema / capability matrix / MR plan in the issue until a migration PR actually needs them.
> - **Risk**: no elevated risk signals — no high-risk paths matched; the diff is tests, fixtures, schemas, and a design doc.
> - **CI**: fork workflows were authorized and still running on the reviewed commit at gate time (ubuntu unit suite and web-shell visuals in progress; macOS/Windows test jobs skipped by path filters; desktop-shell checks green).
>
> ⏸️ Flagging these for discussion before diving deeper — and escalating the direction call to @wenshao @pomelo-nwu: the prevalidation-before-migration question was deferred on #9355 and never answered; this PR is much smaller and cleaner, but the question is the same. Stopping the pipeline here per the gate rules; a maintainer's direction (or a re-run via `@qwen-code /triage` once decided) picks it back up.
>
> <details>
> <summary>中文说明</summary>
>
> 感谢贡献——也感谢这次重构：这正是 #9355 评审中询问的"纯证据"拆分版本，约 3.1k 行生产形态的代码（export builder、probe、wire-format 字段）确实都移除了。在深入之前，给出几点如实的门禁观察。
>
> - **模板**：完整 ✓（双语，含测试计划）。
> - **问题**：没有观测到的缺陷。关联 issue（#9387）由 PR 作者在本 PR 前不久自行提交，目前仍是 `status/needs-triage`，没有 maintainer 表态。动机是前瞻性的——在未来的 VS Code 时间线 / HTML 导出迁移*之前*冻结证据——而不是已发生的用户可见问题。对 `feat` 类 PR 这并不构成否决，但全部重量都落到了下面的方向问题上。
> - **方向**：这与 #9355 昨天转交 maintainer 的方向问题是同一个，且仍未得到答复：我们是否要为尚未立项或批准的迁移（VS Code 时间线、HTML 导出重构）建设预验证基础设施——封闭的 V1 导出 schema、capability matrix、门禁 fixtures？manifest 声明 `web`、`tauri`、`vscode`、`html` 为该契约的消费方，这是产品方向与公共契约层面的决策，应由 maintainer 做出，而不是门禁。Claude Code 的 CHANGELOG 中没有可比的预验证实践——没有外部方向信号。
> - **规模**：未触及核心路径——唯一非测试、非文档的代码改动是 4 行 vitest 别名，指向 SDK 包导出中已存在的子路径（`./daemon/transcript`）。供参考：约 4 行生产配置、约 381 行测试、约 828 行 schema、约 955 行设计文档/fixture。不触发任何规模门禁。
> - **方案**：这次拆分本身是对 #9355 评审的正确回应，web-shell 中新增的 `write_file` 完整 diff 回归测试也有独立价值——无论是否有迁移，它都固化了当前行为。但 diff 的主体仍然只有在 MR2 发生时才有回报："门禁"结果在很大程度上是测试里硬编码的（blocker 字符串、`overall: fail`、matrix 断言）；唯一实际被测量的事实——prepend 历史时 ordinal block ID 会变化——是 ordinal ID 的固有属性，不需要冻结 fixtures 来证明。如果方向获得批准，可以考虑先落地独立的回归测试加一个紧凑的当前语义套件，把 export schema / capability matrix / MR 计划留在 issue 里，等迁移 PR 真正需要时再引入。
> - **风险**：无升级风险信号——未命中高风险路径；diff 仅包含测试、fixtures、schema 和设计文档。
> - **CI**：fork 工作流已获授权，门禁检查时仍在评审 commit 上运行（ubuntu 单测套件与 web-shell 视觉采集进行中；macOS/Windows 测试任务被路径过滤跳过；desktop-shell 检查通过）。
>
> ⏸️ 先提出讨论，再深入看代码——并将方向决策转交 @wenshao @pomelo-nwu：预验证先于迁移的问题在 #9355 上已被转交且从未得到答复；本 PR 更小更干净，但问题相同。按门禁规则在此停止流水线；待 maintainer 给出方向后（或届时通过 `@qwen-code /triage` 重跑）可继续。
>
> </details>
>
> — _Qwen Code · qwen3.8-max_
>
> <sub>Reviewed at `c06b4e77f4f520853b0a1eea99683f2060a0c360` · re-run with `@qwen-code /triage`</sub>

### 4. Web Shell 视觉预览无变化

- 评论来源：qwen-code-ci-bot，会话，https://github.com/QwenLM/qwen-code/pull/9388#issuecomment-5324574562
- 结论：不值得修复
- 理由：视觉任务明确报告相对 base 没有截图变化，与本 PR 不改变用户可见 UI 的范围一致，没有可修复问题。

原始评论：

> <!-- qwen:web-shell-visuals -->
>
> ### 🖼️ web-shell visual preview
>
> Rendered against a mock daemon (no real backend): the PR base vs this PR head `c06b4e7`. Only **screenshots** that changed are shown (flows below, if any, are head-only) — refreshes on every push.
>
> #### Screenshots · before / after
>
> ✅ _No screenshot changes against the PR base._
>
> <sub>Full-resolution recordings (.webm) are attached to the <a href="https://github.com/QwenLM/qwen-code/actions/runs/32106896122">workflow run</a>.</sub>
>
> — _Qwen Code · web-shell visuals_

### 5. 完整 typecheck 验证缺口

- 评论来源：qwen-code-ci-bot，Review，https://github.com/QwenLM/qwen-code/pull/9388#pullrequestreview-4959097422
- 结论：值得修复
- 理由：Review summary 明确披露根级 typecheck 未运行，而当前分支的 integration-tests TypeScript program 实际可复现失败。应在修复 R1-1 后同时运行 integration-tests 专用 typecheck 与根级 typecheck，补齐验证证据。
- 建议修复：修复 R1-1 的 NodeNext import 问题，运行 `cd integration-tests && npx tsc -p tsconfig.json` 与根目录 `npm run typecheck`，并在回复中给出真实结果。

原始评论：

> Not explored to full depth (tool budget reached): `"agent 3b"`: `repo-root  npm run typecheck  across all workspaces was not run; I verified web-shell's and integration-tests' typecheck programs individually instead.`.
>
> <details>
> <summary>中文说明</summary>
>
> 未探索到全部深度（达到工具调用预算）：`"agent 3b"`：`repo-root  npm run typecheck  across all workspaces was not run; I verified web-shell's and integration-tests' typecheck programs individually instead.`。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_
>
> <!-- qwen-review-ledger {"v":1,"round":1,"findings":[{"id":"R1-1","sev":"C","file":"integration-tests/chat-transcript-contract.test.ts","line":15,"title":"This import pulls the web-shell client source graph into the maintained `tsc -p "},{"id":"R1-8","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":14,"title":"The new contract suite is unreachable from every PR-gating CI check. integration"},{"id":"R1-3","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":148,"title":"`probeIdentity` aligns blocks via `${kind}:${text}` semantic keys built into a M"},{"id":"R1-11","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":149,"title":"`unstableBlockKinds` accumulates one entry per drifted block without de-duplicat"},{"id":"R1-7","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":204,"title":"`manifest.schema.json` is hash-locked and inspected for its `additionalPropertie"},{"id":"R1-6","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":216,"title":"Both frozen `errorKind` enums are asserted with `toEqual` against the live, acti"},{"id":"R1-2","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":235,"title":"The SHA-256 lock verifies only the entries the manifest enumerates and never tha"},{"id":"R1-10","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":264,"title":"This equivalence test asserts only `kinds`, `sourceRecordIds`, message `roles`, "},{"id":"R1-4","sev":"S","file":"integration-tests/chat-transcript-contract.test.ts","line":328,"title":"The Desktop wiring gate matches exact text fragments of `packages/desktop-shell/"},{"id":"R1-9","sev":"S","file":"integration-tests/fixtures/chat-transcript-contract/v1/cases/representative/expected-export.json","line":5,"title":"The `forbiddenFields` tripwire locks only 8 names, but design doc §10.3's never-"},{"id":"R1-5","sev":"S","file":"integration-tests/fixtures/chat-transcript-contract/v1/schema/export-transcript-document-v1.schema.json","line":20,"title":"The frozen V1 schema's `rendererVersion` guard is an unanchored substring blackl"}],"sha":"c06b4e77f4f520853b0a1eea99683f2060a0c360"} -->

### 6. R1-1：Integration TypeScript program 被 Web Shell 导入闭包破坏

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470665
- 结论：值得修复
- 理由：在当前 PR head 上运行 `cd integration-tests && npx tsc -p tsconfig.json` 可复现 exit 2，首先报告 `todos.ts` 两处 TS2835，并级联 TS2366/TS7006。该 program 在 PR 前可通过，且根级 typecheck 不覆盖 integration-tests，因此是实际回归。
- 建议修复：为 Web Shell 被拉入闭包的四处 ESM 相对导入补 `.js`，随后验证 integration-tests 与 Web Shell 自身 typecheck。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:15`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
```

> **[Critical]** R1-1: This import pulls the web-shell client source graph into the maintained `tsc -p integration-tests/tsconfig.json` program, and that graph does not compile under its nodenext resolution. No integration test imported web-shell source before this PR, and the tsconfig's own comments state cross-imported files "get checked here too and must resolve their own imports."
>
> Failure scenario: `cd integration-tests && npx tsc -p tsconfig.json` exits 2 on this branch where the merge base exits 0 — TS2835 ×2 in `packages/web-shell/client/utils/todos.ts` (extensionless `'../adapters/types'` / `'../adapters/toolClassification'`), cascading into TS2366/TS7006; fixing those surfaces two further TS2835 in `toolClassification.ts` (`'./types'`) and `types.ts` (`'./messageTypes'`). Root `npm run typecheck` stays green because integration-tests is not a workspace, so the red program ships invisibly.
>
> Witness (A/B typecheck probe):
>
> ```
> BASE (merge-base 721e435f): exit 0
> PR: exit 2 — todos.ts(6,8) TS2835; todos.ts(7,36) TS2835; todos.ts(96,64) TS2366; todos.ts(194,8) TS7006
> add .js to the four import specifiers → exit 0
> ```
>
> Suggested fix: add `.js` extensions to the four extensionless imports in the pulled-in closure — `todos.ts` → `'../adapters/types.js'` and `'../adapters/toolClassification.js'`; `toolClassification.ts` → `'./types.js'`; `types.ts` → `'./messageTypes.js'`. Sibling files already use extensions and web-shell's own typecheck accepts them.
>
> <details><summary>中文说明</summary>
>
> **[Critical]** R1-1：该 import 把 web-shell 客户端源码图拉入了一直被维护的 `tsc -p integration-tests/tsconfig.json` 程序，而该源码图在其 nodenext 解析规则下无法编译。本 PR 之前没有任何 integration test 导入过 web-shell 源码，且该 tsconfig 的注释明确说明跨包导入的文件「也会在这里被检查，必须能解析自身的 import」。
>
> 失败场景：在该分支上运行 `cd integration-tests && npx tsc -p tsconfig.json` 会以 exit 2 失败（merge base 上 exit 0）——`packages/web-shell/client/utils/todos.ts` 中两处无扩展名相对导入（`'../adapters/types'` / `'../adapters/toolClassification'`）触发 TS2835 ×2，并级联出 TS2366/TS7006；修复这两处后还会暴露 `toolClassification.ts`（`'./types'`）和 `types.ts`（`'./messageTypes'`）的另外两处 TS2835。由于 integration-tests 不是 workspace，根目录 `npm run typecheck` 依然为绿，因此这个变红的 typecheck 程序会在无人察觉的情况下随 PR 合入。
>
> 证据（A/B typecheck 探针）：BASE（merge-base 721e435f）exit 0；PR 分支 exit 2（上述四个错误）；为四处 import 补上 `.js` 扩展名后恢复 exit 0。
>
> 建议修复：为被拉入闭包中的四处无扩展名导入补上 `.js` —— `todos.ts` → `'../adapters/types.js'`、`'../adapters/toolClassification.js'`；`toolClassification.ts` → `'./types.js'`；`types.ts` → `'./messageTypes.js'`。同目录的兄弟文件已在使用扩展名，web-shell 自身的 typecheck 也能接受。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 7. R1-8：契约测试未进入 PR 必需 CI

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470670
- 结论：值得修复
- 理由：必需 no-AK gate 执行根 `package.json` 中的精选测试列表，当前列表不含契约测试；PR 的 Integration Tests job 也因 path filter 被跳过。这样后续契约回归可在 PR CI 中漏过，违背预验证 MR 的门禁目的。
- 建议修复：把契约测试加入 `test:integration:no-ak:sandbox:none` 精选列表，并同步更新 no-AK CI wiring 测试。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:14`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
```

> **[Suggestion]** R1-8: The new contract suite is unreachable from every PR-gating CI check. integration-tests is not an npm workspace (root `test:ci` skips it), `ci.yml`'s required no-AK integration gate runs a curated file list that excludes this file, and `e2e.yml` — the only workflow collecting the full integration suite — triggers only on push to `main`, nightly schedule, and `workflow_dispatch` (its own comment says E2E is not in the merge queue). The suite passes today (4/4) but gates nothing at PR time.
>
> Failure scenario: this PR merges with the suite unexecuted by any required check; a future PR breaking the V1 transcript contract (SDK `daemon/transcript` projection or the web-shell `transcriptToMessages` adapter) leaves PR CI green and the regression surfaces only post-merge on `main` — defeating the prevalidation purpose of this PR.
>
> Witness (workflow trigger read): `e2e.yml` `on:` = push(main, feat/e2e/\*\*) + schedule + workflow_dispatch — no `pull_request`/`merge_group`; `ci.yml` no-AK gate = explicit 12-file curated list without this test; the `integration_cli` job's `cli` path filter does not match it.
>
> Suggested fix: add `./chat-transcript-contract.test.ts` to the no-AK integration gate's file list in `ci.yml` (it is fixture-only — no API keys, daemon, or CLI bundle needed), or state in the PR that post-merge-only coverage is intentional.
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-8：新增的契约测试套件无法被任何 PR 门禁 CI 检查执行到。integration-tests 不是 npm workspace（根目录 `test:ci` 会跳过它），`ci.yml` 中必需的 no-AK 集成门禁运行的是一个不含本文件的精选文件列表，而唯一收集完整集成套件的 `e2e.yml` 仅在 push 到 `main`、每日定时和手动触发时运行（其自身注释也说明 E2E 不在合并队列中）。该套件目前可以通过（4/4），但在 PR 阶段不构成任何门禁。
>
> 失败场景：本 PR 合入时该套件未被任何必需检查执行过；未来某个 PR 破坏 V1 transcript 契约（SDK `daemon/transcript` 投影或 web-shell `transcriptToMessages` 适配器）时，PR CI 依然为绿，回归只会在合入后于 `main` 上暴露——这违背了本 PR 预验证的初衷。
>
> 证据（workflow 触发条件核查）：`e2e.yml` `on:` = push(main, feat/e2e/\*\*) + schedule + workflow_dispatch，没有 `pull_request`/`merge_group`；`ci.yml` no-AK 门禁是不含本测试的 12 文件精选列表；`integration_cli` 任务的 `cli` 路径过滤也匹配不到它。
>
> 建议修复：把 `./chat-transcript-contract.test.ts` 加入 `ci.yml` 的 no-AK 集成门禁文件列表（它只依赖 fixture——不需要 API key、daemon 或 CLI bundle），或在 PR 中明确说明只覆盖合入后阶段是有意为之。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 8. R1-3：Identity probe 的语义键可能错误对齐

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470675
- 结论：值得修复
- 理由：当前实现直接用 Map 收集 `${kind}:${text}`，重复文本会静默覆盖；未显式支持的非文本 kind 又回退到被测 ordinal ID。fixture 扩展后可能产生错误对齐或漏报，评论的失败场景成立。
- 建议修复：只为 text、tool、permission 定义明确的语义键；对完整与部分输入分别断言键唯一；遇到不支持 kind 或重复键时给出清晰失败，并增加回归覆盖。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:146-148`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
+
+const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
+const fixtureRoot = resolve(
+  repoRoot,
+  'integration-tests/fixtures/chat-transcript-contract/v1',
+);
+const caseRoot = resolve(fixtureRoot, 'cases/representative');
+
+interface FixtureManifest {
+  readonly fixtureVersion: number;
+  readonly sources: readonly string[];
+  readonly consumers: readonly string[];
+  readonly complete: boolean;
+  readonly expectedDiagnostics: readonly string[];
+  readonly hashes: Readonly<Record<string, string>>;
+}
+
+interface ExpectedModel {
+  readonly kinds: readonly string[];
+  readonly sourceRecordIds: readonly (readonly string[])[];
+}
+
+interface ExpectedRenderItems {
+  readonly roles: readonly string[];
+  readonly runtimeFields: readonly string[];
+  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
+  readonly expectedToolResult: unknown;
+}
+
+interface ExpectedExportContract {
+  readonly schemaVersion: number;
+  readonly forbiddenFields: readonly string[];
+  readonly timestamps: number;
+  readonly implementation: string;
+}
+
+interface IdentityCandidateResult {
+  readonly status: 'fail';
+  readonly stableUnderPartialPrepend: false;
+  readonly unstableBlockKinds: readonly string[];
+  readonly missingNativeTextIdentity: readonly string[];
+}
+
+interface ExpectedGate {
+  readonly overall: 'fail';
+  readonly selectedVscodePath: null;
+  readonly candidates: {
+    readonly directDaemon: IdentityCandidateResult;
+    readonly acp: IdentityCandidateResult;
+  };
+  readonly blockers: readonly string[];
+}
+
+function readJson<T>(path: string): T {
+  return JSON.parse(readFileSync(path, 'utf8')) as T;
+}
+
+function readJsonLines<T>(path: string): T[] {
+  return readFileSync(path, 'utf8')
+    .trim()
+    .split('\n')
+    .map((line) => JSON.parse(line) as T);
+}
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+function collectDeclaredSchemaProperties(
+  value: unknown,
+  names = new Set<string>(),
+): Set<string> {
+  if (Array.isArray(value)) {
+    for (const item of value) collectDeclaredSchemaProperties(item, names);
+    return names;
+  }
+  if (!value || typeof value !== 'object') return names;
+
+  for (const [key, item] of Object.entries(value)) {
+    if (key === 'properties' && item && typeof item === 'object') {
+      for (const propertyName of Object.keys(item)) names.add(propertyName);
+    }
+    collectDeclaredSchemaProperties(item, names);
+  }
+  return names;
+}
+
+function reduceDaemonEvents(
+  events: readonly DaemonEvent[],
+): readonly DaemonTranscriptBlock[] {
+  let state = createDaemonTranscriptState({ now: 0 });
+  for (const event of events) {
+    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
+      now: 0,
+    });
+  }
+  return state.blocks;
+}
+
+function reduceAcpUpdates(
+  updates: readonly unknown[],
+): readonly DaemonTranscriptBlock[] {
+  return reduceDaemonEvents(
+    updates.map(
+      (update): DaemonEvent => ({
+        v: 1,
+        type: 'session_update',
+        data: { update },
+      }),
+    ),
+  );
+}
+
+function blockSemanticKey(block: DaemonTranscriptBlock): string {
+  if (
+    block.kind === 'user' ||
+    block.kind === 'assistant' ||
+    block.kind === 'thought'
+  ) {
+    return `${block.kind}:${block.text}`;
+  }
+  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
+  if (block.kind === 'permission') return `permission:${block.requestId}`;
+  return `${block.kind}:${block.id}`;
+}
+
+function probeIdentity(
+  complete: readonly DaemonTranscriptBlock[],
+  partial: readonly DaemonTranscriptBlock[],
+): IdentityCandidateResult {
+  const completeBySemanticKey = new Map(
+    complete.map((block) => [blockSemanticKey(block), block]),
+  );
```

> **[Suggestion]** R1-3: `probeIdentity` aligns blocks via `${kind}:${text}` semantic keys built into a Map, which silently deduplicates two same-kind blocks with identical text (aligning the wrong blocks); non-text kinds fall back to keying by `${kind}:${block.id}` — the very ordinal ID under test. Both assumptions are undocumented and break the moment the fixtures grow per design doc §11.2 (multi-delta streaming, replay, parallel tools).
>
> Failure scenario: MR2 adds a second same-kind text block with identical text (a retried prompt is plausible): the Map keeps the last block per key, the probe compares mismatched blocks, misreports `unstableBlockKinds` or silently omits a non-text block's instability, and `toEqual(expectedGate)` fails pointing at gate values rather than the key collision.
>
> Witness (probe through the real SDK reducer with two identical assistant texts):
>
> ```
> semantic keys: ['assistant:ok.', 'tool:t-1', 'assistant:ok.', 'debug:debug-4']
> key collisions: 1 | Map size: 3 (blocks: 4)
> partial assistant id=assistant-2 aligned-to complete id=assistant-3 (wrong block)
> ```
>
> (Current MR1 fixtures have all-distinct texts, so the suite is green today.)
>
> Suggested fix: assert semantic-key uniqueness inside `probeIdentity` with a clear error on duplicates, and handle non-text kinds explicitly instead of keying them by ordinal id; document the uniqueness assumption beside `blockSemanticKey`.
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-3：`probeIdentity` 通过 `${kind}:${text}` 语义键构建 Map 来对齐 block，相同 kind 且文本相同的两个 block 会被 Map 静默去重（导致对齐到错误的 block）；非文本 kind 则回退为用 `${kind}:${block.id}` 作键——恰恰使用了被测的 ordinal ID。这两个假设都没有文档说明，一旦按设计文档 §11.2 扩展 fixture（多 delta 流式、重放、并行工具）就会失效。
>
> 失败场景：MR2 增加第二个同 kind 且文本相同的 text block（重试的 prompt 很常见）时，Map 只保留同键的最后一个 block，探针会拿错配的 block 做比较，误报 `unstableBlockKinds` 或静默漏报某个非文本 block 的不稳定性，`toEqual(expectedGate)` 的失败信息会指向 gate 值而不是键冲突。
>
> 证据（用真实 SDK reducer 构造两个相同 assistant 文本的探针）：semantic keys 出现 1 次碰撞，Map size 3（实际 4 个 block），partial 侧 assistant-2 被对齐到 complete 侧的 assistant-3（错误 block）。当前 MR1 fixture 文本均不重复，所以套件目前为绿。
>
> 建议修复：在 `probeIdentity` 内断言语义键唯一性并在重复时给出清晰报错；非文本 kind 显式处理而不是用 ordinal id 作键；在 `blockSemanticKey` 旁注明唯一性假设。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 9. R1-11：Gate kind 数组没有集合归一化

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470682
- 结论：值得修复
- 理由：`unstableBlockKinds` 与 `missingNativeTextIdentity` 当前按 block 累加，而 frozen gate 把它们当 kind 集合。增加同 kind block 会引入重复项并造成与结论无关的 snapshot 失败。
- 建议修复：在保持首次出现顺序的前提下对两个数组去重，并用多 block 用例锁定集合语义。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:149`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
+
+const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
+const fixtureRoot = resolve(
+  repoRoot,
+  'integration-tests/fixtures/chat-transcript-contract/v1',
+);
+const caseRoot = resolve(fixtureRoot, 'cases/representative');
+
+interface FixtureManifest {
+  readonly fixtureVersion: number;
+  readonly sources: readonly string[];
+  readonly consumers: readonly string[];
+  readonly complete: boolean;
+  readonly expectedDiagnostics: readonly string[];
+  readonly hashes: Readonly<Record<string, string>>;
+}
+
+interface ExpectedModel {
+  readonly kinds: readonly string[];
+  readonly sourceRecordIds: readonly (readonly string[])[];
+}
+
+interface ExpectedRenderItems {
+  readonly roles: readonly string[];
+  readonly runtimeFields: readonly string[];
+  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
+  readonly expectedToolResult: unknown;
+}
+
+interface ExpectedExportContract {
+  readonly schemaVersion: number;
+  readonly forbiddenFields: readonly string[];
+  readonly timestamps: number;
+  readonly implementation: string;
+}
+
+interface IdentityCandidateResult {
+  readonly status: 'fail';
+  readonly stableUnderPartialPrepend: false;
+  readonly unstableBlockKinds: readonly string[];
+  readonly missingNativeTextIdentity: readonly string[];
+}
+
+interface ExpectedGate {
+  readonly overall: 'fail';
+  readonly selectedVscodePath: null;
+  readonly candidates: {
+    readonly directDaemon: IdentityCandidateResult;
+    readonly acp: IdentityCandidateResult;
+  };
+  readonly blockers: readonly string[];
+}
+
+function readJson<T>(path: string): T {
+  return JSON.parse(readFileSync(path, 'utf8')) as T;
+}
+
+function readJsonLines<T>(path: string): T[] {
+  return readFileSync(path, 'utf8')
+    .trim()
+    .split('\n')
+    .map((line) => JSON.parse(line) as T);
+}
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+function collectDeclaredSchemaProperties(
+  value: unknown,
+  names = new Set<string>(),
+): Set<string> {
+  if (Array.isArray(value)) {
+    for (const item of value) collectDeclaredSchemaProperties(item, names);
+    return names;
+  }
+  if (!value || typeof value !== 'object') return names;
+
+  for (const [key, item] of Object.entries(value)) {
+    if (key === 'properties' && item && typeof item === 'object') {
+      for (const propertyName of Object.keys(item)) names.add(propertyName);
+    }
+    collectDeclaredSchemaProperties(item, names);
+  }
+  return names;
+}
+
+function reduceDaemonEvents(
+  events: readonly DaemonEvent[],
+): readonly DaemonTranscriptBlock[] {
+  let state = createDaemonTranscriptState({ now: 0 });
+  for (const event of events) {
+    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
+      now: 0,
+    });
+  }
+  return state.blocks;
+}
+
+function reduceAcpUpdates(
+  updates: readonly unknown[],
+): readonly DaemonTranscriptBlock[] {
+  return reduceDaemonEvents(
+    updates.map(
+      (update): DaemonEvent => ({
+        v: 1,
+        type: 'session_update',
+        data: { update },
+      }),
+    ),
+  );
+}
+
+function blockSemanticKey(block: DaemonTranscriptBlock): string {
+  if (
+    block.kind === 'user' ||
+    block.kind === 'assistant' ||
+    block.kind === 'thought'
+  ) {
+    return `${block.kind}:${block.text}`;
+  }
+  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
+  if (block.kind === 'permission') return `permission:${block.requestId}`;
+  return `${block.kind}:${block.id}`;
+}
+
+function probeIdentity(
+  complete: readonly DaemonTranscriptBlock[],
+  partial: readonly DaemonTranscriptBlock[],
+): IdentityCandidateResult {
+  const completeBySemanticKey = new Map(
+    complete.map((block) => [blockSemanticKey(block), block]),
+  );
+  const unstableBlockKinds = partial.flatMap((block) => {
```

> **[Suggestion]** R1-11: `unstableBlockKinds` accumulates one entry per drifted block without de-duplication, while `expected-gate.json` encodes the kind arrays as sets (each kind once). The same per-block accumulation shape exists in `missingNativeTextIdentity` directly below.
>
> Failure scenario: MR2 fixture expansion per doc §11.2 adds a second same-kind text block; both drift under partial-prepend, producing `['thought','assistant','tool','assistant']`, and `toEqual(expectedGate)` fails even though the gate verdict (FAIL, same unstable kinds) is unchanged — forcing either confusing duplicates in the frozen gate record or a semantic change to the probe.
>
> Witness (probe with the real SDK reducer, fixture expanded with a second assistant text block): OBSERVED `unstableBlockKinds: ['thought','assistant','tool','assistant']` vs set-shaped expected → `toEqual` fails while the verdict is semantically unchanged; `[...new Set(observed)]` → `['thought','assistant','tool']` passes.
>
> ```typescript
> const unstableBlockKinds = [
>   ...new Set(
>     partial.flatMap((block) => {
>       const completeBlock = completeBySemanticKey.get(
>         blockSemanticKey(block),
>       );
>       return completeBlock && completeBlock.id !== block.id
>         ? [block.kind]
>         : [];
>     }),
>   ),
> ];
> ```
>
> (and the same normalization for `missingNativeTextIdentity`; document that the gate records the set of unstable kinds, not per-block counts)
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-11：`unstableBlockKinds` 按漂移的 block 逐个累加、没有去重，而 `expected-gate.json` 中的 kind 数组是按集合形式编码的（每个 kind 只出现一次）。紧邻下方的 `missingNativeTextIdentity` 存在同样的按 block 累加形式。
>
> 失败场景：按文档 §11.2 进行 MR2 fixture 扩展时，第二个同 kind 文本 block 在 partial-prepend 下同样漂移，产生 `['thought','assistant','tool','assistant']`，即使 gate 结论（FAIL、相同的不稳定 kind 集合）没有变化，`toEqual(expectedGate)` 也会失败——要么被迫在冻结的 gate 记录里写入令人困惑的重复项，要么被迫改变探针语义。
>
> 证据（真实 SDK reducer 探针，fixture 扩展第二个 assistant 文本 block）：观测到 `unstableBlockKinds: ['thought','assistant','tool','assistant']`，与集合形式的期望值 `toEqual` 失败，而结论语义未变；`[...new Set(observed)]` 后通过。
>
> 建议修复：比较前做归一化（上方代码），`missingNativeTextIdentity` 同样处理，并注明 gate 记录的是不稳定 kind 的集合而非按 block 的计数。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 10. R1-7：Manifest schema 没有验证真实 manifest

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470687
- 结论：值得修复
- 理由：测试只读取 schema 的 `additionalProperties`，并未执行 schema；新增禁止字段、空 capabilities 或非法 hash 格式都不会因 schema 失败。schema 当前只是展品，不是可执行契约。
- 建议修复：实际应用 manifest schema 的 required、additionalProperties、capabilities 和 hash pattern 约束，并增加非法额外字段的负向断言。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:204`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
+
+const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
+const fixtureRoot = resolve(
+  repoRoot,
+  'integration-tests/fixtures/chat-transcript-contract/v1',
+);
+const caseRoot = resolve(fixtureRoot, 'cases/representative');
+
+interface FixtureManifest {
+  readonly fixtureVersion: number;
+  readonly sources: readonly string[];
+  readonly consumers: readonly string[];
+  readonly complete: boolean;
+  readonly expectedDiagnostics: readonly string[];
+  readonly hashes: Readonly<Record<string, string>>;
+}
+
+interface ExpectedModel {
+  readonly kinds: readonly string[];
+  readonly sourceRecordIds: readonly (readonly string[])[];
+}
+
+interface ExpectedRenderItems {
+  readonly roles: readonly string[];
+  readonly runtimeFields: readonly string[];
+  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
+  readonly expectedToolResult: unknown;
+}
+
+interface ExpectedExportContract {
+  readonly schemaVersion: number;
+  readonly forbiddenFields: readonly string[];
+  readonly timestamps: number;
+  readonly implementation: string;
+}
+
+interface IdentityCandidateResult {
+  readonly status: 'fail';
+  readonly stableUnderPartialPrepend: false;
+  readonly unstableBlockKinds: readonly string[];
+  readonly missingNativeTextIdentity: readonly string[];
+}
+
+interface ExpectedGate {
+  readonly overall: 'fail';
+  readonly selectedVscodePath: null;
+  readonly candidates: {
+    readonly directDaemon: IdentityCandidateResult;
+    readonly acp: IdentityCandidateResult;
+  };
+  readonly blockers: readonly string[];
+}
+
+function readJson<T>(path: string): T {
+  return JSON.parse(readFileSync(path, 'utf8')) as T;
+}
+
+function readJsonLines<T>(path: string): T[] {
+  return readFileSync(path, 'utf8')
+    .trim()
+    .split('\n')
+    .map((line) => JSON.parse(line) as T);
+}
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+function collectDeclaredSchemaProperties(
+  value: unknown,
+  names = new Set<string>(),
+): Set<string> {
+  if (Array.isArray(value)) {
+    for (const item of value) collectDeclaredSchemaProperties(item, names);
+    return names;
+  }
+  if (!value || typeof value !== 'object') return names;
+
+  for (const [key, item] of Object.entries(value)) {
+    if (key === 'properties' && item && typeof item === 'object') {
+      for (const propertyName of Object.keys(item)) names.add(propertyName);
+    }
+    collectDeclaredSchemaProperties(item, names);
+  }
+  return names;
+}
+
+function reduceDaemonEvents(
+  events: readonly DaemonEvent[],
+): readonly DaemonTranscriptBlock[] {
+  let state = createDaemonTranscriptState({ now: 0 });
+  for (const event of events) {
+    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
+      now: 0,
+    });
+  }
+  return state.blocks;
+}
+
+function reduceAcpUpdates(
+  updates: readonly unknown[],
+): readonly DaemonTranscriptBlock[] {
+  return reduceDaemonEvents(
+    updates.map(
+      (update): DaemonEvent => ({
+        v: 1,
+        type: 'session_update',
+        data: { update },
+      }),
+    ),
+  );
+}
+
+function blockSemanticKey(block: DaemonTranscriptBlock): string {
+  if (
+    block.kind === 'user' ||
+    block.kind === 'assistant' ||
+    block.kind === 'thought'
+  ) {
+    return `${block.kind}:${block.text}`;
+  }
+  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
+  if (block.kind === 'permission') return `permission:${block.requestId}`;
+  return `${block.kind}:${block.id}`;
+}
+
+function probeIdentity(
+  complete: readonly DaemonTranscriptBlock[],
+  partial: readonly DaemonTranscriptBlock[],
+): IdentityCandidateResult {
+  const completeBySemanticKey = new Map(
+    complete.map((block) => [blockSemanticKey(block), block]),
+  );
+  const unstableBlockKinds = partial.flatMap((block) => {
+    const completeBlock = completeBySemanticKey.get(blockSemanticKey(block));
+    return completeBlock && completeBlock.id !== block.id ? [block.kind] : [];
+  });
+  const missingNativeTextIdentity = complete.flatMap((block) => {
+    if (
+      block.kind !== 'user' &&
+      block.kind !== 'assistant' &&
+      block.kind !== 'thought'
+    ) {
+      return [];
+    }
+    return block.sourceRecordIds?.length || block.promptId ? [] : [block.kind];
+  });
+
+  expect(unstableBlockKinds.length).toBeGreaterThan(0);
+  return {
+    status: 'fail',
+    stableUnderPartialPrepend: false,
+    unstableBlockKinds,
+    missingNativeTextIdentity,
+  };
+}
+
+describe('chat transcript contract prevalidation', () => {
+  it('locks the evidence fixtures, schemas, and fail-first capability decision', () => {
+    const manifest = readJson<FixtureManifest>(
+      resolve(caseRoot, 'manifest.json'),
+    );
+    const manifestSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/manifest.schema.json'),
+    );
+    const exportSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/export-transcript-document-v1.schema.json'),
+    );
+    const expectedExport = readJson<ExpectedExportContract>(
+      resolve(caseRoot, 'expected-export.json'),
+    );
+    const matrix = readFileSync(
+      resolve(fixtureRoot, 'capability-matrix.md'),
+      'utf8',
+    );
+
+    expect(manifest.fixtureVersion).toBe(1);
+    expect(manifest.complete).toBe(true);
+    expect(new Set(manifest.sources)).toEqual(
+      new Set(['daemon', 'acp', 'chat-records']),
+    );
+    expect(new Set(manifest.consumers)).toEqual(
+      new Set(['web', 'tauri', 'vscode', 'html']),
+    );
+    expect(manifest.expectedDiagnostics).toEqual([
+      'direct_daemon_unstable_identity',
+      'acp_unstable_identity',
+    ]);
+    expect(manifestSchema['additionalProperties']).toBe(false);
```

> **[Suggestion]** R1-7: `manifest.schema.json` is hash-locked and inspected for its `additionalProperties` flag, but never applied to validate `manifest.json` — the one live instance in this PR. Only `fixtureVersion`, `complete`, `sources`, `consumers`, `expectedDiagnostics` are individually asserted, so the schema is an exhibit, not an enforced contract.
>
> Failure scenario: MR2 requires editing `manifest.json`; it could gain a property the schema forbids, set `capabilities: []` (schema requires `minItems: 1`), or carry a non-`^[a-f0-9]{64}$` hash, and the test stays green. Nothing in the repo says whether the schema or the actual manifest is normative.
>
> Witness (mutation probe): `manifest.json` + `orphanPropertyForbiddenBySchema: true` + `capabilities: []` → Tests 4 passed (4). Corrupting an enumerated hash value did fail test 1 — the SHA loop is the only manifest-level protection that actually fires.
>
> Suggested fix: validate `manifest.json` against `manifest.schema.json` in this same test (ajv, or explicit required/additionalProperties/hash-pattern checks covering `capabilities` and `hashes`).
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-7：`manifest.schema.json` 被 hash 锁定并检查了 `additionalProperties` 标志，但从未被用来校验 `manifest.json`——本 PR 中唯一的真实实例。测试只单独断言了 `fixtureVersion`、`complete`、`sources`、`consumers`、`expectedDiagnostics`，因此该 schema 只是展品，而不是被执行的契约。
>
> 失败场景：MR2 需要编辑 `manifest.json` 时，它可以增加 schema 禁止的属性、把 `capabilities` 设为 `[]`（schema 要求 `minItems: 1`）、或携带不符合 `^[a-f0-9]{64}$` 的 hash，测试仍然为绿。仓库中没有任何地方说明 schema 和实际 manifest 哪个是权威。
>
> 证据（变异探针）：给 `manifest.json` 加上 schema 禁止的孤立属性并把 `capabilities` 置空后 → Tests 4 passed (4)。而破坏已枚举的 hash 值确实会让 test 1 失败——SHA 循环是唯一真正生效的 manifest 层保护。
>
> 建议修复：在同一测试中用 `manifest.schema.json` 校验 `manifest.json`（ajv，或显式的 required/additionalProperties/hash 格式检查，覆盖 `capabilities` 和 `hashes`）。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 11. R1-6：冻结 errorKind 与增长型 SDK 常量全等耦合

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470690
- 结论：值得修复
- 理由：对 frozen V1 enum 与 `DAEMON_ERROR_KINDS` 做顺序敏感全等，会让 SDK 新增合法错误类型时迫使修改已冻结 schema。该行为与文档的 schema 版本规则冲突。
- 建议修复：在 fixture 中冻结 V1 error kinds，schema 与 frozen copy 全等；另断言 frozen kinds 是当前 SDK 常量的子集，以便删除或改名仍能暴露。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:216`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
+
+const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
+const fixtureRoot = resolve(
+  repoRoot,
+  'integration-tests/fixtures/chat-transcript-contract/v1',
+);
+const caseRoot = resolve(fixtureRoot, 'cases/representative');
+
+interface FixtureManifest {
+  readonly fixtureVersion: number;
+  readonly sources: readonly string[];
+  readonly consumers: readonly string[];
+  readonly complete: boolean;
+  readonly expectedDiagnostics: readonly string[];
+  readonly hashes: Readonly<Record<string, string>>;
+}
+
+interface ExpectedModel {
+  readonly kinds: readonly string[];
+  readonly sourceRecordIds: readonly (readonly string[])[];
+}
+
+interface ExpectedRenderItems {
+  readonly roles: readonly string[];
+  readonly runtimeFields: readonly string[];
+  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
+  readonly expectedToolResult: unknown;
+}
+
+interface ExpectedExportContract {
+  readonly schemaVersion: number;
+  readonly forbiddenFields: readonly string[];
+  readonly timestamps: number;
+  readonly implementation: string;
+}
+
+interface IdentityCandidateResult {
+  readonly status: 'fail';
+  readonly stableUnderPartialPrepend: false;
+  readonly unstableBlockKinds: readonly string[];
+  readonly missingNativeTextIdentity: readonly string[];
+}
+
+interface ExpectedGate {
+  readonly overall: 'fail';
+  readonly selectedVscodePath: null;
+  readonly candidates: {
+    readonly directDaemon: IdentityCandidateResult;
+    readonly acp: IdentityCandidateResult;
+  };
+  readonly blockers: readonly string[];
+}
+
+function readJson<T>(path: string): T {
+  return JSON.parse(readFileSync(path, 'utf8')) as T;
+}
+
+function readJsonLines<T>(path: string): T[] {
+  return readFileSync(path, 'utf8')
+    .trim()
+    .split('\n')
+    .map((line) => JSON.parse(line) as T);
+}
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+function collectDeclaredSchemaProperties(
+  value: unknown,
+  names = new Set<string>(),
+): Set<string> {
+  if (Array.isArray(value)) {
+    for (const item of value) collectDeclaredSchemaProperties(item, names);
+    return names;
+  }
+  if (!value || typeof value !== 'object') return names;
+
+  for (const [key, item] of Object.entries(value)) {
+    if (key === 'properties' && item && typeof item === 'object') {
+      for (const propertyName of Object.keys(item)) names.add(propertyName);
+    }
+    collectDeclaredSchemaProperties(item, names);
+  }
+  return names;
+}
+
+function reduceDaemonEvents(
+  events: readonly DaemonEvent[],
+): readonly DaemonTranscriptBlock[] {
+  let state = createDaemonTranscriptState({ now: 0 });
+  for (const event of events) {
+    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
+      now: 0,
+    });
+  }
+  return state.blocks;
+}
+
+function reduceAcpUpdates(
+  updates: readonly unknown[],
+): readonly DaemonTranscriptBlock[] {
+  return reduceDaemonEvents(
+    updates.map(
+      (update): DaemonEvent => ({
+        v: 1,
+        type: 'session_update',
+        data: { update },
+      }),
+    ),
+  );
+}
+
+function blockSemanticKey(block: DaemonTranscriptBlock): string {
+  if (
+    block.kind === 'user' ||
+    block.kind === 'assistant' ||
+    block.kind === 'thought'
+  ) {
+    return `${block.kind}:${block.text}`;
+  }
+  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
+  if (block.kind === 'permission') return `permission:${block.requestId}`;
+  return `${block.kind}:${block.id}`;
+}
+
+function probeIdentity(
+  complete: readonly DaemonTranscriptBlock[],
+  partial: readonly DaemonTranscriptBlock[],
+): IdentityCandidateResult {
+  const completeBySemanticKey = new Map(
+    complete.map((block) => [blockSemanticKey(block), block]),
+  );
+  const unstableBlockKinds = partial.flatMap((block) => {
+    const completeBlock = completeBySemanticKey.get(blockSemanticKey(block));
+    return completeBlock && completeBlock.id !== block.id ? [block.kind] : [];
+  });
+  const missingNativeTextIdentity = complete.flatMap((block) => {
+    if (
+      block.kind !== 'user' &&
+      block.kind !== 'assistant' &&
+      block.kind !== 'thought'
+    ) {
+      return [];
+    }
+    return block.sourceRecordIds?.length || block.promptId ? [] : [block.kind];
+  });
+
+  expect(unstableBlockKinds.length).toBeGreaterThan(0);
+  return {
+    status: 'fail',
+    stableUnderPartialPrepend: false,
+    unstableBlockKinds,
+    missingNativeTextIdentity,
+  };
+}
+
+describe('chat transcript contract prevalidation', () => {
+  it('locks the evidence fixtures, schemas, and fail-first capability decision', () => {
+    const manifest = readJson<FixtureManifest>(
+      resolve(caseRoot, 'manifest.json'),
+    );
+    const manifestSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/manifest.schema.json'),
+    );
+    const exportSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/export-transcript-document-v1.schema.json'),
+    );
+    const expectedExport = readJson<ExpectedExportContract>(
+      resolve(caseRoot, 'expected-export.json'),
+    );
+    const matrix = readFileSync(
+      resolve(fixtureRoot, 'capability-matrix.md'),
+      'utf8',
+    );
+
+    expect(manifest.fixtureVersion).toBe(1);
+    expect(manifest.complete).toBe(true);
+    expect(new Set(manifest.sources)).toEqual(
+      new Set(['daemon', 'acp', 'chat-records']),
+    );
+    expect(new Set(manifest.consumers)).toEqual(
+      new Set(['web', 'tauri', 'vscode', 'html']),
+    );
+    expect(manifest.expectedDiagnostics).toEqual([
+      'direct_daemon_unstable_identity',
+      'acp_unstable_identity',
+    ]);
+    expect(manifestSchema['additionalProperties']).toBe(false);
+    expect(exportSchema['additionalProperties']).toBe(false);
+
+    const exportDefinitions = exportSchema['$defs'] as Record<string, unknown>;
+    const blockSchema = exportDefinitions['block'] as {
+      oneOf: Array<{ $ref: string }>;
+    };
+    expect(blockSchema.oneOf).toHaveLength(10);
+    for (const definitionName of ['statusBlock', 'errorBlock']) {
+      const definition = exportDefinitions[definitionName] as {
+        properties: { errorKind: { enum: string[] } };
+      };
+      expect(definition.properties.errorKind.enum).toEqual(DAEMON_ERROR_KINDS);
```

> **[Suggestion]** R1-6: Both frozen `errorKind` enums are asserted with `toEqual` against the live, actively-growing SDK `DAEMON_ERROR_KINDS` constant (16 entries; its comments document successive growth), hard-coupling this evidence suite to SDK taxonomy changes. The obvious fix when it breaks — widening the frozen hashed enum — contradicts the design doc's schema-immutability rules (§10.10 lists schema widening as a canary failure; §10.11 says allowlist changes bump `schemaVersion`).
>
> Failure scenario: a routine SDK PR adds a 17th daemon error kind; this `toEqual` fails and blocks that unrelated PR until someone edits the "frozen" hashed schema and recomputes manifest hashes — i.e. is pushed into violating the contract the test exists to protect.
>
> Witness: not run — static coupling claim: `toEqual` on an imported growing const (order-sensitive); the suite's green run proves today's 16/16 equality, the growth scenario is trace-only.
>
> Suggested fix: freeze the enum list inside the fixture (e.g. add `frozenErrorKinds` to `expected-export.json`), compare the schema against that frozen copy, and separately assert the frozen list is a subset of `DAEMON_ERROR_KINDS` with an assertion message pointing at the design doc.
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-6：两处冻结的 `errorKind` 枚举都用 `toEqual` 与仍在活跃增长的 SDK 常量 `DAEMON_ERROR_KINDS`（当前 16 项，其注释记录了历次增长）做全等断言，把本证据套件与 SDK 分类变化硬耦合。它出错时显而易见的修法——扩大冻结且被 hash 锁定的枚举——恰恰违背设计文档的 schema 不可变规则（§10.10 把 schema widening 列为金丝雀失败；§10.11 规定 allowlist 变更必须 bump `schemaVersion`）。
>
> 失败场景：一次例行 SDK PR 增加第 17 个 daemon error kind，这个 `toEqual` 就会失败并阻塞那个无关 PR，直到有人去改「冻结」的 hash 锁定 schema 并重算 manifest hash——即被迫违反该测试本要保护的契约。
>
> 证据：未运行——静态耦合结论：对导入的增长型常量做顺序敏感的 `toEqual`；套件的绿色运行证明了当前 16/16 相等，增长场景仅为推演。
>
> 建议修复：把枚举列表冻结进 fixture（例如在 `expected-export.json` 中增加 `frozenErrorKinds`），schema 与该冻结副本比较，另外断言冻结列表是 `DAEMON_ERROR_KINDS` 的子集，并在断言信息中指向设计文档。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 12. R1-2：Fixture hash 枚举不完整

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470694
- 结论：值得修复
- 理由：`capability-matrix.md` 未被 hash，测试也只遍历 manifest 已声明的键；删除某个 hash 条目会静默解锁对应证据。评论指出的两处漏洞都能从当前实现直接确认。
- 建议修复：递归枚举 fixture 根下所有应锁定文件（排除会形成自引用的 manifest），与 manifest hash key 集合做全等比较，并加入 capability matrix hash。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:233-235`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
+
+const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
+const fixtureRoot = resolve(
+  repoRoot,
+  'integration-tests/fixtures/chat-transcript-contract/v1',
+);
+const caseRoot = resolve(fixtureRoot, 'cases/representative');
+
+interface FixtureManifest {
+  readonly fixtureVersion: number;
+  readonly sources: readonly string[];
+  readonly consumers: readonly string[];
+  readonly complete: boolean;
+  readonly expectedDiagnostics: readonly string[];
+  readonly hashes: Readonly<Record<string, string>>;
+}
+
+interface ExpectedModel {
+  readonly kinds: readonly string[];
+  readonly sourceRecordIds: readonly (readonly string[])[];
+}
+
+interface ExpectedRenderItems {
+  readonly roles: readonly string[];
+  readonly runtimeFields: readonly string[];
+  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
+  readonly expectedToolResult: unknown;
+}
+
+interface ExpectedExportContract {
+  readonly schemaVersion: number;
+  readonly forbiddenFields: readonly string[];
+  readonly timestamps: number;
+  readonly implementation: string;
+}
+
+interface IdentityCandidateResult {
+  readonly status: 'fail';
+  readonly stableUnderPartialPrepend: false;
+  readonly unstableBlockKinds: readonly string[];
+  readonly missingNativeTextIdentity: readonly string[];
+}
+
+interface ExpectedGate {
+  readonly overall: 'fail';
+  readonly selectedVscodePath: null;
+  readonly candidates: {
+    readonly directDaemon: IdentityCandidateResult;
+    readonly acp: IdentityCandidateResult;
+  };
+  readonly blockers: readonly string[];
+}
+
+function readJson<T>(path: string): T {
+  return JSON.parse(readFileSync(path, 'utf8')) as T;
+}
+
+function readJsonLines<T>(path: string): T[] {
+  return readFileSync(path, 'utf8')
+    .trim()
+    .split('\n')
+    .map((line) => JSON.parse(line) as T);
+}
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+function collectDeclaredSchemaProperties(
+  value: unknown,
+  names = new Set<string>(),
+): Set<string> {
+  if (Array.isArray(value)) {
+    for (const item of value) collectDeclaredSchemaProperties(item, names);
+    return names;
+  }
+  if (!value || typeof value !== 'object') return names;
+
+  for (const [key, item] of Object.entries(value)) {
+    if (key === 'properties' && item && typeof item === 'object') {
+      for (const propertyName of Object.keys(item)) names.add(propertyName);
+    }
+    collectDeclaredSchemaProperties(item, names);
+  }
+  return names;
+}
+
+function reduceDaemonEvents(
+  events: readonly DaemonEvent[],
+): readonly DaemonTranscriptBlock[] {
+  let state = createDaemonTranscriptState({ now: 0 });
+  for (const event of events) {
+    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
+      now: 0,
+    });
+  }
+  return state.blocks;
+}
+
+function reduceAcpUpdates(
+  updates: readonly unknown[],
+): readonly DaemonTranscriptBlock[] {
+  return reduceDaemonEvents(
+    updates.map(
+      (update): DaemonEvent => ({
+        v: 1,
+        type: 'session_update',
+        data: { update },
+      }),
+    ),
+  );
+}
+
+function blockSemanticKey(block: DaemonTranscriptBlock): string {
+  if (
+    block.kind === 'user' ||
+    block.kind === 'assistant' ||
+    block.kind === 'thought'
+  ) {
+    return `${block.kind}:${block.text}`;
+  }
+  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
+  if (block.kind === 'permission') return `permission:${block.requestId}`;
+  return `${block.kind}:${block.id}`;
+}
+
+function probeIdentity(
+  complete: readonly DaemonTranscriptBlock[],
+  partial: readonly DaemonTranscriptBlock[],
+): IdentityCandidateResult {
+  const completeBySemanticKey = new Map(
+    complete.map((block) => [blockSemanticKey(block), block]),
+  );
+  const unstableBlockKinds = partial.flatMap((block) => {
+    const completeBlock = completeBySemanticKey.get(blockSemanticKey(block));
+    return completeBlock && completeBlock.id !== block.id ? [block.kind] : [];
+  });
+  const missingNativeTextIdentity = complete.flatMap((block) => {
+    if (
+      block.kind !== 'user' &&
+      block.kind !== 'assistant' &&
+      block.kind !== 'thought'
+    ) {
+      return [];
+    }
+    return block.sourceRecordIds?.length || block.promptId ? [] : [block.kind];
+  });
+
+  expect(unstableBlockKinds.length).toBeGreaterThan(0);
+  return {
+    status: 'fail',
+    stableUnderPartialPrepend: false,
+    unstableBlockKinds,
+    missingNativeTextIdentity,
+  };
+}
+
+describe('chat transcript contract prevalidation', () => {
+  it('locks the evidence fixtures, schemas, and fail-first capability decision', () => {
+    const manifest = readJson<FixtureManifest>(
+      resolve(caseRoot, 'manifest.json'),
+    );
+    const manifestSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/manifest.schema.json'),
+    );
+    const exportSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/export-transcript-document-v1.schema.json'),
+    );
+    const expectedExport = readJson<ExpectedExportContract>(
+      resolve(caseRoot, 'expected-export.json'),
+    );
+    const matrix = readFileSync(
+      resolve(fixtureRoot, 'capability-matrix.md'),
+      'utf8',
+    );
+
+    expect(manifest.fixtureVersion).toBe(1);
+    expect(manifest.complete).toBe(true);
+    expect(new Set(manifest.sources)).toEqual(
+      new Set(['daemon', 'acp', 'chat-records']),
+    );
+    expect(new Set(manifest.consumers)).toEqual(
+      new Set(['web', 'tauri', 'vscode', 'html']),
+    );
+    expect(manifest.expectedDiagnostics).toEqual([
+      'direct_daemon_unstable_identity',
+      'acp_unstable_identity',
+    ]);
+    expect(manifestSchema['additionalProperties']).toBe(false);
+    expect(exportSchema['additionalProperties']).toBe(false);
+
+    const exportDefinitions = exportSchema['$defs'] as Record<string, unknown>;
+    const blockSchema = exportDefinitions['block'] as {
+      oneOf: Array<{ $ref: string }>;
+    };
+    expect(blockSchema.oneOf).toHaveLength(10);
+    for (const definitionName of ['statusBlock', 'errorBlock']) {
+      const definition = exportDefinitions[definitionName] as {
+        properties: { errorKind: { enum: string[] } };
+      };
+      expect(definition.properties.errorKind.enum).toEqual(DAEMON_ERROR_KINDS);
+    }
+    const declaredExportProperties =
+      collectDeclaredSchemaProperties(exportSchema);
+    for (const field of expectedExport.forbiddenFields) {
+      expect(declaredExportProperties.has(field), field).toBe(false);
+    }
+    const permissionOption = exportDefinitions['permissionOption'] as {
+      properties: { raw: { const: unknown } };
+    };
+    expect(permissionOption.properties.raw.const).toBeNull();
+    expect(expectedExport).toMatchObject({
+      schemaVersion: 1,
+      timestamps: 0,
+      implementation: 'deferred-to-mr2',
+    });
+
+    for (const [relativePath, expectedHash] of Object.entries(
+      manifest.hashes,
+    )) {
```

> **[Suggestion]** R1-2: The SHA-256 lock verifies only the entries the manifest enumerates and never that the enumeration is complete. Two holes: (a) `capability-matrix.md` is the only evidence artifact under the fixture root **not** in `manifest.hashes` — guarded only by two `toContain` strings and one negative regex; (b) nothing asserts the key set of `manifest.hashes`, so deleting a hash entry silently unlocks that fixture. Both contradict the design doc's own risk control (§16: hash pinning prevents snapshot edits from hiding blockers).
>
> Failure scenario: flipping the matrix's `DEFERRED`/`BLOCKED` gate cells to PASS-style wording (preserving the two asserted substrings), or deleting a fixture's hash line from `manifest.json` and weakening that fixture, passes the suite silently — falsifying the gate evidence this PR exists to freeze.
>
> Witness (mutation probes): matrix `DEFERRED`/`BLOCKED` → `PASS` with asserted substrings preserved → Tests 4 passed (4); deleted `expected-export.json` hash entry + trimmed `forbiddenFields` 8→6 → Tests 4 passed (4).
>
> Suggested fix: assert the hash key set is complete (enumerate the files under `cases/` and `schema/` of the fixture root and require each to have a `manifest.hashes` entry) and add `capability-matrix.md` to `manifest.hashes`.
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-2：SHA-256 锁定只校验 manifest 中已枚举的条目，从不校验枚举本身是否完整。两个漏洞：(a) `capability-matrix.md` 是 fixture 根目录下唯一不在 `manifest.hashes` 中的证据文件——只有两个 `toContain` 字符串和一个负向正则保护；(b) 没有任何断言约束 `manifest.hashes` 的键集合，删掉某个 hash 条目就会静默解锁对应 fixture。两者都违背设计文档自身的风险控制（§16：hash 锁定用于防止通过编辑快照掩盖 blocker）。
>
> 失败场景：把 matrix 中 `DEFERRED`/`BLOCKED` 的 gate 单元格改成 PASS 措辞（保留两个被断言的子串），或从 `manifest.json` 删除某 fixture 的 hash 行并弱化该 fixture，套件都会静默通过——伪造了本 PR 要冻结的 gate 证据。
>
> 证据（变异探针）：matrix `DEFERRED`/`BLOCKED` 改为 `PASS`（保留断言子串）→ Tests 4 passed (4)；删除 `expected-export.json` 的 hash 条目并把 `forbiddenFields` 从 8 项裁到 6 项 → Tests 4 passed (4)。
>
> 建议修复：断言 hash 键集合完整（枚举 fixture 根目录下 `cases/` 与 `schema/` 中的文件，要求每个都在 `manifest.hashes` 中有条目），并把 `capability-matrix.md` 加入 `manifest.hashes`。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 13. R1-10：等价性证据未覆盖用户可见文本

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470699
- 结论：值得修复
- 理由：现有断言覆盖 kinds、source IDs、roles 与工具 raw 字段，但没有断言 user/thought/assistant 文本或对应 renderer message content；文本损坏仍可被错误认证为 PASS。
- 建议修复：在 expected model/render fixture 中加入特征文本，分别断言 projector block 文本和 Web Shell message content，并更新 hash。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:262-264`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
+
+const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
+const fixtureRoot = resolve(
+  repoRoot,
+  'integration-tests/fixtures/chat-transcript-contract/v1',
+);
+const caseRoot = resolve(fixtureRoot, 'cases/representative');
+
+interface FixtureManifest {
+  readonly fixtureVersion: number;
+  readonly sources: readonly string[];
+  readonly consumers: readonly string[];
+  readonly complete: boolean;
+  readonly expectedDiagnostics: readonly string[];
+  readonly hashes: Readonly<Record<string, string>>;
+}
+
+interface ExpectedModel {
+  readonly kinds: readonly string[];
+  readonly sourceRecordIds: readonly (readonly string[])[];
+}
+
+interface ExpectedRenderItems {
+  readonly roles: readonly string[];
+  readonly runtimeFields: readonly string[];
+  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
+  readonly expectedToolResult: unknown;
+}
+
+interface ExpectedExportContract {
+  readonly schemaVersion: number;
+  readonly forbiddenFields: readonly string[];
+  readonly timestamps: number;
+  readonly implementation: string;
+}
+
+interface IdentityCandidateResult {
+  readonly status: 'fail';
+  readonly stableUnderPartialPrepend: false;
+  readonly unstableBlockKinds: readonly string[];
+  readonly missingNativeTextIdentity: readonly string[];
+}
+
+interface ExpectedGate {
+  readonly overall: 'fail';
+  readonly selectedVscodePath: null;
+  readonly candidates: {
+    readonly directDaemon: IdentityCandidateResult;
+    readonly acp: IdentityCandidateResult;
+  };
+  readonly blockers: readonly string[];
+}
+
+function readJson<T>(path: string): T {
+  return JSON.parse(readFileSync(path, 'utf8')) as T;
+}
+
+function readJsonLines<T>(path: string): T[] {
+  return readFileSync(path, 'utf8')
+    .trim()
+    .split('\n')
+    .map((line) => JSON.parse(line) as T);
+}
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+function collectDeclaredSchemaProperties(
+  value: unknown,
+  names = new Set<string>(),
+): Set<string> {
+  if (Array.isArray(value)) {
+    for (const item of value) collectDeclaredSchemaProperties(item, names);
+    return names;
+  }
+  if (!value || typeof value !== 'object') return names;
+
+  for (const [key, item] of Object.entries(value)) {
+    if (key === 'properties' && item && typeof item === 'object') {
+      for (const propertyName of Object.keys(item)) names.add(propertyName);
+    }
+    collectDeclaredSchemaProperties(item, names);
+  }
+  return names;
+}
+
+function reduceDaemonEvents(
+  events: readonly DaemonEvent[],
+): readonly DaemonTranscriptBlock[] {
+  let state = createDaemonTranscriptState({ now: 0 });
+  for (const event of events) {
+    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
+      now: 0,
+    });
+  }
+  return state.blocks;
+}
+
+function reduceAcpUpdates(
+  updates: readonly unknown[],
+): readonly DaemonTranscriptBlock[] {
+  return reduceDaemonEvents(
+    updates.map(
+      (update): DaemonEvent => ({
+        v: 1,
+        type: 'session_update',
+        data: { update },
+      }),
+    ),
+  );
+}
+
+function blockSemanticKey(block: DaemonTranscriptBlock): string {
+  if (
+    block.kind === 'user' ||
+    block.kind === 'assistant' ||
+    block.kind === 'thought'
+  ) {
+    return `${block.kind}:${block.text}`;
+  }
+  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
+  if (block.kind === 'permission') return `permission:${block.requestId}`;
+  return `${block.kind}:${block.id}`;
+}
+
+function probeIdentity(
+  complete: readonly DaemonTranscriptBlock[],
+  partial: readonly DaemonTranscriptBlock[],
+): IdentityCandidateResult {
+  const completeBySemanticKey = new Map(
+    complete.map((block) => [blockSemanticKey(block), block]),
+  );
+  const unstableBlockKinds = partial.flatMap((block) => {
+    const completeBlock = completeBySemanticKey.get(blockSemanticKey(block));
+    return completeBlock && completeBlock.id !== block.id ? [block.kind] : [];
+  });
+  const missingNativeTextIdentity = complete.flatMap((block) => {
+    if (
+      block.kind !== 'user' &&
+      block.kind !== 'assistant' &&
+      block.kind !== 'thought'
+    ) {
+      return [];
+    }
+    return block.sourceRecordIds?.length || block.promptId ? [] : [block.kind];
+  });
+
+  expect(unstableBlockKinds.length).toBeGreaterThan(0);
+  return {
+    status: 'fail',
+    stableUnderPartialPrepend: false,
+    unstableBlockKinds,
+    missingNativeTextIdentity,
+  };
+}
+
+describe('chat transcript contract prevalidation', () => {
+  it('locks the evidence fixtures, schemas, and fail-first capability decision', () => {
+    const manifest = readJson<FixtureManifest>(
+      resolve(caseRoot, 'manifest.json'),
+    );
+    const manifestSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/manifest.schema.json'),
+    );
+    const exportSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/export-transcript-document-v1.schema.json'),
+    );
+    const expectedExport = readJson<ExpectedExportContract>(
+      resolve(caseRoot, 'expected-export.json'),
+    );
+    const matrix = readFileSync(
+      resolve(fixtureRoot, 'capability-matrix.md'),
+      'utf8',
+    );
+
+    expect(manifest.fixtureVersion).toBe(1);
+    expect(manifest.complete).toBe(true);
+    expect(new Set(manifest.sources)).toEqual(
+      new Set(['daemon', 'acp', 'chat-records']),
+    );
+    expect(new Set(manifest.consumers)).toEqual(
+      new Set(['web', 'tauri', 'vscode', 'html']),
+    );
+    expect(manifest.expectedDiagnostics).toEqual([
+      'direct_daemon_unstable_identity',
+      'acp_unstable_identity',
+    ]);
+    expect(manifestSchema['additionalProperties']).toBe(false);
+    expect(exportSchema['additionalProperties']).toBe(false);
+
+    const exportDefinitions = exportSchema['$defs'] as Record<string, unknown>;
+    const blockSchema = exportDefinitions['block'] as {
+      oneOf: Array<{ $ref: string }>;
+    };
+    expect(blockSchema.oneOf).toHaveLength(10);
+    for (const definitionName of ['statusBlock', 'errorBlock']) {
+      const definition = exportDefinitions[definitionName] as {
+        properties: { errorKind: { enum: string[] } };
+      };
+      expect(definition.properties.errorKind.enum).toEqual(DAEMON_ERROR_KINDS);
+    }
+    const declaredExportProperties =
+      collectDeclaredSchemaProperties(exportSchema);
+    for (const field of expectedExport.forbiddenFields) {
+      expect(declaredExportProperties.has(field), field).toBe(false);
+    }
+    const permissionOption = exportDefinitions['permissionOption'] as {
+      properties: { raw: { const: unknown } };
+    };
+    expect(permissionOption.properties.raw.const).toBeNull();
+    expect(expectedExport).toMatchObject({
+      schemaVersion: 1,
+      timestamps: 0,
+      implementation: 'deferred-to-mr2',
+    });
+
+    for (const [relativePath, expectedHash] of Object.entries(
+      manifest.hashes,
+    )) {
+      expect(sha256(resolve(fixtureRoot, relativePath))).toBe(expectedHash);
+    }
+    expect(matrix).toContain('FAIL — migration blocked');
+    expect(matrix).toContain('No VS Code transport is selected in MR1');
+    expect(matrix).not.toMatch(/pass; selected/i);
+  });
+
+  it('preserves current ChatRecord and Web Shell runtime semantics', () => {
+    const records = readJsonLines<unknown>(
+      resolve(caseRoot, 'chat-records.jsonl'),
+    );
+    const expected = readJson<ExpectedModel>(
+      resolve(caseRoot, 'expected-model.json'),
+    );
+    const expectedRender = readJson<ExpectedRenderItems>(
+      resolve(caseRoot, 'expected-render-items.json'),
+    );
+    const projection = projectChatRecordsToDaemonTranscript(records);
+    const messages = transcriptBlocksToDaemonMessages(projection.blocks);
+    const toolBlock = projection.blocks.find((block) => block.kind === 'tool');
+    const toolMessage = messages.find(
+      (message) => message.role === 'tool_group',
+    );
+
+    expect(projection.complete).toBe(true);
+    expect(projection.diagnostics).toEqual([]);
+    expect(projection.blocks.map((block) => block.kind)).toEqual(
+      expected.kinds,
+    );
```

> **[Suggestion]** R1-10: This equivalence test asserts only `kinds`, `sourceRecordIds`, message `roles`, and the tool's `rawInput`/`rawOutput` — user/thought/assistant block texts and message contents are never verified. This test is the shipped PASS evidence for "ChatRecord semantic projection" and "Web Shell runtime compatibility" in `capability-matrix.md`, and MR2 HTML Export rebuilds user-visible text from exactly this projector (doc §9.6).
>
> Failure scenario: a regression in `projectChatRecordsToDaemonTranscript` corrupting, dropping, or swapping user/thought/assistant text (e.g. a refactor of `thought: true` part handling) leaves kinds, sourceRecordIds, roles and tool raw fields unchanged — the entire shipped evidence chain stays green and silently lost text is re-certified as PASS evidence.
>
> Witness (mutant probe — thought parts emit reversed text): integration 4/4, SDK unit 15/15, acp-bridge 35/35, CLI conformance 1/1, web-shell 131/131 — all green (`'Checking identity'` → `'ytitnedi gnikcehC'`); a probe asserting block texts + message contents flipped RED under the mutant, GREEN after revert. The counter-claim (`transcriptToMessages.test.ts` asserts content) was checked: that suite uses hand-built blocks with literal text and never imports the projector.
>
> Suggested fix: add a `texts` array to `expected-model.json` (the fixture already carries distinctive strings: `'Inspect the contract'`, `'Checking identity'`, `'The contract is stable.'`), assert block texts plus the produced user/thinking/assistant message contents, and re-hash `expected-model.json` in `manifest.json`.
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-10：该等价性测试只断言了 `kinds`、`sourceRecordIds`、消息 `roles` 以及工具的 `rawInput`/`rawOutput`——user/thought/assistant block 的文本和消息内容从未被校验。这个测试正是 `capability-matrix.md` 中「ChatRecord 语义投影」与「Web Shell 运行时兼容性」两行 PASS 结论的证据，而 MR2 的 HTML Export 恰恰要从这个 projector 重建用户可见文本（文档 §9.6）。
>
> 失败场景：`projectChatRecordsToDaemonTranscript` 中破坏、丢弃或调换 user/thought/assistant 文本的回归（例如重构 `thought: true` part 处理），不会改变 kinds、sourceRecordIds、roles 和工具 raw 字段——整条已交付的证据链依然为绿，被静默丢失的文本还会被再次认证为 PASS 证据。
>
> 证据（变异探针——thought part 输出反转文本）：integration 4/4、SDK unit 15/15、acp-bridge 35/35、CLI conformance 1/1、web-shell 131/131 全部为绿（`'Checking identity'` 变成 `'ytitnedi gnikcehC'`）；而断言 block 文本与消息内容的探针在变异下变红、还原后变绿。对反方观点（`transcriptToMessages.test.ts` 断言了内容）已核查：该套件使用手工构造、带字面文本的 block，从未导入该 projector。
>
> 建议修复：在 `expected-model.json` 中增加 `texts` 数组（fixture 本身已带特征字符串：`'Inspect the contract'`、`'Checking identity'`、`'The contract is stable.'`），断言 block 文本与生成的 user/thinking/assistant 消息内容，并在 `manifest.json` 中重算 `expected-model.json` 的 hash。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 14. R1-4：Desktop wiring 断言依赖源码排版

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470704
- 结论：值得修复
- 理由：测试逐字匹配数组字面量和局部变量形式，等价重排可产生假失败；同时没有约束 Web Shell build 必须位于默认启用的 build 分支中。该测试的假阳性与假阴性风险都成立。
- 建议修复：改为断言稳定的 workspace 参数、默认 skipBuild 语义、build 分支关系、必需资源路径及空白归一化后的 dist-to-lib copy 语义。

原始评论：

标注位置：`integration-tests/chat-transcript-contract.test.ts:326-328`（RIGHT（新增侧））

```diff
@@ -0,0 +1,331 @@
+import { createHash } from 'node:crypto';
+import { readFileSync } from 'node:fs';
+import { dirname, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+import { describe, expect, it } from 'vitest';
+import {
+  createDaemonTranscriptState,
+  DAEMON_ERROR_KINDS,
+  normalizeDaemonEvent,
+  reduceDaemonTranscriptEvents,
+  type DaemonEvent,
+  type DaemonTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import { transcriptBlocksToDaemonMessages } from '../packages/web-shell/client/adapters/transcriptToMessages.js';
+
+const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
+const fixtureRoot = resolve(
+  repoRoot,
+  'integration-tests/fixtures/chat-transcript-contract/v1',
+);
+const caseRoot = resolve(fixtureRoot, 'cases/representative');
+
+interface FixtureManifest {
+  readonly fixtureVersion: number;
+  readonly sources: readonly string[];
+  readonly consumers: readonly string[];
+  readonly complete: boolean;
+  readonly expectedDiagnostics: readonly string[];
+  readonly hashes: Readonly<Record<string, string>>;
+}
+
+interface ExpectedModel {
+  readonly kinds: readonly string[];
+  readonly sourceRecordIds: readonly (readonly string[])[];
+}
+
+interface ExpectedRenderItems {
+  readonly roles: readonly string[];
+  readonly runtimeFields: readonly string[];
+  readonly expectedToolArgs: Readonly<Record<string, unknown>>;
+  readonly expectedToolResult: unknown;
+}
+
+interface ExpectedExportContract {
+  readonly schemaVersion: number;
+  readonly forbiddenFields: readonly string[];
+  readonly timestamps: number;
+  readonly implementation: string;
+}
+
+interface IdentityCandidateResult {
+  readonly status: 'fail';
+  readonly stableUnderPartialPrepend: false;
+  readonly unstableBlockKinds: readonly string[];
+  readonly missingNativeTextIdentity: readonly string[];
+}
+
+interface ExpectedGate {
+  readonly overall: 'fail';
+  readonly selectedVscodePath: null;
+  readonly candidates: {
+    readonly directDaemon: IdentityCandidateResult;
+    readonly acp: IdentityCandidateResult;
+  };
+  readonly blockers: readonly string[];
+}
+
+function readJson<T>(path: string): T {
+  return JSON.parse(readFileSync(path, 'utf8')) as T;
+}
+
+function readJsonLines<T>(path: string): T[] {
+  return readFileSync(path, 'utf8')
+    .trim()
+    .split('\n')
+    .map((line) => JSON.parse(line) as T);
+}
+
+function sha256(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+function collectDeclaredSchemaProperties(
+  value: unknown,
+  names = new Set<string>(),
+): Set<string> {
+  if (Array.isArray(value)) {
+    for (const item of value) collectDeclaredSchemaProperties(item, names);
+    return names;
+  }
+  if (!value || typeof value !== 'object') return names;
+
+  for (const [key, item] of Object.entries(value)) {
+    if (key === 'properties' && item && typeof item === 'object') {
+      for (const propertyName of Object.keys(item)) names.add(propertyName);
+    }
+    collectDeclaredSchemaProperties(item, names);
+  }
+  return names;
+}
+
+function reduceDaemonEvents(
+  events: readonly DaemonEvent[],
+): readonly DaemonTranscriptBlock[] {
+  let state = createDaemonTranscriptState({ now: 0 });
+  for (const event of events) {
+    state = reduceDaemonTranscriptEvents(state, normalizeDaemonEvent(event), {
+      now: 0,
+    });
+  }
+  return state.blocks;
+}
+
+function reduceAcpUpdates(
+  updates: readonly unknown[],
+): readonly DaemonTranscriptBlock[] {
+  return reduceDaemonEvents(
+    updates.map(
+      (update): DaemonEvent => ({
+        v: 1,
+        type: 'session_update',
+        data: { update },
+      }),
+    ),
+  );
+}
+
+function blockSemanticKey(block: DaemonTranscriptBlock): string {
+  if (
+    block.kind === 'user' ||
+    block.kind === 'assistant' ||
+    block.kind === 'thought'
+  ) {
+    return `${block.kind}:${block.text}`;
+  }
+  if (block.kind === 'tool') return `tool:${block.toolCallId}`;
+  if (block.kind === 'permission') return `permission:${block.requestId}`;
+  return `${block.kind}:${block.id}`;
+}
+
+function probeIdentity(
+  complete: readonly DaemonTranscriptBlock[],
+  partial: readonly DaemonTranscriptBlock[],
+): IdentityCandidateResult {
+  const completeBySemanticKey = new Map(
+    complete.map((block) => [blockSemanticKey(block), block]),
+  );
+  const unstableBlockKinds = partial.flatMap((block) => {
+    const completeBlock = completeBySemanticKey.get(blockSemanticKey(block));
+    return completeBlock && completeBlock.id !== block.id ? [block.kind] : [];
+  });
+  const missingNativeTextIdentity = complete.flatMap((block) => {
+    if (
+      block.kind !== 'user' &&
+      block.kind !== 'assistant' &&
+      block.kind !== 'thought'
+    ) {
+      return [];
+    }
+    return block.sourceRecordIds?.length || block.promptId ? [] : [block.kind];
+  });
+
+  expect(unstableBlockKinds.length).toBeGreaterThan(0);
+  return {
+    status: 'fail',
+    stableUnderPartialPrepend: false,
+    unstableBlockKinds,
+    missingNativeTextIdentity,
+  };
+}
+
+describe('chat transcript contract prevalidation', () => {
+  it('locks the evidence fixtures, schemas, and fail-first capability decision', () => {
+    const manifest = readJson<FixtureManifest>(
+      resolve(caseRoot, 'manifest.json'),
+    );
+    const manifestSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/manifest.schema.json'),
+    );
+    const exportSchema = readJson<Record<string, unknown>>(
+      resolve(fixtureRoot, 'schema/export-transcript-document-v1.schema.json'),
+    );
+    const expectedExport = readJson<ExpectedExportContract>(
+      resolve(caseRoot, 'expected-export.json'),
+    );
+    const matrix = readFileSync(
+      resolve(fixtureRoot, 'capability-matrix.md'),
+      'utf8',
+    );
+
+    expect(manifest.fixtureVersion).toBe(1);
+    expect(manifest.complete).toBe(true);
+    expect(new Set(manifest.sources)).toEqual(
+      new Set(['daemon', 'acp', 'chat-records']),
+    );
+    expect(new Set(manifest.consumers)).toEqual(
+      new Set(['web', 'tauri', 'vscode', 'html']),
+    );
+    expect(manifest.expectedDiagnostics).toEqual([
+      'direct_daemon_unstable_identity',
+      'acp_unstable_identity',
+    ]);
+    expect(manifestSchema['additionalProperties']).toBe(false);
+    expect(exportSchema['additionalProperties']).toBe(false);
+
+    const exportDefinitions = exportSchema['$defs'] as Record<string, unknown>;
+    const blockSchema = exportDefinitions['block'] as {
+      oneOf: Array<{ $ref: string }>;
+    };
+    expect(blockSchema.oneOf).toHaveLength(10);
+    for (const definitionName of ['statusBlock', 'errorBlock']) {
+      const definition = exportDefinitions[definitionName] as {
+        properties: { errorKind: { enum: string[] } };
+      };
+      expect(definition.properties.errorKind.enum).toEqual(DAEMON_ERROR_KINDS);
+    }
+    const declaredExportProperties =
+      collectDeclaredSchemaProperties(exportSchema);
+    for (const field of expectedExport.forbiddenFields) {
+      expect(declaredExportProperties.has(field), field).toBe(false);
+    }
+    const permissionOption = exportDefinitions['permissionOption'] as {
+      properties: { raw: { const: unknown } };
+    };
+    expect(permissionOption.properties.raw.const).toBeNull();
+    expect(expectedExport).toMatchObject({
+      schemaVersion: 1,
+      timestamps: 0,
+      implementation: 'deferred-to-mr2',
+    });
+
+    for (const [relativePath, expectedHash] of Object.entries(
+      manifest.hashes,
+    )) {
+      expect(sha256(resolve(fixtureRoot, relativePath))).toBe(expectedHash);
+    }
+    expect(matrix).toContain('FAIL — migration blocked');
+    expect(matrix).toContain('No VS Code transport is selected in MR1');
+    expect(matrix).not.toMatch(/pass; selected/i);
+  });
+
+  it('preserves current ChatRecord and Web Shell runtime semantics', () => {
+    const records = readJsonLines<unknown>(
+      resolve(caseRoot, 'chat-records.jsonl'),
+    );
+    const expected = readJson<ExpectedModel>(
+      resolve(caseRoot, 'expected-model.json'),
+    );
+    const expectedRender = readJson<ExpectedRenderItems>(
+      resolve(caseRoot, 'expected-render-items.json'),
+    );
+    const projection = projectChatRecordsToDaemonTranscript(records);
+    const messages = transcriptBlocksToDaemonMessages(projection.blocks);
+    const toolBlock = projection.blocks.find((block) => block.kind === 'tool');
+    const toolMessage = messages.find(
+      (message) => message.role === 'tool_group',
+    );
+
+    expect(projection.complete).toBe(true);
+    expect(projection.diagnostics).toEqual([]);
+    expect(projection.blocks.map((block) => block.kind)).toEqual(
+      expected.kinds,
+    );
+    expect(
+      projection.blocks.map((block) => block.sourceRecordIds ?? []),
+    ).toEqual(expected.sourceRecordIds);
+    expect(messages.map((message) => message.role)).toEqual(
+      expectedRender.roles,
+    );
+    expect(toolBlock).toMatchObject({
+      rawInput: expectedRender.expectedToolArgs,
+      rawOutput: expectedRender.expectedToolResult,
+    });
+    expect(toolMessage).toMatchObject({
+      tools: [
+        {
+          args: expectedRender.expectedToolArgs,
+          rawOutput: expectedRender.expectedToolResult,
+        },
+      ],
+    });
+    expect(expectedRender.runtimeFields).toEqual(['rawInput', 'rawOutput']);
+  });
+
+  it('records both VS Code identity candidates as reproducible blockers', () => {
+    const daemonEvents = readJsonLines<DaemonEvent>(
+      resolve(caseRoot, 'daemon-events.jsonl'),
+    );
+    const acpUpdates = readJsonLines<unknown>(
+      resolve(caseRoot, 'acp-session-updates.jsonl'),
+    );
+    const expectedGate = readJson<ExpectedGate>(
+      resolve(caseRoot, 'expected-gate.json'),
+    );
+    const observedGate: ExpectedGate = {
+      overall: 'fail',
+      selectedVscodePath: null,
+      candidates: {
+        directDaemon: probeIdentity(
+          reduceDaemonEvents(daemonEvents),
+          reduceDaemonEvents(daemonEvents.slice(1)),
+        ),
+        acp: probeIdentity(
+          reduceAcpUpdates(acpUpdates),
+          reduceAcpUpdates(acpUpdates.slice(1)),
+        ),
+      },
+      blockers: [
+        'direct-daemon uses reducer ordinal block IDs that change when history is prepended',
+        'ACP text updates do not carry a stable source identity and inherit the same ordinal block IDs',
+      ],
+    };
+
+    expect(observedGate).toEqual(expectedGate);
+  });
+
+  it('keeps Tauri wired to the packaged Web Shell artifact', () => {
+    const prepareRuntime = readFileSync(
+      resolve(repoRoot, 'packages/desktop-shell/scripts/prepare-runtime.js'),
+      'utf8',
+    );
+
+    expect(prepareRuntime).toContain("'web-shell/index.html'");
+    expect(prepareRuntime).toContain("'web-shell/assets'");
+    expect(prepareRuntime).toContain(
+      "[npm, 'run', 'build', '--workspace=packages/web-shell']",
+    );
```

> **[Suggestion]** R1-4: The Desktop wiring gate matches exact text fragments of `packages/desktop-shell/scripts/prepare-runtime.js`, including an array literal whose shape depends on prettier line-wrapping and on local variable names (`npm`, `distDir`, `libDir`), rather than semantic wiring facts; nothing in either file documents the coupling. Reverse direction: the build call sits inside `if (!skipBuild)`, so defaulting that skip keeps all asserted strings present while the wiring is gone.
>
> Failure scenario: an innocuous refactor of the desktop script (renaming `npm`, extracting the workspace string, adding one flag that pushes the array past prettier's 80-col width so it wraps one-element-per-line) breaks this contract test far from the change with no breadcrumb; conversely a skip-by-default change unwires the build while the test stays green.
>
> Witness: `prettier --stdin-filepath` demonstration — adding one flag to push the array literal over 80 columns makes prettier wrap it one-element-per-line, breaking the exact-substring `toContain` for a semantically identical script.
>
> Suggested fix: match semantic fragments instead — `'--workspace=packages/web-shell'` (build wiring), keep `'web-shell/index.html'`/`'web-shell/assets'`, plus a whitespace-normalized check for the dist→lib copy — and add a comment in both files naming the intentional wiring contract.
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-4：Desktop 接线门禁逐字匹配 `packages/desktop-shell/scripts/prepare-runtime.js` 的源码文本片段，其中包括一个形状依赖 prettier 换行、依赖局部变量名（`npm`、`distDir`、`libDir`）的数组字面量，而不是语义上的接线事实；两个文件都没有注明这层耦合。反向漏洞：build 调用位于 `if (!skipBuild)` 之内，若默认开启该跳过，所有被断言的字符串仍在，接线却已失效。
>
> 失败场景：对 desktop 脚本的无害重构（把 `npm` 改名、把 workspace 字符串提为常量、或多加一个 flag 使数组超过 prettier 80 列宽度而被逐元素换行）都会在远离改动处弄坏这个契约测试且毫无线索；反过来，默认跳过的改动会在测试保持为绿的同时解除 build 接线。
>
> 证据：`prettier --stdin-filepath` 演示——给数组加一个 flag 使其超过 80 列后，prettier 会把它逐元素换行，语义完全相同的脚本却让精确子串 `toContain` 失败。
>
> 建议修复：改为匹配语义片段——`'--workspace=packages/web-shell'`（build 接线）、保留 `'web-shell/index.html'`/`'web-shell/assets'`、对 dist→lib 拷贝用空白归一化检查——并在两个文件中加注释说明这是有意的接线契约。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 15. R1-9：Never-export tripwire 漏掉设计字段

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470711
- 结论：值得修复
- 理由：设计文档列出的 `eventId`、`serverTimestamp`、`promptId`、`branchRecordId`、`debugReason` 未进入全局禁止字段；tool `content` 与 status `data` 也没有作用域断言。重新 hash 后 schema widening 可被静默接受，属于安全契约缺口。
- 建议修复：补全可全局检查的禁止字段，并对 `toolBlock.content` 与 `statusBlock.data` 添加作用域排除断言，更新 fixture hash。

原始评论：

标注位置：`integration-tests/fixtures/chat-transcript-contract/v1/cases/representative/expected-export.json:3-5`（RIGHT（新增侧））

```diff
@@ -0,0 +1,15 @@
+{
+  "schemaVersion": 1,
+  "forbiddenFields": [
+    "rawInput",
+    "rawOutput",
```

> **[Suggestion]** R1-9: The `forbiddenFields` tripwire locks only 8 names, but design doc §10.3's never-export list additionally names `eventId`, `serverTimestamp`, `promptId`, `branchRecordId`, `debugReason` — all absent from `forbiddenFields` and from the frozen schema — while tool `content` and status `data` collide with legitimate `todoEntry.content`/`rasterImage.data` and cannot be name-locked globally.
>
> Failure scenario: an MR2-era change adds `promptId` to `userBlock` or `debugReason` to `errorBlock` and updates the schema's manifest hash alongside — every test passes green (the only automated negative-allowlist check never inspects those 5 names), and the hash lock freezes the widened schema as the new evidence baseline, silently breaking the doc's never-export rule and §10.10's "schema widening must fail" gate.
>
> Witness (mutation probes against the real harness): control — added `rawInput` to `userBlock.properties` → test FAILED `rawInput: expected true to be false`; scenario — added `promptId` to `userBlock.properties` + re-hashed schema → Tests 4 passed (4).
>
> ```suggestion
>   "forbiddenFields": [
>     "rawInput",
>     "rawOutput",
>     "eventId",
>     "serverTimestamp",
>     "promptId",
>     "branchRecordId",
>     "debugReason",
> ```
>
> (re-hash `expected-export.json` in `manifest.json`; for the colliding `content`/`data` names assert scoped exclusions instead — `toolBlock`/`statusBlock` defs must not declare them)
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-9：`forbiddenFields` 绊线只锁定了 8 个名字，而设计文档 §10.3 的永不导出清单还包括 `eventId`、`serverTimestamp`、`promptId`、`branchRecordId`、`debugReason`——它们既不在 `forbiddenFields` 中，也不在冻结 schema 中；而 tool 的 `content` 与 status 的 `data` 因与合法的 `todoEntry.content`/`rasterImage.data` 冲突，无法做全局名字锁定。
>
> 失败场景：MR2 阶段的改动给 `userBlock` 加上 `promptId` 或给 `errorBlock` 加上 `debugReason`，并同步更新 schema 的 manifest hash——所有测试仍然为绿（唯一的自动化负向 allowlist 检查从不检查这 5 个名字），hash 锁定会把扩大后的 schema 冻结为新的证据基线，静默破坏文档的永不导出规则和 §10.10 的「schema widening 必须失败」门禁。
>
> 证据（针对真实测试框架的变异探针）：对照——给 `userBlock.properties` 加 `rawInput` → 测试失败 `rawInput: expected true to be false`；场景——加 `promptId` 并重算 schema hash → Tests 4 passed (4)。
>
> 上方 suggestion 一键补上 5 个名字（需在 `manifest.json` 中重算 `expected-export.json` 的 hash）；对冲突的 `content`/`data` 改为作用域排除断言（`toolBlock`/`statusBlock` defs 不得声明它们）。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

### 16. R1-5：rendererVersion 黑名单允许版本范围

- 评论来源：qwen-code-ci-bot，行内评论，https://github.com/QwenLM/qwen-code/pull/9388#discussion_r3802470726
- 结论：值得修复
- 理由：当前未锚定且大小写敏感的黑名单会放行 `LATEST`、hyphen range、x-range 与 or-range，与“只允许精确 semver 或 64 hex hash”的设计要求不一致。
- 建议修复：改成锚定的正向 allowlist pattern，并用真实 schema validator 覆盖合法精确版本/hash与非法范围版本。

原始评论：

标注位置：`integration-tests/fixtures/chat-transcript-contract/v1/schema/export-transcript-document-v1.schema.json:15-20`（RIGHT（新增侧））

```diff
@@ -0,0 +1,775 @@
+{
+  "$schema": "https://json-schema.org/draft/2020-12/schema",
+  "$id": "https://qwen-code.invalid/export-transcript-document-v1.schema.json",
+  "type": "object",
+  "additionalProperties": false,
+  "required": [
+    "schemaVersion",
+    "rendererVersion",
+    "blocks",
+    "diagnostics",
+    "metadata"
+  ],
+  "properties": {
+    "schemaVersion": { "const": 1 },
+    "rendererVersion": {
+      "type": "string",
+      "minLength": 1,
+      "maxLength": 128,
+      "not": { "pattern": "latest|[~^*><=]" }
+    },
```

> **[Suggestion]** R1-5: The frozen V1 schema's `rendererVersion` guard is an unanchored substring blacklist that admits npm hyphen ranges, x-ranges, and or-ranges, while design doc §10.9/§10.11 requires an exact CLI version or content hash only.
>
> Failure scenario: MR2 implements against a hash-frozen contract that admits range-shaped renderer versions (`'1.0.0 - 2.0.0'`, `'1.x'`, `'1.0.0 || 2.0.0'`, `'LATEST'`); tightening after V1 publication costs a `schemaVersion` bump instead of a one-line fixture edit now. Nothing breaks in MR1 (no runtime yet).
>
> Witness (ajv 8.20.0, draft 2020-12, against the actual frozen schema):
>
> ```
> ADMITTED: "LATEST" | "1.0.0 - 2.0.0" | "1.x" | "1.0.0 || 2.0.0"
> REJECTED: "latest" | "^1.2.3" | "~1.2.3" | "*" | ">=1.0.0"
> ```
>
> Suggested fix: replace the blacklist with a positive pattern admitting only exact semver or a 64-hex content hash, e.g. `"pattern": "^([0-9a-f]{64}|(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?)$"`, and drop the `not`.
>
> <details><summary>中文说明</summary>
>
> **[Suggestion]** R1-5：冻结的 V1 schema 对 `rendererVersion` 的防护是一个未锚定的子串黑名单，会放行 npm hyphen 区间、x 区间和 or 区间，而设计文档 §10.9/§10.11 要求只能是精确 CLI 版本或内容 hash。
>
> 失败场景：MR2 将基于一个允许区间型 renderer 版本（`'1.0.0 - 2.0.0'`、`'1.x'`、`'1.0.0 || 2.0.0'`、`'LATEST'`）的 hash 冻结契约来实现；V1 发布后再收紧就要付出 bump `schemaVersion` 的代价，而现在只需改一行 fixture。MR1 阶段没有任何东西会坏（尚无运行时）。
>
> 证据（ajv 8.20.0，draft 2020-12，针对实际冻结 schema 校验）：放行 `'LATEST'`、`'1.0.0 - 2.0.0'`、`'1.x'`、`'1.0.0 || 2.0.0'`；拒绝 `'latest'`、`'^1.2.3'`、`'~1.2.3'`、`'*'`、`'>=1.0.0'`。
>
> 建议修复：把黑名单换成只允许精确 semver 或 64 位十六进制内容 hash 的正向 pattern（示例见上），并去掉 `not`。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.21.13)_

## 修复边界

- 本轮修复所有 11 条成立的行内 finding，并补齐 integration-tests 与根级 typecheck 证据。
- 不把 `overall: "fail"`、两候选 identity FAIL 或 `selectedVscodePath: null` 改成 PASS；这些是 MR1 应保留的真实 blocker。
- maintainer 是否批准“迁移前预验证”这一产品方向，不能由作者自行关闭；修复后通过 PR 回复提供范围与证据，并请求 maintainer/自动评审重新判断。
- 离题且已最小化的指定评论不触发代码改动。
