// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_INPUT_HISTORY_ENTRY_CHARS } from '@qwen-code/qwen-code-core/utils/input-history.js';
import {
  getShellHistoryStorageKey,
  mergeRemoteInputHistory,
  pushInputHistoryEntry,
  useInputHistory,
} from './useInputHistory';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let history: ReturnType<typeof useInputHistory>;
let renderCount = 0;

function Harness({
  storageKey,
  fallback,
  remoteEnabled,
}: {
  storageKey: string;
  fallback?: string;
  remoteEnabled?: boolean;
}) {
  renderCount++;
  history = useInputHistory(storageKey, fallback, remoteEnabled);
  return null;
}

function render(
  storageKey = 'workspace',
  fallback?: string,
  remoteEnabled?: boolean,
) {
  if (!root) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() =>
    root!.render(
      <Harness
        storageKey={storageKey}
        fallback={fallback}
        remoteEnabled={remoteEnabled}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  renderCount = 0;
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each([
  'navigateUp',
  'searchReverse',
  'getReverseMatches',
  'getLastEntry',
] as const)(
  '%s reads acceptance saved after the workspace became known',
  (read) => {
    render('legacy');
    render('workspace', 'legacy');
    pushInputHistoryEntry('legacy', 'first input');

    let result: string | string[] | null = null;
    act(() => {
      result =
        read === 'getLastEntry' ? history[read]() : history[read]('first');
    });
    expect(result).toEqual(
      read === 'getReverseMatches' ? ['first input'] : 'first input',
    );
    expect(localStorage.getItem('workspace')).toBeNull();
  },
);

it('includes delayed fallback acceptance when the next input is sent directly', () => {
  render('workspace', 'legacy');
  pushInputHistoryEntry('legacy', 'first input');
  act(() => history.push('second input'));
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual([
    'first input',
    'second input',
  ]);
});

it('keeps a browsing snapshot and draft until the next navigation cycle', () => {
  pushInputHistoryEntry('workspace', 'first');
  pushInputHistoryEntry('workspace', 'second');
  render();
  act(() => expect(history.navigateUp('working draft')).toBe('second'));
  pushInputHistoryEntry('workspace', 'third');
  expect(history.getReverseMatches('')).toEqual(['third', 'second', 'first']);
  expect(history.getLastEntry()).toBe('third');
  act(() => expect(history.navigateUp('second')).toBe('first'));
  act(() => expect(history.navigateDown()).toBe('second'));
  act(() => expect(history.navigateDown()).toBe('working draft'));
  act(() => expect(history.navigateUp('working draft')).toBe('third'));
});

it('returns to the draft when a duplicate push arrives mid-browse', () => {
  pushInputHistoryEntry('workspace', 'a');
  pushInputHistoryEntry('workspace', 'b');
  render();
  act(() => expect(history.navigateUp('my draft')).toBe('b'));
  pushInputHistoryEntry('workspace', 'x');
  act(() => history.push('x'));
  act(() => expect(history.navigateDown()).toBe('my draft'));
  act(() => expect(history.navigateDown()).toBeNull());
});

it('uses workspace history ahead of fallback and respects disabled fallback', () => {
  pushInputHistoryEntry('workspace', 'workspace input');
  render('workspace', 'legacy');
  pushInputHistoryEntry('legacy', 'unrelated input');
  expect(history.getReverseMatches('')).toEqual(['workspace input']);
  render('standalone');
  expect(history.getReverseMatches('')).toEqual([]);
});

it('preserves unsaved input when storage still contains an older history', () => {
  pushInputHistoryEntry('workspace', 'old input');
  render();
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => history.push('unsaved input'));
  expect(history.getLastEntry()).toBe('unsaved input');
  act(() => expect(history.navigateUp('draft')).toBe('unsaved input'));
  act(() => expect(history.navigateDown()).toBe('draft'));
  act(() => history.push('another unsaved input'));
  expect(history.getReverseMatches('')).toEqual([
    'another unsaved input',
    'unsaved input',
    'old input',
  ]);
  save.mockRestore();
  act(() => history.push('another unsaved input'));
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual([
    'old input',
    'unsaved input',
    'another unsaved input',
  ]);
});

it('keeps in-memory history when reading storage becomes unavailable', () => {
  pushInputHistoryEntry('workspace', 'saved input');
  render();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Access denied', 'SecurityError');
  });
  act(() => expect(history.navigateUp('draft')).toBe('saved input'));
  act(() => expect(history.navigateDown()).toBe('draft'));
  act(() => history.push('new input'));
  expect(history.getLastEntry()).toBe('new input');
});

