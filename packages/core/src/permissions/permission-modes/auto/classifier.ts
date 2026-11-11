/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auto-mode AI classifier engine.
 *
 * Sends a compact transcript plus the pending action to an LLM classifier and
 * returns allow/deny. The pipeline is stateless: transcript assembly, system
 * prompt, action formatting and the model call. Runtime inputs (LLM delegate,
 * user rules, standing instructions) arrive as `ClassifierRuntime`. The auto
 * permission pipeline converts an unavailable classifier into deny when a
 * tool requires classification.
 */

import {
  ASK_USER_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from '../../../tools/definitions/base-declarations.js';
import type { ToolDenialKind } from '../../../protocol/schemas/common.js';
import {
  buildClassifierPromptFromSlots,
  FAST_STAGE_SUFFIX,
  THINKING_STAGE_SUFFIX,
} from './classifier-prompt.js';
import {
  buildLlmRecords,
  projectToolInputForLlm,
  renderLlmHistory,
  toolRecordKey,
  toRecordLine,
  type LlmHistoryRecord,
  type TranscriptBlockMark,
} from './llm-transcript.js';
import { estimateTextTokens } from '../../../utils/tokenCalculation.js';
import type {
  Message,
  UserMessage,
} from '../../../protocol/transcript/message.js';

// ============================================================================
// Types
// ============================================================================

export type ClassifierRequestMetadata = {
  model: string;
  requestId?: string;
  serverRequestId?: string;
  messageId?: string;
};

/** Token usage from one classifier API call. */
export type ClassifierUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

/** The route selected for one classification; it does not imply success. */
export type AutoModeClassifierDetails = {
  route: 'jev' | 'jev_fallback_llm' | 'llm';
  fallbackReason?: 'jev-input-too-long' | 'jev-unavailable';
};

/**
 * The classifier's verdict on one action, plus the stats it reports.
 * Two-stage: a fast pass, escalating to a thinking pass when it is unsure.
 */
export type AutoModeClassifierResult = {
  fallbackReason?: AutoModeClassifierDetails['fallbackReason'];
  thinking?: string;
  shouldBlock: boolean;
  reason: string;
  unavailable?: boolean;
  aborted?: boolean;
  /** Classifier output was present but did not match the required schema. */
  parsingError?: boolean;
  /** API returned "prompt is too long" — deterministic, should fall back. */
  transcriptTooLong?: boolean;
  /** The model used for this classifier call */
  model: string;
  usage?: ClassifierUsage;
  durationMs?: number;
  /** Character lengths of the prompt components */
  promptLengths?: {
    systemPrompt: number;
    toolCalls: number;
    userPrompts: number;
  };
  /** Path where error prompts were dumped */
  errorDumpPath?: string;
  /** Which stage produced the final decision */
  stage?: 'fast' | 'thinking';
  /** True when the thinking pass escalated instead of trusting the fast pass. */
  escalated?: boolean;
  /** The fast pass's verdict label, kept for stage diagnostics. */
  stage1Verdict?: ClassifierStageVerdictLabel;
  stage1Usage?: ClassifierUsage;
  stage1DurationMs?: number;
  stage1RequestId?: string;
  stage1ServerRequestId?: string;
  stage1MsgId?: string;
  stage2Usage?: ClassifierUsage;
  stage2DurationMs?: number;
  stage2RequestId?: string;
  stage2ServerRequestId?: string;
  stage2MsgId?: string;
};

/**
 * Host-determined provenance of text that is not the user speaking. Absent on
 * a text block, the text is the user's own input.
 */
export type TranscriptTextSource =
  | { kind: 'compact-summary' }
  | { kind: 'non-user'; origin: string };

/** The options a user answered from, so a bare label keeps its meaning. */
export interface UserAnswerQuestionContext {
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string; preview?: string }>;
}

/**
 * A single transcript block for the classifier.
 */
export type TranscriptBlock =
  | { type: 'text'; text: string; source?: TranscriptTextSource }
  | { type: 'proposal'; text: string }
  | {
      type: 'user_answer';
      toolUseId: string;
      question: string;
      questionContext?: UserAnswerQuestionContext;
      answer: string | string[];
      notes?: string;
    }
  | { type: 'tool_use'; id?: string; name: string; input: unknown }
  | {
      type: 'outcome';
      id: string;
      name: string;
      input: unknown;
      resultInfo: { outcome: ClassifierToolOutcome };
    };

export type ClassifierToolOutcome =
  | 'ok'
  | 'error'
  | 'interrupted'
  | 'rejected-by-user'
  | 'blocked-by-permissions'
  | 'automode-blocked'
  | 'automode-unavailable'
  | 'automode-parsing-error';

/**
 * A transcript entry (one turn in the conversation).
 */
export type TranscriptEntry = {
  role: 'user' | 'assistant';
  content: TranscriptBlock[];
};

/**
 * Minimal message interface for building transcripts.
 * Compatible with our message types without tight coupling.
 */
export interface ClassifierMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        is_error?: boolean;
      }>;
  toolUseResult?: unknown;
  toolDenialKind?: ToolDenialKind | Array<ToolDenialKind | undefined>;
  uuid?: string;
  /** Host-stamped origin, as `MessageOrigin` or its legacy string form. */
  origin?: unknown;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  commandMode?: string;
  /** Present when the message is a queued command delivered mid-turn. */
  queuedCommand?: { sourceUuid?: string };
  /** The task a parent agent delegated; written by a model, not the user. */
  delegatedTask?: boolean;
  /** Meta text relaying a decision the user made in host UI. */
  userDecision?: boolean;
}

/**
 * Tool interface for classifier input encoding.
 */
export interface ClassifierToolLookup {
  get(
    name: string,
  ): { toAutoClassifierInput(input: unknown): unknown } | undefined;
}

