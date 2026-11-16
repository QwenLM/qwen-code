// Shared wire-format fixtures for the managed-agent SSE tests. Payloads are
// the SERVER side of the Public REST wire, typed against the generated
// schema so a wire change fails to compile instead of leaving tests silently
// green. The Public wire carries epoch SECONDS for Session/Turn/Event/Item
// timestamps; the client adapter converts them to the frozen camelCase
// contract (millis) before anything downstream sees them.

import type { components } from './generated/managed-agent-api';

type Schemas = components['schemas'];

// A realistic epoch: a fixture of 0 or 1 would pass under either unit and
// prove nothing about the seconds-to-millis adaptation.
const SECONDS = 1_790_777_114;

export function publicDeltaEvent(sequence: number, text: string): string {
  const payload: Schemas['PublicEvent'] = {
    schema_version: 1,
    projection_version: 1,
    sequence,
    event_id: `evt_${sequence}`,
    session_id: 'session-1',
    turn_id: 'turn-1',
    type: 'item.output_text.delta',
    created_at: SECONDS + sequence,
    data: { text },
    terminal: false,
  };
  return JSON.stringify(payload);
}

/** A complete item.output_text.delta SSE frame. */
export function sseFrame(sequence: number, text: string): string {
  return `id: ${sequence}\r\nevent: item.output_text.delta\r\ndata: ${publicDeltaEvent(sequence, text)}\r\n\r\n`;
}

/** A complete item.output_text.delta SSE frame with an empty data object. */
export function validEventFrame(sequence: number): string {
  const payload: Schemas['PublicEvent'] = {
    schema_version: 1,
    projection_version: 1,
    sequence,
    event_id: `evt_${sequence}`,
    session_id: 'session-1',
    turn_id: 'turn-1',
    type: 'item.output_text.delta',
    created_at: SECONDS + sequence,
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

export function publicSessionPayload(lastSequence: number): string {
  const payload: Schemas['PublicSession'] = {
    id: 'session-1',
    object: 'agent.session',
    agent_id: 'dataworks_data_agent',
    agent_revision: '1',
    status: 'active',
    title: 'Session',
    created_at: SECONDS,
    updated_at: SECONDS,
    last_event_id: lastSequence,
    compaction_revision: 0,
    capabilities: {
      items: true,
      snapshots: true,
      artifacts: false,
      resync: true,
      actions: false,
      tasks: true,
      workspace_turns: false,
    },
  };
  return JSON.stringify(payload);
}
