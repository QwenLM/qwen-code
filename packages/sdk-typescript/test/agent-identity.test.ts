import { describe, expect, it } from 'vitest';
import { normalizeDaemonEvent } from '../src/daemon/ui/normalizer.js';
import {
  createDaemonTranscriptState,
  reduceDaemonTranscriptEvents,
} from '../src/daemon/ui/transcript.js';

const SECURITY = {
  agentName: '/root/security',
  depth: 1,
  kind: 'subagent',
} as const;

const frame = (
  sessionUpdate: string,
  extra: Record<string, unknown>,
  meta?: Record<string, unknown>,
) => ({
  id: 1,
  v: 1,
  type: 'session_update',
  data: {
    update: {
      sessionUpdate,
      ...extra,
      ...(meta ? { _meta: meta } : {}),
    },
  },
});

const text = (t: string, meta?: Record<string, unknown>) =>
  frame('agent_message_chunk', { content: { type: 'text', text: t } }, meta);

describe('agent identity projection', () => {
  it('attributes an assistant message to the agent that produced it', () => {
    const events = normalizeDaemonEvent(
      text('found an injection', { agent: SECURITY }) as never,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'assistant.text.delta',
      text: 'found an injection',
      agent: SECURITY,
    });
  });

  it('attributes thought frames the same way', () => {
    const events = normalizeDaemonEvent(
      frame(
        'agent_thought_chunk',
        { content: { type: 'text', text: 'scanning deps' } },
        { agent: SECURITY },
      ) as never,
    );
    expect(events[0]).toMatchObject({
      type: 'thought.text.delta',
      agent: SECURITY,
    });
  });

  it('attributes tool calls made inside a subagent', () => {
    const events = normalizeDaemonEvent(
      frame(
        'tool_call',
        { toolCallId: 'c1', title: 'Grep', status: 'in_progress' },
        { agent: SECURITY, subagentType: 'security' },
      ) as never,
    );
    const tool = events.find((e) => e.type === 'tool.update');
    expect(tool).toMatchObject({ agent: SECURITY, subagentType: 'security' });
  });

  it('leaves root-agent frames unattributed rather than inventing /root', () => {
    const events = normalizeDaemonEvent(text('plain answer') as never);
    expect(events[0]).not.toHaveProperty('agent');
  });

  it.each([
    ['a missing depth', { agentName: '/root/security', kind: 'subagent' }],
    ['a missing kind', { agentName: '/root/security', depth: 1 }],
    ['an unknown kind', { agentName: '/root/x', depth: 1, kind: 'bogus' }],
    ['an empty name', { agentName: '', depth: 1, kind: 'subagent' }],
    ['a negative depth', { agentName: '/root/x', depth: -1, kind: 'subagent' }],
  ])('rejects a half-populated identity: %s', (_label, agent) => {
    // A client keys rendering and auto-approval policy on agentName, so a
    // partial identity must project to nothing rather than to a plausible
    // looking name whose depth/kind disagree with it.
    const events = normalizeDaemonEvent(text('x', { agent }) as never);
    expect(events[0]).not.toHaveProperty('agent');
  });

  it('accepts a teammate identity, the Agent Team producer kind', () => {
    const teammate = {
      agentName: '/root/correctness',
      depth: 1,
      kind: 'teammate',
    } as const;
    const events = normalizeDaemonEvent(
      text('x', { agent: teammate }) as never,
    );
    expect(events[0]).toMatchObject({ agent: teammate });
  });

  it('survives a nested path two levels deep', () => {
    const deep = {
      agentName: '/root/security/deps',
      depth: 2,
      kind: 'subagent',
    };
    const events = normalizeDaemonEvent(text('x', { agent: deep }) as never);
    expect(events[0]).toMatchObject({ agent: deep });
  });
});

describe('agent identity on user chunks', () => {
  it('extracts a replayed peer notice identity from a flat user_message_chunk', () => {
    // The REST transcript wraps no `update` object; the identity rides
    // `_meta` and must survive to `user.text.delta` for the block reducer.
    const events = normalizeDaemonEvent({
      id: 41,
      v: 1,
      type: 'session_update',
      data: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'teammate security joined the team' },
        _meta: {
          source: 'background_notification',
          agent: SECURITY,
        },
      },
    } as never);
    expect(events[0]).toMatchObject({
      type: 'user.text.delta',
      agent: SECURITY,
    });
  });
});

describe('agent identity transcript reduction', () => {
  const raw = (
    id: number,
    sessionUpdate: string,
    extra: Record<string, unknown>,
  ) => ({
    id,
    v: 1 as const,
    type: 'session_update' as const,
    data: {
      sessionUpdate,
      toolCallId: 'agent-1',
      content: [],
      ...extra,
    },
  });

  it('backfills the identity when only the closing result frame carries it', () => {
    // Persistence keeps the identity only on the task_execution result, so a
    // replayed Agent call sees the start frame unattributed; the update path
    // must still adopt the identity.
    let state = createDaemonTranscriptState({
      retainSubagentBlocks: true,
    });
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent(
        raw(1, 'tool_call', {
          status: 'pending',
          _meta: { toolName: 'agent' },
        }) as never,
      ),
    );
    state = reduceDaemonTranscriptEvents(
      state,
      normalizeDaemonEvent(
        raw(2, 'tool_call_update', {
          status: 'completed',
          _meta: { toolName: 'agent', agent: SECURITY },
        }) as never,
      ),
    );
    const tool = state.blocks.find((b) => b.kind === 'tool');
    expect(tool).toMatchObject({ agent: SECURITY });
  });
});
