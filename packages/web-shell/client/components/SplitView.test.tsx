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
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { MAX_SPLIT_PANES } from '../utils/splitUrl';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
let connectionState: any;
let sessionsState: any[];
// Sessions per secondary workspace cwd, keyed by cwd — drives the
// workspace-locked branch of the mocked `useScopedSessions`.
let otherWorkspaceSessions: Record<string, any[]>;
// Stable client object (assigned once per test) so the prune effect, which
// depends on its identity, doesn't re-fire on every render.
let workspaceClient: {
  getStandaloneSession: ReturnType<typeof vi.fn>;
};
// Stable across renders (assigned once per test) so SplitView's reload effects,
// which depend on `reload`'s identity, don't re-fire on every render.
let reloadMock: ReturnType<typeof vi.fn>;
let waitingSessions: Set<string>;
// Session ids whose pane provider is parked on the terminal session_archived
// answer (409) — drives the mocked `useSession` per pane.
let terminalArchived: Set<string>;
const scrollPaneIntoView = vi.fn();
const confirmApproval = vi.fn();
const PaneSessionContext = React.createContext<string | undefined>(undefined);

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DaemonSessionProvider: (props: any) => (
    <PaneSessionContext.Provider value={props.sessionId}>
      <div
        data-session={props.sessionId}
        data-clientid={props.clientId}
        data-workspace={props.workspaceCwd}
        data-restart-sse={props.restartEventStreamOnPrompt ? 'true' : 'false'}
      >
        {props.children}
      </div>
    </PaneSessionContext.Provider>
  ),
  useConnection: () => connectionState,
  // `client` is a stable object; `capabilities` mirrors the connection so a test
  // that sets `capabilities.workspaces` drives both the picker labels and the
  // other-workspace fan-out from one place.
  useWorkspace: () => ({
    client: workspaceClient,
    capabilities: connectionState.capabilities,
    workspaceCwd: connectionState.workspaceCwd,
  }),
  // Per-pane connection state (each pane's DaemonSessionProvider). A test can
  // park a pane on the daemon's terminal session_archived answer (409): add
  // the id to `terminalArchived` and re-render. The parked shape is the one
  // the real provider emits (pinned in DaemonSessionProvider.test.tsx).
  useSession: () => {
    const sessionId = React.useContext(PaneSessionContext);
    const archived = sessionId !== undefined && terminalArchived.has(sessionId);
    return {
      connection: archived
        ? {
            status: 'disconnected',
            sessionId: undefined,
            error: `Session "${sessionId}" is archived. Unarchive it before loading.`,
            errorStatus: 409,
            sessionArchived: true,
          }
        : { status: 'connected', sessionId, error: undefined },
    };
  },
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

// Catalog-store push simulator: once the primary list has settled, a test can
// push an updated page (the daemon invalidation after an archive/delete) and
// every mounted hook re-renders with it.
let pushSettledPrimarySessions: ((next: any[]) => void) | undefined;
// Page-completeness markers the settle page reports. The mock returns these
// straight through (undefined by default = a complete page), so a test can
// mark the settled page truncated / cursor-pending / merge-degraded and prove
// the prune guard waits for a complete page.
let primaryPageMeta: {
  truncated?: boolean;
  nextCursor?: string;
  liveMergeFailed?: boolean;
  stale?: boolean;
  error?: unknown;
} = {};

vi.mock('../hooks/useScopedSessions', () => ({
  useScopedSessions: (workspaceCwd: string | undefined) => {
    const [settled, setSettled] = React.useState(false);
    const [sessions, setSessions] = React.useState<any[]>(() =>
      workspaceCwd ? [] : sessionsState,
    );
    React.useEffect(() => {
      // Mirror the catalog store: the page (and thus `data`) exists only once
      // the first fetch has settled — that is the readiness signal the prune
      // effect waits for.
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (cancelled) return;
        if (workspaceCwd) {
          setSessions([...(otherWorkspaceSessions[workspaceCwd] ?? [])]);
        }
        setSettled(true);
        if (!workspaceCwd) {
          pushSettledPrimarySessions = (next: any[]) => {
            sessionsState = next;
            setSessions([...next]);
          };
        }
      });
      return () => {
        cancelled = true;
      };
    }, [workspaceCwd]);
    const reload = React.useCallback(async () => {
      reloadMock();
      const next = workspaceCwd
        ? (otherWorkspaceSessions[workspaceCwd] ?? [])
        : sessionsState;
      setSessions([...next]);
      return next;
    }, [workspaceCwd]);
    return {
      sessions,
      reload,
      data: settled ? sessions : undefined,
      // Completeness markers (undefined by default = a complete page).
      nextCursor: primaryPageMeta.nextCursor,
      liveMergeFailed: primaryPageMeta.liveMergeFailed,
      truncated: primaryPageMeta.truncated,
      // A page retained after a failed refresh is not a fresh answer.
      stale: primaryPageMeta.stale,
      error: primaryPageMeta.error,
    };
  },
}));

// The other-workspace fan-out, mocked as a stateful seam: SplitView-level
// cases drive what the fan-out reports (queried / not-ready cwds) instead of
// the real catalog store — which page state makes a cwd not-ready is pinned
// in the hook's own suite against the real store.
let otherWorkspaceState: {
  sessions: Record<string, any[]>;
  loading: boolean;
  queriedCwds: string[];
  notReadyCwds: string[];
} = {
  sessions: {},
  loading: false,
  queriedCwds: [],
  notReadyCwds: [],
};
let forceOtherWorkspace: (() => void) | undefined;
let reloadOtherMock: ReturnType<typeof vi.fn>;

vi.mock('../hooks/useOtherWorkspaceSessions', () => ({
  useOtherWorkspaceSessions: (enabled = true) => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    forceOtherWorkspace = force;
    const reload = React.useCallback(async () => {
      reloadOtherMock();
    }, []);
    // Stable while the test leaves `sessions` alone, like the real hook's
    // memoized list; replacing it (setOtherWorkspace) yields a new identity.
    const sessions = React.useMemo(
      () => (enabled ? Object.values(otherWorkspaceState.sessions).flat() : []),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- module test state: replacing `sessions` is the change signal
      [enabled, otherWorkspaceState.sessions],
    );
    if (!enabled) {
      // A disabled fan-out certifies nothing about the other workspaces.
      return {
        sessions,
        loading: false,
        queriedCwds: [],
        notReadyCwds: [],
        reload,
      };
    }
    return {
      sessions,
      loading: otherWorkspaceState.loading,
      queriedCwds: otherWorkspaceState.queriedCwds,
      notReadyCwds: otherWorkspaceState.notReadyCwds,
      reload,
    };
  },
}));

function setOtherWorkspace(partial: Partial<typeof otherWorkspaceState>): void {
  Object.assign(otherWorkspaceState, partial);
  act(() => forceOtherWorkspace?.());
}

