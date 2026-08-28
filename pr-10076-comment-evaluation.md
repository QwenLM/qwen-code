# PR 10076 评论评估

来源：https://github.com/QwenLM/qwen-code/pull/10076
生成日期：2026-08-28
评论审查提交：`df02ec37e43280b8c3f5afcf551cf2506ca84022`
当前评估提交：`01d319c1fe7414eb800fe3e7da5532d61d12c694`
基线提交：`bc6f1a015cfb5e03a078733cbcfdb8bd05425fad`

最新 review 在 `df02ec37e4` 发布；之后当前分支只合入 main，12 条 finding 对应代码均仍存在。本报告以最新 12 条 inline findings 为 canonical 任务。上一轮 33 条 inline comments 已有作者回复并被 resolve，不再作为当前实现任务重复计数；其中 R1-1、R1-6 的复发问题由本轮同名评论完整保留。

当前 PR 的 Ubuntu CI 为红，但实时日志显示失败来自 `packages/cli/src/serve/acp-http/transport.test.ts` 的共享 session/list 并发用例，不是 R2-10 所称的 workflow contract test。R2-10 仍通过本地单文件测试独立复现，二者在报告中分开处理。

## 摘要

- 值得修复：12
- 不值得修复：1
- 需要维护者判断：0

12 条 inline findings 全部成立。R2-9 虽标为 Suggestion，但与 Critical R2-3 共用同一错误复杂度预检 primitive，因此纳入同一 F5 修复，不额外扩大产品范围。Review summary 本身是覆盖缺口/延后项披露，无需代码修改。

## 评估结果

### 1. 最新 Review 的覆盖缺口与延后建议清单

- 评论来源：qwen-code-ci-bot，Review 总结，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#pullrequestreview-5041220005)
- 结论：不值得修复
- 理由：这是审查覆盖范围披露和后续建议清单，不是当前轮的具体修复请求。其中 9 条被 reviewer 明确标记为 deferred/non-blocking；按仓库收敛规则，本轮不把它们扩张为新的实现任务。
- 实施状态：无需修改
- 修复批次：N/A
- 实施证据：完整保留 review 原文。当前实现任务以同一 review 发布的 12 条 inline findings 为准。

原始评论：

> Partially reviewed — gaps disclosed.
>
> Not explored to full depth (tool budget reached): chunk 23: `none — no checks were cut short.`; chunk 15: `executing  packages/cli/src/ui/utils/export/export-transcript-document.test.ts  to confirm green at HEAD — the review worktree has no  node_modules /dist and a …`.
>
> Not reviewed: reverse audit — stopped before round 3 by the review time budget.
>
> Not linted (tool limitation, not a blocker): the executable-script lint — `.github/workflows/ci.yml`: actionlint embedded-shell source mapping is not yet supported — not linted; the executable-script lint — `.github/workflows/e2e.yml`: actionlint embedded-shell source mapping is not yet supported — not linted.
>
> Deferred under the convergence posture (round 2, not a blocker) — recorded, not requested in this round:
>
> - `integration-tests/chat-transcript-contract.test.ts:225 — [review] Schema-closure lock misses the toolResultPreview union (mutation stays green)`
> - `integration-tests/chat-transcript-contract.test.ts:91 — [review] Fixture-tree lock is fail-open for symlink entries`
> - `docs/design/web-shell/chat-transcript-contract-prevalidation.md:690 — [review] Six bare  MR2  references orphan gate obligations after the MR2A/MR2B split`
> - `integration-tests/chat-transcript-document.test.ts:6 — [review] Browser gate imports  playwright  as a phantom dependency (webui hoist only)`
> - `packages/web-shell/client/adapters/parallelAgentGrouping.ts:30 — [review] Summary-row exclusion hardcodes  summary-  instead of the shared summaryRunId predicate`
> - `packages/acp-bridge/src/transcript-replay.ts:1262 — [review] Unreachable shell_output/tool_output lane branch in transcriptSegmentLane`
> - `packages/web-templates/src/export-html/build.mjs:142 — [review] Post-transform  <script  guard is dead code; misleading safety model`
> - `packages/web-shell/client/components/MessageList.tsx:2093 — [review] data-source-block-ids written on every row but read nowhere; includeSourceIdentity hard-wired for it`
> - `packages/web-shell/client/adapters/transcriptToMessages.ts:480 — [review] sourceBlockIds missing on three block-backed pushes (mid_turn/vision_bridge)`
>
> <details>
> <summary>中文说明</summary>
>
> 仅完成部分审查，审查缺口已披露。
>
> 未探索到全部深度（达到工具调用预算）：chunk 23：`none — no checks were cut short.`；chunk 15：`executing  packages/cli/src/ui/utils/export/export-transcript-document.test.ts  to confirm green at HEAD — the review worktree has no  node_modules /dist and a …`。
>
> 未审查：反向审计——评审时间预算不足，未能开始第 3 轮。
>
> 未检查（工具限制，非阻断）：the executable-script lint — `.github/workflows/ci.yml`: actionlint embedded-shell source mapping is not yet supported — not linted; the executable-script lint — `.github/workflows/e2e.yml`: actionlint embedded-shell source mapping is not yet supported — not linted。
>
> 收敛姿态下延后（第 2 轮，非阻断）——已记录，本轮不要求修改：共 9 条（原文未翻译，列表见上方英文部分）。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_
>
> <!-- qwen-review-ledger {"v":1,"round":2,"findings":[{"id":"R1-1","sev":"C","file":"packages/cli/src/ui/utils/export/export-transcript-document.ts","line":1947,"title":"The home-path redaction boundary is still bypassable at this head — the replacem"},{"id":"R1-6","sev":"C","file":"packages/cli/src/ui/utils/export/markdown-document-policy.ts","line":302,"title":"The complexity bound added for round-1 R1-6's re-parse hang has a silent path: `"},{"id":"R2-1","sev":"C","file":"packages/cli/src/ui/utils/export/export-transcript-document.ts","line":441,"title":"The user/assistant/thought branch of `sanitizeBlock` exports `images` but silent"},{"id":"R2-2","sev":"C","file":"packages/cli/src/ui/utils/export/export-transcript-document.ts","line":969,"title":"`label()` truncates to `maxLength` BEFORE running `redactHomePaths`, but the `fi"},{"id":"R2-3","sev":"C","file":"packages/cli/src/ui/utils/export/markdown-document-policy.ts","line":67,"title":"The pre-parse complexity veto only counts `[`/`]`/`>` markers, but the super-lin"},{"id":"R2-4","sev":"C","file":"packages/cli/src/ui/utils/export/markdown-document-policy.ts","line":169,"title":"`safeLinkReplacement` (and the twin definition rewrite in `sanitizeMarkdownDocum"},{"id":"R2-5","sev":"C","file":"packages/web-shell/client/adapters/transcriptToMessages.ts","line":1181,"title":"This PR adds `wasCancelled` to `DaemonMessageToolCall` and extends `extractDiff`"},{"id":"R2-6","sev":"C","file":"packages/web-shell/client/components/messages/ToolGroup.tsx","line":161,"title":"The args-based diff preview — the ONLY diff source on the document/export projec"},{"id":"R2-7","sev":"C","file":"packages/web-templates/src/index.ts","line":12,"title":"This PR inlines the ~20 MB document template into the shipped npm bundle (these "},{"id":"R2-8","sev":"C","file":".github/workflows/e2e.yml","line":296,"title":"The `web-shell-browser-regression` job this gate step was added to keeps its sin"},{"id":"R2-9","sev":"S","file":"packages/cli/src/ui/utils/export/markdown-document-policy.ts","line":67,"title":"The pre-parse marker veto counts every `[`, `]`, `>` anywhere in the raw source "},{"id":"R2-10","sev":"C","file":".github/workflows/ci.yml","line":827,"title":"The rewrite of this job's Playwright install steps (`npx playwright install chro"}],"posted":12,"floor":"o","fresh":12,"prevPosted":33,"sha":"df02ec37e43280b8c3f5afcf551cf2506ca84022","model":"qwen3.8-max@e6bf8ffe","src0":7438} -->

### 2. R1-1 复查：home path 脱敏仍可被结构绕过

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074050)
- 结论：值得修复
- 理由：成立。当前正则排除了前置 `/` 与 `.`，并对输入自带 `[home]` 设置豁免；替换只执行一轮，现有测试还固化了 `nested=[home]/home/...`。这些条件会放行双斜杠、点段、输入伪造占位符和嵌套 home 路径。
- 建议修复：删除输入占位符豁免，对非 HTTP 路径结构做收敛式重复脱敏，并让独立残留检测覆盖双斜杠、点段、Windows 与嵌套结构；补充反例测试。
- 实施状态：已修复并验证
- 修复批次：F1
- 实施证据：已修改 export-transcript-document.ts 与对应测试：一次全局覆盖 POSIX/Windows home 结构，移除输入 `[home]` 豁免；双斜杠、点段、嵌套与伪造占位符回归均通过。CLI 聚焦测试 46/46。

原始评论：

标注位置：`packages/cli/src/ui/utils/export/export-transcript-document.ts:1945-1947`（RIGHT（新增侧））

