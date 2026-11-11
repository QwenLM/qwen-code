/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared post-compact finalizer.
 *
 * Builds all recovery attachments synchronously and returns them so the caller
 * can append them into `messages[]` and persist through the transcript writer handle. This
 * replaces the previous design
 * that queued candidates on `AttachmentToolUseContext` and drained them on
 * the next turn (which lost state across resume).
 *
 * Covers:
 *   - file restoration         (collectRecentReadFileCandidates → post_compact_restored_files)
 *   - plan file reference      (createPlanAttachmentIfNeeded)
 *   - invoked skills           (createSkillAttachmentIfNeeded, MRU-sorted)
 *   - plan_mode instructions   (when currently in plan mode)
 *   - agent listing delta      (reset + re-announce full list as isInitial=true)
 *   - MCP instructions delta   (reset + re-announce all connected servers)
 *
 * Resets delta-tracking state whose state lived in the now-discarded history:
 *   - lastPlanModeState / isFirstTurnSeedDone /
 *     lastSubagentHash
 *     → undefined
 */

import {
  restoreToolFileReadState,
  readFileStateFromResult,
  readOutputReplacementPath,
} from '../attachments/transcript-state.js';
import * as fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import {
  type AttachmentMessage,
  type AttachmentToolUseContext,
  type AttachmentExternalContext,
  PostCompactRestoredFilesAttachment,
  PlanModeAttachment,
} from '../attachments/types.js';
import {
  createPlanAttachmentIfNeeded,
  createSkillAttachmentIfNeeded,
  getAvailableAgentTypeNames,
  getAgentListingDeltaAttachments,
  getMcpInstructionsDeltaAttachments,
  resetAgentListingDeltaState,
  resetMcpInstructionsDeltaState,
  resetLazyMcpReminderState,
  getLazyMcpReminderAttachments,
  getSkillListingAttachments,
  getSkillListingConfig,
  resetSkillListingState,
  createAttachmentMessage,
  type InvokedSkillRecord,
} from '../attachments/index.js';
import { extractTodosFromHistory } from '../attachments/generators/todo-generators.js';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';
import { runLogger } from '../utils/runLogger.js';
import { READ_FILE_TOOL_NAME, SKILL_TOOL_NAME } from '../tools/tool-names.js';
import { getModelVisibleSkillsForTools } from '../workflows/workflow-skills.js';
import { isRecord } from '../utils/markdownUtils.js';
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ContentBlockParam,
} from '../protocol/transcript/message.js';
import type {
  ContentBlock,
  ToolResultBlockParam,
} from '../protocol/transcript/message.js';
import * as path from 'node:path';
import { getContentBlocks, isToolUseBlock } from './message-types.js';
import { RESTORED_FILE_PATH_PREFIX } from './constants.js';
import { pathPermissionContextOf } from '../attachments/path-permission.js';
import { restoreAttachment } from '../attachments/transcript-conversion.js';
import { isFileReadDenied } from '../tools/filesystem-permissions/filesystem.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { isFileReadResult } from '../tools/tools.js';
import { createToolFileStateCache } from '../utils/fileStateCache.js';
import { partListUnionToContent } from '../tools/tool-use-result-builder.js';

// ============================================================================
// File restore utilities
// ============================================================================

const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;

export type FileRestoreCandidate =
  PostCompactRestoredFilesAttachment['files'][number];

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isMessage(value: unknown): value is Message {
  return isRecord(value) && isString((value as { type?: unknown }).type);
}

function userContentBlocks(msg: UserMessage): ContentBlockParam[] {
  const content = msg.message?.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

function assistantContentBlocks(msg: AssistantMessage): ContentBlock[] {
  const content = msg.message?.content;
  return Array.isArray(content) ? content : [];
}

function extractToolResultText(
  content: ToolResultBlockParam['content'] | undefined,
): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (p): p is { type: 'text'; text: string } =>
        isRecord(p) && p['type'] === 'text' && isString(p['text']),
    )
    .map((p) => p.text)
    .join('\n');
}

function extractMessageText(msg: Message): string {
  if (msg.type === 'assistant') {
    return assistantContentBlocks(msg)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  if (msg.type === 'user') {
    return userContentBlocks(msg)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .filter((t) => t.length > 0)
      .join('\n');
  }
  return '';
}

function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (estimateTokenCountSync([{ text }]) <= maxTokens) {
    return { text, truncated: false };
  }
  const maxChars = Math.max(1, maxTokens * 4);
  return {
    text: `${text.slice(0, maxChars)}\n[Truncated for post-compact restore]`,
    truncated: true,
  };
}

