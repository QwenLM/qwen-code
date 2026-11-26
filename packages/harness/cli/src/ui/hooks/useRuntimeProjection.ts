/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CoreToolCallStatus,
  Kind,
  UPDATE_TOPIC_DISPLAY_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  buildToolStatusResult,
  isPayloadResult,
  isSubagentProgress,
  shouldHideToolCall,
  parseThought,
} from '@qwen-code/core';
import type {
  ModelMessage,
  ModelStreamEvent,
  ModelToolUseBlock,
  Config,
  ThoughtSummary,
  SubagentProgress,
  Message,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  MessageType,
  StreamingState,
  mapCoreStatusToDisplayStatus,
  ToolCallStatus,
} from '../types.js';
import type {
  HistoryItemWithoutId,
  HistoryItemInfo,
  HistoryItemThinking,
  IndividualToolCallDisplay,
} from '../types.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import {
  useToolScheduler,
  type TrackedToolCall,
  type TrackedWaitingToolCall,
} from './useToolScheduler.js';
import { calculateStreamingState } from './streamingUtils.js';
import {
  createStreamDeltaBatcher,
  type StreamDeltaBatcher,
  type StreamDeltaKind,
} from './streamDeltaBatcher.js';
import { FRAME_INTERVAL_MS } from '../../ink/constants.js';
import { useStateAndRef } from './useStateAndRef.js';
import { mapToDisplay as mapTrackedToolCallsToDisplay } from './toolMapping.js';
import { isCompactTool } from '../components/messages/ToolGroupMessage.js';
import { getToolGroupBorderAppearance } from '../utils/borderStyles.js';
import { projectToolCallDisplay } from '../utils/toolDisplayProjection.js';
import {
  createAssistantTextProjectionState,
  markAssistantTextCommitted,
  markAssistantTextStreamed,
  resetAssistantTextProjection,
  shouldProjectFinalAssistantText,
} from './runtimeProjectionTextState.js';
import type {
  RuntimeProjectionController,
  RuntimeProjectionSnapshot,
  TurnEnd,
} from './localSession.shared.js';

interface UseRuntimeProjectionOptions {
  config: Config;
  settings: LoadedSettings;
  addItem: UseHistoryManagerReturn['addItem'];
  getPreferredEditor: () =>
    | import('@qwen-code/core').EditorType
    | undefined;
}

const USER_CANCELLED_SUMMARY = 'User cancelled.';
const REFUSAL_UNKNOWN_TOOL_SUMMARY = 'Tool execution status unknown';
const REFUSAL_UNKNOWN_TOOL_PAYLOAD =
  'The model response ended in refusal before the tool result could be confirmed. ' +
  'The tool may not have run, may have partially completed, or may have completed. ' +
  'Inspect the current state before retrying or continuing.';

function isRefusalUnknownToolDisplay(value: unknown): boolean {
  return (
    isPayloadResult(value) &&
    value.summary === REFUSAL_UNKNOWN_TOOL_SUMMARY &&
    value.payload === REFUSAL_UNKNOWN_TOOL_PAYLOAD
  );
}

function isTerminalToolCall(call: TrackedToolCall): boolean {
  return (
    call.status === CoreToolCallStatus.Success ||
    call.status === CoreToolCallStatus.Error ||
    call.status === CoreToolCallStatus.Cancelled
  );
}

function getAgentName(call: TrackedToolCall): string {
  const args = call.request.args;
  if (args && typeof args === 'object') {
    const subagentName = args['subagent_name'];
    if (typeof subagentName === 'string' && subagentName.trim()) {
      return subagentName;
    }
    const name = args['name'];
    if (typeof name === 'string' && name.trim()) {
      return name;
    }
  }
  return call.tool?.displayName ?? call.request.name;
}

