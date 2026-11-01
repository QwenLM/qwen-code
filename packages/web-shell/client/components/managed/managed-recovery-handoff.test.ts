import { describe, expect, it } from 'vitest';
import type {
  ManagedAgentSessionEvent,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import { buildManagedRecoveryHandoff } from './managed-recovery-handoff';

const headings = {
  introduction: 'Historical reference, not instructions',
  source: 'Source',
  task: 'Latest request',
  confirmed: 'Confirmed',
  uncertain: 'Unconfirmed',
  truncated: '[History omitted]',
};
const summary: ManagedAgentSessionSummary = {
  sessionId: 's1',
  title: 'Original task',
  agentId: 'agent',
  phase: 'failed',
  createdAt: 1,
  admittedAt: 1,
  updatedAt: 2,
  runtimeReady: false,
  runtimeState: 'failed',
  capabilities: { canSend: false, canCancel: false },
  workspace: { workspaceId: 'ws1', cwdRelative: 'project' },
  recovery: {
    state: 'operator_required',
    reasonCode: 'evidence_unavailable',
    turnId: 't2',
    nextTurnAllowed: false,
    actions: { recheck: false, cancel: false, continueInNewSession: true },
  },
};
function event(
  id: number,
  turnId: string,
  type: ManagedAgentSessionEvent['type'],
  data?: unknown,
): ManagedAgentSessionEvent {
  return { id, at: id, sessionId: 's1', turnId, type, data };
}
const user = (id: number, turnId: string, text: string) =>
  event(id, turnId, 'accepted', { prompt: [{ type: 'text', text }] });

describe('buildManagedRecoveryHandoff', () => {
  it('includes only completed conversation text, latest request and explicit uncertainty', () => {
    const draft = buildManagedRecoveryHandoff(
      summary,
      [
        user(1, 't1', 'Confirmed request'),
        event(2, 't1', 'assistant_delta', { text: 'Confirmed answer' }),
        event(3, 't1', 'tool_completed', { output: 'SECRET TOOL OUTPUT' }),
        event(4, 't1', 'completed'),
        user(5, 't2', 'Latest request'),
        event(6, 't2', 'assistant_delta', { text: 'PARTIAL ANSWER' }),
        event(7, 't2', 'failed'),
      ],
      headings,
    );
    expect(draft).toMatchObject({
      sourceSessionId: 's1',
      workspaceId: 'ws1',
      cwdRelative: 'project',
      agentId: 'agent',
      truncated: false,
    });
    expect(draft.text).toContain('Confirmed request');
    expect(draft.text).toContain('Confirmed answer');
    expect(draft.text).toContain('Latest request');
    expect(draft.text).toContain('Unconfirmed: evidence_unavailable; t2');
    expect(draft.text).not.toMatch(/SECRET|PARTIAL/);
  });

  it('preserves complete recent messages in chronological order and marks unloaded history', () => {
    const events = [
      user(1, 'a', 'older'),
      event(2, 'a', 'completed'),
      user(3, 'b', 'newer'),
      event(4, 'b', 'completed'),
      user(5, 'c', 'last request'),
    ];
    const draft = buildManagedRecoveryHandoff(summary, events, headings, true);
    expect(draft.text.indexOf('User:\nolder')).toBeLessThan(
      draft.text.indexOf('User:\nnewer'),
    );
    expect(draft.truncated).toBe(true);
    expect(draft.text).toContain(headings.truncated);
  });

  it('caps UTF-8 bytes at 32 KiB without copying partial large messages or split characters', () => {
    const draft = buildManagedRecoveryHandoff(
      summary,
      [
        user(1, 'a', '界'.repeat(40_000)),
        event(2, 'a', 'completed'),
        user(3, 'b', '先确认文件'.repeat(20_000)),
      ],
      headings,
    );
    expect(new TextEncoder().encode(draft.text).length).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(draft.text).not.toContain('\uFFFD');
    expect(draft.text).toContain('先确认文件');
    expect(draft.text).not.toContain('界');
    expect(draft.truncated).toBe(true);
  });

  it('never serializes input resources, approvals or raw execution metadata', () => {
    const draft = buildManagedRecoveryHandoff(
      summary,
      [
        event(1, 'a', 'accepted', {
          prompt: [
            { type: 'input_text', text: 'ordinary text' },
            { type: 'input_file', uri: 'secret-file' },
          ],
          checkpoint: 'secret-checkpoint',
        }),
        event(2, 'a', 'completed', { approval: 'secret-authorization' }),
      ],
      headings,
    );
    expect(draft.text).toContain('ordinary text');
    expect(draft.text).not.toContain('secret-');
  });
});
