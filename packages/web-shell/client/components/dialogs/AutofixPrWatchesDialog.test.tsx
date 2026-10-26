// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions } = vi.hoisted(() => ({
  actions: {
    listAutofixPrWatches: vi.fn(),
    listScheduledTasks: vi.fn(),
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
}));

const { AutofixPrWatchesDialog } = await import('./AutofixPrWatchesDialog');
const { I18nProvider } = await import('../../i18n');

const SESSION = '10000000-0000-4000-8000-000000000001';

const watch = (over: Record<string, unknown> = {}) => ({
  pr: 12,
  repo: 'o/r',
  host: 'github.com',
  url: 'https://github.com/o/r/pull/12',
  headRefName: 'feat',
  headSha: 'a'.repeat(40),
  pushes: 1,
  maxPushes: 10,
  session: SESSION,
  preparedAt: null,
  lastCheck: null,
  checkedRecently: true,
  lastRound: null,
  stopped: null,
  watch: { every: 2, reply: true, instructions: '', task: 'feedc0ffee12' },
  ended: null,
  needsHuman: [],
  worktreeExists: true,
  fix: null,
  ...over,
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: null,
  cron: '*/2 * * * *',
  prompt: 'Run /autofix-pr tick o/r#12 --task feedc0ffee12',
  recurring: true,
  enabled: true,
  createdAt: 1,
  lastFiredAt: null,
  nextRunAt: null,
  sessionId: SESSION,
  sessionMode: 'persistent',
  modelServiceId: null,
  groupId: null,
  runs: [],
  ...over,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(
  props: {
    onRunPrompt?: (prompt: string, sessionId: string) => Promise<void>;
    onOpenSession?: (sessionId: string) => void;
    workspaces?: Array<{
      id: string;
      cwd: string;
      primary: boolean;
      trusted: boolean;
      kind: 'ordinary';
    }>;
    lockedWorkspace?: {
      id: string;
      cwd: string;
      primary: boolean;
      trusted: boolean;
      kind: 'ordinary';
    };
  } = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <AutofixPrWatchesDialog
          onRunPrompt={props.onRunPrompt ?? vi.fn()}
          onOpenSession={props.onOpenSession ?? vi.fn()}
          workspaces={props.workspaces as never}
          lockedWorkspace={props.lockedWorkspace as never}
          onError={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

function button(label: string) {
  return Array.from(container!.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe('AutofixPrWatchesDialog', () => {
  it('lists the watches with their state, opening and stopping each in the session its task is bound to', async () => {
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      watches: [
        watch({
          fix: {
            attempt: '0123456789ab',
            startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
            fresh: true,
          },
        }),
      ],
    });
    actions.listScheduledTasks.mockResolvedValue([task()]);
    const onRunPrompt = vi.fn().mockResolvedValue(undefined);
    const onOpenSession = vi.fn();
    await mount({ onRunPrompt, onOpenSession });
    const text = container!.textContent ?? '';
    expect(text).toContain('o/r#12');
    expect(text).toContain('Fixing in the background (6 min)');
    expect(container!.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/12',
    );
    act(() => button('Open session')!.click());
    expect(onOpenSession).toHaveBeenCalledWith(SESSION);
    await act(async () => button('Stop watch')!.click());
    expect(onRunPrompt).toHaveBeenCalledWith('/autofix-pr stop 12', SESSION);
  });

  it('says where to stop a watch no session of this Web Shell runs', async () => {
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      watches: [
        watch(),
        watch({
          pr: 13,
          url: 'https://github.com/o/r/pull/13',
          watch: null,
          ended: { at: '2026-10-26T10:00:00.000Z', reason: 'stopped' },
        }),
      ],
    });
    // The live watch's task is another session's: a take-over moved it.
    actions.listScheduledTasks.mockResolvedValue([
      task({ sessionId: 'another' }),
    ]);
    await mount();
    expect(button('Stop watch')).toBeUndefined();
    const text = container!.textContent ?? '';
    expect(text).toContain('Owned by a session outside this Web Shell');
    expect(text).toContain('Stopped: stopped');
    expect(text).toContain('/autofix-pr stop 13 cleans it up');
  });

  it("lists each workspace's watches under it, reading the primary by its own route", async () => {
    actions.listAutofixPrWatches.mockImplementation(async (id?: string) => ({
      available: true,
      watches: id === 'second' ? [watch({ pr: 40, url: 'u40' })] : [watch()],
    }));
    actions.listScheduledTasks.mockResolvedValue([]);
    await mount({
      workspaces: [
        {
          id: 'main',
          cwd: '/w/main',
          primary: true,
          trusted: true,
          kind: 'ordinary',
        },
        {
          id: 'second',
          cwd: '/w/second',
          primary: false,
          trusted: true,
          kind: 'ordinary',
        },
        {
          id: 'third',
          cwd: '/w/third',
          primary: false,
          trusted: false,
          kind: 'ordinary',
        },
      ],
    });
    expect(actions.listAutofixPrWatches.mock.calls).toEqual([
      [undefined],
      ['second'],
    ]);
    const text = container!.textContent ?? '';
    expect(text).toContain('o/r#12');
    expect(text).toContain('o/r#40');
  });

  it('names the one workspace of a single-project daemon when it opens or stops a watch', async () => {
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      watches: [watch()],
    });
    actions.listScheduledTasks.mockResolvedValue([task()]);
    const onRunPrompt = vi.fn().mockResolvedValue(undefined);
    const onOpenSession = vi.fn();
    await mount({
      onRunPrompt,
      onOpenSession,
      workspaces: [
        {
          id: 'main',
          cwd: '/w/main',
          primary: true,
          trusted: true,
          kind: 'ordinary',
        },
      ],
    });
    // By the primary's own route.
    expect(actions.listAutofixPrWatches.mock.calls).toEqual([[undefined]]);
    act(() => button('Open session')!.click());
    expect(onOpenSession).toHaveBeenCalledWith(SESSION, '/w/main');
    await act(async () => button('Stop watch')!.click());
    expect(onRunPrompt).toHaveBeenCalledWith(
      '/autofix-pr stop 12',
      SESSION,
      '/w/main',
    );
  });

  it('reads a locked workspace by its own route only', async () => {
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      watches: [],
    });
    actions.listScheduledTasks.mockResolvedValue([]);
    const second = {
      id: 'second',
      cwd: '/w/second',
      primary: false,
      trusted: true,
      kind: 'ordinary' as const,
    };
    await mount({ workspaces: [second], lockedWorkspace: second });
    expect(actions.listAutofixPrWatches.mock.calls).toEqual([['second']]);
    // Read again with every reload of the watches: the same workspace.
    expect(
      new Set(actions.listScheduledTasks.mock.calls.map((call) => call[0])),
    ).toEqual(new Set(['second']));
  });

  it("lists a clone's watch once, its owner found in whichever workspace holds its task", async () => {
    // Two checkouts of one clone, both registered: the same watches.
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      root: '/w/main',
      watches: [watch()],
    });
    actions.listScheduledTasks.mockImplementation(async (id?: string) =>
      id === 'linked' ? [task()] : [],
    );
    const onRunPrompt = vi.fn().mockResolvedValue(undefined);
    const onOpenSession = vi.fn();
    await mount({
      onRunPrompt,
      onOpenSession,
      workspaces: [
        {
          id: 'main',
          cwd: '/w/main',
          primary: true,
          trusted: true,
          kind: 'ordinary',
        },
        {
          id: 'linked',
          cwd: '/w/linked',
          primary: false,
          trusted: true,
          kind: 'ordinary',
        },
      ],
    });
    expect(
      container!.querySelectorAll('[data-testid="autofix-pr-watch"]'),
    ).toHaveLength(1);
    // Restored in the workspace of its task, not the one it is listed under.
    act(() => button('Open session')!.click());
    expect(onOpenSession).toHaveBeenCalledWith(SESSION, '/w/linked');
    await act(async () => button('Stop watch')!.click());
    expect(onRunPrompt).toHaveBeenCalledWith(
      '/autofix-pr stop 12',
      SESSION,
      '/w/linked',
    );
  });

  it('sends a watch no gate checks to a session here, not to a terminal', async () => {
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      watches: [watch({ checkedRecently: false })],
    });
    actions.listScheduledTasks.mockResolvedValue([]);
    await mount();
    const text = container!.textContent ?? '';
    expect(text).toContain('Not checked recently');
    expect(text).not.toContain('outside this Web Shell');
    expect(text).toContain('/autofix-pr resume 12 starts it again');
  });

  it('shows an empty list, and the watches it could not read', async () => {
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      watches: [],
    });
    actions.listScheduledTasks.mockResolvedValue([]);
    await mount();
    expect(container!.textContent).toContain('No /autofix-pr watch yet');
    act(() => root?.unmount());
    container?.remove();
    actions.listAutofixPrWatches.mockResolvedValue({
      available: true,
      watches: [],
      unreadable: [{ pr: 9, error: 'state.json: bad' }],
    });
    await mount();
    const text = container!.textContent ?? '';
    expect(text).not.toContain('No /autofix-pr watch yet');
    expect(text).toContain(
      'Could not read the watch of PR #9: state.json: bad',
    );
  });
});
