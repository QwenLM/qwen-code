/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, MessageBlock } from './message-types.js';
import type { ToolResultBlockParam } from '../protocol/transcript/message.js';
import {
  isToolResultBlock,
  buildToolUseIdToNameMap,
  getContentBlocks,
  withContent,
} from './message-types.js';
import {
  formatTruncatedToolOutput,
  saveTruncatedToolOutput,
} from '../utils/fileUtils.js';
import type { CompressionStageContext } from './types.js';
import type {
  TextBlockParam,
  ImageBlockParam,
} from '../protocol/transcript/message.js';
import { runLogger } from '../utils/runLogger.js';

/**
 * Maximum aggregate size in characters for tool_result blocks within a SINGLE
 * user message (one turn's batch of parallel tool results). When a message's
 * blocks together exceed this, the largest fresh blocks are persisted to disk
 * and replaced with previews until under budget.
 *
 * Messages are evaluated independently — a 150K result in one turn and a 150K
 * result in the next are both untouched.
 *
 * This prevents N parallel tools from each producing large output and
 * collectively blowing up one turn's user message.
 */
const PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS = 200_000;

interface ToolResponseCandidate {
  blockIndex: number;
  toolResult: ToolResultBlockParam;
  originalText: string;
  /** Character size used for budget accounting. */
  size: number;
  /**
   * Candidate partition state:
   * - 'mustReapply': previously truncated, cached replacement must be re-applied
   * - 'frozen': previously seen but NOT truncated, locked to protect prompt cache
   * - 'fresh': never seen, eligible for new budget decisions
   */
  state: 'mustReapply' | 'frozen' | 'fresh';
  /** Cached replacement text (only set for mustReapply). */
  cachedReplacement?: string;
}

function cloneToolResultBlock(
  block: ToolResultBlockParam,
  output: string,
): ToolResultBlockParam {
  const content =
    typeof block.content === 'string'
      ? output
      : replaceTextParts(block.content, output);
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content,
    is_error: block.is_error,
  };
}

function replaceTextParts(
  content: ReadonlyArray<TextBlockParam | ImageBlockParam>,
  replacement: string,
): Array<TextBlockParam | ImageBlockParam> {
  const result: Array<TextBlockParam | ImageBlockParam> = [];
  let insertedReplacement = false;

  for (const part of content) {
    if (part.type === 'text') {
      if (!insertedReplacement) {
        result.push({ ...part, text: replacement });
        insertedReplacement = true;
      }
      continue;
    }
    result.push(part);
  }

  if (!insertedReplacement) {
    result.unshift({ type: 'text', text: replacement });
  }
  return result;
}

function stringifyToolResultContent(
  content: ToolResultBlockParam['content'],
): string {
  if (typeof content === 'string') {
    return content;
  }

  const texts = content
    .filter(
      (part): part is Extract<typeof part, { type: 'text' }> =>
        part.type === 'text',
    )
    .map((part) => part.text);

  return texts.join('\n');
}

/**
 * Collect tool_result candidates from a single user message's content blocks,
 * partitioning each into one of three states based on prior decisions:
 *
 * - **mustReapply**: ID found in `replacementDecisions` → previously truncated,
 *   must re-apply the cached replacement for prompt cache stability.
 * - **frozen**: ID found in `seenFunctionResponseIds` but NOT in
 *   `replacementDecisions` → previously evaluated and kept, locked to protect
 *   prompt cache prefix.
 * - **fresh**: ID not seen before → eligible for new budget evaluation.
 */
