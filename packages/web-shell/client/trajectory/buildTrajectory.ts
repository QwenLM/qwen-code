/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonTranscriptTimingMeta,
} from '@qwen-code/sdk/daemon';
import type {
  Trajectory,
  TrajectoryEntry,
  TrajectoryRequestRow,
  TrajectoryRow,
  TrajectoryToolRow,
  TrajectoryTurn,
} from './types';

/**
 * User records the daemon injects mid-turn. They are real rows, but they do not
 * open a turn — the same split the transcript reader makes server-side with
 * `isReplayTurnStartType`.
 *
 * A `goal_runtime` record carrying display text reaches the client as a plain
 * user chunk with no marker, so it reads here as a turn start. Known gap; it
 * costs a spurious turn header and nothing else.
 */
const INJECTED_USER_SOURCES: ReadonlySet<string> = new Set([
  'background_notification',
  'cron',
  'mid_turn_message_injected',
]);

/**
 * Subagent prompt ids are `<session>#<subagentId>#<round>`; the main session
 * uses an empty middle (`<session>########<n>`). Same test core applies in
 * `openaiLogger`, kept in step with it.
 *
 * This is the only marker a tool timing frame carries: `logToolCall` does not
 * expand subagent identity, so unlike a request frame there is no
 * `subagentId` field to read.
 */
function subagentIdFromPromptId(promptId?: string): string | undefined {
  if (promptId === undefined) return undefined;
  const parts = promptId.split('#');
  if (parts.length !== 3) return undefined;
  const [, subagentId, round] = parts;
  if (!subagentId || !round || !/^\d+$/.test(round)) return undefined;
  return subagentId;
}

/**
 * A subagent id is `<agentType>-<parentCallId>` and the type itself may contain
 * `-`, so the split point is found by testing suffixes against the tool calls
 * actually seen. Subagents with no spawning tool call (the managed memory
 * extractor, for one) simply resolve to nothing.
 */
function resolveParentToolCallId(
  subagentId: string,
  toolRowByCallId: ReadonlyMap<string, number>,
): string | undefined {
  for (
    let i = subagentId.indexOf('-');
    i >= 0;
    i = subagentId.indexOf('-', i + 1)
  ) {
    const candidate = subagentId.slice(i + 1);
    if (toolRowByCallId.has(candidate)) return candidate;
  }
  return undefined;
}

/** Only message and tool blocks can sit under a subagent's tool call. */
function parentToolCallIdOf(block: DaemonTranscriptBlock): string | undefined {
  return 'parentToolCallId' in block ? block.parentToolCallId : undefined;
}

function isTurnStart(block: DaemonTextTranscriptBlock): boolean {
  const source = block.meta?.['source'];
  return typeof source !== 'string' || !INJECTED_USER_SOURCES.has(source);
}

/**
 * Fold a run of raw entries into turns and rows, pairing each timing frame with
 * what it measured.
 *
 * Nothing here invents a duration. A row whose frame never arrived — an
 * in-flight call, a session written before timing frames existed — carries no
 * timing at all rather than a value derived from arrival times.
 */
