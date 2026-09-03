import {
  DAEMON_ERROR_KINDS,
  type DaemonErrorKind,
  type DaemonPermissionTranscriptBlock,
  type DaemonShellTranscriptBlock,
  type DaemonStatusTranscriptBlock,
  type DaemonTextTranscriptBlock,
  type DaemonToolPreview,
  type DaemonToolResultPreview,
  type DaemonToolTranscriptBlock,
  type DaemonTodoListPreview,
  type DaemonTranscriptBlock,
  type DaemonUiPermissionOption,
  type DaemonUserShellTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { SchemaValidator } from '@qwen-code/qwen-code-core';
import { projectChatRecordsToDaemonTranscript } from '@qwen-code/sdk/daemon/transcript';
import type { ExportSessionData } from './types.js';
import exportTranscriptDocumentV1Schema from './export-transcript-document-v1.schema.json' with { type: 'json' };
import { escapeJsonForHtmlScriptData } from './html-script-data.js';
import {
  countRichMarkdownTasks,
  sanitizeMarkdownDocument,
  transformRichMarkdownTasks,
} from './markdown-document-policy.js';

export const EXPORT_TRANSCRIPT_LIMITS_V1 = Object.freeze({
  maxBlocks: 1_000,
  maxTextBytes: 400 * 1024,
  maxVisibleTextBytes: 8 * 1024 * 1024,
  maxRasterBytes: 8 * 1024 * 1024,
  maxTotalRasterBytes: 16 * 1024 * 1024,
  maxEnvelopeBytes: 32 * 1024 * 1024,
  maxObjectDepth: 16,
  maxObjectProperties: 1_000,
  maxArrayLength: 1_000,
  maxRichRenderTasks: 100,
});

export interface ExportTranscriptDiagnosticV1 {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly count: number;
}

export interface ExportMetadataPresentationV1 {
  readonly title?: string;
  readonly startedAt?: string;
  readonly exportedAt: string;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly projectName?: string;
  readonly repository?: string;
  readonly gitBranch?: string;
  readonly model?: string;
  readonly channel?: string;
  readonly promptCount?: number;
  readonly contextUsagePercent?: number;
  readonly contextWindowSize?: number;
  readonly totalTokens?: number;
  readonly filesWritten?: number;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
}

type DaemonPromptCancelledTranscriptBlock = Extract<
  DaemonTranscriptBlock,
  { kind: 'prompt_cancelled' }
>;

type ExportBlockBaseKeys =
  | 'id'
  | 'kind'
  | 'clientReceivedAt'
  | 'createdAt'
  | 'updatedAt';

type ExportPermissionOptionV1 = Pick<
  DaemonUiPermissionOption,
  'optionId' | 'label' | 'description'
> & { raw: null };

interface ExportTranscriptQuestionOptionV1 {
  label: string;
  description?: string;
  raw: null;
}

interface ExportTranscriptQuestionV1 {
  header?: string;
  question: string;
  options: ExportTranscriptQuestionOptionV1[];
  raw: null;
}

type ToolPreviewOf<K extends DaemonToolPreview['kind']> = Extract<
  DaemonToolPreview,
  { kind: K }
>;
type ToolPreviewPick<
  K extends DaemonToolPreview['kind'],
  P extends keyof ToolPreviewOf<K>,
> = Pick<ToolPreviewOf<K>, 'kind' | P>;
type ExportTodoListPreviewV1 = ToolPreviewPick<
  'todo_list',
  'entries' | 'truncated' | 'planId' | 'revision'
>;
type ExportToolPreviewV1 =
  | { kind: 'ask_user_question'; questions: ExportTranscriptQuestionV1[] }
  | ToolPreviewPick<'command', 'command' | 'cwd'>
  | ToolPreviewPick<'file_diff', 'path' | 'oldText' | 'newText' | 'patch'>
  | ToolPreviewPick<'file_read', 'path' | 'range'>
  | ToolPreviewPick<'web_fetch', 'url' | 'method'>
  | ToolPreviewPick<'mcp_invocation', 'serverId' | 'toolName' | 'argsSummary'>
  | ToolPreviewPick<'code_block', 'language' | 'code' | 'origin'>
  | ToolPreviewPick<'search', 'query' | 'resultCount' | 'top'>
  | ToolPreviewPick<'tabular', 'columns' | 'rows' | 'totalRows'>
  | ToolPreviewPick<'image_generation', 'prompt' | 'thumbnailUrl' | 'model'>
  | ToolPreviewPick<
      'subagent_delegation',
      'agentName' | 'task' | 'parentDelegationId'
    >
  | ToolPreviewPick<'key_value', 'rows'>
  | ExportTodoListPreviewV1
  | ToolPreviewPick<'generic', 'summary'>;
type ExportToolResultPreviewV1 =
  | ExportTodoListPreviewV1
  | { kind: 'text'; text: string }
  | { kind: 'generic'; summary: string };

export type ExportPermissionResolutionV1 =
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'resolved';

type ExportTextTranscriptBlockBaseV1 = Pick<
  DaemonTextTranscriptBlock,
  | Exclude<ExportBlockBaseKeys, 'kind'>
  | 'text'
  | 'images'
  | 'collapsed'
  | 'parentToolCallId'
> & { streaming?: false };
type ExportTextTranscriptBlockV1 =
  | (ExportTextTranscriptBlockBaseV1 & { kind: 'user' | 'thought' })
  | (ExportTextTranscriptBlockBaseV1 & {
      kind: 'assistant';
      usage?: DaemonTextTranscriptBlock['usage'];
    });
type ExportToolTranscriptBlockV1 = Pick<
  DaemonToolTranscriptBlock,
  | ExportBlockBaseKeys
  | 'toolCallId'
  | 'title'
  | 'toolName'
  | 'toolKind'
  | 'parentToolCallId'
  | 'parentBlockId'
  | 'subagentType'
  | 'background'
> & {
  status: 'completed' | 'failed' | 'cancelled' | 'canceled';
  preview: ExportToolPreviewV1;
  resultPreview?: ExportToolResultPreviewV1;
};
type ExportShellTranscriptBlockV1 = Pick<
  DaemonShellTranscriptBlock,
  ExportBlockBaseKeys | 'text' | 'stream'
>;
type ExportUserShellTranscriptBlockV1 = Pick<
  DaemonUserShellTranscriptBlock,
  ExportBlockBaseKeys | 'text' | 'command' | 'cwd' | 'stream'
>;
type ExportPermissionTranscriptBlockV1 = Pick<
  DaemonPermissionTranscriptBlock,
  | ExportBlockBaseKeys
  | 'requestId'
  | 'title'
  | 'toolCallId'
  | 'toolName'
  | 'toolKind'
> & {
  options: ExportPermissionOptionV1[];
  preview: ExportToolPreviewV1;
  resolved?: ExportPermissionResolutionV1;
};
type ExportStatusTranscriptBlockV1 = Pick<
  DaemonStatusTranscriptBlock,
  | Exclude<ExportBlockBaseKeys, 'kind'>
  | 'text'
  | 'code'
  | 'errorKind'
  | 'source'
> & {
  kind: 'status' | 'error';
};
type ExportPromptCancelledTranscriptBlockV1 = Pick<
  DaemonPromptCancelledTranscriptBlock,
  ExportBlockBaseKeys | 'reason'
>;

export type ExportTranscriptBlockV1 =
  | ExportTextTranscriptBlockV1
  | ExportToolTranscriptBlockV1
  | ExportShellTranscriptBlockV1
  | ExportUserShellTranscriptBlockV1
  | ExportPermissionTranscriptBlockV1
  | ExportStatusTranscriptBlockV1
  | ExportPromptCancelledTranscriptBlockV1;

export interface ExportTranscriptDocumentV1 {
  readonly schemaVersion: 1;
  readonly rendererVersion: string;
  readonly blocks: readonly ExportTranscriptBlockV1[];
  readonly diagnostics: readonly ExportTranscriptDiagnosticV1[];
  readonly metadata: ExportMetadataPresentationV1;
}

export interface CreateExportTranscriptDocumentOptions {
  readonly rendererVersion: string;
  readonly exportedAt: string;
  readonly title?: string;
}

export class ExportTranscriptDocumentError extends Error {
  constructor(readonly code: string) {
    super(`Cannot create export transcript document: ${code}.`);
    this.name = 'ExportTranscriptDocumentError';
  }
}

export function createExportTranscriptDocumentV1(
  records: readonly unknown[],
  sessionData: Pick<ExportSessionData, 'startTime' | 'metadata'>,
  options: CreateExportTranscriptDocumentOptions,
): ExportTranscriptDocumentV1 {
  if (!isSafeRendererVersion(options.rendererVersion)) {
    throw new ExportTranscriptDocumentError('invalid_renderer_version');
  }
  if (!isIsoDate(options.exportedAt)) {
    throw new ExportTranscriptDocumentError('invalid_exported_at');
  }

  const diagnostics = new DiagnosticCounter();
  const policy = applyRecordExportPolicy(records, diagnostics);
  const projection = projectChatRecordsToDaemonTranscript(policy.records, {
    maxBlocks: EXPORT_TRANSCRIPT_LIMITS_V1.maxBlocks,
  });
  for (const item of projection.diagnostics) {
    diagnostics.add(item.code, item.severity, 1, item.affectsCompleteness);
  }
  const budget = new ExportBudget(diagnostics);
  const ids = new OpaqueDocumentIds();
  const visibleBlocks = projection.blocks.filter((block) => {
    const sourceRecordIds = block.sourceRecordIds ?? [];
    return (
      sourceRecordIds.length === 0 ||
      sourceRecordIds.some((recordId) => policy.visibleRecordIds.has(recordId))
    );
  });
  const blocks: ExportTranscriptBlockV1[] = [];
  for (const block of visibleBlocks) {
    const checkpoint = budget.checkpoint();
    const safe = sanitizeBlock(block, budget, ids, diagnostics);
    if (budget.cumulativeTextBudgetExceeded) {
      budget.restore(checkpoint);
      break;
    }
    if (safe) blocks.push(safe);
  }
  const initialTruncated = projection.truncated || budget.truncated;
  const metadataPresentation = createMetadataPresentation(
    sessionData,
    options,
    diagnostics,
    budget,
  );
  const truncated = initialTruncated || budget.truncated;
  const degraded =
    !policy.complete ||
    !projection.complete ||
    budget.truncated ||
    diagnostics.hasErrors ||
    diagnostics.hasCompletenessLoss;
  const metadata = {
    ...metadataPresentation,
    complete: !degraded,
    truncated,
  };
  let document: ExportTranscriptDocumentV1 = {
    schemaVersion: 1,
    rendererVersion: options.rendererVersion,
    blocks,
    diagnostics: diagnostics.toArray(),
    metadata,
  };
  document = fitDocumentToEnvelope(document, diagnostics);
  assertExportTranscriptDocumentV1(document);
  return document;
}

function fitDocumentToEnvelope(
  document: ExportTranscriptDocumentV1,
  diagnostics: DiagnosticCounter,
): ExportTranscriptDocumentV1 {
  if (
    serializedEnvelopeBytes(document) <=
    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
  ) {
    return document;
  }
  diagnostics.add('envelope_budget_exceeded', 'warning', 1, true);
  const buildCandidate = (blockCount: number): ExportTranscriptDocumentV1 => ({
    ...document,
    blocks: document.blocks.slice(0, blockCount),
    diagnostics: diagnostics.toArray(),
    metadata: { ...document.metadata, complete: false, truncated: true },
  });
  let low = 0;
  let high = document.blocks.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      serializedEnvelopeBytes(buildCandidate(middle)) <=
      EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const fitted = buildCandidate(low);
  if (
    serializedEnvelopeBytes(fitted) >
    EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes
  ) {
    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
  }
  return fitted;
}

export function assertExportTranscriptDocumentV1(
  value: unknown,
): asserts value is ExportTranscriptDocumentV1 {
  assertDepthAndArrayBudgets(value);
  const bytes = serializedEnvelopeBytes(value);
  if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes) {
    throw new ExportTranscriptDocumentError('envelope_budget_exceeded');
  }
  const schemaError = SchemaValidator.validateStrict(
    exportTranscriptDocumentV1Schema,
    value,
  );
  if (schemaError) {
    throw new ExportTranscriptDocumentError('schema_validation_failed');
  }
  if (!isRecord(value)) {
    throw new ExportTranscriptDocumentError('schema_validation_failed');
  }
  assertSemanticSafety(value);
  assertDocumentConsistency(value);
  assertNoForbiddenFields(value);
  assertResourceBudgets(value);
}