/**
 * Creates an empty classifier tool lookup for callers that only need the
 * transcript/action classifier path and have no tool-specific input projector.
 */
export function createEmptyToolLookup(): ClassifierToolLookup {
  return {
    get() {
      return undefined;
    },
  };
}

/**
 * The delegate function for invoking the LLM.
 * Decoupled from model inference to keep this module portable and testable.
 */
export type ClassifierInvokeFn = (options: {
  systemPrompt: string;
  userPrompt: string;
  abortSignal: AbortSignal;
  /**
   * Which stage this call serves. The fast pre-pass may only allow, so it is
   * not worth retrying; the thinking pass is authoritative.
   */
  stage?: 'fast' | 'thinking';
  onRequestMetadata?: (metadata: ClassifierRequestMetadata) => void;
}) => Promise<{
  shouldBlock: boolean;
  reason: string;
  parsingError?: boolean;
}>;

/**
 * User-supplied classifier customization read from trusted settings.
 *
 * These rules are injected into the classifier's system prompt as SOFT
 * guidance only — they never bypass the classifier. The classifier itself
 * remains the final authority on each decision.
 *
 * Security model (autoMode rules):
 * - Read only from trusted settings sources (userSettings, localSettings).
 * - projectSettings is intentionally excluded: a malicious project could
 *   otherwise inject classifier allow rules to escalate privileges.
 * - Each entry is a natural-language description, length-capped to prevent
 *   prompt pollution.
 */
export interface AutoModeUserConfig {
  /** ALLOW exceptions, appended after the built-in ones. */
  allow?: string[];
  /** SOFT BLOCK rules, appended after the built-in ones. */
  soft_deny?: string[];
  /** HARD BLOCK rules, appended after the built-in ones. */
  hard_deny?: string[];
  /** Environment entries, appended after the built-in defaults. */
  environment?: string[];
}

/**
 * Delegate that returns user-supplied auto-mode rules. Returns undefined
 * when no trusted settings provide any rules, in which case the prompt
 * falls back to its built-in instructions.
 */
export type GetAutoModeUserConfigFn = () => AutoModeUserConfig | undefined;

/** Returns the user's own standing instructions, or undefined when none exist. */
export type GetAutoModeUserInstructionsFn = () => string | undefined;

/**
 * Per-entry maximum length. Caps total prompt growth and limits the impact
 * of any single malformed entry. Entries longer than this are truncated.
 */
export const AUTO_MODE_RULE_MAX_LENGTH = 200;

/**
 * Maximum number of entries per section. Sections with more entries are
 * truncated. Keeps the system prompt bounded even with adversarial input.
 */
export const AUTO_MODE_RULE_MAX_COUNT = 20;

// ============================================================================
// Classifier Runtime (session state, supplied by AutoClassifier)
// ============================================================================

/**
 * The three things a classifier run reads that are session state rather than
 * arguments to the call being judged.
 *
 * `AutoClassifier` builds one per run from the delegates installed on it, so the
 * values are always the current session's: a settings edit or a memory change
 * takes effect on the next call without a restart, and two sessions in one
 * process never read each other's rules.
 */
export interface ClassifierRuntime {
  /** The LLM delegate, or null when the host never wired auto mode up. */
  readonly invokeFn: ClassifierInvokeFn | null;
  /** The user's own `autoMode` rules, undefined when trusted settings have none. */
  readonly userConfig: AutoModeUserConfig | undefined;
  /** The user's standing instructions, undefined when there are none. */
  readonly userInstructions: string | undefined;
}

// ============================================================================
// Transcript Building
// ============================================================================

/**
 * Build transcript entries from conversation messages: the shared extraction
 * both classifier adapters read.
 *
 * Who wrote a message is decided from host fields before any text is read.
 * Compaction summaries, notifications, other agents and delegated tasks stay as
 * background tagged with their source; host-generated meta text is dropped.
 * Tool results contribute their outcome whichever message carries them, and
 * tool-result bodies and ordinary assistant prose never enter. With
 * `includeConfirmationContext`, assistant text the user directly replied to is
 * kept as a `proposal` and host-verified answers as `user_answer`.
 */
export function buildTranscriptEntries(
  messages: readonly ClassifierMessage[],
  includeConfirmationContext = false,
): TranscriptEntry[] {
  return extractTranscript(messages, includeConfirmationContext).entries;
}