function extractReadFilePath(input: unknown, targetDir: string): string | null {
  if (!isRecord(input)) {
    return null;
  }
  const rawPath =
    (isString(input['file_path']) && input['file_path']) ||
    (isString(input['path']) && input['path']);
  if (!rawPath) {
    return null;
  }
  return path.resolve(targetDir, rawPath);
}

function collectRestoredFilePaths(
  history: readonly Message[],
  targetDir: string,
): Set<string> {
  const restoredPaths = new Set<string>();
  const readPrefix = `Called the ${READ_FILE_TOOL_NAME} tool with the following input: `;
  for (const msg of history) {
    if (!isMessage(msg)) continue;
    const text = extractMessageText(msg);
    if (!text) continue;
    for (const line of text.split('\n')) {
      const match = line.startsWith(RESTORED_FILE_PATH_PREFIX)
        ? line.slice(RESTORED_FILE_PATH_PREFIX.length).trim()
        : null;
      if (match) {
        restoredPaths.add(match);
      } else if (line.startsWith(readPrefix)) {
        try {
          const filePath = extractReadFilePath(
            JSON.parse(line.slice(readPrefix.length)),
            msg.cwd ?? targetDir,
          );
          if (filePath) restoredPaths.add(filePath);
        } catch {
          // A malformed historical reminder cannot establish a preserved read.
        }
      }
    }
  }
  return restoredPaths;
}

/**
 * Walks the message history once and pairs each `read_file` tool_use with its
 * matching tool_result. Matching is id-based (tool_use.id ↔ tool_result.
 * tool_use_id); a small FIFO queue acts as a fallback if ids are absent.
 *
 * `onPair` fires for every successfully matched pair, receiving the resolved
 * absolute file path and the raw tool_result content for text extraction.
 */
function walkReadFilePairs(
  history: readonly Message[],
  targetDir: string,
  onPair: (
    filePath: string,
    content: ToolResultBlockParam['content'],
    readState?: FileRestoreCandidate['readState'],
  ) => void,
): void {
  type ReadCall = {
    filePath: string;
    input: Record<string, unknown>;
    cwd?: string;
  };
  const calls = new Map<string, ReadCall>();
  const anonymousCalls: ReadCall[] = [];
  for (const msg of history) {
    if (!isMessage(msg)) continue;
    if (msg.type === 'assistant') {
      for (const block of assistantContentBlocks(msg)) {
        if (
          block.type !== 'tool_use' ||
          block.name !== READ_FILE_TOOL_NAME ||
          !isRecord(block.input)
        )
          continue;
        const filePath = extractReadFilePath(block.input, msg.cwd ?? targetDir);
        if (filePath) {
          const call = { filePath, input: block.input, cwd: msg.cwd };
          if (typeof block.id === 'string' && block.id)
            calls.set(block.id, call);
          else anonymousCalls.push(call);
        }
      }
    } else if (msg.type === 'user') {
      const results = userContentBlocks(msg).filter(
        (block) => block.type === 'tool_result',
      );
      for (const [index, block] of results.entries()) {
        const call = calls.get(block.tool_use_id) ?? anonymousCalls.shift();
        calls.delete(block.tool_use_id);
        if (!call || block.is_error) continue;
        const payload =
          results.length > 1 && Array.isArray(msg.toolUseResult)
            ? msg.toolUseResult[index]
            : msg.toolUseResult;
        const resultFile =
          isRecord(payload) && isRecord(payload['file'])
            ? payload['file']
            : undefined;
        const resultPath = resultFile?.['filePath'];
        const replacementPath = readOutputReplacementPath(
          msg,
          index,
          results.length,
        );
        const filePath =
          typeof replacementPath === 'string' || typeof resultPath === 'string'
            ? path.resolve(
                msg.cwd ?? call.cwd ?? targetDir,
                replacementPath ?? (resultPath as string),
              )
            : call.filePath;
        const state = readFileStateFromResult(
          call.input,
          payload,
          extractToolResultText(block.content),
          Date.parse(msg.timestamp),
          replacementPath !== undefined,
        );
        const readState = state
          ? {
              timestamp: state.timestamp,
              offset: state.offset,
              limit: state.limit,
              isPartialView: state.isPartialView,
              contentNotInModelContext: state.contentNotInModelContext,
            }
          : undefined;
        onPair(
          filePath,
          state &&
            !state.isPartialView &&
            !(isRecord(payload) && payload['type'] === 'notebook')
            ? state.content
            : block.content,
          readState,
        );
      }
    }
  }
}

