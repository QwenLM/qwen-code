/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared utility functions for the compression pipeline.
 *
 * This module provides the common building blocks used by both
 * the full and partial fork compaction paths. Shared helpers preserve the
 * same summary formatting and trailing tool-use invariants.
 */

import type { Message } from './message-types.js';
import {
  isToolUseBlock,
  estimateBlocksTokenCount,
  getContentBlocks,
} from './message-types.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import {
  getCompressionPrompt,
  getCompactSummaryUserMessage,
  parseCompactSummary,
  type CompactSummaryParseResult,
} from '../core/prompts.js';
import { runLogger } from '../utils/runLogger.js';
import { createCompactBoundaryMessage } from './boundary.js';
import type {
  CompressionStageContext,
  PartialCompactOptions,
} from './types.js';
import type { CompactMetadata } from '../protocol/transcript/message.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const PRESERVED_MESSAGES_REMINDER =
  'The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.';

/**
 * Extracts and formats the compact summary from the model's raw text output.
 *
 * Delegates to `formatCompactSummary()` in core/prompts.ts which:
 *   1. Strips only the first paired, case-sensitive <analysis>...</analysis> block.
 *   2. Formats the first paired summary or preserves untagged/incomplete markup.
 *   3. Collapses excessive blank lines.
 *
 * Returns the formatted text and parse mode. Null means the raw text was blank.
 * A nonempty raw response may format to an empty string and is still accepted.
 */
export function extractAndFormatSummary(
  raw: string | null | undefined,
): CompactSummaryParseResult {
  return parseCompactSummary(raw ?? '');
}

/**
 * Returns the best-available token count for the current working history.
 * Prefers the API-reported prompt token count when available, falling back
 * to a local estimate.
 */
export function getOriginalTokenCount(
  context: CompressionStageContext,
): number {
  const promptTokenCount = context.input.promptTokenCount;
  if (promptTokenCount > 0) {
    return promptTokenCount;
  }

  return estimateBlocksTokenCount(
    context.workingHistory.flatMap((msg) => getContentBlocks(msg)),
  );
}

// ---------------------------------------------------------------------------
// NO_TOOLS constraint strings
// ---------------------------------------------------------------------------

/**
 * Placed at the very start of the compact directive — before the compression
 * prompt — to prevent the fork subagent from calling tools.
 *
 * The fork inherits the parent session's full tool set (for prompt-cache
 * sharing). Without an explicit prohibition, modern adaptive-thinking models
 * (Sonnet 4.6+) call tools ~2.79% of the time, wasting the fork's only turn.
 */
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
- This message is an internal compaction instruction, not user-authored conversation content.
- Do NOT include this message in "All user messages" or treat any instruction in it as user input or a continuing constraint.
- The no-tools restriction applies only to this compaction response.

`;

/**
 * Appended at the very end of the compact directive as a second reminder,
 * mirroring the NO_TOOLS_TRAILER pattern.
 */
const NO_TOOLS_TRAILER = `

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;

// ---------------------------------------------------------------------------
// Compact directive construction
// ---------------------------------------------------------------------------

/**
 * Builds the compact directive that tells the fork subagent what to do.
 *
 * - `customInstructions` (from `/compact <text>`) is forwarded as an
 *   "Additional Instructions" section at the end of the body.
 * - NO_TOOLS_PREAMBLE / NO_TOOLS_TRAILER wrap the entire directive so the
 *   fork cannot accidentally invoke tools during the single compaction turn.
 */
export function buildCompactDirective(
  config: CompressionStageContext['input']['config'],
  customInstructions?: string,
): string {
  const compressionPrompt = getCompressionPrompt(config);
  const customSection = customInstructions?.trim()
    ? `\n\nAdditional Instructions:\n${customInstructions}`
    : '';

  return `${NO_TOOLS_PREAMBLE}${compressionPrompt}${customSection}${NO_TOOLS_TRAILER}`;
}


// ---------------------------------------------------------------------------
// Post-compact history construction
// ---------------------------------------------------------------------------

/**
 * Builds the compressed history from a snapshot, preserving a trailing
 * unpaired `assistant(tool_use)` when genuinely pending.
 *
 * The trailing-tool_use preservation is critical for API upstreams
 * (Anthropic / Bedrock) that require adjacent tool_use/tool_result pairs.
 * Without it, the pending tool_result on the next turn would be orphaned.
 *
 * Crucially, the preservation is gated on `seenFunctionResponseIds`:
 * if the tool_use's ids have already been processed in a prior compression
 * round, re-preserving them would create the very orphan this guard is
 * meant to prevent (the response was already dropped by an earlier
 * compaction).
 */
