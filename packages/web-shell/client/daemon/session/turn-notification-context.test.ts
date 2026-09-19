import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonEvent,
  DaemonTextTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  createTurnNotificationObserver,
  getTurnNotificationContent,
} from './turn-notification-context';

function terminal(promptId = 'p', stopReason = 'end_turn'): DaemonEvent {
  return {
    type: 'turn_complete',
    data: { sessionId: 's', promptId, stopReason },
  };
}

describe('turn notification observer', () => {
  it.each([
    ['end_turn', 'completed'],
    ['cancelled', 'cancelled'],
    ['max_tokens', 'ended'],
  ])('classifies %s without implying task-wide success', (reason, outcome) => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.observe('scope', 's', terminal('p', reason));
    expect(notify).toHaveBeenCalledWith({
      key: JSON.stringify(['scope', 'p']),
      outcome,
    });
  });

  it('requires a real terminal and ignores cancellation requests and transport errors', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    for (const type of [
      'prompt_cancelled',
      'stream_error',
      'state_resync_required',
    ]) {
      observer.observe('scope', 's', {
        type,
        data: { sessionId: 's', promptId: 'p' },
      });
    }
    expect(notify).not.toHaveBeenCalled();
    observer.observe('scope', 's', {
      type: 'turn_error',
      data: { sessionId: 's', promptId: 'p', message: 'secret' },
    });
    expect(notify).toHaveBeenCalledWith({
      key: JSON.stringify(['scope', 'p']),
      outcome: 'failed',
    });
  });

  it('only computes content for an accepted terminal once', () => {
    const observer = createTurnNotificationObserver(vi.fn());
    observer.retain('scope');
    const content = vi.fn(() => ({ responseText: 'Done' }));
    observer.observe('scope', 's', terminal('history'), true, content);
    observer.observe('scope', 'other', terminal(), false, content);
    expect(content).not.toHaveBeenCalled();
    observer.observe('scope', 's', terminal(), false, content);
    observer.observe('scope', 's', terminal(), false, content);
    expect(content).toHaveBeenCalledOnce();
  });

  it('preserves admitted text over queued copies and derives a code title', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.admit('scope', 'p', '```ts\nexport const a = 1;\n```');
    observer.observe('scope', 's', {
      type: 'pending_prompt_started',
      data: { sessionId: 's', promptId: 'p', text: 'Daemon copy' },
    });
    observer.observe('scope', 's', terminal());
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionTitle: 'export const a = 1;',
        promptText: '```ts\nexport const a = 1;\n```',
      }),
    );
  });

  it('bounds pending prompt text and forgets mid-turn injections', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.observe('scope', 's', {
      type: 'pending_prompt_added',
      data: { sessionId: 's', promptId: 'p', text: 'x'.repeat(10000) },
    });
    observer.observe('scope', 's', terminal(), true);
    expect(notify.mock.calls[0][0].promptText).toHaveLength(4096);
    observer.admit('scope', 'injected', 'steering text');
    observer.observe('scope', 's', {
      type: 'mid_turn_message_injected',
      promptId: 'active',
      data: { sessionId: 'other', messageIds: ['injected'] },
    });
    observer.observe('scope', 's', {
      type: 'mid_turn_message_injected',
      promptId: 'active',
      data: { sessionId: 's', messageIds: ['injected'] },
    });
    observer.observe('scope', 's', terminal('injected'), true);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('evicts oldest pending labels at the scope limit', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    for (let i = 0; i < 1025; i++)
      observer.admit('scope', String(i), 'Question');
    observer.observe('scope', 's', terminal('0'), true);
    expect(notify).not.toHaveBeenCalled();
    observer.observe('scope', 's', terminal('1024'), true);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('keeps initial history silent but catches up admitted prompts once', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.observe('scope', 's', terminal('history'), true);
    observer.admit('scope', 'p');
    observer.observe('scope', 's', terminal(), true);
    observer.observe('scope', 's', terminal());
    observer.observe('scope', 's', terminal(), true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('deduplicates multiple panes and a terminal that precedes admission', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.retain('scope');
    observer.observe('scope', 's', terminal());
    observer.admit('scope', 'p');
    observer.observe('scope', 's', terminal(), true);
    expect(notify).toHaveBeenCalledTimes(1);
    observer.retain('other-workspace');
    observer.observe('other-workspace', 's', terminal());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('tracks live queued prompts but never registers historical queue records', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    const start = {
      type: 'pending_prompt_started',
      data: { sessionId: 's', promptId: 'p' },
    };
    observer.observe('scope', 's', start, true);
    observer.observe('scope', 's', terminal(), true);
    expect(notify).not.toHaveBeenCalled();
    observer.observe('scope', 's', start);
    observer.observe('scope', 's', terminal(), true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('forgets removed prompts even if a later terminal is replayed', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.admit('scope', 'p');
    observer.observe('scope', 's', {
      type: 'pending_prompt_completed',
      data: { sessionId: 's', promptId: 'p', state: 'removed' },
    });
    observer.observe('scope', 's', terminal(), true);
    observer.observe('scope', 's', terminal());
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects missing and conflicting identities without consuming the valid terminal', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.observe('scope', 'wrong-session', terminal());
    observer.observe('scope', 's', terminal(''));
    observer.observe('scope', 's', { ...terminal(), promptId: 'other' });
    observer.observe('scope', 's', {
      type: 'turn_complete',
      data: { sessionId: 's', promptId: 'p' },
    });
    expect(notify).not.toHaveBeenCalled();
    observer.observe('scope', 's', terminal());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('preserves tracking on immediate remount but clears it after the last pane leaves', async () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    const release = observer.retain('scope');
    observer.admit('scope', 'p');
    release();
    const nextRelease = observer.retain('scope');
    await Promise.resolve();
    observer.observe('scope', 's', terminal(), true);
    observer.admit('scope', 'later');
    nextRelease();
    await Promise.resolve();
    observer.retain('scope');
    observer.observe('scope', 's', terminal('later'), true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not replay old history after the recent cache reaches its bound', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    for (let index = 0; index < 1100; index++)
      observer.observe('scope', 's', terminal(String(index)));
    observer.observe('scope', 's', terminal('0'), true);
    expect(notify).toHaveBeenCalledTimes(1100);
  });

  it('isolates a failing notification callback from the daemon stream', () => {
    const observer = createTurnNotificationObserver(() => {
      throw new Error('display unavailable');
    });
    observer.retain('scope');
    expect(() => observer.observe('scope', 's', terminal())).not.toThrow();
  });
});

describe('turn notification content', () => {
  const block = (
    text: string,
    extra: Partial<DaemonTextTranscriptBlock> = {},
  ): DaemonTextTranscriptBlock => ({
    id: text,
    kind: 'assistant',
    text,
    promptId: 'p',
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });

  it('selects the last main assistant response for the exact turn', () => {
    const content = getTurnNotificationContent(
      terminal(),
      [
        block('commentary'),
        block('final response'),
        block('thought', { kind: 'thought' }),
        block('child', { parentToolCallId: 'tool' }),
        block('background', { meta: { source: 'background_notification' } }),
        block('vision', { meta: { source: 'vision_bridge_notice' } }),
        block('another turn', { promptId: 'other' }),
        block('unidentified', { promptId: undefined }),
      ],
      'Session title',
    );
    expect(content).toEqual({
      sessionTitle: 'Session title',
      responseText: 'final response',
    });
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.observe('scope', 's', terminal(), false, content);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining(content!));
  });

  it('uses this turn request when a new session has no title yet', () => {
    const blocks = [
      block('old request', { kind: 'user', promptId: 'old' }),
      block('child request', { kind: 'user', parentToolCallId: 'tool' }),
      block('unidentified request', { kind: 'user', promptId: undefined }),
      block('  Fix notifications\nMore context', { kind: 'user' }),
      block('Done'),
    ];
    expect(getTurnNotificationContent(terminal(), blocks, undefined)).toEqual({
      sessionTitle: 'Fix notifications',
      promptText: '  Fix notifications\nMore context',
      responseText: 'Done',
    });
    expect(
      getTurnNotificationContent(terminal(), blocks, 'Explicit title'),
    ).toEqual({
      sessionTitle: 'Explicit title',
      promptText: '  Fix notifications\nMore context',
      responseText: 'Done',
    });
  });

  it('uses admitted labels when the local user block has no prompt id', () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    observer.retain('scope');
    observer.admit('scope', 'old', 'Old request');
    observer.admit('scope', 'p', '  Current request\nDetails');
    const content = getTurnNotificationContent(
      terminal(),
      [
        block('Current request', { kind: 'user', promptId: undefined }),
        block('Done'),
      ],
      undefined,
    );
    observer.observe('scope', 's', terminal(), false, content);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionTitle: 'Current request',
        promptText: 'Current request\nDetails',
        responseText: 'Done',
      }),
    );
    observer.admit('scope', 'named', 'Request fallback');
    observer.observe('scope', 's', terminal('named'), false, {
      sessionTitle: 'Explicit title',
    });
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionTitle: 'Explicit title',
        promptText: 'Request fallback',
      }),
    );
  });

  it('keeps multiline queued prompts across replay and clears them on release', async () => {
    const notify = vi.fn();
    const observer = createTurnNotificationObserver(notify);
    const release = observer.retain('scope');
    observer.observe('scope', 's', {
      type: 'pending_prompt_started',
      data: { sessionId: 's', promptId: 'p', text: 'Question\nDetails' },
    });
    observer.observe('scope', 's', terminal(), true, {
      sessionTitle: 'Existing title',
    });
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionTitle: 'Existing title',
        promptText: 'Question\nDetails',
      }),
    );
    observer.admit('scope', 'removed', 'Removed question');
    observer.remove('scope', 'removed');
    observer.observe('scope', 's', terminal('removed'), true);
    expect(notify).toHaveBeenCalledOnce();
    observer.admit('scope', 'later', 'Abandoned question');
    release();
    await Promise.resolve();
    observer.retain('scope');
    observer.observe('scope', 's', terminal('later'), false, {
      sessionTitle: 'Title is not the question',
    });
    expect(notify).toHaveBeenLastCalledWith({
      key: JSON.stringify(['scope', 'later']),
      outcome: 'completed',
      sessionTitle: 'Title is not the question',
    });
  });

  it('includes the exact user prompt on failure without a partial reply', () => {
    expect(
      getTurnNotificationContent(
        {
          type: 'turn_error',
          data: { sessionId: 's', promptId: 'p', error: 'private error' },
        },
        [
          block('Previous question', { kind: 'user', promptId: 'old' }),
          block('Current question', { kind: 'user' }),
          block('partial response'),
        ],
        'Title',
      ),
    ).toEqual({ sessionTitle: 'Title', promptText: 'Current question' });
  });

  it('omits transport attachment tails without changing prompt prose', () => {
    expect(
      getTurnNotificationContent(
        terminal(),
        [
          block('check\n\n@attachment:///private.txt', { kind: 'user' }),
          block('Done'),
        ],
        undefined,
      ),
    ).toEqual({
      sessionTitle: 'check',
      promptText: 'check',
      responseText: 'Done',
    });
    expect(
      getTurnNotificationContent(
        terminal(),
        [block('Discuss @attachment:/// tokens', { kind: 'user' })],
        'Title',
      )?.promptText,
    ).toBe('Discuss @attachment:/// tokens');
  });

  it('keeps visible insight prose while omitting internal segments', () => {
    for (const text of [
      'Report ready\n{"insight_ready":{"path":"/tmp/r.md"}}',
      'the marker "insight_ready": is emitted',
    ]) {
      expect(
        getTurnNotificationContent(terminal(), [block(text)], 'Title')
          ?.responseText,
      ).toBe(text.startsWith('Report') ? 'Report ready' : text);
    }
    expect(
      getTurnNotificationContent(
        terminal(),
        [
          block(
            'Report ready\n{"insight_ready":{"path":"/tmp/r.md"}}\n{"insight_error":{"path":"/private',
          ),
        ],
        'Title',
      ),
    ).toEqual({ sessionTitle: 'Title' });
    expect(
      getTurnNotificationContent(
        terminal(),
        [block('{"insight_ready":{"path":"/private')],
        'Title',
      ),
    ).toEqual({ sessionTitle: 'Title' });
  });

  it('does not borrow old replies or expose partial failure replies and insight payloads', () => {
    expect(
      getTurnNotificationContent(
        terminal('new'),
        [block('old question', { kind: 'user' }), block('old answer')],
        undefined,
      ),
    ).toEqual({ sessionTitle: undefined });
    expect(
      getTurnNotificationContent(
        {
          type: 'turn_error',
          data: { sessionId: 's', promptId: 'p', error: 'private error' },
        },
        [block('partial response')],
        'Title',
      ),
    ).toEqual({ sessionTitle: 'Title' });
    expect(
      getTurnNotificationContent(
        terminal(),
        [
          block('commentary'),
          block('{"insight_ready":{"path":"/private/report.html"}}'),
        ],
        'Title',
      ),
    ).toEqual({ sessionTitle: 'Title' });
    expect(
      getTurnNotificationContent(
        terminal(''),
        [block('unidentified', { promptId: undefined })],
        'Title',
      ),
    ).toEqual({ sessionTitle: 'Title' });
  });
});