function applyRecordExportPolicy(
  records: readonly unknown[],
  diagnostics: DiagnosticCounter,
): {
  records: unknown[];
  visibleRecordIds: ReadonlySet<string>;
  complete: boolean;
} {
  const projectionRecords: unknown[] = [];
  const visibleRecordIds = new Set<string>();
  let complete = true;
  for (const record of records) {
    if (!isRecord(record)) {
      diagnostics.add('record_invalid', 'error');
      complete = false;
      continue;
    }
    const type = record['type'];
    const subtype = record['subtype'];
    const acceptedSystemSubtype =
      type === 'system' &&
      typeof subtype === 'string' &&
      VISIBLE_SYSTEM_RECORD_SUBTYPES.has(subtype);
    const visible =
      type === 'user' ||
      type === 'assistant' ||
      type === 'tool_result' ||
      acceptedSystemSubtype;
    if (visible || type === 'system') {
      projectionRecords.push(record);
      const uuid = record['uuid'];
      if (visible && typeof uuid === 'string') visibleRecordIds.add(uuid);
      if (type === 'system' && !acceptedSystemSubtype) {
        diagnostics.add('record_internal_excluded', 'info');
      }
      continue;
    }
    diagnostics.add('record_unknown_excluded', 'error');
    complete = false;
  }
  return { records: projectionRecords, visibleRecordIds, complete };
}

const VISIBLE_SYSTEM_RECORD_SUBTYPES = new Set([
  'slash_command',
  'notification',
  'cron',
  'mid_turn_user_message',
  'realtime_message',
  'goal_state',
  'goal_runtime',
]);

function sanitizeBlock(
  block: DaemonTranscriptBlock,
  budget: ExportBudget,
  ids: OpaqueDocumentIds,
  diagnostics: DiagnosticCounter,
): ExportTranscriptBlockV1 | undefined {
  const common = {
    id: ids.get('block', block.id),
    kind: block.kind,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'thought': {
      const text = budget.text(block.text);
      const images = block.images
        ? budget.array(block.images).flatMap((image) => {
            const safe = budget.image(image);
            return safe ? [safe] : [];
          })
        : undefined;
      if (block.files && block.files.length > 0) {
        diagnostics.add(
          'file_attachment_excluded',
          'warning',
          block.files.length,
          true,
        );
        budget.markContentLoss();
      }
      return {
        ...common,
        kind: block.kind,
        text,
        streaming: false,
        ...(block.collapsed ? { collapsed: true } : {}),
        ...(block.parentToolCallId
          ? {
              parentToolCallId: ids.get('tool-call', block.parentToolCallId),
            }
          : {}),
        ...(images && images.length > 0 ? { images } : {}),
        ...(block.kind === 'assistant' && block.usage
          ? {
              usage: {
                inputTokens: safeCount(block.usage.inputTokens),
                outputTokens: safeCount(block.usage.outputTokens),
                ...(block.usage.cachedTokens !== undefined
                  ? { cachedTokens: safeCount(block.usage.cachedTokens) }
                  : {}),
              },
            }
          : {}),
      };
    }
    case 'tool': {
      const status = terminalToolStatus(block.status, diagnostics, budget);
      const toolName = budget.optionalLabel(block.toolName, 128);
      const toolKind = budget.optionalLabel(block.toolKind, 128);
      const subagentType = budget.optionalLabel(block.subagentType, 128);
      let resultPreview = block.resultPreview
        ? sanitizeResultPreview(block.resultPreview, budget, diagnostics, ids)
        : undefined;
      if (
        !resultPreview &&
        block.preview.kind === 'file_diff' &&
        status === 'completed'
      ) {
        resultPreview = {
          kind: 'text',
          text: budget.plainText('File change applied'),
        };
      }
      if (!resultPreview && (status === 'completed' || status === 'failed')) {
        diagnostics.add('tool_result_presentation_missing', 'error');
        budget.markContentLoss();
        resultPreview = {
          kind: 'text',
          text: budget.plainText('[tool result omitted from export]'),
        };
      }
      return {
        ...common,
        kind: 'tool',
        toolCallId: ids.get('tool-call', block.toolCallId),
        title: budget.plainText(block.title),
        status,
        ...(block.background ? { background: true } : {}),
        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
        ...(resultPreview ? { resultPreview } : {}),
        ...(toolName ? { toolName } : {}),
        ...(toolKind ? { toolKind } : {}),
        ...(block.parentToolCallId
          ? {
              parentToolCallId: ids.get('tool-call', block.parentToolCallId),
            }
          : {}),
        ...(block.parentBlockId
          ? { parentBlockId: ids.get('block', block.parentBlockId) }
          : {}),
        ...(subagentType ? { subagentType } : {}),
      };
    }
    case 'shell':
      return {
        ...common,
        kind: 'shell',
        text: budget.plainText(block.text),
        ...(block.stream ? { stream: block.stream } : {}),
      };
    case 'user_shell':
      return {
        ...common,
        kind: 'user_shell',
        text: budget.plainText(block.text),
        command: budget.plainText(block.command),
        ...(block.cwd
          ? { cwd: budget.label(safePath(block.cwd), 400, false) }
          : {}),
        ...(block.stream ? { stream: block.stream } : {}),
      };
    case 'permission': {
      const toolName = budget.optionalLabel(block.toolName, 128);
      const toolKind = budget.optionalLabel(block.toolKind, 128);
      const resolution = block.resolved
        ? classifyPermissionResolutionForExport(block.resolved, block.options)
        : undefined;
      if (resolution?.lossy) {
        diagnostics.add('permission_resolution_sanitized', 'warning', 1, true);
        budget.markContentLoss();
      }
      return {
        ...common,
        kind: 'permission',
        requestId: ids.get('permission', block.requestId),
        title: budget.plainText(block.title),
        options: budget.array(block.options).map((option) => ({
          optionId: ids.get('permission-option', option.optionId),
          label: budget.plainText(option.label),
          ...(option.description
            ? { description: budget.plainText(option.description) }
            : {}),
          raw: null,
        })),
        preview: sanitizeToolPreview(block.preview, budget, diagnostics, ids),
        ...(block.toolCallId
          ? { toolCallId: ids.get('tool-call', block.toolCallId) }
          : {}),
        ...(toolName ? { toolName } : {}),
        ...(toolKind ? { toolKind } : {}),
        ...(resolution ? { resolved: resolution.value } : {}),
      };
    }
    case 'status':
    case 'error': {
      const code = budget.optionalLabel(block.code, 128);
      const errorKind = safeExportErrorKind(block.errorKind);
      const source = budget.optionalLabel(block.source, 128);
      return {
        ...common,
        kind: block.kind,
        text: budget.text(block.text),
        ...(code ? { code } : {}),
        ...(errorKind ? { errorKind } : {}),
        ...(source ? { source } : {}),
      };
    }
    case 'prompt_cancelled':
      return {
        ...common,
        kind: 'prompt_cancelled',
        ...(block.reason ? { reason: budget.plainText(block.reason) } : {}),
      };
    case 'debug':
      diagnostics.add('debug_block_excluded', 'info');
      return undefined;
    default:
      return assertNever(block);
  }
}