function getExistingSubagentProgress(
  call: TrackedToolCall,
): SubagentProgress | undefined {
  const responseResultDisplay =
    'response' in call ? call.response.resultDisplay : undefined;
  if (isSubagentProgress(responseResultDisplay)) {
    return responseResultDisplay;
  }

  const liveOutput = 'liveOutput' in call ? call.liveOutput : undefined;
  if (isSubagentProgress(liveOutput)) {
    return liveOutput;
  }

  const responseToolUseResult =
    'response' in call ? call.response.toolUseResult : undefined;
  if (isSubagentProgress(responseToolUseResult)) {
    return responseToolUseResult;
  }

  return undefined;
}

function isTerminalSubagentProgress(progress: SubagentProgress): boolean {
  return (
    progress.state === 'completed' ||
    progress.state === 'error' ||
    progress.state === 'cancelled'
  );
}

function buildCancelledDisplayCall(call: TrackedToolCall): TrackedToolCall {
  if (isTerminalToolCall(call)) {
    return call;
  }

  const statusResult = buildToolStatusResult(
    'cancelled',
    USER_CANCELLED_SUMMARY,
  );
  const statusData: Record<string, unknown> = { ...statusResult };

  if (call.tool?.kind !== Kind.Agent) {
    return {
      ...call,
      status: CoreToolCallStatus.Cancelled,
      response: {
        callId: call.request.callId,
        responseParts: [],
        resultDisplay: USER_CANCELLED_SUMMARY,
        error: new Error(USER_CANCELLED_SUMMARY),
        errorType: undefined,
        data: statusData,
        toolUseResult: statusResult,
      },
    } as TrackedToolCall;
  }

  const existingProgress = getExistingSubagentProgress(call);

  const progress =
    existingProgress && isTerminalSubagentProgress(existingProgress)
      ? existingProgress
      : {
          ...existingProgress,
          isSubagentProgress: true as const,
          agentName: existingProgress?.agentName ?? getAgentName(call),
          recentActivity: existingProgress?.recentActivity?.length
            ? existingProgress.recentActivity
            : [
                {
                  id: `${call.request.callId}-cancelled`,
                  type: 'thought' as const,
                  status: 'cancelled' as const,
                  content: 'Request cancelled.',
                },
              ],
          state: 'cancelled' as const,
          result: USER_CANCELLED_SUMMARY,
        };

  return {
    ...call,
    status: CoreToolCallStatus.Error,
    response: {
      callId: call.request.callId,
      responseParts: [],
      resultDisplay: progress,
      error: new Error(USER_CANCELLED_SUMMARY),
      errorType: undefined,
      data: statusData,
      toolUseResult: progress,
    },
  } as TrackedToolCall;
}

const isTopicTool = (name: string): boolean =>
  name === UPDATE_TOPIC_TOOL_NAME || name === UPDATE_TOPIC_DISPLAY_NAME;

function makeThinkingItem(thought: ThoughtSummary): HistoryItemThinking {
  return { type: 'thinking', thought } as HistoryItemThinking;
}

