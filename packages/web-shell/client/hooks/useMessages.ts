import { useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useTranscriptBlocks,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import { transcriptBlocksToDaemonMessages } from '../adapters/transcriptToMessages';
import type { Message } from '../adapters/types';
import { isBackgroundSubAgentToolCall } from '../adapters/toolClassification';

type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface BackgroundAgentResolution {
  status: string;
  durationMs?: number;
}

export function transcriptBlocksToLocalizedMessages(
  blocks: readonly DaemonTranscriptBlock[],
  t: Translator,
): Message[] {
  return transcriptBlocksToDaemonMessages(blocks, {
    labels: {
      promptCancelled: t('request.cancelled'),
      branchSuccess: (name) => t('branch.success', { name }),
      midTurnInserted: (message) => t('midTurn.inserted', { message }),
      modelStreamInterrupted: t('error.modelStreamInterrupted'),
    },
  });
}

function isActiveStatus(status: string): boolean {
  return (
    status === 'pending' || status === 'in_progress' || status === 'running'
  );
}

function isTerminalBackgroundAgentStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getBackgroundAgentNotificationKey(
  blocks: readonly DaemonTranscriptBlock[],
): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== 'assistant') continue;
    const meta = getRecord(block.meta);
    const task = getRecord(meta?.['backgroundTask']);
    const status = task?.['status'];
    if (
      meta?.['source'] === 'background_notification' &&
      task?.['kind'] === 'agent' &&
      typeof status === 'string' &&
      isTerminalBackgroundAgentStatus(status)
    ) {
      return `${block.id}:${status}`;
    }
  }
  return '';
}

export function getPendingBackgroundAgentKey(
  messages: readonly Message[],
): string {
  const callIds: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    for (const tool of message.tools) {
      if (isActiveStatus(tool.status) && isBackgroundSubAgentToolCall(tool)) {
        callIds.push(tool.callId);
      }
    }
  }
  return callIds.join('|');
}

export function reconcileBackgroundAgentResolutions(
  messages: Message[],
  resolutions: ReadonlyMap<string, BackgroundAgentResolution>,
): Message[] {
  if (resolutions.size === 0) return messages;

  let changed = false;
  const reconciled = messages.map((message): Message => {
    if (message.role !== 'tool_group') return message;
    let toolsChanged = false;
    const tools = message.tools.map((tool): (typeof message.tools)[number] => {
      const resolution = resolutions.get(tool.callId);
      if (
        !resolution ||
        !isTerminalBackgroundAgentStatus(resolution.status) ||
        !isActiveStatus(tool.status) ||
        !isBackgroundSubAgentToolCall(tool)
      ) {
        return tool;
      }
      toolsChanged = true;
      const cancelled =
        resolution.status === 'cancelled' || resolution.status === 'canceled';
      const status: typeof tool.status =
        resolution.status === 'failed' ? 'failed' : 'completed';
      return {
        ...tool,
        status,
        ...(tool.startTime !== undefined
          ? { endTime: tool.startTime + (resolution.durationMs ?? 0) }
          : {}),
        ...(cancelled
          ? {
              rawOutput: {
                ...(typeof tool.rawOutput === 'object' &&
                tool.rawOutput !== null &&
                !Array.isArray(tool.rawOutput)
                  ? tool.rawOutput
                  : {}),
                status: 'cancelled',
              },
            }
          : {}),
      };
    });
    if (!toolsChanged) return message;
    changed = true;
    return { ...message, tools };
  });
  return changed ? reconciled : messages;
}

export function useMessages(t: Translator): Message[] {
  const blocks = useTranscriptBlocks();
  const workspace = useWorkspace();
  const connection = useConnection();
  const messages = useMemo(
    () => transcriptBlocksToLocalizedMessages(blocks, t),
    [blocks, t],
  );
  const pendingBackgroundAgentKey = useMemo(
    () => getPendingBackgroundAgentKey(messages),
    [messages],
  );
  const backgroundAgentNotificationKey = useMemo(
    () => getBackgroundAgentNotificationKey(blocks),
    [blocks],
  );
  const [resolutionSnapshot, setResolutionSnapshot] = useState<{
    sessionId: string;
    resolutions: ReadonlyMap<string, BackgroundAgentResolution>;
  }>();
  const reconciliationRequestRef = useRef<
    | {
        key: string;
        request: Promise<ReadonlyMap<string, BackgroundAgentResolution>>;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    const sessionId = connection.sessionId;
    if (
      !sessionId ||
      connection.status !== 'connected' ||
      connection.loadingTranscript ||
      connection.catchingUp ||
      !pendingBackgroundAgentKey
    ) {
      if (
        !sessionId ||
        connection.status !== 'connected' ||
        connection.loadingTranscript ||
        connection.catchingUp
      ) {
        reconciliationRequestRef.current = undefined;
      }
      return;
    }
    const requestKey = `${sessionId}:${pendingBackgroundAgentKey}:${backgroundAgentNotificationKey}`;
    const existingRequest = reconciliationRequestRef.current;
    const callIds = pendingBackgroundAgentKey.split('|');
    const request =
      existingRequest?.key === requestKey
        ? existingRequest.request
        : Promise.allSettled(
            callIds.map(async (callId) => {
              // @ts-expect-error resolveSubagentSession exists in SDK source, not in stale dist
              const resolution = await workspace.client.resolveSubagentSession(
                sessionId,
                callId,
              );
              return [callId, resolution] as const;
            }),
          ).then((results) => {
            const resolutions = new Map<string, BackgroundAgentResolution>();
            results.forEach((result) => {
              if (
                result.status === 'fulfilled' &&
                isTerminalBackgroundAgentStatus(result.value[1].status)
              ) {
                resolutions.set(...result.value);
              }
            });
            return resolutions;
          });
    reconciliationRequestRef.current = { key: requestKey, request };
    let active = true;
    request
      .then((resolutions) => {
        if (active) {
          setResolutionSnapshot((current) => ({
            sessionId,
            resolutions: new Map([
              ...(current?.sessionId === sessionId ? current.resolutions : []),
              ...resolutions,
            ]),
          }));
        }
      })
      .catch(() => {
        if (reconciliationRequestRef.current?.request === request) {
          reconciliationRequestRef.current = undefined;
        }
      });
    return () => {
      active = false;
    };
  }, [
    backgroundAgentNotificationKey,
    connection.catchingUp,
    connection.loadingTranscript,
    connection.sessionId,
    connection.status,
    pendingBackgroundAgentKey,
    workspace.client,
  ]);

  return useMemo(() => {
    if (
      !resolutionSnapshot ||
      resolutionSnapshot.sessionId !== connection.sessionId
    ) {
      return messages;
    }
    return reconcileBackgroundAgentResolutions(
      messages,
      resolutionSnapshot.resolutions,
    );
  }, [connection.sessionId, messages, resolutionSnapshot]);
}