function sanitizeToolPreview(
  preview: DaemonToolPreview,
  budget: ExportBudget,
  diagnostics: DiagnosticCounter,
  ids: OpaqueDocumentIds,
): ExportToolPreviewV1 {
  switch (preview.kind) {
    case 'ask_user_question':
      return {
        kind: preview.kind,
        questions: budget.array(preview.questions).map((question) => {
          const header = budget.optionalLabel(question.header, 200);
          return {
            ...(header ? { header } : {}),
            question: budget.plainText(question.question),
            options: budget.array(question.options).map((option) => ({
              label: budget.plainText(option.label),
              ...(option.description
                ? { description: budget.plainText(option.description) }
                : {}),
              raw: null,
            })),
            raw: null,
          };
        }),
      };
    case 'command':
      return {
        kind: preview.kind,
        command: budget.plainText(preview.command),
        ...(preview.cwd
          ? { cwd: budget.label(safePath(preview.cwd), 400, false) }
          : {}),
      };
    case 'file_diff':
      return {
        kind: preview.kind,
        path: budget.label(safePath(preview.path), 400, false),
        ...(preview.oldText !== undefined
          ? { oldText: budget.plainText(preview.oldText) }
          : {}),
        ...(preview.newText !== undefined
          ? { newText: budget.plainText(preview.newText) }
          : {}),
        ...(preview.patch !== undefined
          ? { patch: budget.plainText(preview.patch) }
          : {}),
      };
    case 'file_read': {
      const range = preview.range
        ? ([safeCount(preview.range[0]), safeCount(preview.range[1])] as [
            number,
            number,
          ])
        : undefined;
      return {
        kind: preview.kind,
        path: budget.label(safePath(preview.path), 400, false),
        ...(range ? { range } : {}),
      };
    }
    case 'web_fetch': {
      const method = budget.optionalLabel(preview.method, 16);
      return {
        kind: preview.kind,
        url: budget.plainText(
          safeDisplayUrl(preview.url, diagnostics, () =>
            budget.markContentLoss(),
          ),
        ),
        ...(method ? { method } : {}),
      };
    }
    case 'mcp_invocation':
      return {
        kind: preview.kind,
        serverId: budget.label(preview.serverId, 128),
        toolName: budget.label(preview.toolName, 128),
        ...(preview.argsSummary
          ? { argsSummary: budget.plainText(preview.argsSummary) }
          : {}),
      };
    case 'code_block': {
      const language = budget.optionalLabel(preview.language, 64);
      const origin = preview.origin
        ? budget.optionalLabel(safePath(preview.origin), 400, false)
        : undefined;
      return {
        kind: preview.kind,
        code: budget.plainText(preview.code),
        ...(language ? { language } : {}),
        ...(origin ? { origin } : {}),
      };
    }
    case 'search':
      return {
        kind: preview.kind,
        query: budget.plainText(preview.query),
        ...(preview.resultCount !== undefined
          ? { resultCount: safeCount(preview.resultCount) }
          : {}),
        ...(preview.top
          ? {
              top: budget
                .array(preview.top)
                .map((item) => budget.plainText(item)),
            }
          : {}),
      };
    case 'tabular':
      return {
        kind: preview.kind,
        columns: budget
          .array(preview.columns)
          .map((item) => budget.plainText(item)),
        rows: budget
          .array(preview.rows)
          .map((row) =>
            budget.array(row).map((item) => budget.plainText(item)),
          ),
        ...(preview.totalRows !== undefined
          ? { totalRows: safeCount(preview.totalRows) }
          : {}),
      };
    case 'image_generation': {
      const model = budget.optionalLabel(preview.model, 128);
      const thumbnailUrl =
        preview.thumbnailUrl !== undefined
          ? budget.dataImageUrl(preview.thumbnailUrl)
          : undefined;
      return {
        kind: preview.kind,
        prompt: budget.plainText(preview.prompt),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(model ? { model } : {}),
      };
    }
    case 'subagent_delegation':
      return {
        kind: preview.kind,
        agentName: budget.label(preview.agentName, 128),
        task: budget.plainText(preview.task),
        ...(preview.parentDelegationId
          ? {
              parentDelegationId: ids.get(
                'tool-call',
                preview.parentDelegationId,
              ),
            }
          : {}),
      };
    case 'key_value':
      return {
        kind: preview.kind,
        rows: budget.array(preview.rows).map((row) => ({
          label: budget.plainText(row.label),
          value: budget.plainText(row.value),
        })),
      };
    case 'todo_list':
      return sanitizeTodoPreview(preview, budget, ids);
    case 'generic':
      return {
        kind: preview.kind,
        ...(preview.summary
          ? { summary: budget.plainText(preview.summary) }
          : {}),
      };
    default:
      return assertNever(preview);
  }
}

function sanitizeResultPreview(
  preview: DaemonToolResultPreview,
  budget: ExportBudget,
  _diagnostics: DiagnosticCounter,
  ids: OpaqueDocumentIds,
): ExportToolResultPreviewV1 | undefined {
  if (preview.kind === 'todo_list') {
    return sanitizeTodoPreview(preview, budget, ids);
  }
  if (preview.kind === 'text') {
    return { kind: 'text', text: budget.text(preview.text) };
  }
  if (!preview.summary?.trim()) return undefined;
  const summary = budget.text(preview.summary);
  return summary.trim()
    ? { kind: 'generic', summary }
    : { kind: 'text', text: summary };
}