it('does not carry unsaved history into another workspace', () => {
  pushInputHistoryEntry('other', 'other input');
  render();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => history.push('unsaved workspace input'));
  render('other');
  expect(history.getReverseMatches('')).toEqual(['other input']);
});

it('re-reads storage after a workspace switch that follows a failed save', () => {
  render();
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => history.push('unsaved input'));
  save.mockRestore();
  render('other');
  pushInputHistoryEntry('other', 'late acceptance');
  expect(history.getReverseMatches('')).toEqual(['late acceptance']);
});

it('does not re-render the host for history interactions nothing consumes', () => {
  pushInputHistoryEntry('workspace', 'first');
  pushInputHistoryEntry('workspace', 'second');
  render();
  const baseline = renderCount;

  act(() => expect(history.navigateUp('draft')).toBe('second'));
  act(() => expect(history.navigateUp('second')).toBe('first'));
  act(() => expect(history.navigateDown()).toBe('second'));
  act(() => expect(history.navigateDown()).toBe('draft'));
  act(() => history.push('next'));
  act(() => history.reset());

  expect(renderCount).toBe(baseline);
});

it('scopes shell history storage keys by workspace with legacy default', () => {
  expect(getShellHistoryStorageKey()).toBe('qwen-web-shell-command-history');
  expect(getShellHistoryStorageKey('/repo/a')).toBe(
    `qwen-web-shell-command-history:${encodeURIComponent('/repo/a')}`,
  );
});

it('merges remote history ahead at the newest tail while keeping local-only entries', () => {
  expect(
    mergeRemoteInputHistory(
      ['local-only', 'shared', 'older-local'],
      ['from-desktop-1', 'shared', 'from-desktop-2'],
    ),
  ).toEqual([
    'local-only',
    'older-local',
    'from-desktop-1',
    'shared',
    'from-desktop-2',
  ]);
});

it('keeps a just-submitted local prompt at the newest tail until the daemon confirms it', () => {
  pushInputHistoryEntry('workspace', 'older');
  pushInputHistoryEntry('workspace', 'middle');
  render('workspace', undefined, true);

  act(() => history.push('just-submitted'));
  const version = history.getMutationVersion();
  expect(history.applyRemoteEntries(['older', 'middle'], version)).toBe(false);
  expect(history.getReverseMatches('')).toEqual([
    'just-submitted',
    'middle',
    'older',
  ]);

  expect(
    history.applyRemoteEntries(['older', 'middle', 'from-desktop'], version),
  ).toBe(true);
  expect(history.getReverseMatches('')).toEqual([
    'just-submitted',
    'from-desktop',
    'middle',
    'older',
  ]);

  expect(
    history.applyRemoteEntries(
      ['older', 'middle', 'from-desktop', 'just-submitted'],
      version,
    ),
  ).toBe(false);
  expect(history.getLastEntry()).toBe('just-submitted');
});

it('applies remote entries without re-rendering and ignores stale responses after a local push', () => {
  pushInputHistoryEntry('workspace', 'local-1');
  render('workspace', undefined, true);
  const baseline = renderCount;

  const v0 = history.getMutationVersion();
  expect(history.applyRemoteEntries(['desktop-1', 'desktop-2'], v0)).toBe(true);
  expect(history.getReverseMatches('')).toEqual([
    'desktop-2',
    'desktop-1',
    'local-1',
  ]);
  expect(renderCount).toBe(baseline);

  // Applying the same remote entries again is a no-op.
  expect(history.applyRemoteEntries(['desktop-1', 'desktop-2'], v0)).toBe(
    false,
  );

  // A stale response captured before a local push must not clobber the new local entry.
  const staleVersion = history.getMutationVersion();
  act(() => history.push('fresh-mobile'));
  expect(history.applyRemoteEntries(['desktop-1'], staleVersion)).toBe(false);
  expect(history.getLastEntry()).toBe('fresh-mobile');
});

