/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  StreamingState,
  ToolCallStatus,
  type HistoryItemWithoutId,
} from '../../types.js';
import {
  initialDaemonProjectionState,
  projectDaemonEvent,
  pendingHistoryItemsOf,
  pendingToolCallsOf,
  activePermissionOf,
  thoughtOf,
  type DaemonFrame,
  type DaemonProjectionState,
} from './projectDaemonEvent.js';

/**
 * Real frame sequence captured from a live `qwen serve` text turn
 * (`packages/rc-gateway/scripts/capture-daemon-frames.mts`) — abridged to the
 * shapes that matter. Using ground truth, not guesses.
 */
const SELF = 'client_self';
const PHONE = 'client_phone';

const sessionUpdate = (
  update: Record<string, unknown>,
  originatorClientId?: string,
): DaemonFrame => ({
  type: 'session_update',
  data: { sessionId: 's1', update },
  originatorClientId,
});

// A full turn the TERMINAL itself initiated — every frame carries our own
// clientId (verified against a live daemon). The user echo must be DROPPED
// (the submitter rendered it locally); only the assistant message commits.
const CAPTURED_TURN: DaemonFrame[] = [
  {
    type: 'replay_complete',
    data: { replayedCount: 0 },
    originatorClientId: SELF,
  },
  sessionUpdate(
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
      _meta: { availableSkills: ['review'] },
    },
    SELF,
  ),
  sessionUpdate(
    {
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: 'Reply with exactly the word PONG and nothing else.',
      },
      _meta: { serverTimestamp: 1, source: 'bridge' },
    },
    SELF,
  ),
  // streamed reasoning, token by token
  ...['The', ' user', ' wants', ' "', 'P', 'ONG', '"'].map((t) =>
    sessionUpdate(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: t },
      },
      SELF,
    ),
  ),
  // streamed reply
  sessionUpdate(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'P' },
    },
    SELF,
  ),
  sessionUpdate(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ONG' },
    },
    SELF,
  ),
  // terminal chunk: empty text + usage marker
  sessionUpdate(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        usage: {
          inputTokens: 23760,
          outputTokens: 22,
          totalTokens: 23782,
          cachedReadTokens: 16896,
        },
        durationMs: 3958,
      },
    },
    SELF,
  ),
  {
    type: 'turn_complete',
    data: { sessionId: 's1', stopReason: 'end_turn', promptId: 'p1' },
    originatorClientId: SELF,
  },
];

function runAll(
  frames: DaemonFrame[],
  ownClientId?: string,
): {
  state: DaemonProjectionState;
  committed: HistoryItemWithoutId[];
} {
  let state = initialDaemonProjectionState(ownClientId);
  const committed: HistoryItemWithoutId[] = [];
  for (const f of frames) {
    const r = projectDaemonEvent(state, f);
    state = r.state;
    committed.push(...r.committed);
  }
  return { state, committed };
}