function collectToolResponseCandidates(
  blocks: readonly MessageBlock[],
  context: CompressionStageContext,
  seenIds: Set<string>,
): ToolResponseCandidate[] {
  return blocks.flatMap((block, blockIndex) => {
    if (!isToolResultBlock(block)) {
      return [];
    }

    const toolResult = block;
    const id = toolResult.tool_use_id;
    const cachedReplacement = id
      ? context.state.replacementDecisions[id]
      : undefined;

    let state: ToolResponseCandidate['state'];
    if (cachedReplacement !== undefined) {
      state = 'mustReapply';
    } else if (id && seenIds.has(id)) {
      state = 'frozen';
    } else {
      state = 'fresh';
    }

    const originalText = stringifyToolResultContent(toolResult.content);
    // For mustReapply, size reflects the replacement (already committed).
    // For frozen/fresh, size reflects the original content.
    const size = cachedReplacement?.length ?? originalText.length;

    return [
      {
        blockIndex,
        toolResult,
        originalText,
        size,
        state,
        cachedReplacement,
      },
    ];
  });
}

/**
 * Pick the largest fresh results to replace until the model-visible total
 * (frozen + remaining fresh) is at or under budget, or fresh is exhausted.
 *
 * mustReapply candidates are excluded from the budget — their truncation is
 * already committed and their (small) replacement size won't push fresh
 * results over budget.
 *
 * If frozen results alone exceed budget we accept the overage to preserve
 * cache stability; full compaction remains responsible for context pressure.
 */
function selectFreshToReplace(
  fresh: readonly ToolResponseCandidate[],
  frozenSize: number,
  limit: number,
): Set<number> {
  const selected = new Set<number>();
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0);

  if (remaining <= limit) {
    return selected;
  }

  const sorted = [...fresh].sort((a, b) => {
    if (b.size !== a.size) {
      return b.size - a.size;
    }
    const aKey = a.toolResult.tool_use_id ?? String(a.blockIndex);
    const bKey = b.toolResult.tool_use_id ?? String(b.blockIndex);
    return aKey.localeCompare(bKey);
  });

  for (const candidate of sorted) {
    if (remaining <= limit) {
      break;
    }
    selected.add(candidate.blockIndex);
    remaining -= candidate.size;
  }

  return selected;
}

/**
 * Apply replacements to a message's content blocks and push the result.
 * Returns true if any replacement was applied.
 */
function applyReplacements(
  message: Message,
  replacementMap: Map<number, string>,
  nextHistory: Message[],
): boolean {
  if (replacementMap.size === 0) {
    nextHistory.push(message);
    return false;
  }
  const blocks = getContentBlocks(message);
  nextHistory.push(
    withContent(
      message,
      blocks.map((block, idx) => {
        const replacement = replacementMap.get(idx);
        if (replacement !== undefined && isToolResultBlock(block)) {
          return cloneToolResultBlock(block, replacement);
        }
        return block;
      }),
    ),
  );
  return true;
}

/**
 * Mark candidate IDs as seen in both the local set and persisted state.
 */
function markSeen(
  candidates: readonly ToolResponseCandidate[],
  seenIds: Set<string>,
  state: CompressionStageContext['state'],
  excludeIds?: Set<string>,
): void {
  for (const c of candidates) {
    const id = c.toolResult.tool_use_id;
    if (id && !seenIds.has(id) && (!excludeIds || !excludeIds.has(id))) {
      seenIds.add(id);
      state.seenFunctionResponseIds.push(id);
    }
  }
}

/**
 * Enforces a per-message character budget on tool_result blocks in the
 * conversation history.
 *
 * Each user message is evaluated independently against
 * `PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS`. This prevents N parallel tool calls
 * from collectively producing an oversized message while allowing different
 * turns to each use the full budget.
 *
 * Uses a three-state model to protect prompt cache stability:
 * - **mustReapply**: previously truncated → re-apply cached replacement
 * - **frozen**: previously seen but kept → locked, won't be truncated later
 * - **fresh**: new this round → eligible for budget evaluation
 *
 * Replacement decisions are persisted in `state.replacementDecisions` and seen
 * IDs tracked in `state.seenFunctionResponseIds` so that decisions are stable
 * across compression rounds.
 */