/** The shared transcript, plus where each user-side block came from. */
function extractTranscript(
  messages: readonly ClassifierMessage[],
  includeConfirmationContext: boolean,
): { entries: TranscriptEntry[]; marks: Map<TranscriptBlock, TranscriptBlockMark> } {
  const sources = resolveMessageSources(messages);
  const transcript: TranscriptEntry[] = [];
  const marks = new Map<TranscriptBlock, TranscriptBlockMark>();
  const toolUsesById = new Map<string, { name: string; input: unknown }>();

  for (const [index, msg] of messages.entries()) {
    if (!isClassifierMessage(msg)) continue;
    const source = sources[index];
    if (source.kind === 'duplicate') continue;

    if (msg.role === 'user') {
      const userBlocks: TranscriptBlock[] = [];
      const mark: TranscriptBlockMark = {
        message: index,
        queued: msg.queuedCommand !== undefined,
        decision: msg.userDecision === true,
      };
      const textSource = source.kind === 'context' ? source.source : undefined;
      const pushText = (text: string) => {
        if (!text || source.kind === 'excluded') return;
        const block: TranscriptBlock = textSource
          ? { type: 'text', text, source: textSource }
          : { type: 'text', text };
        marks.set(block, mark);
        userBlocks.push(block);
      };
      if (typeof msg.content === 'string') {
        pushText(msg.content);
      } else if (Array.isArray(msg.content)) {
        const toolResultCount = msg.content.filter(
          (block) => block?.type === 'tool_result',
        ).length;
        let toolResultIndex = 0;
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            pushText(block.text);
            continue;
          }
          if (
            block.type === 'tool_result' &&
            typeof block.tool_use_id === 'string'
          ) {
            const toolUse = toolUsesById.get(block.tool_use_id);
            const metadataIndex = toolResultIndex++;
            if (!toolUse) continue;

            const toolUseResult = getToolResultMetadata(
              msg.toolUseResult,
              metadataIndex,
              toolResultCount,
            );
            const denialKind = getToolDenialKindMetadata(
              msg.toolDenialKind,
              metadataIndex,
            );
            const outcome = classifyToolOutcome({
              denialKind,
              isError: block.is_error === true,
              toolUseResult,
            });
            // Only the built-in question tool's successful host-produced
            // result can contribute user answers. Never trust model-prefilled
            // answers in tool input or arbitrary tool-result text.
            if (
              includeConfirmationContext &&
              toolUse.name === ASK_USER_TOOL_NAME &&
              (toolResultCount === 1 || Array.isArray(msg.toolUseResult)) &&
              outcome === 'ok'
            ) {
              for (const answer of extractUserAnswers(
                block.tool_use_id,
                toolUse.input,
                toolUseResult,
              )) {
                marks.set(answer, mark);
                userBlocks.push(answer);
              }
            }
            userBlocks.push({
              type: 'outcome',
              id: block.tool_use_id,
              name: toolUse.name,
              input: toolUse.input,
              resultInfo: { outcome },
            });
          }
        }
      }
      if (userBlocks.length > 0) {
        transcript.push({ role: 'user', content: userBlocks });
      }
    } else {
      const blocks: TranscriptBlock[] = [];
      if (
        includeConfirmationContext &&
        isRepliedToByUser(messages, sources, index)
      ) {
        const text =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((b) => b?.type === 'text')
                  .map((b) => b.text ?? '')
                  .join('\n')
              : '';
        if (text) blocks.push({ type: 'proposal', text });
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          // Only include tool_use blocks — assistant text is model-authored
          // and could be crafted to influence the classifier's decision.
          if (
            block &&
            typeof block === 'object' &&
            block.type === 'tool_use' &&
            block.name
          ) {
            const input =
              includeConfirmationContext && block.name === ASK_USER_TOOL_NAME
                ? {
                    questions: (block.input as { questions?: unknown } | null)
                      ?.questions,
                  }
                : block.input;
            blocks.push({
              type: 'tool_use',
              id: typeof block.id === 'string' ? block.id : undefined,
              name: block.name,
              input,
            });
            if (typeof block.id === 'string') {
              toolUsesById.set(block.id, {
                name: block.name,
                input,
              });
            }
          }
        }
      }
      if (blocks.length > 0) {
        transcript.push({ role: 'assistant', content: blocks });
      }
    }
  }

  return { entries: omitRoutineHistoryTools(transcript), marks };
}

type MessageSource =
  | { kind: 'assistant' }
  | { kind: 'user' }
  | { kind: 'context'; source: TranscriptTextSource }
  | { kind: 'excluded' }
  | { kind: 'duplicate' };

function isClassifierMessage(msg: unknown): msg is ClassifierMessage {
  if (!msg || typeof msg !== 'object') return false;
  const { role, content } = msg as ClassifierMessage;
  return (role === 'user' || role === 'assistant') && content != null;
}

/**
 * Origins the host stamps on its own meta text inside a turn — skill and
 * command expansions, hook continuations, recovery nudges, SDK synthetic
 * messages. Meta text carrying one of these is host-generated, not typed.
 */
const HOST_META_ORIGIN_KINDS = new Set(['human', 'bridge', 'auto-continuation']);

/** Origins that, on non-meta text, mean a user actually submitted it. */
const USER_ORIGIN_KINDS = new Set(['human', 'bridge']);

const ORIGIN_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/i;

function resolveOriginKind(msg: ClassifierMessage): string | undefined {
  let origin = msg.origin;
  if (typeof origin === 'string') {
    try {
      origin = JSON.parse(origin) as unknown;
    } catch {
      // A bare kind name.
    }
  }
  if (origin === undefined || origin === null) {
    return msg.commandMode === 'task-notification'
      ? 'task-notification'
      : undefined;
  }
  const kind =
    typeof origin === 'string'
      ? origin
      : typeof origin === 'object'
        ? (origin as { kind?: unknown }).kind
        : undefined;
  return typeof kind === 'string' && ORIGIN_KIND_PATTERN.test(kind)
    ? kind
    : 'unclassified';
}

function classifyMessageSource(msg: ClassifierMessage): MessageSource {
  if (msg.role === 'assistant') return { kind: 'assistant' };
  if (msg.delegatedTask === true) {
    return { kind: 'context', source: { kind: 'non-user', origin: 'delegated-task' } };
  }
  if (msg.isCompactSummary === true) {
    return { kind: 'context', source: { kind: 'compact-summary' } };
  }
  const kind = resolveOriginKind(msg);
  if (msg.isMeta === true) {
    if (
      msg.userDecision === true &&
      (kind === undefined || USER_ORIGIN_KINDS.has(kind))
    ) {
      return { kind: 'user' };
    }
    return kind === undefined || HOST_META_ORIGIN_KINDS.has(kind)
      ? { kind: 'excluded' }
      : { kind: 'context', source: { kind: 'non-user', origin: kind } };
  }
  // A message with no origin at all predates origin stamping; it was typed.
  if (kind === undefined || USER_ORIGIN_KINDS.has(kind)) return { kind: 'user' };
  return { kind: 'context', source: { kind: 'non-user', origin: kind } };
}

/**
 * One source per message. A queued command that was also recorded as an
 * ordinary user message, or queued twice, is the same submission: kept once,
 * matched by the host's uuid and never by text.
 */
