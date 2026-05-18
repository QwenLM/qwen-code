/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Dispatch,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import type { Part, PartListUnion } from '@google/genai';
import type {
  ApprovalMode,
  Config,
  EditorType,
  GeminiClient,
  Logger,
  ThoughtSummary,
} from '@qwen-code/qwen-code-core';
import { MessageSenderType, SendMessageType } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type {
  HistoryItem,
  HistoryItemToolGroup,
  HistoryItemWithoutId,
  SlashCommandProcessorResult,
} from '../types.js';
import { MessageType, StreamingState } from '../types.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import type {
  CancelSubmitInfo,
  useGeminiStream,
} from '../hooks/useGeminiStream.js';
import { DaemonTuiAdapter, type DaemonTuiUpdate } from './DaemonTuiAdapter.js';
import {
  createDaemonTuiSession,
  type CreateDaemonTuiSessionOptions,
} from './createDaemonTuiSession.js';
import type { DaemonTuiRuntimeOptions } from './daemonTuiOptions.js';

/**
 * Daemon-backed implementation of the useGeminiStream contract.
 *
 * The hook is deliberately a renderer adapter: prompts go through
 * DaemonSessionClient, typed daemon events are reduced by DaemonTuiAdapter, and
 * the resulting view items are rendered by the normal TUI. It must not grow a
 * PTY proxy or a second runtime path.
 */
type GeminiStreamResult = ReturnType<typeof useGeminiStream>;
type SubmitQuery = GeminiStreamResult['submitQuery'];
type MergeableTextHistoryItem = Extract<HistoryItemWithoutId, { text: string }>;

interface QueuedSubmission {
  query: PartListUnion;
  submitType: SendMessageType;
}