function sanitizeTodoPreview(
  preview: DaemonTodoListPreview,
  budget: ExportBudget,
  ids: OpaqueDocumentIds,
): ExportTodoListPreviewV1 {
  if (preview.truncated) budget.markTruncated('todo_preview_truncated');
  return {
    kind: 'todo_list',
    entries: budget.array(preview.entries).map((entry) => ({
      id: ids.get('todo', entry.id),
      content: budget.plainText(entry.content),
      status: entry.status,
      ...(entry.priority ? { priority: entry.priority } : {}),
      ...(entry.blockedBy
        ? {
            blockedBy: budget
              .array(entry.blockedBy)
              .map((item) => ids.get('todo', item)),
          }
        : {}),
    })),
    ...(preview.truncated ? { truncated: true } : {}),
    ...(preview.planId ? { planId: ids.get('plan', preview.planId) } : {}),
    ...(preview.revision !== undefined
      ? { revision: safeCount(preview.revision) }
      : {}),
  };
}

function terminalToolStatus(
  status: string,
  diagnostics: DiagnosticCounter,
  budget: ExportBudget,
): ExportToolTranscriptBlockV1['status'] {
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
  ) {
    return status;
  }
  diagnostics.add('tool_status_frozen', 'warning', 1, true);
  budget.markContentLoss();
  return 'cancelled';
}

function createMetadataPresentation(
  sessionData: Pick<ExportSessionData, 'startTime' | 'metadata'>,
  options: CreateExportTranscriptDocumentOptions,
  diagnostics: DiagnosticCounter,
  budget: ExportBudget,
): Omit<ExportMetadataPresentationV1, 'complete' | 'truncated'> {
  const metadata = sessionData.metadata;
  const title = safeMetadataLabel(
    options.title,
    200,
    'title',
    diagnostics,
    budget,
  );
  const gitBranch = safeMetadataLabel(
    metadata?.gitBranch,
    200,
    'git_branch',
    diagnostics,
    budget,
  );
  const model = safeMetadataLabel(
    metadata?.model,
    200,
    'model',
    diagnostics,
    budget,
  );
  const channel = safeMetadataLabel(
    metadata?.channel,
    100,
    'channel',
    diagnostics,
    budget,
  );
  const projectName = metadata?.cwd
    ? safeMetadataLabel(
        safePath(metadata.cwd),
        400,
        'project_name',
        diagnostics,
        budget,
        false,
      )
    : undefined;
  const repository = metadata?.gitRepo
    ? safeRepository(metadata.gitRepo, diagnostics, budget)
    : undefined;
  return {
    ...(title ? { title } : {}),
    ...(isIsoDate(sessionData.startTime)
      ? { startedAt: sessionData.startTime }
      : {}),
    exportedAt: options.exportedAt,
    ...(projectName ? { projectName } : {}),
    ...(repository ? { repository } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(model ? { model } : {}),
    ...(channel ? { channel } : {}),
    ...(metadata ? { promptCount: safeCount(metadata.promptCount) } : {}),
    ...(metadata?.contextUsagePercent !== undefined
      ? {
          contextUsagePercent: Math.min(
            100,
            safeCount(metadata.contextUsagePercent),
          ),
        }
      : {}),
    ...(metadata?.contextWindowSize !== undefined
      ? { contextWindowSize: safeCount(metadata.contextWindowSize) }
      : {}),
    ...(metadata?.totalTokens !== undefined
      ? { totalTokens: safeCount(metadata.totalTokens) }
      : {}),
    ...(metadata?.filesWritten !== undefined
      ? { filesWritten: safeCount(metadata.filesWritten) }
      : {}),
    ...(metadata?.linesAdded !== undefined
      ? { linesAdded: safeCount(metadata.linesAdded) }
      : {}),
    ...(metadata?.linesRemoved !== undefined
      ? { linesRemoved: safeCount(metadata.linesRemoved) }
      : {}),
  };
}

const REQUIRED_TEXT_FALLBACK_RESERVE_BYTES = 64 * 1024;

class ExportBudget {
  visibleTextBytes = 0;
  totalRasterBytes = 0;
  richRenderTasks = 0;
  truncated = false;
  cumulativeTextBudgetExceeded = false;

  constructor(private readonly diagnostics: DiagnosticCounter) {}

  checkpoint(): {
    visibleTextBytes: number;
    totalRasterBytes: number;
    richRenderTasks: number;
  } {
    return {
      visibleTextBytes: this.visibleTextBytes,
      totalRasterBytes: this.totalRasterBytes,
      richRenderTasks: this.richRenderTasks,
    };
  }

  restore(checkpoint: ReturnType<ExportBudget['checkpoint']>): void {
    this.visibleTextBytes = checkpoint.visibleTextBytes;
    this.totalRasterBytes = checkpoint.totalRasterBytes;
    this.richRenderTasks = checkpoint.richRenderTasks;
  }

  array<T>(value: readonly T[]): T[] {
    if (value.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength) {
      this.truncated = true;
      this.diagnostics.add('array_budget_exceeded', 'warning');
    }
    return value.slice(0, EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength);
  }

  markTruncated(code: string): void {
    this.truncated = true;
    this.diagnostics.add(code, 'warning');
  }

  markContentLoss(): void {
    this.truncated = true;
  }

  private homeSafeText(value: string): string {
    const redaction = redactHomePaths(value);
    for (const code of redaction.omissions) this.markTruncated(code);
    const redacted = redaction.text;
    if (!containsUnredactedHomePath(redacted, true)) return redacted;
    this.markTruncated('home_path_omitted');
    return '[home path omitted]';
  }

  label(value: unknown, maxLength: number, redact = true): string {
    const initiallySafe = safeLabel(value, maxLength);
    const redacted = redact ? this.homeSafeText(initiallySafe) : initiallySafe;
    const safe = safeLabel(redacted, maxLength);
    if (initiallySafe !== value || safe !== redacted) {
      this.markTruncated('label_sanitized');
    }
    return this.applyTextBudgetWithFallback(
      safe,
      safeLabel('[content omitted]', maxLength),
    );
  }

  optionalLabel(
    value: unknown,
    maxLength: number,
    redact = true,
  ): string | undefined {
    if (value === undefined || value === '') return undefined;
    return this.label(value, maxLength, redact);
  }

  plainText(value: string): string {
    return this.applyTextBudget(this.homeSafeText(value));
  }

  text(value: string): string {
    value = this.homeSafeText(value);
    const onComplexityLimit = (): void => {
      this.truncated = true;
      this.diagnostics.add('markdown_complexity_exceeded', 'warning', 1, true);
    };
    const replaceImage = (alt: string, source: string | undefined): string => {
      const safeAlt = safeLabel(alt, 200).replace(/([\\[\]])/g, '\\$1');
      const parsed = source ? parseApprovedImageDataUrl(source) : undefined;
      if (parsed && this.image(parsed)) {
        return `![${safeAlt}](${formatApprovedImageDataUrl(parsed)})`;
      }
      this.truncated = true;
      this.diagnostics.add('markdown_image_rejected', 'warning');
      return `[image omitted${safeAlt ? `: ${safeAlt}` : ''}]`;
    };
    const resourceSafeValue = sanitizeMarkdownDocument(value, {
      normalizeUrl: normalizeNavigableUrl,
      replaceImage,
      onUrlChange: (code) => {
        this.truncated = true;
        this.diagnostics.add(code, 'warning', 1, true);
      },
      onComplexityLimit,
    });
    const richTaskSafeValue = transformRichMarkdownTasks(
      resourceSafeValue,
      () => {
        this.richRenderTasks += 1;
        if (
          this.richRenderTasks <= EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks
        ) {
          return true;
        }
        this.diagnostics.add('rich_render_budget_exceeded', 'warning');
        return false;
      },
      onComplexityLimit,
    );
    return this.applyTextBudget(richTaskSafeValue);
  }

  private applyTextBudget(value: string): string {
    return this.applyTextBudgetWithFallback(
      value,
      '[content omitted: export text budget exceeded]',
    );
  }

  private applyTextBudgetWithFallback(value: string, fallback: string): string {
    const bytes = utf8Bytes(value);
    const normalTextLimit =
      EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes -
      REQUIRED_TEXT_FALLBACK_RESERVE_BYTES;
    const perItemExceeded = bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes;
    const cumulativeExceeded = this.visibleTextBytes + bytes > normalTextLimit;
    if (perItemExceeded || cumulativeExceeded) {
      this.truncated = true;
      if (cumulativeExceeded) this.cumulativeTextBudgetExceeded = true;
      this.diagnostics.add('text_budget_exceeded', 'warning');
      const fallbackBytes = utf8Bytes(fallback);
      if (
        this.visibleTextBytes + fallbackBytes <=
        EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes
      ) {
        this.visibleTextBytes += fallbackBytes;
        return fallback;
      }
      return '';
    }
    this.visibleTextBytes += bytes;
    return value;
  }

  image(image: {
    data: string;
    mimeType: string;
  }): { data: string; mimeType: string } | undefined {
    if (!SAFE_RASTER_MIME_TYPES.has(image.mimeType)) {
      this.truncated = true;
      this.diagnostics.add('image_type_rejected', 'warning');
      return undefined;
    }
    const bytes = decodedBase64Bytes(image.data);
    if (
      bytes === undefined ||
      bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
      this.totalRasterBytes + bytes >
        EXPORT_TRANSCRIPT_LIMITS_V1.maxTotalRasterBytes ||
      (image.mimeType === 'image/gif' && isAnimatedGif(image.data))
    ) {
      this.truncated = true;
      this.diagnostics.add('image_budget_or_animation_rejected', 'warning');
      return undefined;
    }
    this.totalRasterBytes += bytes;
    return { data: image.data, mimeType: image.mimeType };
  }

  dataImageUrl(value: string): string | undefined {
    const image = parseApprovedImageDataUrl(value);
    if (!image) {
      this.truncated = true;
      this.diagnostics.add('image_type_rejected', 'warning');
      return undefined;
    }
    return this.image(image) ? formatApprovedImageDataUrl(image) : undefined;
  }
}

const SAFE_RASTER_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function parseApprovedImageDataUrl(
  value: string,
): { data: string; mimeType: string } | undefined {
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(
      value,
    );
  if (!match?.[1] || match[2] === undefined) return undefined;
  return { mimeType: match[1].toLowerCase(), data: match[2] };
}

function formatApprovedImageDataUrl(image: {
  data: string;
  mimeType: string;
}): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

class DiagnosticCounter {
  private readonly entries = new Map<
    string,
    { severity: 'info' | 'warning' | 'error'; count: number }
  >();
  private completenessLost = false;

  add(
    code: string,
    severity: 'info' | 'warning' | 'error',
    count = 1,
    affectsCompleteness = false,
  ): void {
    if (affectsCompleteness) this.completenessLost = true;
    const current = this.entries.get(code);
    if (current) {
      current.count += Math.max(1, count);
      if (severityRank(severity) > severityRank(current.severity)) {
        current.severity = severity;
      }
      return;
    }
    this.entries.set(code, { severity, count: Math.max(1, count) });
  }

  get hasErrors(): boolean {
    return [...this.entries.values()].some((item) => item.severity === 'error');
  }

  get hasCompletenessLoss(): boolean {
    return this.completenessLost;
  }

  toArray(): ExportTranscriptDiagnosticV1[] {
    return [...this.entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, item]) => ({ code, ...item }));
  }
}