function resolveMessageSources(
  messages: readonly ClassifierMessage[],
): MessageSource[] {
  const submitted = new Set<string>();
  for (const msg of messages) {
    if (
      isClassifierMessage(msg) &&
      msg.role === 'user' &&
      !msg.queuedCommand &&
      typeof msg.uuid === 'string'
    ) {
      submitted.add(msg.uuid);
    }
  }
  const queued = new Set<string>();
  return messages.map((msg): MessageSource => {
    if (!isClassifierMessage(msg)) return { kind: 'excluded' };
    const sourceUuid = msg.queuedCommand?.sourceUuid;
    if (typeof sourceUuid === 'string' && sourceUuid) {
      if (submitted.has(sourceUuid) || queued.has(sourceUuid)) {
        return { kind: 'duplicate' };
      }
      queued.add(sourceUuid);
    }
    return classifyMessageSource(msg);
  });
}

function hasText(content: ClassifierMessage['content']): boolean {
  if (typeof content === 'string') return !!content.trim();
  return (
    Array.isArray(content) &&
    content.some((b) => b?.type === 'text' && !!b.text?.trim())
  );
}

/**
 * True when the next contributing message after `index` is the user's own
 * text. Host meta text in between is skipped; a tool result, an assistant
 * turn, or text from any other source means the user did not reply to it.
 */
function isRepliedToByUser(
  messages: readonly ClassifierMessage[],
  sources: readonly MessageSource[],
  index: number,
): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (!isClassifierMessage(msg)) continue;
    const source = sources[i];
    if (source.kind === 'assistant') return false;
    if (source.kind === 'duplicate') continue;
    const text = hasText(msg.content);
    if (source.kind === 'user' && text) return true;
    const toolResult =
      Array.isArray(msg.content) &&
      msg.content.some((b) => b?.type === 'tool_result');
    if (toolResult || (text && source.kind !== 'excluded')) return false;
  }
  return false;
}

function extractUserAnswers(
  toolUseId: string,
  input: unknown,
  toolUseResult: unknown,
): TranscriptBlock[] {
  const questions = (input as { questions?: unknown } | null)?.questions;
  const result = toolUseResult as {
    answers?: Record<string, unknown>;
    annotations?: Record<string, { notes?: unknown }>;
  } | null;
  const answers = result?.answers;
  if (
    !Array.isArray(questions) ||
    !answers ||
    typeof answers !== 'object' ||
    Array.isArray(answers)
  ) {
    return [];
  }
  const blocks: TranscriptBlock[] = [];
  for (const item of questions as Array<{ question?: unknown } | null>) {
    if (typeof item?.question !== 'string') continue;
    const answer = Object.hasOwn(answers, item.question)
      ? answers[item.question]
      : undefined;
    const notes = result?.annotations?.[item.question]?.notes;
    if (
      (typeof notes === 'string' && notes.trim()) ||
      (typeof answer === 'string' && answer.trim()) ||
      (Array.isArray(answer) &&
        answer.length &&
        answer.every((v) => typeof v === 'string' && v.trim()))
    ) {
      const questionContext = getQuestionContext(item);
      blocks.push({
        type: 'user_answer',
        toolUseId,
        question: item.question,
        ...(questionContext ? { questionContext } : {}),
        answer:
          typeof answer === 'string' ||
          (Array.isArray(answer) && answer.every((v) => typeof v === 'string'))
            ? answer
            : '',
        ...(typeof notes === 'string' ? { notes } : {}),
      });
    }
  }
  return blocks;
}