function stringifyPart(part: Part | string): string {
  if (typeof part === 'string') {
    return part;
  }
  if ('text' in part && typeof part.text === 'string') {
    return part.text;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function partListToText(parts: PartListUnion): string {
  if (typeof parts === 'string') {
    return parts;
  }
  const list = Array.isArray(parts) ? parts : [parts];
  return list.map((part) => stringifyPart(part)).join('');
}

function isMergeableTextItem(
  item: HistoryItemWithoutId,
): item is MergeableTextHistoryItem {
  return (
    item.type === 'gemini' ||
    item.type === 'gemini_content' ||
    item.type === 'gemini_thought' ||
    item.type === 'gemini_thought_content'
  );
}

function canMergeTextItemTypes(
  a: MergeableTextHistoryItem['type'],
  b: MergeableTextHistoryItem['type'],
): boolean {
  const assistantText =
    (a === 'gemini' || a === 'gemini_content') &&
    (b === 'gemini' || b === 'gemini_content');
  const thoughtText =
    (a === 'gemini_thought' || a === 'gemini_thought_content') &&
    (b === 'gemini_thought' || b === 'gemini_thought_content');
  return assistantText || thoughtText;
}

function mergePendingItem(
  pendingItems: HistoryItemWithoutId[],
  incoming: HistoryItemWithoutId,
): HistoryItemWithoutId[] {
  const last = pendingItems[pendingItems.length - 1];
  if (
    last &&
    isMergeableTextItem(last) &&
    isMergeableTextItem(incoming) &&
    canMergeTextItemTypes(last.type, incoming.type)
  ) {
    return [
      ...pendingItems.slice(0, -1),
      { type: last.type, text: `${last.text}${incoming.text}` },
    ];
  }

  return [...pendingItems, incoming];
}

function replacePendingToolGroup(
  pendingItems: HistoryItemWithoutId[],
  incoming: HistoryItemToolGroup,
): HistoryItemWithoutId[] {
  const toolGroupIndex = pendingItems.findIndex(
    (item) => item.type === 'tool_group',
  );
  if (toolGroupIndex < 0) {
    return [...pendingItems, incoming];
  }
  return pendingItems.map((item, index) =>
    index === toolGroupIndex ? incoming : item,
  );
}

function createSessionOptions(
  options: DaemonTuiRuntimeOptions,
): CreateDaemonTuiSessionOptions {
  return {
    daemonUrl: options.daemonUrl,
    token: options.token,
    workspaceCwd: options.workspaceCwd,
    model: options.model,
    sessionId: options.sessionId,
    sessionScope: options.sessionScope,
  };
}

export const useDaemonTuiStream = (
  _geminiClient: GeminiClient,
  _history: HistoryItem[],
  addItem: UseHistoryManagerReturn['addItem'],
  config: Config,
  _settings: LoadedSettings,
  onDebugMessage: (message: string) => void,
  handleSlashCommand: (
    cmd: PartListUnion,
  ) => Promise<SlashCommandProcessorResult | false>,
  _shellModeActive: boolean,
  _getPreferredEditor: () => EditorType | undefined,
  _onAuthError: (error: string) => void,
  _performMemoryRefresh: () => Promise<void>,
  _modelSwitchedFromQuotaError: boolean,
  _setModelSwitchedFromQuotaError: Dispatch<SetStateAction<boolean>>,
  _onEditorClose: () => void,
  _onCancelSubmit: (info?: CancelSubmitInfo) => void,
  _setShellInputFocused: (value: boolean) => void,
  _terminalWidth: number,
  _terminalHeight: number,
  _midTurnDrainRef?: React.RefObject<(() => string[]) | null>,
  logger?: Logger | null,
  daemonOptions?: DaemonTuiRuntimeOptions,
): GeminiStreamResult => {
  const [streamingState, setStreamingState] = useState<StreamingState>(
    StreamingState.Idle,
  );
  const [initError, setInitError] = useState<string | null>(null);
  const [pendingHistoryItems, setPendingHistoryItems] = useState<
    HistoryItemWithoutId[]
  >([]);
  const [thought, setThought] = useState<ThoughtSummary | null>(null);
  const [isReceivingContent, setIsReceivingContent] = useState(false);
  const streamingResponseLengthRef = useRef(0);
  const adapterRef = useRef<DaemonTuiAdapter | null>(null);
  const pendingItemsRef = useRef<HistoryItemWithoutId[]>([]);
  const lastPromptRef = useRef<PartListUnion | null>(null);
  const sendGenerationRef = useRef(0);
  const queuedSubmissionsRef = useRef<QueuedSubmission[]>([]);
  const submitQueryRef = useRef<SubmitQuery | null>(null);

  const runtimeOptions = useMemo(
    () =>
      daemonOptions ?? {
        enabled: true,
        daemonUrl: process.env['QWEN_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
        token: process.env['QWEN_DAEMON_TOKEN'],
        workspaceCwd: config.getTargetDir(),
        model: config.getModel(),
      },
    [config, daemonOptions],
  );

  const setPending = useCallback(
    (
      updater:
        | HistoryItemWithoutId[]
        | ((current: HistoryItemWithoutId[]) => HistoryItemWithoutId[]),
    ) => {
      setPendingHistoryItems((current) => {
        const next = typeof updater === 'function' ? updater(current) : updater;
        pendingItemsRef.current = next;
        return next;
      });
    },
    [],
  );

  const flushPendingItems = useCallback(() => {
    const pending = pendingItemsRef.current;
    if (pending.length === 0) {
      return;
    }
    const timestamp = Date.now();
    for (const item of pending) {
      addItem(item, timestamp);
    }
    setPending([]);
  }, [addItem, setPending]);

  const handleUpdate = useCallback(
    (update: DaemonTuiUpdate) => {
      switch (update.type) {
        case 'history': {
          const item =
            update.item.type === 'gemini_content'
              ? ({ type: 'gemini', text: update.item.text } as const)
              : update.item.type === 'gemini_thought_content'
                ? ({ type: 'gemini_thought', text: update.item.text } as const)
                : update.item;
          if (item.type === 'gemini') {
            streamingResponseLengthRef.current += item.text.length;
            setIsReceivingContent(true);
            setPending((current) => mergePendingItem(current, item));
            return;
          }
          if (item.type === 'gemini_thought') {
            setThought((current) => ({
              subject: current?.subject ?? '',
              description: `${current?.description ?? ''}${item.text}`,
            }));
            setPending((current) => mergePendingItem(current, item));
            return;
          }
          setPending((current) => mergePendingItem(current, item));
          return;
        }
        case 'tool_group_update':
          setPending((current) =>
            replacePendingToolGroup(current, update.item),
          );
          return;
        case 'permission_request':
          // TODO(#3803): wire this to the native permission dialog before this
          // draft can graduate. Showing a warning keeps the unsupported
          // security-sensitive path visible during daemon-native renderer tests.
          setPending((current) => [
            ...current,
            {
              type: MessageType.WARNING,
              text:
                `Daemon requested permission for ${update.request.toolCall.kind}. ` +
                'Native daemon permission UI is not wired in this draft yet.',
            },
          ]);
          return;
        case 'permission_resolved':
          // TODO(#3803): once native daemon permission UI is wired, update the
          // active dialog/tool group instead of appending an informational row.
          setPending((current) => [
            ...current,
            {
              type: MessageType.INFO,
              text: `Daemon permission resolved: ${update.requestId}`,
            },
          ]);
          return;
        case 'model_switched':
          onDebugMessage(`Daemon model switched to ${update.modelId}`);
          return;
        case 'disconnected':
          setStreamingState(StreamingState.Idle);
          setIsReceivingContent(false);
          addItem(
            {
              type: MessageType.ERROR,
              text: `Daemon disconnected: ${update.reason}`,
            },
            Date.now(),
          );
          return;
        default: {
          const neverUpdate: never = update;
          onDebugMessage(
            `Unknown daemon update: ${JSON.stringify(neverUpdate)}`,
          );
        }
      }
    },
    [addItem, onDebugMessage, setPending],
  );

  useEffect(() => {
    if (!runtimeOptions.enabled) {
      return undefined;
    }
    let disposed = false;
    let adapter: DaemonTuiAdapter | null = null;

    const connect = async () => {
      try {
        const session = await createDaemonTuiSession(
          createSessionOptions(runtimeOptions),
        );
        if (disposed) {
          return;
        }
        adapter = new DaemonTuiAdapter({
          session,
          onUpdate: handleUpdate,
        });
        adapter.start();
        adapterRef.current = adapter;
        setInitError(null);
        addItem(
          {
            type: MessageType.INFO,
            text: `Connected to daemon session ${session.sessionId} (${session.workspaceCwd})`,
          },
          Date.now(),
        );
        const queuedSubmissions = queuedSubmissionsRef.current.splice(0);
        for (const queuedSubmission of queuedSubmissions) {
          void submitQueryRef.current?.(
            queuedSubmission.query,
            queuedSubmission.submitType,
          );
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setInitError(message);
        addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to connect daemon TUI: ${message}`,
          },
          Date.now(),
        );
      }
    };

    void connect();

    return () => {
      disposed = true;
      adapterRef.current = null;
      void adapter?.stop();
    };
  }, [addItem, handleUpdate, runtimeOptions]);

  const submitQuery = useCallback(
    async (
      query: PartListUnion,
      submitType: SendMessageType = SendMessageType.UserQuery,
    ) => {
      if (streamingState !== StreamingState.Idle) {
        return;
      }

      const adapter = adapterRef.current;
      if (!adapter) {
        queuedSubmissionsRef.current.push({ query, submitType });
        onDebugMessage('Queued daemon prompt until the session connects');
        return;
      }

      if (typeof query === 'string') {
        const trimmedQuery = query.trim();
        if (trimmedQuery.length === 0) {
          return;
        }

        if (submitType !== SendMessageType.Notification) {
          await logger?.logMessage(MessageSenderType.USER, trimmedQuery);
        }

        const slashCommandResult = trimmedQuery.startsWith('/')
          ? await handleSlashCommand(trimmedQuery)
          : false;
        if (slashCommandResult) {
          if (slashCommandResult.type === 'handled') {
            return;
          }
          if (slashCommandResult.type === 'submit_prompt') {
            query = slashCommandResult.content;
          } else {
            // TODO(#3803): slash commands that schedule local tools need
            // daemon control-plane routes or explicit client-capability RPCs.
            addItem(
              {
                type: MessageType.WARNING,
                text:
                  `Slash command scheduled local tool "${slashCommandResult.toolName}", ` +
                  'but daemon TUI tool scheduling is not wired in this draft yet.',
              },
              Date.now(),
            );
            return;
          }
        } else if (submitType !== SendMessageType.Notification) {
          addItem({ type: MessageType.USER, text: trimmedQuery }, Date.now());
        }
      }

      const generation = ++sendGenerationRef.current;
      lastPromptRef.current = query;
      streamingResponseLengthRef.current = 0;
      setIsReceivingContent(false);
      setThought(null);
      setPending([]);
      setStreamingState(StreamingState.Responding);
      try {
        const promptText = partListToText(query);
        onDebugMessage(`Sending daemon prompt (${promptText.length} chars)`);
        await adapter.sendPrompt(promptText);
        if (sendGenerationRef.current === generation) {
          flushPendingItems();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addItem({ type: MessageType.ERROR, text: message }, Date.now());
      } finally {
        if (sendGenerationRef.current === generation) {
          setStreamingState(StreamingState.Idle);
          setIsReceivingContent(false);
        }
      }
    },
    [
      addItem,
      flushPendingItems,
      handleSlashCommand,
      logger,
      onDebugMessage,
      setPending,
      streamingState,
    ],
  );
  submitQueryRef.current = submitQuery;

  const cancelOngoingRequest = useCallback(() => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return;
    }
    void adapter.cancel().catch((error) => {
      addItem(
        {
          type: MessageType.ERROR,
          text: error instanceof Error ? error.message : String(error),
        },
        Date.now(),
      );
    });
  }, [addItem]);

  const retryLastPrompt = useCallback(async () => {
    if (!lastPromptRef.current) {
      addItem(
        { type: MessageType.INFO, text: 'No daemon prompt to retry.' },
        Date.now(),
      );
      return;
    }
    await submitQuery(lastPromptRef.current, SendMessageType.Retry);
  }, [addItem, submitQuery]);

  const handleApprovalModeChange = useCallback(
    async (_newApprovalMode: ApprovalMode) => {},
    [],
  );

  return {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems,
    thought,
    cancelOngoingRequest,
    retryLastPrompt,
    pendingToolCalls: [],
    handleApprovalModeChange,
    activePtyId: undefined,
    loopDetectionConfirmationRequest: null,
    streamingResponseLengthRef,
    isReceivingContent,
  };
};