class OpaqueDocumentIds {
  private readonly ids = new Map<string, string>();
  private nextOrdinal = 0;

  get(kind: string, nativeId: string): string {
    const key = `${kind}\u0000${nativeId}`;
    let id = this.ids.get(key);
    if (!id) {
      id = `${kind}-${this.nextOrdinal}`;
      this.nextOrdinal += 1;
      this.ids.set(key, id);
    }
    return id;
  }
}

const APPROVED_PERMISSION_TOKENS = new Set([
  'accept',
  'accepted',
  'allow',
  'allow_always',
  'allow_once',
  'allowed',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'proceed',
  'proceed_always_project',
  'proceed_always_user',
  'proceed_once',
  'proceed_once_and_switch_to_default',
  'succeeded',
  'success',
]);

const REJECTED_PERMISSION_TOKENS = new Set([
  'deny',
  'denied',
  'reject',
  'reject_always',
  'reject_once',
  'rejected',
]);

const CANCELLED_PERMISSION_TOKENS = new Set([
  'cancel',
  'canceled',
  'cancelled',
]);

const EXPIRED_PERMISSION_TOKENS = new Set([
  'expired',
  'session_closed',
  'timed_out',
  'timeout',
]);

export function classifyPermissionResolutionForExport(
  resolved: string,
  options: readonly DaemonUiPermissionOption[],
): { value: ExportPermissionResolutionV1; lossy: boolean } {
  const separator = resolved.indexOf(':');
  const primary = (separator === -1 ? resolved : resolved.slice(0, separator))
    .trim()
    .toLowerCase();
  let token = primary;
  if (primary === 'selected' && separator !== -1) {
    const optionId = resolved.slice(separator + 1).trim();
    const option = options.find((candidate) => candidate.optionId === optionId);
    if (!option) return { value: 'resolved', lossy: true };
    const raw = isRecord(option.raw) ? option.raw : undefined;
    token =
      (typeof raw?.['kind'] === 'string'
        ? raw['kind'].trim().toLowerCase()
        : '') || option.optionId.trim().toLowerCase();
  }
  if (APPROVED_PERMISSION_TOKENS.has(token)) {
    return { value: 'approved', lossy: false };
  }
  if (REJECTED_PERMISSION_TOKENS.has(token)) {
    return { value: 'rejected', lossy: false };
  }
  if (CANCELLED_PERMISSION_TOKENS.has(token)) {
    return { value: 'cancelled', lossy: false };
  }
  if (EXPIRED_PERMISSION_TOKENS.has(token)) {
    return { value: 'expired', lossy: false };
  }
  if (token === 'resolved') return { value: 'resolved', lossy: false };
  return { value: 'resolved', lossy: true };
}
const SAFE_EXPORT_ERROR_KINDS = new Set<string>(DAEMON_ERROR_KINDS);

function safeExportErrorKind(
  value: DaemonErrorKind | undefined,
): DaemonErrorKind | undefined {
  return value && SAFE_EXPORT_ERROR_KINDS.has(value) ? value : undefined;
}

const SAFE_IDENTIFIER_LENGTHS = new Map<string, number>([
  ['id', 200],
  ['toolCallId', 200],
  ['requestId', 200],
  ['optionId', 200],
  ['parentToolCallId', 200],
  ['parentBlockId', 200],
  ['subagentType', 200],
  ['source', 128],
  ['planId', 128],
  ['parentDelegationId', 128],
  ['method', 16],
  ['language', 64],
]);
const SAFE_PRESENTATION_IDENTIFIER_LENGTHS = new Map<string, number>([
  ['toolName', 200],
  ['toolKind', 200],
  ['serverId', 128],
  ['agentName', 128],
  ['header', 200],
  ['model', 200],
]);

function assertSemanticSafety(value: Record<string, unknown>): void {
  const metadata = value['metadata'] as ExportMetadataPresentationV1;
  const diagnostics = value['diagnostics'] as ExportTranscriptDiagnosticV1[];
  if (diagnostics.some((diagnostic) => !isSafeLabel(diagnostic.code, 128))) {
    throw new ExportTranscriptDocumentError('invalid_diagnostic');
  }
  for (const [key, maxLength] of [
    ['title', 200],
    ['gitBranch', 200],
    ['model', 200],
    ['channel', 100],
  ] as const) {
    const field = metadata[key];
    if (field !== undefined && !isSafeLabel(field, maxLength)) {
      throw new ExportTranscriptDocumentError('invalid_metadata');
    }
  }
  if (!isIsoDate(metadata.exportedAt)) {
    throw new ExportTranscriptDocumentError('invalid_metadata');
  }
  if (metadata.startedAt !== undefined && !isIsoDate(metadata.startedAt)) {
    throw new ExportTranscriptDocumentError('invalid_metadata');
  }
  if (
    metadata.projectName !== undefined &&
    !isSafeExportPath(metadata.projectName)
  ) {
    throw new ExportTranscriptDocumentError('invalid_metadata');
  }
  if (
    metadata.repository !== undefined &&
    !isSafeRepository(metadata.repository)
  ) {
    throw new ExportTranscriptDocumentError('invalid_metadata');
  }

  const visit = (entry: unknown, key?: string): void => {
    if (typeof entry === 'string') {
      const maxLength = key ? SAFE_IDENTIFIER_LENGTHS.get(key) : undefined;
      if (maxLength !== undefined && !isSafeLabel(entry, maxLength)) {
        throw new ExportTranscriptDocumentError('invalid_block');
      }
      const presentationMaxLength = key
        ? SAFE_PRESENTATION_IDENTIFIER_LENGTHS.get(key)
        : undefined;
      if (
        presentationMaxLength !== undefined &&
        !isSafePresentationLabel(entry, presentationMaxLength)
      ) {
        throw new ExportTranscriptDocumentError('invalid_block');
      }
      if (
        key !== undefined &&
        ['path', 'cwd', 'origin'].includes(key) &&
        !isSafeExportPath(entry)
      ) {
        throw new ExportTranscriptDocumentError('invalid_block');
      }
      if (key === 'url' && !isSafeDisplayUrl(entry)) {
        throw new ExportTranscriptDocumentError('invalid_block');
      }
      return;
    }
    if (Array.isArray(entry)) {
      if (
        key === 'blockedBy' &&
        !entry.every((item) => isSafeLabel(item, 128))
      ) {
        throw new ExportTranscriptDocumentError('invalid_block');
      }
      for (const item of entry) visit(item, key);
      return;
    }
    if (!isRecord(entry)) return;
    if (
      (entry['kind'] === 'status' || entry['kind'] === 'error') &&
      entry['code'] !== undefined &&
      !isSafeLabel(entry['code'], 128)
    ) {
      throw new ExportTranscriptDocumentError('invalid_block');
    }
    for (const [childKey, child] of Object.entries(entry)) {
      visit(child, childKey);
    }
  };
  visit(value['blocks']);
}

