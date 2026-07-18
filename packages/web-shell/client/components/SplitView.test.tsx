// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
let connectionState: any;
let sessionsState: any[];
// Live sessions the mock daemon returns per non-primary workspace cwd, keyed by
// cwd — drives `useOtherWorkspaceSessions` (via the mocked `useWorkspace`).
let otherWorkspaceSessions: Record<string, any[]>;
// Stable client object (assigned once per test) so the other-workspace hook's
// load callback keeps a stable identity and its effect doesn't loop.
let workspaceClient: {
  listWorkspaceSessions: ReturnType<typeof vi.fn>;
  workspaceByCwd: ReturnType<typeof vi.fn>;
};
// Stable across renders (assigned once per test) so SplitView's reload effects,
// which depend on `reload`'s identity, don't re-fire on every render.
let reloadMock: ReturnType<typeof vi.fn>;

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DaemonSessionProvider: (props: any) => (
    <div
      data-session={props.sessionId}
      data-clientid={props.clientId}
      data-workspace={props.workspaceCwd}
      data-restart-sse={props.restartEventStreamOnPrompt ? 'true' : 'false'}
    >
      {props.children}
    </div>
  ),
  useConnection: () => connectionState,
  // `client` is a stable object; `capabilities` mirrors the connection so a test
  // that sets `capabilities.workspaces` drives both the picker labels and the
  // other-workspace fan-out from one place.
  useWorkspace: () => ({
    client: workspaceClient,
    capabilities: connectionState.capabilities,
  }),
  // Stateful, like the real hook: reload() re-renders with the CURRENT module
  // store. This lets a test prove the picker renders sessions that appeared
  // only after the reload — not merely that reload() was called.
  useSessions: () => {
    const [sessions, setSessions] = React.useState<any[]>(() => sessionsState);
    const reload = React.useCallback(async () => {
      reloadMock();
      setSessions([...sessionsState]);
      return sessionsState;
    }, []);
    return { sessions, reload };
  },
}));

vi.mock('./ChatPane', () => ({
  ChatPane: (props: any) => {
    // Let a test force a render crash to exercise the per-pane ErrorBoundary.
    if (props.title === 'BOOM') throw new Error('pane exploded');
    return (
      <div
        data-testid="chat-pane"
        data-pane-workspace={props.workspaceCwd}
        data-maximized={props.isMaximized ? 'true' : 'false'}
        data-pane-restart-sse={props.restartSseOnPrompt ? 'true' : 'false'}
      >
        <span data-testid="pane-title">{props.title}</span>
        {props.onToggleMaximize && (
          <button data-testid="pane-maximize" onClick={props.onToggleMaximize}>
            max
          </button>
        )}
        {props.onClose && (
          <button data-testid="pane-close" onClick={props.onClose}>
            x
          </button>
        )}
      </div>
    );
  },
}));

const { SplitView } = await import('./SplitView');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  connectionState = {
    sessionId: 's3',
    capabilities: { features: [] },
    workspaceCwd: '/w',
  };
  sessionsState = [
    { sessionId: 's1', workspaceCwd: '/w', displayName: 'One' },
    { sessionId: 's2', workspaceCwd: '/w', displayName: 'Two' },
    { sessionId: 's3', workspaceCwd: '/w', displayName: 'Three' },
    { sessionId: 's4', workspaceCwd: '/w', displayName: 'Four' },
  ];
  otherWorkspaceSessions = {};
  workspaceClient = {
    listWorkspaceSessions: vi.fn(
      async (cwd: string) => otherWorkspaceSessions[cwd] ?? [],
    ),
    workspaceByCwd: vi.fn((cwd: string) => ({
      listWorkspaceSessions: vi.fn(
        async () => otherWorkspaceSessions[cwd] ?? [],
      ),
    })),
  };
  reloadMock = vi.fn();
});

// Flush the other-workspace hook's async fan-out (Promise.allSettled + the
// effect's `.then` setState). Three ticks so the state update lands in `act`.
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(props: Record<string, unknown> = {}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <SplitView onExit={() => {}} {...props} />
      </I18nProvider>,
    ),
  );
}