export function useRuntimeProjection(
  options: UseRuntimeProjectionOptions,
): RuntimeProjectionSnapshot & { controller: RuntimeProjectionController } {
  const { config, settings, addItem, getPreferredEditor } = options;

  const [isResponding, isRespondingRef, setIsResponding] =
    useStateAndRef<boolean>(false);
  const [isModelTurnActive, , setIsModelTurnActive] =
    useStateAndRef<boolean>(false);
  const [lastTurnEnd, setLastTurnEnd] = useState<TurnEnd>(null);
  // Outcome of the in-flight turn; committed to lastTurnEnd by finishTurn().
  const pendingTurnEndRef = useRef<TurnEnd>(null);
  // Whether the model took part in the in-flight turn. A turn it never
  // joined (local slash command) ends as null rather than 'completed'.
  const modelJoinedTurnRef = useRef(false);
  const [thought, thoughtRef, setThought] =
    useStateAndRef<ThoughtSummary | null>(null);
  const [pendingHistoryItem, pendingHistoryItemRef, setPendingHistoryItem] =
    useStateAndRef<HistoryItemWithoutId | null>(null);
  const [pushedToolCallIds, pushedToolCallIdsRef, setPushedToolCallIds] =
    useStateAndRef<Set<string>>(new Set());
  const [_isFirstToolInGroup, isFirstToolInGroupRef, setIsFirstToolInGroup] =
    useStateAndRef<boolean>(true);

  // Accumulates raw thinking text across thinking_delta events so we can
  // parse the full thought rather than individual fragments. Only mutated
  // when the delta batcher applies (and at the lifecycle resets below), so
  // buffered-but-unapplied thinking never leaks into a text transition.
  const accumulatedThinkingRef = useRef<string>('');
  const textProjectionStateRef = useRef(createAssistantTextProjectionState());
  const streamedToolUsesRef = useRef(new Map<string, ModelToolUseBlock>());

  // Ref flag: when true, the projected streaming state always returns Idle.
  // This breaks the race condition where post-cancel scheduler events
  // re-populate toolCallsMap before React processes the batch clear.
  const turnCancelledRef = useRef(false);

  const handleToolComplete = useCallback(async () => {}, []);
  const [
    toolCalls,
    markToolsAsSubmitted,
    setToolCallsForDisplay,
    cancelAllToolCalls,
    ,
    retireToolCalls,
  ] = useToolScheduler(handleToolComplete, config, getPreferredEditor);
  const toolCallsRef = useRef(toolCalls);
  toolCallsRef.current = toolCalls;

  // When the turn is cancelled, force Idle state regardless of lingering
  // tool-call events that may arrive after cancellation.
  const streamingState = useMemo(
    () =>
      turnCancelledRef.current
        ? StreamingState.Idle
        : calculateStreamingState(isResponding, toolCalls),
    [isResponding, toolCalls],
  );

  useEffect(() => {
    if (toolCalls.length > 0) {
      const isNewBatch = !toolCalls.some((tc) =>
        pushedToolCallIdsRef.current.has(tc.request.callId),
      );
      if (isNewBatch) {
        setPushedToolCallIds(new Set());
        setIsFirstToolInGroup(true);
      }
    } else if (streamingState === StreamingState.Idle) {
      setPushedToolCallIds(new Set());
      setIsFirstToolInGroup(true);
    }
  }, [
    toolCalls,
    pushedToolCallIdsRef,
    setPushedToolCallIds,
    setIsFirstToolInGroup,
    streamingState,
  ]);

  useEffect(() => {
    const toolsToPush: TrackedToolCall[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (pushedToolCallIdsRef.current.has(tc.request.callId)) continue;

      if (
        tc.status === 'success' ||
        tc.status === 'error' ||
        tc.status === 'cancelled'
      ) {
        const isAgent = tc.tool?.kind === Kind.Agent;
        if (isAgent) {
          let contigAgentsComplete = true;
          for (let j = i + 1; j < toolCalls.length; j++) {
            const nextTc = toolCalls[j];
            if (nextTc.tool?.kind === Kind.Agent) {
              if (
                nextTc.status !== 'success' &&
                nextTc.status !== 'error' &&
                nextTc.status !== 'cancelled'
              ) {
                contigAgentsComplete = false;
                break;
              }
            } else {
              break;
            }
          }

          if (!contigAgentsComplete) {
            break;
          }
        }

        toolsToPush.push(tc);
      } else {
        break;
      }
    }

    if (toolsToPush.length === 0) {
      return;
    }

    // Keep this below the early return: flushing on every liveOutput tick
    // would defeat the batching.
    streamBatcherRef.current?.flush();
    const currentPending = pendingHistoryItemRef.current;
    if (currentPending) {
      addItem(currentPending);
      setPendingHistoryItem(null);
    }

    const newPushed = new Set(pushedToolCallIdsRef.current);
    const isFirstInThisPush = isFirstToolInGroupRef.current;
    const isCompactModeEnabled = settings.merged.ui?.compactToolOutput === true;

    const groups: TrackedToolCall[][] = [];
    let currentGroup: TrackedToolCall[] = [];

    for (const tc of toolsToPush) {
      newPushed.add(tc.request.callId);

      if (tc.tool?.kind === Kind.Agent) {
        currentGroup.push(tc);
      } else {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
        groups.push([tc]);
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    const stubActiveShellPtyId: number | undefined = undefined;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const isFirstInBatch = i === 0 && isFirstInThisPush;
      const lastTcInGroup = group[group.length - 1];
      const tcIndexInBatch = toolCalls.indexOf(lastTcInGroup);
      const isLastInBatch = tcIndexInBatch === toolCalls.length - 1;

      const nextTcInBatch =
        tcIndexInBatch < toolCalls.length - 1
          ? toolCalls[tcIndexInBatch + 1]
          : null;
      const prevTcInBatch =
        toolCalls.indexOf(group[0]) > 0
          ? toolCalls[toolCalls.indexOf(group[0]) - 1]
          : null;

      const historyItem = mapTrackedToolCallsToDisplay(group, {
        ...getToolGroupBorderAppearance(
          { type: 'tool_group', tools: toolCalls },
          stubActiveShellPtyId,
          [],
        ),
      });

      const currentIsCompact =
        historyItem.tools.length === 1 &&
        isCompactTool(historyItem.tools[0], isCompactModeEnabled);

      let nextIsCompact = false;
      if (nextTcInBatch) {
        const nextHistoryItem = mapTrackedToolCallsToDisplay(nextTcInBatch);
        nextIsCompact =
          nextHistoryItem.tools.length === 1 &&
          isCompactTool(nextHistoryItem.tools[0], isCompactModeEnabled);
      }

      let prevWasCompact = false;
      if (prevTcInBatch) {
        const prevHistoryItem = mapTrackedToolCallsToDisplay(prevTcInBatch);
        prevWasCompact =
          prevHistoryItem.tools.length === 1 &&
          isCompactTool(prevHistoryItem.tools[0], isCompactModeEnabled);
      }

      historyItem.borderTop =
        isFirstInBatch || (!currentIsCompact && prevWasCompact);
      historyItem.borderBottom = currentIsCompact
        ? isLastInBatch && !nextIsCompact
        : isLastInBatch || nextIsCompact;

      addItem(historyItem);
    }

    setPushedToolCallIds(newPushed);

    if (
      isFirstToolInGroupRef.current &&
      toolsToPush.every((tc) => isTopicTool(tc.request.name))
    ) {
      return;
    }
    setIsFirstToolInGroup(false);
  }, [
    toolCalls,
    pushedToolCallIdsRef,
    pendingHistoryItemRef,
    setPendingHistoryItem,
    isFirstToolInGroupRef,
    setPushedToolCallIds,
    setIsFirstToolInGroup,
    addItem,
    settings.merged.ui?.compactToolOutput,
  ]);

  const pendingToolGroupItems = useMemo((): HistoryItemWithoutId[] => {
    const remainingTools = toolCalls.filter(
      (tc) => !pushedToolCallIds.has(tc.request.callId),
    );

    const items: HistoryItemWithoutId[] = [];
    const stubActiveShellPtyId: number | undefined = undefined;

    const appearance = getToolGroupBorderAppearance(
      { type: 'tool_group', tools: toolCalls },
      stubActiveShellPtyId,
      [],
    );

    if (remainingTools.length > 0) {
      let needsTopBorder = pushedToolCallIds.size === 0;
      if (!needsTopBorder) {
        const allPushedWereTopics = toolCalls
          .filter((tc) => pushedToolCallIds.has(tc.request.callId))
          .every((tc) => isTopicTool(tc.request.name));
        if (allPushedWereTopics) {
          needsTopBorder = true;
        }
      }

      items.push(
        mapTrackedToolCallsToDisplay(remainingTools, {
          borderTop: needsTopBorder,
          borderBottom: false,
          ...appearance,
        }),
      );
    }

    const allTerminal =
      toolCalls.length > 0 &&
      toolCalls.every(
        (tc) =>
          tc.status === 'success' ||
          tc.status === 'error' ||
          tc.status === 'cancelled',
      );

    const allPushed =
      toolCalls.length > 0 &&
      toolCalls.every((tc) => pushedToolCallIds.has(tc.request.callId));

    const isToolVisible = (tc: TrackedToolCall) => {
      let hasResultDisplay = false;
      if (
        tc.status === CoreToolCallStatus.Success ||
        tc.status === CoreToolCallStatus.Error ||
        tc.status === CoreToolCallStatus.Cancelled
      ) {
        hasResultDisplay =
          !!mapTrackedToolCallsToDisplay(tc).tools[0]?.resultDisplay;
      } else if (tc.status === CoreToolCallStatus.Executing) {
        hasResultDisplay = !!tc.liveOutput;
      }

      if (
        shouldHideToolCall({
          toolName: tc.request.name,
          status: tc.status,
          planModeActive: tc.planModeActive,
          hasResultDisplay,
          parentCallId: tc.request.parentCallId,
          input: tc.request.args,
        })
      ) {
        return false;
      }

      const displayStatus = mapCoreStatusToDisplayStatus(tc.status);
      if (displayStatus === ToolCallStatus.Confirming) {
        return false;
      }

      return true;
    };

    let lastVisibleIsCompact = false;
    const isCompactModeEnabled = settings.merged.ui?.compactToolOutput === true;
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      if (isToolVisible(toolCalls[i])) {
        const mapped = mapTrackedToolCallsToDisplay(toolCalls[i]);
        lastVisibleIsCompact = mapped.tools[0]
          ? isCompactTool(mapped.tools[0], isCompactModeEnabled)
          : false;
        break;
      }
    }

    if (
      toolCalls.length > 0 &&
      !(allTerminal && allPushed) &&
      toolCalls.some(isToolVisible) &&
      !lastVisibleIsCompact
    ) {
      items.push({
        type: 'tool_group',
        tools: [] as IndividualToolCallDisplay[],
        borderTop: false,
        borderBottom: true,
        ...appearance,
      });
    }

    return items;
  }, [toolCalls, pushedToolCallIds, settings.merged.ui?.compactToolOutput]);

  const pendingHistoryItems = useMemo(
    () =>
      [pendingHistoryItem, ...pendingToolGroupItems].filter(
        (item): item is HistoryItemWithoutId =>
          item !== null && item !== undefined,
      ),
    [pendingHistoryItem, pendingToolGroupItems],
  );
  const snapshot = useMemo<RuntimeProjectionSnapshot>(
    () => ({
      streamingState,
      isModelTurnActive,
      thought,
      pendingHistoryItems,
      pendingToolCalls: toolCalls,
      lastTurnEnd,
    }),
    [
      streamingState,
      isModelTurnActive,
      thought,
      pendingHistoryItems,
      toolCalls,
      lastTurnEnd,
    ],
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const applyStreamDeltas = useCallback(
    (kind: StreamDeltaKind, text: string) => {
      if (kind === 'text') {
        // Flush any pending thinking item before switching to text
        const prev = pendingHistoryItemRef.current;
        if (prev && prev.type === 'thinking') {
          addItem(prev);
          setPendingHistoryItem(null);
        }
        // Reset accumulated thinking for the next thinking block
        accumulatedThinkingRef.current = '';
        setPendingHistoryItem((prev) => {
          if (!prev || prev.type !== 'gemini') {
            return { type: 'gemini', text };
          }
          return { ...prev, text: (prev.text ?? '') + text };
        });
        if (thoughtRef.current !== null) {
          setThought(null);
        }
      } else {
        // Accumulate raw thinking text across deltas
        accumulatedThinkingRef.current += text;
        const parsed = parseThought(accumulatedThinkingRef.current);
        if (parsed) {
          setThought(parsed);
          // Update the pending thinking history item with the full accumulated text
          setPendingHistoryItem((prev) => {
            if (prev && prev.type === 'thinking') {
              return makeThinkingItem(parsed);
            }
            // Flush non-thinking pending item if present
            if (prev) {
              addItem(prev);
            }
            return makeThinkingItem(parsed);
          });
        }
      }
    },
    [
      addItem,
      setPendingHistoryItem,
      pendingHistoryItemRef,
      thoughtRef,
      setThought,
    ],
  );

  const applyStreamDeltasRef = useRef(applyStreamDeltas);
  useEffect(() => {
    applyStreamDeltasRef.current = applyStreamDeltas;
  }, [applyStreamDeltas]);

  // Coalesces per-delta state updates: each delta event is its own React
  // commit and every commit runs a full yoga layout, so a backlogged stream
  // pays one layout per overdue delta. Half the paint interval so the apply
  // cadence cannot phase-alias against ink's own frame throttle.
  const streamBatcherRef = useRef<StreamDeltaBatcher | null>(null);
  if (streamBatcherRef.current === null) {
    streamBatcherRef.current = createStreamDeltaBatcher({
      windowMs: FRAME_INTERVAL_MS / 2,
      // Late-bound so fake timers installed after mount still govern it.
      now: () => Date.now(),
      onApply: (kind, text) => applyStreamDeltasRef.current(kind, text),
    });
  }
  const streamBatcher = streamBatcherRef.current;

  useEffect(() => () => streamBatcher.discard(), [streamBatcher]);

  const handleStreamEvent = useCallback(
    (event: ModelStreamEvent) => {
      // A late provider event after cancelTurn must not resurrect the
      // pending item (the batcher timer would widen that race past
      // teardown otherwise).
      if (turnCancelledRef.current) return;
      if (event.type !== 'content_block_delta') return;

      const { delta } = event;
      if (delta.type === 'text_delta') {
        markAssistantTextStreamed(textProjectionStateRef.current);
        streamBatcher.push('text', delta.text);
      } else if (delta.type === 'thinking_delta') {
        streamBatcher.push('thinking', delta.thinking);
      }
    },
    [streamBatcher],
  );

  const handleAssistantBlock = useCallback(
    (message: ModelMessage, _index: number) => {
      // Cancellation already committed the pending output before its notice.
      if (turnCancelledRef.current) return;
      streamBatcher.flush();
      const block = message.blocks[0];
      if (!block) return;

      if (block.type === 'text' && block.text) {
        markAssistantTextCommitted(textProjectionStateRef.current);
        const prev = pendingHistoryItemRef.current;
        if (prev && prev.type === 'thinking') {
          addItem(prev);
        }
        addItem({ type: 'gemini', text: block.text });
        setPendingHistoryItem(null);
      }
      if (block.type === 'tool_use') {
        streamedToolUsesRef.current.set(block.id, block);
      }
      // Thinking blocks are handled by handleStreamEvent during streaming;
      // no action needed here to avoid duplicate thinking history items.
    },
    [addItem, setPendingHistoryItem, pendingHistoryItemRef, streamBatcher],
  );

  const handleToolResultMessage = useCallback(
    (message: Extract<Message, { type: 'user' }>) => {
      if (!Array.isArray(message.message.content)) return;
      const resultBlocks = message.message.content.filter(
        (block) => block.type === 'tool_result',
      );
      const structuredResults = Array.isArray(message.toolUseResult)
        ? message.toolUseResult
        : [message.toolUseResult];
      const displays: IndividualToolCallDisplay[] = [];
      const retiredCallIds: string[] = [];
      const newPushed = new Set(pushedToolCallIdsRef.current);

      for (let index = 0; index < resultBlocks.length; index++) {
        const block = resultBlocks[index];
        const structuredResult = structuredResults[index];
        if (
          block.is_error !== true ||
          !isRefusalUnknownToolDisplay(structuredResult) ||
          newPushed.has(block.tool_use_id)
        ) {
          continue;
        }

        const runtimeCall = toolCallsRef.current.find(
          (call) => call.request.callId === block.tool_use_id,
        );
        const streamedToolUse = streamedToolUsesRef.current.get(
          block.tool_use_id,
        );
        const toolName = runtimeCall?.request.name ?? streamedToolUse?.name;
        if (!toolName) continue;

        displays.push(
          projectToolCallDisplay({
            toolUse: {
              id: block.tool_use_id,
              name: toolName,
              input: runtimeCall?.request.args ?? streamedToolUse?.input ?? {},
              parentCallId: runtimeCall?.request.parentCallId,
              originalRequestName: runtimeCall?.request.originalRequestName,
            },
            toolResult: {
              content: block.content,
              isError: true,
              toolUseResult: structuredResult,
            },
            runtime: runtimeCall
              ? {
                  kind: runtimeCall.tool?.kind,
                }
              : undefined,
          }),
        );
        retiredCallIds.push(block.tool_use_id);
        newPushed.add(block.tool_use_id);
      }

      if (displays.length === 0) return;
      retireToolCalls(retiredCallIds);
      const currentPending = pendingHistoryItemRef.current;
      if (currentPending) {
        addItem(currentPending);
        setPendingHistoryItem(null);
      }
      const historyItem: HistoryItemWithoutId = {
        type: 'tool_group',
        tools: displays,
        borderTop: true,
        borderBottom: true,
      };
      addItem(historyItem);
      setPushedToolCallIds(newPushed);
    },
    [
      addItem,
      pendingHistoryItemRef,
      pushedToolCallIdsRef,
      setPendingHistoryItem,
      setPushedToolCallIds,
      retireToolCalls,
    ],
  );

  const handleAssistantMessage = useCallback(
    (message: Parameters<RuntimeProjectionController['handleAssistantMessage']>[0]) => {
      // The loop still emits partial assistant messages while draining an abort.
      if (turnCancelledRef.current) return;
      streamBatcher.flush();
      let fullText = '';
      for (const block of message.content) {
        if (block.type === 'text') {
          fullText += block.text;
        }
      }

      if (fullText) {
        if (shouldProjectFinalAssistantText(textProjectionStateRef.current)) {
          addItem({ type: 'gemini', text: fullText });
        }
        setPendingHistoryItem(null);
      }
      setThought(null);
    },
    [addItem, setPendingHistoryItem, setThought, streamBatcher],
  );

  const flushPendingToHistory = useCallback(
    (options?: { skipEmptyAssistant?: boolean }) => {
      streamBatcher.flush();
      const currentPending = pendingHistoryItemRef.current;
      if (!currentPending) {
        return;
      }
      if (
        options?.skipEmptyAssistant &&
        currentPending.type === 'gemini' &&
        !currentPending.text
      ) {
        setPendingHistoryItem(null);
        return;
      }
      addItem(currentPending);
      setPendingHistoryItem(null);
    },
    [addItem, pendingHistoryItemRef, setPendingHistoryItem, streamBatcher],
  );

  const controller = useMemo<RuntimeProjectionController>(
    () => ({
      getSnapshot: () => snapshotRef.current,
      startTurn: ({ modelTurnActive = false } = {}) => {
        // Pending state is reset below, so buffered deltas from a dead
        // stream are dropped rather than applied.
        streamBatcher.discard();
        turnCancelledRef.current = false;
        accumulatedThinkingRef.current = '';
        resetAssistantTextProjection(textProjectionStateRef.current);
        setThought(null);
        setPendingHistoryItem(null);
        setToolCallsForDisplay([]);
        streamedToolUsesRef.current.clear();
        pendingTurnEndRef.current = null;
        modelJoinedTurnRef.current = modelTurnActive;
        setIsModelTurnActive(modelTurnActive);
        setIsResponding(true);
      },
      handleInputResolved: (shouldQuery) => {
        modelJoinedTurnRef.current = shouldQuery;
        setIsModelTurnActive(shouldQuery);
      },
      handleRequestStart: () => {
        streamBatcher.flush();
        modelJoinedTurnRef.current = true;
        // Keep model participation active for the entire agentic turn. A
        // provider request ends before its tools execute, but the model-owned
        // turn continues until finishTurn() or cancelTurn().
        setIsModelTurnActive(true);
        const prev = pendingHistoryItemRef.current;
        const isPrevEmpty = prev?.type === 'gemini' && !prev.text;
        if (prev && !isPrevEmpty) {
          addItem(prev);
        }
        // Reset accumulated thinking so a new model call doesn't
        // stack onto thinking text from the previous call in the
        // same turn (e.g. after compaction or tool-use iterations).
        accumulatedThinkingRef.current = '';
        resetAssistantTextProjection(textProjectionStateRef.current);
        setThought(null);
        setPendingHistoryItem({ type: 'gemini', text: '' });
        // Reset the throttle clock so the new request's first delta takes
        // the leading edge even when requests are < one window apart
        // (fast tool loops).
        streamBatcher.discard();
      },
      handleStreamEvent,
      handleAssistantBlock,
      handleAssistantMessage,
      handleToolResultMessage,
      markToolResultsSubmitted: (toolUseIds: string[]) => {
        if (toolUseIds.length > 0) {
          markToolsAsSubmitted(toolUseIds);
        }
      },
      flushPendingToHistory,
      recordTurnEnd: (outcome) => {
        pendingTurnEndRef.current = outcome;
      },
      finishTurn: () => {
        // The orchestrator always runs flushPendingToHistory before
        // finishTurn, so anything still buffered here is intentionally
        // dropped instead of resurrecting a pending item post-turn.
        streamBatcher.discard();
        if (!turnCancelledRef.current) {
          setLastTurnEnd(
            pendingTurnEndRef.current ??
              (modelJoinedTurnRef.current ? 'completed' : null),
          );
        }
        pendingTurnEndRef.current = null;
        setIsModelTurnActive(false);
        setIsResponding(false);
        setThought(null);
        setToolCallsForDisplay([]);
        accumulatedThinkingRef.current = '';
      },
      cancelTurn: () => {
        if (turnCancelledRef.current) {
          return;
        }
        turnCancelledRef.current = true;
        pendingTurnEndRef.current = null;
        setLastTurnEnd('cancelled');
        streamBatcher.flush();
        const unpushedToolCalls = toolCalls.filter(
          (tc) => !pushedToolCallIdsRef.current.has(tc.request.callId),
        );
        const cancelledToolCalls = unpushedToolCalls.map(
          buildCancelledDisplayCall,
        );
        flushPendingToHistory();
        if (cancelledToolCalls.length > 0) {
          const stubActiveShellPtyId: number | undefined = undefined;
          addItem(
            mapTrackedToolCallsToDisplay(cancelledToolCalls, {
              ...getToolGroupBorderAppearance(
                { type: 'tool_group', tools: cancelledToolCalls },
                stubActiveShellPtyId,
                [],
              ),
              borderTop: true,
              borderBottom: true,
            }),
          );
        }
        setToolCallsForDisplay([]);
        if (cancelledToolCalls.length === 0) {
          addItem({ type: MessageType.INFO, text: 'Request cancelled.' });
        }
        setIsResponding(false);
        setIsModelTurnActive(false);
        setThought(null);
        accumulatedThinkingRef.current = '';
        streamBatcher.discard();
      },
      getStreamingState: () =>
        turnCancelledRef.current
          ? StreamingState.Idle
          : calculateStreamingState(isRespondingRef.current, toolCalls),
      getToolCalls: () => toolCalls,
      getAwaitingApprovalCalls: () =>
        toolCalls.filter(
          (tc): tc is TrackedWaitingToolCall =>
            tc.status === 'awaiting_approval' && !tc.request.forcedAsk,
        ),
      cancelAllToolCalls,
    }),
    [
      addItem,
      cancelAllToolCalls,
      flushPendingToHistory,
      handleAssistantBlock,
      handleAssistantMessage,
      handleToolResultMessage,
      handleStreamEvent,
      isRespondingRef,
      markToolsAsSubmitted,
      pendingHistoryItemRef,
      pushedToolCallIdsRef,
      setIsResponding,
      setIsModelTurnActive,
      setPendingHistoryItem,
      setThought,
      setToolCallsForDisplay,
      streamBatcher,
      toolCalls,
    ],
  );

  return {
    controller,
    ...snapshot,
  };
}

function formatSupplementarySystemContent(item: HistoryItemInfo): string {
  const segments = [];
  if (item.source) {
    segments.push(`hook=${item.source}`);
  }
  if (item.secondaryText) {
    segments.push(`event=${item.secondaryText}`);
  }
  segments.push(item.text);
  return segments.join(' ');
}

export { formatSupplementarySystemContent };