vi.mock('./ChatPane', () => ({
  ChatPane: (props: any) => {
    const sessionId = React.useContext(PaneSessionContext);
    const pending = !!sessionId && waitingSessions.has(sessionId);
    const { onApprovalChange } = props;
    React.useEffect(() => {
      if (!sessionId) return;
      onApprovalChange?.(sessionId, pending);
      return () => onApprovalChange?.(sessionId, false);
    }, [sessionId, pending, onApprovalChange]);
    // Let a test force a render crash to exercise the per-pane ErrorBoundary.
    if (props.title === 'BOOM') throw new Error('pane exploded');
    return (
      <div
        data-testid="chat-pane"
        data-plan-visible={String(props.planControlVisible)}
        data-model-management={JSON.stringify(props.modelManagement)}
        data-pane-workspace={props.workspaceCwd}
        data-session-details={props.sessionSummary?.sessionId}
        data-maximized={props.isMaximized ? 'true' : 'false'}
        data-pane-active={props.isActive ? '' : undefined}
        data-slash-handler={props.onSlashCommand ? 'true' : 'false'}
        data-context-controls={
          props.registerContextUsageControls ? 'true' : 'false'
        }
        data-open-context-usage={props.onOpenContextUsage ? 'true' : 'false'}
        data-before-context-compress={
          props.onBeforeContextCompress ? 'true' : 'false'
        }
        data-hidden={props.hidden ? 'true' : 'false'}
        data-report-catalog-turn-completion={
          props.reportCatalogTurnCompletion ? 'true' : 'false'
        }
        data-voice-user-revision={String(props.voiceUserRevision ?? 0)}
        data-voice-workspace-count={String(props.voiceWorkspaces?.length ?? 0)}
      >
        <span data-testid="pane-title">{props.title}</span>
        <input aria-label={`Draft ${props.title}`} />
        {pending && (
          <div data-testid="pane-approval">
            <button tabIndex={0} onClick={confirmApproval}>
              Approve
            </button>
          </div>
        )}
        {props.renderHeaderActions && (
          <span data-testid="pane-header-slot">
            {props.renderHeaderActions({
              sessionId: 'from-props',
              workspaceCwd: props.workspaceCwd,
            })}
          </span>
        )}
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
  waitingSessions = new Set();
  confirmApproval.mockClear();
  scrollPaneIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollPaneIntoView;
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
  otherWorkspaceState = {
    sessions: {},
    loading: false,
    queriedCwds: [],
    notReadyCwds: [],
  };
  terminalArchived = new Set();
  primaryPageMeta = {};
  workspaceClient = {
    // A workspace session id is not a standalone session: the prune probe
    // gets a not-found and the pane is pruned (override per test otherwise).
    getStandaloneSession: vi.fn(async () => {
      throw new DaemonHttpError(
        404,
        {
          error: 'standalone session not found',
          code: 'standalone_session_not_found',
        },
        'standalone session not found',
      );
    }),
  };
  pushSettledPrimarySessions = undefined;
  reloadMock = vi.fn();
  reloadOtherMock = vi.fn();
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

// Push an updated settled primary list (the daemon catalog invalidation after
// an archive/delete) and let the reconcile effect react to it.
async function pushCatalog(next: any[]): Promise<void> {
  await act(async () => {
    pushSettledPrimarySessions?.(next);
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

function rerender(props: Record<string, unknown> = {}): void {
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
function sessionDetails(): string[] {
  return Array.from(
    container!.querySelectorAll('[data-testid="chat-pane"]'),
  ).map((el) => el.getAttribute('data-session-details') ?? '(none)');
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
  it('forwards model management policy to every pane', () => {
    const modelManagement = { allowAdd: false, allowDelete: true };
    render({ sessionIds: ['s1', 's2'], modelManagement });
    const panes = container!.querySelectorAll('[data-testid="chat-pane"]');
    expect(panes).toHaveLength(2);
    for (const pane of panes) {
      expect(pane.getAttribute('data-model-management')).toBe(
        JSON.stringify(modelManagement),
      );
    }
  });

  it('keeps a newly added controlled pane active without relying on composer autofocus', () => {
    function ControlledSplit() {
      const [ids, setIds] = React.useState(['s1', 's2']);
      return (
        <SplitView sessionIds={ids} onPanesChange={setIds} onExit={() => {}} />
      );
    }
    render();
    act(() =>
      root!.render(
        <I18nProvider language="en">
          <ControlledSplit />
        </I18nProvider>,
      ),
    );
    openPicker();
    const third = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('[role="option"] button'),
    ).find((button) => button.textContent === 'Three')!;
    act(() => third.click());
    expect(titles()).toEqual(['One', 'Two', 'Three']);
    expect(panes()[2].hasAttribute('data-pane-active')).toBe(true);
  });

  it('tracks pointer and keyboard activity without activating a hovered pane', () => {
    render({ sessionIds: ['s1', 's2'] });
    expect(panes()[0].hasAttribute('data-pane-active')).toBe(true);
    act(() =>
      panes()[1].dispatchEvent(new Event('pointerover', { bubbles: true })),
    );
    expect(panes()[0].hasAttribute('data-pane-active')).toBe(true);
    act(() =>
      panes()[1].dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    expect(panes()[1].hasAttribute('data-pane-active')).toBe(true);
    act(() => panes()[0].querySelector('input')!.focus());
    expect(panes()[0].hasAttribute('data-pane-active')).toBe(true);
    expect(panes()[1].hasAttribute('data-pane-active')).toBe(false);
  });

  it('cycles hidden pending panes, focuses outside approvals and preserves drafts without confirming', () => {
    waitingSessions = new Set(['s2', 's3']);
    render({ sessionIds: ['s1', 's2', 's3'] });
    const draft = panes()[0].querySelector('input')!;
    draft.value = 'keep this draft';
    act(() =>
      panes()[0]
        .querySelector<HTMLButtonElement>('[data-testid="pane-maximize"]')!
        .click(),
    );
    const pendingButton = container!.querySelector<HTMLButtonElement>(
      '[title="Go to the next session awaiting input"]',
    )!;
    expect(pendingButton.textContent).toBe('2 awaiting input');
    expect(pendingButton.getAttribute('aria-label')).toBe(
      '2 awaiting input — Go to the next session awaiting input',
    );
    expect(pendingButton.getAttribute('aria-label')).toContain(
      pendingButton.textContent,
    );
    expect(container!.querySelector('[role="status"]')?.textContent).toBe(
      '2 awaiting input',
    );
    act(() => pendingButton.click());
    expect(panes()[1].getAttribute('data-maximized')).toBe('true');
    expect(document.activeElement).toBe(
      panes()[1].closest('[data-pane-session-id]'),
    );
    act(() => pendingButton.click());
    expect(panes()[2].getAttribute('data-maximized')).toBe('true');
    expect(document.activeElement).toBe(
      panes()[2].closest('[data-pane-session-id]'),
    );
    expect(confirmApproval).not.toHaveBeenCalled();
    expect(scrollPaneIntoView).toHaveBeenCalledTimes(2);
    expect(panes()[0].querySelector('input')).toBe(draft);
    expect(draft.value).toBe('keep this draft');
  });

  it.each([false, true])(
    'continues forward from an idle middle pane (maximized: %s)',
    (maximized) => {
      waitingSessions = new Set(['s1', 's3']);
      render({ sessionIds: ['s1', 's2', 's3'] });
      act(() => panes()[1].querySelector('input')!.focus());
      if (maximized) {
        act(() =>
          panes()[1]
            .querySelector<HTMLButtonElement>('[data-testid="pane-maximize"]')!
            .click(),
        );
      }
      const pending = container!.querySelector<HTMLButtonElement>(
        '[title="Go to the next session awaiting input"]',
      )!;
      for (const index of [2, 0]) {
        act(() => pending.click());
        expect(panes()[index].hasAttribute('data-pane-active')).toBe(true);
        expect(document.activeElement).toBe(
          panes()[index].closest('[data-pane-session-id]'),
        );
        expect(panes()[index].getAttribute('data-maximized')).toBe(
          String(maximized),
        );
      }
      expect(confirmApproval).not.toHaveBeenCalled();
    },
  );

  it('reports pending panes while hidden and clears the report on unmount', () => {
    waitingSessions = new Set(['s1']);
    const onPendingPanesChange = vi.fn();
    render({ sessionIds: ['s1', 's2'], onPendingPanesChange });
    act(() =>
      panes()[1]
        .querySelector<HTMLButtonElement>('[data-testid="pane-maximize"]')!
        .click(),
    );
    expect(panes()[0].getAttribute('data-hidden')).toBe('true');
    expect(onPendingPanesChange).toHaveBeenLastCalledWith(['s1']);
    act(() => root!.unmount());
    root = null;
    expect(onPendingPanesChange).toHaveBeenLastCalledWith([]);
  });

  it('reports changed pending panes without clearing the still-pending panes', () => {
    waitingSessions = new Set(['s1']);
    const onPendingPanesChange = vi.fn();
    const sessionIds = ['s1', 's2'];
    render({ sessionIds, onPendingPanesChange });
    expect(onPendingPanesChange).toHaveBeenLastCalledWith(['s1']);
    onPendingPanesChange.mockClear();
    waitingSessions = new Set(['s1', 's2']);
    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView
            sessionIds={sessionIds}
            onExit={() => {}}
            onPendingPanesChange={onPendingPanesChange}
          />
        </I18nProvider>,
      ),
    );
    expect(onPendingPanesChange).toHaveBeenCalledExactlyOnceWith(['s1', 's2']);
  });

  it('clears the old report callback before sending pending panes to its replacement', () => {
    waitingSessions = new Set(['s1']);
    const oldReport = vi.fn();
    render({ sessionIds: ['s1', 's2'], onPendingPanesChange: oldReport });
    expect(oldReport).toHaveBeenLastCalledWith(['s1']);
    oldReport.mockClear();
    const nextReport = vi.fn(() => {
      expect(oldReport).toHaveBeenCalledExactlyOnceWith([]);
    });
    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView
            sessionIds={['s1', 's2']}
            onExit={() => {}}
            onPendingPanesChange={nextReport}
          />
        </I18nProvider>,
      ),
    );
    expect(nextReport).toHaveBeenCalledExactlyOnceWith(['s1']);
    act(() => root!.unmount());
    root = null;
    expect(nextReport).toHaveBeenLastCalledWith([]);
  });

  it('keeps pending reports stable when their parent stores them in state', () => {
    const onReport = vi.fn();
    const sessionIds = ['s1', 's2'];
    function Parent() {
      const [reportedIds, setReportedIds] = React.useState<string[]>([]);
      const handleReport = React.useCallback((ids: string[]) => {
        onReport(ids);
        // Bound a broken render/effect loop so the regression fails promptly.
        if (onReport.mock.calls.length > 10) {
          throw new Error('Pending reports did not settle');
        }
        setReportedIds(ids);
      }, []);
      return (
        <I18nProvider language="en">
          <output>{reportedIds.length}</output>
          <SplitView
            sessionIds={sessionIds}
            onExit={() => {}}
            onPendingPanesChange={handleReport}
          />
        </I18nProvider>
      );
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<Parent />));
    expect(onReport).toHaveBeenCalledExactlyOnceWith([]);
    act(() => root!.render(<Parent />));
    expect(onReport).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('stops reporting a crashed pane even though its slot remains', async () => {
    waitingSessions = new Set(['s1']);
    const onPendingPanesChange = vi.fn();
    render({ sessionIds: ['s1', 's2'], onPendingPanesChange });
    expect(onPendingPanesChange).toHaveBeenLastCalledWith(['s1']);
    sessionsState = sessionsState.map((session) =>
      session.sessionId === 's1'
        ? { ...session, displayName: 'BOOM' }
        : session,
    );
    openPicker();
    await flushAsync();
    expect(container!.textContent).toContain('This session pane hit an error');
    expect(
      container!.querySelector('[data-pane-session-id="s1"]'),
    ).not.toBeNull();
    expect(onPendingPanesChange).toHaveBeenLastCalledWith([]);
  });

  it('keeps selection and focus on a neighbour when a controlled pane is removed', () => {
    waitingSessions = new Set(['s3']);
    render({ sessionIds: ['s1', 's2', 's3'] });
    act(() => panes()[2].querySelector('input')!.focus());
    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SplitView sessionIds={['s1', 's2']} onExit={() => {}} />
        </I18nProvider>,
      ),
    );
    expect(panes()).toHaveLength(2);
    expect(panes()[0].hasAttribute('data-pane-active')).toBe(false);
    expect(panes()[1].hasAttribute('data-pane-active')).toBe(true);
    expect(document.activeElement).toBe(
      panes()[1].closest('[data-pane-session-id]'),
    );
    expect(container!.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('omits title details when the host disables them', () => {
    waitingSessions = new Set(['s1']);
    const onPendingPanesChange = vi.fn();
    render({
      sessionIds: ['s1', 's2'],
      showSessionDetails: false,
      onPendingPanesChange,
    });
    expect(titles()).toEqual(['One', 'Two']);
    expect(
      panes().some((pane) => pane.hasAttribute('data-session-details')),
    ).toBe(false);
    expect(
      container!.querySelector(
        '[title="Go to the next session awaiting input"]',
      )?.textContent,
    ).toBe('1 awaiting input');
    expect(container!.querySelector('[role="status"]')?.textContent).toBe(
      '1 awaiting input',
    );
    expect(onPendingPanesChange).toHaveBeenLastCalledWith(['s1']);
  });

  it('renders one pane per initial session, each under its own provider', () => {
    render({
      sessionIds: ['s1', 's2'],
      registerContextUsageControls: vi.fn(),
      onBeforeContextCompress: vi.fn(),
      onOpenContextUsage: vi.fn(),
    });
    expect(panes()).toHaveLength(2);
    for (const pane of panes()) {
      expect(pane.getAttribute('data-context-controls')).toBe('true');
      expect(pane.getAttribute('data-open-context-usage')).toBe('true');
      expect(pane.getAttribute('data-before-context-compress')).toBe('true');
    }
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

  it('leaves the outer session as the sole catalog turn-completion owner', () => {
    render({ sessionIds: ['s3', 's1'] });

    expect(
      panes()[0]?.getAttribute('data-report-catalog-turn-completion'),
    ).toBe('false');
    expect(
      panes()[1]?.getAttribute('data-report-catalog-turn-completion'),
    ).toBe('true');
  });

  it('reports completion for the same session id in another workspace', async () => {
    otherWorkspaceSessions['/wsB'] = [
      { sessionId: 's3', workspaceCwd: '/wsB', displayName: 'Other Three' },
    ];

    render({ sessionIds: ['s3'], workspaceCwd: '/wsB' });
    await flushAsync();

    expect(
      panes()[0]?.getAttribute('data-report-catalog-turn-completion'),
    ).toBe('true');
  });

  it('passes the prompt SSE restart option to pane providers', () => {
    render({ sessionIds: ['s1'], restartSseOnPrompt: true });
    expect(
      container!
        .querySelector('[data-session="s1"]')
        ?.getAttribute('data-restart-sse'),
    ).toBe('true');
  });

  it('passes the host slash command handler to every pane', () => {
    render({
      sessionIds: ['s1', 's2'],
      onSlashCommand: vi.fn(),
    });

    expect(
      panes().every(
        (pane) => pane.getAttribute('data-slash-handler') === 'true',
      ),
    ).toBe(true);
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
    // At the cap there is no room left, so the entry point is disabled.
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
  });

  it('keeps the add button enabled one below MAX_PANES', () => {
    sessionsState = Array.from({ length: MAX_SPLIT_PANES + 2 }, (_, i) => ({
      sessionId: `x${i}`,
      workspaceCwd: '/w',
      displayName: `Pane ${i}`,
    }));
    // One slot spare and a session left to add, so the entry point must work.
    render({
      sessionIds: sessionsState
        .slice(0, MAX_SPLIT_PANES - 1)
        .map((session) => session.sessionId),
    });
    expect(panes()).toHaveLength(MAX_SPLIT_PANES - 1);
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
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
    expect(container!.querySelectorAll('[data-hidden="true"]')).toHaveLength(2);
    // The maximized pane reflects its state down to ChatPane.
    const maximized = container!.querySelector('[data-maximized="true"]');
    expect(
      maximized?.querySelector('[data-testid="pane-title"]')?.textContent,
    ).toBe('One');
  });

  it('forwards Voice revision state to every pane', () => {
    render({
      sessionIds: ['s1', 's2'],
      voiceUserRevision: 4,
      voiceWorkspaceRevisions: { workspace: 7 },
    });

    expect(
      container!.querySelectorAll('[data-voice-user-revision="4"]'),
    ).toHaveLength(2);
  });

  it('forwards the merged Voice workspace list to every pane', () => {
    render({
      sessionIds: ['s1', 's2'],
      voiceWorkspaces: [
        { id: 'primary', cwd: '/w', primary: true },
        { id: 'secondary', cwd: '/other', primary: false, trusted: true },
      ],
    });

    expect(
      container!.querySelectorAll('[data-voice-workspace-count="2"]'),
    ).toHaveLength(2);
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

  it('keeps the add button enabled when the catalog has no other sessions', () => {
    sessionsState = [
      { sessionId: 's3', workspaceCwd: '/w', displayName: 'Three' },
    ];
    render({ sessionIds: ['s3'] });
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    // The cached catalog is not authoritative: another session may exist
    // elsewhere, so an empty list must not disable the entry point.
    expect(addButton.disabled).toBe(false);
    openPicker();
    expect(pickerOptions()).toEqual([]);
    expect(container!.querySelector('[role="listbox"]')?.textContent).toContain(
      'No other sessions',
    );
  });

  it('picks up a session created elsewhere after opening the empty picker', () => {
    sessionsState = [
      { sessionId: 's3', workspaceCwd: '/w', displayName: 'Three' },
    ];
    render({ sessionIds: ['s3'] });
    openPicker();
    expect(pickerOptions()).toEqual([]);
    // A session is created elsewhere while the picker was open.
    sessionsState = [
      ...sessionsState,
      { sessionId: 's6', workspaceCwd: '/w', displayName: 'Six' },
    ];
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    openPicker();
    expect(pickerOptions()).toEqual(['Six']);
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
    // The empty row is `role="presentation"`, so only a text read sees it: a
    // populated picker must not keep advertising "No other sessions".
    expect(
      container!.querySelector('[role="listbox"]')?.textContent,
    ).not.toContain('No other sessions');
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
      {
        id: 'w1',
        cwd: '/wsB',
        displayName: 'Payments API',
        primary: false,
        trusted: true,
      },
    ],
  };

  it('offers other trusted workspaces’ sessions in the picker, tagged by workspace', async () => {
    connectionState.capabilities = MULTI_WORKSPACE_CAPS;
    setOtherWorkspace({
      sessions: {
        '/wsB': [
          { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
        ],
      },
      queriedCwds: ['/wsB'],
      notReadyCwds: [],
    });
    render({ sessionIds: ['s1'] });
    await flushAsync(); // let the other-workspace fan-out resolve
    openPicker();
    await flushAsync(); // opening the picker re-fires reload()/reloadOther()
    const options = pickerOptions();
    // Primary sessions are still listed…
    expect(options.some((o) => o.includes('Two'))).toBe(true);
    // …plus the non-primary session, tagged with its workspace display name.
    expect(
      options.some((o) => o.includes('Beta') && o.includes('Payments API')),
    ).toBe(true);
    // Primary-workspace sessions show their own basename too, not a "Primary"
    // tag — the redundant label was removed from the picker.
    expect(options.some((o) => o.includes('Primary'))).toBe(false);
  });

  it('attaches an added other-workspace pane under its own workspace cwd', async () => {
    connectionState.capabilities = MULTI_WORKSPACE_CAPS;
    setOtherWorkspace({
      sessions: {
        '/wsB': [
          { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
        ],
      },
      queriedCwds: ['/wsB'],
      notReadyCwds: [],
    });
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

    setOtherWorkspace({
      sessions: {
        '/wsB': [
          { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
        ],
      },
      queriedCwds: ['/wsB'],
      notReadyCwds: [],
    });
    await flushAsync();

    // Once `workspaceCwdById` populates, the pane key flips from `b1:` to
    // `b1:/wsB`, so the pane remounts bound to /wsB (never left on the primary
    // cwd, which would 409 the attach).
    expect(workspaceOf()).toBe('/wsB');
  });

  it('keeps the picker untagged on a single-workspace daemon', async () => {
    // Default capabilities carry no `workspaces`, so the picker stays
    // untagged. That the fan-out never queries the daemon then is pinned in
    // the hook's own suite.
    render({ sessionIds: ['s1'] });
    await flushAsync();
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
    setOtherWorkspace({
      sessions: {
        '/wsB': [
          { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
        ],
      },
      queriedCwds: ['/wsB'],
      notReadyCwds: [],
    });
    render({ sessionIds: ['s1'] });
    await flushAsync();
    openPicker();
    await flushAsync();
    // Opening the picker reloads the other-workspace list so it never offers a
    // stale set (mirrors the primary `reload()` on picker open).
    expect(reloadOtherMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false, true])(
    'passes explicit Plan visibility to every pane: %s',
    (planControlVisible) => {
      render({ sessionIds: ['s1', 's2'], planControlVisible });
      const panes = container!.querySelectorAll('[data-testid="chat-pane"]');
      expect(panes).toHaveLength(2);
      for (const pane of panes) {
        expect(pane.getAttribute('data-plan-visible')).toBe(
          String(planControlVisible ?? false),
        );
      }
    },
  );

  it('passes renderPaneHeaderActions through to each ChatPane', () => {
    render({
      sessionIds: ['s1', 's2'],
      renderPaneHeaderActions: (info: {
        sessionId: string;
        workspaceCwd?: string;
      }) => (
        <button type="button" data-testid={`host-${info.sessionId}`}>
          host
        </button>
      ),
    });
    expect(
      container!.querySelectorAll('[data-testid="pane-header-slot"]'),
    ).toHaveLength(2);
    // The mock ChatPane invokes the renderer with a stand-in session id; the
    // important contract is that SplitView forwards the prop at all.
    expect(
      container!.querySelectorAll('[data-testid="host-from-props"]'),
    ).toHaveLength(2);
  });

  describe('prunes panes whose session left the active catalog', () => {
    it('prunes the archived pane and keeps the rest (uncontrolled)', async () => {
      render(); // seeds the current session (s3)
      await flushAsync();
      openPicker();
      const option = Array.from(
        container!.querySelectorAll<HTMLButtonElement>(
          '[role="option"] button',
        ),
      ).find((button) => button.textContent === 'One')!;
      act(() => option.click());
      expect(titles()).toEqual(['Three', 'One']);
      // The daemon archives session s1 (a non-current pane): the catalog
      // invalidation drops it from the settled active list. The current
      // session (s3) is exempt from pruning — archiving it keeps its pane
      // (showing the terminal error the provider reports) rather than closing
      // the pane the user is looking at.
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's1'));
      expect(titles()).toEqual(['Three']);
    });

    it('reports the pruned pane set to the parent (controlled)', async () => {
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2'], onPanesChange });
      await flushAsync();
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's2'));
      expect(onPanesChange).toHaveBeenLastCalledWith(['s1']);
    });

    it('exits the split when the last pane leaves the active catalog', async () => {
      // The seed pane is the current session, which is exempt from pruning —
      // close it first, leaving a non-current pane as the last one.
      const onExit = vi.fn();
      render({ onExit });
      await flushAsync();
      openPicker();
      const option = Array.from(
        container!.querySelectorAll<HTMLButtonElement>(
          '[role="option"] button',
        ),
      ).find((button) => button.textContent === 'One')!;
      act(() => option.click());
      // Close the seed (current) pane: one pane remains, so no exit yet.
      act(() => {
        const close = container!.querySelector('[data-testid="pane-close"]');
        close!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(titles()).toEqual(['One']);
      expect(onExit).not.toHaveBeenCalled();
      // The last remaining pane is a non-current session: archiving it prunes
      // it and the split exits to the session overview.
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's1'));
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('waits for the active list to settle before pruning', async () => {
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s9'], onPanesChange });
      // Before the first settled page an unknown id must not be pruned.
      expect(onPanesChange).not.toHaveBeenCalled();
      await flushAsync();
      expect(onPanesChange).toHaveBeenLastCalledWith([]);
    });

    it('keeps a pane whose session is listed by another workspace', async () => {
      connectionState.capabilities = MULTI_WORKSPACE_CAPS;
      setOtherWorkspace({
        sessions: {
          '/wsB': [
            { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
          ],
        },
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      render({ sessionIds: ['s1', 'b1'] });
      await flushAsync();
      expect(titles()).toEqual(['One', 'Beta']);
      expect(panes()).toHaveLength(2);
    });

    it('does not prune a pane while other-workspace lists are still loading', async () => {
      connectionState.capabilities = MULTI_WORKSPACE_CAPS;
      const onPanesChange = vi.fn();
      // b1 is not in the primary list: while the /wsB page is still in flight
      // the pane must not be pruned on that gap alone.
      setOtherWorkspace({
        sessions: {},
        loading: true,
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      render({ sessionIds: ['s1', 'b1'], onPanesChange });
      await flushAsync();
      expect(onPanesChange).not.toHaveBeenCalled();
      setOtherWorkspace({
        sessions: {
          '/wsB': [
            { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
          ],
        },
        loading: false,
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      await flushAsync();
      // Settled and present: still nothing to prune.
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(titles()).toEqual(['One', 'Beta']);
    });

    it('prunes a pane whose other-workspace session left that list', async () => {
      connectionState.capabilities = MULTI_WORKSPACE_CAPS;
      const onPanesChange = vi.fn();
      setOtherWorkspace({
        sessions: {
          '/wsB': [
            { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
          ],
        },
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      render({ sessionIds: ['s1', 'b1'], onPanesChange });
      await flushAsync();
      // b1 vanishes from the /wsB list (archived there): the page settled
      // complete, so its workspace can prove absence — prune.
      setOtherWorkspace({
        sessions: { '/wsB': [] },
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      await flushAsync();
      expect(onPanesChange).toHaveBeenLastCalledWith(['s1']);
    });

    it('keeps a pane the standalone probe confirms alive', async () => {
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      workspaceClient.getStandaloneSession.mockResolvedValue({
        sessionId: 'st1',
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledWith('st1');
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(1);
    });

    it('prunes a pane whose standalone probe answers not-found', async () => {
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      // The default probe mock answers 404 standalone_session_not_found.
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(onPanesChange).toHaveBeenLastCalledWith([]);
    });

    it('joins an in-flight probe when another commit lands mid-probe', async () => {
      // A commit landing while the probe is still in flight must join the
      // running request, not fire a duplicate.
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      let settleProbe: (() => void) | undefined;
      const probeGate = new Promise<void>((resolve) => {
        settleProbe = resolve;
      });
      workspaceClient.getStandaloneSession = vi.fn(() => probeGate);
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(1);
      // A second catalog commit lands mid-probe.
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(1);
      act(() => settleProbe!());
      await flushAsync();
      // Resolved alive: the pane is kept and nothing was reported.
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(1);
    });

    it('keeps a pane and stops re-probing on a deterministic standalone conflict', async () => {
      // A 409 standalone_session_conflict is deterministic (the daemon knows
      // the id but refuses to serve it standalone): the pane is kept and the
      // verdict is cached, so later commits must not re-probe it.
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      workspaceClient.getStandaloneSession = vi.fn(async () => {
        throw new DaemonHttpError(
          409,
          {
            error: 'standalone session conflict',
            code: 'standalone_session_conflict',
          },
          'standalone session conflict',
        );
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(1);
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(1);
    });

    it('keeps a pane when the standalone probe fails transiently', async () => {
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      workspaceClient.getStandaloneSession.mockRejectedValue(
        new Error('network down'),
      );
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(1);
      // A transient failure records no verdict: the next commit must re-probe
      // (caching the failure as 'alive' would make the pane unprunable).
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(2);
      expect(panes()).toHaveLength(1);
    });

    // --- Page-completeness guards (R1-1): an absence from an incomplete page
    // is not proof a session is gone, so the prune must wait. Each case below
    // marks the settled page incomplete and asserts the prune does NOT fire.

    it('does not prune while the settled page is truncated (bounded)', async () => {
      primaryPageMeta = { truncated: true };
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2'], onPanesChange });
      await flushAsync();
      // s2 leaves the (bounded) page, but the page was truncated: a session can
      // simply have fallen off it. Absence is not proof of removal.
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's2'));
      expect(onPanesChange).not.toHaveBeenCalled();
    });

    it('does not prune while the settled page has a nextCursor', async () => {
      primaryPageMeta = { nextCursor: 'cursor-2' };
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2'], onPanesChange });
      await flushAsync();
      // A nextCursor means more results exist beyond this page: absence is not
      // proof of removal.
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's2'));
      expect(onPanesChange).not.toHaveBeenCalled();
    });

    it('does not prune while the settled page liveMergeFailed', async () => {
      primaryPageMeta = { liveMergeFailed: true };
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2'], onPanesChange });
      await flushAsync();
      // A merge that failed partway is missing sessions for a reason other than
      // archiving: absence is not proof of removal.
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's2'));
      expect(onPanesChange).not.toHaveBeenCalled();
    });

    it('prunes a stale primary pane while a stopped-workspace pane stays resolvable', async () => {
      // /wsB is non-primary but untrusted: the fan-out never queries it, so a
      // session there could still be a live pane — but that may only protect
      // b1's pane, not block the prune of a primary-workspace pane whose
      // absence the (complete) primary page does prove.
      connectionState.capabilities = MULTI_WORKSPACE_CAPS;
      setOtherWorkspace({
        sessions: {
          '/wsB': [
            { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
          ],
        },
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2', 'b1'], onPanesChange });
      await flushAsync();
      expect(titles()).toEqual(['One', 'Two', 'Beta']);
      // The daemon flips /wsB untrusted: the fan-out stops querying it and the
      // merged list loses b1. Its absence from our list proves nothing (we no
      // longer cover that workspace), but s2 left the complete primary page:
      // it is pruned, while b1's pane — title and session details — survives.
      connectionState.capabilities = {
        ...MULTI_WORKSPACE_CAPS,
        workspaces: [
          { id: 'w0', cwd: '/w', primary: true, trusted: true },
          { id: 'w1', cwd: '/wsB', primary: false, trusted: false },
        ],
      };
      setOtherWorkspace({ sessions: {}, queriedCwds: [], notReadyCwds: [] });
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's2'));
      expect(onPanesChange).toHaveBeenLastCalledWith(['s1', 'b1']);
      // The parent acks the prune by re-seeding the pane set without s2.
      act(() => {
        root!.render(
          <I18nProvider language="en">
            <SplitView
              sessionIds={['s1', 'b1']}
              onPanesChange={onPanesChange}
              onExit={() => {}}
            />
          </I18nProvider>,
        );
      });
      await flushAsync();
      // b1's pane — title and session details — survives from the last-seen
      // summary even though its workspace is no longer advertised.
      expect(titles()).toEqual(['One', 'Beta']);
      expect(sessionDetails()).toEqual(['s1', 'b1']);
    });

    it('keeps panes whose workspace stopped being advertised', async () => {
      // The daemon stops advertising /wsB (draining/transitioning/blocked
      // filters internal entries out of capabilities): the fan-out drops its
      // snapshot in the same update, so b1's absence from the merged list
      // proves nothing — outside the coverage, the pane is a probe candidate,
      // never a direct prune.
      connectionState.capabilities = MULTI_WORKSPACE_CAPS;
      setOtherWorkspace({
        sessions: {
          '/wsB': [
            { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
          ],
        },
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 'b1'], onPanesChange });
      await flushAsync();
      connectionState.capabilities = {
        features: [],
        workspaceCwd: '/w',
        workspaces: [{ id: 'w0', cwd: '/w', primary: true, trusted: true }],
      };
      setOtherWorkspace({ sessions: {}, queriedCwds: [], notReadyCwds: [] });
      await pushCatalog(sessionsState);
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(2);
    });

    it('does not prune a fan-out pane whose cwd is not-ready', async () => {
      // Readiness is positive proof per cwd: a not-ready workspace cannot
      // prove absence. Which page states make a cwd not-ready (truncated,
      // nextCursor, liveMergeFailed, stale, errored, never landed) is pinned
      // in the hook's own suite against the real catalog store.
      connectionState.capabilities = MULTI_WORKSPACE_CAPS;
      setOtherWorkspace({
        sessions: {
          '/wsB': [
            { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
          ],
        },
        queriedCwds: ['/wsB'],
        notReadyCwds: [],
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 'b1'], onPanesChange });
      await flushAsync();
      setOtherWorkspace({
        sessions: { '/wsB': [] },
        queriedCwds: ['/wsB'],
        notReadyCwds: ['/wsB'],
      });
      await flushAsync();
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(2);
    });

    it.each([
      ['stale (mid-revalidation)', { stale: true }],
      ['errored (retained after a failed refresh)', { error: new Error('x') }],
    ])('does not prune while the settled page is %s', async (_label, meta) => {
      // A retained page is not a fresh answer from the daemon: absence from
      // it proves nothing. Stale-without-error is the common state — the
      // store marks the page stale at the start of every refresh.
      primaryPageMeta = meta;
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2'], onPanesChange });
      await flushAsync();
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's2'));
      expect(onPanesChange).not.toHaveBeenCalled();
    });

    it.each([
      ['a nextCursor', { nextCursor: 'cursor-2' }],
      ['truncated', { truncated: true }],
      ['liveMergeFailed', { liveMergeFailed: true }],
      ['stale', { stale: true }],
      ['errored', { error: new Error('refresh failed') }],
    ])(
      'prunes a terminal-archived pane while the page has %s',
      async (_label, meta) => {
        // List-based inference is off the table, but a pane whose own
        // provider parked on the daemon's terminal session_archived answer
        // (409) is an authoritative per-pane signal: prune it.
        primaryPageMeta = meta;
        const onPanesChange = vi.fn();
        render({ sessionIds: ['s1', 's2'], onPanesChange });
        await flushAsync();
        await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's2'));
        expect(onPanesChange).not.toHaveBeenCalled();
        terminalArchived.add('s2');
        rerender({ sessionIds: ['s1', 's2'], onPanesChange });
        expect(onPanesChange).toHaveBeenLastCalledWith(['s1']);
      },
    );

    it('prunes a terminal-archived pane in an uncontrolled split', async () => {
      primaryPageMeta = { nextCursor: 'cursor-2' };
      render(); // seeds the current session (s3)
      await flushAsync();
      openPicker();
      const option = Array.from(
        container!.querySelectorAll<HTMLButtonElement>(
          '[role="option"] button',
        ),
      ).find((button) => button.textContent === 'One')!;
      act(() => option.click());
      expect(titles()).toEqual(['Three', 'One']);
      terminalArchived.add('s1');
      rerender();
      expect(titles()).toEqual(['Three']);
    });

    it('drops the terminal mark when the pane un-parks', async () => {
      // A parent that does not apply the prune keeps the pane mounted. Once
      // its provider leaves the parked state (the session was restored), a
      // later incomplete-page commit must not prune it on a sticky mark.
      primaryPageMeta = { nextCursor: 'cursor-2' };
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2'], onPanesChange });
      await flushAsync();
      terminalArchived.add('s2');
      rerender({ sessionIds: ['s1', 's2'], onPanesChange });
      expect(onPanesChange).toHaveBeenLastCalledWith(['s1']);
      terminalArchived.delete('s2');
      rerender({ sessionIds: ['s1', 's2'], onPanesChange });
      onPanesChange.mockClear();
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      expect(onPanesChange).not.toHaveBeenCalled();
    });

    it('prunes a terminal-archived pane on a complete page despite a cached alive verdict', async () => {
      // An archived standalone session's probe can have answered alive before
      // the archive. The pane's own terminal answer supersedes the cached
      // verdict instead of short-circuiting on it.
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      workspaceClient.getStandaloneSession.mockResolvedValue({
        sessionId: 'st1',
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 'st1'], onPanesChange });
      await flushAsync();
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(1);
      expect(onPanesChange).not.toHaveBeenCalled();
      terminalArchived.add('st1');
      rerender({ sessionIds: ['s1', 'st1'], onPanesChange });
      await flushAsync();
      expect(onPanesChange).toHaveBeenLastCalledWith(['s1']);
    });

    it('never prunes the current session parked on its terminal answer', async () => {
      // The provider clears `connection.sessionId` when the current session
      // parks on session_archived: the seed pane keeps its exemption through
      // the park, on an incomplete page and on a complete one.
      primaryPageMeta = { nextCursor: 'cursor-2' };
      const onPanesChange = vi.fn();
      const onExit = vi.fn();
      render({ sessionIds: ['s3', 's1'], onPanesChange, onExit });
      await flushAsync();
      terminalArchived.add('s3');
      connectionState = {
        ...connectionState,
        sessionId: undefined,
        status: 'disconnected',
        errorStatus: 409,
        sessionArchived: true,
      };
      rerender({ sessionIds: ['s3', 's1'], onPanesChange, onExit });
      await flushAsync();
      expect(onPanesChange).not.toHaveBeenCalled();
      primaryPageMeta = {};
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's3'));
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(2);
    });

    it('prunes a ready fan-out pane while a sibling workspace is not ready', async () => {
      // Readiness is per-cwd: /wsB not being ready must not shield c1 in the
      // (ready, empty) /wsC — a fan-out-wide "any not-ready blocks everything"
      // gate would keep the pruned pane open.
      connectionState.capabilities = {
        features: [],
        workspaceCwd: '/w',
        workspaces: [
          { id: 'w0', cwd: '/w', primary: true, trusted: true },
          {
            id: 'w1',
            cwd: '/wsB',
            displayName: 'Payments API',
            primary: false,
            trusted: true,
          },
          {
            id: 'w2',
            cwd: '/wsC',
            displayName: 'Ledger API',
            primary: false,
            trusted: true,
          },
        ],
      };
      setOtherWorkspace({
        sessions: {
          '/wsB': [
            { sessionId: 'b1', workspaceCwd: '/wsB', displayName: 'Beta' },
          ],
          '/wsC': [
            { sessionId: 'c1', workspaceCwd: '/wsC', displayName: 'Gamma' },
          ],
        },
        queriedCwds: ['/wsB', '/wsC'],
        notReadyCwds: [],
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 'b1', 'c1'], onPanesChange });
      await flushAsync();
      // /wsB goes not-ready while /wsC settles empty: c1 is provably gone
      // (pruned), b1 is not provably gone (kept).
      setOtherWorkspace({
        sessions: { '/wsC': [] },
        queriedCwds: ['/wsB', '/wsC'],
        notReadyCwds: ['/wsB'],
      });
      await flushAsync();
      expect(onPanesChange).toHaveBeenLastCalledWith(['s1', 'b1']);
    });

    it('does not resurrect a pane the parent closed while a probe is in flight (controlled)', async () => {
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      // stale1 is absent from the catalog; defer its probe so the prop can move
      // while it is in flight.
      let settleProbe: ((reject: boolean) => void) | undefined;
      const probeGate = new Promise<void>((resolve, reject) => {
        settleProbe = (doReject) =>
          doReject
            ? reject(
                new DaemonHttpError(
                  404,
                  {
                    error: 'standalone session not found',
                    code: 'standalone_session_not_found',
                  },
                  'standalone session not found',
                ),
              )
            : resolve();
      });
      workspaceClient.getStandaloneSession = vi.fn(() => probeGate);
      // A stateful parent: what it holds after the round is the truth — a
      // report that resurrects a closed pane sticks, because nothing stale is
      // left to re-trigger the reconcile afterwards.
      let parentIds: string[] = ['stale1', 's2', 's3'];
      function Parent() {
        const [ids, setIds] = React.useState<string[]>(['stale1', 's2', 's3']);
        parentIds = ids;
        return (
          <SplitView
            sessionIds={ids}
            onPanesChange={setIds}
            onExit={() => {}}
          />
        );
      }
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root!.render(
          <I18nProvider language="en">
            <Parent />
          </I18nProvider>,
        );
      });
      await flushAsync();
      // The probe for stale1 is in flight. The user closes the s3 pane with a
      // real (un-act()ed) click: the prop render commits and paneIdsRef —
      // which tracks the prop-derived pane set in controlled mode — refreshes
      // before the probe's continuation microtask runs.
      const closes = container!.querySelectorAll('[data-testid="pane-close"]');
      closes[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      settleProbe!(true);
      await flushAsync();
      // s3 must stay closed: a stale state mirror (the pre-fix read) would
      // have reported ['s2', 's3'], resurrecting the pane the user just
      // closed — permanently.
      expect(parentIds).toEqual(['s2']);
    });

    it('skips the standalone probe when the capability is absent', async () => {
      // Default capabilities carry no standalone_sessions_v1: the gate must skip
      // the probe entirely (no getStandaloneSession call) and prune the stale
      // pane directly.
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(workspaceClient.getStandaloneSession).not.toHaveBeenCalled();
      expect(onPanesChange).toHaveBeenLastCalledWith([]);
    });

    it('never prunes the current session, even if it leaves the catalog', async () => {
      // connectionState.sessionId is 's3': the seed pane is the current
      // session, whose workspace the connection already knows. If it leaves
      // the catalog (archived), the provider shows the terminal error —
      // closing the pane the user is looking at is not the reconcile's job.
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s3'], onPanesChange });
      await flushAsync();
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's3'));
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(1);
      // The kept seed pane stays resolvable: title and session-details target
      // both survive via the last-seen summary fallback.
      expect(titles()).toEqual(['Three']);
      expect(sessionDetails()).toEqual(['s3']);
    });

    it('does not re-probe an id the probe already answered absent', async () => {
      // The absent verdict is deterministic (a workspace id is never a
      // standalone session), so a stale id that survives a round — e.g. the
      // parent does not apply the controlled prune — must not be re-probed
      // on every catalog commit (that would repeat the same 404 forever).
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      workspaceClient.getStandaloneSession = vi.fn(async () => {
        throw new DaemonHttpError(
          404,
          {
            error: 'standalone session not found',
            code: 'standalone_session_not_found',
          },
          'standalone session not found',
        );
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(onPanesChange).toHaveBeenLastCalledWith([]);
      // Second catalog commit with the same absence: the verdict is cached,
      // so the prune is reported again without a second probe round trip.
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(1);
      expect(onPanesChange).toHaveBeenCalledTimes(2);
    });

    it('does not re-probe a live standalone pane on later commits', async () => {
      // A live standalone pane is kept-but-stale (it never appears in a
      // workspace list): its successful probe is the definitive answer, so
      // later catalog commits must not re-probe it.
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      workspaceClient.getStandaloneSession = vi.fn(async () => ({
        sessionId: 'st1',
      }));
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      // A live standalone pane: kept, and the verdict is recorded.
      expect(onPanesChange).not.toHaveBeenCalled();
      expect(panes()).toHaveLength(1);
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(1);
      expect(panes()).toHaveLength(1);
    });

    it('re-probes a pane after a retryable standalone conflict', async () => {
      // A pending deletion journal answers 409 standalone_session_conflict
      // with retryable: true — "ask again". No verdict is cached: the next
      // commit re-probes, and once the journal clears the 404 prunes.
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      const retryableConflict = new DaemonHttpError(
        409,
        {
          error: 'standalone session conflict',
          code: 'standalone_session_conflict',
          retryable: true,
        },
        'standalone session conflict',
      );
      workspaceClient.getStandaloneSession.mockRejectedValueOnce(
        retryableConflict,
      );
      const onPanesChange = vi.fn();
      render({ sessionIds: ['st1'], onPanesChange });
      await flushAsync();
      expect(onPanesChange).not.toHaveBeenCalled();
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      await flushAsync();
      expect(workspaceClient.getStandaloneSession).toHaveBeenCalledTimes(2);
      expect(onPanesChange).toHaveBeenLastCalledWith([]);
    });

    it.each([
      [
        'a 200 summary marked archived',
        () =>
          workspaceClient.getStandaloneSession.mockResolvedValue({
            sessionId: 'st1',
            isArchived: true,
          }),
      ],
      [
        'a 409 session_archived',
        () =>
          workspaceClient.getStandaloneSession.mockRejectedValue(
            new DaemonHttpError(
              409,
              { error: 'session archived', code: 'session_archived' },
              'session archived',
            ),
          ),
      ],
    ])(
      'prunes a pane whose standalone probe answers %s',
      async (_label, arrange) => {
        connectionState.capabilities = {
          features: ['standalone_sessions_v1'],
          workspaceCwd: '/w',
        };
        arrange();
        const onPanesChange = vi.fn();
        render({ sessionIds: ['st1'], onPanesChange });
        await flushAsync();
        expect(onPanesChange).toHaveBeenLastCalledWith([]);
      },
    );

    it('neither probes nor prunes an unknown-workspace pane while a fan-out workspace is not ready', async () => {
      // Cold mount: b1 lives in /wsB, whose page has not landed, so its cwd
      // is unknown. The probe cannot settle it — a live workspace session
      // answers not-found too — so it waits for the fan-out.
      connectionState.capabilities = {
        ...MULTI_WORKSPACE_CAPS,
        features: ['standalone_sessions_v1'],
      };
      setOtherWorkspace({
        sessions: {},
        queriedCwds: ['/wsB'],
        notReadyCwds: ['/wsB'],
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['b1'], onPanesChange });
      await flushAsync();
      await pushCatalog(sessionsState.filter((s) => s.sessionId !== 's4'));
      expect(workspaceClient.getStandaloneSession).not.toHaveBeenCalled();
      expect(onPanesChange).not.toHaveBeenCalled();
    });

    it.each([
      ['truncated', { truncated: true }],
      ['cursor-pending', { nextCursor: 'cursor-2' }],
      ['liveMergeFailed', { liveMergeFailed: true }],
      ['stale', { stale: true }],
      ['errored', { error: new Error('refresh failed') }],
    ])(
      'does not prune an unknown-workspace pane while the page is %s',
      async (_label, meta) => {
        // deep1 was never listed, so it has no known workspace: the page
        // completeness check is the only thing between it and a prune.
        primaryPageMeta = meta;
        const onPanesChange = vi.fn();
        render({ sessionIds: ['deep1'], onPanesChange });
        await flushAsync();
        expect(workspaceClient.getStandaloneSession).not.toHaveBeenCalled();
        expect(onPanesChange).not.toHaveBeenCalled();
      },
    );

    it('never probes panes the catalog still lists', async () => {
      connectionState.capabilities = {
        features: ['standalone_sessions_v1'],
        workspaceCwd: '/w',
      };
      workspaceClient.getStandaloneSession.mockResolvedValue({
        sessionId: 'x',
      });
      const onPanesChange = vi.fn();
      render({ sessionIds: ['s1', 's2'], onPanesChange });
      await flushAsync();
      expect(workspaceClient.getStandaloneSession).not.toHaveBeenCalled();
      await pushCatalog([...sessionsState]);
      expect(workspaceClient.getStandaloneSession).not.toHaveBeenCalled();
      expect(onPanesChange).not.toHaveBeenCalled();
    });

    it('keeps the seed pane in its workspace across a terminal park', async () => {
      // x1 is the current session in /wsB and appears in no list: only the
      // connection knows its workspace. Clearing `connection.sessionId` on
      // the park must not remount the pane under the primary workspace.
      connectionState = {
        ...connectionState,
        sessionId: 'x1',
        workspaceCwd: '/wsB',
        capabilities: MULTI_WORKSPACE_CAPS,
      };
      render({ sessionIds: ['x1'] });
      await flushAsync();
      const workspaceOfX1 = () =>
        container!
          .querySelector('[data-session="x1"]')
          ?.getAttribute('data-workspace');
      expect(workspaceOfX1()).toBe('/wsB');
      terminalArchived.add('x1');
      connectionState = {
        ...connectionState,
        sessionId: undefined,
        status: 'disconnected',
        errorStatus: 409,
        sessionArchived: true,
      };
      rerender({ sessionIds: ['x1'] });
      await flushAsync();
      expect(panes()).toHaveLength(1);
      expect(workspaceOfX1()).toBe('/wsB');
    });
  });
});
