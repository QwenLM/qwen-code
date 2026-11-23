import { describe, expect, it } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { hasLiveWork, sessionBlocksDelete } from './session-live-work';

function session(
  overrides: Partial<DaemonSessionSummary>,
): DaemonSessionSummary {
  return {
    sessionId: 's',
    workspaceCwd: '/tmp/project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as DaemonSessionSummary;
}

describe('hasLiveWork', () => {
  it.each([
    ['a turn in flight', { hasActivePrompt: true }],
    ['other active work', { activeWorkState: 'active' as const }],
    // The monitor shape: background work without any active-work category.
    [
      'background work the daemon grades idle',
      { hasRunningBackgroundTasks: true, activeWorkState: 'idle' as const },
    ],
    [
      'background work with no reported grade',
      { hasRunningBackgroundTasks: true },
    ],
  ])('counts %s', (_label, overrides) => {
    expect(hasLiveWork(session(overrides))).toBe(true);
  });

  it.each([
    ['an idle row', {}],
    ['an unknown grade', { activeWorkState: 'unknown' as const }],
    ['an unsupported grade', { activeWorkState: 'unsupported' as const }],
    // A row missing from live-state has the flag cleared to undefined; it must
    // stay actionable rather than being blocked forever.
    [
      'a row with no live-state coverage',
      { hasRunningBackgroundTasks: undefined },
    ],
    ['finished background work', { hasRunningBackgroundTasks: false }],
  ])('does not count %s', (_label, overrides) => {
    expect(hasLiveWork(session(overrides))).toBe(false);
  });
});

describe('sessionBlocksDelete', () => {
  it.each([
    [
      'background work on the attached row',
      { hasRunningBackgroundTasks: true },
      true,
    ],
    [
      'background work on another row',
      { hasRunningBackgroundTasks: true },
      false,
    ],
    ['a turn on the attached row', { hasActivePrompt: true }, true],
    [
      'other active work on the attached row',
      { activeWorkState: 'active' as const },
      true,
    ],
  ])('refuses %s', (_label, overrides, isCurrent) => {
    expect(sessionBlocksDelete(session(overrides), isCurrent)).toBe(true);
  });

  it.each([
    ['a turn on another row', { hasActivePrompt: true }, false],
    [
      'other active work on another row',
      { activeWorkState: 'active' as const },
      false,
    ],
    ['an idle attached row', { activeWorkState: 'idle' as const }, true],
    ['an idle other row', { activeWorkState: 'idle' as const }, false],
    // Cleared to undefined for rows missing from live-state; they stay deletable.
    [
      'a row with no live-state coverage',
      { hasRunningBackgroundTasks: undefined },
      false,
    ],
    ['finished background work', { hasRunningBackgroundTasks: false }, false],
  ])('allows %s', (_label, overrides, isCurrent) => {
    expect(sessionBlocksDelete(session(overrides), isCurrent)).toBe(false);
  });
});