export function buildTrajectory(
  entries: readonly TrajectoryEntry[],
): Trajectory {
  const rows: TrajectoryRow[] = [];
  const turns: TrajectoryTurn[] = [];
  const rowIndexByKey = new Map<string, number>();
  const toolRowByCallId = new Map<string, number>();

  let turn: TrajectoryTurn | undefined;
  let requestCount = 0;
  let currentRequestIndex: number | undefined;
  // Request row still waiting for the round's usage; cleared once one lands so
  // a later round's counts cannot be read back onto it.
  let usageRowIndex: number | undefined;

  const openTurn = (partial: boolean): TrajectoryTurn => {
    const created: TrajectoryTurn = {
      index: turns.length + 1,
      rowKeys: [],
      requestCount: 0,
      toolCount: 0,
      requestMs: 0,
      partial,
    };
    turns.push(created);
    turn = created;
    currentRequestIndex = undefined;
    usageRowIndex = undefined;
    return created;
  };

  const uniqueKey = (candidate: string): string => {
    if (!rowIndexByKey.has(candidate)) return candidate;
    for (let n = 2; ; n += 1) {
      const suffixed = `${candidate}#${n}`;
      if (!rowIndexByKey.has(suffixed)) return suffixed;
    }
  };

  const push = (row: TrajectoryRow): number => {
    const index = rows.length;
    rows.push(row);
    rowIndexByKey.set(row.key, index);
    (turn ?? openTurn(true)).rowKeys.push(row.key);
    return index;
  };

  const blockKey = (prefix: string, block: DaemonTranscriptBlock): string =>
    uniqueKey(
      `${prefix}:${block.segmentId ?? block.sourceRecordIds?.[0] ?? block.id}`,
    );

  const summaryFor = (
    parentCallId: string,
  ): TrajectoryToolRow['subagentSummary'] => {
    const parent = rows[toolRowByCallId.get(parentCallId) ?? -1];
    if (parent?.kind !== 'tool') return undefined;
    parent.subagentSummary ??= { requests: 0, tools: 0, requestMs: 0 };
    return parent.subagentSummary;
  };

  const addRequest = (
    timing: DaemonTranscriptTimingMeta,
    recordId: string | undefined,
  ) => {
    const active = turn ?? openTurn(true);
    const subagentId =
      timing.subagentId ?? subagentIdFromPromptId(timing.promptId);
    const span = {
      durationMs: timing.durationMs,
      ...(timing.startedAt !== undefined
        ? { startedAt: timing.startedAt }
        : {}),
      ...(timing.ttftMs !== undefined ? { ttftMs: timing.ttftMs } : {}),
    };
    const row: TrajectoryRequestRow = {
      kind: 'request',
      key: uniqueKey(`req:${recordId ?? timing.responseId ?? rows.length}`),
      turnIndex: active.index,
      depth: subagentId !== undefined ? 1 : 0,
      status: timing.status ?? 'unknown',
      timing: span,
      ...(timing.model !== undefined ? { model: timing.model } : {}),
      ...(timing.responseId !== undefined
        ? { responseId: timing.responseId }
        : {}),
      ...(timing.promptId !== undefined ? { promptId: timing.promptId } : {}),
    };

    if (subagentId !== undefined) {
      // A delegated round is its own row but does not renumber the main
      // session, so main-session rows after it keep belonging to their request.
      row.subagentId = subagentId;
      const parentCallId = resolveParentToolCallId(subagentId, toolRowByCallId);
      if (parentCallId !== undefined) {
        row.parentToolCallId = parentCallId;
        const summary = summaryFor(parentCallId);
        if (summary) {
          summary.requests += 1;
          summary.requestMs += timing.durationMs;
        }
      }
      push(row);
      return;
    }

    requestCount += 1;
    currentRequestIndex = requestCount;
    row.requestIndex = currentRequestIndex;
    active.requestCount += 1;
    active.requestMs += timing.durationMs;
    usageRowIndex = push(row);
  };

  const addToolTiming = (timing: DaemonTranscriptTimingMeta) => {
    if (timing.callId === undefined) return;
    const fromSubagent = subagentIdFromPromptId(timing.promptId);
    if (fromSubagent !== undefined) {
      const parentCallId = resolveParentToolCallId(
        fromSubagent,
        toolRowByCallId,
      );
      // Counted on the frame, not on the claim below: when subagent blocks are
      // not in the window there is no row to claim and the rollup is all that
      // is left of the call.
      if (parentCallId !== undefined) {
        const summary = summaryFor(parentCallId);
        if (summary) summary.tools += 1;
      }
    }
    const row = rows[toolRowByCallId.get(timing.callId) ?? -1];
    if (row?.kind !== 'tool' || row.timing !== undefined) return;
    // A subagent's call id can repeat a main-session one, and the frame cannot
    // say which it is beyond its prompt id — so both the tool name and the side
    // of the session must agree before a frame is allowed to claim a row.
    if (
      timing.toolName !== undefined &&
      row.block.toolName !== undefined &&
      timing.toolName !== row.block.toolName
    ) {
      return;
    }
    if ((fromSubagent !== undefined) !== row.depth > 0) return;
    row.timing = {
      durationMs: timing.durationMs,
      ...(timing.startedAt !== undefined
        ? { startedAt: timing.startedAt }
        : {}),
    };
    if (timing.toolStatus !== undefined) row.toolStatus = timing.toolStatus;
  };

  const addBlock = (block: DaemonTranscriptBlock) => {
    const depth = parentToolCallIdOf(block) ? 1 : 0;
    if (block.kind === 'user' && depth === 0 && isTurnStart(block)) {
      const opened = openTurn(false);
      const key = blockKey('user', block);
      opened.userRowKey = key;
      push({ kind: 'user', key, turnIndex: opened.index, depth, block });
      return;
    }
    const active = turn ?? openTurn(true);
    const base = {
      turnIndex: active.index,
      depth,
      ...(depth === 0 && currentRequestIndex !== undefined
        ? { requestIndex: currentRequestIndex }
        : {}),
    };

    switch (block.kind) {
      case 'user':
        push({ kind: 'user', key: blockKey('user', block), ...base, block });
        return;
      case 'assistant':
      case 'thought':
        push({
          kind: 'message',
          key: blockKey(block.kind, block),
          ...base,
          block: block as DaemonTextTranscriptBlock,
          thought: block.kind === 'thought',
        });
        return;
      case 'tool': {
        const tool = block as DaemonToolTranscriptBlock;
        const index = push({
          kind: 'tool',
          key: uniqueKey(`tool:${tool.toolCallId}`),
          ...base,
          block: tool,
        });
        // First writer wins: a repeated call id means replay rewrote one of
        // them, and the earlier row is the one its frame will name.
        if (!toolRowByCallId.has(tool.toolCallId)) {
          toolRowByCallId.set(tool.toolCallId, index);
        }
        if (depth === 0) active.toolCount += 1;
        return;
      }
      default:
        push({ kind: 'other', key: blockKey('other', block), ...base, block });
    }
  };

  for (const entry of entries) {
    if (entry.kind === 'block') {
      addBlock(entry.block);
    } else if (entry.kind === 'usage') {
      // The first counts reported after a round's frame are that round's.
      const request =
        usageRowIndex !== undefined ? rows[usageRowIndex] : undefined;
      if (request?.kind === 'request') request.usage = entry.usage;
      usageRowIndex = undefined;
    } else if (entry.timing.kind === 'request') {
      addRequest(entry.timing, entry.recordId);
    } else {
      addToolTiming(entry.timing);
    }
  }

  return { turns, rows, rowIndexByKey };
}