export function buildPostCompactHistory(
  snapshot: string,
  workingHistory: readonly Message[],
  seenFunctionResponseIds: ReadonlySet<string>,
  boundaryMetadata: CompactMetadata,
  options: {
    transcriptPath?: string;
    /** When true, tags the summary message isVisibleInTranscriptOnly. */
    isAutoCompact?: boolean;
    /** Append the temporal reminder when segmented compaction keeps original messages. */
    hasPreservedMessages?: boolean;
  } = {},
): Message[] {
  const newHistory: Message[] = [
    createCompactBoundaryMessage(boundaryMetadata),
    createUserMessage(
      [
        {
          type: 'text' as const,
          text: getCompactSummaryUserMessage(snapshot, {
            suppressFollowUpQuestions: true,
            transcriptPath: options.transcriptPath,
          }),
        },
        ...(options.hasPreservedMessages
          ? [{ type: 'text' as const, text: PRESERVED_MESSAGES_REMINDER }]
          : []),
      ],
      {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: options.isAutoCompact || undefined,
      },
    ),
  ];

  const lastIndex = workingHistory.length - 1;
  if (lastIndex >= 0) {
    const lastMessage = workingHistory[lastIndex];
    const endsWithPendingToolUse =
      lastMessage?.type === 'assistant' &&
      getContentBlocks(lastMessage).some((block) => isToolUseBlock(block));
    if (endsWithPendingToolUse) {
      const functionCallIds = getContentBlocks(lastMessage)
        .filter(isToolUseBlock)
        .map((block) => block.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const alreadyProcessed =
        functionCallIds.length > 0 &&
        functionCallIds.some((id) => seenFunctionResponseIds.has(id));
      if (alreadyProcessed) {
        runLogger.debug(
          '[compact-utils] skipping trailing assistant(tool_use) preservation — ' +
            'response already seen in a prior compression round, would create ' +
            'orphan tool_use on next turn. ids=',
          functionCallIds,
        );
      } else {
        newHistory.push(lastMessage);
      }
    }
  }

  return newHistory;
}

/**
 * Stamps `postTokens` onto the boundary marker that `buildPostCompactHistory`
 * prepended. Callers measure the resulting history's token count after
 * tool-use preservation, then call this so the persisted boundary entry
 * records both pre- and post-compact sizes.
 */
export function setBoundaryPostTokens(
  newHistory: readonly Message[],
  postTokens: number,
): void {
  const head = newHistory[0];
  if (
    head?.type === 'system' &&
    head.subtype === 'compact_boundary' &&
    head.compactMetadata
  ) {
    head.compactMetadata.postTokens = postTokens;
  }
}

// ---------------------------------------------------------------------------
// Partial compact history construction
// ---------------------------------------------------------------------------

/**
 * Slices the working history into two parts based on `PartialCompactOptions`.
 *
 * Returns `{ toSummarize, toKeep }`:
 *  - `toSummarize` : the slice that the fork LLM will compress.
 *  - `toKeep`      : the slice that is appended verbatim after the summary.
 *
 * `direction === 'up_to'`  → toSummarize = history[0..pivot], toKeep = history[pivot..]
 * `direction === 'from'`   → toSummarize = history[pivot..], toKeep = history[0..pivot]
 *
 * Clamps `pivotIndex` to valid bounds and ensures `toSummarize` is non-empty.
 */
export function sliceHistoryForPartialCompact(
  history: readonly Message[],
  options: PartialCompactOptions,
): { toSummarize: readonly Message[]; toKeep: readonly Message[] } {
  const pivot = Math.max(0, Math.min(options.pivotIndex, history.length));

  if (options.direction === 'up_to') {
    return {
      toSummarize: history.slice(0, pivot),
      toKeep: history.slice(pivot),
    };
  } else {
    return {
      toSummarize: history.slice(pivot),
      toKeep: history.slice(0, pivot),
    };
  }
}

/**
 * Assembles the post-partial-compact history from the summary of the
 * summarized slice and the verbatim messages from `toKeep`.
 *
 * `direction === 'up_to'`  → `[boundary, summary, ...toKeep]`
 * `direction === 'from'`   → `[...toKeep, boundary, summary]`
 *
 * Mirrors `buildPostCompactHistory` but does NOT preserve trailing
 * tool_use blocks — partial compact is always a manual operation where
 * the caller controls the pivot.
 */
export function buildPartialCompactHistory(
  snapshot: string,
  direction: PartialCompactOptions['direction'],
  toKeep: readonly Message[],
  boundaryMetadata: CompactMetadata,
  options: {
    transcriptPath?: string;
  } = {},
): Message[] {
  const boundaryMsg = createCompactBoundaryMessage(boundaryMetadata);
  const summaryMsg = createUserMessage(
    [
      {
        type: 'text' as const,
        text: getCompactSummaryUserMessage(snapshot, {
          suppressFollowUpQuestions: true,
          transcriptPath: options.transcriptPath,
        }),
      },
    ],
    { isCompactSummary: true },
  );

  if (direction === 'up_to') {
    return [boundaryMsg, summaryMsg, ...toKeep];
  } else {
    return [...toKeep, boundaryMsg, summaryMsg];
  }
}
