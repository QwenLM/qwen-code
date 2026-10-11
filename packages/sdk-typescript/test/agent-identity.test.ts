import { describe, expect, it } from 'vitest';
import { normalizeDaemonEvent } from '../src/daemon/ui/normalizer.js';

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
    ['an unknown kind', { agentName: '/root/x', depth: 1, kind: 'teammate' }],
    ['an empty name', { agentName: '', depth: 1, kind: 'subagent' }],
    ['a negative depth', { agentName: '/root/x', depth: -1, kind: 'subagent' }],
  ])('rejects a half-populated identity: %s', (_label, agent) => {
    // A client keys rendering and auto-approval policy on agentName, so a
    // partial identity must project to nothing rather than to a plausible
    // looking name whose depth/kind disagree with it.
    const events = normalizeDaemonEvent(text('x', { agent }) as never);
    expect(events[0]).not.toHaveProperty('agent');
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
