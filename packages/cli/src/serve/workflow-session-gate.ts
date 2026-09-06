/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import type { ServeSessionSupportedCommandsStatus } from '@qwen-code/acp-bridge/status';

// The daemon's workspace trust verdict never reaches the ACP child's
// workflow gate, so the daemon boundary redacts the surfaces itself with the
// same fail-closed shape the child produces when its own gate denies them.
export function redactWorkflowsFromSupportedCommands(
  status: ServeSessionSupportedCommandsStatus,
): ServeSessionSupportedCommandsStatus {
  return {
    ...status,
    availableCommands: status.availableCommands.filter(
      (command) => command.name !== 'workflows',
    ),
    workflowsEnabled: false,
    savedWorkflows: [],
  };
}

export function redactWorkflowsFromAvailableCommandsEvent<
  T extends { type: string; data: unknown },
>(event: T): T {
  if (event.type !== 'session_update') return event;
  const data = asRecord(event.data);
  if (!data) return event;
  const wrapped = asRecord(data['update']);
  const flat = !wrapped && data['sessionUpdate'] !== undefined;
  const candidate = flat ? data : wrapped;
  if (
    !candidate ||
    candidate['sessionUpdate'] !== 'available_commands_update'
  ) {
    return event;
  }
  const availableCommands = candidate['availableCommands'];
  if (!Array.isArray(availableCommands)) return event;
  const filteredCommands = availableCommands.filter(
    (command) => asRecord(command)?.['name'] !== 'workflows',
  );
  if (filteredCommands.length === availableCommands.length) return event;
  const nextCandidate = {
    ...candidate,
    availableCommands: filteredCommands,
  };
  if (flat) return { ...event, data: nextCandidate };
  return { ...event, data: { ...data, update: nextCandidate } };
}

export function redactWorkflowsFromReplayArrays<
  T extends {
    compactedReplay?: BridgeEvent[];
    liveJournal?: BridgeEvent[];
  },
>(session: T): T {
  if (!session.compactedReplay && !session.liveJournal) return session;
  return {
    ...session,
    ...(session.compactedReplay
      ? {
          compactedReplay: session.compactedReplay.map(
            redactWorkflowsFromAvailableCommandsEvent,
          ),
        }
      : {}),
    ...(session.liveJournal
      ? {
          liveJournal: session.liveJournal.map(
            redactWorkflowsFromAvailableCommandsEvent,
          ),
        }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