function collectPreservedReadFilePaths(
  history: readonly Message[],
  targetDir: string,
): Set<string> {
  const restoredPaths = collectRestoredFilePaths(history, targetDir);
  walkReadFilePairs(history, targetDir, (filePath) => {
    restoredPaths.add(filePath);
  });
  return restoredPaths;
}

/**
 * Collect the most recent read file candidates from workingHistory that are
 * NOT in skippedPaths (i.e., not already present in the compressed tail).
 *
 * Returns up to POST_COMPACT_MAX_FILES_TO_RESTORE candidates, sorted by
 * most-recent occurrence (most recently read first).
 *
 * Called from QueryEngine.applyPostCompact after compression; input is the
 * pre-compression runtime Message[] (Anthropic-shaped).
 */
export function collectRecentReadFileCandidates(
  workingHistory: readonly Message[],
  targetDir: string,
  skippedPaths: ReadonlySet<string>,
): FileRestoreCandidate[] {
  const candidates: Array<{
    filePath: string;
    text: string;
    truncated: boolean;
    order: number;
    readState?: FileRestoreCandidate['readState'];
  }> = [];

  walkReadFilePairs(
    workingHistory,
    targetDir,
    (filePath, content, readState) => {
      if (skippedPaths.has(filePath)) return;
      candidates.push({
        filePath,
        ...truncateToTokenBudget(
          extractToolResultText(content),
          POST_COMPACT_MAX_TOKENS_PER_FILE,
        ),
        order: candidates.length,
        ...(readState ? { readState } : {}),
      });
    },
  );

  // Deduplicate by path (keep most recent occurrence)
  const deduped = new Map<string, (typeof candidates)[0]>();
  for (const candidate of candidates) {
    deduped.set(candidate.filePath, candidate);
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.order - a.order)
    .slice(0, POST_COMPACT_MAX_FILES)
    .map(({ filePath, text: content, truncated, readState }) => ({
      filePath,
      content,
      truncated,
      ...(readState ? { readState } : {}),
    }));
}

/**
 * Helper: collect preserved file paths from the new (compressed) history tail.
 * Exported for use in QueryEngine's post-compact wiring.
 */
export function collectPreservedReadFilePathsFromHistory(
  newHistory: readonly Message[],
  targetDir: string,
): Set<string> {
  return collectPreservedReadFilePaths(newHistory, targetDir);
}

/** Total token budget across all restored files. */
const POST_COMPACT_FILE_TOKEN_BUDGET = 50_000;
/** Maximum number of files to restore. */
const POST_COMPACT_MAX_FILES = 5;

export interface FinalizePostCompactArgs {
  /**
   * The history BEFORE compression ran — used to scan for recent Read tool
   * uses that should be re-injected after compaction.
   */
  workingHistory: readonly Message[];
  /**
   * The history AFTER compression — summary (+ optional pending tool_use tail).
   * Used to detect which files are already preserved in the tail.
   */
  newHistory: readonly Message[];
  /** Working directory — for resolving relative Read paths. */
  targetDir: string;
  /** Runtime attachment context (mutated: delta-tracker resets). */
  ctx: AttachmentToolUseContext;
  /** External context snapshot (provides agentRegistry + mcpClientManager). */
  externalContext?: AttachmentExternalContext;
  /** Config — for plan path + skill manager + plan-mode state. */
  config: Config;
}

export interface FinalizePostCompactResult {
  /** AttachmentMessages the caller should append to messages[] + persist. */
  attachmentMessages: AttachmentMessage[];
  /**
   * True when the last message in newHistory is an assistant message that ends
   * with a tool_use block.  In that case attachment injection must be deferred
   * (via ctx drain queues) so it doesn't break strict tool_use/tool_result
   * pairing expected by the model.
   */
  hasPendingToolTail: boolean;
}

