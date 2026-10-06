// Shared wire-format fixtures for the managed-agent SSE tests. Payloads are
// typed against the generated schema so a wire change fails to compile
// instead of leaving tests silently green.

import type {
  JavaAgentEvent,
  JavaAgentSession,
} from './java-managed-agent-client';

export function javaDeltaEvent(sequence: number, text: string): string {
  const payload: JavaAgentEvent = {
    sequence,
    eventId: `evt_${sequence}`,
    sessionId: 'session-1',
    turnId: 'turn-1',
    type: 'item.output_text.delta',
    createdAt: sequence,
    data: { text },
    terminal: false,
  };
  return JSON.stringify(payload);
}

/** A complete item.output_text.delta SSE frame. */
export function sseFrame(sequence: number, text: string): string {
  return `id: ${sequence}\r\nevent: item.output_text.delta\r\ndata: ${javaDeltaEvent(sequence, text)}\r\n\r\n`;
}

/** A complete item.output_text.delta SSE frame with an empty data object. */
export function validEventFrame(sequence: number): string {
  const payload: JavaAgentEvent = {
    sequence,
    eventId: `evt_${sequence}`,
    sessionId: 'session-1',
    turnId: 'turn-1',
    type: 'item.output_text.delta',
    createdAt: sequence,
    data: {},
    terminal: false,
  };
  return `id: ${sequence}\r\nevent: item.output_text.delta\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
}

/** A well-formed SSE frame whose data payload is truncated JSON. */
export function corruptFrame(
  sequence: number,
  name = 'item.output_text.delta',
): string {
  return `id: ${sequence}\r\nevent: ${name}\r\ndata: {"sequence":${sequence}\r\n\r\n`;
}

export function javaSessionPayload(lastSequence: number): string {
  const payload: JavaAgentSession = {
    sessionId: 'session-1',
    agentId: 'dataworks_data_agent',
    status: 'active',
    title: 'Session',
    createdAt: 1,
    updatedAt: 1,
    lastSequence,
    capabilities: { tasks: true, artifacts: false, actions: false },
  };
  return JSON.stringify(payload);
}