it('retains the order of pending local prompts across a remount until remote confirmation', () => {
  pushInputHistoryEntry('workspace', 'older');
  pushInputHistoryEntry('workspace', 'middle');
  render('workspace', undefined, true);
  act(() => history.push('first-pending'));
  act(() => history.push('second-pending'));
  expect(
    JSON.parse(localStorage.getItem('workspace:pending-remote')!).map(
      (entry: { text: string }) => entry.text,
    ),
  ).toEqual(['first-pending', 'second-pending']);
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual([
    'older',
    'middle',
    'first-pending',
    'second-pending',
  ]);

  render('other', undefined, true);
  render('workspace', undefined, true);
  expect(history.getReverseMatches('')).toEqual([
    'second-pending',
    'first-pending',
    'middle',
    'older',
  ]);

  const version = history.getMutationVersion();
  expect(
    history.applyRemoteEntries(['older', 'middle', 'from-desktop'], version),
  ).toBe(true);
  expect(history.getReverseMatches('')).toEqual([
    'second-pending',
    'first-pending',
    'from-desktop',
    'middle',
    'older',
  ]);
  expect(
    JSON.parse(localStorage.getItem('workspace:pending-remote')!).map(
      (entry: { text: string }) => entry.text,
    ),
  ).toEqual(['first-pending', 'second-pending']);

  expect(
    history.applyRemoteEntries(
      ['older', 'middle', 'from-desktop', 'first-pending'],
      version,
    ),
  ).toBe(false);
  expect(history.getReverseMatches('')).toEqual([
    'second-pending',
    'first-pending',
    'from-desktop',
    'middle',
    'older',
  ]);

  expect(
    history.applyRemoteEntries(
      ['older', 'middle', 'from-desktop', 'first-pending', 'second-pending'],
      version,
    ),
  ).toBe(false);
  expect(history.getLastEntry()).toBe('second-pending');
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('restores the latest pending order on a fresh mount with the same storage key', () => {
  const previous = ['p0', 'p1', 'p2', 'p3', 'p4'];
  for (const entry of previous) pushInputHistoryEntry('workspace', entry);
  localStorage.setItem('workspace:pending-remote', JSON.stringify(previous));
  render('workspace', undefined, true);

  const version = history.getMutationVersion();
  expect(history.applyRemoteEntries([], version)).toBe(false);
  expect(history.getReverseMatches('')).toEqual(previous.toReversed());
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    previous.map((text) => ({
      text,
      missedRemoteSnapshots: 0,
      hadLocalBefore: true,
    })),
  );
});

it('uses the daemon trim convention for pending and confirmed entries', () => {
  render('workspace', undefined, true);
  act(() => history.push(' hello '));
  const version = history.getMutationVersion();

  expect(history.applyRemoteEntries([], version, 'server-1')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(['hello']);
  // The canonical history is unchanged; only its pending marker is consumed.
  expect(history.applyRemoteEntries(['hello'], version, 'server-2')).toBe(
    false,
  );
  expect(history.getReverseMatches('')).toEqual(['hello']);
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('expires pending input only after two newer remote snapshots miss it', () => {
  pushInputHistoryEntry('workspace', 'older');
  render('workspace', undefined, true);
  act(() => history.push('local-pending'));
  const version = history.getMutationVersion();
  expect(
    history.applyRemoteEntries(['older', 'other-desktop'], version, 'server-1'),
  ).toBe(true);
  act(() => history.push('local-pending'));
  expect(history.getLastEntry()).toBe('local-pending');
  const currentVersion = history.getMutationVersion();

  // This response belongs to the first submission and must not advance expiry.
  expect(
    history.applyRemoteEntries(['older', 'from-desktop'], version, 'stale'),
  ).toBe(false);
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [
      {
        text: 'local-pending',
        seenRemoteRevision: 'server-1',
        missedRemoteSnapshots: 0,
      },
    ],
  );

  expect(
    history.applyRemoteEntries(
      ['older', 'from-desktop'],
      currentVersion,
      'server-2',
    ),
  ).toBe(true);
  expect(history.getLastEntry()).toBe('local-pending');
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [
      {
        text: 'local-pending',
        seenRemoteRevision: 'server-2',
        missedRemoteSnapshots: 1,
      },
    ],
  );

  const repeated = JSON.parse(
    localStorage.getItem('workspace:pending-remote')!,
  );
  expect(
    history.applyRemoteEntries(
      ['older', 'from-desktop'],
      currentVersion,
      'server-2',
    ),
  ).toBe(false);
  expect(history.getLastEntry()).toBe('local-pending');
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    repeated,
  );

  expect(
    history.applyRemoteEntries(
      ['older', 'from-desktop', 'latest-desktop'],
      currentVersion,
      'server-3',
    ),
  ).toBe(true);
  expect(history.getLastEntry()).toBe('latest-desktop');
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('preserves local-only entries against a full remote history window', () => {
  const manyRemotes = Array.from(
    { length: 100 },
    (_, index) => `remote-${index}`,
  );
  const localEntries = [
    ...Array.from({ length: 40 }, (_, index) => `local-${index}`),
    'most-recent-local',
  ];
  const merged = mergeRemoteInputHistory(localEntries, manyRemotes);
  expect(merged).toEqual([...localEntries, ...manyRemotes.slice(41)]);
});

it('expires a lost pending prompt without displacing any of the 100 remote entries', () => {
  render('workspace', undefined, true);
  expect(history.applyRemoteEntries([], 0, 'before-submit')).toBe(false);
  act(() => history.push('lost-pending'));
  const version = history.getMutationVersion();
  const first = Array.from({ length: 99 }, (_, index) => `remote-${index}`);
  expect(history.applyRemoteEntries(first, version, 'newer-1')).toBe(true);
  expect(history.getLastEntry()).toBe('lost-pending');
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [
      {
        text: 'lost-pending',
        seenRemoteRevision: 'newer-1',
        missedRemoteSnapshots: 1,
      },
    ],
  );

  const fullWindow = [...first, 'remote-99'];
  expect(history.applyRemoteEntries(fullWindow, version, 'newer-2')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(fullWindow.toReversed());
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('uses the latest full remote window instead of retaining evicted entries', () => {
  render('workspace', undefined, true);
  const initial = Array.from({ length: 100 }, (_, i) => `remote-${i}`);
  expect(history.applyRemoteEntries(initial, 0, 'first-window')).toBe(true);

  // Remount so this cover both the persisted source metadata and in-memory state.
  render('other', undefined, true);
  render('workspace', undefined, true);
  const version = history.getMutationVersion();
  const next = [...initial.slice(1), 'remote-100'];
  expect(history.applyRemoteEntries(next, version, 'next-window')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(next.toReversed());
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual(next);
  expect(JSON.parse(localStorage.getItem('workspace:remote-source')!)).toEqual(
    next,
  );
});

it('keeps new remote entries visible after a full local-only history', () => {
  const locals = Array.from({ length: 100 }, (_, i) => `local-${i}`);
  for (const entry of locals) pushInputHistoryEntry('workspace', entry);
  render('workspace', undefined, true);
  const version = history.getMutationVersion();
  const first = Array.from({ length: 100 }, (_, i) => `remote-${i}`);
  expect(history.applyRemoteEntries(first, version, 'first-window')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(
    [...locals.slice(1), 'remote-99'].toReversed(),
  );

  const next = [...first.slice(1), 'new-desktop'];
  expect(history.applyRemoteEntries(next, version, 'new-window')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(
    [...locals.slice(1), 'new-desktop'].toReversed(),
  );
});

it('deduplicates legacy pending text after normalization', () => {
  localStorage.setItem('workspace', JSON.stringify([' foo ', 'foo']));
  localStorage.setItem(
    'workspace:pending-remote',
    JSON.stringify([' foo ', 'foo']),
  );
  render('workspace', undefined, true);

  expect(history.applyRemoteEntries([], 0)).toBe(true);
  expect(history.getReverseMatches('')).toEqual(['foo']);
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [{ text: 'foo', missedRemoteSnapshots: 0, hadLocalBefore: true }],
  );
});

it('preserves a pre-existing local entry when its newer pending copy expires', () => {
  pushInputHistoryEntry('workspace', 'repeat');
  pushInputHistoryEntry('workspace', 'other');
  render('workspace', undefined, true);
  expect(history.applyRemoteEntries(['other'], 0, 'r0')).toBe(false);
  act(() => history.push('repeat'));
  const version = history.getMutationVersion();

  expect(history.applyRemoteEntries(['other'], version, 'r1')).toBe(true);
  render('other', undefined, true);
  render('workspace', undefined, true);
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [
      {
        text: 'repeat',
        hadLocalBefore: true,
        seenRemoteRevision: 'r1',
        missedRemoteSnapshots: 1,
      },
    ],
  );
  const remountedVersion = history.getMutationVersion();
  expect(history.applyRemoteEntries(['later'], remountedVersion, 'r2')).toBe(
    true,
  );
  expect(history.getReverseMatches('')).toContain('repeat');
  expect(history.getLastEntry()).toBe('later');
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('does not discard source-unknown history merely because windows overlap', () => {
  const previous = Array.from({ length: 100 }, (_, index) => `remote-${index}`);
  for (const entry of previous) pushInputHistoryEntry('workspace', entry);
  render('workspace', undefined, true);

  const next = [...previous.slice(1), 'remote-100'];
  expect(history.applyRemoteEntries(next, 0, 'next-window')).toBe(true);
  const after = [previous[0], ...next.slice(1)];
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual(after);
  const newer = [...next.slice(1), 'remote-101'];
  expect(history.applyRemoteEntries(newer, 0, 'newer-window')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(
    [previous[0], ...newer.slice(1)].reverse(),
  );
  expect(JSON.parse(localStorage.getItem('workspace:remote-source')!)).toEqual(
    newer.slice(1),
  );
});

it('does not erase independent local history on one shared entry', () => {
  const local = Array.from({ length: 99 }, (_, index) => `local-${index}`);
  const remote = Array.from({ length: 99 }, (_, index) => `remote-${index}`);
  expect(
    mergeRemoteInputHistory([...local, 'shared'], ['shared', ...remote], null),
  ).toEqual([...local, 'remote-98']);
});

it('keeps more than four rapid pending inputs ordered across a remount', () => {
  render('workspace', undefined, true);
  for (let index = 0; index < 5; index++) {
    act(() => history.push(`pending-${index}`));
  }
  expect(history.applyRemoteEntries(['desktop'], 5, 'r0')).toBe(true);
  render('workspace', undefined, true);
  render('other', undefined, true);
  render('workspace', undefined, true);
  const restoredVersion = history.getMutationVersion();
  expect(history.applyRemoteEntries(['desktop'], restoredVersion, 'r1')).toBe(
    false,
  );
  expect(history.getReverseMatches('')).toEqual([
    'pending-4',
    'pending-3',
    'pending-2',
    'pending-1',
    'pending-0',
    'desktop',
  ]);

  expect(history.applyRemoteEntries(['later'], restoredVersion, 'r2')).toBe(
    true,
  );
  expect(history.getReverseMatches('')).toEqual(['later']);
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('follows a multi-step authoritative window after confirming a prior local copy', () => {
  const previous = Array.from({ length: 100 }, (_, index) => `remote-${index}`);
  for (const entry of previous) pushInputHistoryEntry('workspace', entry);
  localStorage.setItem('workspace:remote-source', JSON.stringify(previous));
  render('workspace', undefined, true);
  act(() => history.push('remote-99'));
  const version = history.getMutationVersion();

  const next = [...previous.slice(2), 'remote-100', 'remote-101'];
  expect(history.applyRemoteEntries(next, version, 'next-window')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(next.toReversed());
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual(next);
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
  expect(history.applyRemoteEntries(next, version, 'next-window')).toBe(false);
});

it('expires a repeated remote-owned entry without reclaiming its stale copy', () => {
  render('workspace', undefined, true);
  const first = Array.from({ length: 100 }, (_, index) => `remote-${index}`);
  expect(history.applyRemoteEntries(first, 0, 'r0')).toBe(true);
  act(() => history.push('remote-0'));
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [
      {
        text: 'remote-0',
        seenRemoteRevision: 'r0',
        missedRemoteSnapshots: 0,
      },
    ],
  );

  const version = history.getMutationVersion();
  const second = [...first.slice(1), 'remote-100'];
  const third = [...second.slice(1), 'remote-101'];
  expect(history.applyRemoteEntries(second, version, 'r1')).toBe(true);
  expect(history.applyRemoteEntries(third, version, 'r2')).toBe(true);
  expect(history.getReverseMatches('')).toEqual(third.toReversed());
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual(third);
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('does not queue oversized text as permanently pending remote history', () => {
  render('workspace', undefined, true);
  act(() => history.push('x'.repeat(MAX_INPUT_HISTORY_ENTRY_CHARS + 1)));
  expect(JSON.parse(localStorage.getItem('workspace:pending-remote')!)).toEqual(
    [],
  );
});

it('does not track pending order without a supported daemon', () => {
  render('workspace');
  act(() => history.push('local-only-input'));
  expect(localStorage.getItem('workspace:pending-remote')).toBeNull();
});