function assertDocumentConsistency(value: Record<string, unknown>): void {
  const metadata = value['metadata'] as ExportMetadataPresentationV1;
  const diagnostics = value['diagnostics'] as ExportTranscriptDiagnosticV1[];
  const blocks = value['blocks'] as ExportTranscriptBlockV1[];
  const blockIds = new Set(blocks.map((block) => block.id));
  if (blockIds.size !== blocks.length) {
    throw new ExportTranscriptDocumentError('duplicate_block_id');
  }
  for (const block of blocks) {
    if (
      block.kind === 'tool' &&
      block.parentBlockId !== undefined &&
      !blockIds.has(block.parentBlockId)
    ) {
      throw new ExportTranscriptDocumentError('invalid_block_reference');
    }
  }
  if (metadata.complete && metadata.truncated) {
    throw new ExportTranscriptDocumentError('invalid_metadata_state');
  }
  const hasError = diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error',
  );
  const hasCompletenessDiagnostic = diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === 'error' ||
      (diagnostic.severity === 'warning' &&
        diagnostic.code !== 'rich_render_budget_exceeded'),
  );
  const hasTruncationDiagnostic = diagnostics.some((diagnostic) =>
    TRUNCATION_DIAGNOSTIC_CODES.has(diagnostic.code),
  );
  const hasExplicitContentLoss = blocks.some((block) => {
    if (
      block.kind === 'tool' &&
      (block.status === 'completed' || block.status === 'failed') &&
      block.resultPreview === undefined
    ) {
      return true;
    }
    if (block.kind === 'tool') {
      return (
        (block.preview.kind === 'todo_list' &&
          block.preview.truncated === true) ||
        (block.resultPreview?.kind === 'todo_list' &&
          block.resultPreview.truncated === true)
      );
    }
    if (block.kind === 'permission') {
      return (
        block.preview.kind === 'todo_list' && block.preview.truncated === true
      );
    }
    return false;
  });
  if (
    (hasError || hasCompletenessDiagnostic || hasExplicitContentLoss) &&
    metadata.complete
  ) {
    throw new ExportTranscriptDocumentError('invalid_metadata_state');
  }
  if (
    (hasExplicitContentLoss || hasTruncationDiagnostic) &&
    !metadata.truncated
  ) {
    throw new ExportTranscriptDocumentError('invalid_metadata_state');
  }
}

const TRUNCATION_DIAGNOSTIC_CODES = new Set([
  'envelope_budget_exceeded',
  'array_budget_exceeded',
  'todo_preview_truncated',
  'markdown_image_rejected',
  'markdown_complexity_exceeded',
  'text_budget_exceeded',
  'image_type_rejected',
  'image_budget_or_animation_rejected',
  'tool_status_frozen',
  'url_sanitized',
  'url_rejected',
  'repository_url_rejected',
  'repository_rejected',
  'title_rejected',
  'git_branch_rejected',
  'model_rejected',
  'channel_rejected',
  'project_name_rejected',
  'permission_resolution_sanitized',
  'tool_result_presentation_missing',
  'file_attachment_excluded',
  'home_path_omitted',
  'encoded_content_omitted',
  'url_home_path_omitted',
  'label_sanitized',
]);

function assertNoForbiddenFields(value: unknown): void {
  const forbidden = new Set([
    'rawInput',
    'rawOutput',
    'toolCall',
    'details',
    'locations',
    'meta',
    'sessionId',
    'sourceRecordIds',
    'eventId',
    'serverTimestamp',
    'promptId',
    'branchRecordId',
    'debugReason',
  ]);
  const visit = (entry: unknown, key?: string): void => {
    if (typeof entry === 'string') {
      const safePathField =
        key !== undefined &&
        ['path', 'cwd', 'origin', 'projectName', 'repository'].includes(key);
      if (
        key !== 'data' &&
        key !== 'thumbnailUrl' &&
        containsUnredactedHomePath(entry, !safePathField)
      ) {
        throw new ExportTranscriptDocumentError('home_path_forbidden');
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, key);
      return;
    }
    if (!isRecord(entry)) return;
    for (const [key, item] of Object.entries(entry)) {
      if (forbidden.has(key)) {
        throw new ExportTranscriptDocumentError('forbidden_field');
      }
      visit(item, key);
    }
  };
  visit(value);
}