```diff
@@ -0,0 +1,2159 @@
+import {
+  DAEMON_ERROR_KINDS,
+  type DaemonErrorKind,
+  type DaemonPermissionTranscriptBlock,
+  type DaemonShellTranscriptBlock,
+  type DaemonStatusTranscriptBlock,
+  type DaemonTextTranscriptBlock,
+  type DaemonToolPreview,
+  type DaemonToolResultPreview,
+  type DaemonToolTranscriptBlock,
+  type DaemonTodoListPreview,
+  type DaemonTranscriptBlock,
+  type DaemonUiPermissionOption,
+  type DaemonUserShellTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { SchemaValidator } from '@qwen-code/qwen-code-core';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import type { ExportSessionData } from './types.js';
+import exportTranscriptDocumentV1Schema from './export-transcript-document-v1.schema.json' with { type: 'json' };
+import { escapeJsonForHtmlScriptData } from './html-script-data.js';
+import {
+  countRichMarkdownTasks,
+  sanitizeMarkdownDocument,
+  transformRichMarkdownTasks,
+} from './markdown-document-policy.js';
+
+export const EXPORT_TRANSCRIPT_LIMITS_V1 = Object.freeze({
+  maxBlocks: 1_000,
+  maxTextBytes: 400 * 1024,
+  maxVisibleTextBytes: 8 * 1024 * 1024,
+  maxRasterBytes: 8 * 1024 * 1024,
+  maxTotalRasterBytes: 16 * 1024 * 1024,
+  maxEnvelopeBytes: 32 * 1024 * 1024,
+  maxObjectDepth: 16,
+  maxObjectProperties: 1_000,
+  maxArrayLength: 1_000,
+  maxRichRenderTasks: 100,
+});
+
+export interface ExportTranscriptDiagnosticV1 {
+  readonly code: string;
+  readonly severity: 'info' | 'warning' | 'error';
+  readonly count: number;
+}
+
+export interface ExportMetadataPresentationV1 {
+  readonly title?: string;
+  readonly startedAt?: string;
+  readonly exportedAt: string;
+  readonly complete: boolean;
+  readonly truncated: boolean;
+  readonly projectName?: string;
+  readonly repository?: string;
+  readonly gitBranch?: string;
+  readonly model?: string;
+  readonly channel?: string;
+  readonly promptCount?: number;
+  readonly contextUsagePercent?: number;
+  readonly contextWindowSize?: number;
+  readonly totalTokens?: number;
+  readonly filesWritten?: number;
+  readonly linesAdded?: number;
+  readonly linesRemoved?: number;
+}
+
+type DaemonPromptCancelledTranscriptBlock = Extract<
+  DaemonTranscriptBlock,
+  { kind: 'prompt_cancelled' }
+>;
+
+type ExportBlockBaseKeys =
+  | 'id'
+  | 'kind'
+  | 'clientReceivedAt'
+  | 'createdAt'
+  | 'updatedAt';
+
+type ExportPermissionOptionV1 = Pick<
+  DaemonUiPermissionOption,
+  'optionId' | 'label' | 'description'
+> & { raw: null };
+
+interface ExportTranscriptQuestionOptionV1 {
+  label: string;
+  description?: string;
+  raw: null;
+}
+
+interface ExportTranscriptQuestionV1 {
+  header?: string;
+  question: string;
+  options: ExportTranscriptQuestionOptionV1[];
+  raw: null;
+}
+
+type ToolPreviewOf<K extends DaemonToolPreview['kind']> = Extract<
+  DaemonToolPreview,
+  { kind: K }
+>;
+type ToolPreviewPick<
+  K extends DaemonToolPreview['kind'],
+  P extends keyof ToolPreviewOf<K>,
+> = Pick<ToolPreviewOf<K>, 'kind' | P>;
+type ExportTodoListPreviewV1 = ToolPreviewPick<
+  'todo_list',
+  'entries' | 'truncated' | 'planId' | 'revision'
+>;
+type ExportToolPreviewV1 =
+  | { kind: 'ask_user_question'; questions: ExportTranscriptQuestionV1[] }
+  | ToolPreviewPick<'command', 'command' | 'cwd'>
+  | ToolPreviewPick<'file_diff', 'path' | 'oldText' | 'newText' | 'patch'>
+  | ToolPreviewPick<'file_read', 'path' | 'range'>
+  | ToolPreviewPick<'web_fetch', 'url' | 'method'>
+  | ToolPreviewPick<'mcp_invocation', 'serverId' | 'toolName' | 'argsSummary'>
+  | ToolPreviewPick<'code_block', 'language' | 'code' | 'origin'>
+  | ToolPreviewPick<'search', 'query' | 'resultCount' | 'top'>
+  | ToolPreviewPick<'tabular', 'columns' | 'rows' | 'totalRows'>
+  | ToolPreviewPick<'image_generation', 'prompt' | 'thumbnailUrl' | 'model'>
+  | ToolPreviewPick<
+      'subagent_delegation',
+      'agentName' | 'task' | 'parentDelegationId'
+    >
+  | ToolPreviewPick<'key_value', 'rows'>
+  | ExportTodoListPreviewV1
+  | ToolPreviewPick<'generic', 'summary'>;
+type ExportToolResultPreviewV1 =
+  | ExportTodoListPreviewV1
+  | { kind: 'text'; text: string }
+  | { kind: 'generic'; summary: string };
+
+export type ExportPermissionResolutionV1 =
+  | 'approved'
+  | 'rejected'
+  | 'cancelled'
+  | 'expired'
+  | 'resolved';
+
+type ExportTextTranscriptBlockBaseV1 = Pick<
+  DaemonTextTranscriptBlock,
+  | Exclude<ExportBlockBaseKeys, 'kind'>
+  | 'text'
+  | 'images'
+  | 'collapsed'
+  | 'parentToolCallId'
+> & { streaming?: false };
+type ExportTextTranscriptBlockV1 =
+  | (ExportTextTranscriptBlockBaseV1 & { kind: 'user' | 'thought' })
+  | (ExportTextTranscriptBlockBaseV1 & {
+      kind: 'assistant';
+      usage?: DaemonTextTranscriptBlock['usage'];
+    });
+type ExportToolTranscriptBlockV1 = Pick<
+  DaemonToolTranscriptBlock,
+  | ExportBlockBaseKeys
+  | 'toolCallId'
+  | 'title'
+  | 'toolName'
+  | 'toolKind'
+  | 'parentToolCallId'
+  | 'parentBlockId'
+  | 'subagentType'
+  | 'background'
+> & {
+  status: 'completed' | 'failed' | 'cancelled' | 'canceled';
+  preview: ExportToolPreviewV1;
+  resultPreview?: ExportToolResultPreviewV1;
+};
+type ExportShellTranscriptBlockV1 = Pick<
+  DaemonShellTranscriptBlock,
+  ExportBlockBaseKeys | 'text' | 'stream'
+>;
+type ExportUserShellTranscriptBlockV1 = Pick<
+  DaemonUserShellTranscriptBlock,
+  ExportBlockBaseKeys | 'text' | 'command' | 'cwd' | 'stream'
+>;
+type ExportPermissionTranscriptBlockV1 = Pick<
+  DaemonPermissionTranscriptBlock,
+  | ExportBlockBaseKeys
+  | 'requestId'
+  | 'title'
+  | 'toolCallId'
+  | 'toolName'
+  | 'toolKind'
+> & {
+  options: ExportPermissionOptionV1[];
+  preview: ExportToolPreviewV1;
+  resolved?: ExportPermissionResolutionV1;
+};
+type ExportStatusTranscriptBlockV1 = Pick<
+  DaemonStatusTranscriptBlock,
+  | Exclude<ExportBlockBaseKeys, 'kind'>
+  | 'text'
+  | 'code'
+  | 'errorKind'
+  | 'source'
+> & {
+  kind: 'status' | 'error';
+};
+type ExportPromptCancelledTranscriptBlockV1 = Pick<
+  DaemonPromptCancelledTranscriptBlock,
+  ExportBlockBaseKeys | 'reason'
+>;
+
+export type ExportTranscriptBlockV1 =
+  | ExportTextTranscriptBlockV1
+  | ExportToolTranscriptBlockV1
+  | ExportShellTranscriptBlockV1
+  | ExportUserShellTranscriptBlockV1
+  | ExportPermissionTranscriptBlockV1
+  | ExportStatusTranscriptBlockV1
+  | ExportPromptCancelledTranscriptBlockV1;
+
+export interface ExportTranscriptDocumentV1 {
+  readonly schemaVersion: 1;
+  readonly rendererVersion: string;
+  readonly blocks: readonly ExportTranscriptBlockV1[];
+  readonly diagnostics: readonly ExportTranscriptDiagnosticV1[];
+  readonly metadata: ExportMetadataPresentationV1;
+}
+
+export interface CreateExportTranscriptDocumentOptions {
+  readonly rendererVersion: string;
+  readonly exportedAt: string;
+  readonly title?: string;
+}
+
+export class ExportTranscriptDocumentError extends Error {
+  constructor(readonly code: string) {
+    super(`Cannot create export transcript document: ${code}.`);
+    this.name = 'ExportTranscriptDocumentError';
+  }
+}
+
+export function createExportTranscriptDocumentV1(
+  records: readonly unknown[],
+  sessionData: Pick<ExportSessionData, 'startTime' | 'metadata'>,
+  options: CreateExportTranscriptDocumentOptions,
+): ExportTranscriptDocumentV1 {
+  if (!isSafeRendererVersion(options.rendererVersion)) {
+    throw new ExportTranscriptDocumentError('invalid_renderer_version');
+  }
+  if (!isIsoDate(options.exportedAt)) {
+    throw new ExportTranscriptDocumentError('invalid_exported_at');
+  }
+
+  const diagnostics = new DiagnosticCounter();
+  const policy = applyRecordExportPolicy(records, diagnostics);
+  const projection = projectChatRecordsToDaemonTranscript(policy.records, {
+    maxBlocks: EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
+  });
+  for (const item of projection.diagnostics) {
+    diagnostics.add(item.code, item.severity, 1, item.affectsCompleteness);
+  }
+  const budget = new ExportBudget(diagnostics);
+  const ids = new OpaqueDocumentIds();
+  const visibleBlocks = projection.blocks.filter((block) => {
+    const sourceRecordIds = block.sourceRecordIds ?? [];
+    return (
+      sourceRecordIds.length === 0 ||
+      sourceRecordIds.some((recordId) => policy.visibleRecordIds.has(recordId))
+    );
+  });
+  const blocks: ExportTranscriptBlockV1[] = [];
+  for (const block of visibleBlocks) {
+    const checkpoint = budget.checkpoint();
+    const safe = sanitizeBlock(block, budget, ids, diagnostics);
+    if (budget.cumulativeTextBudgetExceeded) {
+      budget.restore(checkpoint);
+      break;
+    }
+    if (safe) blocks.push(safe);
+  }
+  const initialTruncated = projection.truncated || budget.truncated;
+  const metadataPresentation = createMetadataPresentation(
+    sessionData,
+    options,
+    diagnostics,
+    budget,
+  );
+  const truncated = initialTruncated || budget.truncated;
+  const degraded =
+    !policy.complete ||
+    !projection.complete ||
+    budget.truncated ||
+    diagnostics.hasErrors ||
+    diagnostics.hasCompletenessLoss;
+  const metadata = {
+    ...metadataPresentation,
+    complete: !degraded,
+    truncated,
+  };
+  let document: ExportTranscriptDocumentV1 = {
+    schemaVersion: 1,
+    rendererVersion: options.rendererVersion,
+    blocks,
+    diagnostics: diagnostics.toArray(),
+    metadata,
+  };
+  document = fitDocumentToEnvelope(document, diagnostics);
+  assertExportTranscriptDocumentV1(document);
+  return document;
+}
+
+function fitDocumentToEnvelope(
+  document: ExportTranscriptDocumentV1,
+  diagnostics: DiagnosticCounter,
+): ExportTranscriptDocumentV1 {
+  if (
+    serializedEnvelopeBytes(document) <=
+    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+  ) {
+    return document;
+  }
+  diagnostics.add('envelope_budget_exceeded', 'warning', 1, true);
+  const buildCandidate = (blockCount: number): ExportTranscriptDocumentV1 => ({
+    ...document,
+    blocks: document.blocks.slice(0, blockCount),
+    diagnostics: diagnostics.toArray(),
+    metadata: { ...document.metadata, complete: false, truncated: true },
+  });
+  let low = 0;
+  let high = document.blocks.length;
+  while (low < high) {
+    const middle = Math.ceil((low + high) / 2);
+    if (
+      serializedEnvelopeBytes(buildCandidate(middle)) <=
+      EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+    ) {
+      low = middle;
+    } else {
+      high = middle - 1;
+    }
+  }
+  const fitted = buildCandidate(low);
+  if (
+    serializedEnvelopeBytes(fitted) >
+    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+  ) {
+    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
+  }
+  return fitted;
+}
+
+export function assertExportTranscriptDocumentV1(
+  value: unknown,
+): asserts value is ExportTranscriptDocumentV1 {
+  assertDepthAndArrayBudgets(value);
+  const bytes = serializedEnvelopeBytes(value);
+  if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
+    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
+  }
+  const schemaError = SchemaValidator.validateStrict(
+    exportTranscriptDocumentV1Schema,
+    value,
+  );
+  if (schemaError) {
+    throw new ExportTranscriptDocumentError('schema_validation_failed');
+  }
+  if (!isRecord(value)) {
+    throw new ExportTranscriptDocumentError('schema_validation_failed');
+  }
+  assertSemanticSafety(value);
+  assertDocumentConsistency(value);
+  assertNoForbiddenFields(value);
+  assertResourceBudgets(value);
+}
+
+function applyRecordExportPolicy(
+  records: readonly unknown[],
+  diagnostics: DiagnosticCounter,
+): {
+  records: unknown[];
+  visibleRecordIds: ReadonlySet<string>;
+  complete: boolean;
+} {
+  const projectionRecords: unknown[] = [];
+  const visibleRecordIds = new Set<string>();
+  let complete = true;
+  for (const record of records) {
+    if (!isRecord(record)) {
+      diagnostics.add('record_invalid', 'error');
+      complete = false;
+      continue;
+    }
+    const type = record['type'];
+    const subtype = record['subtype'];
+    const acceptedSystemSubtype =
+      type === 'system' &&
+      typeof subtype === 'string' &&
+      VISIBLE_SYSTEM_RECORD_SUBTYPES.has(subtype);
+    const visible =
+      type === 'user' ||
+      type === 'assistant' ||
+      type === 'tool_result' ||
+      acceptedSystemSubtype;
+    if (visible || type === 'system') {
+      projectionRecords.push(record);
+      const uuid = record['uuid'];
+      if (visible && typeof uuid === 'string') visibleRecordIds.add(uuid);
+      if (type === 'system' && !acceptedSystemSubtype) {
+        diagnostics.add('record_internal_excluded', 'info');
+      }
+      continue;
+    }
+    diagnostics.add('record_unknown_excluded', 'error');
+    complete = false;
+  }
+  return { records: projectionRecords, visibleRecordIds, complete };
+}
+
+const VISIBLE_SYSTEM_RECORD_SUBTYPES = new Set([
+  'slash_command',
+  'notification',
+  'cron',
+  'mid_turn_user_message',
+  'realtime_message',
+  'goal_state',
+  'goal_runtime',
+]);
+
+function sanitizeBlock(
+  block: DaemonTranscriptBlock,
+  budget: ExportBudget,
+  ids: OpaqueDocumentIds,
+  diagnostics: DiagnosticCounter,
+): ExportTranscriptBlockV1 | undefined {
+  const common = {
+    id: ids.get('block', block.id),
+    kind: block.kind,
+    clientReceivedAt: 0,
+    createdAt: 0,
+    updatedAt: 0,
+  };
+  switch (block.kind) {
+    case 'user':
+    case 'assistant':
+    case 'thought': {
+      const text = budget.text(block.text);
+      const images = block.images
+        ? budget.array(block.images).flatMap((image) => {
+            const safe = budget.image(image);
+            return safe ? [safe] : [];
+          })
+        : undefined;
+      return {
+        ...common,
+        kind: block.kind,
+        text,
+        streaming: false,
+        ...(block.collapsed ? { collapsed: true } : {}),
+        ...(block.parentToolCallId
+          ? {
+              parentToolCallId: ids.get('tool-call', block.parentToolCallId),
+            }
+          : {}),
+        ...(images && images.length > 0 ? { images } : {}),
+        ...(block.kind === 'assistant' && block.usage
+          ? {
+              usage: {
+                inputTokens: safeCount(block.usage.inputTokens),
+                outputTokens: safeCount(block.usage.outputTokens),
+                ...(block.usage.cachedTokens !== undefined
+                  ? { cachedTokens: safeCount(block.usage.cachedTokens) }
+                  : {}),
+              },
+            }
+          : {}),
+      };
+    }
+    case 'tool': {
+      const status = terminalToolStatus(block.status, diagnostics, budget);
+      const toolName = budget.optionalLabel(block.toolName, 128);
+      const toolKind = budget.optionalLabel(block.toolKind, 128);
+      const subagentType = budget.optionalLabel(block.subagentType, 128);
+      let resultPreview = block.resultPreview
+        ? sanitizeResultPreview(block.resultPreview, budget, diagnostics, ids)
+        : undefined;
+      if (
+        !resultPreview &&
+        block.preview.kind === 'file_diff' &&
+        status === 'completed'
+      ) {
+        resultPreview = {
+          kind: 'text',
+          text: budget.plainText('File change applied'),
+        };
+      }
+      if (!resultPreview && (status === 'completed' || status === 'failed')) {
+        diagnostics.add('tool_result_presentation_missing', 'error');
+        budget.markContentLoss();
+        resultPreview = {
+          kind: 'text',
+          text: budget.plainText('[tool result omitted from export]'),
+        };
+      }
+      return {
+        ...common,
+        kind: 'tool',
+        toolCallId: ids.get('tool-call', block.toolCallId),
+        title: budget.plainText(block.title),
+        status,
+        ...(block.background ? { background: true } : {}),
+        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
+        ...(resultPreview ? { resultPreview } : {}),
+        ...(toolName ? { toolName } : {}),
+        ...(toolKind ? { toolKind } : {}),
+        ...(block.parentToolCallId
+          ? {
+              parentToolCallId: ids.get('tool-call', block.parentToolCallId),
+            }
+          : {}),
+        ...(block.parentBlockId
+          ? { parentBlockId: ids.get('block', block.parentBlockId) }
+          : {}),
+        ...(subagentType ? { subagentType } : {}),
+      };
+    }
+    case 'shell':
+      return {
+        ...common,
+        kind: 'shell',
+        text: budget.plainText(block.text),
+        ...(block.stream ? { stream: block.stream } : {}),
+      };
+    case 'user_shell':
+      return {
+        ...common,
+        kind: 'user_shell',
+        text: budget.plainText(block.text),
+        command: budget.plainText(block.command),
+        ...(block.cwd
+          ? { cwd: budget.label(safePath(block.cwd), 400, false) }
+          : {}),
+        ...(block.stream ? { stream: block.stream } : {}),
+      };
+    case 'permission': {
+      const toolName = budget.optionalLabel(block.toolName, 128);
+      const toolKind = budget.optionalLabel(block.toolKind, 128);
+      const resolution = block.resolved
+        ? classifyPermissionResolutionForExport(block.resolved, block.options)
+        : undefined;
+      if (resolution?.lossy) {
+        diagnostics.add('permission_resolution_sanitized', 'warning', 1, true);
+        budget.markContentLoss();
+      }
+      return {
+        ...common,
+        kind: 'permission',
+        requestId: ids.get('permission', block.requestId),
+        title: budget.plainText(block.title),
+        options: budget.array(block.options).map((option) => ({
+          optionId: ids.get('permission-option', option.optionId),
+          label: budget.plainText(option.label),
+          ...(option.description
+            ? { description: budget.plainText(option.description) }
+            : {}),
+          raw: null,
+        })),
+        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
+        ...(block.toolCallId
+          ? { toolCallId: ids.get('tool-call', block.toolCallId) }
+          : {}),
+        ...(toolName ? { toolName } : {}),
+        ...(toolKind ? { toolKind } : {}),
+        ...(resolution ? { resolved: resolution.value } : {}),
+      };
+    }
+    case 'status':
+    case 'error': {
+      const code = budget.optionalLabel(block.code, 128);
+      const errorKind = safeExportErrorKind(block.errorKind);
+      const source = budget.optionalLabel(block.source, 128);
+      return {
+        ...common,
+        kind: block.kind,
+        text: budget.text(block.text),
+        ...(code ? { code } : {}),
+        ...(errorKind ? { errorKind } : {}),
+        ...(source ? { source } : {}),
+      };
+    }
+    case 'prompt_cancelled':
+      return {
+        ...common,
+        kind: 'prompt_cancelled',
+        ...(block.reason ? { reason: budget.plainText(block.reason) } : {}),
+      };
+    case 'debug':
+      diagnostics.add('debug_block_excluded', 'info');
+      return undefined;
+    default:
+      return assertNever(block);
+  }
+}
+
+function sanitizeToolPreview(
+  preview: DaemonToolPreview,
+  budget: ExportBudget,
+  diagnostics: DiagnosticCounter,
+  ids: OpaqueDocumentIds,
+): ExportToolPreviewV1 {
+  switch (preview.kind) {
+    case 'ask_user_question':
+      return {
+        kind: preview.kind,
+        questions: budget.array(preview.questions).map((question) => {
+          const header = budget.optionalLabel(question.header, 200);
+          return {
+            ...(header ? { header } : {}),
+            question: budget.plainText(question.question),
+            options: budget.array(question.options).map((option) => ({
+              label: budget.plainText(option.label),
+              ...(option.description
+                ? { description: budget.plainText(option.description) }
+                : {}),
+              raw: null,
+            })),
+            raw: null,
+          };
+        }),
+      };
+    case 'command':
+      return {
+        kind: preview.kind,
+        command: budget.plainText(preview.command),
+        ...(preview.cwd
+          ? { cwd: budget.label(safePath(preview.cwd), 400, false) }
+          : {}),
+      };
+    case 'file_diff':
+      return {
+        kind: preview.kind,
+        path: budget.label(safePath(preview.path), 400, false),
+        ...(preview.oldText !== undefined
+          ? { oldText: budget.plainText(preview.oldText) }
+          : {}),
+        ...(preview.newText !== undefined
+          ? { newText: budget.plainText(preview.newText) }
+          : {}),
+        ...(preview.patch !== undefined
+          ? { patch: budget.plainText(preview.patch) }
+          : {}),
+      };
+    case 'file_read': {
+      const range = preview.range
+        ? ([safeCount(preview.range[0]), safeCount(preview.range[1])] as [
+            number,
+            number,
+          ])
+        : undefined;
+      return {
+        kind: preview.kind,
+        path: budget.label(safePath(preview.path), 400, false),
+        ...(range ? { range } : {}),
+      };
+    }
+    case 'web_fetch': {
+      const method = budget.optionalLabel(preview.method, 16);
+      return {
+        kind: preview.kind,
+        url: budget.plainText(
+          safeDisplayUrl(preview.url, diagnostics, () =>
+            budget.markContentLoss(),
+          ),
+        ),
+        ...(method ? { method } : {}),
+      };
+    }
+    case 'mcp_invocation':
+      return {
+        kind: preview.kind,
+        serverId: budget.label(preview.serverId, 128),
+        toolName: budget.label(preview.toolName, 128),
+        ...(preview.argsSummary
+          ? { argsSummary: budget.plainText(preview.argsSummary) }
+          : {}),
+      };
+    case 'code_block': {
+      const language = budget.optionalLabel(preview.language, 64);
+      const origin = preview.origin
+        ? budget.optionalLabel(safePath(preview.origin), 400, false)
+        : undefined;
+      return {
+        kind: preview.kind,
+        code: budget.plainText(preview.code),
+        ...(language ? { language } : {}),
+        ...(origin ? { origin } : {}),
+      };
+    }
+    case 'search':
+      return {
+        kind: preview.kind,
+        query: budget.plainText(preview.query),
+        ...(preview.resultCount !== undefined
+          ? { resultCount: safeCount(preview.resultCount) }
+          : {}),
+        ...(preview.top
+          ? {
+              top: budget
+                .array(preview.top)
+                .map((item) => budget.plainText(item)),
+            }
+          : {}),
+      };
+    case 'tabular':
+      return {
+        kind: preview.kind,
+        columns: budget
+          .array(preview.columns)
+          .map((item) => budget.plainText(item)),
+        rows: budget
+          .array(preview.rows)
+          .map((row) =>
+            budget.array(row).map((item) => budget.plainText(item)),
+          ),
+        ...(preview.totalRows !== undefined
+          ? { totalRows: safeCount(preview.totalRows) }
+          : {}),
+      };
+    case 'image_generation': {
+      const model = budget.optionalLabel(preview.model, 128);
+      const thumbnailUrl =
+        preview.thumbnailUrl !== undefined
+          ? budget.dataImageUrl(preview.thumbnailUrl)
+          : undefined;
+      return {
+        kind: preview.kind,
+        prompt: budget.plainText(preview.prompt),
+        ...(thumbnailUrl ? { thumbnailUrl } : {}),
+        ...(model ? { model } : {}),
+      };
+    }
+    case 'subagent_delegation':
+      return {
+        kind: preview.kind,
+        agentName: budget.label(preview.agentName, 128),
+        task: budget.plainText(preview.task),
+        ...(preview.parentDelegationId
+          ? {
+              parentDelegationId: ids.get(
+                'tool-call',
+                preview.parentDelegationId,
+              ),
+            }
+          : {}),
+      };
+    case 'key_value':
+      return {
+        kind: preview.kind,
+        rows: budget.array(preview.rows).map((row) => ({
+          label: budget.plainText(row.label),
+          value: budget.plainText(row.value),
+        })),
+      };
+    case 'todo_list':
+      return sanitizeTodoPreview(preview, budget, ids);
+    case 'generic':
+      return {
+        kind: preview.kind,
+        ...(preview.summary
+          ? { summary: budget.plainText(preview.summary) }
+          : {}),
+      };
+    default:
+      return assertNever(preview);
+  }
+}
+
+function sanitizeResultPreview(
+  preview: DaemonToolResultPreview,
+  budget: ExportBudget,
+  _diagnostics: DiagnosticCounter,
+  ids: OpaqueDocumentIds,
+): ExportToolResultPreviewV1 | undefined {
+  if (preview.kind === 'todo_list') {
+    return sanitizeTodoPreview(preview, budget, ids);
+  }
+  if (preview.kind === 'text') {
+    return { kind: 'text', text: budget.text(preview.text) };
+  }
+  if (!preview.summary?.trim()) return undefined;
+  const summary = budget.text(preview.summary);
+  return summary.trim()
+    ? { kind: 'generic', summary }
+    : { kind: 'text', text: summary };
+}
+
+function sanitizeTodoPreview(
+  preview: DaemonTodoListPreview,
+  budget: ExportBudget,
+  ids: OpaqueDocumentIds,
+): ExportTodoListPreviewV1 {
+  if (preview.truncated) budget.markTruncated('todo_preview_truncated');
+  return {
+    kind: 'todo_list',
+    entries: budget.array(preview.entries).map((entry) => ({
+      id: ids.get('todo', entry.id),
+      content: budget.plainText(entry.content),
+      status: entry.status,
+      ...(entry.priority ? { priority: entry.priority } : {}),
+      ...(entry.blockedBy
+        ? {
+            blockedBy: budget
+              .array(entry.blockedBy)
+              .map((item) => ids.get('todo', item)),
+          }
+        : {}),
+    })),
+    ...(preview.truncated ? { truncated: true } : {}),
+    ...(preview.planId ? { planId: ids.get('plan', preview.planId) } : {}),
+    ...(preview.revision !== undefined
+      ? { revision: safeCount(preview.revision) }
+      : {}),
+  };
+}
+
+function terminalToolStatus(
+  status: string,
+  diagnostics: DiagnosticCounter,
+  budget: ExportBudget,
+): ExportToolTranscriptBlockV1['status'] {
+  if (
+    status === 'completed' ||
+    status === 'failed' ||
+    status === 'cancelled' ||
+    status === 'canceled'
+  ) {
+    return status;
+  }
+  diagnostics.add('tool_status_frozen', 'warning', 1, true);
+  budget.markContentLoss();
+  return 'cancelled';
+}
+
+function createMetadataPresentation(
+  sessionData: Pick<ExportSessionData, 'startTime' | 'metadata'>,
+  options: CreateExportTranscriptDocumentOptions,
+  diagnostics: DiagnosticCounter,
+  budget: ExportBudget,
+): Omit<ExportMetadataPresentationV1, 'complete' | 'truncated'> {
+  const metadata = sessionData.metadata;
+  const title = safeMetadataLabel(
+    options.title,
+    200,
+    'title',
+    diagnostics,
+    budget,
+  );
+  const gitBranch = safeMetadataLabel(
+    metadata?.gitBranch,
+    200,
+    'git_branch',
+    diagnostics,
+    budget,
+  );
+  const model = safeMetadataLabel(
+    metadata?.model,
+    200,
+    'model',
+    diagnostics,
+    budget,
+  );
+  const channel = safeMetadataLabel(
+    metadata?.channel,
+    100,
+    'channel',
+    diagnostics,
+    budget,
+  );
+  const projectName = metadata?.cwd
+    ? safeMetadataLabel(
+        safePath(metadata.cwd),
+        400,
+        'project_name',
+        diagnostics,
+        budget,
+        false,
+      )
+    : undefined;
+  const repository = metadata?.gitRepo
+    ? safeRepository(metadata.gitRepo, diagnostics, budget)
+    : undefined;
+  return {
+    ...(title ? { title } : {}),
+    ...(isIsoDate(sessionData.startTime)
+      ? { startedAt: sessionData.startTime }
+      : {}),
+    exportedAt: options.exportedAt,
+    ...(projectName ? { projectName } : {}),
+    ...(repository ? { repository } : {}),
+    ...(gitBranch ? { gitBranch } : {}),
+    ...(model ? { model } : {}),
+    ...(channel ? { channel } : {}),
+    ...(metadata ? { promptCount: safeCount(metadata.promptCount) } : {}),
+    ...(metadata?.contextUsagePercent !== undefined
+      ? {
+          contextUsagePercent: Math.min(
+            100,
+            safeCount(metadata.contextUsagePercent),
+          ),
+        }
+      : {}),
+    ...(metadata?.contextWindowSize !== undefined
+      ? { contextWindowSize: safeCount(metadata.contextWindowSize) }
+      : {}),
+    ...(metadata?.totalTokens !== undefined
+      ? { totalTokens: safeCount(metadata.totalTokens) }
+      : {}),
+    ...(metadata?.filesWritten !== undefined
+      ? { filesWritten: safeCount(metadata.filesWritten) }
+      : {}),
+    ...(metadata?.linesAdded !== undefined
+      ? { linesAdded: safeCount(metadata.linesAdded) }
+      : {}),
+    ...(metadata?.linesRemoved !== undefined
+      ? { linesRemoved: safeCount(metadata.linesRemoved) }
+      : {}),
+  };
+}
+
+const REQUIRED_TEXT_FALLBACK_RESERVE_BYTES = 64 * 1024;
+
+class ExportBudget {
+  visibleTextBytes = 0;
+  totalRasterBytes = 0;
+  richRenderTasks = 0;
+  truncated = false;
+  cumulativeTextBudgetExceeded = false;
+
+  constructor(private readonly diagnostics: DiagnosticCounter) {}
+
+  checkpoint(): {
+    visibleTextBytes: number;
+    totalRasterBytes: number;
+    richRenderTasks: number;
+  } {
+    return {
+      visibleTextBytes: this.visibleTextBytes,
+      totalRasterBytes: this.totalRasterBytes,
+      richRenderTasks: this.richRenderTasks,
+    };
+  }
+
+  restore(checkpoint: ReturnType<ExportBudget['checkpoint']>): void {
+    this.visibleTextBytes = checkpoint.visibleTextBytes;
+    this.totalRasterBytes = checkpoint.totalRasterBytes;
+    this.richRenderTasks = checkpoint.richRenderTasks;
+  }
+
+  array<T>(value: readonly T[]): T[] {
+    if (value.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength) {
+      this.truncated = true;
+      this.diagnostics.add('array_budget_exceeded', 'warning');
+    }
+    return value.slice(0, EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength);
+  }
+
+  markTruncated(code: string): void {
+    this.truncated = true;
+    this.diagnostics.add(code, 'warning');
+  }
+
+  markContentLoss(): void {
+    this.truncated = true;
+  }
+
+  label(value: unknown, maxLength: number, redact = true): string {
+    const safe = safeLabel(value, maxLength);
+    if (safe !== value) this.markTruncated('label_sanitized');
+    return this.applyTextBudgetWithFallback(
+      redact ? redactHomePaths(safe) : safe,
+      safeLabel('[content omitted]', maxLength),
+    );
+  }
+
+  optionalLabel(
+    value: unknown,
+    maxLength: number,
+    redact = true,
+  ): string | undefined {
+    if (value === undefined || value === '') return undefined;
+    return this.label(value, maxLength, redact);
+  }
+
+  plainText(value: string): string {
+    return this.applyTextBudget(redactHomePaths(value));
+  }
+
+  text(value: string): string {
+    value = redactHomePaths(value);
+    const replaceImage = (alt: string, source: string | undefined): string => {
+      const safeAlt = safeLabel(alt, 200).replace(/([\\[\]])/g, '\\$1');
+      const parsed = source ? parseApprovedImageDataUrl(source) : undefined;
+      if (parsed && this.image(parsed)) {
+        return `![${safeAlt}](${formatApprovedImageDataUrl(parsed)})`;
+      }
+      this.truncated = true;
+      this.diagnostics.add('markdown_image_rejected', 'warning');
+      return `[image omitted${safeAlt ? `: ${safeAlt}` : ''}]`;
+    };
+    const resourceSafeValue = sanitizeMarkdownDocument(value, {
+      normalizeUrl: normalizeNavigableUrl,
+      replaceImage,
+      onUrlChange: (code) => {
+        this.truncated = true;
+        this.diagnostics.add(code, 'warning', 1, true);
+      },
+      onComplexityLimit: () => {
+        this.truncated = true;
+        this.diagnostics.add(
+          'markdown_complexity_exceeded',
+          'warning',
+          1,
+          true,
+        );
+      },
+    });
+    const richTaskSafeValue = transformRichMarkdownTasks(
+      resourceSafeValue,
+      () => {
+        this.richRenderTasks += 1;
+        if (
+          this.richRenderTasks <= EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks
+        ) {
+          return true;
+        }
+        this.diagnostics.add('rich_render_budget_exceeded', 'warning');
+        return false;
+      },
+    );
+    return this.applyTextBudget(richTaskSafeValue);
+  }
+
+  private applyTextBudget(value: string): string {
+    return this.applyTextBudgetWithFallback(
+      value,
+      '[content omitted: export text budget exceeded]',
+    );
+  }
+
+  private applyTextBudgetWithFallback(value: string, fallback: string): string {
+    const bytes = utf8Bytes(value);
+    const normalTextLimit =
+      EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes -
+      REQUIRED_TEXT_FALLBACK_RESERVE_BYTES;
+    const perItemExceeded = bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes;
+    const cumulativeExceeded = this.visibleTextBytes + bytes > normalTextLimit;
+    if (perItemExceeded || cumulativeExceeded) {
+      this.truncated = true;
+      if (cumulativeExceeded) this.cumulativeTextBudgetExceeded = true;
+      this.diagnostics.add('text_budget_exceeded', 'warning');
+      const fallbackBytes = utf8Bytes(fallback);
+      if (
+        this.visibleTextBytes + fallbackBytes <=
+        EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes
+      ) {
+        this.visibleTextBytes += fallbackBytes;
+        return fallback;
+      }
+      return '';
+    }
+    this.visibleTextBytes += bytes;
+    return value;
+  }
+
+  image(image: {
+    data: string;
+    mimeType: string;
+  }): { data: string; mimeType: string } | undefined {
+    if (!SAFE_RASTER_MIME_TYPES.has(image.mimeType)) {
+      this.truncated = true;
+      this.diagnostics.add('image_type_rejected', 'warning');
+      return undefined;
+    }
+    const bytes = decodedBase64Bytes(image.data);
+    if (
+      bytes === undefined ||
+      bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
+      this.totalRasterBytes + bytes >
+        EXPORT_TRANSCRIPT_LIMITS_V1.maxTotalRasterBytes ||
+      (image.mimeType === 'image/gif' && isAnimatedGif(image.data))
+    ) {
+      this.truncated = true;
+      this.diagnostics.add('image_budget_or_animation_rejected', 'warning');
+      return undefined;
+    }
+    this.totalRasterBytes += bytes;
+    return { data: image.data, mimeType: image.mimeType };
+  }
+
+  dataImageUrl(value: string): string | undefined {
+    const image = parseApprovedImageDataUrl(value);
+    if (!image) {
+      this.truncated = true;
+      this.diagnostics.add('image_type_rejected', 'warning');
+      return undefined;
+    }
+    return this.image(image) ? formatApprovedImageDataUrl(image) : undefined;
+  }
+}
+
+const SAFE_RASTER_MIME_TYPES = new Set([
+  'image/png',
+  'image/jpeg',
+  'image/gif',
+  'image/webp',
+]);
+
+function parseApprovedImageDataUrl(
+  value: string,
+): { data: string; mimeType: string } | undefined {
+  const match =
+    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
+      value,
+    );
+  if (!match?.[1] || match[2] === undefined) return undefined;
+  return { mimeType: match[1].toLowerCase(), data: match[2] };
+}
+
+function formatApprovedImageDataUrl(image: {
+  data: string;
+  mimeType: string;
+}): string {
+  return `data:${image.mimeType};base64,${image.data}`;
+}
+
+class DiagnosticCounter {
+  private readonly entries = new Map<
+    string,
+    { severity: 'info' | 'warning' | 'error'; count: number }
+  >();
+  private completenessLost = false;
+
+  add(
+    code: string,
+    severity: 'info' | 'warning' | 'error',
+    count = 1,
+    affectsCompleteness = false,
+  ): void {
+    if (affectsCompleteness) this.completenessLost = true;
+    const current = this.entries.get(code);
+    if (current) {
+      current.count += Math.max(1, count);
+      if (severityRank(severity) > severityRank(current.severity)) {
+        current.severity = severity;
+      }
+      return;
+    }
+    this.entries.set(code, { severity, count: Math.max(1, count) });
+  }
+
+  get hasErrors(): boolean {
+    return [...this.entries.values()].some((item) => item.severity === 'error');
+  }
+
+  get hasCompletenessLoss(): boolean {
+    return this.completenessLost;
+  }
+
+  toArray(): ExportTranscriptDiagnosticV1[] {
+    return [...this.entries.entries()]
+      .sort(([a], [b]) => a.localeCompare(b))
+      .map(([code, item]) => ({ code, ...item }));
+  }
+}
+
+class OpaqueDocumentIds {
+  private readonly ids = new Map<string, string>();
+  private nextOrdinal = 0;
+
+  get(kind: string, nativeId: string): string {
+    const key = `${kind}\^@${nativeId}`;
+    let id = this.ids.get(key);
+    if (!id) {
+      id = `${kind}-${this.nextOrdinal}`;
+      this.nextOrdinal += 1;
+      this.ids.set(key, id);
+    }
+    return id;
+  }
+}
+
+const APPROVED_PERMISSION_TOKENS = new Set([
+  'accept',
+  'accepted',
+  'allow',
+  'allow_always',
+  'allow_once',
+  'allowed',
+  'approve',
+  'approved',
+  'confirm',
+  'confirmed',
+  'proceed',
+  'proceed_always_project',
+  'proceed_always_user',
+  'proceed_once',
+  'proceed_once_and_switch_to_default',
+  'succeeded',
+  'success',
+]);
+
+const REJECTED_PERMISSION_TOKENS = new Set([
+  'deny',
+  'denied',
+  'reject',
+  'reject_always',
+  'reject_once',
+  'rejected',
+]);
+
+const CANCELLED_PERMISSION_TOKENS = new Set([
+  'cancel',
+  'canceled',
+  'cancelled',
+]);
+
+const EXPIRED_PERMISSION_TOKENS = new Set([
+  'expired',
+  'session_closed',
+  'timed_out',
+  'timeout',
+]);
+
+export function classifyPermissionResolutionForExport(
+  resolved: string,
+  options: readonly DaemonUiPermissionOption[],
+): { value: ExportPermissionResolutionV1; lossy: boolean } {
+  const separator = resolved.indexOf(':');
+  const primary = (separator === -1 ? resolved : resolved.slice(0, separator))
+    .trim()
+    .toLowerCase();
+  let token = primary;
+  if (primary === 'selected' && separator !== -1) {
+    const optionId = resolved.slice(separator + 1).trim();
+    const option = options.find((candidate) => candidate.optionId === optionId);
+    if (!option) return { value: 'resolved', lossy: true };
+    const raw = isRecord(option.raw) ? option.raw : undefined;
+    token =
+      (typeof raw?.['kind'] === 'string'
+        ? raw['kind'].trim().toLowerCase()
+        : '') || option.optionId.trim().toLowerCase();
+  }
+  if (APPROVED_PERMISSION_TOKENS.has(token)) {
+    return { value: 'approved', lossy: false };
+  }
+  if (REJECTED_PERMISSION_TOKENS.has(token)) {
+    return { value: 'rejected', lossy: false };
+  }
+  if (CANCELLED_PERMISSION_TOKENS.has(token)) {
+    return { value: 'cancelled', lossy: false };
+  }
+  if (EXPIRED_PERMISSION_TOKENS.has(token)) {
+    return { value: 'expired', lossy: false };
+  }
+  if (token === 'resolved') return { value: 'resolved', lossy: false };
+  return { value: 'resolved', lossy: true };
+}
+const SAFE_EXPORT_ERROR_KINDS = new Set<string>(DAEMON_ERROR_KINDS);
+
+function safeExportErrorKind(
+  value: DaemonErrorKind | undefined,
+): DaemonErrorKind | undefined {
+  return value && SAFE_EXPORT_ERROR_KINDS.has(value) ? value : undefined;
+}
+
+const SAFE_IDENTIFIER_LENGTHS = new Map<string, number>([
+  ['id', 200],
+  ['toolCallId', 200],
+  ['requestId', 200],
+  ['optionId', 200],
+  ['parentToolCallId', 200],
+  ['parentBlockId', 200],
+  ['subagentType', 200],
+  ['source', 128],
+  ['planId', 128],
+  ['parentDelegationId', 128],
+  ['method', 16],
+  ['language', 64],
+]);
+const SAFE_PRESENTATION_IDENTIFIER_LENGTHS = new Map<string, number>([
+  ['toolName', 200],
+  ['toolKind', 200],
+  ['serverId', 128],
+  ['agentName', 128],
+  ['header', 200],
+  ['model', 200],
+]);
+
+function assertSemanticSafety(value: Record<string, unknown>): void {
+  const metadata = value['metadata'] as ExportMetadataPresentationV1;
+  const diagnostics = value['diagnostics'] as ExportTranscriptDiagnosticV1[];
+  if (diagnostics.some((diagnostic) => !isSafeLabel(diagnostic.code, 128))) {
+    throw new ExportTranscriptDocumentError('invalid_diagnostic');
+  }
+  for (const [key, maxLength] of [
+    ['title', 200],
+    ['gitBranch', 200],
+    ['model', 200],
+    ['channel', 100],
+  ] as const) {
+    const field = metadata[key];
+    if (field !== undefined && !isSafeLabel(field, maxLength)) {
+      throw new ExportTranscriptDocumentError('invalid_metadata');
+    }
+  }
+  if (!isIsoDate(metadata.exportedAt)) {
+    throw new ExportTranscriptDocumentError('invalid_metadata');
+  }
+  if (metadata.startedAt !== undefined && !isIsoDate(metadata.startedAt)) {
+    throw new ExportTranscriptDocumentError('invalid_metadata');
+  }
+  if (
+    metadata.projectName !== undefined &&
+    !isSafeExportPath(metadata.projectName)
+  ) {
+    throw new ExportTranscriptDocumentError('invalid_metadata');
+  }
+  if (
+    metadata.repository !== undefined &&
+    !isSafeRepository(metadata.repository)
+  ) {
+    throw new ExportTranscriptDocumentError('invalid_metadata');
+  }
+
+  const visit = (entry: unknown, key?: string): void => {
+    if (typeof entry === 'string') {
+      const maxLength = key ? SAFE_IDENTIFIER_LENGTHS.get(key) : undefined;
+      if (maxLength !== undefined && !isSafeLabel(entry, maxLength)) {
+        throw new ExportTranscriptDocumentError('invalid_block');
+      }
+      const presentationMaxLength = key
+        ? SAFE_PRESENTATION_IDENTIFIER_LENGTHS.get(key)
+        : undefined;
+      if (
+        presentationMaxLength !== undefined &&
+        !isSafePresentationLabel(entry, presentationMaxLength)
+      ) {
+        throw new ExportTranscriptDocumentError('invalid_block');
+      }
+      if (
+        key !== undefined &&
+        ['path', 'cwd', 'origin'].includes(key) &&
+        !isSafeExportPath(entry)
+      ) {
+        throw new ExportTranscriptDocumentError('invalid_block');
+      }
+      if (key === 'url' && !isSafeDisplayUrl(entry)) {
+        throw new ExportTranscriptDocumentError('invalid_block');
+      }
+      return;
+    }
+    if (Array.isArray(entry)) {
+      if (
+        key === 'blockedBy' &&
+        !entry.every((item) => isSafeLabel(item, 128))
+      ) {
+        throw new ExportTranscriptDocumentError('invalid_block');
+      }
+      for (const item of entry) visit(item, key);
+      return;
+    }
+    if (!isRecord(entry)) return;
+    if (
+      (entry['kind'] === 'status' || entry['kind'] === 'error') &&
+      entry['code'] !== undefined &&
+      !isSafeLabel(entry['code'], 128)
+    ) {
+      throw new ExportTranscriptDocumentError('invalid_block');
+    }
+    for (const [childKey, child] of Object.entries(entry)) {
+      visit(child, childKey);
+    }
+  };
+  visit(value['blocks']);
+}
+
+function assertDocumentConsistency(value: Record<string, unknown>): void {
+  const metadata = value['metadata'] as ExportMetadataPresentationV1;
+  const diagnostics = value['diagnostics'] as ExportTranscriptDiagnosticV1[];
+  const blocks = value['blocks'] as ExportTranscriptBlockV1[];
+  const blockIds = new Set(blocks.map((block) => block.id));
+  if (blockIds.size !== blocks.length) {
+    throw new ExportTranscriptDocumentError('duplicate_block_id');
+  }
+  for (const block of blocks) {
+    if (
+      block.kind === 'tool' &&
+      block.parentBlockId !== undefined &&
+      !blockIds.has(block.parentBlockId)
+    ) {
+      throw new ExportTranscriptDocumentError('invalid_block_reference');
+    }
+  }
+  if (metadata.complete && metadata.truncated) {
+    throw new ExportTranscriptDocumentError('invalid_metadata_state');
+  }
+  const hasError = diagnostics.some(
+    (diagnostic) => diagnostic.severity === 'error',
+  );
+  const hasCompletenessDiagnostic = diagnostics.some(
+    (diagnostic) =>
+      diagnostic.severity === 'error' ||
+      (diagnostic.severity === 'warning' &&
+        diagnostic.code !== 'rich_render_budget_exceeded'),
+  );
+  const hasTruncationDiagnostic = diagnostics.some((diagnostic) =>
+    TRUNCATION_DIAGNOSTIC_CODES.has(diagnostic.code),
+  );
+  const hasExplicitContentLoss = blocks.some((block) => {
+    if (
+      block.kind === 'tool' &&
+      (block.status === 'completed' || block.status === 'failed') &&
+      block.resultPreview === undefined
+    ) {
+      return true;
+    }
+    if (block.kind === 'tool') {
+      return (
+        (block.preview.kind === 'todo_list' &&
+          block.preview.truncated === true) ||
+        (block.resultPreview?.kind === 'todo_list' &&
+          block.resultPreview.truncated === true)
+      );
+    }
+    if (block.kind === 'permission') {
+      return (
+        block.preview.kind === 'todo_list' && block.preview.truncated === true
+      );
+    }
+    return false;
+  });
+  if (
+    (hasError || hasCompletenessDiagnostic || hasExplicitContentLoss) &&
+    metadata.complete
+  ) {
+    throw new ExportTranscriptDocumentError('invalid_metadata_state');
+  }
+  if (
+    (hasExplicitContentLoss || hasTruncationDiagnostic) &&
+    !metadata.truncated
+  ) {
+    throw new ExportTranscriptDocumentError('invalid_metadata_state');
+  }
+}
+
+const TRUNCATION_DIAGNOSTIC_CODES = new Set([
+  'envelope_budget_exceeded',
+  'array_budget_exceeded',
+  'todo_preview_truncated',
+  'markdown_image_rejected',
+  'markdown_complexity_exceeded',
+  'text_budget_exceeded',
+  'image_type_rejected',
+  'image_budget_or_animation_rejected',
+  'tool_status_frozen',
+  'url_sanitized',
+  'url_rejected',
+  'repository_url_rejected',
+  'repository_rejected',
+  'title_rejected',
+  'git_branch_rejected',
+  'model_rejected',
+  'channel_rejected',
+  'project_name_rejected',
+  'permission_resolution_sanitized',
+  'tool_result_presentation_missing',
+  'label_sanitized',
+]);
+
+function assertNoForbiddenFields(value: unknown): void {
+  const forbidden = new Set([
+    'rawInput',
+    'rawOutput',
+    'toolCall',
+    'details',
+    'locations',
+    'meta',
+    'sessionId',
+    'sourceRecordIds',
+    'eventId',
+    'serverTimestamp',
+    'promptId',
+    'branchRecordId',
+    'debugReason',
+  ]);
+  const visit = (entry: unknown, key?: string): void => {
+    if (typeof entry === 'string') {
+      const safePathField =
+        key !== undefined &&
+        ['path', 'cwd', 'origin', 'projectName'].includes(key);
+      if (key !== 'data' && containsUnredactedHomePath(entry, !safePathField)) {
+        throw new ExportTranscriptDocumentError('home_path_forbidden');
+      }
+      return;
+    }
+    if (Array.isArray(entry)) {
+      for (const item of entry) visit(item, key);
+      return;
+    }
+    if (!isRecord(entry)) return;
+    for (const [key, item] of Object.entries(entry)) {
+      if (forbidden.has(key)) {
+        throw new ExportTranscriptDocumentError('forbidden_field');
+      }
+      visit(item, key);
+    }
+  };
+  visit(value);
+}
+
+function assertDepthAndArrayBudgets(
+  value: unknown,
+  depth = 0,
+  ancestors = new WeakSet<object>(),
+): void {
+  if (depth > EXPORT_TRANSCRIPT_LIMITS_V1.maxObjectDepth) {
+    throw new ExportTranscriptDocumentError('object_depth_exceeded');
+  }
+  if (Array.isArray(value)) {
+    if (ancestors.has(value)) {
+      throw new ExportTranscriptDocumentError('cyclic_envelope');
+    }
+    if (value.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength) {
+      throw new ExportTranscriptDocumentError('array_budget_exceeded');
+    }
+    ancestors.add(value);
+    for (const item of value) {
+      assertDepthAndArrayBudgets(item, depth + 1, ancestors);
+    }
+    ancestors.delete(value);
+    return;
+  }
+  if (!isRecord(value)) return;
+  if (ancestors.has(value)) {
+    throw new ExportTranscriptDocumentError('cyclic_envelope');
+  }
+  const entries = Object.values(value);
+  if (entries.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxObjectProperties) {
+    throw new ExportTranscriptDocumentError('object_property_budget_exceeded');
+  }
+  ancestors.add(value);
+  for (const item of entries) {
+    assertDepthAndArrayBudgets(item, depth + 1, ancestors);
+  }
+  ancestors.delete(value);
+}
+
+function serializedEnvelopeBytes(value: unknown): number {
+  try {
+    const serialized = JSON.stringify(value);
+    if (serialized === undefined) {
+      throw new ExportTranscriptDocumentError('invalid_envelope');
+    }
+    return utf8Bytes(escapeJsonForHtmlScriptData(serialized));
+  } catch (error) {
+    if (error instanceof ExportTranscriptDocumentError) throw error;
+    throw new ExportTranscriptDocumentError('invalid_envelope');
+  }
+}
+
+function assertResourceBudgets(value: unknown): void {
+  let visibleTextBytes = 0;
+  let totalRasterBytes = 0;
+  let richRenderTasks = 0;
+  const visit = (
+    entry: unknown,
+    key?: string,
+    parent?: Record<string, unknown>,
+    path: readonly string[] = [],
+  ): void => {
+    if (typeof entry === 'string') {
+      if (key === 'data') return;
+      if (key === 'thumbnailUrl') {
+        const image = parseApprovedImageDataUrl(entry);
+        const bytes = image ? decodedBase64Bytes(image.data) : undefined;
+        const canonical = image ? formatApprovedImageDataUrl(image) : undefined;
+        if (
+          bytes === undefined ||
+          bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
+          entry !== canonical ||
+          (image?.mimeType === 'image/gif' && isAnimatedGif(image.data))
+        ) {
+          throw new ExportTranscriptDocumentError('invalid_thumbnail_image');
+        }
+        totalRasterBytes += bytes;
+        return;
+      }
+      const bytes = utf8Bytes(entry);
+      if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes) {
+        throw new ExportTranscriptDocumentError('text_budget_exceeded');
+      }
+      const markdownText = isMarkdownExportText(key, parent, path);
+      if (key && VISIBLE_EXPORT_TEXT_FIELDS.has(key)) {
+        visibleTextBytes += bytes;
+      }
+      if (markdownText) {
+        richRenderTasks += countRichMarkdownTasks(entry);
+        const sanitized = sanitizeMarkdownDocument(entry, {
+          normalizeUrl: normalizeNavigableUrl,
+          onUrlChange: () => {
+            throw new ExportTranscriptDocumentError('invalid_markdown_url');
+          },
+          onComplexityLimit: () => {
+            throw new ExportTranscriptDocumentError(
+              'markdown_complexity_exceeded',
+            );
+          },
+          replaceImage: (alt, source) => {
+            const image = source
+              ? parseApprovedImageDataUrl(source)
+              : undefined;
+            const imageBytes = image
+              ? decodedBase64Bytes(image.data)
+              : undefined;
+            if (
+              !image ||
+              imageBytes === undefined ||
+              imageBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
+              (image.mimeType === 'image/gif' && isAnimatedGif(image.data))
+            ) {
+              throw new ExportTranscriptDocumentError('invalid_markdown_image');
+            }
+            totalRasterBytes += imageBytes;
+            const safeAlt = safeLabel(alt, 200).replace(/([\\[\]])/g, '\\$1');
+            return `![${safeAlt}](${formatApprovedImageDataUrl(image)})`;
+          },
+        });
+        if (sanitized !== entry) {
+          throw new ExportTranscriptDocumentError('invalid_markdown_image');
+        }
+      }
+      return;
+    }
+    if (Array.isArray(entry)) {
+      for (const item of entry) visit(item, key, parent, path);
+      return;
+    }
+    if (!isRecord(entry)) return;
+    if (
+      typeof entry['data'] === 'string' &&
+      typeof entry['mimeType'] === 'string'
+    ) {
+      const bytes = decodedBase64Bytes(entry['data']);
+      if (
+        bytes === undefined ||
+        bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
+        !SAFE_RASTER_MIME_TYPES.has(entry['mimeType']) ||
+        (entry['mimeType'] === 'image/gif' && isAnimatedGif(entry['data']))
+      ) {
+        throw new ExportTranscriptDocumentError('raster_budget_exceeded');
+      }
+      totalRasterBytes += bytes;
+    }
+    for (const [childKey, item] of Object.entries(entry)) {
+      visit(item, childKey, entry, [...path, childKey]);
+    }
+  };
+  visit(value);
+  if (visibleTextBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes) {
+    throw new ExportTranscriptDocumentError('visible_text_budget_exceeded');
+  }
+  if (totalRasterBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTotalRasterBytes) {
+    throw new ExportTranscriptDocumentError('total_raster_budget_exceeded');
+  }
+  if (richRenderTasks > EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks) {
+    throw new ExportTranscriptDocumentError('rich_render_budget_exceeded');
+  }
+}
+
+function isMarkdownExportText(
+  key: string | undefined,
+  parent: Record<string, unknown> | undefined,
+  path: readonly string[],
+): boolean {
+  if (path.at(-2) === 'resultPreview') {
+    return key === 'text' || key === 'summary';
+  }
+  return (
+    key === 'text' &&
+    ['user', 'assistant', 'thought', 'status', 'error'].includes(
+      String(parent?.['kind']),
+    )
+  );
+}
+
+function normalizeNavigableUrl(value: string): string | undefined {
+  if (value.startsWith('#')) return value;
+  if (value.startsWith('/') && !value.startsWith('//')) {
+    if (value.includes('\\')) return undefined;
+    const queryIndex = value.search(/[?#]/);
+    return queryIndex === -1 ? value : value.slice(0, queryIndex);
+  }
+  try {
+    const url = new URL(value);
+    if (
+      url.protocol !== 'http:' &&
+      url.protocol !== 'https:' &&
+      url.protocol !== 'mailto:'
+    ) {
+      return undefined;
+    }
+    if (
+      url.username === '' &&
+      url.password === '' &&
+      url.search === '' &&
+      url.hash === ''
+    ) {
+      return value;
+    }
+    url.username = '';
+    url.password = '';
+    url.search = '';
+    url.hash = '';
+    return url.toString();
+  } catch {
+    return undefined;
+  }
+}
+
+const VISIBLE_EXPORT_TEXT_FIELDS = new Set([
+  'text',
+  'title',
+  'label',
+  'description',
+  'command',
+  'cwd',
+  'question',
+  'path',
+  'oldText',
+  'newText',
+  'patch',
+  'url',
+  'argsSummary',
+  'code',
+  'origin',
+  'query',
+  'top',
+  'columns',
+  'rows',
+  'prompt',
+  'task',
+  'value',
+  'content',
+  'summary',
+  'reason',
+  'projectName',
+  'repository',
+  'gitBranch',
+  'model',
+  'channel',
+]);
+
+function safeDisplayUrl(
+  raw: string,
+  diagnostics: DiagnosticCounter,
+  onContentLoss?: () => void,
+): string {
+  try {
+    const safe = normalizeNavigableUrl(raw);
+    if (!safe) throw new Error();
+    const url = new URL(safe);
+    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
+      throw new Error();
+    }
+    if (utf8Bytes(safe) > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes) {
+      throw new Error();
+    }
+    if (safe !== raw) {
+      diagnostics.add('url_sanitized', 'warning', 1, true);
+      onContentLoss?.();
+    }
+    return safe;
+  } catch {
+    diagnostics.add('url_rejected', 'warning', 1, true);
+    onContentLoss?.();
+    return '[link omitted]';
+  }
+}
+
+function safeRepository(
+  raw: string,
+  diagnostics: DiagnosticCounter,
+  budget: ExportBudget,
+): string {
+  if (/^https?:/i.test(raw)) {
+    const safe = safeDisplayUrl(raw, diagnostics, () =>
+      budget.markContentLoss(),
+    );
+    if (safe.length <= 200) return budget.plainText(safe);
+    diagnostics.add('repository_url_rejected', 'warning', 1, true);
+    budget.markContentLoss();
+    return budget.plainText('[link omitted]');
+  }
+  const safe = safePath(raw).replace(/\.git$/i, '');
+  if (isSafeLabel(safe, 200)) return budget.label(safe, 200, false);
+  diagnostics.add('repository_rejected', 'warning', 1, true);
+  budget.markContentLoss();
+  return budget.plainText('[link omitted]');
+}
+
+function safeMetadataLabel(
+  value: unknown,
+  maxLength: number,
+  field: string,
+  diagnostics: DiagnosticCounter,
+  budget: ExportBudget,
+  redact = true,
+): string | undefined {
+  if (value === undefined || value === '') return undefined;
+  if (isSafeLabel(value, maxLength)) {
+    return redact
+      ? budget.plainText(value)
+      : budget.label(value, maxLength, false);
+  }
+  diagnostics.add(`${field}_rejected`, 'warning', 1, true);
+  budget.markContentLoss();
+  return undefined;
+}
+
+function isSafeDisplayUrl(value: unknown): value is string {
+  if (
+    value === '[link omitted]' ||
+    value === '[content omitted: export text budget exceeded]'
+  ) {
+    return true;
+  }
+  if (typeof value !== 'string') return false;
+  try {
+    const url = new URL(value);
+    return (
+      (url.protocol === 'http:' || url.protocol === 'https:') &&
+      normalizeNavigableUrl(value) === value
+    );
+  } catch {
+    return false;
+  }
+}
+
+function isSafeRepository(value: unknown): value is string {
+  return (
+    (typeof value === 'string' &&
+      !/^https?:/i.test(value) &&
+      isSafeLabel(value, 200) &&
+      !/[\\/]/.test(value)) ||
+    isSafeDisplayUrl(value)
+  );
+}
+
+function safePath(value: string): string {
+  const normalized = value
+    .replaceAll('\\', '/')
+    .replace(/^file:\/\/[^/]+\//i, '/')
+    .replace(/^file:\/\/\//i, '/')
+    .replace(/^file:\//i, '/')
+    .replace(/\/+$/, '');
+  const components = normalized.split('/').filter(Boolean);
+  const rootIndex = /^[A-Za-z]:$/.test(components[0] ?? '') ? 1 : 0;
+  if (
+    /^(?:Users|home)$/i.test(components[rootIndex] ?? '') &&
+    components[rootIndex + 1] !== undefined
+  ) {
+    const homeBasename = components.at(-1);
+    if (components.length === rootIndex + 2) return '[home]';
+    return homeBasename && homeBasename !== '.' && homeBasename !== '..'
+      ? homeBasename
+      : '[path]';
+  }
+  const basename = components.at(-1);
+  return basename && !/^[A-Za-z]:$/.test(basename) ? basename : '[path]';
+}
+
+function isSafeExportPath(value: unknown): value is string {
+  return (
+    isSafePresentationLabel(value, 400) &&
+    !/[\\/]/.test(String(value)) &&
+    !/^[A-Za-z]:$/.test(String(value))
+  );
+}
+
+function redactHomePaths(value: string): string {
+  return redactHomePathStructures(value);
+}
+function redactHomePathStructures(value: string): string {
+  const urlPattern =
+    /\b(?:https?:\/\/|data:image\/[A-Za-z0-9.+-]+;base64,)[^\s<>"'\x60]+/gi;
+  let result = '';
+  let cursor = 0;
+  for (const match of value.matchAll(urlPattern)) {
+    result += redactNonHttpHomePathStructures(value.slice(cursor, match.index));
+    result += match[0];
+    cursor = match.index + match[0].length;
+  }
+  return result + redactNonHttpHomePathStructures(value.slice(cursor));
+}
+
+function redactNonHttpHomePathStructures(value: string): string {
+  const rawRedacted = redactRawHomePathStructures(value);
+  const encodedRedacted = rawRedacted.replace(
+    /(^|[^A-Za-z0-9%])(%[0-9A-Fa-f]{2}[^\s<>"'\x60]*)/g,
+    (
+      match: string,
+      prefix: string,
+      token: string,
+      offset: number,
+      source: string,
+    ) => {
+      const tokenStart = offset + prefix.length;
+      if (source.slice(0, tokenStart).endsWith('[home]')) return match;
+      let decoded = token;
+      for (let pass = 0; pass < 3; pass += 1) {
+        try {
+          const next = decodeURIComponent(decoded);
+          if (next === decoded) break;
+          decoded = next;
+        } catch {
+          break;
+        }
+      }
+      const redacted = redactRawHomePathStructures(decoded);
+      return redacted === decoded ? match : prefix + redacted;
+    },
+  );
+  return encodedRedacted.replace(
+    /file:\/+(?:[^/\s]+\/)?(?:[A-Za-z]:\/)?\[home\]/gi,
+    'file://[home]',
+  );
+}
+
+function redactRawHomePathStructures(value: string): string {
+  return value
+    .replace(
+      /file:\/+(?:[^/\s]+\/)?(?:[A-Za-z]:\/)?(?:home|Users)\/(?:\.\/|\/)*[^/\\\s<>"'\x60,;:|()]+/gi,
+      'file://[home]',
+    )
+    .replace(
+      /(^|[^A-Za-z0-9_+\-./\\%])(\/(?:home|Users)\/(?:\.\/|\/)*[^/\\\s<>"'\x60,;:|()]+)/gi,
+      (
+        match: string,
+        prefix: string,
+        _path: string,
+        offset: number,
+        source: string,
+      ) =>
+        source.slice(0, offset + prefix.length).endsWith('[home]')
+          ? match
+          : prefix + '[home]',
```