function panes(): HTMLElement[] {
  return Array.from(container!.querySelectorAll('[data-testid="chat-pane"]'));
}
function titles(): string[] {
  return Array.from(
    container!.querySelectorAll('[data-testid="pane-title"]'),
  ).map((el) => el.textContent ?? '');
}
function pickerOptions(): string[] {
  return Array.from(container!.querySelectorAll('[role="option"] button')).map(
    (el) => (el.textContent ?? '').trim(),
  );
}
function openPicker(): void {
  const addButton = container!.querySelector(
    'button[aria-haspopup="listbox"]',
  ) as HTMLButtonElement;
  act(() =>
    addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
}

describe('SplitView', () => {
  it('renders one pane per initial session, each under its own provider', () => {
    render({ sessionIds: ['s1', 's2'] });
    expect(panes()).toHaveLength(2);
    expect(titles()).toEqual(['One', 'Two']);
    const providers = container!.querySelectorAll('[data-session]');
    expect(providers[0].getAttribute('data-session')).toBe('s1');
    // Panes use a distinct client id (with a per-mount nonce) so they don't
    // collide with the main view — or with another tab's panes for the session.
    const clientId = providers[0].getAttribute('data-clientid') ?? '';
    expect(clientId).toMatch(/^split-pane:.+:s1$/);
    // Both panes share this instance's nonce.
    const s2ClientId = providers[1].getAttribute('data-clientid') ?? '';
    const nonce = clientId.slice('split-pane:'.length, -':s1'.length);
    expect(s2ClientId).toBe(`split-pane:${nonce}:s2`);
  });

  it('passes the prompt SSE restart option to pane providers', () => {
    render({ sessionIds: ['s1'], restartSseOnPrompt: true });
    expect(
      container!
        .querySelector('[data-session="s1"]')
        ?.getAttribute('data-restart-sse'),
    ).toBe('true');
    expect(
      container!
        .querySelector('[data-session="s1"] [data-testid="chat-pane"]')
        ?.getAttribute('data-pane-restart-sse'),
    ).toBe('true');
  });

  it('seeds with the current session when no session ids are given', () => {
    render();
    expect(titles()).toEqual(['Three']);
  });

  it('dedupes initial sessions', () => {
    render({ sessionIds: ['s1', 's1', 's2'] });
    expect(titles()).toEqual(['One', 'Two']);
  });

  it('syncs panes when session ids change after mount', () => {
    render({ sessionIds: ['s1'] });
    expect(titles()).toEqual(['One']);

    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView onExit={() => {}} sessionIds={['s1', 's2']} />
        </I18nProvider>,
      ),
    );
    expect(titles()).toEqual(['One', 'Two']);

    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView onExit={() => {}} sessionIds={[]} />
        </I18nProvider>,
      ),
    );
    expect(panes()).toHaveLength(0);
  });

  it('requests pane changes without mutating local panes when controlled', () => {
    const onPanesChange = vi.fn();
    render({ sessionIds: ['s1'], onPanesChange });

    openPicker();
    const options = container!.querySelectorAll('[role="option"] button');
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onPanesChange).toHaveBeenCalledWith(['s1', 's2']);
    expect(titles()).toEqual(['One']);

    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView
            onExit={() => {}}
            sessionIds={['s1', 's2']}
            onPanesChange={onPanesChange}
          />
        </I18nProvider>,
      ),
    );
    expect(titles()).toEqual(['One', 'Two']);

    const close = container!.querySelector('[data-testid="pane-close"]');
    act(() => close!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onPanesChange).toHaveBeenCalledWith(['s2']);
    expect(titles()).toEqual(['One', 'Two']);
  });

  it('adds a pane from the picker', () => {
    render();
    expect(panes()).toHaveLength(1);
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    act(() =>
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // Picker lists sessions not already shown (s1, s2, s4).
    const options = container!.querySelectorAll('[role="option"] button');
    expect(options).toHaveLength(3);
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(panes()).toHaveLength(2);
  });

  it('closes the picker on Escape', () => {
    render({ sessionIds: ['s1'] });
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    act(() =>
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(addButton.getAttribute('aria-expanded')).toBe('true');
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(addButton.getAttribute('aria-expanded')).toBe('false');
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
  });

  it('closes the picker on a click outside it', () => {
    render({ sessionIds: ['s1'] });
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    act(() =>
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(container!.querySelector('[role="listbox"]')).not.toBeNull();
    // A mousedown anywhere outside the add-wrap dismisses it…
    act(() =>
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      ),
    );
    expect(addButton.getAttribute('aria-expanded')).toBe('false');
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
  });

  it('keeps the picker open on a click inside it', () => {
    render({ sessionIds: ['s1'] });
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    act(() =>
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const listbox = container!.querySelector('[role="listbox"]') as HTMLElement;
    // A mousedown on the picker itself must not dismiss it (the click that
    // selects an option would otherwise be swallowed).
    act(() =>
      listbox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    expect(addButton.getAttribute('aria-expanded')).toBe('true');
    expect(container!.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('removes a pane via its close button', () => {
    render();
    openPicker();
    const options = container!.querySelectorAll('[role="option"] button');
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(panes()).toHaveLength(2);

    const closes = container!.querySelectorAll('[data-testid="pane-close"]');
    act(() =>
      closes[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(titles()).toEqual(['One']);
  });

  it('auto-exits to the overview when the last pane is closed', () => {
    const onExit = vi.fn();
    render({ onExit });
    expect(onExit).not.toHaveBeenCalled();
    const close = container!.querySelector('[data-testid="pane-close"]');
    act(() => close!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('exits via the back button', () => {
    const onExit = vi.fn();
    render({ sessionIds: ['s1'], onExit });
    // The back button is the first toolbar button (aria-label from common.back).
    const back = container!.querySelector('header button') as HTMLButtonElement;
    act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('caps the number of panes at MAX_PANES (6)', () => {
    sessionsState = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `x${i}`,
      workspaceCwd: '/w',
      displayName: `Pane ${i}`,
    }));
    render({ sessionIds: sessionsState.map((s) => s.sessionId) });
    // Eight requested, but only six live panes mount.
    expect(panes()).toHaveLength(6);
  });

  it('isolates a crashing pane so the rest of the split survives', () => {
    sessionsState = [
      { sessionId: 's1', workspaceCwd: '/w', displayName: 'BOOM' },
      { sessionId: 's2', workspaceCwd: '/w', displayName: 'Two' },
    ];
    render({ sessionIds: ['s1', 's2'] });
    // The crashing pane shows its error fallback; the healthy pane still renders.
    expect(container!.textContent).toContain('This session pane hit an error');
    expect(panes()).toHaveLength(1);
    expect(titles()).toEqual(['Two']);
  });

  function maximizeButtons(): HTMLElement[] {
    return Array.from(
      container!.querySelectorAll('[data-testid="pane-maximize"]'),
    );
  }
  function hiddenSlots(): HTMLElement[] {
    return Array.from(container!.querySelectorAll('[data-pane-hidden]'));
  }

  it('offers a maximize toggle only when more than one pane is open', () => {
    // A lone pane already fills the split — nothing to maximize against.
    render();
    expect(maximizeButtons()).toHaveLength(0);
    // Adding a second pane makes the toggle available on both.
    openPicker();
    const options = container!.querySelectorAll('[role="option"] button');
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(maximizeButtons()).toHaveLength(2);
  });

  it('maximizing a pane hides the others but keeps them all mounted', () => {
    render({ sessionIds: ['s1', 's2', 's3'] });
    expect(panes()).toHaveLength(3);
    expect(hiddenSlots()).toHaveLength(0);

    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    // All three panes stay mounted (their sessions keep streaming)…
    expect(panes()).toHaveLength(3);
    // …but the two non-maximized slots are hidden, leaving one visible.
    expect(hiddenSlots()).toHaveLength(2);
    // The maximized pane reflects its state down to ChatPane.
    const maximized = container!.querySelector('[data-maximized="true"]');
    expect(
      maximized?.querySelector('[data-testid="pane-title"]')?.textContent,
    ).toBe('One');
  });

  it('toggles back to the tiled layout when the maximized pane’s button is clicked again', () => {
    render({ sessionIds: ['s1', 's2'] });
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    // The still-mounted maximized pane's own toggle restores the split.
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(0);
    expect(container!.querySelector('[data-maximized="true"]')).toBeNull();
  });

  it('restores the tiled layout on Escape', () => {
    render({ sessionIds: ['s1', 's2'] });
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    // A plain Escape (not aimed at the composer or picker) restores all panes.
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(0);
  });

  it('keeps a pane maximized when Escape originates from an editable field', () => {
    render({ sessionIds: ['s1', 's2'] });
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    // Escape from the composer cancels the turn / closes its menus — it must not
    // also un-maximize. An <input> stands in for the CodeMirror editor here.
    const input = document.createElement('input');
    container!.appendChild(input);
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    input.remove();
  });

  it('moves maximize to another pane when its toggle is clicked', () => {
    render({ sessionIds: ['s1', 's2', 's3'] });
    // Maximize s1.
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    let maximized = container!.querySelector('[data-maximized="true"]');
    expect(
      maximized?.querySelector('[data-testid="pane-title"]')?.textContent,
    ).toBe('One');
    // Click s2's toggle while s1 is maximized — maximize MOVES to s2 (it does
    // not restore to tiled). Guards the toggle's switch branch, which a
    // "clear on any second click" regression would break.
    act(() =>
      maximizeButtons()[1].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    maximized = container!.querySelector('[data-maximized="true"]');
    expect(
      maximized?.querySelector('[data-testid="pane-title"]')?.textContent,
    ).toBe('Two');
    // Exactly one pane maximized, the other two hidden.
    expect(container!.querySelectorAll('[data-maximized="true"]')).toHaveLength(
      1,
    );
    expect(hiddenSlots()).toHaveLength(2);
  });

  it('closes the picker on Escape without un-maximizing', () => {
    render({ sessionIds: ['s1', 's2'] });
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    // Open the add-session picker, then press Escape: it closes the picker but
    // must NOT also un-maximize — Escape defers to the open picker first.
    openPicker();
    expect(container!.querySelector('[role="listbox"]')).not.toBeNull();
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    expect(hiddenSlots()).toHaveLength(1);
  });

  it('drops maximize when the maximized pane is closed', () => {
    // Uncontrolled so the close button removes the pane locally (a controlled
    // split only reports removals up via onPanesChange).
    render();
    openPicker();
    const options = container!.querySelectorAll('[role="option"] button');
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(panes()).toHaveLength(2); // seed 'Three' + added 'One'
    // Maximize the seed pane, then close it via its (visible) close button.
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    const closes = container!.querySelectorAll('[data-testid="pane-close"]');
    act(() =>
      closes[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // The lone survivor tiles normally — maximize was dropped with its pane.
    expect(titles()).toEqual(['One']);
    expect(hiddenSlots()).toHaveLength(0);
  });

  it('drops maximize when a controlled sync removes the maximized pane', () => {
    render({ sessionIds: ['s1', 's2'] });
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    // The parent drops the maximized session (s1) from the split…
    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView onExit={() => {}} sessionIds={['s2']} />
        </I18nProvider>,
      ),
    );
    // …so nothing stays maximized — the lone survivor tiles normally.
    expect(titles()).toEqual(['Two']);
    expect(hiddenSlots()).toHaveLength(0);
  });

  it('clears a stale maximize when a controlled split shrinks to one pane then regrows', () => {
    const rerender = (ids: string[]) =>
      act(() =>
        root!.render(
          <I18nProvider language="en">
            <SplitView onExit={() => {}} sessionIds={ids} />
          </I18nProvider>,
        ),
      );
    render({ sessionIds: ['s1', 's2'] });
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1); // s1 maximized, s2 hidden
    // The parent drops the *other* pane, leaving the maximized one alone — the
    // stale maximize must clear (it can't hold against a single pane)…
    rerender(['s1']);
    expect(titles()).toEqual(['One']);
    expect(hiddenSlots()).toHaveLength(0);
    // …so re-adding a pane shows a clean tiled split, not a silently re-hidden
    // one from the earlier maximize.
    rerender(['s1', 's2']);
    expect(titles()).toEqual(['One', 'Two']);
    expect(hiddenSlots()).toHaveLength(0);
  });

  it('reveals a newly added pane by exiting maximize', () => {
    // Uncontrolled so the picker mounts the new pane locally.
    render();
    openPicker();
    let options = container!.querySelectorAll('[role="option"] button');
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(panes()).toHaveLength(2);
    act(() =>
      maximizeButtons()[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(hiddenSlots()).toHaveLength(1);
    // Adding another session drops the maximize so the new pane isn't hidden
    // behind a still-maximized one.
    openPicker();
    options = container!.querySelectorAll('[role="option"] button');
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(panes()).toHaveLength(3);
    expect(hiddenSlots()).toHaveLength(0);
  });

  it('reloads the session list when the picker opens (never a stale list)', () => {
    render({ sessionIds: ['s1'] });
    // `useSessions` only fetches on mount; nothing reloads until the user acts.
    expect(reloadMock).not.toHaveBeenCalled();
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    act(() =>
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('renders the refreshed session list on reopen — not the entry snapshot', () => {
    render({ sessionIds: ['s1'] });
    // First open: the picker offers the sessions present at entry.
    openPicker();
    expect(pickerOptions()).toEqual(['Two', 'Three', 'Four']);
    // A session is created elsewhere after the split was entered…
    sessionsState = [
      ...sessionsState,
      { sessionId: 's5', workspaceCwd: '/w', displayName: 'Five' },
    ];
    // …reopening the picker reloads and the new session now appears. Without the
    // reload-on-open the list would be frozen at the entry snapshot (no 'Five').
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    openPicker();
    expect(pickerOptions()).toEqual(['Two', 'Three', 'Four', 'Five']);
  });

  it('reloads the picker list when the parent bumps the reload token', () => {
    render({ sessionIds: ['s1'], sessionListReloadToken: 0 });
    // The initial token is not a change, so it does not trigger a reload.
    expect(reloadMock).not.toHaveBeenCalled();
    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView
            onExit={() => {}}
            sessionIds={['s1']}
            sessionListReloadToken={1}
          />
        </I18nProvider>,
      ),
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('mirrors the live pane set up to the parent as panes change', () => {
    const onPanesChange = vi.fn();
    render({ onPanesChange });
    // Reported on mount so the parent's seed reflects the actual panes…
    expect(onPanesChange).toHaveBeenLastCalledWith(['s3']);
    // …and after every add (so switching away and back restores it).
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    act(() =>
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const options = container!.querySelectorAll('[role="option"] button');
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onPanesChange).toHaveBeenLastCalledWith(['s3', 's1']);
    // …and after every remove.
    const close = container!.querySelector('[data-testid="pane-close"]');
    act(() => close!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onPanesChange).toHaveBeenLastCalledWith(['s1']);
  });

  const MULTI_WORKSPACE_CAPS = {
    features: [] as string[],
    workspaceCwd: '/w',
    workspaces: [
      { id: 'w0', cwd: '/w', primary: true, trusted: true },
      { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
    ],
  };

  it('offers other trusted workspaces’ sessions in the picker, tagged by workspace', async () => {
    connectionState.capabilities = MULTI_WORKSPACE_CAPS;
    otherWorkspaceSessions['/wsB'] = [
      { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
    ];
    render({ sessionIds: ['s1'] });
    await flushAsync(); // let the other-workspace fan-out resolve
    openPicker();
    await flushAsync(); // opening the picker re-fires reload()/reloadOther()
    const options = pickerOptions();
    // Primary sessions are still listed…
    expect(options.some((o) => o.includes('Two'))).toBe(true);
    // …plus the non-primary session, tagged with its workspace basename.
    expect(options.some((o) => o.includes('Beta') && o.includes('wsB'))).toBe(
      true,
    );
    // Primary-workspace sessions show their own basename too, not a "Primary"
    // tag — the redundant label was removed from the picker.
    expect(options.some((o) => o.includes('Primary'))).toBe(false);
  });

  it('attaches an added other-workspace pane under its own workspace cwd', async () => {
    connectionState.capabilities = MULTI_WORKSPACE_CAPS;
    otherWorkspaceSessions['/wsB'] = [
      { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
    ];
    // Uncontrolled (no `sessionIds`) so the picker mounts panes locally; the
    // seed is the current session s3.
    render();
    await flushAsync();
    openPicker();
    await flushAsync(); // opening the picker re-fires reload()/reloadOther()
    const betaButton = Array.from(
      container!.querySelectorAll('[role="option"] button'),
    ).find((el) =>
      (el.textContent ?? '').includes('Beta'),
    ) as HTMLButtonElement;
    act(() =>
      betaButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const providerFor = (id: string) =>
      Array.from(container!.querySelectorAll('[data-session]')).find(
        (el) => el.getAttribute('data-session') === id,
      );
    // The new pane binds the session's own workspace, so the daemon routes the
    // attach to /wsB instead of 409ing it against the primary cwd.
    expect(providerFor('b1')?.getAttribute('data-workspace')).toBe('/wsB');
    // The primary seed pane still binds the primary cwd.
    expect(providerFor('s3')?.getAttribute('data-workspace')).toBe('/w');
    // The pane also receives its workspace as a prop (for the composer chip),
    // not just through the provider — so dropping that pass-through fails here.
    expect(
      providerFor('b1')
        ?.querySelector('[data-testid="chat-pane"]')
        ?.getAttribute('data-pane-workspace'),
    ).toBe('/wsB');
  });

  it('loads and attaches only the locked secondary workspace', async () => {
    connectionState.capabilities = MULTI_WORKSPACE_CAPS;
    otherWorkspaceSessions['/wsB'] = [
      { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
    ];

    render({
      sessionIds: ['b1'],
      includeOtherWorkspaces: false,
      workspaceCwd: '/wsB',
    });
    await flushAsync();

    expect(titles()).toEqual(['Beta']);
    expect(
      container!
        .querySelector('[data-session="b1"]')
        ?.getAttribute('data-workspace'),
    ).toBe('/wsB');
    openPicker();
    expect(pickerOptions().some((option) => option.includes('One'))).toBe(
      false,
    );
  });

  it('remounts a deep-linked pane under its workspace once the session list resolves', async () => {
    connectionState.capabilities = MULTI_WORKSPACE_CAPS;
    otherWorkspaceSessions['/wsB'] = [
      { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
    ];
    // Deep-link straight to an other-workspace session (b1) — the pane mounts
    // before the other-workspace fan-out has resolved, so its workspace is not
    // yet known.
    render({ sessionIds: ['b1'] });
    const workspaceOf = () =>
      container!
        .querySelector('[data-session="b1"]')
        ?.getAttribute('data-workspace');
    // Before the fan-out resolves the pane can't be pinned to a workspace.
    expect(workspaceOf()).toBeNull();

    await flushAsync();

    // Once `workspaceCwdById` populates, the pane key flips from `b1:` to
    // `b1:/wsB`, so the pane remounts bound to /wsB (never left on the primary
    // cwd, which would 409 the attach).
    expect(workspaceOf()).toBe('/wsB');
  });

  it('never fans out to other workspaces on a single-workspace daemon', async () => {
    // Default capabilities carry no `workspaces`, so the other-workspace hook
    // must not touch the daemon and the picker stays untagged.
    render({ sessionIds: ['s1'] });
    await flushAsync();
    expect(workspaceClient.listWorkspaceSessions).not.toHaveBeenCalled();
    openPicker();
    expect(pickerOptions()).toEqual(['Two', 'Three', 'Four']);
  });

  it('does not pin a workspace on panes for a single-workspace daemon', () => {
    // The pane provider must get no `workspaceCwd` prop (it falls back to the
    // provider's primary cwd) so a deep-linked pane never re-attaches when the
    // session list resolves — today's behavior, unchanged.
    render({ sessionIds: ['s1'] });
    const provider = container!.querySelector('[data-session="s1"]');
    expect(provider?.getAttribute('data-workspace')).toBeNull();
  });

  it('re-queries other workspaces when the picker opens', async () => {
    connectionState.capabilities = MULTI_WORKSPACE_CAPS;
    otherWorkspaceSessions['/wsB'] = [
      { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
    ];
    render({ sessionIds: ['s1'] });
    await flushAsync();
    const before = workspaceClient.listWorkspaceSessions.mock.calls.length;
    openPicker();
    await flushAsync();
    // Opening the picker reloads the other-workspace list so it never offers a
    // stale set (mirrors the primary `reload()` on picker open).
    expect(
      workspaceClient.listWorkspaceSessions.mock.calls.length,
    ).toBeGreaterThan(before);
  });
});