function assertDepthAndArrayBudgets(
  value: unknown,
  depth = 0,
  ancestors = new WeakSet<object>(),
): void {
  if (depth > EXPORT_TRANSCRIPT_LIMITS_V1.maxObjectDepth) {
    throw new ExportTranscriptDocumentError('object_depth_exceeded');
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new ExportTranscriptDocumentError('cyclic_envelope');
    }
    if (value.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength) {
      throw new ExportTranscriptDocumentError('array_budget_exceeded');
    }
    ancestors.add(value);
    for (const item of value) {
      assertDepthAndArrayBudgets(item, depth + 1, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (!isRecord(value)) return;
  if (ancestors.has(value)) {
    throw new ExportTranscriptDocumentError('cyclic_envelope');
  }
  const entries = Object.values(value);
  if (entries.length > EXPORT_TRANSCRIPT_LIMITS_V1.maxObjectProperties) {
    throw new ExportTranscriptDocumentError('object_property_budget_exceeded');
  }
  ancestors.add(value);
  for (const item of entries) {
    assertDepthAndArrayBudgets(item, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function serializedEnvelopeBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new ExportTranscriptDocumentError('invalid_envelope');
    }
    return utf8Bytes(escapeJsonForHtmlScriptData(serialized));
  } catch (error) {
    if (error instanceof ExportTranscriptDocumentError) throw error;
    throw new ExportTranscriptDocumentError('invalid_envelope');
  }
}

function assertResourceBudgets(value: unknown): void {
  let visibleTextBytes = 0;
  let totalRasterBytes = 0;
  let richRenderTasks = 0;
  const visit = (
    entry: unknown,
    key?: string,
    parent?: Record<string, unknown>,
    path: readonly string[] = [],
  ): void => {
    if (typeof entry === 'string') {
      if (key === 'data') return;
      if (key === 'thumbnailUrl') {
        const image = parseApprovedImageDataUrl(entry);
        const bytes = image ? decodedBase64Bytes(image.data) : undefined;
        const canonical = image ? formatApprovedImageDataUrl(image) : undefined;
        if (
          bytes === undefined ||
          bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
          entry !== canonical ||
          (image?.mimeType === 'image/gif' && isAnimatedGif(image.data))
        ) {
          throw new ExportTranscriptDocumentError('invalid_thumbnail_image');
        }
        totalRasterBytes += bytes;
        return;
      }
      const bytes = utf8Bytes(entry);
      if (bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes) {
        throw new ExportTranscriptDocumentError('text_budget_exceeded');
      }
      const markdownText = isMarkdownExportText(key, parent, path);
      if (key && VISIBLE_EXPORT_TEXT_FIELDS.has(key)) {
        visibleTextBytes += bytes;
      }
      if (markdownText) {
        richRenderTasks += countRichMarkdownTasks(entry);
        const sanitized = sanitizeMarkdownDocument(entry, {
          normalizeUrl: normalizeNavigableUrl,
          onUrlChange: () => {
            throw new ExportTranscriptDocumentError('invalid_markdown_url');
          },
          onComplexityLimit: () => {
            throw new ExportTranscriptDocumentError(
              'markdown_complexity_exceeded',
            );
          },
          replaceImage: (alt, source) => {
            const image = source
              ? parseApprovedImageDataUrl(source)
              : undefined;
            const imageBytes = image
              ? decodedBase64Bytes(image.data)
              : undefined;
            if (
              !image ||
              imageBytes === undefined ||
              imageBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
              (image.mimeType === 'image/gif' && isAnimatedGif(image.data))
            ) {
              throw new ExportTranscriptDocumentError('invalid_markdown_image');
            }
            totalRasterBytes += imageBytes;
            const safeAlt = safeLabel(alt, 200).replace(/([\\[\]])/g, '\\$1');
            return `![${safeAlt}](${formatApprovedImageDataUrl(image)})`;
          },
        });
        if (sanitized !== entry) {
          throw new ExportTranscriptDocumentError('invalid_markdown_image');
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, key, parent, path);
      return;
    }
    if (!isRecord(entry)) return;
    if (
      typeof entry['data'] === 'string' &&
      typeof entry['mimeType'] === 'string'
    ) {
      const bytes = decodedBase64Bytes(entry['data']);
      if (
        bytes === undefined ||
        bytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes ||
        !SAFE_RASTER_MIME_TYPES.has(entry['mimeType']) ||
        (entry['mimeType'] === 'image/gif' && isAnimatedGif(entry['data']))
      ) {
        throw new ExportTranscriptDocumentError('raster_budget_exceeded');
      }
      totalRasterBytes += bytes;
    }
    for (const [childKey, item] of Object.entries(entry)) {
      visit(item, childKey, entry, [...path, childKey]);
    }
  };
  visit(value);
  if (visibleTextBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes) {
    throw new ExportTranscriptDocumentError('visible_text_budget_exceeded');
  }
  if (totalRasterBytes > EXPORT_TRANSCRIPT_LIMITS_V1.maxTotalRasterBytes) {
    throw new ExportTranscriptDocumentError('total_raster_budget_exceeded');
  }
  if (richRenderTasks > EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks) {
    throw new ExportTranscriptDocumentError('rich_render_budget_exceeded');
  }
}

function isMarkdownExportText(
  key: string | undefined,
  parent: Record<string, unknown> | undefined,
  path: readonly string[],
): boolean {
  if (path.at(-2) === 'resultPreview') {
    return key === 'text' || key === 'summary';
  }
  return (
    key === 'text' &&
    ['user', 'assistant', 'thought', 'status', 'error'].includes(
      String(parent?.['kind']),
    )
  );
}

function normalizeNavigableUrl(value: string): string | undefined {
  if (value.startsWith('#')) return value;
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (value.includes('\\')) return undefined;
    const queryIndex = value.search(/[?#]/);
    return queryIndex === -1 ? value : value.slice(0, queryIndex);
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'mailto:'
    ) {
      return undefined;
    }
    if (
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    ) {
      return value;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

const VISIBLE_EXPORT_TEXT_FIELDS = new Set([
  'text',
  'title',
  'label',
  'description',
  'command',
  'cwd',
  'question',
  'path',
  'oldText',
  'newText',
  'patch',
  'url',
  'argsSummary',
  'code',
  'origin',
  'query',
  'top',
  'columns',
  'rows',
  'prompt',
  'task',
  'value',
  'content',
  'summary',
  'reason',
  'projectName',
  'repository',
  'gitBranch',
  'model',
  'channel',
]);

function safeDisplayUrl(
  raw: string,
  diagnostics: DiagnosticCounter,
  onContentLoss?: () => void,
): string {
  try {
    const safe = normalizeNavigableUrl(raw);
    if (!safe) throw new Error();
    const url = new URL(safe);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error();
    }
    if (utf8Bytes(safe) > EXPORT_TRANSCRIPT_LIMITS_V1.maxTextBytes) {
      throw new Error();
    }
    if (safe !== raw) {
      diagnostics.add('url_sanitized', 'warning', 1, true);
      onContentLoss?.();
    }
    return safe;
  } catch {
    diagnostics.add('url_rejected', 'warning', 1, true);
    onContentLoss?.();
    return '[link omitted]';
  }
}

function safeRepository(
  raw: string,
  diagnostics: DiagnosticCounter,
  budget: ExportBudget,
): string {
  if (/^https?:/i.test(raw)) {
    const safe = safeDisplayUrl(raw, diagnostics, () =>
      budget.markContentLoss(),
    );
    if (safe.length <= 200) return budget.plainText(safe);
    diagnostics.add('repository_url_rejected', 'warning', 1, true);
    budget.markContentLoss();
    return budget.plainText('[link omitted]');
  }
  const safe = safePath(raw).replace(/\.git$/i, '');
  if (isSafeLabel(safe, 200)) return budget.label(safe, 200, false);
  diagnostics.add('repository_rejected', 'warning', 1, true);
  budget.markContentLoss();
  return budget.plainText('[link omitted]');
}

function safeMetadataLabel(
  value: unknown,
  maxLength: number,
  field: string,
  diagnostics: DiagnosticCounter,
  budget: ExportBudget,
  redact = true,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (isSafeLabel(value, maxLength)) {
    return budget.label(value, maxLength, redact);
  }
  diagnostics.add(`${field}_rejected`, 'warning', 1, true);
  budget.markContentLoss();
  return undefined;
}

function isSafeDisplayUrl(value: unknown): value is string {
  if (
    value === '[link omitted]' ||
    value === '[content omitted: export text budget exceeded]'
  ) {
    return true;
  }
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      normalizeNavigableUrl(value) === value
    );
  } catch {
    return false;
  }
}

function isSafeRepository(value: unknown): value is string {
  return (
    (typeof value === 'string' &&
      !/^https?:/i.test(value) &&
      isSafeLabel(value, 200) &&
      !/[\\/]/.test(value)) ||
    isSafeDisplayUrl(value)
  );
}

function safePath(value: string): string {
  const normalized = value
    .replaceAll('\\', '/')
    .replace(/^file:\/\/[^/]+\//i, '/')
    .replace(/^file:\/\/\//i, '/')
    .replace(/^file:\//i, '/')
    .replace(/\/+$/, '');
  const components: string[] = [];
  for (const component of normalized.split('/').filter(Boolean)) {
    if (component === '.') continue;
    if (component === '..') {
      if (
        components.length > 0 &&
        !(components.length === 1 && /^[A-Za-z]:$/.test(components[0]))
      ) {
        components.pop();
      }
      continue;
    }
    components.push(component);
  }
  const homeIndex = components.findIndex((component) =>
    /^(?:Users|home)$/i.test(component),
  );
  if (homeIndex !== -1 && components[homeIndex + 1] !== undefined) {
    const homeBasename = components.at(-1);
    if (components.length === homeIndex + 2) return '[home]';
    return homeBasename && homeBasename !== '.' && homeBasename !== '..'
      ? homeBasename
      : '[path]';
  }
  const basename = components.at(-1);
  return basename && !/^[A-Za-z]:$/.test(basename) ? basename : '[path]';
}

function isSafeExportPath(value: unknown): value is string {
  return (
    isSafePresentationLabel(value, 400) &&
    !/[\\/]/.test(String(value)) &&
    !/^[A-Za-z]:$/.test(String(value))
  );
}

const EXPORT_URL_PATTERN =
  /\b(?:https?:\/\/[^\s<>"\x60]+|data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/gi;
const HOME_USERNAME_SEGMENT_SOURCE = String.raw`(?:[^/\\\t\r\n<>]+(?=[/\\])|[^/\\\s<>]+)`;
const FILE_HOME_PATH_SOURCE = String.raw`file:\/+(?:[^/\s]+\/)?(?:[A-Za-z]:\/)?(?:\.\/|\/)*(?:home|Users)\/(?:\.\/|\/)*${HOME_USERNAME_SEGMENT_SOURCE}`;
const LOCAL_HOME_PATH_SOURCE = String.raw`(?:[A-Za-z]:)?(?:[\\/](?:\.[\\/]|[\\/])*)+(?:home|Users)[\\/](?:\.[\\/]|[\\/])*${HOME_USERNAME_SEGMENT_SOURCE}`;
const BARE_HOME_ROOT_SOURCE = String.raw`(?:[A-Za-z]:)?(?:[\\/](?:\.[\\/]|[\\/])*)+(?:home|Users)[\\/](?=$|\s|[<>"'\x60,;:|()](?=\s|$))`;
const RELATIVE_HOME_PATH_SOURCE = String.raw`(^|[\r\n])(?:home|Users)[\\/](?:\.[\\/]|[\\/])*${HOME_USERNAME_SEGMENT_SOURCE}`;
const RELATIVE_HOME_ROOT_SOURCE = String.raw`(^|[\r\n])(?:home|Users)[\\/](?=$|\s|[<>"'\x60,;:|()](?=\s|$))`;
const FILE_HOME_PATH_PATTERN = new RegExp(FILE_HOME_PATH_SOURCE, 'gi');
const LOCAL_HOME_PATH_PATTERN = new RegExp(LOCAL_HOME_PATH_SOURCE, 'gi');
const BARE_HOME_ROOT_PATTERN = new RegExp(BARE_HOME_ROOT_SOURCE, 'gi');
const RELATIVE_HOME_PATH_PATTERN = new RegExp(RELATIVE_HOME_PATH_SOURCE, 'gim');
const RELATIVE_HOME_ROOT_PATTERN = new RegExp(RELATIVE_HOME_ROOT_SOURCE, 'gim');
const ENCODED_CONTENT_OMITTED = '[encoded content omitted]';
const URL_HOME_PATH_OMITTED = '[link omitted]';

interface HomeRedactionResult {
  text: string;
  omissions: string[];
}

function redactHomePaths(value: string): HomeRedactionResult {
  return redactHomePathStructures(value);
}
function redactHomePathStructures(value: string): HomeRedactionResult {
  const urlPattern = EXPORT_URL_PATTERN;
  let result = '';
  let cursor = 0;
  const omissions: string[] = [];
  const append = (redaction: HomeRedactionResult): void => {
    result += redaction.text;
    omissions.push(...redaction.omissions);
  };
  for (const match of value.matchAll(urlPattern)) {
    append(redactNonHttpHomePathStructures(value.slice(cursor, match.index)));
    if (
      match[0].toLowerCase().startsWith('data:image/') &&
      containsNonHttpHomePath(match[0], true)
    ) {
      append(redactNonHttpHomePathStructures(match[0]));
    } else if (shouldOmitHttpUrlToken(match[0])) {
      result += URL_HOME_PATH_OMITTED;
      omissions.push('url_home_path_omitted');
    } else {
      result += match[0];
    }
    cursor = match.index + match[0].length;
  }
  append(redactNonHttpHomePathStructures(value.slice(cursor)));
  return { text: result, omissions };
}

function shouldOmitHttpUrlToken(value: string): boolean {
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
  return (
    authority !== undefined &&
    (hasAmbiguousUrlHomePath(value) ||
      ((normalizeNavigableUrl(value) === undefined ||
        /[(),;|'\\]/.test(authority)) &&
        containsNonHttpHomePath(value, true)))
  );
}

function hasAmbiguousUrlHomePath(value: string): boolean {
  let afterDelimiter = false;
  let parenthesisDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ("?#&,;|'\\".includes(character)) afterDelimiter = true;
    if (character === '(') parenthesisDepth += 1;
    if (character === ')') {
      if (parenthesisDepth > 0) parenthesisDepth -= 1;
      else afterDelimiter = true;
    }
    if (!afterDelimiter || (character !== '/' && character !== '\\')) {
      continue;
    }
    const component = value.slice(index + 1, index + 6).toLowerCase();
    const length = component.startsWith('users')
      ? 5
      : component.startsWith('home')
        ? 4
        : 0;
    const separator = value[index + length + 1];
    const firstUsernameCharacter = value[index + length + 2];
    if (
      length > 0 &&
      (separator === '/' || separator === '\\') &&
      firstUsernameCharacter !== undefined &&
      firstUsernameCharacter !== '/' &&
      firstUsernameCharacter !== '\\' &&
      !/\s/.test(firstUsernameCharacter)
    ) {
      return true;
    }
  }
  return false;
}

function redactNonHttpHomePathStructures(value: string): HomeRedactionResult {
  const rawRedacted = redactRawHomePathStructures(value);
  const decoded = decodePercentText(rawRedacted);
  if (decoded === undefined) {
    return {
      text: ENCODED_CONTENT_OMITTED,
      omissions: ['encoded_content_omitted'],
    };
  }
  const encodedRedacted = containsRawHomePath(decoded)
    ? redactRawHomePathStructures(decoded).replace(
        /(?:\[home\]){2,}/g,
        '[home]',
      )
    : rawRedacted;
  return {
    text: encodedRedacted.replace(
      /file:\/+(?:[^/\s]+\/)?(?:[A-Za-z]:\/)?\[home\]/gi,
      'file://[home]',
    ),
    omissions: [],
  };
}

function redactRawHomePathStructures(value: string): string {
  return value
    .replace(FILE_HOME_PATH_PATTERN, 'file://[home]')
    .replace(BARE_HOME_ROOT_PATTERN, '[home]')
    .replace(LOCAL_HOME_PATH_PATTERN, '[home]')
    .replace(RELATIVE_HOME_ROOT_PATTERN, '$1[home]')
    .replace(RELATIVE_HOME_PATH_PATTERN, '$1[home]');
}

function containsUnredactedHomePath(
  value: string,
  checkPercentEncoding: boolean,
): boolean {
  const urlPattern = EXPORT_URL_PATTERN;
  let cursor = 0;
  for (const match of value.matchAll(urlPattern)) {
    if (shouldOmitHttpUrlToken(match[0])) return true;
    if (
      match[0].toLowerCase().startsWith('data:image/') &&
      containsNonHttpHomePath(match[0], checkPercentEncoding)
    ) {
      return true;
    }
    if (
      containsNonHttpHomePath(
        value.slice(cursor, match.index),
        checkPercentEncoding,
      )
    ) {
      return true;
    }
    cursor = match.index + match[0].length;
  }
  return containsNonHttpHomePath(value.slice(cursor), checkPercentEncoding);
}

function containsNonHttpHomePath(
  value: string,
  checkPercentEncoding: boolean,
): boolean {
  if (containsRawHomePath(value)) return true;
  if (!checkPercentEncoding) return false;
  const decoded = decodePercentText(value);
  return decoded === undefined || containsRawHomePath(decoded);
}

function decodePercentText(value: string): string | undefined {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodePrintablePercentEscapes(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decodePrintablePercentEscapes(decoded) === decoded
    ? decoded
    : undefined;
}

function decodePrintablePercentEscapes(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex) => {
    const code = Number.parseInt(hex, 16);
    return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : escape;
  });
}

function containsRawHomePath(value: string): boolean {
  return redactRawHomePathStructures(value) !== value;
}

function safeLabel(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '[invalid]';
  let safe = '';
  for (const character of value) {
    if (isControlCharacter(character)) continue;
    if (safe.length + character.length > maxLength) break;
    safe += character;
  }
  return safe;
}

function isSafeLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    ![...value].some(isControlCharacter)
  );
}

function isSafePresentationLabel(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    ![...value].some(isControlCharacter)
  );
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code <= 31 || code === 127;
}

function assertNever(value: never): never {
  void value;
  throw new ExportTranscriptDocumentError('unsupported_value');
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
    : 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isSafeRendererVersion(value: unknown): value is string {
  return (
    isSafeLabel(value, 128) &&
    !String(value).includes('latest') &&
    !/[~^*><=]/.test(String(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodedBase64Bytes(value: string): number | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isAnimatedGif(value: string): boolean {
  try {
    const binary = atob(value);
    if (
      binary.length < 13 ||
      (binary.slice(0, 6) !== 'GIF87a' && binary.slice(0, 6) !== 'GIF89a')
    ) {
      return true;
    }
    const logicalScreenPacked = binary.charCodeAt(10);
    let offset = 13;
    if ((logicalScreenPacked & 0x80) !== 0) {
      offset += 3 * 2 ** ((logicalScreenPacked & 0x07) + 1);
    }
    let frames = 0;
    while (offset < binary.length) {
      const marker = binary.charCodeAt(offset);
      offset += 1;
      if (marker === 0x3b) return frames !== 1;
      if (marker === 0x21) {
        if (offset >= binary.length) return true;
        offset += 1;
        const nextOffset = skipGifSubBlocks(binary, offset);
        if (nextOffset === undefined) return true;
        offset = nextOffset;
        continue;
      }
      if (marker !== 0x2c || offset + 9 > binary.length) return true;
      frames += 1;
      if (frames > 1) return true;
      const imagePacked = binary.charCodeAt(offset + 8);
      offset += 9;
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      }
      if (offset >= binary.length) return true;
      offset += 1;
      const nextOffset = skipGifSubBlocks(binary, offset);
      if (nextOffset === undefined) return true;
      offset = nextOffset;
    }
    return true;
  } catch {
    return true;
  }
}

function skipGifSubBlocks(
  binary: string,
  startOffset: number,
): number | undefined {
  let offset = startOffset;
  while (offset < binary.length) {
    const size = binary.charCodeAt(offset);
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > binary.length) return undefined;
    offset += size;
  }
  return undefined;
}

function severityRank(value: 'info' | 'warning' | 'error'): number {
  return value === 'error' ? 2 : value === 'warning' ? 1 : 0;
}