/**
 * Build the post-compact attachment messages and reset delta-tracking state.
 *
 * Call this once per successful compaction. The caller is responsible for:
 *   (a) pushing `attachmentMessages` onto runtime history
 *
 * This function intentionally does not mutate the message list — the caller
 * owns that, and it differs between auto-compact (adapter already swapped)
 * and manual /compress (slash-command layer).
 */
export async function finalizePostCompact(
  args: FinalizePostCompactArgs,
): Promise<FinalizePostCompactResult> {
  const {
    workingHistory,
    newHistory,
    targetDir,
    ctx,
    externalContext,
    config,
  } = args;

  // Detect whether the new history ends with an un-resolved tool_use tail.
  // When true, attachment injection must be deferred (can't insert messages
  // between tool_use and its pending tool_result).
  const lastMsg = newHistory[newHistory.length - 1];
  const hasPendingToolTail =
    lastMsg?.type === 'assistant' &&
    getContentBlocks(lastMsg).some(isToolUseBlock);

  // Clear the file-content LRU so that re-injected files aren't suppressed by
  // stale cache entries from the history we just discarded.
  ctx.readFileState?.clear();
  restoreToolFileReadState(ctx.fileReadState, newHistory, targetDir);

  const attachmentMessages: AttachmentMessage[] = [];
  const preservesPrefix = newHistory.some(
    (m) => m.isCompactSummary && m.isCompactionPrefix,
  );
  if (preservesPrefix) {
    // Rebuild only announcement baselines, preserving unrelated scopes/queues.
    resetSkillListingState(ctx);
    resetAgentListingDeltaState(ctx);
    resetMcpInstructionsDeltaState(ctx);
    resetLazyMcpReminderState(ctx);
    for (const message of newHistory) {
      if (message.type === 'attachment') {
        restoreAttachment(message.attachment)?.restoreAttachmentContext(ctx);
      }
    }
  }

  // Cache plan file read — steps 2 (plan attachment) and 4 (plan_mode) both
  // need the same content; read once and reuse.
  const planPath = config.getApprovedPlanPath?.() ?? null;
  const planContent = planPath ? await readFileSafe(planPath) : null;

  // ── 1. File restoration ────────────────────────────────────────────────────
  try {
    const preservedPaths = collectPreservedReadFilePathsFromHistory(
      newHistory,
      targetDir,
    );
    // These files have dedicated startup/memory/plan recovery paths. Filter
    // before selecting the five candidates; leave history source/order intact.
    const memory =
      externalContext?.memoryContextManager ??
      config.getMemoryContextManager?.();
    const excludedPaths = [
      ...ctx.loadedNestedMemoryPaths,
      ...(memory?.getLoadedPaths() ?? []),
      ...(memory?.getRuleFileStates?.().map((file) => file.rulePath) ?? []),
      ...(memory
        ?.getAutoMemoryIndexFileStates?.()
        .map((file) => file.indexPath) ?? []),
      ...((
        externalContext?.sdkMemoryFileStates ??
        config.getSdkMemoryFileStates?.()
      )?.map((file) => file.filePath) ?? []),
      ...(planPath ? [planPath] : []),
    ];
    for (const filePath of excludedPaths)
      preservedPaths.add(path.resolve(targetDir, filePath));
    const candidates = collectRecentReadFileCandidates(
      workingHistory,
      targetDir,
      preservedPaths,
    );
    const files = selectFilesWithinBudget(
      await readCurrentRestoreFiles(candidates, ctx, config),
    );
    if (files.length > 0) {
      const attachment: PostCompactRestoredFilesAttachment =
        new PostCompactRestoredFilesAttachment({
          type: 'post_compact_restored_files',
          files,
        });
      attachmentMessages.push(createAttachmentMessage(attachment));
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] file restore error:', err);
  }

  // ── 2. Plan file reference ────────────────────────────────────────────────
  try {
    if (planPath) {
      const planAttachment = createPlanAttachmentIfNeeded(
        planPath,
        planContent ?? undefined,
      );
      if (planAttachment) {
        attachmentMessages.push(createAttachmentMessage(planAttachment));
      }
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] plan attachment error:', err);
  }

  // ── 3. Invoked skills ─────────────────────────────────────────────────────
  try {
    const skillManager = config.getSkillManager?.();
    if (skillManager) {
      const activeSkills = skillManager.getActiveSkillsWithTimestamp();
      const invoked: InvokedSkillRecord[] = activeSkills.map(
        ({ skill, invokedAt }) => ({
          name: skill.name,
          path: skill.location,
          content: skillManager.getRenderedBody(skill.name) ?? skill.body ?? '',
          invokedAt,
        }),
      );
      const skillAttachment = createSkillAttachmentIfNeeded(invoked);
      if (skillAttachment) {
        attachmentMessages.push(createAttachmentMessage(skillAttachment));
      }
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] skill attachment error:', err);
  }

  // ── 3b. Available skill listing ───────────────────────────────────────────
  // Separate failure domain from the invoked-skill body above: the listing is
  // what keeps the model aware of every skill, so it must survive an error
  // while collecting active skills.
  try {
    const skillManager = config.getSkillManager?.();
    if (skillManager) {
      // The listing lived in the discarded prefix. Reset the delta state and
      // re-run the generator as an initial turn so uninterrupted execution and
      // resume rebuild the same model-visible context after compaction —
      // symmetric with the agent-listing / MCP paths in step 5.
      if (!preservesPrefix) resetSkillListingState(ctx);
      const skills = getModelVisibleSkillsForTools(
        config,
        (
          externalContext?.toolRegistry ?? config.getToolRegistry()
        ).hasToolEnabled(SKILL_TOOL_NAME)
          ? [SKILL_TOOL_NAME]
          : [],
        { isMainSession: ctx.isMainAgent !== false },
      );
      const skillListings = await getSkillListingAttachments(
        ctx,
        skills ?? [],
        true,
        await getSkillListingConfig(config, {
          model: externalContext?.effectiveModel,
        }),
      );
      for (const attachment of skillListings) {
        attachmentMessages.push(createAttachmentMessage(attachment));
      }
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] skill listing error:', err);
  }

  // ── 4. Plan mode state ────────────────────────────────────────────────────
  // When the session is currently in plan mode, re-inject the instructions
  // so the model keeps operating in plan mode after the summary replaces
  // prior reminders.
  try {
    if (config.isPlanMode?.()) {
      const availableAgentTypes = getAvailableAgentTypeNames(externalContext);
      const planMode: PlanModeAttachment = new PlanModeAttachment({
        type: 'plan_mode',
        reminderType: 'full',
        isActive: true,
        planFilePath: planPath ?? '',
        planExists: planContent !== null,
        ...(availableAgentTypes ? { availableAgentTypes } : {}),
      });
      attachmentMessages.push(createAttachmentMessage(planMode));
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] plan_mode attachment error:', err);
  }

  // ── 5. Reset + re-announce delta-tracked attachments ──────────────────────
  // The old history carried the previous agent-listing / MCP-instruction
  // announcements; after compaction those tokens are gone. Reset tracking
  // sets to empty, then call the generators — they diff against the (now
  // empty) sets and emit a full re-announcement.
  try {
    if (!preservesPrefix) resetAgentListingDeltaState(ctx);
    for (const att of getAgentListingDeltaAttachments(ctx, externalContext)) {
      attachmentMessages.push(createAttachmentMessage(att));
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] agent listing delta error:', err);
  }
  try {
    if (!preservesPrefix) resetMcpInstructionsDeltaState(ctx);
    for (const att of getMcpInstructionsDeltaAttachments(
      ctx,
      externalContext,
    )) {
      attachmentMessages.push(createAttachmentMessage(att));
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] mcp instructions delta error:', err);
  }
  // The lazy MCP catalog that was announced lived in discarded history.
  // Forget it and re-emit the full catalog in the recovery bundle so the
  // continuation right after compaction can still see every server/tool.
  try {
    if (!preservesPrefix) resetLazyMcpReminderState(ctx);
    for (const att of getLazyMcpReminderAttachments(ctx, externalContext)) {
      attachmentMessages.push(createAttachmentMessage(att));
    }
  } catch (err) {
    runLogger.log('[finalizePostCompact] lazy mcp reminder error:', err);
  }

  // ── 6. Reset discarded-history baselines for next-turn generators ─────────
  // These reminders and first-turn seeds lived in discarded history/state:
  // replay current baselines, including auto-memory MEMORY.md readFileState
  // seeds used for later edited_text_file detection.
  ctx.isFirstTurnSeedDone = false;
  ctx.lastSubagentHash = undefined;
  // workingHistory is about to be discarded; save the last write_todos state so
  // getTodoReminderAttachments() can fall back to it after compression.
  ctx.lastKnownTodos = extractTodosFromHistory(workingHistory);

  runLogger.log(
    `[finalizePostCompact] produced ${attachmentMessages.length} attachment(s); delta state reset.`,
  );

  return { attachmentMessages, hasPendingToolTail };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** History still selects paths; only a successful current disk read supplies text. */
async function readCurrentRestoreFiles(
  candidates: readonly FileRestoreCandidate[],
  ctx: AttachmentToolUseContext,
  config: Config,
): Promise<FileRestoreCandidate[]> {
  const pathContext = pathPermissionContextOf(ctx);
  const files: FileRestoreCandidate[] = [];
  for (const { filePath } of candidates) {
    if (pathContext && isFileReadDenied(filePath, pathContext, ctx.cwd))
      continue;
    try {
      // Isolate tool baselines until the chosen attachments are actually
      // delivered. Rejected/over-budget reads must not grant Edit a baseline.
      const fileReadState = createToolFileStateCache();
      const invocation = new ReadFileTool(config).build({
        file_path: filePath,
      });
      const read = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        fileReadState,
        agentId: ctx.agentId,
        invocationOrigin: 'internal',
        dedupUnchangedReads: false,
        fileReadingLimits: {
          maxTokens: POST_COMPACT_MAX_TOKENS_PER_FILE,
          wholeFile: true,
        },
      });
      const state = fileReadState.get(filePath);
      if (
        read.error?.type === ToolErrorType.FILE_TOO_LARGE ||
        state?.isPartialView
      ) {
        files.push(fileReference(filePath, ctx.cwd));
        continue;
      }
      if (
        read.error ||
        !isFileReadResult(read.toolUseResult) ||
        (read.toolUseResult.type !== 'text' &&
          read.toolUseResult.type !== 'notebook') ||
        !state
      )
        continue;
      const payload = read.toolUseResult;
      if (payload.type === 'notebook') {
        const content =
          payload.file.cells.length === 0
            ? []
            : partListUnionToContent(read.llmContent);
        files.push({
          filePath,
          displayPath: path.relative(ctx.cwd, filePath),
          content: JSON.stringify(payload.file.cells),
          formattedParts:
            typeof content === 'string'
              ? [{ type: 'text', text: content }]
              : [...content],
          readResult: payload,
          truncated: false,
          readState: {
            timestamp: state.timestamp,
            offset: state.offset,
            limit: state.limit,
            isPartialView: false,
            contentNotInModelContext: false,
          },
        });
        continue;
      }
      if (typeof read.llmContent !== 'string') continue;
      files.push({
        filePath,
        displayPath: path.relative(ctx.cwd, filePath),
        content: payload.file.content,
        formattedContent: read.llmContent,
        readResult: payload,
        truncated: false,
        readState: {
          timestamp: state.timestamp,
          offset: state.offset,
          limit: state.limit,
          isPartialView: payload.file.numLines < payload.file.totalLines,
          contentNotInModelContext: false,
        },
      });
    } catch (error) {
      runLogger.debug('[finalizePostCompact] skipped unreadable restore file', {
        filePath,
        error,
      });
    }
  }
  return files;
}

function fileReference(filePath: string, cwd: string): FileRestoreCandidate {
  return {
    filePath,
    displayPath: path.relative(cwd, filePath),
    content: '',
    truncated: false,
    referenceOnly: true,
  };
}

export function selectFilesWithinBudget(
  candidates: readonly FileRestoreCandidate[],
): FileRestoreCandidate[] {
  const picked: FileRestoreCandidate[] = [];
  let used = 0;
  for (const c of candidates.slice(0, POST_COMPACT_MAX_FILES)) {
    const attachment = c.referenceOnly
      ? {
          type: 'compact_file_reference',
          filename: c.filePath,
          displayPath: c.displayPath ?? c.filePath,
        }
      : {
          type: 'file',
          filename: c.filePath,
          content: c.readResult ?? c.content,
          displayPath: c.displayPath ?? c.filePath,
        };
    // Match the attachment recovery budget's rough serialized-payload estimate.
    const sectionTokens = Math.round(JSON.stringify(attachment).length / 4);
    if (used + sectionTokens > POST_COMPACT_FILE_TOKEN_BUDGET) continue;
    used += sectionTokens;
    picked.push(c);
  }
  return picked;
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}