/** The question's own framing, taken field by field so nothing else rides along. */
function getQuestionContext(
  item: object,
): UserAnswerQuestionContext | undefined {
  const { header, multiSelect, options } = item as Record<string, unknown>;
  const context: UserAnswerQuestionContext = {};
  if (typeof header === 'string' && header) context.header = header;
  if (typeof multiSelect === 'boolean') context.multiSelect = multiSelect;
  if (Array.isArray(options)) {
    const projected = options.flatMap((option: unknown) => {
      if (!option || typeof option !== 'object') return [];
      const { label, description, preview } = option as Record<
        string,
        unknown
      >;
      if (typeof label !== 'string') return [];
      return [
        {
          label,
          ...(typeof description === 'string' ? { description } : {}),
          ...(typeof preview === 'string' ? { preview } : {}),
        },
      ];
    });
    if (projected.length > 0) context.options = projected;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * Read-only lookups whose past calls say nothing about whether a later action
 * is sanctioned. The CLI's `mcp_list` / `mcp_get` are its lazy tool discovery.
 */
const HISTORY_SKIP_TOOLS = new Set<string>([
  READ_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  'mcp_list',
  'mcp_get',
]);

/** A refused lookup stays: it records what the user or a policy disallowed. */
const DENIAL_OUTCOMES = new Set<ClassifierToolOutcome>([
  'rejected-by-user',
  'blocked-by-permissions',
  'automode-blocked',
  'automode-unavailable',
  'automode-parsing-error',
]);

/**
 * Drops routine lookup calls from history, the call and its outcome together
 * by call id. Applies to history only; the action under review is separate.
 */
function omitRoutineHistoryTools(
  transcript: TranscriptEntry[],
): TranscriptEntry[] {
  const denied = new Set<string>();
  for (const entry of transcript) {
    for (const block of entry.content) {
      if (
        block.type === 'outcome' &&
        HISTORY_SKIP_TOOLS.has(block.name) &&
        DENIAL_OUTCOMES.has(block.resultInfo.outcome)
      ) {
        denied.add(block.id);
      }
    }
  }
  const omitted = (block: TranscriptBlock) =>
    (block.type === 'tool_use' || block.type === 'outcome') &&
    HISTORY_SKIP_TOOLS.has(block.name) &&
    (block.id === undefined || !denied.has(block.id));
  return transcript.flatMap((entry) => {
    const content = entry.content.filter((block) => !omitted(block));
    if (content.length === entry.content.length) return [entry];
    return content.length > 0 ? [{ ...entry, content }] : [];
  });
}

function getToolResultMetadata(
  value: unknown,
  index: number,
  resultCount: number,
): unknown {
  return resultCount > 1 && Array.isArray(value) ? value[index] : value;
}

function getToolDenialKindMetadata(
  value: ClassifierMessage['toolDenialKind'],
  index: number,
): ToolDenialKind | undefined {
  const candidate = Array.isArray(value) ? value[index] : value;
  switch (candidate) {
    case 'user-rejected':
    case 'permission-rule':
    case 'automode-blocked':
    case 'automode-unavailable':
    case 'automode-parsing-error':
      return candidate;
    default:
      return undefined;
  }
}

function classifyToolOutcome(options: {
  denialKind?: ToolDenialKind;
  isError: boolean;
  toolUseResult: unknown;
}): ClassifierToolOutcome {
  switch (options.denialKind) {
    case 'user-rejected':
      return 'rejected-by-user';
    case 'permission-rule':
      return 'blocked-by-permissions';
    case 'automode-blocked':
    case 'automode-unavailable':
    case 'automode-parsing-error':
      return options.denialKind;
    default:
      break;
  }

  if (
    options.toolUseResult &&
    typeof options.toolUseResult === 'object' &&
    'interrupted' in options.toolUseResult &&
    options.toolUseResult.interrupted === true
  ) {
    return 'interrupted';
  }
  return options.isError ? 'error' : 'ok';
}

// ============================================================================
// Approval Snapshot
// ============================================================================

/**
 * What one approval reads, captured once when it starts. Every classifier
 * route for that approval — LLM fast and thinking passes, Jev, the fallback
 * and the shadow comparison — reads this one value, so a message appended, an
 * input or setting mutated, or a tool definition swapped mid-approval can
 * never reach only some of them.
 *
 * Everything is the snapshot's own deep-frozen copy. Tool projections are run
 * here, once: the current action both routes send, and the LLM's history
 * records. No route consults the live tool registry afterwards.
 */
export interface ClassifierSnapshot {
  readonly runtime: ClassifierRuntime;
  /** The shared extraction; Jev projects it into its own history. */
  readonly transcript: readonly TranscriptEntry[];
  readonly toolName: string;
  readonly input: unknown;
  /** The current action as Jev sends it; '' when the tool gave none. */
  readonly action: string;
  /** The LLM route's history, one record per line, with its budget facts. */
  readonly llmRecords: readonly LlmHistoryRecord[];
  /** The LLM route's history as normally sent, within its budget. */
  readonly llmTranscript: string;
  /**
   * The current action as the LLM route's last transcript record, in the
   * history record format without an id; '' when the tool gave none.
   */
  readonly llmAction: string;
}

export function createClassifierSnapshot(
  runtime: ClassifierRuntime,
  messages: readonly ClassifierMessage[],
  toolName: string,
  input: unknown,
  toolLookup: ClassifierToolLookup,
): ClassifierSnapshot {
  // Cloned together so each mark stays keyed by the copy of its block.
  const { entries, marks } = structuredClone(extractTranscript(messages, true));
  const transcript = deepFreeze(entries);
  const llmRecords = deepFreeze(buildLlmRecords(transcript, toolLookup, marks));
  const ownInput = deepFreeze(structuredClone(input));
  return Object.freeze({
    runtime: Object.freeze({
      ...runtime,
      userConfig: deepFreeze(structuredClone(runtime.userConfig)),
    }),
    transcript,
    toolName,
    input: ownInput,
    action: formatActionForClassifier(toolName, ownInput, toolLookup),
    llmRecords,
    llmTranscript: renderLlmHistory(llmRecords, 'normal'),
    llmAction: formatActionRecordForLlm(toolName, ownInput, toolLookup),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ============================================================================
// LLM Adapter
// ============================================================================

/**
 * The LLM classifier's full view of the shared transcript, one JSON record per
 * line and nothing left out; see `buildLlmRecords` for the record shapes.
 */
export function serializeTranscriptForLlm(
  transcript: readonly TranscriptEntry[],
  lookup: ClassifierToolLookup,
): string {
  return renderLlmHistory(buildLlmRecords(transcript, lookup), 'full');
}

/**
 * The pending action as the LLM transcript's closing record: projected like a
 * past call, but with no id since it has not run.
 */
export function formatActionRecordForLlm(
  toolName: string,
  input: unknown,
  lookup: ClassifierToolLookup,
): string {
  const projection = projectToolInputForLlm(toolName, input, lookup);
  if (projection === '') return '';
  return `${toRecordLine({ [toolRecordKey(toolName)]: projection })}\n`;
}

/**
 * Build the LLM classifier's transcript string from messages.
 */
export function buildTranscriptForClassifier(
  messages: readonly ClassifierMessage[],
  toolLookup: ClassifierToolLookup,
): string {
  return serializeTranscriptForLlm(
    buildTranscriptEntries(messages, true),
    toolLookup,
  );
}

// ============================================================================
// Action Formatting
// ============================================================================

/**
 * Format a tool action for the classifier to evaluate.
 */
export function formatActionForClassifier(
  toolName: string,
  input: unknown,
  toolLookup: ClassifierToolLookup,
): string {
  const tool = toolLookup.get(toolName);
  let encoded: unknown;
  if (tool) {
    try {
      encoded = tool.toAutoClassifierInput(input) ?? input;
    } catch {
      encoded = input;
    }
  } else {
    encoded = input;
  }
  if (encoded === '') return '';
  const s = typeof encoded === 'string' ? encoded : JSON.stringify(encoded);
  return `${toolName} ${s}\n`;
}

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Build the system prompt for the auto mode classifier.
 *
 * User-supplied environment / hard_deny / soft_deny / allow entries join the
 * matching rule slot after the built-in entries; they never replace them.
 *
 * Pure: the session's own rules arrive through the parameter, read by
 * `AutoClassifier.buildSystemPrompt` from its delegate.
 */
export function buildClassifierSystemPrompt(
  userConfig?: AutoModeUserConfig,
): string {
  return buildClassifierPromptFromSlots({
    environment: sanitizeRules(userConfig?.environment),
    hardDeny: sanitizeRules(userConfig?.hard_deny),
    softDeny: sanitizeRules(userConfig?.soft_deny),
    allow: sanitizeRules(userConfig?.allow),
  });
}

/**
 * Sanitize user-supplied rule entries: drop non-strings and empties, trim,
 * and cap entry length and count to bound prompt growth.
 *
 * This path keeps valid entries when some are malformed; the settings-file
 * path rejects the whole array so misconfiguration is visible.
 */
function sanitizeRules(rules: string[] | undefined): string[] {
  if (!Array.isArray(rules)) return [];
  const cleaned: string[] = [];
  for (const raw of rules) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    cleaned.push(
      trimmed.length > AUTO_MODE_RULE_MAX_LENGTH
        ? trimmed.slice(0, AUTO_MODE_RULE_MAX_LENGTH)
        : trimmed,
    );
    if (cleaned.length >= AUTO_MODE_RULE_MAX_COUNT) break;
  }
  return cleaned;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Classify whether a tool action should be allowed or blocked in auto mode.
 *
 * @param snapshot - The approval's runtime, shared transcript and action
 * @param signal - Abort signal
 * @param collectRequestMetadata Collect request IDs for an active shadow comparison
 * @returns AutoModeClassifierResult indicating the decision
 */
export async function classifyAutoModeAction(
  snapshot: ClassifierSnapshot,
  signal: AbortSignal,
  collectRequestMetadata = false,
): Promise<AutoModeClassifierResult> {
  const { runtime, toolName, llmAction } = snapshot;
  // Check if invoke function is available
  const invokeFn = runtime.invokeFn;
  if (!invokeFn) {
    return {
      shouldBlock: true,
      reason: 'Classifier invoke function not configured',
      model: 'none',
      unavailable: true,
    };
  }

  if (llmAction === '') {
    // Fail-closed: if a non-allowlisted tool provides no classifier input,
    // we cannot evaluate its safety. Block to prevent bypass via empty input.
    return {
      shouldBlock: true,
      reason: `Tool "${toolName}" did not provide classifier input and cannot be auto-approved`,
      model: 'configured',
    };
  }

  const systemPrompt = buildClassifierSystemPrompt(runtime.userConfig);

  const instructionsBlock = buildUserInstructionsBlock(runtime.userInstructions);
  const buildUserPrompt = (history: string) =>
    instructionsBlock +
    `<transcript>\n${history}${llmAction}</transcript>\n\n` +
    `Evaluate the last record of the transcript, the action under review. ` +
    `Should it be blocked?`;
  let userPrompt = buildUserPrompt(snapshot.llmTranscript);

  // A request the model reports too long gets one retry per approval, with the
  // recovery history; every later call, either stage, keeps that history.
  let recoveryUsed = false;
  const invokeStage = async (stage: 'fast' | 'thinking') => {
    const suffix = stage === 'fast' ? FAST_STAGE_SUFFIX : THINKING_STAGE_SUFFIX;
    const run = () =>
      invokeClassifierStage(invokeFn, {
        systemPrompt,
        userPrompt: `${userPrompt}${suffix}`,
        signal,
        stage,
        collectRequestMetadata,
      });
    const outcome = await run();
    if (
      outcome.kind !== 'transcriptTooLong' ||
      recoveryUsed ||
      signal.aborted
    ) {
      return outcome;
    }
    recoveryUsed = true;
    const recovery = renderLlmHistory(snapshot.llmRecords, 'recovery');
    // Its notice can outweigh what it drops; a request no smaller cannot fit.
    if (
      estimateTextTokens(recovery) >=
      estimateTextTokens(snapshot.llmTranscript)
    ) {
      return outcome;
    }
    userPrompt = buildUserPrompt(recovery);
    return run();
  };

  const start = Date.now();

  // Stage 1: a cheap pre-pass that may only clear an action. Most auto-mode
  // traffic is unremarkable, so clearing it here avoids the deliberate pass
  // entirely; anything it does not clear is escalated rather than trusted.
  const stage1 = await invokeStage('fast');
  const stage1Metadata = stage1.metadata;
  const stage1Details = stage1Metadata && {
    stage1RequestId: stage1Metadata.requestId,
    stage1ServerRequestId: stage1Metadata.serverRequestId,
    stage1MsgId: stage1Metadata.messageId,
  };

  if (
    stage1.kind === 'verdict' &&
    !stage1.shouldBlock &&
    !stage1.parsingError
  ) {
    return {
      shouldBlock: false,
      reason: stage1.reason,
      model: stage1Metadata?.model ?? 'configured',
      durationMs: Date.now() - start,
      stage: 'fast',
      escalated: false,
      stage1Verdict: 'allow',
      ...stage1Details,
    };
  }

  if (stage1.kind === 'transcriptTooLong') {
    return {
      shouldBlock: true,
      reason: stage1.reason,
      model: stage1Metadata?.model ?? 'configured',
      transcriptTooLong: true,
      unavailable: true,
      durationMs: Date.now() - start,
      stage: 'fast',
      escalated: false,
      stage1Verdict: 'transcript_too_long',
      ...stage1Details,
    };
  }

  if (stage1.kind === 'aborted') {
    return {
      shouldBlock: true,
      reason: stage1.reason,
      model: stage1Metadata?.model ?? 'configured',
      unavailable: true,
      aborted: true,
      durationMs: Date.now() - start,
      stage: 'fast',
      escalated: false,
      stage1Verdict: 'aborted',
      ...stage1Details,
    };
  }

  // Stage 2: the authoritative pass. Only this stage may conclude that an
  // action must be blocked.
  //
  // An unparseable verdict is usually a one-off formatting slip, so it is worth
  // re-asking before treating it as a refusal: denying on the first malformed
  // answer turns a formatting glitch into a blocked action.
  // What stage 1 concluded, kept for the record: telling "stage 2 overturned a
  // block" apart from "stage 1 could not answer" is the whole point of tracking
  // whether the cheap pass earns its place.
  const stage1Verdict: ClassifierStageVerdictLabel =
    stage1.kind === 'verdict'
      ? stage1.parsingError
        ? 'unparseable'
        : 'block'
      : 'error';

  let stage2 = await invokeStage('thinking');
  let parseRetries = 0;
  for (
    let attempt = 0;
    attempt < THINKING_STAGE_PARSE_RETRIES &&
    stage2.kind === 'verdict' &&
    stage2.parsingError;
    attempt++
  ) {
    parseRetries++;
    stage2 = await invokeStage('thinking');
  }
  const durationMs = Date.now() - start;
  const stage2Metadata = stage2.metadata;
  const escalationFacts = {
    escalated: true as const,
    stage1Verdict,
    parseRetries,
    ...stage1Details,
    ...(stage2Metadata && {
      stage2RequestId: stage2Metadata.requestId,
      stage2ServerRequestId: stage2Metadata.serverRequestId,
      stage2MsgId: stage2Metadata.messageId,
    }),
  };

  if (stage2.kind === 'verdict') {
    return {
      shouldBlock: stage2.shouldBlock,
      reason: stage2.reason,
      parsingError: stage2.parsingError,
      model: stage2Metadata?.model ?? 'configured',
      durationMs,
      stage: 'thinking',
      ...escalationFacts,
    };
  }

  if (stage2.kind === 'transcriptTooLong') {
    return {
      shouldBlock: true,
      reason: stage2.reason,
      model: stage2Metadata?.model ?? 'configured',
      transcriptTooLong: true,
      unavailable: true,
      durationMs,
      stage: 'thinking',
      ...escalationFacts,
    };
  }

  // Stage 2 could not answer. Stage 1 had already declined to clear the action,
  // so keep that assessment instead of handing an action that already looked
  // unsafe back for approval.
  if (stage1.kind === 'verdict' && stage1.shouldBlock) {
    return {
      shouldBlock: true,
      reason: 'Stage 2 classifier error — blocking based on stage 1 assessment',
      model: stage1Metadata?.model ?? 'configured',
      durationMs,
      stage: 'fast',
      ...escalationFacts,
    };
  }

  return {
    shouldBlock: true,
    reason: stage2.reason,
    model: stage2Metadata?.model ?? 'configured',
    unavailable: true,
    ...(stage2.kind === 'aborted' ? { aborted: true } : {}),
    durationMs,
    stage: 'thinking',
    ...escalationFacts,
  };
}

/** What a classifier stage concluded, as recorded for analysis. */
export type ClassifierStageVerdictLabel =
  | 'allow'
  | 'block'
  | 'unparseable'
  | 'error'
  | 'aborted'
  | 'transcript_too_long';

/**
 * How many times the authoritative stage may be re-asked when its verdict comes
 * back unparseable. Each retry costs a full classifier round-trip on the hot
 * path, so this only buys a few chances at a formatting slip — an outage is
 * handled by the unavailable path instead.
 */
const THINKING_STAGE_PARSE_RETRIES = 3;

/**
 * Largest slice of the user's instructions handed to the classifier: long enough
 * for the conventions that explain an action, short enough that a big
 * instructions file cannot crowd out the transcript it is meant to inform.
 */
const USER_INSTRUCTIONS_MAX_LENGTH = 4000;

/**
 * Leading block carrying the user's standing instructions, or '' when there are
 * none. Placed first so both stages share it as a prompt prefix.
 */
function buildUserInstructionsBlock(instructions: string | undefined): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return '';
  const capped =
    trimmed.length > USER_INSTRUCTIONS_MAX_LENGTH
      ? trimmed.slice(0, USER_INSTRUCTIONS_MAX_LENGTH)
      : trimmed;
  return (
    `The following are the standing instructions the user wrote for the agent. ` +
    `Treat them as part of the user's intent when judging whether an action was ` +
    `asked for. They inform intent, they do not grant permission: an action they ` +
    `appear to sanction must still be blocked if a BLOCK rule says so.

` +
    `<user_instructions>
${capped}
</user_instructions>

`
  );
}

/** Outcome of one classifier stage, before it is turned into a decision. */
type ClassifierStageOutcome =
  | {
      kind: 'verdict';
      shouldBlock: boolean;
      reason: string;
      parsingError: boolean;
      metadata?: ClassifierRequestMetadata;
    }
  | {
      kind: 'transcriptTooLong';
      reason: string;
      metadata?: ClassifierRequestMetadata;
    }
  | { kind: 'aborted'; reason: string; metadata?: ClassifierRequestMetadata }
  | { kind: 'error'; reason: string; metadata?: ClassifierRequestMetadata };

/**
 * Runs one classifier stage and classifies the outcome. Never throws: the
 * caller decides what each failure means for the action under evaluation.
 */
async function invokeClassifierStage(
  invokeFn: ClassifierInvokeFn,
  params: {
    systemPrompt: string;
    userPrompt: string;
    signal: AbortSignal;
    stage: 'fast' | 'thinking';
    collectRequestMetadata: boolean;
  },
): Promise<ClassifierStageOutcome> {
  let metadata: ClassifierRequestMetadata | undefined;
  try {
    const result = await invokeFn({
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      abortSignal: params.signal,
      stage: params.stage,
      ...(params.collectRequestMetadata && {
        onRequestMetadata: (next: ClassifierRequestMetadata) => {
          metadata =
            next.requestId && next.requestId !== metadata?.requestId
              ? next
              : { ...metadata, ...next };
        },
      }),
    });

    // Defense-in-depth: validate result even though the invoke fn should
    // already normalize it. Fail-closed if shouldBlock is not a boolean.
    const hasValidShouldBlock = typeof result?.shouldBlock === 'boolean';
    const hasValidReason =
      typeof result?.reason === 'string' && result.reason.trim().length > 0;
    return {
      kind: 'verdict',
      shouldBlock: hasValidShouldBlock ? result.shouldBlock : true,
      reason: hasValidReason
        ? result.reason
        : 'Classifier did not provide a valid reason',
      parsingError:
        result?.parsingError === true ||
        !hasValidShouldBlock ||
        !hasValidReason,
      metadata,
    };
  } catch (error) {
    if (params.signal.aborted) {
      return {
        kind: 'aborted',
        reason: 'Classifier request aborted',
        metadata,
      };
    }
    const message = error instanceof Error ? error.message : 'unknown';
    if (isContextWindowError(message)) {
      return {
        kind: 'transcriptTooLong',
        reason:
          'Auto mode classifier transcript exceeded the context window — falling back to manual approval',
        metadata,
      };
    }
    return {
      kind: 'error',
      reason: `Classifier error: ${message}`,
      metadata,
    };
  }
}

/**
 * Recognises the deterministic "the prompt no longer fits" failure. Retrying it
 * cannot help, and treating it as a verdict would deny an action the classifier
 * never actually looked at.
 */
function isContextWindowError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('prompt is too long') ||
    normalized.includes('context length') ||
    normalized.includes('context_length_exceeded') ||
    normalized.includes('context window') ||
    normalized.includes('too many tokens') ||
    normalized.includes('maximum context')
  );
}

// ============================================================================
// Runtime Adapters
// ============================================================================

/**
 * Convert runtime Message[] to ClassifierMessage[].
 *
 * Keeps user and assistant messages with the host provenance the shared
 * extraction classifies by, and turns a `queued_command` attachment — input
 * that arrived while the agent was working — into the user message it carries.
 * Every other attachment, and system, progress, tombstone and tool-use-summary
 * messages, is skipped.
 */
export function toClassifierMessages(
  messages: readonly Message[],
): ClassifierMessage[] {
  const result: ClassifierMessage[] = [];
  for (const msg of messages) {
    if (msg.type === 'user') {
      result.push({
        role: 'user',
        content: msg.message.content as ClassifierMessage['content'],
        toolUseResult: msg.toolUseResult,
        toolDenialKind: msg.toolDenialKind,
        uuid: msg.uuid,
        ...(msg.origin !== undefined ? { origin: msg.origin } : {}),
        ...(msg.isMeta !== undefined ? { isMeta: msg.isMeta } : {}),
        ...(msg.isCompactSummary !== undefined
          ? { isCompactSummary: msg.isCompactSummary }
          : {}),
        ...(msg.isDelegatedTask === true || isHostWrittenSubagentText(msg)
          ? { delegatedTask: true }
          : {}),
        ...(msg.isUserDecision === true ? { userDecision: true } : {}),
      });
    } else if (msg.type === 'assistant') {
      result.push({
        role: 'assistant',
        content: msg.message.content as ClassifierMessage['content'],
        uuid: msg.uuid,
      });
    } else if (msg.type === 'attachment') {
      const queued = toQueuedCommandMessage(msg.attachment);
      if (queued) result.push(queued);
    }
  }
  return result;
}

/**
 * Sidechain records carry the subagent's `agentId`, and no input path lets a
 * person type into a subagent, so human-origin text there — including seeds
 * recorded before `isDelegatedTask` existed — was written by the host.
 */
function isHostWrittenSubagentText(msg: UserMessage): boolean {
  if (!msg.agentId || msg.isMeta === true || msg.isCompactSummary === true) {
    return false;
  }
  const kind = msg.origin?.kind;
  return kind === undefined || USER_ORIGIN_KINDS.has(kind);
}

function toQueuedCommandMessage(
  attachment: unknown,
): ClassifierMessage | undefined {
  if (!attachment || typeof attachment !== 'object') return undefined;
  const queued = attachment as Record<string, unknown>;
  if (queued['type'] !== 'queued_command') return undefined;
  const prompt = queued['prompt'];
  if (typeof prompt !== 'string' && !Array.isArray(prompt)) return undefined;
  const sourceUuid = queued['source_uuid'];
  const commandMode = queued['commandMode'];
  const isMeta = queued['isMeta'];
  return {
    role: 'user',
    content: prompt as ClassifierMessage['content'],
    queuedCommand:
      typeof sourceUuid === 'string' ? { sourceUuid } : {},
    ...(queued['origin'] !== undefined ? { origin: queued['origin'] } : {}),
    ...(typeof isMeta === 'boolean' ? { isMeta } : {}),
    ...(typeof commandMode === 'string' ? { commandMode } : {}),
    ...(queued['isUserDecision'] === true ? { userDecision: true } : {}),
  };
}

/**
 * Build a ClassifierToolLookup from a tool resolver function.
 *
 * Bridges the gap between the Scheduler's `resolveTool` registry
 * and the classifier's `ClassifierToolLookup` interface. Each tool's
 * `toClassifierInput` is mapped to the `toAutoClassifierInput` method
 * expected by the transcript serialiser.
 */
export function buildClassifierToolLookup(
  resolveTool: (
    name: string,
  ) =>
    | { toClassifierInput(input: Record<string, unknown>): unknown }
    | undefined,
): ClassifierToolLookup {
  return {
    get(name: string) {
      const tool = resolveTool(name);
      if (!tool) return undefined;
      return {
        toAutoClassifierInput(input: unknown) {
          return tool.toClassifierInput(input as Record<string, unknown>);
        },
      };
    },
  };
}
