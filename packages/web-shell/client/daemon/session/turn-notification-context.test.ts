import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { createTurnNotificationObserver } from './turn-notification-context';

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