export async function applyToolResultBudget(
  history: readonly Message[],
  context: CompressionStageContext,
): Promise<readonly Message[]> {
  const seenIds = new Set(context.state.seenFunctionResponseIds);
  const toolNameMap = buildToolUseIdToNameMap(history);
  let changed = false;
  const nextHistory: Message[] = [];

  for (const message of history) {
    if (message.type !== 'user' || getContentBlocks(message).length === 0) {
      nextHistory.push(message);
      continue;
    }

    const candidates = collectToolResponseCandidates(
      getContentBlocks(message),
      context,
      seenIds,
    );

    if (candidates.length === 0) {
      nextHistory.push(message);
      continue;
    }

    const mustReapply = candidates.filter((c) => c.state === 'mustReapply');
    const frozen = candidates.filter((c) => c.state === 'frozen');
    const fresh = candidates.filter((c) => c.state === 'fresh');

    // Re-apply cached replacements (zero I/O).
    const replacementMap = new Map<number, string>();
    for (const c of mustReapply) {
      if (c.cachedReplacement !== c.originalText) {
        replacementMap.set(c.blockIndex, c.cachedReplacement!);
      }
    }

    // No fresh candidates → old message, just re-apply and move on.
    if (fresh.length === 0) {
      markSeen(candidates, seenIds, context.state);
      if (applyReplacements(message, replacementMap, nextHistory)) {
        changed = true;
      }
      continue;
    }

    // Fresh candidates exist → evaluate per-message budget.
    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0);
    const selectedBlockIndexes = selectFreshToReplace(
      fresh,
      frozenSize,
      PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS,
    );

    // Mark non-selected candidates as seen NOW (synchronously).
    // Selected candidates are marked seen AFTER persist, alongside
    // replacementDecisions — keeps the pair atomic so no concurrent reader
    // sees an ID in seenIds without its replacement.
    const selectedFresh = fresh.filter((c) =>
      selectedBlockIndexes.has(c.blockIndex),
    );
    const selectedIds = new Set(
      selectedFresh.map((c) => c.toolResult.tool_use_id),
    );
    markSeen(candidates, seenIds, context.state, selectedIds);

    const outputThreshold =
      selectedFresh.length === 0
        ? 0
        : context.input.config.getTruncateToolOutputThreshold(
            context.input.modelResolution.model,
            context.input.modelResolution.config.context?.contextWindow,
          );
    // Persist selected candidates concurrently.
    const persistResults = await Promise.all(
      selectedFresh.map(async (c) => {
        const toolName =
          toolNameMap.get(c.toolResult.tool_use_id) ?? 'unknown_tool';
        let outputFile: string;
        try {
          ({ outputFile } = await saveTruncatedToolOutput(
            c.originalText,
            toolName,
            c.toolResult.tool_use_id ??
              context.input.config.getNextCompressionTruncationId(),
            context.input.config.storage.getProjectTempDir(),
            context.input.sessionScopeId,
          ));
        } catch (error) {
          runLogger.warn(
            `[ToolResultBudget] Unable to persist output for ${toolName}; preserving the original result.`,
            error,
          );
          return undefined;
        }
        const placeholder = formatTruncatedToolOutput(
          c.originalText,
          outputFile,
          outputThreshold,
        );
        return { candidate: c, placeholder };
      }),
    );

    // Post-await: atomically mark seen + record replacement decisions.
    for (const persisted of persistResults) {
      // Failed saves remain unchanged and eligible for retry. Never freeze a
      // replacement decision until the full content has actually been saved.
      if (!persisted) continue;
      const { candidate, placeholder } = persisted;
      const id = candidate.toolResult.tool_use_id;
      if (id) {
        seenIds.add(id);
        context.state.seenFunctionResponseIds.push(id);
        context.state.replacementDecisions[id] = placeholder;
      }
      replacementMap.set(candidate.blockIndex, placeholder);
    }

    if (applyReplacements(message, replacementMap, nextHistory)) {
      changed = true;
    }
  }

  return changed ? nextHistory : history;
}