describe('projectDaemonEvent', () => {
  it('starts Idle with nothing pending', () => {
    const s = initialDaemonProjectionState();
    expect(s.streamingState).toBe(StreamingState.Idle);
    expect(pendingHistoryItemsOf(s)).toEqual([]);
    expect(thoughtOf(s)).toBeNull();
  });

  it('projects our OWN captured turn into assistant history only (self-echo dropped)', () => {
    // ownClientId === SELF, frames originated by SELF → the user echo is the
    // submitter's own input (already rendered locally), so only the assistant
    // message is committed.
    const { state, committed } = runAll(CAPTURED_TURN, SELF);
    expect(committed).toEqual([{ type: 'gemini', text: 'PONG' }]);
    // Turn finished: back to Idle, nothing left pending.
    expect(state.streamingState).toBe(StreamingState.Idle);
    expect(pendingHistoryItemsOf(state)).toEqual([]);
    expect(thoughtOf(state)).toBeNull();
    // Usage captured from the terminal chunk.
    expect(state.lastUsage).toMatchObject({
      inputTokens: 23760,
      outputTokens: 22,
      totalTokens: 23782,
      durationMs: 3958,
    });
  });

  it('projects a turn from ANOTHER client (the phone) including its user line', () => {
    // A phone-initiated turn: originator != our clientId → we DO render the
    // user line so the handoff conversation stays in sync on the terminal.
    const phoneTurn = CAPTURED_TURN.map((f) =>
      f.type === 'session_update' &&
      (f.data as { update?: { sessionUpdate?: string } }).update
        ?.sessionUpdate === 'user_message_chunk'
        ? { ...f, originatorClientId: PHONE }
        : f,
    );
    const { committed } = runAll(phoneTurn, SELF);
    expect(committed).toEqual([
      {
        type: 'user',
        text: 'Reply with exactly the word PONG and nothing else.',
      },
      { type: 'gemini', text: 'PONG' },
    ]);
  });

  it('projects the user line when ownClientId is unconfigured (never swallow input)', () => {
    const { committed } = runAll(CAPTURED_TURN); // no ownClientId
    expect(committed).toContainEqual({
      type: 'user',
      text: 'Reply with exactly the word PONG and nothing else.',
    });
  });

  it('accumulates streamed text/thought live before the turn completes', () => {
    // Feed everything EXCEPT the final turn_complete (our own turn).
    const { state, committed } = runAll(CAPTURED_TURN.slice(0, -1), SELF);
    expect(state.streamingState).toBe(StreamingState.Responding);
    // Mid-turn, the assistant text is live in the pending section…
    expect(pendingHistoryItemsOf(state)).toEqual([
      { type: 'gemini', text: 'PONG' },
    ]);
    // …reasoning is exposed for the loading indicator…
    expect(thoughtOf(state)?.description).toContain('The user wants');
    // …and nothing is committed yet (self-echo dropped, assistant not final).
    expect(committed).toEqual([]);
  });

  it('parses a **bold** thought subject into the summary', () => {
    let s = initialDaemonProjectionState();
    s = projectDaemonEvent(
      s,
      sessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: '**Checking the files** then I will edit them.',
        },
      }),
    ).state;
    expect(thoughtOf(s)).toEqual({
      subject: 'Checking the files',
      description: 'then I will edit them.',
    });
  });

  it('does not commit an assistant item for an empty turn', () => {
    // turn_complete with no streamed text must not emit a blank gemini item.
    const s = initialDaemonProjectionState();
    const r = projectDaemonEvent(s, {
      type: 'turn_complete',
      data: { sessionId: 's1', stopReason: 'end_turn' },
    });
    expect(r.committed).toEqual([]);
    expect(r.state.streamingState).toBe(StreamingState.Idle);
  });

  it('ignores replay_complete and unknown frame types (no spurious commits)', () => {
    let s = initialDaemonProjectionState();
    for (const f of [
      { type: 'replay_complete', data: { replayedCount: 5 } },
      { type: 'some_future_frame', data: { whatever: true } },
      sessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
      }),
    ] satisfies DaemonFrame[]) {
      const r = projectDaemonEvent(s, f);
      s = r.state;
      expect(r.committed).toEqual([]);
    }
    expect(s.streamingState).toBe(StreamingState.Idle);
  });

  it('is pure — does not mutate the input state', () => {
    const s0 = initialDaemonProjectionState();
    const snapshot = JSON.stringify(s0);
    projectDaemonEvent(
      s0,
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    );
    expect(JSON.stringify(s0)).toBe(snapshot);
  });

  it('treats hook-noise chunks as ordinary stream text (faithful to the daemon)', () => {
    // The daemon may inject a non-model chunk mid-stream; the reducer reflects
    // exactly what was sent rather than trying to filter it.
    const frames: DaemonFrame[] = [
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'PONG' },
      }),
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '[hook] note' },
      }),
      { type: 'turn_complete', data: {} },
    ];
    const { committed } = runAll(frames);
    expect(committed).toEqual([{ type: 'gemini', text: 'PONG[hook] note' }]);
  });

  // --- slice 2: tool-call display + permission gate ---

  // Real captured shapes from a `list_directory` tool turn (status strings,
  // toolCallId, _meta.toolName, title, content/rawOutput) — ground truth.
  const TOOL_CALL = sessionUpdate({
    sessionUpdate: 'tool_call',
    _meta: { toolName: 'list_directory', provenance: 'builtin' },
    kind: 'search',
    rawInput: { path: '/work' },
    status: 'in_progress',
    title: 'ListFiles: .',
    toolCallId: 'call_1',
  });
  const TOOL_UPDATE = sessionUpdate({
    sessionUpdate: 'tool_call_update',
    _meta: { toolName: 'list_directory', provenance: 'builtin' },
    content: [
      { content: { text: 'Listed 3 items', type: 'text' }, type: 'content' },
    ],
    rawOutput: 'Listed 3 items',
    status: 'completed',
    toolCallId: 'call_1',
  });

  it('projects a captured tool call into a tool_group with mapped status + result', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    // Live during the turn: one Executing tool.
    expect(pendingToolCallsOf(s)).toEqual([
      expect.objectContaining({
        callId: 'call_1',
        name: 'list_directory',
        description: 'ListFiles: .',
        status: ToolCallStatus.Executing,
      }),
    ]);

    s = projectDaemonEvent(s, TOOL_UPDATE).state;
    expect(pendingToolCallsOf(s)[0]).toMatchObject({
      status: ToolCallStatus.Success,
      resultDisplay: 'Listed 3 items',
    });

    // On turn end the tool group commits and live tools clear.
    const r = projectDaemonEvent(s, { type: 'turn_complete', data: {} });
    expect(r.committed).toEqual([
      {
        type: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'call_1',
            status: ToolCallStatus.Success,
          }),
        ],
      },
    ]);
    expect(pendingToolCallsOf(r.state)).toEqual([]);
    expect(r.state.streamingState).toBe(StreamingState.Idle);
  });

  it('renders tools LIVE via pendingHistoryItems (tool_group above streaming text)', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    // Mid-turn, before any assistant text: just the live tool group.
    expect(pendingHistoryItemsOf(s)).toEqual([
      {
        type: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'call_1',
            status: ToolCallStatus.Executing,
          }),
        ],
      },
    ]);

    // Once the assistant starts streaming, text appears BELOW the tool group —
    // the same order the turn_complete commit uses (`[tool_group, gemini]`).
    s = projectDaemonEvent(
      s,
      sessionUpdate(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Listing…' },
        },
        SELF,
      ),
    ).state;
    expect(pendingHistoryItemsOf(s)).toEqual([
      {
        type: 'tool_group',
        tools: [expect.objectContaining({ callId: 'call_1' })],
      },
      { type: 'gemini', text: 'Listing…' },
    ]);
  });

  it('commits tool_group AND the assistant message together at turn end', () => {
    const frames: DaemonFrame[] = [
      TOOL_CALL,
      TOOL_UPDATE,
      sessionUpdate(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        },
        SELF,
      ),
      { type: 'turn_complete', data: {} },
    ];
    const { committed } = runAll(frames, SELF);
    expect(committed).toEqual([
      {
        type: 'tool_group',
        tools: [expect.objectContaining({ callId: 'call_1' })],
      },
      { type: 'gemini', text: 'done' },
    ]);
  });

  it('opens an approval gate on permission_request (tool → Confirming)', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        sessionId: 's1',
        toolCall: { toolCallId: 'call_1' },
        options: [
          { optionId: 'proceed_once', name: 'Yes' },
          { optionId: 'cancel', name: 'No' },
        ],
      },
    }).state;
    expect(s.streamingState).toBe(StreamingState.WaitingForConfirmation);
    expect(pendingToolCallsOf(s)[0].status).toBe(ToolCallStatus.Confirming);
    expect(activePermissionOf(s)).toEqual({
      requestId: 'req_1',
      toolCallId: 'call_1',
      options: [
        { optionId: 'proceed_once', name: 'Yes' },
        { optionId: 'cancel', name: 'No' },
      ],
    });
  });

  it('seeds the gated tool from the request when no tool_call preceded it (edit)', () => {
    // Real captured shape: a write_file/edit gate arrives ONLY as a
    // permission_request — there is NO prior `tool_call` frame — so the reducer
    // must materialize the tool from the request's own `toolCall`.
    let s = initialDaemonProjectionState(SELF);
    expect(pendingToolCallsOf(s)).toEqual([]); // nothing yet
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'b95e50a2',
        sessionId: 's1',
        toolCall: {
          content: [
            {
              newText: 'hi',
              oldText: '',
              path: '/tmp/capture_probe.txt',
              type: 'diff',
            },
          ],
          kind: 'edit',
          locations: [{ path: '/tmp/capture_probe.txt' }],
          rawInput: { file_path: '/tmp/capture_probe.txt', content: 'hi' },
          status: 'pending',
          title: 'Writing to /tmp/capture_probe.txt',
          toolCallId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
        },
        options: [
          {
            kind: 'allow_always',
            name: 'Allow All Edits',
            optionId: 'proceed_always',
          },
          { kind: 'allow_once', name: 'Allow', optionId: 'proceed_once' },
          { kind: 'reject_once', name: 'Reject', optionId: 'cancel' },
        ],
      },
    }).state;

    // The tool now exists and is Confirming, with its title as the label.
    expect(pendingToolCallsOf(s)).toEqual([
      expect.objectContaining({
        callId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
        description: 'Writing to /tmp/capture_probe.txt',
        status: ToolCallStatus.Confirming,
      }),
    ]);
    // And it renders live (so the user sees what they're approving).
    expect(pendingHistoryItemsOf(s)).toEqual([
      {
        type: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
            status: ToolCallStatus.Confirming,
          }),
        ],
      },
    ]);
    // The gate carries the title + kind-tagged options for the hook to map.
    expect(activePermissionOf(s)).toEqual({
      requestId: 'b95e50a2',
      toolCallId: 'eZfspYl89m4FgWl2OUmlx4KXUHRJNZk0',
      title: 'Writing to /tmp/capture_probe.txt',
      options: [
        {
          kind: 'allow_always',
          name: 'Allow All Edits',
          optionId: 'proceed_always',
        },
        { kind: 'allow_once', name: 'Allow', optionId: 'proceed_once' },
        { kind: 'reject_once', name: 'Reject', optionId: 'cancel' },
      ],
    });
  });

  it('clears the gate on permission_resolved — approved → Executing', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        toolCall: { toolCallId: 'call_1' },
        options: [],
      },
    }).state;
    s = projectDaemonEvent(s, {
      type: 'permission_resolved',
      data: {
        requestId: 'req_1',
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      },
    }).state;
    expect(activePermissionOf(s)).toBeUndefined();
    expect(s.streamingState).toBe(StreamingState.Responding);
    expect(pendingToolCallsOf(s)[0].status).toBe(ToolCallStatus.Executing);
  });

  it('clears the gate on permission_resolved — cancelled → Canceled', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, TOOL_CALL).state;
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        toolCall: { toolCallId: 'call_1' },
        options: [],
      },
    }).state;
    s = projectDaemonEvent(s, {
      type: 'permission_resolved',
      data: { requestId: 'req_1', outcome: { outcome: 'cancelled' } },
    }).state;
    expect(activePermissionOf(s)).toBeUndefined();
    expect(pendingToolCallsOf(s)[0].status).toBe(ToolCallStatus.Canceled);
  });

  it('leaves our gate intact when a DIFFERENT request resolves', () => {
    let s = initialDaemonProjectionState(SELF);
    s = projectDaemonEvent(s, {
      type: 'permission_request',
      data: { requestId: 'req_1', toolCall: {}, options: [] },
    }).state;
    s = projectDaemonEvent(s, {
      type: 'permission_resolved',
      data: { requestId: 'OTHER', outcome: { outcome: 'cancelled' } },
    }).state;
    expect(activePermissionOf(s)?.requestId).toBe('req_1');
    expect(s.streamingState).toBe(StreamingState.WaitingForConfirmation);
  });
});