> **[Critical]** R1-1: (fix-induced) The home-path redaction boundary is still bypassable at this head — the replacement mechanism introduced by the round-1 fix has three executed bypass entrances, so the round-1 class finding stands. (1) Leading-slash/dot-segment spellings defeat the boundary class: `//home/alice/secret.txt`, `/./home/alice/...`, `//Users/bob/Library/Keychains` export verbatim with `complete:true` (the boundary class excludes `/` and `.` before `home|Users`; the redundant-segment cleanup only runs after `home/`). (2) Input-borne `[home]` grants immunity: text containing `[home]/home/alice/.ssh/id_rsa` suppresses both the redactor and the residual detector via the `endsWith('[home]')` guards, so a raw home path reaches the shareable export while `home_path_forbidden` passes — while the percent-encoded twin fails closed. (3) Nested home paths leak in the single replace pass: `/home/alice/home/bob/secret.txt` exports as `[home]/home/bob/secret.txt` (substituted output is never rescanned, and the detector exemption clears the residue) — and `export-transcript-document.test.ts:201` pins the leaking shape. Enumerating more spellings will not converge: the entrance space of path spellings in arbitrary text has no last corner.
>
> Witness — probes at this head:
>
> ```
> CONTROL in: "leak /home/alice/.ssh/id_rsa end" -> "leak [home]/.ssh/id_rsa end"
> BYPASS in: "leak [home]/home/alice/.ssh/id_rsa end" -> unchanged, complete:true, diagnostics:[]
> in: "nested /home/alice/home/bob/secret.txt" -> "nested [home]/home/bob/secret.txt", complete:true
> in: "//home/alice/secret.txt", "/./home/alice/...", "//Users/bob/Library/Keychains" -> exported verbatim, complete:true
> ASYMMETRY in: "leak [home]%2Fhome%2Falice%2Fsecret end" -> throws home_path_forbidden (fails closed)
> ```
>
> Suggested fix: match the sensitive structure instead of a grammar — extract path-like and percent-encoded tokens, normalize them (collapse `//`, resolve `.` segments, decode percent-encoding) and redact when the normalized token is prefixed by the actual home directory captured at export time; delete both `endsWith('[home]')` guards so the detector flags every raw `/home|/Users/<seg>` occurrence (detector must be a strict superset of the redactor); update the `nested=` expectation at `export-transcript-document.test.ts:201`, which pins the leaking shape.
>
> Fix witness: add cases asserting `[home]/home/alice/private.txt`, `//home/alice/x`, and `/home/alice/home/bob/secret.txt` each export without `/home/alice` or `/home/bob` surviving, then remove the new redaction logic and confirm those tests go red.
>
> <details>
> <summary>中文说明</summary>
>
> 本 head 上主目录脱敏边界仍可被绕过——round 1 修复引入的新机制存在三个已实测的绕出入口，因此 round 1 的类级发现仍然成立。(1) 前导斜杠/点段拼写可绕过边界类：`//home/alice/secret.txt`、`/./home/alice/...`、`//Users/bob/Library/Keychains` 都会原样导出且 `complete:true`（边界类在 `home|Users` 之前排除了 `/` 和 `.`，冗余段清理只在 `home/` 之后生效）。(2) 输入自带的 `[home]` 会获得豁免：包含 `[home]/home/alice/.ssh/id_rsa` 的文本通过 `endsWith('[home]')` 守卫同时压制了脱敏器与残留检测器，原始主目录路径进入可分享导出而 `home_path_forbidden` 放行——其百分号编码孪生形态却是快速失败（抛错）的。(3) 嵌套主目录路径在单次替换中泄漏：`/home/alice/home/bob/secret.txt` 导出为 `[home]/home/bob/secret.txt`（替换结果从不重扫描，且检测器的豁免清除了残留）——并且 `export-transcript-document.test.ts:201` 把泄漏形态固化成了断言。继续枚举更多拼写不会收敛：任意文本中路径拼写的入口空间没有最后一个角。
>
> 建议修复：改为匹配敏感结构本身而非语法——提取路径状与百分号编码的 token，做归一化（折叠 `//`、解析 `.` 段、解码百分号），当归一化 token 以导出时捕获的真实主目录为前缀时脱敏；删除两个 `endsWith('[home]')` 守卫，使检测器标记每一处原始 `/home|/Users/<seg>`（检测器必须是脱敏器的严格超集）；更新 `export-transcript-document.test.ts:201` 的 `nested=` 断言，它目前固化的是泄漏形态。
>
> 修复见证：新增用例断言 `[home]/home/alice/private.txt`、`//home/alice/x`、`/home/alice/home/bob/secret.txt` 导出后不含 `/home/alice` 或 `/home/bob`，然后移除新脱敏逻辑并确认这些测试变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 3. R1-6 复查：rich-task 复杂度回退未标记内容损失

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074057)
- 结论：值得修复
- 理由：成立。sanitize 路径会调用 onComplexityLimit，但 transformRichMarkdownTasks 在 parseMarkdown 返回 undefined 时直接返回 fallback，调用方无法设置 truncated/diagnostic，导致静默丢失。
- 建议修复：为 transformRichMarkdownTasks 增加复杂度回调，并在 ExportBudget.text 中复用同一 completeness 记录逻辑。
- 实施状态：已修复并验证
- 修复批次：F2
- 实施证据：已为 transformRichMarkdownTasks 增加复杂度回调并接入 ExportBudget completeness；unit 与真实 document 回归均验证 fallback 会产生 diagnostic、complete=false、truncated=true。CLI 聚焦测试 46/46。

原始评论：

标注位置：`packages/cli/src/ui/utils/export/markdown-document-policy.ts:301-302`（RIGHT（新增侧））

````diff
@@ -0,0 +1,321 @@
+/**
+ * @license
+ * Copyright 2025 Qwen Team
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { unified } from 'unified';
+import remarkGfm from 'remark-gfm';
+import remarkMath from 'remark-math';
+import remarkParse from 'remark-parse';
+
+interface MarkdownPoint {
+  offset?: number;
+}
+
+interface MarkdownNode {
+  type: string;
+  value?: string;
+  url?: string;
+  alt?: string;
+  identifier?: string;
+  lang?: string | null;
+  children?: MarkdownNode[];
+  position?: { start: MarkdownPoint; end: MarkdownPoint };
+}
+
+interface Replacement {
+  start: number;
+  end: number;
+  value: string;
+}
+
+export interface MarkdownDocumentPolicy {
+  normalizeUrl(source: string): string | undefined;
+  replaceImage(alt: string, source: string | undefined): string;
+  onUrlChange(code: 'url_rejected' | 'url_sanitized'): void;
+  onComplexityLimit?(): void;
+}
+
+const MARKDOWN_COMPLEXITY_FALLBACK =
+  '[markdown omitted: complexity limit exceeded]';
+const MAX_MARKDOWN_SOURCE_MARKERS = 2_048;
+const MAX_MARKDOWN_AST_NODES = 20_000;
+const MAX_MARKDOWN_AST_DEPTH = 512;
+
+const markdownParser = unified()
+  .use(remarkParse)
+  .use(remarkGfm)
+  .use(remarkMath);
+
+function mayContainNavigableMarkdown(value: string): boolean {
+  return (
+    value.includes(']') ||
+    value.includes('@') ||
+    /www\.|(?:https?|mailto|javascript|data):/i.test(value) ||
+    (value.includes('<') && value.includes('>'))
+  );
+}
+
+function mayContainFencedCode(value: string): boolean {
+  return value.includes('```') || value.includes('~~~');
+}
+
+function parseMarkdown(value: string): MarkdownNode | undefined {
+  let markers = 0;
+  for (const character of value) {
+    if (character !== '[' && character !== ']' && character !== '>') continue;
+    markers += 1;
+    if (markers > MAX_MARKDOWN_SOURCE_MARKERS) return undefined;
+  }
+  try {
+    const root = markdownParser.parse(value) as unknown as MarkdownNode;
+    return isMarkdownTreeWithinBudget(root) ? root : undefined;
+  } catch {
+    return undefined;
+  }
+}
+
+function walkMarkdown(
+  node: MarkdownNode,
+  visit: (node: MarkdownNode) => boolean | void,
+): void {
+  const stack = [node];
+  while (stack.length > 0) {
+    const current = stack.pop();
+    if (!current || visit(current) === false) continue;
+    const children = current.children ?? [];
+    for (let index = children.length - 1; index >= 0; index -= 1) {
+      stack.push(children[index]);
+    }
+  }
+}
+
+function isMarkdownTreeWithinBudget(root: MarkdownNode): boolean {
+  const stack: Array<{ node: MarkdownNode; depth: number }> = [
+    { node: root, depth: 0 },
+  ];
+  let nodes = 0;
+  while (stack.length > 0) {
+    const current = stack.pop();
+    if (!current) continue;
+    nodes += 1;
+    if (
+      nodes > MAX_MARKDOWN_AST_NODES ||
+      current.depth > MAX_MARKDOWN_AST_DEPTH
+    ) {
+      return false;
+    }
+    for (const child of current.node.children ?? []) {
+      stack.push({ node: child, depth: current.depth + 1 });
+    }
+  }
+  return true;
+}
+
+function rangeOf(
+  node: MarkdownNode,
+): { start: number; end: number } | undefined {
+  const start = node.position?.start.offset;
+  const end = node.position?.end.offset;
+  return typeof start === 'number' && typeof end === 'number'
+    ? { start, end }
+    : undefined;
+}
+
+function applyReplacements(value: string, replacements: Replacement[]): string {
+  let result = value;
+  let previousStart = Number.POSITIVE_INFINITY;
+  for (const replacement of replacements.sort(
+    (left, right) => right.start - left.start,
+  )) {
+    if (replacement.end > previousStart) continue;
+    result =
+      result.slice(0, replacement.start) +
+      replacement.value +
+      result.slice(replacement.end);
+    previousStart = replacement.start;
+  }
+  return result;
+}
+
+function normalizedIdentifier(node: MarkdownNode): string | undefined {
+  return node.identifier?.trim().toLowerCase();
+}
+
+function markdownText(node: MarkdownNode): string {
+  if (node.type === 'text' || node.type === 'inlineCode') {
+    return node.value ?? '';
+  }
+  if (node.type === 'image') return node.alt ?? '';
+  return (node.children ?? []).map(markdownText).join('');
+}
+
+function escapeLabel(value: string): string {
+  return value.replace(/([\\[\]])/g, '\\$1');
+}
+
+function safeLinkReplacement(
+  original: string,
+  node: MarkdownNode,
+  safe: string | undefined,
+): string {
+  if (!safe) {
+    return original.trimStart().startsWith('[')
+      ? escapeLabel(markdownText(node))
+      : '[link omitted]';
+  }
+  if (!original.trimStart().startsWith('[')) return safe;
+  return `[${escapeLabel(markdownText(node))}](${safe})`;
+}
+
+export function sanitizeMarkdownDocument(
+  value: string,
+  policy: MarkdownDocumentPolicy,
+): string {
+  if (!mayContainNavigableMarkdown(value)) return value;
+  const root = parseMarkdown(value);
+  if (!root) {
+    policy.onComplexityLimit?.();
+    return MARKDOWN_COMPLEXITY_FALLBACK;
+  }
+  const definitions = new Map<string, MarkdownNode>();
+  const imageDefinitionIds = new Set<string>();
+  const linkDefinitionIds = new Set<string>();
+  walkMarkdown(root, (node) => {
+    if (node.type === 'definition') {
+      const identifier = normalizedIdentifier(node);
+      if (identifier && !definitions.has(identifier)) {
+        definitions.set(identifier, node);
+      }
+    } else if (node.type === 'imageReference') {
+      const identifier = normalizedIdentifier(node);
+      if (identifier) imageDefinitionIds.add(identifier);
+    } else if (node.type === 'linkReference') {
+      const identifier = normalizedIdentifier(node);
+      if (identifier) linkDefinitionIds.add(identifier);
+    }
+  });
+
+  const replacements: Replacement[] = [];
+  walkMarkdown(root, (node) => {
+    const range = rangeOf(node);
+    if (!range) return;
+    if (node.type === 'code' || node.type === 'inlineCode') return false;
+    if (node.type === 'image') {
+      replacements.push({
+        ...range,
+        value: policy.replaceImage(node.alt ?? '', node.url),
+      });
+      return false;
+    }
+    if (node.type === 'imageReference') {
+      const definition = definitions.get(normalizedIdentifier(node) ?? '');
+      replacements.push({
+        ...range,
+        value: policy.replaceImage(node.alt ?? '', definition?.url),
+      });
+      return false;
+    }
+    if (node.type === 'html' && /<img\b/i.test(node.value ?? '')) {
+      replacements.push({
+        ...range,
+        value: policy.replaceImage('', undefined),
+      });
+      return false;
+    }
+    if (node.type === 'definition') {
+      const identifier = normalizedIdentifier(node);
+      if (
+        identifier &&
+        imageDefinitionIds.has(identifier) &&
+        !linkDefinitionIds.has(identifier)
+      ) {
+        replacements.push({ ...range, value: '' });
+        return false;
+      }
+      const source = node.url ?? '';
+      const safe = policy.normalizeUrl(source);
+      if (safe === source) return false;
+      policy.onUrlChange(safe ? 'url_sanitized' : 'url_rejected');
+      replacements.push({
+        ...range,
+        value:
+          safe && identifier ? `[${escapeLabel(identifier)}]: ${safe}` : '',
+      });
+      return false;
+    }
+    if (node.type === 'link') {
+      const source = node.url ?? '';
+      const safe = policy.normalizeUrl(source);
+      if (safe === source) return;
+      policy.onUrlChange(safe ? 'url_sanitized' : 'url_rejected');
+      replacements.push({
+        ...range,
+        value: safeLinkReplacement(
+          value.slice(range.start, range.end),
+          node,
+          safe,
+        ),
+      });
+      return false;
+    }
+    return undefined;
+  });
+  return applyReplacements(value, replacements);
+}
+
+function richLanguage(node: MarkdownNode): string | undefined {
+  if (node.type !== 'code' || !node.lang) return undefined;
+  const language = node.lang.trim().toLowerCase();
+  return ['text', 'plain', 'plaintext'].includes(language)
+    ? undefined
+    : language;
+}
+
+function demoteFence(
+  value: string,
+  node: MarkdownNode,
+  language: string,
+): Replacement | undefined {
+  const range = rangeOf(node);
+  if (!range) return undefined;
+  const lineEnd = value.indexOf('\n', range.start);
+  const end = lineEnd === -1 || lineEnd > range.end ? range.end : lineEnd;
+  const opening = value.slice(range.start, end);
+  const match = /^(`{3,}|~{3,})[ \t]*(\S+)(.*)$/.exec(opening);
+  if (!match) return undefined;
+  return {
+    start: range.start,
+    end,
+    value: `${match[1]}text${match[3]} [source fallback: ${language.slice(0, 32)}]`,
+  };
+}
+
+export function transformRichMarkdownTasks(
+  value: string,
+  keepTask: (language: string) => boolean,
+): string {
+  if (!mayContainFencedCode(value)) return value;
+  const replacements: Replacement[] = [];
+  const root = parseMarkdown(value);
+  if (!root) return MARKDOWN_COMPLEXITY_FALLBACK;
````

> **[Critical]** R1-6: (fix-induced) The complexity bound added for round-1 R1-6's re-parse hang has a silent path: `transformRichMarkdownTasks` hits the complexity fallback with no `onComplexityLimit` hook, while its sibling `sanitizeMarkdownDocument` reports via `policy.onComplexityLimit?.()` — so `ExportBudget.text()` cannot record `truncated` or the `markdown_complexity_exceeded` diagnostic. `assertResourceBudgets` accepts the fallback (it re-sanitizes cleanly), and the exported document silently loses an entire entry while claiming completeness — violating this module's own degraded/complete consistency invariant. Note the marker count can RISE between the two passes (each rejected autolink like `<javascript:alert(1)>` becomes `[link omitted]`, 1 marker to 2), so a fence near the cap after sanitize can exceed it in the transform.
>
> Witness — probe at this head:
>
> ```
> in: code fence + ~2049 '[' markers (no navigable content)
> out: entry replaced by '[markdown omitted: complexity limit exceeded]'
>      complete:true, truncated:false, diagnostics:[]
> control: identical marker load without the fence survives (complete:true)
> flip: wiring onComplexityLimit -> complete:false, truncated:true, diagnostics:[markdown_complexity_exceeded]
> ```
>
> Suggested fix: give `transformRichMarkdownTasks` a complexity callback invoked on the `!root` branch (or fold it into the policy object), and wire it in `ExportBudget.text()` to set `truncated` and add `markdown_complexity_exceeded`, mirroring the sanitize path.
>
> Fix witness: in `markdown-document-policy.test.ts`, feed `transformRichMarkdownTasks` a value whose marker count exceeds the cap after sanitize and assert the complexity callback fires; removing the callback invocation must make it red.
>
> <details>
> <summary>中文说明</summary>
>
> 为 round 1 R1-6 的重解析挂起问题新增的复杂度边界存在一条静默路径：`transformRichMarkdownTasks` 命中复杂度回退时没有 `onComplexityLimit` 钩子，而其姊妹函数 `sanitizeMarkdownDocument` 会通过 `policy.onComplexityLimit?.()` 上报——因此 `ExportBudget.text()` 无法记录 `truncated` 或 `markdown_complexity_exceeded` 诊断。`assertResourceBudgets` 会接受该回退结果（它能被干净地重新脱敏），导出文档在声称完整的同时静默丢失整个条目——违反了本模块自身的 degraded/complete 一致性不变量。注意两次解析之间标记数可能上升（每个被拒绝的 autolink（如 `<javascript:alert(1)>`）变成 `[link omitted]`，1 个标记变 2 个），因此 sanitize 后接近上限的围栏在 transform 阶段可能超限。
>
> 建议修复：为 `transformRichMarkdownTasks` 增加一个在 `!root` 分支调用的复杂度回调（或并入 policy 对象），并在 `ExportBudget.text()` 中接入，设置 `truncated` 并添加 `markdown_complexity_exceeded`，与 sanitize 路径保持一致。
>
> 修复见证：在 `markdown-document-policy.test.ts` 中，给 `transformRichMarkdownTasks` 输入 sanitize 后标记数超过上限的内容并断言复杂度回调被触发；移除该回调调用后测试必须变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 4. R2-1：文件附件被静默丢弃且 complete 仍为 true

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074067)
- 结论：值得修复
- 理由：成立。DaemonTextTranscriptBlock 明确定义 files，sanitizeBlock 仅处理 images；没有输出字段、诊断或 markContentLoss，违背文档完整性语义。
- 建议修复：本 MR 不扩展导出 schema，采用最小 fail-visible 修复：发现 files 时记录 file_attachment_excluded completeness diagnostic 并标记内容损失。
- 实施状态：已修复并验证
- 修复批次：F3
- 实施证据：sanitizeBlock 发现 files 时记录 file_attachment_excluded、标记内容损失；resource attachment 真实记录回归验证 complete=false/truncated=true。CLI 聚焦测试 46/46。

原始评论：

标注位置：`packages/cli/src/ui/utils/export/export-transcript-document.ts:439-441`（RIGHT（新增侧））

```diff
@@ -0,0 +1,2159 @@
+import {
+  DAEMON_ERROR_KINDS,
+  type DaemonErrorKind,
+  type DaemonPermissionTranscriptBlock,
+  type DaemonShellTranscriptBlock,
+  type DaemonStatusTranscriptBlock,
+  type DaemonTextTranscriptBlock,
+  type DaemonToolPreview,
+  type DaemonToolResultPreview,
+  type DaemonToolTranscriptBlock,
+  type DaemonTodoListPreview,
+  type DaemonTranscriptBlock,
+  type DaemonUiPermissionOption,
+  type DaemonUserShellTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { SchemaValidator } from '@qwen-code/qwen-code-core';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import type { ExportSessionData } from './types.js';
+import exportTranscriptDocumentV1Schema from './export-transcript-document-v1.schema.json' with { type: 'json' };
+import { escapeJsonForHtmlScriptData } from './html-script-data.js';
+import {
+  countRichMarkdownTasks,
+  sanitizeMarkdownDocument,
+  transformRichMarkdownTasks,
+} from './markdown-document-policy.js';
+
+export const EXPORT_TRANSCRIPT_LIMITS_V1 = Object.freeze({
+  maxBlocks: 1_000,
+  maxTextBytes: 400 * 1024,
+  maxVisibleTextBytes: 8 * 1024 * 1024,
+  maxRasterBytes: 8 * 1024 * 1024,
+  maxTotalRasterBytes: 16 * 1024 * 1024,
+  maxEnvelopeBytes: 32 * 1024 * 1024,
+  maxObjectDepth: 16,
+  maxObjectProperties: 1_000,
+  maxArrayLength: 1_000,
+  maxRichRenderTasks: 100,
+});
+
+export interface ExportTranscriptDiagnosticV1 {
+  readonly code: string;
+  readonly severity: 'info' | 'warning' | 'error';
+  readonly count: number;
+}
+
+export interface ExportMetadataPresentationV1 {
+  readonly title?: string;
+  readonly startedAt?: string;
+  readonly exportedAt: string;
+  readonly complete: boolean;
+  readonly truncated: boolean;
+  readonly projectName?: string;
+  readonly repository?: string;
+  readonly gitBranch?: string;
+  readonly model?: string;
+  readonly channel?: string;
+  readonly promptCount?: number;
+  readonly contextUsagePercent?: number;
+  readonly contextWindowSize?: number;
+  readonly totalTokens?: number;
+  readonly filesWritten?: number;
+  readonly linesAdded?: number;
+  readonly linesRemoved?: number;
+}
+
+type DaemonPromptCancelledTranscriptBlock = Extract<
+  DaemonTranscriptBlock,
+  { kind: 'prompt_cancelled' }
+>;
+
+type ExportBlockBaseKeys =
+  | 'id'
+  | 'kind'
+  | 'clientReceivedAt'
+  | 'createdAt'
+  | 'updatedAt';
+
+type ExportPermissionOptionV1 = Pick<
+  DaemonUiPermissionOption,
+  'optionId' | 'label' | 'description'
+> & { raw: null };
+
+interface ExportTranscriptQuestionOptionV1 {
+  label: string;
+  description?: string;
+  raw: null;
+}
+
+interface ExportTranscriptQuestionV1 {
+  header?: string;
+  question: string;
+  options: ExportTranscriptQuestionOptionV1[];
+  raw: null;
+}
+
+type ToolPreviewOf<K extends DaemonToolPreview['kind']> = Extract<
+  DaemonToolPreview,
+  { kind: K }
+>;
+type ToolPreviewPick<
+  K extends DaemonToolPreview['kind'],
+  P extends keyof ToolPreviewOf<K>,
+> = Pick<ToolPreviewOf<K>, 'kind' | P>;
+type ExportTodoListPreviewV1 = ToolPreviewPick<
+  'todo_list',
+  'entries' | 'truncated' | 'planId' | 'revision'
+>;
+type ExportToolPreviewV1 =
+  | { kind: 'ask_user_question'; questions: ExportTranscriptQuestionV1[] }
+  | ToolPreviewPick<'command', 'command' | 'cwd'>
+  | ToolPreviewPick<'file_diff', 'path' | 'oldText' | 'newText' | 'patch'>
+  | ToolPreviewPick<'file_read', 'path' | 'range'>
+  | ToolPreviewPick<'web_fetch', 'url' | 'method'>
+  | ToolPreviewPick<'mcp_invocation', 'serverId' | 'toolName' | 'argsSummary'>
+  | ToolPreviewPick<'code_block', 'language' | 'code' | 'origin'>
+  | ToolPreviewPick<'search', 'query' | 'resultCount' | 'top'>
+  | ToolPreviewPick<'tabular', 'columns' | 'rows' | 'totalRows'>
+  | ToolPreviewPick<'image_generation', 'prompt' | 'thumbnailUrl' | 'model'>
+  | ToolPreviewPick<
+      'subagent_delegation',
+      'agentName' | 'task' | 'parentDelegationId'
+    >
+  | ToolPreviewPick<'key_value', 'rows'>
+  | ExportTodoListPreviewV1
+  | ToolPreviewPick<'generic', 'summary'>;
+type ExportToolResultPreviewV1 =
+  | ExportTodoListPreviewV1
+  | { kind: 'text'; text: string }
+  | { kind: 'generic'; summary: string };
+
+export type ExportPermissionResolutionV1 =
+  | 'approved'
+  | 'rejected'
+  | 'cancelled'
+  | 'expired'
+  | 'resolved';
+
+type ExportTextTranscriptBlockBaseV1 = Pick<
+  DaemonTextTranscriptBlock,
+  | Exclude<ExportBlockBaseKeys, 'kind'>
+  | 'text'
+  | 'images'
+  | 'collapsed'
+  | 'parentToolCallId'
+> & { streaming?: false };
+type ExportTextTranscriptBlockV1 =
+  | (ExportTextTranscriptBlockBaseV1 & { kind: 'user' | 'thought' })
+  | (ExportTextTranscriptBlockBaseV1 & {
+      kind: 'assistant';
+      usage?: DaemonTextTranscriptBlock['usage'];
+    });
+type ExportToolTranscriptBlockV1 = Pick<
+  DaemonToolTranscriptBlock,
+  | ExportBlockBaseKeys
+  | 'toolCallId'
+  | 'title'
+  | 'toolName'
+  | 'toolKind'
+  | 'parentToolCallId'
+  | 'parentBlockId'
+  | 'subagentType'
+  | 'background'
+> & {
+  status: 'completed' | 'failed' | 'cancelled' | 'canceled';
+  preview: ExportToolPreviewV1;
+  resultPreview?: ExportToolResultPreviewV1;
+};
+type ExportShellTranscriptBlockV1 = Pick<
+  DaemonShellTranscriptBlock,
+  ExportBlockBaseKeys | 'text' | 'stream'
+>;
+type ExportUserShellTranscriptBlockV1 = Pick<
+  DaemonUserShellTranscriptBlock,
+  ExportBlockBaseKeys | 'text' | 'command' | 'cwd' | 'stream'
+>;
+type ExportPermissionTranscriptBlockV1 = Pick<
+  DaemonPermissionTranscriptBlock,
+  | ExportBlockBaseKeys
+  | 'requestId'
+  | 'title'
+  | 'toolCallId'
+  | 'toolName'
+  | 'toolKind'
+> & {
+  options: ExportPermissionOptionV1[];
+  preview: ExportToolPreviewV1;
+  resolved?: ExportPermissionResolutionV1;
+};
+type ExportStatusTranscriptBlockV1 = Pick<
+  DaemonStatusTranscriptBlock,
+  | Exclude<ExportBlockBaseKeys, 'kind'>
+  | 'text'
+  | 'code'
+  | 'errorKind'
+  | 'source'
+> & {
+  kind: 'status' | 'error';
+};
+type ExportPromptCancelledTranscriptBlockV1 = Pick<
+  DaemonPromptCancelledTranscriptBlock,
+  ExportBlockBaseKeys | 'reason'
+>;
+
+export type ExportTranscriptBlockV1 =
+  | ExportTextTranscriptBlockV1
+  | ExportToolTranscriptBlockV1
+  | ExportShellTranscriptBlockV1
+  | ExportUserShellTranscriptBlockV1
+  | ExportPermissionTranscriptBlockV1
+  | ExportStatusTranscriptBlockV1
+  | ExportPromptCancelledTranscriptBlockV1;
+
+export interface ExportTranscriptDocumentV1 {
+  readonly schemaVersion: 1;
+  readonly rendererVersion: string;
+  readonly blocks: readonly ExportTranscriptBlockV1[];
+  readonly diagnostics: readonly ExportTranscriptDiagnosticV1[];
+  readonly metadata: ExportMetadataPresentationV1;
+}
+
+export interface CreateExportTranscriptDocumentOptions {
+  readonly rendererVersion: string;
+  readonly exportedAt: string;
+  readonly title?: string;
+}
+
+export class ExportTranscriptDocumentError extends Error {
+  constructor(readonly code: string) {
+    super(`Cannot create export transcript document: ${code}.`);
+    this.name = 'ExportTranscriptDocumentError';
+  }
+}
+
+export function createExportTranscriptDocumentV1(
+  records: readonly unknown[],
+  sessionData: Pick<ExportSessionData, 'startTime' | 'metadata'>,
+  options: CreateExportTranscriptDocumentOptions,
+): ExportTranscriptDocumentV1 {
+  if (!isSafeRendererVersion(options.rendererVersion)) {
+    throw new ExportTranscriptDocumentError('invalid_renderer_version');
+  }
+  if (!isIsoDate(options.exportedAt)) {
+    throw new ExportTranscriptDocumentError('invalid_exported_at');
+  }
+
+  const diagnostics = new DiagnosticCounter();
+  const policy = applyRecordExportPolicy(records, diagnostics);
+  const projection = projectChatRecordsToDaemonTranscript(policy.records, {
+    maxBlocks: EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
+  });
+  for (const item of projection.diagnostics) {
+    diagnostics.add(item.code, item.severity, 1, item.affectsCompleteness);
+  }
+  const budget = new ExportBudget(diagnostics);
+  const ids = new OpaqueDocumentIds();
+  const visibleBlocks = projection.blocks.filter((block) => {
+    const sourceRecordIds = block.sourceRecordIds ?? [];
+    return (
+      sourceRecordIds.length === 0 ||
+      sourceRecordIds.some((recordId) => policy.visibleRecordIds.has(recordId))
+    );
+  });
+  const blocks: ExportTranscriptBlockV1[] = [];
+  for (const block of visibleBlocks) {
+    const checkpoint = budget.checkpoint();
+    const safe = sanitizeBlock(block, budget, ids, diagnostics);
+    if (budget.cumulativeTextBudgetExceeded) {
+      budget.restore(checkpoint);
+      break;
+    }
+    if (safe) blocks.push(safe);
+  }
+  const initialTruncated = projection.truncated || budget.truncated;
+  const metadataPresentation = createMetadataPresentation(
+    sessionData,
+    options,
+    diagnostics,
+    budget,
+  );
+  const truncated = initialTruncated || budget.truncated;
+  const degraded =
+    !policy.complete ||
+    !projection.complete ||
+    budget.truncated ||
+    diagnostics.hasErrors ||
+    diagnostics.hasCompletenessLoss;
+  const metadata = {
+    ...metadataPresentation,
+    complete: !degraded,
+    truncated,
+  };
+  let document: ExportTranscriptDocumentV1 = {
+    schemaVersion: 1,
+    rendererVersion: options.rendererVersion,
+    blocks,
+    diagnostics: diagnostics.toArray(),
+    metadata,
+  };
+  document = fitDocumentToEnvelope(document, diagnostics);
+  assertExportTranscriptDocumentV1(document);
+  return document;
+}
+
+function fitDocumentToEnvelope(
+  document: ExportTranscriptDocumentV1,
+  diagnostics: DiagnosticCounter,
+): ExportTranscriptDocumentV1 {
+  if (
+    serializedEnvelopeBytes(document) <=
+    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+  ) {
+    return document;
+  }
+  diagnostics.add('envelope_budget_exceeded', 'warning', 1, true);
+  const buildCandidate = (blockCount: number): ExportTranscriptDocumentV1 => ({
+    ...document,
+    blocks: document.blocks.slice(0, blockCount),
+    diagnostics: diagnostics.toArray(),
+    metadata: { ...document.metadata, complete: false, truncated: true },
+  });
+  let low = 0;
+  let high = document.blocks.length;
+  while (low < high) {
+    const middle = Math.ceil((low + high) / 2);
+    if (
+      serializedEnvelopeBytes(buildCandidate(middle)) <=
+      EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+    ) {
+      low = middle;
+    } else {
+      high = middle - 1;
+    }
+  }
+  const fitted = buildCandidate(low);
+  if (
+    serializedEnvelopeBytes(fitted) >
+    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+  ) {
+    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
+  }
+  return fitted;
+}
+
+export function assertExportTranscriptDocumentV1(
+  value: unknown,
+): asserts value is ExportTranscriptDocumentV1 {
+  assertDepthAndArrayBudgets(value);
+  const bytes = serializedEnvelopeBytes(value);
+  if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
+    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
+  }
+  const schemaError = SchemaValidator.validateStrict(
+    exportTranscriptDocumentV1Schema,
+    value,
+  );
+  if (schemaError) {
+    throw new ExportTranscriptDocumentError('schema_validation_failed');
+  }
+  if (!isRecord(value)) {
+    throw new ExportTranscriptDocumentError('schema_validation_failed');
+  }
+  assertSemanticSafety(value);
+  assertDocumentConsistency(value);
+  assertNoForbiddenFields(value);
+  assertResourceBudgets(value);
+}
+
+function applyRecordExportPolicy(
+  records: readonly unknown[],
+  diagnostics: DiagnosticCounter,
+): {
+  records: unknown[];
+  visibleRecordIds: ReadonlySet<string>;
+  complete: boolean;
+} {
+  const projectionRecords: unknown[] = [];
+  const visibleRecordIds = new Set<string>();
+  let complete = true;
+  for (const record of records) {
+    if (!isRecord(record)) {
+      diagnostics.add('record_invalid', 'error');
+      complete = false;
+      continue;
+    }
+    const type = record['type'];
+    const subtype = record['subtype'];
+    const acceptedSystemSubtype =
+      type === 'system' &&
+      typeof subtype === 'string' &&
+      VISIBLE_SYSTEM_RECORD_SUBTYPES.has(subtype);
+    const visible =
+      type === 'user' ||
+      type === 'assistant' ||
+      type === 'tool_result' ||
+      acceptedSystemSubtype;
+    if (visible || type === 'system') {
+      projectionRecords.push(record);
+      const uuid = record['uuid'];
+      if (visible && typeof uuid === 'string') visibleRecordIds.add(uuid);
+      if (type === 'system' && !acceptedSystemSubtype) {
+        diagnostics.add('record_internal_excluded', 'info');
+      }
+      continue;
+    }
+    diagnostics.add('record_unknown_excluded', 'error');
+    complete = false;
+  }
+  return { records: projectionRecords, visibleRecordIds, complete };
+}
+
+const VISIBLE_SYSTEM_RECORD_SUBTYPES = new Set([
+  'slash_command',
+  'notification',
+  'cron',
+  'mid_turn_user_message',
+  'realtime_message',
+  'goal_state',
+  'goal_runtime',
+]);
+
+function sanitizeBlock(
+  block: DaemonTranscriptBlock,
+  budget: ExportBudget,
+  ids: OpaqueDocumentIds,
+  diagnostics: DiagnosticCounter,
+): ExportTranscriptBlockV1 | undefined {
+  const common = {
+    id: ids.get('block', block.id),
+    kind: block.kind,
+    clientReceivedAt: 0,
+    createdAt: 0,
+    updatedAt: 0,
+  };
+  switch (block.kind) {
+    case 'user':
+    case 'assistant':
+    case 'thought': {
+      const text = budget.text(block.text);
+      const images = block.images
+        ? budget.array(block.images).flatMap((image) => {
+            const safe = budget.image(image);
```

> **[Critical]** R2-1: The user/assistant/thought branch of `sanitizeBlock` exports `images` but silently drops `block.files` (file attachments) — no schema field, no diagnostic, no `markContentLoss()` — so the V1 document loses user-visible attachment content while `metadata.complete` stays `true`, violating the pipeline's own invariant that every content loss surfaces via a diagnostic and/or the completeness flag. Every comparable loss in this module is tracked (`image_type_rejected`, `tool_result_presentation_missing` + `markContentLoss`, `record_internal_excluded`, `debug_block_excluded`); image-type attachment references even degrade to a visible '[Attachment is no longer available]' placeholder — file attachments alone vanish without a word.
>
> Witness — probe at this head (real pipeline): a user record whose projection-level block carries `files:[{name,mimeType,attachmentId}]` exports as `{"kind":"user","text":"please review the log","streaming":false}` with `fileTracePresentAnywhere:false`, `complete:true`, `diagnostics:[]`; an image reference on the same path degrades to visible placeholder text.
>
> Suggested fix: in this branch add a tracked loss when attachments exist (`diagnostics.add('file_attachment_excluded', 'warning', block.files.length, true); budget.markContentLoss();`), or extend `ExportTextTranscriptBlockBaseV1` and the schema with a sanitized `files` array (budget.label-bounded name/attachmentId + mimeType) mirroring the `images` handling.
>
> Fix witness: add a case feeding a user record whose `systemPayload.attachmentReferences` holds one `resource` entry and assert the exported block either carries the attachment or `metadata.complete === false` with the content-loss diagnostic; removing the added branch must make it red.
>
> <details>
> <summary>中文说明</summary>
>
> `sanitizeBlock` 的 user/assistant/thought 分支会导出 `images` 却静默丢弃 `block.files`（文件附件）——没有 schema 字段、没有诊断、没有 `markContentLoss()`——因此 V1 文档丢失用户可见的附件内容而 `metadata.complete` 仍为 `true`，违反了本管线自身“任何内容损失都必须通过诊断和/或完整性标志体现”的不变量。本模块中所有可比的损失都有跟踪（`image_type_rejected`、`tool_result_presentation_missing` + `markContentLoss`、`record_internal_excluded`、`debug_block_excluded`）；图片型附件引用甚至会退化为可见的 '[Attachment is no longer available]' 占位符——唯独文件附件无声消失。
>
> 建议修复：在该分支中，当存在附件时添加受跟踪的损失（`diagnostics.add('file_attachment_excluded', 'warning', block.files.length, true); budget.markContentLoss();`），或者为 `ExportTextTranscriptBlockBaseV1` 与 schema 增加脱敏后的 `files` 数组（经 budget.label 限制的 name/attachmentId + mimeType），参照 `images` 的处理方式。
>
> 修复见证：新增用例，输入 `systemPayload.attachmentReferences` 含一个 `resource` 条目的 user 记录，断言导出块要么携带附件、要么 `metadata.complete === false` 且带内容损失诊断；移除新增分支后测试必须变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 5. R2-2：脱敏增字符串后突破 label/schema 长度上限

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074072)
- 结论：值得修复
- 理由：成立。label 先 safeLabel 再 redact；safeMetadataLabel 先校验长度再调用 plainText。`file:/home/a` 脱敏为更长的 `file://[home]` 后可能超过 schema maxLength 并中止整个导出。
- 建议修复：统一为先脱敏再限长，并在脱敏/截断任一步发生变化时记录 label_sanitized；metadata 同样在脱敏后执行长度验证。
- 实施状态：已修复并验证
- 修复批次：F4
- 实施证据：ExportBudget.label 在 home 脱敏后再次限长，safeMetadataLabel 统一走该路径；200 字符 metadata.model 不再抛错且正确标记截断。CLI 聚焦测试 46/46。

原始评论：

标注位置：`packages/cli/src/ui/utils/export/export-transcript-document.ts:967-969`（RIGHT（新增侧））

```diff
@@ -0,0 +1,2159 @@
+import {
+  DAEMON_ERROR_KINDS,
+  type DaemonErrorKind,
+  type DaemonPermissionTranscriptBlock,
+  type DaemonShellTranscriptBlock,
+  type DaemonStatusTranscriptBlock,
+  type DaemonTextTranscriptBlock,
+  type DaemonToolPreview,
+  type DaemonToolResultPreview,
+  type DaemonToolTranscriptBlock,
+  type DaemonTodoListPreview,
+  type DaemonTranscriptBlock,
+  type DaemonUiPermissionOption,
+  type DaemonUserShellTranscriptBlock,
+} from '@qwen-code/sdk/daemon';
+import { SchemaValidator } from '@qwen-code/qwen-code-core';
+import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
+import type { ExportSessionData } from './types.js';
+import exportTranscriptDocumentV1Schema from './export-transcript-document-v1.schema.json' with { type: 'json' };
+import { escapeJsonForHtmlScriptData } from './html-script-data.js';
+import {
+  countRichMarkdownTasks,
+  sanitizeMarkdownDocument,
+  transformRichMarkdownTasks,
+} from './markdown-document-policy.js';
+
+export const EXPORT_TRANSCRIPT_LIMITS_V1 = Object.freeze({
+  maxBlocks: 1_000,
+  maxTextBytes: 400 * 1024,
+  maxVisibleTextBytes: 8 * 1024 * 1024,
+  maxRasterBytes: 8 * 1024 * 1024,
+  maxTotalRasterBytes: 16 * 1024 * 1024,
+  maxEnvelopeBytes: 32 * 1024 * 1024,
+  maxObjectDepth: 16,
+  maxObjectProperties: 1_000,
+  maxArrayLength: 1_000,
+  maxRichRenderTasks: 100,
+});
+
+export interface ExportTranscriptDiagnosticV1 {
+  readonly code: string;
+  readonly severity: 'info' | 'warning' | 'error';
+  readonly count: number;
+}
+
+export interface ExportMetadataPresentationV1 {
+  readonly title?: string;
+  readonly startedAt?: string;
+  readonly exportedAt: string;
+  readonly complete: boolean;
+  readonly truncated: boolean;
+  readonly projectName?: string;
+  readonly repository?: string;
+  readonly gitBranch?: string;
+  readonly model?: string;
+  readonly channel?: string;
+  readonly promptCount?: number;
+  readonly contextUsagePercent?: number;
+  readonly contextWindowSize?: number;
+  readonly totalTokens?: number;
+  readonly filesWritten?: number;
+  readonly linesAdded?: number;
+  readonly linesRemoved?: number;
+}
+
+type DaemonPromptCancelledTranscriptBlock = Extract<
+  DaemonTranscriptBlock,
+  { kind: 'prompt_cancelled' }
+>;
+
+type ExportBlockBaseKeys =
+  | 'id'
+  | 'kind'
+  | 'clientReceivedAt'
+  | 'createdAt'
+  | 'updatedAt';
+
+type ExportPermissionOptionV1 = Pick<
+  DaemonUiPermissionOption,
+  'optionId' | 'label' | 'description'
+> & { raw: null };
+
+interface ExportTranscriptQuestionOptionV1 {
+  label: string;
+  description?: string;
+  raw: null;
+}
+
+interface ExportTranscriptQuestionV1 {
+  header?: string;
+  question: string;
+  options: ExportTranscriptQuestionOptionV1[];
+  raw: null;
+}
+
+type ToolPreviewOf<K extends DaemonToolPreview['kind']> = Extract<
+  DaemonToolPreview,
+  { kind: K }
+>;
+type ToolPreviewPick<
+  K extends DaemonToolPreview['kind'],
+  P extends keyof ToolPreviewOf<K>,
+> = Pick<ToolPreviewOf<K>, 'kind' | P>;
+type ExportTodoListPreviewV1 = ToolPreviewPick<
+  'todo_list',
+  'entries' | 'truncated' | 'planId' | 'revision'
+>;
+type ExportToolPreviewV1 =
+  | { kind: 'ask_user_question'; questions: ExportTranscriptQuestionV1[] }
+  | ToolPreviewPick<'command', 'command' | 'cwd'>
+  | ToolPreviewPick<'file_diff', 'path' | 'oldText' | 'newText' | 'patch'>
+  | ToolPreviewPick<'file_read', 'path' | 'range'>
+  | ToolPreviewPick<'web_fetch', 'url' | 'method'>
+  | ToolPreviewPick<'mcp_invocation', 'serverId' | 'toolName' | 'argsSummary'>
+  | ToolPreviewPick<'code_block', 'language' | 'code' | 'origin'>
+  | ToolPreviewPick<'search', 'query' | 'resultCount' | 'top'>
+  | ToolPreviewPick<'tabular', 'columns' | 'rows' | 'totalRows'>
+  | ToolPreviewPick<'image_generation', 'prompt' | 'thumbnailUrl' | 'model'>
+  | ToolPreviewPick<
+      'subagent_delegation',
+      'agentName' | 'task' | 'parentDelegationId'
+    >
+  | ToolPreviewPick<'key_value', 'rows'>
+  | ExportTodoListPreviewV1
+  | ToolPreviewPick<'generic', 'summary'>;
+type ExportToolResultPreviewV1 =
+  | ExportTodoListPreviewV1
+  | { kind: 'text'; text: string }
+  | { kind: 'generic'; summary: string };
+
+export type ExportPermissionResolutionV1 =
+  | 'approved'
+  | 'rejected'
+  | 'cancelled'
+  | 'expired'
+  | 'resolved';
+
+type ExportTextTranscriptBlockBaseV1 = Pick<
+  DaemonTextTranscriptBlock,
+  | Exclude<ExportBlockBaseKeys, 'kind'>
+  | 'text'
+  | 'images'
+  | 'collapsed'
+  | 'parentToolCallId'
+> & { streaming?: false };
+type ExportTextTranscriptBlockV1 =
+  | (ExportTextTranscriptBlockBaseV1 & { kind: 'user' | 'thought' })
+  | (ExportTextTranscriptBlockBaseV1 & {
+      kind: 'assistant';
+      usage?: DaemonTextTranscriptBlock['usage'];
+    });
+type ExportToolTranscriptBlockV1 = Pick<
+  DaemonToolTranscriptBlock,
+  | ExportBlockBaseKeys
+  | 'toolCallId'
+  | 'title'
+  | 'toolName'
+  | 'toolKind'
+  | 'parentToolCallId'
+  | 'parentBlockId'
+  | 'subagentType'
+  | 'background'
+> & {
+  status: 'completed' | 'failed' | 'cancelled' | 'canceled';
+  preview: ExportToolPreviewV1;
+  resultPreview?: ExportToolResultPreviewV1;
+};
+type ExportShellTranscriptBlockV1 = Pick<
+  DaemonShellTranscriptBlock,
+  ExportBlockBaseKeys | 'text' | 'stream'
+>;
+type ExportUserShellTranscriptBlockV1 = Pick<
+  DaemonUserShellTranscriptBlock,
+  ExportBlockBaseKeys | 'text' | 'command' | 'cwd' | 'stream'
+>;
+type ExportPermissionTranscriptBlockV1 = Pick<
+  DaemonPermissionTranscriptBlock,
+  | ExportBlockBaseKeys
+  | 'requestId'
+  | 'title'
+  | 'toolCallId'
+  | 'toolName'
+  | 'toolKind'
+> & {
+  options: ExportPermissionOptionV1[];
+  preview: ExportToolPreviewV1;
+  resolved?: ExportPermissionResolutionV1;
+};
+type ExportStatusTranscriptBlockV1 = Pick<
+  DaemonStatusTranscriptBlock,
+  | Exclude<ExportBlockBaseKeys, 'kind'>
+  | 'text'
+  | 'code'
+  | 'errorKind'
+  | 'source'
+> & {
+  kind: 'status' | 'error';
+};
+type ExportPromptCancelledTranscriptBlockV1 = Pick<
+  DaemonPromptCancelledTranscriptBlock,
+  ExportBlockBaseKeys | 'reason'
+>;
+
+export type ExportTranscriptBlockV1 =
+  | ExportTextTranscriptBlockV1
+  | ExportToolTranscriptBlockV1
+  | ExportShellTranscriptBlockV1
+  | ExportUserShellTranscriptBlockV1
+  | ExportPermissionTranscriptBlockV1
+  | ExportStatusTranscriptBlockV1
+  | ExportPromptCancelledTranscriptBlockV1;
+
+export interface ExportTranscriptDocumentV1 {
+  readonly schemaVersion: 1;
+  readonly rendererVersion: string;
+  readonly blocks: readonly ExportTranscriptBlockV1[];
+  readonly diagnostics: readonly ExportTranscriptDiagnosticV1[];
+  readonly metadata: ExportMetadataPresentationV1;
+}
+
+export interface CreateExportTranscriptDocumentOptions {
+  readonly rendererVersion: string;
+  readonly exportedAt: string;
+  readonly title?: string;
+}
+
+export class ExportTranscriptDocumentError extends Error {
+  constructor(readonly code: string) {
+    super(`Cannot create export transcript document: ${code}.`);
+    this.name = 'ExportTranscriptDocumentError';
+  }
+}
+
+export function createExportTranscriptDocumentV1(
+  records: readonly unknown[],
+  sessionData: Pick<ExportSessionData, 'startTime' | 'metadata'>,
+  options: CreateExportTranscriptDocumentOptions,
+): ExportTranscriptDocumentV1 {
+  if (!isSafeRendererVersion(options.rendererVersion)) {
+    throw new ExportTranscriptDocumentError('invalid_renderer_version');
+  }
+  if (!isIsoDate(options.exportedAt)) {
+    throw new ExportTranscriptDocumentError('invalid_exported_at');
+  }
+
+  const diagnostics = new DiagnosticCounter();
+  const policy = applyRecordExportPolicy(records, diagnostics);
+  const projection = projectChatRecordsToDaemonTranscript(policy.records, {
+    maxBlocks: EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
+  });
+  for (const item of projection.diagnostics) {
+    diagnostics.add(item.code, item.severity, 1, item.affectsCompleteness);
+  }
+  const budget = new ExportBudget(diagnostics);
+  const ids = new OpaqueDocumentIds();
+  const visibleBlocks = projection.blocks.filter((block) => {
+    const sourceRecordIds = block.sourceRecordIds ?? [];
+    return (
+      sourceRecordIds.length === 0 ||
+      sourceRecordIds.some((recordId) => policy.visibleRecordIds.has(recordId))
+    );
+  });
+  const blocks: ExportTranscriptBlockV1[] = [];
+  for (const block of visibleBlocks) {
+    const checkpoint = budget.checkpoint();
+    const safe = sanitizeBlock(block, budget, ids, diagnostics);
+    if (budget.cumulativeTextBudgetExceeded) {
+      budget.restore(checkpoint);
+      break;
+    }
+    if (safe) blocks.push(safe);
+  }
+  const initialTruncated = projection.truncated || budget.truncated;
+  const metadataPresentation = createMetadataPresentation(
+    sessionData,
+    options,
+    diagnostics,
+    budget,
+  );
+  const truncated = initialTruncated || budget.truncated;
+  const degraded =
+    !policy.complete ||
+    !projection.complete ||
+    budget.truncated ||
+    diagnostics.hasErrors ||
+    diagnostics.hasCompletenessLoss;
+  const metadata = {
+    ...metadataPresentation,
+    complete: !degraded,
+    truncated,
+  };
+  let document: ExportTranscriptDocumentV1 = {
+    schemaVersion: 1,
+    rendererVersion: options.rendererVersion,
+    blocks,
+    diagnostics: diagnostics.toArray(),
+    metadata,
+  };
+  document = fitDocumentToEnvelope(document, diagnostics);
+  assertExportTranscriptDocumentV1(document);
+  return document;
+}
+
+function fitDocumentToEnvelope(
+  document: ExportTranscriptDocumentV1,
+  diagnostics: DiagnosticCounter,
+): ExportTranscriptDocumentV1 {
+  if (
+    serializedEnvelopeBytes(document) <=
+    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+  ) {
+    return document;
+  }
+  diagnostics.add('envelope_budget_exceeded', 'warning', 1, true);
+  const buildCandidate = (blockCount: number): ExportTranscriptDocumentV1 => ({
+    ...document,
+    blocks: document.blocks.slice(0, blockCount),
+    diagnostics: diagnostics.toArray(),
+    metadata: { ...document.metadata, complete: false, truncated: true },
+  });
+  let low = 0;
+  let high = document.blocks.length;
+  while (low < high) {
+    const middle = Math.ceil((low + high) / 2);
+    if (
+      serializedEnvelopeBytes(buildCandidate(middle)) <=
+      EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+    ) {
+      low = middle;
+    } else {
+      high = middle - 1;
+    }
+  }
+  const fitted = buildCandidate(low);
+  if (
+    serializedEnvelopeBytes(fitted) >
+    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
+  ) {
+    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
+  }
+  return fitted;
+}
+
+export function assertExportTranscriptDocumentV1(
+  value: unknown,
+): asserts value is ExportTranscriptDocumentV1 {
+  assertDepthAndArrayBudgets(value);
+  const bytes = serializedEnvelopeBytes(value);
+  if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
+    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
+  }
+  const schemaError = SchemaValidator.validateStrict(
+    exportTranscriptDocumentV1Schema,
+    value,
+  );
+  if (schemaError) {
+    throw new ExportTranscriptDocumentError('schema_validation_failed');
+  }
+  if (!isRecord(value)) {
+    throw new ExportTranscriptDocumentError('schema_validation_failed');
+  }
+  assertSemanticSafety(value);
+  assertDocumentConsistency(value);
+  assertNoForbiddenFields(value);
+  assertResourceBudgets(value);
+}
+
+function applyRecordExportPolicy(
+  records: readonly unknown[],
+  diagnostics: DiagnosticCounter,
+): {
+  records: unknown[];
+  visibleRecordIds: ReadonlySet<string>;
+  complete: boolean;
+} {
+  const projectionRecords: unknown[] = [];
+  const visibleRecordIds = new Set<string>();
+  let complete = true;
+  for (const record of records) {
+    if (!isRecord(record)) {
+      diagnostics.add('record_invalid', 'error');
+      complete = false;
+      continue;
+    }
+    const type = record['type'];
+    const subtype = record['subtype'];
+    const acceptedSystemSubtype =
+      type === 'system' &&
+      typeof subtype === 'string' &&
+      VISIBLE_SYSTEM_RECORD_SUBTYPES.has(subtype);
+    const visible =
+      type === 'user' ||
+      type === 'assistant' ||
+      type === 'tool_result' ||
+      acceptedSystemSubtype;
+    if (visible || type === 'system') {
+      projectionRecords.push(record);
+      const uuid = record['uuid'];
+      if (visible && typeof uuid === 'string') visibleRecordIds.add(uuid);
+      if (type === 'system' && !acceptedSystemSubtype) {
+        diagnostics.add('record_internal_excluded', 'info');
+      }
+      continue;
+    }
+    diagnostics.add('record_unknown_excluded', 'error');
+    complete = false;
+  }
+  return { records: projectionRecords, visibleRecordIds, complete };
+}
+
+const VISIBLE_SYSTEM_RECORD_SUBTYPES = new Set([
+  'slash_command',
+  'notification',
+  'cron',
+  'mid_turn_user_message',
+  'realtime_message',
+  'goal_state',
+  'goal_runtime',
+]);
+
+function sanitizeBlock(
+  block: DaemonTranscriptBlock,
+  budget: ExportBudget,
+  ids: OpaqueDocumentIds,
+  diagnostics: DiagnosticCounter,
+): ExportTranscriptBlockV1 | undefined {
+  const common = {
+    id: ids.get('block', block.id),
+    kind: block.kind,
+    clientReceivedAt: 0,
+    createdAt: 0,
+    updatedAt: 0,
+  };
+  switch (block.kind) {
+    case 'user':
+    case 'assistant':
+    case 'thought': {
+      const text = budget.text(block.text);
+      const images = block.images
+        ? budget.array(block.images).flatMap((image) => {
+            const safe = budget.image(image);
+            return safe ? [safe] : [];
+          })
+        : undefined;
+      return {
+        ...common,
+        kind: block.kind,
+        text,
+        streaming: false,
+        ...(block.collapsed ? { collapsed: true } : {}),
+        ...(block.parentToolCallId
+          ? {
+              parentToolCallId: ids.get('tool-call', block.parentToolCallId),
+            }
+          : {}),
+        ...(images && images.length > 0 ? { images } : {}),
+        ...(block.kind === 'assistant' && block.usage
+          ? {
+              usage: {
+                inputTokens: safeCount(block.usage.inputTokens),
+                outputTokens: safeCount(block.usage.outputTokens),
+                ...(block.usage.cachedTokens !== undefined
+                  ? { cachedTokens: safeCount(block.usage.cachedTokens) }
+                  : {}),
+              },
+            }
+          : {}),
+      };
+    }
+    case 'tool': {
+      const status = terminalToolStatus(block.status, diagnostics, budget);
+      const toolName = budget.optionalLabel(block.toolName, 128);
+      const toolKind = budget.optionalLabel(block.toolKind, 128);
+      const subagentType = budget.optionalLabel(block.subagentType, 128);
+      let resultPreview = block.resultPreview
+        ? sanitizeResultPreview(block.resultPreview, budget, diagnostics, ids)
+        : undefined;
+      if (
+        !resultPreview &&
+        block.preview.kind === 'file_diff' &&
+        status === 'completed'
+      ) {
+        resultPreview = {
+          kind: 'text',
+          text: budget.plainText('File change applied'),
+        };
+      }
+      if (!resultPreview && (status === 'completed' || status === 'failed')) {
+        diagnostics.add('tool_result_presentation_missing', 'error');
+        budget.markContentLoss();
+        resultPreview = {
+          kind: 'text',
+          text: budget.plainText('[tool result omitted from export]'),
+        };
+      }
+      return {
+        ...common,
+        kind: 'tool',
+        toolCallId: ids.get('tool-call', block.toolCallId),
+        title: budget.plainText(block.title),
+        status,
+        ...(block.background ? { background: true } : {}),
+        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
+        ...(resultPreview ? { resultPreview } : {}),
+        ...(toolName ? { toolName } : {}),
+        ...(toolKind ? { toolKind } : {}),
+        ...(block.parentToolCallId
+          ? {
+              parentToolCallId: ids.get('tool-call', block.parentToolCallId),
+            }
+          : {}),
+        ...(block.parentBlockId
+          ? { parentBlockId: ids.get('block', block.parentBlockId) }
+          : {}),
+        ...(subagentType ? { subagentType } : {}),
+      };
+    }
+    case 'shell':
+      return {
+        ...common,
+        kind: 'shell',
+        text: budget.plainText(block.text),
+        ...(block.stream ? { stream: block.stream } : {}),
+      };
+    case 'user_shell':
+      return {
+        ...common,
+        kind: 'user_shell',
+        text: budget.plainText(block.text),
+        command: budget.plainText(block.command),
+        ...(block.cwd
+          ? { cwd: budget.label(safePath(block.cwd), 400, false) }
+          : {}),
+        ...(block.stream ? { stream: block.stream } : {}),
+      };
+    case 'permission': {
+      const toolName = budget.optionalLabel(block.toolName, 128);
+      const toolKind = budget.optionalLabel(block.toolKind, 128);
+      const resolution = block.resolved
+        ? classifyPermissionResolutionForExport(block.resolved, block.options)
+        : undefined;
+      if (resolution?.lossy) {
+        diagnostics.add('permission_resolution_sanitized', 'warning', 1, true);
+        budget.markContentLoss();
+      }
+      return {
+        ...common,
+        kind: 'permission',
+        requestId: ids.get('permission', block.requestId),
+        title: budget.plainText(block.title),
+        options: budget.array(block.options).map((option) => ({
+          optionId: ids.get('permission-option', option.optionId),
+          label: budget.plainText(option.label),
+          ...(option.description
+            ? { description: budget.plainText(option.description) }
+            : {}),
+          raw: null,
+        })),
+        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
+        ...(block.toolCallId
+          ? { toolCallId: ids.get('tool-call', block.toolCallId) }
+          : {}),
+        ...(toolName ? { toolName } : {}),
+        ...(toolKind ? { toolKind } : {}),
+        ...(resolution ? { resolved: resolution.value } : {}),
+      };
+    }
+    case 'status':
+    case 'error': {
+      const code = budget.optionalLabel(block.code, 128);
+      const errorKind = safeExportErrorKind(block.errorKind);
+      const source = budget.optionalLabel(block.source, 128);
+      return {
+        ...common,
+        kind: block.kind,
+        text: budget.text(block.text),
+        ...(code ? { code } : {}),
+        ...(errorKind ? { errorKind } : {}),
+        ...(source ? { source } : {}),
+      };
+    }
+    case 'prompt_cancelled':
+      return {
+        ...common,
+        kind: 'prompt_cancelled',
+        ...(block.reason ? { reason: budget.plainText(block.reason) } : {}),
+      };
+    case 'debug':
+      diagnostics.add('debug_block_excluded', 'info');
+      return undefined;
+    default:
+      return assertNever(block);
+  }
+}
+
+function sanitizeToolPreview(
+  preview: DaemonToolPreview,
+  budget: ExportBudget,
+  diagnostics: DiagnosticCounter,
+  ids: OpaqueDocumentIds,
+): ExportToolPreviewV1 {
+  switch (preview.kind) {
+    case 'ask_user_question':
+      return {
+        kind: preview.kind,
+        questions: budget.array(preview.questions).map((question) => {
+          const header = budget.optionalLabel(question.header, 200);
+          return {
+            ...(header ? { header } : {}),
+            question: budget.plainText(question.question),
+            options: budget.array(question.options).map((option) => ({
+              label: budget.plainText(option.label),
+              ...(option.description
+                ? { description: budget.plainText(option.description) }
+                : {}),
+              raw: null,
+            })),
+            raw: null,
+          };
+        }),
+      };
+    case 'command':
+      return {
+        kind: preview.kind,
+        command: budget.plainText(preview.command),
+        ...(preview.cwd
+          ? { cwd: budget.label(safePath(preview.cwd), 400, false) }
+          : {}),
+      };
+    case 'file_diff':
+      return {
+        kind: preview.kind,
+        path: budget.label(safePath(preview.path), 400, false),
+        ...(preview.oldText !== undefined
+          ? { oldText: budget.plainText(preview.oldText) }
+          : {}),
+        ...(preview.newText !== undefined
+          ? { newText: budget.plainText(preview.newText) }
+          : {}),
+        ...(preview.patch !== undefined
+          ? { patch: budget.plainText(preview.patch) }
+          : {}),
+      };
+    case 'file_read': {
+      const range = preview.range
+        ? ([safeCount(preview.range[0]), safeCount(preview.range[1])] as [
+            number,
+            number,
+          ])
+        : undefined;
+      return {
+        kind: preview.kind,
+        path: budget.label(safePath(preview.path), 400, false),
+        ...(range ? { range } : {}),
+      };
+    }
+    case 'web_fetch': {
+      const method = budget.optionalLabel(preview.method, 16);
+      return {
+        kind: preview.kind,
+        url: budget.plainText(
+          safeDisplayUrl(preview.url, diagnostics, () =>
+            budget.markContentLoss(),
+          ),
+        ),
+        ...(method ? { method } : {}),
+      };
+    }
+    case 'mcp_invocation':
+      return {
+        kind: preview.kind,
+        serverId: budget.label(preview.serverId, 128),
+        toolName: budget.label(preview.toolName, 128),
+        ...(preview.argsSummary
+          ? { argsSummary: budget.plainText(preview.argsSummary) }
+          : {}),
+      };
+    case 'code_block': {
+      const language = budget.optionalLabel(preview.language, 64);
+      const origin = preview.origin
+        ? budget.optionalLabel(safePath(preview.origin), 400, false)
+        : undefined;
+      return {
+        kind: preview.kind,
+        code: budget.plainText(preview.code),
+        ...(language ? { language } : {}),
+        ...(origin ? { origin } : {}),
+      };
+    }
+    case 'search':
+      return {
+        kind: preview.kind,
+        query: budget.plainText(preview.query),
+        ...(preview.resultCount !== undefined
+          ? { resultCount: safeCount(preview.resultCount) }
+          : {}),
+        ...(preview.top
+          ? {
+              top: budget
+                .array(preview.top)
+                .map((item) => budget.plainText(item)),
+            }
+          : {}),
+      };
+    case 'tabular':
+      return {
+        kind: preview.kind,
+        columns: budget
+          .array(preview.columns)
+          .map((item) => budget.plainText(item)),
+        rows: budget
+          .array(preview.rows)
+          .map((row) =>
+            budget.array(row).map((item) => budget.plainText(item)),
+          ),
+        ...(preview.totalRows !== undefined
+          ? { totalRows: safeCount(preview.totalRows) }
+          : {}),
+      };
+    case 'image_generation': {
+      const model = budget.optionalLabel(preview.model, 128);
+      const thumbnailUrl =
+        preview.thumbnailUrl !== undefined
+          ? budget.dataImageUrl(preview.thumbnailUrl)
+          : undefined;
+      return {
+        kind: preview.kind,
+        prompt: budget.plainText(preview.prompt),
+        ...(thumbnailUrl ? { thumbnailUrl } : {}),
+        ...(model ? { model } : {}),
+      };
+    }
+    case 'subagent_delegation':
+      return {
+        kind: preview.kind,
+        agentName: budget.label(preview.agentName, 128),
+        task: budget.plainText(preview.task),
+        ...(preview.parentDelegationId
+          ? {
+              parentDelegationId: ids.get(
+                'tool-call',
+                preview.parentDelegationId,
+              ),
+            }
+          : {}),
+      };
+    case 'key_value':
+      return {
+        kind: preview.kind,
+        rows: budget.array(preview.rows).map((row) => ({
+          label: budget.plainText(row.label),
+          value: budget.plainText(row.value),
+        })),
+      };
+    case 'todo_list':
+      return sanitizeTodoPreview(preview, budget, ids);
+    case 'generic':
+      return {
+        kind: preview.kind,
+        ...(preview.summary
+          ? { summary: budget.plainText(preview.summary) }
+          : {}),
+      };
+    default:
+      return assertNever(preview);
+  }
+}
+
+function sanitizeResultPreview(
+  preview: DaemonToolResultPreview,
+  budget: ExportBudget,
+  _diagnostics: DiagnosticCounter,
+  ids: OpaqueDocumentIds,
+): ExportToolResultPreviewV1 | undefined {
+  if (preview.kind === 'todo_list') {
+    return sanitizeTodoPreview(preview, budget, ids);
+  }
+  if (preview.kind === 'text') {
+    return { kind: 'text', text: budget.text(preview.text) };
+  }
+  if (!preview.summary?.trim()) return undefined;
+  const summary = budget.text(preview.summary);
+  return summary.trim()
+    ? { kind: 'generic', summary }
+    : { kind: 'text', text: summary };
+}
+
+function sanitizeTodoPreview(
+  preview: DaemonTodoListPreview,
+  budget: ExportBudget,
+  ids: OpaqueDocumentIds,
+): ExportTodoListPreviewV1 {
+  if (preview.truncated) budget.markTruncated('todo_preview_truncated');
+  return {
+    kind: 'todo_list',
+    entries: budget.array(preview.entries).map((entry) => ({
+      id: ids.get('todo', entry.id),
+      content: budget.plainText(entry.content),
+      status: entry.status,
+      ...(entry.priority ? { priority: entry.priority } : {}),
+      ...(entry.blockedBy
+        ? {
+            blockedBy: budget
+              .array(entry.blockedBy)
+              .map((item) => ids.get('todo', item)),
+          }
+        : {}),
+    })),
+    ...(preview.truncated ? { truncated: true } : {}),
+    ...(preview.planId ? { planId: ids.get('plan', preview.planId) } : {}),
+    ...(preview.revision !== undefined
+      ? { revision: safeCount(preview.revision) }
+      : {}),
+  };
+}
+
+function terminalToolStatus(
+  status: string,
+  diagnostics: DiagnosticCounter,
+  budget: ExportBudget,
+): ExportToolTranscriptBlockV1['status'] {
+  if (
+    status === 'completed' ||
+    status === 'failed' ||
+    status === 'cancelled' ||
+    status === 'canceled'
+  ) {
+    return status;
+  }
+  diagnostics.add('tool_status_frozen', 'warning', 1, true);
+  budget.markContentLoss();
+  return 'cancelled';
+}
+
+function createMetadataPresentation(
+  sessionData: Pick<ExportSessionData, 'startTime' | 'metadata'>,
+  options: CreateExportTranscriptDocumentOptions,
+  diagnostics: DiagnosticCounter,
+  budget: ExportBudget,
+): Omit<ExportMetadataPresentationV1, 'complete' | 'truncated'> {
+  const metadata = sessionData.metadata;
+  const title = safeMetadataLabel(
+    options.title,
+    200,
+    'title',
+    diagnostics,
+    budget,
+  );
+  const gitBranch = safeMetadataLabel(
+    metadata?.gitBranch,
+    200,
+    'git_branch',
+    diagnostics,
+    budget,
+  );
+  const model = safeMetadataLabel(
+    metadata?.model,
+    200,
+    'model',
+    diagnostics,
+    budget,
+  );
+  const channel = safeMetadataLabel(
+    metadata?.channel,
+    100,
+    'channel',
+    diagnostics,
+    budget,
+  );
+  const projectName = metadata?.cwd
+    ? safeMetadataLabel(
+        safePath(metadata.cwd),
+        400,
+        'project_name',
+        diagnostics,
+        budget,
+        false,
+      )
+    : undefined;
+  const repository = metadata?.gitRepo
+    ? safeRepository(metadata.gitRepo, diagnostics, budget)
+    : undefined;
+  return {
+    ...(title ? { title } : {}),
+    ...(isIsoDate(sessionData.startTime)
+      ? { startedAt: sessionData.startTime }
+      : {}),
+    exportedAt: options.exportedAt,
+    ...(projectName ? { projectName } : {}),
+    ...(repository ? { repository } : {}),
+    ...(gitBranch ? { gitBranch } : {}),
+    ...(model ? { model } : {}),
+    ...(channel ? { channel } : {}),
+    ...(metadata ? { promptCount: safeCount(metadata.promptCount) } : {}),
+    ...(metadata?.contextUsagePercent !== undefined
+      ? {
+          contextUsagePercent: Math.min(
+            100,
+            safeCount(metadata.contextUsagePercent),
+          ),
+        }
+      : {}),
+    ...(metadata?.contextWindowSize !== undefined
+      ? { contextWindowSize: safeCount(metadata.contextWindowSize) }
+      : {}),
+    ...(metadata?.totalTokens !== undefined
+      ? { totalTokens: safeCount(metadata.totalTokens) }
+      : {}),
+    ...(metadata?.filesWritten !== undefined
+      ? { filesWritten: safeCount(metadata.filesWritten) }
+      : {}),
+    ...(metadata?.linesAdded !== undefined
+      ? { linesAdded: safeCount(metadata.linesAdded) }
+      : {}),
+    ...(metadata?.linesRemoved !== undefined
+      ? { linesRemoved: safeCount(metadata.linesRemoved) }
+      : {}),
+  };
+}
+
+const REQUIRED_TEXT_FALLBACK_RESERVE_BYTES = 64 * 1024;
+
+class ExportBudget {
+  visibleTextBytes = 0;
+  totalRasterBytes = 0;
+  richRenderTasks = 0;
+  truncated = false;
+  cumulativeTextBudgetExceeded = false;
+
+  constructor(private readonly diagnostics: DiagnosticCounter) {}
+
+  checkpoint(): {
+    visibleTextBytes: number;
+    totalRasterBytes: number;
+    richRenderTasks: number;
+  } {
+    return {
+      visibleTextBytes: this.visibleTextBytes,
+      totalRasterBytes: this.totalRasterBytes,
+      richRenderTasks: this.richRenderTasks,
+    };
+  }
+
+  restore(checkpoint: ReturnType<ExportBudget['checkpoint']>): void {
+    this.visibleTextBytes = checkpoint.visibleTextBytes;
+    this.totalRasterBytes = checkpoint.totalRasterBytes;
+    this.richRenderTasks = checkpoint.richRenderTasks;
+  }
+
+  array<T>(value: readonly T[]): T[] {
+    if (value.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength) {
+      this.truncated = true;
+      this.diagnostics.add('array_budget_exceeded', 'warning');
+    }
+    return value.slice(0, EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength);
+  }
+
+  markTruncated(code: string): void {
+    this.truncated = true;
+    this.diagnostics.add(code, 'warning');
+  }
+
+  markContentLoss(): void {
+    this.truncated = true;
+  }
+
+  label(value: unknown, maxLength: number, redact = true): string {
+    const safe = safeLabel(value, maxLength);
+    if (safe !== value) this.markTruncated('label_sanitized');
```

> **[Critical]** R2-2: `label()` truncates to `maxLength` BEFORE running `redactHomePaths`, but the `file:` home-URL redaction can GROW the string (`file:/home/a`, 12 chars, becomes `file://[home]`, 13) — so a capped identifier can leave `label()` at `maxLength + 1`, and the schema `maxLength` validation then throws `schema_validation_failed`, aborting the whole export instead of degrading. `safeMetadataLabel` → `budget.plainText` has the same redact-after-check ordering, and the metadata loop re-checks at the end. Reachable fields include user/model-controlled text (mcp `serverId` cap 128, ask_user_question `header` cap 200, metadata `model`/`gitBranch`/`channel`), not contrived inputs.
>
> Witness — probes at this head:
>
> ```
> mcp serverId 'x'.repeat(116)+'file:/home/a' (128 chars) -> throws schema_validation_failed
> control same length ending 'file:/home/' (no growth)   -> document created OK
> metadata.model 'm'.repeat(188)+'file:/home/a' (200)    -> throws schema_validation_failed
> ```
>
> Suggested fix: redact before capping — in `label()`, apply `redactHomePaths` to the raw value and run `safeLabel(..., maxLength)` on the redacted result (or re-cap after redaction); in `safeMetadataLabel`, evaluate length after redaction.
>
> Fix witness: add a regression test where an ask_user_question `header` (or mcp `serverId`) at the cap containing `file:/home/a` within the first cap chars yields a document (with `truncated: true`), not a throw; removing the re-cap makes it red.
>
> <details>
> <summary>中文说明</summary>
>
> `label()` 在运行 `redactHomePaths` 之前就把字符串截断到 `maxLength`，但 `file:` 主目录 URL 脱敏可能使字符串变长（`file:/home/a` 12 字符变为 `file://[home]` 13 字符）——因此一个恰好达到上限的标识符可能以 `maxLength + 1` 的长度离开 `label()`，随后 schema 的 `maxLength` 校验抛出 `schema_validation_failed`，使整个导出中止而非降级。`safeMetadataLabel` → `budget.plainText` 同样是“先检查后脱敏”的顺序，且 metadata 循环末尾会再次检查。可达字段包括用户/模型可控文本（mcp `serverId` 上限 128、ask_user_question `header` 上限 200、metadata `model`/`gitBranch`/`channel`），并非构造输入。
>
> 建议修复：先脱敏再限长——在 `label()` 中对原始值应用 `redactHomePaths`，再对脱敏结果运行 `safeLabel(..., maxLength)`（或在脱敏后重新限长）；在 `safeMetadataLabel` 中于脱敏之后再评估长度。
>
> 修复见证：新增回归测试：长度恰好达到上限且前若干个字符内含 `file:/home/a` 的 ask_user_question `header`（或 mcp `serverId`）必须产出文档（带 `truncated: true`）而不是抛错；移除重新限长逻辑后测试必须变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 6. R2-3：Markdown 前置复杂度闸门漏掉超线性结构

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074074)
- 结论：值得修复
- 理由：成立。当前只计数 `[ ] >`，无法拦截强调分隔符汤和深缩进列表；AST budget 只能在 remark 完成解析后生效，不能防止解析阶段 CPU 放大。
- 建议修复：用廉价结构预检替代原始 marker 总数：限制围栏外强调分隔符、括号嵌套、行首 blockquote 深度和缩进深度，同时保留 AST node/depth 与 try/catch。
- 实施状态：已修复并验证
- 修复批次：F5
- 实施证据：parseMarkdown 改用围栏感知的结构预检，限制强调分隔符、括号/blockquote 深度与前导缩进；20KB emphasis 与深缩进反例即时 fail closed。Markdown policy 7/7、CLI export 39/39。

原始评论：

标注位置：`packages/cli/src/ui/utils/export/markdown-document-policy.ts:65-67`（RIGHT（新增侧））

````diff
@@ -0,0 +1,321 @@
+/**
+ * @license
+ * Copyright 2025 Qwen Team
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { unified } from 'unified';
+import remarkGfm from 'remark-gfm';
+import remarkMath from 'remark-math';
+import remarkParse from 'remark-parse';
+
+interface MarkdownPoint {
+  offset?: number;
+}
+
+interface MarkdownNode {
+  type: string;
+  value?: string;
+  url?: string;
+  alt?: string;
+  identifier?: string;
+  lang?: string | null;
+  children?: MarkdownNode[];
+  position?: { start: MarkdownPoint; end: MarkdownPoint };
+}
+
+interface Replacement {
+  start: number;
+  end: number;
+  value: string;
+}
+
+export interface MarkdownDocumentPolicy {
+  normalizeUrl(source: string): string | undefined;
+  replaceImage(alt: string, source: string | undefined): string;
+  onUrlChange(code: 'url_rejected' | 'url_sanitized'): void;
+  onComplexityLimit?(): void;
+}
+
+const MARKDOWN_COMPLEXITY_FALLBACK =
+  '[markdown omitted: complexity limit exceeded]';
+const MAX_MARKDOWN_SOURCE_MARKERS = 2_048;
+const MAX_MARKDOWN_AST_NODES = 20_000;
+const MAX_MARKDOWN_AST_DEPTH = 512;
+
+const markdownParser = unified()
+  .use(remarkParse)
+  .use(remarkGfm)
+  .use(remarkMath);
+
+function mayContainNavigableMarkdown(value: string): boolean {
+  return (
+    value.includes(']') ||
+    value.includes('@') ||
+    /www\.|(?:https?|mailto|javascript|data):/i.test(value) ||
+    (value.includes('<') && value.includes('>'))
+  );
+}
+
+function mayContainFencedCode(value: string): boolean {
+  return value.includes('```') || value.includes('~~~');
+}
+
+function parseMarkdown(value: string): MarkdownNode | undefined {
+  let markers = 0;
+  for (const character of value) {
+    if (character !== '[' && character !== ']' && character !== '>') continue;
````

> **[Critical]** R2-3: The pre-parse complexity veto only counts `[`/`]`/`>` markers, but the super-linear remark-parse costs it exists to bound come from constructs containing NONE of those markers — emphasis-delimiter soup and indentation-nested lists. The cost is paid inside `parseMarkdown` before any AST budget runs (`ExportBudget.text()` sanitizes before `applyTextBudget`), and `assertResourceBudgets` clamps to `maxTextBytes` but still parses. One transcript message carrying a single `]`, `@`, or `<>` pair (routine in content full of code/log output) passes the navigability gate and stalls an export for a minute; entries compound (visible-text budget is 8 MB), and `text()` re-parses via `transformRichMarkdownTasks` when fences are present. This is the under-count twin of the marker over-deletion finding (R2-9); raising the marker cap does not close it.
>
> Witness — wall times through `createExportTranscriptDocumentV1` at this head:
>
> ```
> 'a*'.repeat(50_000) (no marker, control):       125.7 ms
> 'a*'.repeat(10_000)+']' (20 KB):              5,457 ms (parsed, exported)
> 'a*'.repeat(20_000)+']' (40 KB):              8,847 ms (AST budget rejects only AFTER parse)
> 'a*'.repeat(50_000)+']' (100 KB):            56,398 ms  (2.5x bytes -> 6.4x time)
> nested list 324,801 bytes, 0 counted markers: 4,609 ms
> ```
>
> Suggested fix: extend the veto in `parseMarkdown` with cheap structural checks for the marker-less super-linear shapes — veto when any line's leading indentation exceeds `2 * MAX_MARKDOWN_AST_DEPTH` spaces, and cap `*`/`_` emphasis-delimiter counts (or delimiter-dense bytes) the same way markers are capped; alternatively cap input bytes before parsing and route the excess through `onComplexityLimit`.
>
> Fix witness: in `markdown-document-policy.test.ts`, assert `sanitizeMarkdownDocument('a*'.repeat(50_000) + ']')` returns the complexity fallback under a wall-clock bound, plus a zero-marker deeply-indented list case; removing the added veto makes them red by timeout.
>
> <details>
> <summary>中文说明</summary>
>
> 解析前复杂度否决只统计 `[`/`]`/`>` 标记，但它要约束的 remark-parse 超线性开销恰恰来自不含任何这些标记的结构——强调分隔符汤与缩进嵌套列表。开销发生在 `parseMarkdown` 内部、任何 AST 预算生效之前（`ExportBudget.text()` 先脱敏后预算），`assertResourceBudgets` 虽然按 `maxTextBytes` 限流但仍会解析。只要一条转录消息里带一个 `]`、`@` 或 `<>` 对（在充满代码/日志输出的内容中很常见）就能通过可导航性闸门，使一次导出停滞约一分钟；条目可叠加（可见文本预算 8 MB），且有围栏时 `text()` 还会经 `transformRichMarkdownTasks` 再次解析。这是“标记过量删除”发现（R2-6）的孪生问题（计数不足方向）；提高标记上限并不能堵住它。
>
> 建议修复：在 `parseMarkdown` 的否决中为无标记的超线性形态增加廉价结构检查——任一行前导缩进超过 `2 * MAX_MARKDOWN_AST_DEPTH` 个空格即否决，并像标记一样对 `*`/`_` 强调分隔符数量（或分隔符密集字节数）设上限；或者在解析前对输入字节数设上限，超出部分走 `onComplexityLimit`。
>
> 修复见证：在 `markdown-document-policy.test.ts` 中断言 `sanitizeMarkdownDocument('a*'.repeat(50_000) + ']')` 在墙钟时限内返回复杂度回退，另加一个零标记深缩进列表用例；移除新增否决后它们会因超时变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 7. R2-4：清洗后的 URL 裸写回 Markdown 会破坏目标

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074079)
- 结论：值得修复
- 理由：成立。safeLinkReplacement 与 definition 分支直接把 safe URL 插入裸括号/定义目标；含未配对括号的合法 URL 会在二次解析时被截断，现有 verifier 无法发现语义漂移。
- 建议修复：统一用 angle-bracket destination 写回安全 URL，并转义 angle destination 中必要字符；补充 inline link 与 definition 往返解析测试。
- 实施状态：已修复并验证
- 修复批次：F6
- 实施证据：新增 markdownDestination，以 angle-bracket 形式安全写回 inline link 与 definition URL；未配对右括号和 definition 往返测试通过。Markdown policy 7/7、Chromium gate 4/4。

原始评论：

标注位置：`packages/cli/src/ui/utils/export/markdown-document-policy.ts:168-169`（RIGHT（新增侧））

````diff
@@ -0,0 +1,321 @@
+/**
+ * @license
+ * Copyright 2025 Qwen Team
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { unified } from 'unified';
+import remarkGfm from 'remark-gfm';
+import remarkMath from 'remark-math';
+import remarkParse from 'remark-parse';
+
+interface MarkdownPoint {
+  offset?: number;
+}
+
+interface MarkdownNode {
+  type: string;
+  value?: string;
+  url?: string;
+  alt?: string;
+  identifier?: string;
+  lang?: string | null;
+  children?: MarkdownNode[];
+  position?: { start: MarkdownPoint; end: MarkdownPoint };
+}
+
+interface Replacement {
+  start: number;
+  end: number;
+  value: string;
+}
+
+export interface MarkdownDocumentPolicy {
+  normalizeUrl(source: string): string | undefined;
+  replaceImage(alt: string, source: string | undefined): string;
+  onUrlChange(code: 'url_rejected' | 'url_sanitized'): void;
+  onComplexityLimit?(): void;
+}
+
+const MARKDOWN_COMPLEXITY_FALLBACK =
+  '[markdown omitted: complexity limit exceeded]';
+const MAX_MARKDOWN_SOURCE_MARKERS = 2_048;
+const MAX_MARKDOWN_AST_NODES = 20_000;
+const MAX_MARKDOWN_AST_DEPTH = 512;
+
+const markdownParser = unified()
+  .use(remarkParse)
+  .use(remarkGfm)
+  .use(remarkMath);
+
+function mayContainNavigableMarkdown(value: string): boolean {
+  return (
+    value.includes(']') ||
+    value.includes('@') ||
+    /www\.|(?:https?|mailto|javascript|data):/i.test(value) ||
+    (value.includes('<') && value.includes('>'))
+  );
+}
+
+function mayContainFencedCode(value: string): boolean {
+  return value.includes('```') || value.includes('~~~');
+}
+
+function parseMarkdown(value: string): MarkdownNode | undefined {
+  let markers = 0;
+  for (const character of value) {
+    if (character !== '[' && character !== ']' && character !== '>') continue;
+    markers += 1;
+    if (markers > MAX_MARKDOWN_SOURCE_MARKERS) return undefined;
+  }
+  try {
+    const root = markdownParser.parse(value) as unknown as MarkdownNode;
+    return isMarkdownTreeWithinBudget(root) ? root : undefined;
+  } catch {
+    return undefined;
+  }
+}
+
+function walkMarkdown(
+  node: MarkdownNode,
+  visit: (node: MarkdownNode) => boolean | void,
+): void {
+  const stack = [node];
+  while (stack.length > 0) {
+    const current = stack.pop();
+    if (!current || visit(current) === false) continue;
+    const children = current.children ?? [];
+    for (let index = children.length - 1; index >= 0; index -= 1) {
+      stack.push(children[index]);
+    }
+  }
+}
+
+function isMarkdownTreeWithinBudget(root: MarkdownNode): boolean {
+  const stack: Array<{ node: MarkdownNode; depth: number }> = [
+    { node: root, depth: 0 },
+  ];
+  let nodes = 0;
+  while (stack.length > 0) {
+    const current = stack.pop();
+    if (!current) continue;
+    nodes += 1;
+    if (
+      nodes > MAX_MARKDOWN_AST_NODES ||
+      current.depth > MAX_MARKDOWN_AST_DEPTH
+    ) {
+      return false;
+    }
+    for (const child of current.node.children ?? []) {
+      stack.push({ node: child, depth: current.depth + 1 });
+    }
+  }
+  return true;
+}
+
+function rangeOf(
+  node: MarkdownNode,
+): { start: number; end: number } | undefined {
+  const start = node.position?.start.offset;
+  const end = node.position?.end.offset;
+  return typeof start === 'number' && typeof end === 'number'
+    ? { start, end }
+    : undefined;
+}
+
+function applyReplacements(value: string, replacements: Replacement[]): string {
+  let result = value;
+  let previousStart = Number.POSITIVE_INFINITY;
+  for (const replacement of replacements.sort(
+    (left, right) => right.start - left.start,
+  )) {
+    if (replacement.end > previousStart) continue;
+    result =
+      result.slice(0, replacement.start) +
+      replacement.value +
+      result.slice(replacement.end);
+    previousStart = replacement.start;
+  }
+  return result;
+}
+
+function normalizedIdentifier(node: MarkdownNode): string | undefined {
+  return node.identifier?.trim().toLowerCase();
+}
+
+function markdownText(node: MarkdownNode): string {
+  if (node.type === 'text' || node.type === 'inlineCode') {
+    return node.value ?? '';
+  }
+  if (node.type === 'image') return node.alt ?? '';
+  return (node.children ?? []).map(markdownText).join('');
+}
+
+function escapeLabel(value: string): string {
+  return value.replace(/([\\[\]])/g, '\\$1');
+}
+
+function safeLinkReplacement(
+  original: string,
+  node: MarkdownNode,
+  safe: string | undefined,
+): string {
+  if (!safe) {
+    return original.trimStart().startsWith('[')
+      ? escapeLabel(markdownText(node))
+      : '[link omitted]';
+  }
+  if (!original.trimStart().startsWith('[')) return safe;
+  return `[${escapeLabel(markdownText(node))}](${safe})`;
````

> **[Critical]** R2-4: `safeLinkReplacement` (and the twin definition rewrite in `sanitizeMarkdownDocument`) re-emits the normalized URL into a bare `(...)` destination without escaping destination-special characters, so a sanitized URL containing an unbalanced `)` — legal in a WHATWG URL path, writable in source only via the `<...>` destination form — produces markdown that re-parses to a different, truncated link target. The fail-closed verifier does not catch it: in `assertResourceBudgets` the truncated link now satisfies `safe === source`, so `sanitized === entry` passes while the `url_sanitized` diagnostic describes only the query strip, not the target corruption. Balanced-paren URLs like `Thing_(disambiguation)` are unaffected.
>
> Witness — executed on the real module at this head:
>
> ```
> in:  [docs](<https://example.com/report)v2?q=1>)
> out: [docs](https://example.com/report)v2)
> re-parse: link url="https://example.com/report" + literal text "v2)"  (intended target truncated)
> definition variant: "[ref]: https://example.com/report)v2" no longer parses as a definition -> [docs][ref] renders as literal text
> ```
>
> Suggested fix: re-emit destinations in a round-trip-safe form — percent-encode `(` / `)` in the sanitized URL before interpolation (WHATWG-equivalent), or emit the angle-bracket form `[label](<safe>)` / `[id]: <safe>` whenever the URL contains characters special in a bare destination. Apply the same treatment to the definition branch.
>
> Fix witness: add a case sanitizing `[docs](<https://example.com/report)v2?q=1>)` with a query-stripping `normalizeUrl`, then re-parse the output and assert exactly one link node whose `url` is `https://example.com/report)v2` (plus a definition variant asserting the reference still resolves); removing the escaping makes the round-trip assertion red.
>
> <details>
> <summary>中文说明</summary>
>
> `safeLinkReplacement`（以及 `sanitizeMarkdownDocument` 中成对的定义重写）把归一化后的 URL 重新写入裸 `(...)` 目标时没有转义目标特殊字符，因此包含未配对 `)` 的归一化 URL（在 WHATWG URL 路径中合法，源码中只能经由 `<...>` 目标形式书写）会产出重新解析后指向不同（被截断）链接目标的 markdown。快速失败校验器抓不到这一点：在 `assertResourceBudgets` 中截断后的链接满足 `safe === source`，于是 `sanitized === entry` 通过，而 `url_sanitized` 诊断只描述了查询参数剥离，未描述目标损坏。括号配平的 URL（如 `Thing_(disambiguation)`）不受影响。
>
> 建议修复：以可往返的形式重新写入目标——在插值前对归一化 URL 中的 `(` / `)` 做百分号编码（与 WHATWG 等价），或当 URL 含有裸目标中的特殊字符时改用尖括号形式 `[label](<safe>)` / `[id]: <safe>`。定义分支同样处理。
>
> 修复见证：新增用例，用剥离查询参数的 `normalizeUrl` 脱敏 `[docs](<https://example.com/report)v2?q=1>)`，然后重新解析输出并断言恰好一个 link 节点且其 `url` 为 `https://example.com/report)v2`（另加定义变体断言引用仍可解析）；移除转义后往返断言必须变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 8. R2-5：mergeToolCall 丢失 wasCancelled

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074084)
- 结论：值得修复
- 理由：成立。默认投影把 cancelled 映射为 completed 并依赖 wasCancelled 阻止 diff 展示，但 mergeToolCall 没有传播该字段；多块工具调用会把未应用 diff 当作成功。
- 建议修复：在 mergeToolCall 中传播 wasCancelled，并新增 in_progress → cancelled 的合并回归测试。
- 实施状态：已修复并验证
- 修复批次：F7
- 实施证据：mergeToolCall 传播 wasCancelled；既有多块 in_progress→cancelled 合并测试新增该断言。Web Shell 聚焦测试 249/249。

原始评论：

标注位置：`packages/web-shell/client/adapters/transcriptToMessages.ts:1179-1181`（RIGHT（新增侧））

```diff
@@ -1047,15 +1161,27 @@ function findShellOutputTargetIndex(
 function mergeToolCall(
   target: DaemonMessageToolCall,
   source: DaemonMessageToolCall,
+  options: {
+    replaceArgs?: boolean;
+    replaceRawOutput?: boolean;
+  } = {},
 ): void {
   target.status = source.status ?? target.status;
   target.title = source.title ?? target.title;
   target.toolName = source.toolName ?? target.toolName;
   target.kind = source.kind ?? target.kind;
+  target.sourceBlockIds = unionMessageIds(
+    target.sourceBlockIds,
+    ...(source.sourceBlockIds ?? []),
+  );
   target.content = source.content ?? target.content;
   target.endTime = source.endTime ?? target.endTime;
-  target.rawOutput = source.rawOutput ?? target.rawOutput;
-  target.args = source.args ?? target.args;
+  if (options.replaceRawOutput !== false) {
+    target.rawOutput = source.rawOutput ?? target.rawOutput;
+  }
```

> **[Critical]** R2-5: This PR adds `wasCancelled` to `DaemonMessageToolCall` and extends `extractDiff`'s guard to rely on it — but `mergeToolCall`, reworked in the same PR, copies status/title/toolName/kind/sourceBlockIds/content/endTime/rawOutput/args/locations and never propagates `wasCancelled`. A cancelled edit streamed as two blocks under one `toolCallId` (in_progress then cancelled; cancelled maps to status `'completed'` in the default projection) loses the flag at the merge, so nothing in the merged tool signals the cancellation and the new args-based reconstruction renders the attempted diff as applied. The safe/document projection is shielded (cancelled maps to `'failed'` there); the interactive/default projection is exposed. This is the multi-block entrance of the mechanism round-1 R1-8 targeted (whose single-block input the fix closed); the existing tests at `transcriptToMessages.test.ts:1441`/:2334 exercise this merge shape but none asserts `wasCancelled` across it.
>
> Witness — probe at this head:
>
> ```
> single cancelled block:         status=completed wasCancelled=true      extractDiff=""          (guard works)
> in_progress -> cancelled merge: status=completed wasCancelled=undefined extractDiff="-old\n+new"  <- attempted edit renders as applied
> flip (one-line merge fix):      merged wasCancelled=true                extractDiff=""
> ```
>
> Suggested fix:
>
> ```suggestion
>   target.wasCancelled = source.wasCancelled ?? target.wasCancelled;
>   if (options.replaceRawOutput !== false) {
>     target.rawOutput = source.rawOutput ?? target.rawOutput;
>   }
> ```
>
> Fix witness: add a `transcriptToMessages.test.ts` case feeding `[toolBlock(id1, call, 'in_progress', …, {rawInput: {oldText, newText}}), toolBlock(id2, call, 'cancelled', …)]` and assert the merged tool has `wasCancelled: true` and `extractDiff(tool) === ''`; removing the merge line makes it red.
>
> <details>
> <summary>中文说明</summary>
>
> 本 PR 为 `DaemonMessageToolCall` 增加了 `wasCancelled` 并让 `extractDiff` 的守卫依赖它——但同一 PR 重构的 `mergeToolCall` 复制了 status/title/toolName/kind/sourceBlockIds/content/endTime/rawOutput/args/locations，唯独不传播 `wasCancelled`。一个被取消的编辑以两个块（同一 `toolCallId` 下 in_progress 然后 cancelled；默认投影中 cancelled 映射为状态 `'completed'`）流入时，合并会丢失该标志，合并后的工具调用没有任何取消信号，新的基于 args 的重建会把未应用的编辑渲染成已应用。safe/document 投影不受影响（那里 cancelled 映射为 `'failed'`）；交互式/默认投影暴露于此。这是 round 1 R1-8 所针对机制的多块入口（其单块输入已被修复关闭）；`transcriptToMessages.test.ts:1441`/:2334 的既有测试覆盖了该合并形态，但没有断言 `wasCancelled` 跨合并保留。
>
> 建议修复：见上方 suggestion 块，在 `mergeToolCall` 中传播该标志。
>
> 修复见证：新增 `transcriptToMessages.test.ts` 用例，输入 `[toolBlock(id1, call, 'in_progress', …, {rawInput: {oldText, newText}}), toolBlock(id2, call, 'cancelled', …)]`，断言合并后的工具 `wasCancelled: true` 且 `extractDiff(tool) === ''`；移除该合并行后测试必须变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 9. R2-6：delete-only file diff 在 document mode 静默消失

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074099)
- 结论：值得修复
- 理由：成立。extractDiff 只有 newText 为字符串时才构造 diff；oldText-only preview 直接返回空串，而 safe/document projection 没有其他可用 diff 来源。
- 建议修复：oldText 或 newText 任一存在时构造 unified diff，缺失一侧使用空字符串；补充 oldText-only 回归。
- 实施状态：已修复并验证
- 修复批次：F8
- 实施证据：extractDiff 在 oldText/newText 任一存在时构造 unified diff；oldText-only 删除回归断言 `-deleted content`。Web Shell 聚焦测试 249/249。

原始评论：

标注位置：`packages/web-shell/client/components/messages/ToolGroup.tsx:160-161`（RIGHT（新增侧））

```diff
@@ -150,6 +153,19 @@ export function extractDiff(tool: ACPToolCall): string {
     }
   }

+  if (tool.status === 'failed' || tool.wasCancelled) return '';
+
+  const previewPatch = tool.args?.patch;
+  if (typeof previewPatch === 'string' && previewPatch) return previewPatch;
+  const previewNewText = tool.args?.newText;
+  if (typeof previewNewText === 'string') {
```

> **[Critical]** R2-6: The args-based diff preview — the ONLY diff source on the document/export projection (`content` is forced `undefined` there and `rawOutput` is just the result-preview text) — silently skips delete-only edits. `getFirstString` rejects empty strings, so `detectFileDiff` on `new_string: ''` emits `{kind:'file_diff', path, oldText}` with NO `newText`; this fallback requires `newText` to be a string, returns `''`, and the exported HTML shows a completed deletion with its one-line result but no diff — while every replacement edit (oldText+newText) and every create edit (`old_string: ''` → `buildUnifiedDiff('', newText)` works) renders a diff. Silent content loss in an artifact whose `metadata.complete` is `true`.
>
> Witness — probe end-to-end at this head:
>
> ```
> UPSTREAM SDK: edit args {file_path, old_string:'deleted line', new_string:''}
>   -> preview {kind:'file_diff', oldText:'deleted line'} (no newText; create-edit control carries newText)
> DOCUMENT PROJECTION: delete-only preview -> args {path, oldText} -> extractDiff="" (completed deletion, no diff)
> CONTROL create edit -> extractDiff="-\n+added line"
> FLIP accepting oldText-only previews -> extractDiff="-deleted line\n+"
> ```
>
> Suggested fix: accept oldText-only previews — branch on `typeof previewNewText === 'string' || typeof previewOldText === 'string'` and call `buildUnifiedDiff` with `''` for the missing side; alternatively preserve `newText: ''` in `detectFileDiff` when the edit shape is detected.
>
> Fix witness: a `ToolGroup.test.tsx` safe-projection case whose block preview is `{kind:'file_diff', path:'document.ts', oldText:'old content'}` (no `newText`) asserting `extractDiff(tool)` contains `-old content`; removing the oldText-only branch makes it red.
>
> <details>
> <summary>中文说明</summary>
>
> 基于 args 的 diff 预览是 document/export 投影上唯一的 diff 来源（那里 `content` 被强制为 `undefined`，`rawOutput` 只是结果预览文本），但它静默跳过纯删除编辑。`getFirstString` 拒绝空字符串，因此 `detectFileDiff` 对 `new_string: ''` 只产出 `{kind:'file_diff', path, oldText}` 而没有 `newText`；此回退分支要求 `newText` 必须是字符串，于是返回 `''`，导出的 HTML 对已完成的删除只显示一行结果而没有 diff——而所有替换编辑（oldText+newText）和所有创建编辑（`old_string: ''` → `buildUnifiedDiff('', newText)` 可工作）都会渲染 diff。这是在 `metadata.complete` 为 `true` 的产物中静默丢失内容。
>
> 建议修复：接受仅含 oldText 的预览——以 `typeof previewNewText === 'string' || typeof previewOldText === 'string'` 为条件，对缺失的一侧以 `''` 调用 `buildUnifiedDiff`；或者在 `detectFileDiff` 检测到编辑形态时保留 `newText: ''`。
>
> 修复见证：新增 `ToolGroup.test.tsx` safe 投影用例，块预览为 `{kind:'file_diff', path:'document.ts', oldText:'old content'}`（无 `newText`），断言 `extractDiff(tool)` 包含 `-old content`；移除仅 oldText 分支后测试必须变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 10. R2-7：HTML renderer 使 npm 发布包超过 96MiB 门禁

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074108)
- 结论：值得修复
- 理由：成立。当前真实 `npm run bundle && npm run prepare:package` 以 117,779,954 bytes 超过 100,663,296 bytes 失败；这是 release blocker。
- 建议修复：在保留真实 HTML Export 消费者的前提下，把显式发布体积预算提高到 128MiB，并同步锁定测试；用 prepare:package 证明发布流程恢复。
- 实施状态：已修复并验证
- 修复批次：F9
- 实施证据：prepare-package 默认预算与锁定测试同步为 128MiB；预修复 117,779,954 > 100,663,296，修复后真实 `npm run bundle && npm run prepare:package` 成功。

原始评论：

标注位置：`packages/web-templates/src/index.ts:10-12`（RIGHT（新增侧））

```diff
@@ -7,3 +7,8 @@
 export { INSIGHT_JS, INSIGHT_CSS } from './generated/insightTemplate.js';

 export { HTML_TEMPLATE as EXPORT_HTML_TEMPLATE } from './generated/exportHtmlTemplate.js';
+export {
+  DOCUMENT_HTML_TEMPLATE as EXPORT_TRANSCRIPT_HTML_TEMPLATE,
+  EXPORT_TRANSCRIPT_RENDERER_LIMITS,
```

> **[Critical]** R2-7: This PR inlines the ~20 MB document template into the shipped npm bundle (these exports pull `generated/exportTranscriptDocumentTemplate.ts` into the CLI import graph via `formatters/html.ts`; esbuild emits it as a ~20.7 MB chunk that `prepare-package.js` ships wholesale) but leaves `DEFAULT_MAX_NPM_PACKAGE_UNPACKED_BYTES = 96 MiB` unchanged — so `npm run prepare:package` throws. No PR lane runs `prepare:package`: only release.yml's publish job (nightly cron, Tuesday preview cron, workflow_dispatch), desktop-shell `prepare-runtime.js`, the vscode companion `prepackage.js`, and the tag-triggered Docker build do. The PR merges fully green and the first red lands on the next release lane.
>
> Witness — measured in this worktree's build:
>
> ```
> BASE: node scripts/prepare-package.js -> Error: Prepared package unpacked size 117432625 bytes exceeds 100663296 bytes
> FLIP: stub out the 20,760,649-byte template chunk (verified to contain the PR's 'transcript-document' envelope) -> gate passes (~92.2 MiB)
> ```
>
> `scripts/tests/package-assets.test.js:933` pins the 100663296 default.
>
> Suggested fix: bump `DEFAULT_MAX_NPM_PACKAGE_UNPACKED_BYTES` to cover the new headroom (e.g. 128 MiB) together with the pinning test, or reduce shipped bytes if a slimmer template representation is feasible — decide it in this PR, since the failure otherwise surfaces only on the release lane post-merge.
>
> Fix witness: `scripts/tests/package-assets.test.js` — 'enforces a 96 MiB default unpacked size budget' asserts the exact `exceeds 100663296 bytes` message and must move in lockstep with any cap bump; 'fails packaging when prepared dist exceeds the unpacked size budget' pins the gate itself.
>
> <details>
> <summary>中文说明</summary>
>
> 本 PR 把约 20 MB 的文档模板内联进了发布的 npm 包（这些导出经由 `formatters/html.ts` 把 `generated/exportTranscriptDocumentTemplate.ts` 拉入 CLI 导入图；esbuild 将其产出为约 20.7 MB 的 chunk，`prepare-package.js` 会整体打包发布），但 `DEFAULT_MAX_NPM_PACKAGE_UNPACKED_BYTES = 96 MiB` 未变——因此 `npm run prepare:package` 会抛错。没有任何 PR 门禁会运行 `prepare:package`：只有 release.yml 的 publish job（夜间定时、周二预览定时、workflow_dispatch）、desktop-shell 的 `prepare-runtime.js`、vscode companion 的 `prepackage.js` 以及 tag 触发的 Docker 构建会运行。PR 会以全绿合入，第一个红会出现在下一个 release 门禁。
>
> 建议修复：提高 `DEFAULT_MAX_NPM_PACKAGE_UNPACKED_BYTES` 以覆盖新增体积（例如 128 MiB）并同步更新锁定测试；或者若有更精简的模板表示则减少发布字节——请在本 PR 内决定，否则该失败只会在合入后的 release 门禁暴露。
>
> 修复见证：`scripts/tests/package-assets.test.js` 中 'enforces a 96 MiB default unpacked size budget' 断言了精确的 `exceeds 100663296 bytes` 文案，任何上限调整都必须同步；'fails packaging when prepared dist exceeds the unpacked size budget' 锁定门禁本身。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 11. R2-8：nightly browser job 只安装一个 Chromium revision

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074118)
- 结论：值得修复
- 理由：成立。当前根 playwright 1.58.2 需要 rev 1208，@playwright/test 1.61.1 需要 rev 1228；e2e nightly 仍只运行 npx CLI，无法保证 document gate 与 Web Shell E2E 两个 runtime 都可启动。
- 建议修复：在 e2e nightly 镜像 CI 的 dual-tree 安装：根 playwright 带 --with-deps，存在 nested CLI 时再安装其 Chromium。
- 实施状态：已修复并验证
- 修复批次：F10
- 实施证据：e2e nightly 改为 root playwright + nested @playwright/test dual-tree Chromium 安装，并新增 workflow contract。Scripts 聚焦测试 46 passed/2 skipped。

原始评论：

标注位置：`.github/workflows/e2e.yml:369-370`（RIGHT（新增侧））

```diff
@@ -292,6 +292,9 @@ jobs:
       - name: 'Install Playwright Chromium'
         run: 'npx playwright install --with-deps chromium'

+      - name: 'Run transcript document browser gate'
+        run: 'npx vitest run --root ./integration-tests ./chat-transcript-document.test.ts --retry=0'
```

> **[Critical]** R2-8: The `web-shell-browser-regression` job this gate step was added to keeps its single `npx playwright install --with-deps chromium`, which installs at most ONE chromium revision — while the job now needs TWO: this test imports root-hoisted `playwright@1.58.2` (chromium rev 1208), but `npx playwright` resolves to `.bin/playwright` = @playwright/test's CLI (1.61.1, chromium rev 1228). The job runs only on `schedule`/`workflow_dispatch`, never on PR checks — so this PR's green checks give no evidence about it, and the first red lands on `main` after merge. This PR already fixed the identical shape in ci.yml's `web_shell_e2e_smoke` with a dual-tree install.
>
> Witness — probes on this tree:
>
> ```
> node_modules/.bin/playwright -> ../@playwright/test/cli.js (1.61.1 -> chromium rev 1228)
> hoisted playwright 1.58.2 browsers.json -> chromium rev 1208
> npx playwright install --dry-run chromium                      -> Install location .../chromium-1228
> node node_modules/playwright/cli.js install --dry-run chromium -> .../chromium-1208
> with only 1228 present: LAUNCH FAILED: browserType.launch: Executable doesn't exist at .../ms-playwright/chromium_headless_shell-1208/...
> after the dual install: LAUNCH OK
> ```
>
> Suggested fix: mirror ci.yml's dual-tree install in this job:
>
> ```yaml
> - name: 'Install Playwright Chromium'
>   run: |-
>     node node_modules/playwright/cli.js install --with-deps chromium
>     nested_cli='node_modules/@playwright/test/node_modules/playwright/cli.js'
>     if [ -f "${nested_cli}" ]; then
>       node "${nested_cli}" install chromium
>     fi
> ```
>
> Fix witness: N/A — the witness is this job's own gate step on the nightly lane (red without the fix); no in-repo unit test can pin a runner-side browser install.
>
> <details>
> <summary>中文说明</summary>
>
> 该门禁步骤被加入的 `web-shell-browser-regression` job 仍然只有单条 `npx playwright install --with-deps chromium`，最多安装一个 chromium 版本——而该 job 现在需要两个：本测试导入根目录提升的 `playwright@1.58.2`（chromium rev 1208），但 `npx playwright` 解析到 `.bin/playwright` = @playwright/test 的 CLI（1.61.1，chromium rev 1228）。该 job 仅在 `schedule`/`workflow_dispatch` 运行、从不在 PR 检查中运行——因此本 PR 的绿色检查对它没有任何证据，第一个红会在合入后落在 `main` 上。本 PR 已经在 ci.yml 的 `web_shell_e2e_smoke` 中用双树安装修复了同样的形态。
>
> 建议修复：在该 job 中镜像 ci.yml 的双树安装（见上方 YAML）。
>
> 修复见证：N/A——见证就是该 job 自身在夜间门禁上的门禁步骤（不修复则红）；仓库内没有单元测试能锁定 runner 侧的浏览器安装。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 12. R2-9：原始 marker 总数会过度删除普通日志

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074128)
- 结论：值得修复
- 理由：成立。当前预检统计代码围栏与普通文本内全部 `[ ] >`，342 行扁平日志也会被当作复杂度攻击。该问题与 Critical R2-3 共用同一错误 primitive，修复它不构成独立范围扩张。
- 建议修复：由 F5 的结构预检替换原始字符总数，并新增 2048+ 非嵌套 marker/围栏日志保持不变的测试。
- 实施状态：已修复并验证
- 修复批次：F5
- 实施证据：结构预检不再统计所有原始 `[ ] >`；342 行扁平 bracket 日志保持原文且不触发 complexity callback。Markdown policy 7/7。

原始评论：

标注位置：`packages/cli/src/ui/utils/export/markdown-document-policy.ts:65-67`（RIGHT（新增侧））

````diff
@@ -0,0 +1,321 @@
+/**
+ * @license
+ * Copyright 2025 Qwen Team
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { unified } from 'unified';
+import remarkGfm from 'remark-gfm';
+import remarkMath from 'remark-math';
+import remarkParse from 'remark-parse';
+
+interface MarkdownPoint {
+  offset?: number;
+}
+
+interface MarkdownNode {
+  type: string;
+  value?: string;
+  url?: string;
+  alt?: string;
+  identifier?: string;
+  lang?: string | null;
+  children?: MarkdownNode[];
+  position?: { start: MarkdownPoint; end: MarkdownPoint };
+}
+
+interface Replacement {
+  start: number;
+  end: number;
+  value: string;
+}
+
+export interface MarkdownDocumentPolicy {
+  normalizeUrl(source: string): string | undefined;
+  replaceImage(alt: string, source: string | undefined): string;
+  onUrlChange(code: 'url_rejected' | 'url_sanitized'): void;
+  onComplexityLimit?(): void;
+}
+
+const MARKDOWN_COMPLEXITY_FALLBACK =
+  '[markdown omitted: complexity limit exceeded]';
+const MAX_MARKDOWN_SOURCE_MARKERS = 2_048;
+const MAX_MARKDOWN_AST_NODES = 20_000;
+const MAX_MARKDOWN_AST_DEPTH = 512;
+
+const markdownParser = unified()
+  .use(remarkParse)
+  .use(remarkGfm)
+  .use(remarkMath);
+
+function mayContainNavigableMarkdown(value: string): boolean {
+  return (
+    value.includes(']') ||
+    value.includes('@') ||
+    /www\.|(?:https?|mailto|javascript|data):/i.test(value) ||
+    (value.includes('<') && value.includes('>'))
+  );
+}
+
+function mayContainFencedCode(value: string): boolean {
+  return value.includes('```') || value.includes('~~~');
+}
+
+function parseMarkdown(value: string): MarkdownNode | undefined {
+  let markers = 0;
+  for (const character of value) {
+    if (character !== '[' && character !== ']' && character !== '>') continue;
````

> **[Suggestion]** R2-9: The pre-parse marker veto counts every `[`, `]`, `>` anywhere in the raw source — including inside code fences and plain prose — so it does not correlate with parse cost and over-deletes benign content: a ~15 KB flat-paragraph log of bracketed tokens is dropped from exports entirely (tracked loss with diagnostic + `truncated`, but over-deletion). Boundary measured at this head: 341 log-style lines (2046 markers) survive with `complete:true`; 342 lines (2052 markers) are replaced by the complexity fallback. Transcripts quoting logs, JSON arrays, or shell output (`>` prompts, `=>`, redirects) hit this routinely — reachable from exactly the fields coding-assistant transcripts are full of.
>
> Witness — probes at this head: 342 lines shaped `[2026-01-01 12:00:NN] [INFO] [worker-N] ok` → entry replaced, `complete:false`, diagnostics `[markdown_complexity_exceeded]`; 341 lines → survive, `complete:true`.
>
> Suggested fix: make the veto track nesting-relevant markers instead of raw character counts (max leading-blockquote `>` depth per line and bracket nesting depth, or exclude markers inside fenced code), or raise `MAX_MARKDOWN_SOURCE_MARKERS` substantially — keeping the AST node/depth budgets and the parse try/catch as the authoritative fail-closed gates.
>
> Fix witness: assert that an entry with 2048+ non-nesting markers (bracketed log lines, or brackets inside a fenced code block) is returned intact rather than replaced with the fallback; goes red while the naive character count remains.
>
> <details>
> <summary>中文说明</summary>
>
> 解析前的标记否决统计原始文本中任意位置的每一个 `[`、`]`、`>`——包括代码围栏内部和普通行文——因此它与解析开销并不相关，会过量删除良性内容：一段约 15 KB、由带括号 token 组成的扁平段落日志会被整个从导出中丢弃（有诊断 + `truncated` 的受跟踪损失，但属于过量删除）。在本 head 实测边界：341 行日志形态（2046 个标记）存活且 `complete:true`；342 行（2052 个标记）被替换为复杂度回退。引用日志、JSON 数组或 shell 输出（`>` 提示符、`=>`、重定向）的转录会经常命中——可达面正是编程助手转录中最常见的字段。
>
> 建议修复：让否决跟踪与嵌套相关的标记而非原始字符计数（每行前导块引用 `>` 的最大深度与括号嵌套深度，或排除围栏代码内的标记），或大幅提高 `MAX_MARKDOWN_SOURCE_MARKERS`——保留 AST 节点/深度预算与解析 try/catch 作为权威的快速失败闸门。
>
> 修复见证：断言含 2048+ 个非嵌套标记的条目（日志括号行或围栏代码内的括号）原样返回而非被替换为回退文案；保留朴素字符计数时该断言为红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

### 13. R2-10：Playwright workflow 断言仍锁定旧安装命令

- 评论来源：qwen-code-ci-bot，行内评论，[原评论](https://github.com/QwenLM/qwen-code/pull/10076#discussion_r3872074136)
- 结论：值得修复
- 理由：成立，但 reviewer 对当前 CI 红灯归因已过时：当前 Ubuntu 红灯实际是 ACP HTTP transport 测试；本地单文件仍确定性复现此断言失败。
- 建议修复：更新测试，分别锁定 hosted/self-hosted dual-tree 命令与 self-hosted 不使用 --with-deps 的约束。
- 实施状态：已修复并验证
- 修复批次：F11
- 实施证据：no-ak workflow contract 改为分别锁定 hosted/self-hosted dual-tree 命令与 self-hosted 无 install --with-deps；预修复 1 failed，修复后 14 tests 中 12 passed/2 platform-skipped。

原始评论：

标注位置：`.github/workflows/ci.yml:830-831`（RIGHT（新增侧））

```diff
@@ -816,19 +816,32 @@ jobs:

       - name: 'Install Playwright Chromium (hosted)'
         if: "${{ runner.environment == 'github-hosted' }}"
-        run: 'npx playwright install --with-deps chromium'
+        run: |-
+          node node_modules/playwright/cli.js install --with-deps chromium
+          nested_cli='node_modules/@playwright/test/node_modules/playwright/cli.js'
+          if [ -f "${nested_cli}" ]; then
+            node "${nested_cli}" install chromium
+          fi

       - name: 'Install Playwright Chromium (self-hosted)'
         if: "${{ runner.environment == 'self-hosted' }}"
```

> **[Critical]** R2-10: The rewrite of this job's Playwright install steps (`npx playwright install chromium` → the dual-tree `node node_modules/playwright/cli.js install` form) breaks the repository's CI-wiring contract test, which pins the old shape: `scripts/tests/no-ak-integration-ci.test.js` 'does not install Linux packages on self-hosted Playwright runners' expects `run: 'npx playwright install chromium'` in `web_shell_e2e_smoke`. The ubuntu unit-test CI job is red on this very test at the reviewed head, and the failure reproduces deterministically in a clean checkout. The workflow change itself is intentional (round-1 R1-12 discussed it); the pin was never updated with it. Merge-base `main` still carries the pinned single-install form, so the divergence is this PR's.
>
> Witness — executed:
>
> ```
> npx vitest run --project scripts scripts/tests/no-ak-integration-ci.test.js (at this head)
>   x 'does not install Linux packages on self-hosted Playwright runners' (AssertionError at :656)
>   Test Files 1 failed | 65 passed (66); Tests 1 failed | 1779 passed
> CI at the same head: Test (ubuntu-latest, Node 22.x) failed with the identical assertion
> ```
>
> Suggested fix: update the pin to the new dual-tree shape — assert the `node node_modules/playwright/cli.js install chromium` step plus the nested-CLI fallback, keeping the self-hosted no-`--with-deps` assertion — so the contract test locks the form the workflow now uses.
>
> Fix witness: the updated assertion itself — reverting this job's self-hosted step to the old `npx` form must turn it red.
>
> <details>
> <summary>中文说明</summary>
>
> 该 job 的 Playwright 安装步骤重写（`npx playwright install chromium` → 双树 `node node_modules/playwright/cli.js install` 形态）破坏了仓库的 CI 接线契约测试，该测试固化的是旧形态：`scripts/tests/no-ak-integration-ci.test.js` 的 'does not install Linux packages on self-hosted Playwright runners' 期望 `web_shell_e2e_smoke` 中有 `run: 'npx playwright install chromium'`。在被审查的 head 上，ubuntu 单元测试 CI job 正因这个测试而红，且在干净检出中可确定性复现。工作流改动本身是有意的（round 1 R1-12 讨论过），但固化断言从未随之更新。merge-base `main` 仍是被固化的单安装形态，因此分叉来自本 PR。
>
> 建议修复：把断言更新为新的双树形态——断言 `node node_modules/playwright/cli.js install chromium` 步骤及嵌套 CLI 回退，保留 self-hosted 不带 `--with-deps` 的断言——使契约测试锁定工作流当前使用的形态。
>
> 修复见证：更新后的断言本身——把该 job 的 self-hosted 步骤还原为旧 `npx` 形态必须使其变红。
>
> </details>
>
> _— qwen3.8-max via Qwen Code /review (v0.22.2)_

## 实施摘要

- 已修复并验证：12
- 已修复待验证：0
- 无需修改：1
- 需要维护者判断：0
- 受阻：0
- 待实施：0

本地实现基于远端 PR HEAD `01d319c1fe`，保持未提交、未暂存；本轮没有 commit、push、GitHub 回复或 thread resolution。修改 12 个源码/测试/workflow 文件，并刷新本报告。

## 实施批次

### F1. 收敛 home path 脱敏与独立残留检测

- 对应评论：2
- 修改：`export-transcript-document.ts` 一次全局脱敏 POSIX/Windows home 结构并加强独立残留检测；更新 home 绕过回归。
- 验证：`cd packages/cli && npx vitest run src/ui/utils/export/markdown-document-policy.test.ts src/ui/utils/export/export-transcript-document.test.ts`，46/46。
- 状态：已修复并验证

### F2. 让 rich-task 复杂度回退参与 completeness

- 对应评论：3
- 修改：为 rich-task transform 增加 complexity callback，并接入 ExportBudget completeness。
- 验证：Markdown unit callback + ExportTranscriptDocument 端到端 fallback 回归，包含在 CLI 46/46。
- 状态：已修复并验证

### F3. 显式记录文件附件内容损失

- 对应评论：4
- 修改：发现 `block.files` 时添加 `file_attachment_excluded` completeness diagnostic 与 content-loss 标记。
- 验证：resource attachment 真实记录回归，包含在 CLI 46/46。
- 状态：已修复并验证

### F4. 先脱敏再执行 label/schema 长度限制

- 对应评论：5
- 修改：label 脱敏后重新限长；metadata label 统一使用同一路径。
- 验证：200 字符增长边界不再抛 schema 错误，包含在 CLI 46/46。
- 状态：已修复并验证

### F5. 用结构复杂度预检替代原始 marker 总数

- 对应评论：6、12
- 修改：围栏感知结构预检替代原始 marker 总数，限制强调符、括号/blockquote 深度与缩进。
- 验证：emphasis/indent fail-closed 与 342 行平铺日志保留测试；Markdown 7/7。
- 状态：已修复并验证

### F6. 保证 Markdown URL 写回可往返

- 对应评论：7
- 修改：inline link 与 definition 使用 angle-bracket destination 写回。
- 验证：URL/definition 往返回归、CLI 46/46、Chromium 4/4。
- 状态：已修复并验证

### F7. 保留合并工具调用的取消语义

- 对应评论：8
- 修改：`mergeToolCall` 传播 `wasCancelled`。
- 验证：`transcriptToMessages.test.ts` 与 `ToolGroup.test.tsx`，249/249。
- 状态：已修复并验证

### F8. 渲染 delete-only file diff

- 对应评论：9
- 修改：oldText/newText 任一存在即可构造 unified diff。
- 验证：delete-only diff 回归，包含在 Web Shell 249/249。
- 状态：已修复并验证

### F9. 更新真实 npm 发布包体积预算

- 对应评论：10
- 修改：发布包默认预算与测试同步到 128MiB。
- 验证：package-assets 34/34；真实 `npm run bundle && npm run prepare:package` 成功。
- 状态：已修复并验证

### F10. 为 nightly job 安装两个 Playwright Chromium revision

- 对应评论：11
- 修改：nightly browser job 安装 root 与 nested 两个 Chromium revision。
- 验证：workflow contract；scripts 两文件 46 passed/2 skipped。
- 状态：已修复并验证

### F11. 更新 Playwright workflow contract 测试

- 对应评论：13
- 修改：更新 hosted/self-hosted Playwright 安装断言并锁定 nightly dual-tree。
- 验证：预修复 no-ak 单文件 1 failed；修复后 scripts 两文件 46 passed/2 skipped。
- 状态：已修复并验证

## 总体验证

- `npm run build && npm run typecheck`：通过。
- 聚焦 ESLint、Prettier、`git diff --check`：通过。
- CLI Export/Markdown：46/46。
- Web Shell adapter/ToolGroup：249/249。
- Workflow/package scripts：46 passed，2 个平台条件跳过。
- Transcript contract + Chromium document gate：7/7。
- 真实 npm 发布准备：通过。
