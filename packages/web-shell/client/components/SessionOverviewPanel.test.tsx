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
import type {
  DaemonCapabilities,
  DaemonSessionSummary,
  DaemonStatusReportSession,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// jsdom lacks PointerEvent; radix popovers/dropdowns dispatch pointer events
// to open, so the test helper needs a usable constructor (mirrors the sidebar
// tests).
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
// radix Select calls hasPointerCapture during pointer handling; jsdom does not
// implement it (mirrors the sidebar tests).
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}

// --- Mutable mock state, reset in beforeEach ---
let connectionState: {
  sessionId?: string;
  capabilities?: DaemonCapabilities;
  workspaceCwd?: string;
};
let workspaceCapabilities: DaemonCapabilities | undefined;
let sessionsState: {
  sessions: DaemonSessionSummary[];
  loading: boolean;
  error?: Error;
};
let statusState: {
  report?: { full?: { sessions: DaemonStatusReportSession[] } };
};
// Live sessions the mock daemon returns per non-primary workspace cwd.
let otherWorkspaceSessions: Record<string, DaemonSessionSummary[]>;
// Options captured from the (mocked) useScopedSessions call, so tests can
// assert the live-state vs catalog-poll fallback.
let scopedSessionsOptions: { pollIntervalMs?: number };
let workspaceLiveStateOptions: { enabled: boolean };
let statusReportOptions: { autoLoad?: boolean; detail?: string };
// Stable client object (per test) so the other-workspace hook's load callback
// keeps a stable identity and its effect doesn't loop.
let workspaceClient: {
  listWorkspaceSessionsPage: ReturnType<typeof vi.fn>;
  workspaceByCwd: ReturnType<typeof vi.fn>;
  archiveSessionsData: ReturnType<typeof vi.fn>;
  deleteSessionsData: ReturnType<typeof vi.fn>;
};
// Primary-workspace actions surfaced by useWorkspace / useActions.
let workspaceActions: {
  deleteSession: ReturnType<typeof vi.fn>;
  archiveSession: ReturnType<typeof vi.fn>;
  renameSession: ReturnType<typeof vi.fn>;
  exportSession: ReturnType<typeof vi.fn>;
};

const sessionsReload = vi.fn(async () => sessionsState.sessions);
const statusReload = vi.fn(async () => statusState.report);

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connectionState,
  useActions: () => workspaceActions,
  useStatusReport: (options: { autoLoad?: boolean; detail?: string } = {}) => {
    statusReportOptions = options;
    return { ...statusState, reload: statusReload };
  },
  useWorkspace: () => ({
    client: workspaceClient,
    actions: workspaceActions,
    capabilities: workspaceCapabilities ?? connectionState.capabilities,
    workspaceCwd: connectionState.workspaceCwd,
  }),
}));

vi.mock('../hooks/useScopedSessions', () => ({
  useScopedSessions: (
    _workspaceCwd: string | undefined,
    options: { pollIntervalMs?: number } = {},
  ) => {
    scopedSessionsOptions = options;
    const inFlight = React.useRef(false);
    React.useEffect(() => {
      if (options.pollIntervalMs === undefined) return;
      const timer = setInterval(() => {
        if (document.hidden || inFlight.current) return;
        inFlight.current = true;
        void sessionsReload().finally(() => {
          inFlight.current = false;
        });
      }, options.pollIntervalMs);
      return () => clearInterval(timer);
    }, [options.pollIntervalMs]);
    return { ...sessionsState, reload: sessionsReload };
  },
}));

// The live-state channel itself is exercised by the session-catalog tests;
// the panel just needs its group-catalog return (always empty here).
vi.mock('../session-catalog/workspace-session-live-state', () => ({
  useWorkspaceSessionLiveState: (
    _client: unknown,
    options: { enabled: boolean },
  ) => {
    workspaceLiveStateOptions = options;
    return new Map();
  },
}));

const { SessionOverviewPanel, deriveSessionCards } = await import(
  './SessionOverviewPanel'
);

function session(
  id: string,
  extra: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    sessionId: id,
    workspaceCwd: '/w',
    updatedAt: '2026-07-06T10:00:00.000Z',
    ...extra,
  };
}

function statusSession(
  id: string,
  extra: Partial<DaemonStatusReportSession> = {},
): DaemonStatusReportSession {
  return {
    sessionId: id,
    workspaceCwd: '/w',
    createdAt: '2026-07-06T09:00:00.000Z',
    clientCount: 0,
    subscriberCount: 0,
    attachCount: 0,
    pendingPromptCount: 0,
    pendingPermissionCount: 0,
    hasActivePrompt: false,
    lastEventId: 0,
    ...extra,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onOpenSession: ReturnType<typeof vi.fn>;
let onCurrentSessionRemoved: ReturnType<typeof vi.fn>;
let openSpy: ReturnType<typeof vi.fn>;
let anchorClick: ReturnType<typeof vi.fn>;
const originalOpen = window.open;
const originalAnchorClick = HTMLAnchorElement.prototype.click;

beforeEach(() => {
  window.localStorage.clear();
  connectionState = {
    sessionId: 's-run',
    capabilities: {
      features: ['session_archive', 'workspace_qualified_rest_core'],
      workspaceCwd: '/w',
    },
    workspaceCwd: '/w',
  };
  workspaceCapabilities = undefined;
  sessionsState = { sessions: [], loading: false };
  statusState = { report: { full: { sessions: [] } } };
  otherWorkspaceSessions = {};
  scopedSessionsOptions = {};
  workspaceLiveStateOptions = { enabled: false };
  statusReportOptions = {};
  workspaceActions = {
    deleteSession: vi.fn(async () => true),
    archiveSession: vi.fn(async () => true),
    renameSession: vi.fn(async () => ({ displayName: 'Renamed' })),
    exportSession: vi.fn(async () => ({
      content: '<html></html>',
      filename: 'session.html',
      mimeType: 'text/html',
      format: 'html',
    })),
  };
  workspaceClient = {
    listWorkspaceSessionsPage: vi.fn(async (cwd: string) => ({
      sessions: otherWorkspaceSessions[cwd] ?? [],
    })),
    workspaceByCwd: vi.fn((cwd: string) => ({
      listWorkspaceSessionsPage: vi.fn(async () => ({
        sessions: otherWorkspaceSessions[cwd] ?? [],
      })),
      archiveSessionsData: vi.fn(async () => ({
        archived: [],
        alreadyArchived: [],
        notFound: [],
        errors: [],
      })),
      deleteSessionsData: vi.fn(async () => ({
        removed: [],
        notFound: [],
        errors: [],
      })),
      updateSessionMetadata: vi.fn(async () => ({ displayName: 'Renamed' })),
      exportSession: vi.fn(async () => ({
        content: '<html></html>',
        filename: 'session.html',
        mimeType: 'text/html',
        format: 'html',
      })),
    })),
    archiveSessionsData: vi.fn(async (ids: string[]) => ({
      archived: ids,
      alreadyArchived: [],
      notFound: [],
      errors: [],
    })),
    deleteSessionsData: vi.fn(async (ids: string[]) => ({
      removed: ids,
      notFound: [],
      errors: [],
    })),
  };
  sessionsReload.mockClear();
  statusReload.mockClear();
  onOpenSession = vi.fn();
  onCurrentSessionRemoved = vi.fn(async () => {});
  openSpy = vi.fn().mockReturnValue({ focus: vi.fn() });
  window.open = openSpy as unknown as typeof window.open;
  anchorClick = vi.fn();
  HTMLAnchorElement.prototype.click = anchorClick;
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.open = originalOpen;
  HTMLAnchorElement.prototype.click = originalAnchorClick;
});

function render(
  props: {
    onOpenSplit?: (ids: string[]) => void;
    onCurrentSessionRemoved?: (session: {
      sessionId: string;
      workspaceCwd: string;
    }) => Promise<boolean | void> | boolean | void;
    manageLiveState?: boolean;
    workspaceCwd?: string;
  } = {},
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <SessionOverviewPanel onOpenSession={onOpenSession} {...props} />
      </I18nProvider>,
    ),
  );
}

function rerender(
  props: {
    onOpenSplit?: (ids: string[]) => void;
    onCurrentSessionRemoved?: (session: {
      sessionId: string;
      workspaceCwd: string;
    }) => Promise<boolean | void> | boolean | void;
    manageLiveState?: boolean;
    workspaceCwd?: string;
  } = {},
): void {
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <SessionOverviewPanel onOpenSession={onOpenSession} {...props} />
      </I18nProvider>,
    ),
  );
}

// Flush the other-workspace hook's async fan-out (Promise.allSettled + the
// effect's `.then` setState). Three ticks so the state update lands in `act`.
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rows(): HTMLElement[] {
  return Array.from(container!.querySelectorAll('tbody tr'));
}
function rowTitles(): string[] {
  return rows().map((tr) => {
    const title = tr.querySelector('[data-web-shell-session-title]');
    return title?.textContent?.trim() ?? '';
  });
}
function selectAllCheckbox(): HTMLElement {
  return container!.querySelector(
    'thead [data-slot="checkbox"]',
  ) as HTMLElement;
}
function rowCheckbox(row: HTMLElement): HTMLElement {
  return row.querySelector('td [data-slot="checkbox"]') as HTMLElement;
}
function rowActionButton(row: HTMLElement, label: string): HTMLButtonElement {
  return row.querySelector(
    `button[aria-label="${label}"]`,
  ) as HTMLButtonElement;
}
function titleTrigger(row: HTMLElement): HTMLElement {
  return row.querySelector('[data-web-shell-session-title]') as HTMLElement;
}
function footerButton(label: string): HTMLButtonElement | null {
  const footer = container!.querySelector('[data-web-shell-session-footer]');
  return (
    Array.from(footer?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes(label),
    ) ??
    Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    ) ??
    null
  );
}

// Radix popovers/dropdowns/selects open on pointerdown and Tabs activate on
// mousedown; the native click alone is not enough in jsdom (mirrors the
// sidebar's test helper, extended with the mousedown radix needs).
function click(element: HTMLElement): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('deriveSessionCards', () => {
  it('ranks needs-approval above user-input above running above idle, then by recency', () => {
    const sessions = [
      session('s-idle', { displayName: 'idle' }),
      session('s-run', { displayName: 'run', hasActivePrompt: true }),
      session('s-q', { displayName: 'q', isWaitingForUserQuestion: true }),
      session('s-appr', { displayName: 'appr', isWaitingForPermission: true }),
    ];
    const cards = deriveSessionCards(sessions, 's-run');
    expect(cards.map((c) => c.sessionId)).toEqual([
      's-appr',
      's-q',
      's-run',
      's-idle',
    ]);
    expect(cards.map((c) => c.status)).toEqual([
      'needsApproval',
      'askUserQuestion',
      'running',
      'idle',
    ]);
  });

  it('needs-approval wins even when the prompt is also active (blocked turn)', () => {
    const cards = deriveSessionCards(
      [session('s', { hasActivePrompt: true, isWaitingForPermission: true })],
      undefined,
    );
    expect(cards[0].status).toBe('needsApproval');
  });

  it('user-input wins over a running turn when both flags are set', () => {
    const cards = deriveSessionCards(
      [session('s', { hasActivePrompt: true, isWaitingForUserQuestion: true })],
      undefined,
    );
    expect(cards[0].status).toBe('askUserQuestion');
  });

  it('treats sessions without live flags as idle', () => {
    const cards = deriveSessionCards([session('cold')], undefined);
    expect(cards[0].status).toBe('idle');
  });

  it('labels with displayName, falling back to a short id, and flags current', () => {
    const cards = deriveSessionCards(
      [
        session('abcdef1234567890', {}),
        session('named', { displayName: '  Named  ' }),
      ],
      'named',
    );
    const byId = new Map(cards.map((c) => [c.sessionId, c]));
    expect(byId.get('abcdef1234567890')!.label).toBe('abcdef12');
    expect(byId.get('named')!.label).toBe('Named');
    expect(byId.get('named')!.isCurrent).toBe(true);
    expect(byId.get('abcdef1234567890')!.isCurrent).toBe(false);
  });

  it('uses workspace and id together to identify the current session', () => {
    const cards = deriveSessionCards(
      [
        session('same', { workspaceCwd: '/w' }),
        session('same', { workspaceCwd: '/other' }),
      ],
      'same',
      [],
      '/other',
    );
    expect(cards.find((card) => card.workspaceCwd === '/w')?.isCurrent).toBe(
      false,
    );
    expect(
      cards.find((card) => card.workspaceCwd === '/other')?.isCurrent,
    ).toBe(true);
  });

  it('uses status-report approval details as a compatibility fallback', () => {
    const cards = deriveSessionCards([session('s')], undefined, [
      statusSession('s', {
        pendingPermissionCount: 1,
      }),
    ]);
    expect(cards[0].status).toBe('needsApproval');
  });

  it('passes bound PRs through to the card', () => {
    const prs = [
      { number: 9500, url: 'https://github.com/o/r/pull/9500' },
      { number: 9517, url: 'https://github.com/o/r/pull/9517' },
    ];
    const cards = deriveSessionCards([session('s', { prs })], undefined);
    expect(cards[0].prs).toEqual(prs);
    const bare = deriveSessionCards([session('bare')], undefined);
    expect(bare[0].prs).toBeUndefined();
  });
});

describe('SessionOverviewPanel', () => {
  it('renders an empty state when there are no sessions', () => {
    render();
    const empty = container!.querySelector('[data-slot="data-table-empty"]');
    expect(empty?.closest('tbody')).not.toBeNull();
    expect(empty?.textContent).toContain('No sessions yet');
    expect(footerButton('Refresh')).not.toBeNull();
  });

  it('keeps manual refresh available when the initial load fails', async () => {
    sessionsState.error = new Error('offline');
    render();
    act(() => click(footerButton('Refresh')!));
    await flushAsync();
    expect(sessionsReload).toHaveBeenCalledOnce();
  });

  it('renders rows ranked with needs-approval first', () => {
    sessionsState.sessions = [
      session('s-idle', { displayName: 'Bravo' }),
      session('s-run', { displayName: 'Alpha', hasActivePrompt: true }),
      session('s-appr', {
        displayName: 'Charlie',
        isWaitingForPermission: true,
      }),
    ];
    render();
    expect(rowTitles()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('shows loading after the title for every non-idle session', () => {
    sessionsState.sessions = [
      session('s-run', { displayName: 'Run', hasActivePrompt: true }),
      session('s-appr', {
        displayName: 'Approval',
        isWaitingForPermission: true,
      }),
      session('s-q', {
        displayName: 'Question',
        isWaitingForUserQuestion: true,
      }),
      session('s-idle', { displayName: 'Still' }),
    ];
    render();
    for (const label of ['Run', 'Approval', 'Question']) {
      const row = rows().find((candidate) =>
        candidate.textContent?.includes(label),
      )!;
      expect(
        titleTrigger(row).nextElementSibling?.hasAttribute(
          'data-web-shell-session-loading',
        ),
      ).toBe(true);
    }
    const idle = rows().find((tr) => tr.textContent?.includes('Still'))!;
    expect(idle.querySelector('[data-web-shell-session-loading]')).toBeNull();
  });

  it('toggles selection when the row is clicked', () => {
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    render();
    act(() => click(rows()[0]!.querySelectorAll('td')[2] as HTMLElement));
    expect(rowCheckbox(rows()[0]!).getAttribute('data-state')).toBe('checked');
    expect(onOpenSession).not.toHaveBeenCalled();

    act(() => click(rows()[0]!.querySelectorAll('td')[2] as HTMLElement));
    expect(rowCheckbox(rows()[0]!).getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  it('keeps the title keyboard-focusable for opening a session', () => {
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    render();
    const title = titleTrigger(rows()[0]!);
    expect(title.tagName).toBe('BUTTON');
    act(() => click(title));
    expect(onOpenSession).toHaveBeenCalledWith('s-run', '/w');
    expect(rowCheckbox(rows()[0]!).getAttribute('data-state')).toBe(
      'unchecked',
    );
  });

  it('shows the full title in a tooltip on hover', async () => {
    sessionsState.sessions = [
      session('s1', { displayName: 'A long session title' }),
    ];
    vi.useFakeTimers();
    try {
      render();
      await act(async () => {
        titleTrigger(rows()[0]!).dispatchEvent(
          new Event('pointermove', { bubbles: true }),
        );
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
      expect(
        document.querySelector('[data-slot="tooltip-content"]')?.textContent,
      ).toContain('A long session title');
      expect(
        document
          .querySelector('[data-slot="tooltip-arrow"]')
          ?.getAttribute('viewBox'),
      ).toBe('0 0 30 10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the full session id in a tooltip on hover', async () => {
    sessionsState.sessions = [session('session-id-for-tooltip')];
    vi.useFakeTimers();
    try {
      render();
      await act(async () => {
        rows()[0]!
          .querySelector('[data-web-shell-session-id]')!
          .dispatchEvent(new Event('pointermove', { bubbles: true }));
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
      expect(
        document.querySelector('[data-slot="tooltip-content"]')?.textContent,
      ).toContain('session-id-for-tooltip');
      expect(
        rows()[0]!
          .querySelector('[data-web-shell-session-id]')!
          .className.includes('truncate'),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the full workspace path in a tooltip on hover', async () => {
    sessionsState.sessions = [
      session('s1', { workspaceCwd: '/workspace/with/a/long/path' }),
    ];
    vi.useFakeTimers();
    try {
      render();
      await act(async () => {
        rows()[0]!
          .querySelector('[data-web-shell-session-workspace]')!
          .dispatchEvent(new Event('pointermove', { bubbles: true }));
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
      expect(
        document.querySelector('[data-slot="tooltip-content"]')?.textContent,
      ).toContain('/workspace/with/a/long/path');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows worktree metadata in a column immediately after the title', () => {
    sessionsState.sessions = [
      session('s1', {
        displayName: 'One',
        worktree: {
          slug: 'one',
          path: '/wt/one',
          branch: 'feature/a-very-long-branch-name',
        },
        prs: [
          { number: 121, url: 'https://github.com/o/r/pull/121' },
          { number: 122, url: 'https://github.com/o/r/pull/122' },
          { number: 123, url: 'https://github.com/o/r/pull/123' },
        ],
      }),
      session('s2', { displayName: 'Two' }),
    ];
    render();
    const headers = Array.from(container!.querySelectorAll('thead th'));
    expect(headers[1]?.textContent).toBe('Title');
    expect(headers[2]?.textContent).toBe('Worktree');
    expect(headers[3]?.textContent).toBe('Session ID');
    expect(
      rows()[0]?.querySelector('[data-web-shell-session-git]')?.textContent,
    ).toBe('feature/a-very-long-branch-name');
    expect(
      rows()[0]?.querySelector('[data-web-shell-session-git] svg'),
    ).toBeNull();
    const gitCell = rows()[0]
      ?.querySelector('[data-web-shell-session-git]')
      ?.closest('td');
    const worktree = rows()[0]?.querySelector('[data-web-shell-session-git]');
    expect(worktree?.className).toContain('min-w-0');
    expect(worktree?.className).toContain('flex-1');
    expect(worktree?.className).toContain('truncate');
    expect(gitCell?.querySelector('a')?.textContent).toBe('#123 +2');
    expect(
      rows()[0]
        ?.querySelector('[data-web-shell-session-title]')
        ?.closest('td')
        ?.querySelector('a'),
    ).toBeNull();
    expect(
      rows()[1]?.querySelector('[data-web-shell-session-git]')?.textContent,
    ).toBe('-');
  });

  it('shows the sidebar details popover from the worktree column', async () => {
    vi.useFakeTimers();
    try {
      sessionsState.sessions = [
        session('session-details', {
          displayName: 'Detailed session',
          workspaceCwd: '/work/qwen-code',
          updatedAt: '2026-08-26T09:00:00.000Z',
          clientCount: 2,
          worktree: {
            slug: 'details',
            path: '/work/qwen-code/.worktrees/details',
            branch: 'worktree/details',
          },
          prs: [
            { number: 121, url: 'https://github.com/o/r/pull/121' },
            { number: 123, url: 'https://github.com/o/r/pull/123' },
          ],
        }),
      ];
      render();
      const trigger = container!
        .querySelector('[data-web-shell-session-git]')!
        .closest('div')!;
      await act(async () => {
        trigger.dispatchEvent(new Event('pointerover', { bubbles: true }));
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      const details = document.querySelector('[role="dialog"]');
      expect(details?.getAttribute('data-align')).toBe('center');
      expect(details?.textContent).toContain('worktree/details');
      expect(details?.textContent).toContain('Pull Request #123');
      expect(details?.textContent).toContain('Pull Request #121');
      expect(details?.textContent).not.toContain('Detailed session');
      expect(details?.textContent).not.toContain('qwen-code');
      expect(details?.textContent).not.toContain('session-details');
      expect(details?.textContent).not.toContain('2 client(s)');
      expect(
        details?.querySelectorAll('a[href*="/pull/"]')[0]?.getAttribute('href'),
      ).toBe('https://github.com/o/r/pull/123');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show an empty worktree popover', async () => {
    vi.useFakeTimers();
    try {
      sessionsState.sessions = [session('no-worktree')];
      render();
      const trigger = container!.querySelector('[data-web-shell-session-git]')!;
      await act(async () => {
        trigger.dispatchEvent(new Event('pointerover', { bubbles: true }));
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('copies the session ID and restores the hover icon after two seconds', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    try {
      sessionsState.sessions = [session('session-to-copy')];
      render();
      const copy = container!.querySelector(
        '[data-web-shell-session-id-copy]',
      ) as HTMLButtonElement;
      expect(copy.className).toContain('opacity-0');
      expect(copy.className).toContain('group-hover:opacity-100');
      expect(copy.querySelector('.lucide-copy')).not.toBeNull();

      await act(async () => copy.click());
      expect(writeText).toHaveBeenCalledWith('session-to-copy');
      expect(copy.querySelector('.lucide-check')).not.toBeNull();
      expect(copy.className).toContain('opacity-100');
      expect(rowCheckbox(rows()[0]!).getAttribute('data-state')).toBe(
        'unchecked',
      );

      act(() => vi.advanceTimersByTime(2000));
      expect(copy.querySelector('.lucide-copy')).not.toBeNull();
    } finally {
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
      Reflect.deleteProperty(navigator, 'clipboard');
      vi.useRealTimers();
    }
  });

  it("passes the owning workspace cwd when clicking another workspace's session", async () => {
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync();
    const beta = rows().find((tr) => tr.textContent?.includes('Beta'))!;
    act(() => click(titleTrigger(beta)));
    expect(onOpenSession).toHaveBeenCalledWith('b1', '/wsB');
  });

  it('keeps equal session ids in different workspaces independent', async () => {
    connectionState.sessionId = 'same';
    connectionState.workspaceCwd = '';
    connectionState.capabilities = {
      features: ['session_archive', 'workspace_qualified_rest_core'],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [
      session('same', { workspaceCwd: '/w', displayName: 'Primary' }),
    ];
    otherWorkspaceSessions['/wsB'] = [
      session('same', { workspaceCwd: '/wsB', displayName: 'Secondary' }),
    ];
    render({ onOpenSplit: vi.fn(), onCurrentSessionRemoved });
    await flushAsync();

    expect(rowTitles()).toEqual(['Primary', 'Secondary']);
    const primary = rows().find((row) => row.textContent?.includes('Primary'))!;
    const secondary = rows().find((row) =>
      row.textContent?.includes('Secondary'),
    )!;
    expect(primary.textContent).toContain('Current');
    expect(secondary.textContent).not.toContain('Current');

    act(() => click(rowCheckbox(secondary)));
    expect(rowCheckbox(primary).getAttribute('data-state')).toBe('unchecked');
    expect(rowCheckbox(secondary).getAttribute('data-state')).toBe('checked');
    expect(footerButton('Open in new tab')?.disabled).toBe(true);
    expect(footerButton('Open in split')?.disabled).toBe(true);

    act(() => click(rowActionButton(secondary, 'Archive')));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    const qualified = workspaceClient.workspaceByCwd.mock.results.at(-1)!.value;
    expect(qualified.archiveSessionsData).toHaveBeenCalledWith(['same']);
    expect(workspaceActions.archiveSession).not.toHaveBeenCalled();
    expect(onCurrentSessionRemoved).not.toHaveBeenCalled();
  });

  it('keeps footer actions visible and disables them until a row is selected', () => {
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    render({ onOpenSplit: vi.fn() });
    expect(selectAllCheckbox()).not.toBeNull();
    const actions = [
      footerButton('Archive'),
      footerButton('Delete'),
      footerButton('Open in new tab'),
      footerButton('Open in split'),
    ] as HTMLButtonElement[];
    expect(actions.every((button) => button.disabled)).toBe(true);
    act(() => click(rowCheckbox(rows()[0]!)));
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('1 of 1 row(s) selected.');
    const openInTab = footerButton('Open in new tab') as HTMLButtonElement;
    expect(actions.every((button) => button.disabled)).toBe(false);
    // The new-tab action is not the primary button style.
    expect(openInTab.getAttribute('data-variant')).toBe('outline');
  });

  it('opens the selected sessions as a split in ONE new tab (?split=…)', () => {
    sessionsState.sessions = [
      session('s-idle', { displayName: 'Bravo' }),
      session('s-appr', {
        displayName: 'Charlie',
        isWaitingForPermission: true,
      }),
    ];
    render();
    act(() => click(selectAllCheckbox()));
    const openInTab = footerButton('Open in new tab') as HTMLButtonElement;
    act(() =>
      openInTab.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // A single new tab whose URL carries the ranked split (needs-approval
    // first).
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target] = openSpy.mock.calls[0];
    expect(target).toBe('_blank');
    expect(decodeURIComponent(String(url))).toContain('split=s-appr,s-idle');
  });

  it('severs window.opener on the new split tab (token is in its URL)', () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    const opened = { focus: vi.fn(), opener: {} as unknown };
    openSpy.mockReturnValue(opened);
    render();
    act(() => click(selectAllCheckbox()));
    const openInTab = footerButton('Open in new tab') as HTMLButtonElement;
    act(() =>
      openInTab.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // The opener link is cut so the authenticated split tab can't script us.
    expect(opened.opener).toBeNull();
    expect(opened.focus).toHaveBeenCalledTimes(1);
  });

  it('opens the selected sessions in the visible sort order', () => {
    sessionsState.sessions = [
      session('s-idle', {
        displayName: 'Bravo',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      session('s-appr', {
        displayName: 'Charlie',
        isWaitingForPermission: true,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    ];
    const onOpenSplit = vi.fn();
    render({ onOpenSplit });
    const timeHeader = Array.from(container!.querySelectorAll('th')).find(
      (header) => header.textContent?.includes('Time'),
    )!;
    act(() => click(timeHeader.querySelector('button')!));
    act(() => click(selectAllCheckbox()));
    const splitButton = footerButton('Open in split') as HTMLButtonElement;
    act(() =>
      splitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onOpenSplit).toHaveBeenCalledWith(['s-idle', 's-appr']);
  });

  it('surfaces the popup-blocked notice when window.open is blocked', () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    openSpy.mockReturnValue(null); // browser blocked the pop-up
    render();
    act(() => click(selectAllCheckbox()));
    const openInTab = footerButton('Open in new tab') as HTMLButtonElement;
    act(() =>
      openInTab.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(container!.textContent).toContain('Pop-up blocked');
  });

  it('surfaces a refresh failure inline while keeping the last-good rows', () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    sessionsState.error = new Error('daemon unreachable');
    render();
    // The rows stay on screen (not replaced by the empty/error-only state)…
    expect(rowTitles()).toEqual(['One']);
    // …and the failure is still visible rather than silently swallowed.
    expect(container!.textContent).toContain('daemon unreachable');
  });

  it('shows a refresh icon and spins while refreshing', async () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    let finishReload: (() => void) | undefined;
    sessionsReload.mockImplementationOnce(
      () =>
        new Promise<DaemonSessionSummary[]>((resolve) => {
          finishReload = () => resolve(sessionsState.sessions);
        }),
    );
    render();
    const refreshButton = footerButton('Refresh') as HTMLButtonElement;

    expect(refreshButton.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(refreshButton.querySelector('svg')).not.toBeNull();

    act(() => click(refreshButton));
    expect(refreshButton.disabled).toBe(true);
    expect(refreshButton.querySelector('[data-slot="spinner"]')).not.toBeNull();

    await act(async () => {
      finishReload?.();
      await Promise.resolve();
    });
    expect(refreshButton.disabled).toBe(false);
    expect(refreshButton.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it('drops removed session ids while preserving remaining selections', () => {
    sessionsState.sessions = [
      session('a', { displayName: 'A' }),
      session('b', { displayName: 'B' }),
    ];
    render();
    act(() => click(selectAllCheckbox()));
    expect(selectAllCheckbox().getAttribute('data-state')).toBe('checked');

    // 'a' leaves the list, but the still-present 'b' remains selected.
    sessionsState.sessions = [session('b', { displayName: 'B' })];
    rerender();
    expect(selectAllCheckbox().getAttribute('data-state')).toBe('checked');
    expect(container!.textContent).toContain('1 of 1 row(s) selected.');
  });

  it('preserves selection across live status updates', () => {
    sessionsState.sessions = [
      session('a', { displayName: 'A' }),
      session('b', { displayName: 'B' }),
    ];
    render();
    act(() => click(rowCheckbox(rows()[0]!)));
    sessionsState.sessions = [
      session('a', { displayName: 'A', hasActivePrompt: true }),
      session('b', { displayName: 'B' }),
    ];
    rerender();
    expect(container!.textContent).toContain('1 of 2 row(s) selected.');
  });

  it('disables split actions when more than 6 sessions are selected', () => {
    sessionsState.sessions = Array.from({ length: 8 }, (_, i) =>
      session(`s${i}`, { displayName: `S${i}` }),
    );
    const onOpenSplit = vi.fn();
    render({ onOpenSplit });
    act(() => click(selectAllCheckbox())); // all rows selected
    const openInTab = footerButton('Open in new tab') as HTMLButtonElement;
    const splitButton = footerButton('Open in split') as HTMLButtonElement;
    expect(openInTab.disabled).toBe(true);
    expect(splitButton.disabled).toBe(true);
    expect(openInTab.title).toBe(
      'Select at most 6 sessions to open them together',
    );
    expect(openSpy).not.toHaveBeenCalled();
    expect(onOpenSplit).not.toHaveBeenCalled();
  });

  it('defaults to 50 rows per page and supports 10, 50, and 100', () => {
    sessionsState.sessions = Array.from({ length: 120 }, (_, i) =>
      session(`s${i}`, { displayName: `S${i}` }),
    );
    render();
    expect(rows()).toHaveLength(50);
    expect(container!.textContent).toContain('Page 1 of 3');
    const trigger = container!.querySelector(
      'button[aria-label="Rows per page"]',
    ) as HTMLElement;
    act(() => click(trigger));
    expect(
      Array.from(document.querySelectorAll('[role="option"]')).map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(['10', '50', '100']);
    const option100 = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((option) => option.textContent?.trim() === '100') as HTMLElement;
    act(() => click(option100));
    expect(rows()).toHaveLength(100);
    expect(container!.textContent).toContain('Page 1 of 2');
    expect(
      window.localStorage.getItem('qwen-web-shell-session-overview-page-size'),
    ).toBe('100');
    const next = footerButton('Next') as HTMLButtonElement;
    act(() => next.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(rows()).toHaveLength(20);
    expect(container!.textContent).toContain('Page 2 of 2');
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    render();
    expect(rows()).toHaveLength(100);
    expect(
      container!.querySelector('button[aria-label="Rows per page"]')
        ?.textContent,
    ).toContain('100');
  });

  it('keeps the toolbar and pagination responsive on narrow screens', () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render();

    const search = container!.querySelector(
      'input[aria-label="Search sessions…"]',
    ) as HTMLInputElement;
    expect(search.parentElement?.className).toContain('w-full');
    expect(search.parentElement?.className).toContain('max-w-[300px]');

    const rowsPerPage = Array.from(container!.querySelectorAll('span')).find(
      (element) => element.textContent === 'Rows per page',
    );
    expect(rowsPerPage?.parentElement?.className).toContain('flex-wrap');
    expect(rowsPerPage?.parentElement?.className).toContain('min-w-0');
  });

  it('keeps the current page when live session data changes', async () => {
    window.localStorage.setItem(
      'qwen-web-shell-session-overview-page-size',
      '10',
    );
    sessionsState.sessions = Array.from({ length: 15 }, (_, i) =>
      session(`s${i}`, {
        displayName: `S${i}`,
        updatedAt: new Date(2026, 0, 15 - i).toISOString(),
      }),
    );
    render();
    act(() => click(footerButton('Next')!));
    expect(container!.textContent).toContain('Page 2 of 2');
    expect(rows()).toHaveLength(5);

    sessionsState.sessions = sessionsState.sessions.map((item) =>
      item.sessionId === 's0' ? { ...item, hasActivePrompt: true } : item,
    );
    rerender();
    await flushAsync();

    expect(container!.textContent).toContain('Page 2 of 2');
    expect(rows()).toHaveLength(5);
  });

  it('selects every session across pages like the old overview', () => {
    sessionsState.sessions = Array.from({ length: 60 }, (_, i) =>
      session(`s${i}`, { displayName: `S${i}` }),
    );
    render();
    expect(rows()).toHaveLength(50);
    act(() => click(selectAllCheckbox()));
    expect(container!.textContent).toContain('60 of 60 row(s) selected.');
  });

  it('lists an other-workspace session as a row with its folder', async () => {
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
    };
    workspaceCapabilities = {
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
      ],
    };
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync(); // let the other-workspace fan-out resolve
    // The non-primary session shows up as its own row…
    expect(rowTitles()).toContain('Beta');
    // …with its workspace display name in the folder column.
    expect(container!.textContent).toContain('Payments API');
    expect(
      container!.querySelector('button[aria-label="Filter by workspace"]'),
    ).not.toBeNull();
  });

  it('does not query other workspaces on a single-workspace daemon', async () => {
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    render();
    await flushAsync();
    expect(workspaceClient.listWorkspaceSessionsPage).not.toHaveBeenCalled();
  });

  it('filters rows by search query and shows a no-match state', () => {
    sessionsState.sessions = [
      session('a', { displayName: 'Alpha' }),
      session('b', { displayName: 'Beta' }),
    ];
    render();
    const input = container!.querySelector(
      '[aria-label="Search sessions…"]',
    ) as HTMLInputElement;
    act(() => {
      setInputValue(input, 'Alpha');
    });
    expect(rowTitles()).toEqual(['Alpha']);
    act(() => {
      setInputValue(input, 'zzz');
    });
    const empty = container!.querySelector('[data-slot="data-table-empty"]');
    expect(empty?.closest('tbody')).not.toBeNull();
    expect(empty?.textContent).toContain('No data');
    expect(container!.textContent).not.toContain('No sessions matching');
  });

  it('filters rows by workspace via the multi-select panel', async () => {
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
      workspaces: [
        {
          id: 'w0',
          cwd: '/w',
          displayName: 'Main',
          primary: true,
          trusted: true,
        },
        {
          id: 'w1',
          cwd: '/wsB',
          displayName: 'Payments',
          primary: false,
          trusted: true,
        },
      ],
    };
    sessionsState.sessions = [session('a', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync();
    expect(rowTitles()).toContain('Alpha');
    expect(rowTitles()).toContain('Beta');
    const trigger = container!.querySelector(
      'button[aria-label="Filter by workspace"]',
    ) as HTMLElement;
    expect(trigger.closest('th')?.textContent).toContain('Workspace');
    expect(trigger.querySelector('.lucide-funnel')).not.toBeNull();
    act(() => click(trigger));
    const filterPanel = document.querySelector(
      '[role="dialog"][aria-label="Filter by workspace"]',
    ) as HTMLElement;
    expect(filterPanel).not.toBeNull();
    expect(filterPanel.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
    expect(filterPanel.textContent).toContain('All');
    expect(filterPanel.textContent).toContain('Main');
    expect(filterPanel.textContent).toContain('Payments');
    const main = filterPanel.querySelector(
      '#session-overview-workspace-0',
    ) as HTMLElement;
    act(() => click(main));
    expect(rowTitles()).toEqual(['Beta']);

    const payments = document.querySelector(
      '#session-overview-workspace-1',
    ) as HTMLElement;
    act(() => click(payments));
    expect(
      container!.querySelector('[data-slot="data-table-empty"]')?.textContent,
    ).toContain('No data');
    expect(
      container!.querySelector('button[aria-label="Filter by workspace"]'),
    ).not.toBeNull();

    const all = document.querySelector(
      '#session-overview-workspace-all',
    ) as HTMLElement;
    act(() => click(all));
    expect(rowTitles()).toEqual(['Alpha', 'Beta']);
  });

  it('hides the workspace filter when the panel is locked to a workspace', () => {
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('a', { displayName: 'Alpha' })];
    render({ onOpenSplit: undefined });
    // Re-render locked to a single workspace — the filter disappears.
    act(() =>
      root!.render(
        <I18nProvider language="en">
          <SessionOverviewPanel
            onOpenSession={onOpenSession}
            workspaceCwd="/w"
          />
        </I18nProvider>,
      ),
    );
    expect(
      container!.querySelector('button[aria-label="Filter by workspace"]'),
    ).toBeNull();
  });

  it('shows all available row actions without a menu', () => {
    connectionState.capabilities = {
      features: ['workspace_session_metadata', 'session_export'],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render();
    const row = rows()[0]!;
    expect(rowActionButton(row, 'Rename')).not.toBeNull();
    expect(rowActionButton(row, 'Export conversation record')).not.toBeNull();
    expect(rowActionButton(row, 'Archive')).not.toBeNull();
    expect(rowActionButton(row, 'Delete')).not.toBeNull();
    expect(rowActionButton(row, 'Rename').textContent).toBe('');
    expect(rowActionButton(row, 'Rename').querySelector('svg')).not.toBeNull();
    expect(rowActionButton(row, 'Rename').className).toContain(
      'text-muted-foreground',
    );
    expect(rowActionButton(row, 'Rename').className).toContain(
      'hover:text-foreground',
    );
    expect(rowActionButton(row, 'Delete').className).toContain(
      'text-destructive',
    );
    expect(
      rowActionButton(row, 'Export conversation record').querySelector('svg'),
    ).not.toBeNull();
    expect(row.querySelector('[data-slot="dropdown-menu-trigger"]')).toBeNull();
  });

  it('labels and pins opaque edge columns without borders', () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render();
    const headers = Array.from(container!.querySelectorAll('thead th'));
    const cells = Array.from(rows()[0]!.querySelectorAll('td'));
    const renderedTable = container!.querySelector(
      '[data-slot="table"]',
    ) as HTMLTableElement;
    expect(renderedTable.dataset.layout).toBe('scroll');
    expect(renderedTable.style.minWidth).toBe('912px');
    expect(renderedTable.style.tableLayout).toBe('fixed');
    expect(renderedTable.querySelectorAll('col')).toHaveLength(headers.length);
    expect(
      (renderedTable.querySelectorAll('col')[1] as HTMLTableColElement).style
        .width,
    ).toBe('224px');
    expect(headers.at(-1)?.textContent).toContain('Actions');
    expect(headers.at(-1)?.className).toContain('text-center');
    expect((headers.at(-1) as HTMLElement).style.width).toBe('128px');
    expect((cells.at(-1) as HTMLElement).style.width).toBe('128px');
    expect(cells.at(-1)?.firstElementChild?.className).toContain(
      'justify-center',
    );
    const timeHeader = headers.find((header) =>
      header.textContent?.includes('Time'),
    );
    const sessionIdHeader = headers.find((header) =>
      header.textContent?.includes('Session ID'),
    );
    const gitHeader = headers.find(
      (header) => header.textContent === 'Worktree',
    );
    const workspaceHeader = headers.find((header) =>
      header.textContent?.includes('Workspace'),
    );
    const sessionIdColumnIndex = headers.indexOf(sessionIdHeader!);
    expect((gitHeader as HTMLElement).style.width).toBe('144px');
    expect(cells[2]?.firstElementChild?.className).toContain('truncate');
    expect((sessionIdHeader as HTMLElement).style.width).toBe('136px');
    expect((cells[sessionIdColumnIndex] as HTMLElement).style.width).toBe(
      '136px',
    );
    expect((workspaceHeader as HTMLElement).style.width).toBe('128px');
    expect((timeHeader as HTMLElement).style.width).toBe('112px');
    const timeSortButton = timeHeader?.querySelector('button');
    expect(timeSortButton?.className).toContain('px-0');
    expect(timeSortButton?.className).toContain('text-sm');
    expect(timeSortButton?.className).not.toContain('text-xs');
    expect(timeHeader?.getAttribute('aria-sort')).toBeNull();
    act(() => click(timeHeader!.querySelector('button')!));
    expect(timeHeader?.getAttribute('aria-sort')).toBe('ascending');
    expect(headers[0]?.className).toContain('sticky');
    expect((headers[0] as HTMLElement).style.left).toBe('0px');
    expect((headers[0] as HTMLElement).style.width).toBe('40px');
    expect(headers[1]?.className).toContain('sticky');
    expect((headers[1] as HTMLElement).style.left).toBe('40px');
    expect((headers[1] as HTMLElement).style.width).toBe('224px');
    expect(headers.at(-1)?.className).toContain('sticky');
    expect((headers.at(-1) as HTMLElement).style.right).toBe('0px');
    expect(cells[0]?.className).toContain('sticky');
    expect((cells[0] as HTMLElement).style.left).toBe('0px');
    expect((cells[0] as HTMLElement).style.width).toBe('40px');
    expect(cells[1]?.className).toContain('sticky');
    expect((cells[1] as HTMLElement).style.left).toBe('40px');
    expect((cells[1] as HTMLElement).style.width).toBe('224px');
    expect(titleTrigger(rows()[0]!).closest('.truncate')).not.toBeNull();
    expect(titleTrigger(rows()[0]!).className).toContain('text-xs');
    expect(cells[1]?.querySelector('.font-semibold')).not.toBeNull();
    for (const cell of cells.slice(2, 6)) {
      expect(cell.querySelector('.text-muted-foreground')).toBeNull();
      expect(cell.querySelector('.text-current')).not.toBeNull();
    }
    expect(cells.at(-1)?.className).toContain('sticky');
    expect((cells.at(-1) as HTMLElement).style.right).toBe('0px');
    expect(headers[0]?.className).not.toContain('border-r');
    expect(headers.at(-1)?.className).not.toContain('border-l');
    expect(cells[0]?.className).toContain('bg-background');
    expect(cells[1]?.className).toContain('bg-background');
    expect(cells.at(-1)?.className).toContain('bg-background');
    expect(cells[0]?.className).toContain('transition-colors');
    expect(cells[1]?.className).toContain('transition-colors');
    expect(cells.at(-1)?.className).toContain('transition-colors');
    expect(cells[0]?.className).toContain(
      'group-hover:bg-[color-mix(in_srgb,var(--muted)_50%,var(--background))]',
    );
    expect(cells[0]?.className).not.toContain('group-hover:bg-muted/50');
    const footer = container!.querySelector(
      '[data-web-shell-session-footer]',
    ) as HTMLElement;
    expect(footer.className).not.toContain('sticky bottom-0');
    expect(footer.className).not.toContain('border-t');
  });

  it('distributes flexible columns only when the table fits without scrolling', () => {
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    try {
      sessionsState.sessions = [session('s1', { displayName: 'One' })];
      render();
      const scroller = container!.querySelector(
        '[data-slot="table-container"]',
      ) as HTMLElement;
      Object.defineProperties(scroller, {
        clientWidth: { configurable: true, value: 1200 },
        scrollWidth: { configurable: true, value: 1200 },
      });
      act(() =>
        resizeCallbacks.forEach((callback) =>
          callback([], {} as ResizeObserver),
        ),
      );
      const table = container!.querySelector(
        '[data-slot="table"]',
      ) as HTMLTableElement;
      const headers = Array.from(container!.querySelectorAll('thead th'));
      expect(table.dataset.layout).toBe('fluid');
      expect(table.style.tableLayout).toBe('fixed');
      expect(
        parseFloat((headers[1] as HTMLElement).style.width),
      ).toBeGreaterThan(224);
      expect((headers[1] as HTMLElement).style.minWidth).toBe('224px');
      expect((headers.at(-1) as HTMLElement).style.width).toBe('128px');
      const columnWidth = Array.from(table.querySelectorAll('col')).reduce(
        (total, column) => total + parseFloat(column.style.width),
        0,
      );
      expect(columnWidth).toBeCloseTo(1200);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('sticks and separates the footer only while the panel overflows', () => {
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    const observedTargets = new Set<Element>();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback);
      }
      observe(target: Element) {
        observedTargets.add(target);
      }
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    try {
      sessionsState.sessions = [session('s1', { displayName: 'One' })];
      render();
      const panel = container!.querySelector(
        '[data-web-shell-session-panel]',
      ) as HTMLElement;
      const viewport = panel.parentElement!;
      const footer = container!.querySelector(
        '[data-web-shell-session-footer]',
      ) as HTMLElement;
      const tableViewport = container!.querySelector(
        '[data-web-shell-session-table-viewport]',
      ) as HTMLElement;
      const horizontalScroller = container!.querySelector(
        '[data-slot="table-container"]',
      ) as HTMLElement;
      expect(observedTargets.has(tableViewport)).toBe(true);
      Object.defineProperties(panel, {
        scrollHeight: { configurable: true, value: 600 },
      });
      Object.defineProperties(tableViewport, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, value: 200 },
      });
      Object.defineProperties(horizontalScroller, {
        scrollLeft: { configurable: true, writable: true, value: 0 },
        clientWidth: { configurable: true, value: 500 },
        scrollWidth: { configurable: true, value: 900 },
      });
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 400 },
      });
      act(() =>
        resizeCallbacks.forEach((callback) =>
          callback([], {} as ResizeObserver),
        ),
      );
      expect(footer.className).toContain('sticky bottom-0');
      expect(footer.className).toContain('border-t');
      expect(footer.className).toContain('bg-background');
      expect(footer.className).toContain('-mb-4');
      expect(panel.className).toContain('panelOverflowing');
      expect(tableViewport.className).toContain('tableViewportOverflowing');
      const headers = Array.from(container!.querySelectorAll('thead th'));
      expect(headers[1]?.className).not.toContain('after:shadow-');
      expect(headers.at(-1)?.className).toContain(
        'after:shadow-[inset_-10px_0_8px_-8px_var(--border)]',
      );

      Object.defineProperties(panel, {
        scrollHeight: { configurable: true, value: 300 },
      });
      act(() =>
        resizeCallbacks.forEach((callback) =>
          callback([], {} as ResizeObserver),
        ),
      );
      expect(footer.className).not.toContain('sticky bottom-0');
      expect(footer.className).not.toContain('border-t');
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('adds inward shadows to fixed columns while horizontally scrolled', () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render();
    const scrollContainer = container!.querySelector(
      '[data-slot="table-container"]',
    ) as HTMLElement;
    Object.defineProperties(scrollContainer, {
      scrollLeft: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 500 },
      scrollWidth: { configurable: true, value: 900 },
    });
    act(() => scrollContainer.dispatchEvent(new Event('scroll')));
    const cells = Array.from(rows()[0]!.querySelectorAll('td'));
    expect(cells[0]?.className).not.toContain('after:shadow-');
    expect(cells[1]?.className).toContain(
      'after:shadow-[inset_10px_0_8px_-8px_var(--border)]',
    );
    expect(cells.at(-1)?.className).toContain(
      'after:shadow-[inset_-10px_0_8px_-8px_var(--border)]',
    );
  });

  it('archives a primary-workspace session from its row action', async () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render();
    act(() => click(rowActionButton(rows()[0]!, 'Archive')));
    expect(document.body.textContent).toContain('Archive session?');
    expect(workspaceActions.archiveSession).not.toHaveBeenCalled();
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(workspaceClient.archiveSessionsData).toHaveBeenCalledWith(['s1']);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('archives the current session and clears it after success', async () => {
    connectionState.sessionId = 's1';
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render({ onCurrentSessionRemoved });
    expect(rowActionButton(rows()[0]!, 'Archive').disabled).toBe(false);
    expect(rowActionButton(rows()[0]!, 'Delete').disabled).toBe(false);
    act(() => click(rowActionButton(rows()[0]!, 'Archive')));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(workspaceClient.archiveSessionsData).toHaveBeenCalledWith(['s1']);
    expect(onCurrentSessionRemoved).toHaveBeenCalledOnce();
  });

  it('treats an already-missing current session as archived', async () => {
    connectionState.sessionId = 's1';
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    workspaceClient.archiveSessionsData.mockResolvedValueOnce({
      archived: [],
      alreadyArchived: [],
      notFound: ['s1'],
      errors: [],
    });
    render({ onCurrentSessionRemoved });
    act(() => click(rowActionButton(rows()[0]!, 'Archive')));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();

    expect(onCurrentSessionRemoved).toHaveBeenCalledOnce();
    expect(container!.textContent).not.toContain('Failed to archive session');
  });

  it('deletes the current session and clears it after success', async () => {
    connectionState.sessionId = 's1';
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render({ onCurrentSessionRemoved });
    act(() => click(rowActionButton(rows()[0]!, 'Delete')));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(workspaceClient.deleteSessionsData).toHaveBeenCalledWith(['s1']);
    expect(onCurrentSessionRemoved).toHaveBeenCalledOnce();
  });

  it.each([
    ['Archive', 'archiveSessionsData', 'Failed to archive session'],
    ['Delete', 'deleteSessionsData', 'Failed to delete session'],
  ] as const)(
    'does not clear the current session when %s fails',
    async (label, action, error) => {
      connectionState.sessionId = 's1';
      sessionsState.sessions = [session('s1', { displayName: 'One' })];
      workspaceClient[action].mockRejectedValueOnce(new Error('daemon busy'));
      render({ onCurrentSessionRemoved });

      act(() => click(rowActionButton(rows()[0]!, label)));
      const confirm = document.querySelector(
        '[data-slot="alert-dialog-action"]',
      ) as HTMLElement;
      act(() => click(confirm));
      await flushAsync();

      expect(onCurrentSessionRemoved).not.toHaveBeenCalled();
      expect(container!.textContent).toContain(`${error}: daemon busy`);
    },
  );

  it.each([
    [
      'Archive',
      'archiveSessionsData',
      { archived: ['s1'], alreadyArchived: [], notFound: [], errors: [] },
    ],
    [
      'Delete',
      'deleteSessionsData',
      { removed: ['s1'], notFound: [], errors: [] },
    ],
  ] as const)(
    'does not clear a newly selected session when %s finishes',
    async (label, action, result) => {
      connectionState.sessionId = 's1';
      sessionsState.sessions = [
        session('s1', { displayName: 'One' }),
        session('s2', { displayName: 'Two' }),
      ];
      let resolveMutation!: (value: typeof result) => void;
      workspaceClient[action].mockReturnValueOnce(
        new Promise<typeof result>((resolve) => {
          resolveMutation = resolve;
        }),
      );
      render({ onCurrentSessionRemoved });

      const one = rows().find((row) => row.textContent?.includes('One'))!;
      act(() => click(rowActionButton(one, label)));
      const confirm = document.querySelector(
        '[data-slot="alert-dialog-action"]',
      ) as HTMLElement;
      act(() => click(confirm));
      expect(workspaceClient[action]).toHaveBeenCalledWith(['s1']);

      connectionState.sessionId = 's2';
      rerender({ onCurrentSessionRemoved });
      await act(async () => resolveMutation(result));
      await flushAsync();

      expect(onCurrentSessionRemoved).not.toHaveBeenCalled();
    },
  );

  it('disables unsupported archive and qualified workspace mutations', async () => {
    connectionState.capabilities = {
      features: ['session_archive'],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('a', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync();
    const alpha = rows().find((row) => row.textContent?.includes('Alpha'))!;
    const beta = rows().find((row) => row.textContent?.includes('Beta'))!;
    expect(rowActionButton(alpha, 'Archive').disabled).toBe(false);
    expect(rowActionButton(beta, 'Archive').disabled).toBe(true);
    expect(rowActionButton(beta, 'Delete').disabled).toBe(true);

    connectionState.capabilities = {
      ...connectionState.capabilities,
      features: ['workspace_qualified_rest_core'],
    };
    rerender();
    expect(rowActionButton(rows()[0]!, 'Archive').disabled).toBe(true);
  });

  it('rejects mutations for unknown and untrusted workspace scopes', () => {
    connectionState.sessionId = 'untrusted';
    connectionState.capabilities = {
      features: [
        'session_archive',
        'workspace_qualified_rest_core',
        'workspace_session_metadata',
        'workspace_session_export',
      ],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/untrusted', primary: false, trusted: false },
      ],
    };
    sessionsState.sessions = [
      session('unknown', {
        workspaceCwd: '/unknown',
        displayName: 'Unknown',
      }),
      session('untrusted', {
        workspaceCwd: '/untrusted',
        displayName: 'Untrusted',
      }),
    ];
    render();

    for (const title of ['Unknown', 'Untrusted']) {
      const row = rows().find((item) => item.textContent?.includes(title))!;
      for (const action of [
        'Rename',
        'Export conversation record',
        'Archive',
        'Delete',
      ]) {
        expect(rowActionButton(row, action).disabled).toBe(true);
      }
    }
  });

  it('routes archive for an other-workspace session through the qualified client', async () => {
    connectionState.capabilities = {
      features: ['session_archive', 'workspace_qualified_rest_core'],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('a', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync();
    const beta = rows().find((tr) => tr.textContent?.includes('Beta'))!;
    act(() => click(rowActionButton(beta, 'Archive')));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(workspaceClient.workspaceByCwd).toHaveBeenCalledWith('/wsB');
    // The mutation used the client returned by workspaceByCwd; grab that same
    // instance from the mock results (each call builds a fresh object).
    const qualified = workspaceClient.workspaceByCwd.mock.results.at(-1)!.value;
    expect(qualified.archiveSessionsData).toHaveBeenCalledWith(['b1']);
  });

  it('deletes a session through the confirm dialog', async () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render();
    act(() => click(rowActionButton(rows()[0]!, 'Delete')));
    // The destructive confirm dialog is shown with the session name.
    expect(document.body.textContent).toContain('Delete session?');
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(workspaceClient.deleteSessionsData).toHaveBeenCalledWith(['s1']);
  });

  it('batch-archives the selected sessions', async () => {
    workspaceClient.archiveSessionsData.mockResolvedValueOnce({
      archived: ['a'],
      alreadyArchived: [],
      notFound: ['b'],
      errors: [],
    });
    sessionsState.sessions = [
      session('a', { displayName: 'A' }),
      session('b', { displayName: 'B' }),
    ];
    render();
    act(() => click(selectAllCheckbox()));
    act(() => click(footerButton('Archive')!));
    expect(document.body.textContent).toContain('Archive 2 sessions?');
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(workspaceClient.archiveSessionsData).toHaveBeenCalledOnce();
    expect(workspaceClient.archiveSessionsData).toHaveBeenCalledWith([
      'a',
      'b',
    ]);
    expect(container!.textContent).not.toContain('Failed to archive session');
  });

  it('disables row actions while a batch mutation is running', async () => {
    connectionState.sessionId = 's1';
    connectionState.capabilities = {
      features: ['session_archive', 'session_export'],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    let resolveArchive!: (value: {
      archived: string[];
      alreadyArchived: string[];
      notFound: string[];
      errors: [];
    }) => void;
    workspaceClient.archiveSessionsData.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveArchive = resolve;
      }),
    );
    let resolveReload!: (value: DaemonSessionSummary[]) => void;
    sessionsReload.mockReturnValueOnce(
      new Promise<DaemonSessionSummary[]>((resolve) => {
        resolveReload = resolve;
      }),
    );
    render();
    act(() => click(rowCheckbox(rows()[0]!)));
    act(() => click(footerButton('Archive')!));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));

    expect(rowActionButton(rows()[0]!, 'Rename').disabled).toBe(true);
    expect(
      rowActionButton(rows()[0]!, 'Export conversation record').disabled,
    ).toBe(true);

    await act(async () =>
      resolveArchive({
        archived: ['s1'],
        alreadyArchived: [],
        notFound: [],
        errors: [],
      }),
    );
    await flushAsync();
    expect(rowActionButton(rows()[0]!, 'Rename').disabled).toBe(true);
    await act(async () => resolveReload(sessionsState.sessions));
    await flushAsync();
    expect(rowActionButton(rows()[0]!, 'Rename').disabled).toBe(false);
    expect(
      rowActionButton(rows()[0]!, 'Export conversation record').disabled,
    ).toBe(false);
  });

  it('batch-deletes the selected sessions after confirmation', async () => {
    workspaceClient.deleteSessionsData.mockResolvedValueOnce({
      removed: ['a'],
      notFound: ['b'],
      errors: [],
    });
    sessionsState.sessions = [
      session('a', { displayName: 'A' }),
      session('b', { displayName: 'B' }),
    ];
    render();
    act(() => click(selectAllCheckbox()));
    act(() => click(footerButton('Delete')!));
    // The bulk confirm dialog names the count.
    expect(document.body.textContent).toContain('Delete 2 sessions?');
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(workspaceClient.deleteSessionsData).toHaveBeenCalledOnce();
    expect(workspaceClient.deleteSessionsData).toHaveBeenCalledWith(['a', 'b']);
    expect(container!.textContent).not.toContain('Failed to delete session');
  });

  it('clears a deleted current session after a partial batch failure', async () => {
    connectionState.sessionId = 'current';
    connectionState.capabilities = {
      features: ['session_archive', 'workspace_qualified_rest_core'],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [
      session('current', {
        displayName: 'Current',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    ];
    otherWorkspaceSessions['/wsB'] = [
      session('secondary', {
        workspaceCwd: '/wsB',
        displayName: 'Secondary',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    const qualified = workspaceClient.workspaceByCwd('/wsB');
    qualified.deleteSessionsData.mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [{ sessionId: 'secondary', error: 'locked' }],
    });
    workspaceClient.workspaceByCwd.mockReturnValue(qualified);

    render({ onCurrentSessionRemoved });
    await flushAsync();
    act(() => click(selectAllCheckbox()));
    act(() => click(footerButton('Delete')!));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    sessionsReload.mockClear();
    act(() => click(confirm));
    await flushAsync();

    expect(workspaceClient.deleteSessionsData).toHaveBeenCalledWith([
      'current',
    ]);
    expect(onCurrentSessionRemoved).toHaveBeenCalledOnce();
    expect(sessionsReload).toHaveBeenCalled();
    expect(container!.textContent).toContain(
      'Failed to delete session: locked',
    );
  });

  it('surfaces a failure to clear the deleted current session', async () => {
    connectionState.sessionId = 's1';
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    onCurrentSessionRemoved.mockResolvedValue(false);
    render({ onCurrentSessionRemoved });
    act(() => click(rowActionButton(rows()[0]!, 'Delete')));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(container!.textContent).toContain(
      'Failed to delete session: Failed to create a new chat',
    );
  });

  it('renames the current session inline from its row action', async () => {
    connectionState.sessionId = 's1';
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    let resolveReload!: (value: DaemonSessionSummary[]) => void;
    sessionsReload.mockReturnValueOnce(
      new Promise<DaemonSessionSummary[]>((resolve) => {
        resolveReload = resolve;
      }),
    );
    render();
    act(() => click(rowActionButton(rows()[0]!, 'Rename')));
    const input = container!.querySelector(
      'input[aria-label="Rename: One"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.closest('.truncate')).toBeNull();
    act(() => setInputValue(input, 'Renamed'));
    const form = input.closest('form')!;
    act(() =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await flushAsync();
    // The current session renames through its own session actions.
    expect(workspaceActions.renameSession).toHaveBeenCalledWith('Renamed');
    expect(rowActionButton(rows()[0]!, 'Rename').disabled).toBe(true);
    await act(async () => resolveReload(sessionsState.sessions));
    await flushAsync();
    expect(rowActionButton(rows()[0]!, 'Rename').disabled).toBe(false);
  });

  it('renames the current trusted secondary session from the global overview', async () => {
    connectionState.sessionId = 'b1';
    connectionState.workspaceCwd = '/wsB';
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('a', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync();

    const beta = rows().find((row) => row.textContent?.includes('Beta'))!;
    const rename = rowActionButton(beta, 'Rename');
    expect(rename.disabled).toBe(false);
    act(() => click(rename));
    const input = container!.querySelector(
      'input[aria-label="Rename: Beta"]',
    ) as HTMLInputElement;
    act(() => setInputValue(input, 'Renamed Beta'));
    act(() =>
      input
        .closest('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    await flushAsync();

    expect(workspaceActions.renameSession).toHaveBeenCalledWith('Renamed Beta');
  });

  it('renames the current session in a locked legacy secondary workspace', async () => {
    connectionState.sessionId = 'b1';
    connectionState.workspaceCwd = '';
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render({ workspaceCwd: '/wsB' });

    const rename = rowActionButton(rows()[0]!, 'Rename');
    expect(rename.disabled).toBe(false);
    act(() => click(rename));
    const input = container!.querySelector(
      'input[aria-label="Rename: Beta"]',
    ) as HTMLInputElement;
    act(() => setInputValue(input, 'Renamed Beta'));
    act(() =>
      input
        .closest('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    await flushAsync();

    expect(workspaceActions.renameSession).toHaveBeenCalledWith('Renamed Beta');
  });

  it('does not rename a new current session from a stale editor', async () => {
    connectionState.sessionId = 's1';
    connectionState.capabilities = { features: [], workspaceCwd: '/w' };
    sessionsState.sessions = [
      session('s1', { displayName: 'One' }),
      session('s2', { displayName: 'Two' }),
    ];
    render();
    const one = rows().find((row) => row.textContent?.includes('One'))!;
    act(() => click(rowActionButton(one, 'Rename')));
    const input = container!.querySelector(
      'input[aria-label="Rename: One"]',
    ) as HTMLInputElement;
    act(() => setInputValue(input, 'Renamed One'));

    connectionState.sessionId = 's2';
    rerender();
    act(() =>
      input
        .closest('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    await flushAsync();

    expect(workspaceActions.renameSession).not.toHaveBeenCalled();
  });

  it('renames an other-workspace session through the qualified client', async () => {
    connectionState.capabilities = {
      features: ['workspace_session_metadata', 'workspace_qualified_rest_core'],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('a', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync();
    const beta = rows().find((tr) => tr.textContent?.includes('Beta'))!;
    act(() => click(rowActionButton(beta, 'Rename')));
    const input = container!.querySelector(
      'input[aria-label="Rename: Beta"]',
    ) as HTMLInputElement;
    act(() => setInputValue(input, 'Renamed Beta'));
    const form = input.closest('form')!;
    act(() =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await flushAsync();
    const qualified = workspaceClient.workspaceByCwd.mock.results.at(-1)!.value;
    expect(qualified.updateSessionMetadata).toHaveBeenCalledWith('b1', {
      displayName: 'Renamed Beta',
    });
  });

  it('exports a session as an html download', async () => {
    connectionState.capabilities = {
      features: ['session_export'],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    render();
    act(() => click(rowActionButton(rows()[0]!, 'Export conversation record')));
    await flushAsync();
    expect(workspaceActions.exportSession).toHaveBeenCalledWith('s1', 'html');
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalled();
  });

  it('exports a trusted other-workspace session when supported', async () => {
    connectionState.capabilities = {
      features: ['workspace_session_export'],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('a', { displayName: 'Alpha' })];
    otherWorkspaceSessions['/wsB'] = [
      session('b1', { workspaceCwd: '/wsB', displayName: 'Beta' }),
    ];
    render();
    await flushAsync();
    const alpha = rows().find((row) => row.textContent?.includes('Alpha'))!;
    const beta = rows().find((row) => row.textContent?.includes('Beta'))!;
    expect(rowActionButton(alpha, 'Export conversation record').disabled).toBe(
      true,
    );
    const exportBeta = rowActionButton(beta, 'Export conversation record');
    expect(exportBeta.disabled).toBe(false);
    act(() => click(exportBeta));
    await flushAsync();
    const qualified = workspaceClient.workspaceByCwd.mock.results.at(-1)!.value;
    expect(qualified.exportSession).toHaveBeenCalledWith('b1', {
      format: 'html',
    });
  });

  it('surfaces an archive failure in the notice area', async () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    workspaceClient.archiveSessionsData.mockRejectedValueOnce(
      new Error('daemon busy'),
    );
    render();
    act(() => click(rowActionButton(rows()[0]!, 'Archive')));
    const confirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(confirm));
    await flushAsync();
    expect(container!.textContent).toContain('Failed to archive session');

    workspaceClient.archiveSessionsData.mockResolvedValueOnce({
      archived: ['s1'],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    });
    act(() => click(rowActionButton(rows()[0]!, 'Archive')));
    const retryConfirm = document.querySelector(
      '[data-slot="alert-dialog-action"]',
    ) as HTMLElement;
    act(() => click(retryConfirm));
    await flushAsync();
    expect(container!.textContent).not.toContain('Failed to archive session');
  });

  it('surfaces a rename failure in the notice area', async () => {
    connectionState.sessionId = 's1';
    connectionState.capabilities = {
      features: ['workspace_session_metadata'],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    workspaceActions.renameSession.mockRejectedValue(new Error('locked'));
    render();
    act(() => click(rowActionButton(rows()[0]!, 'Rename')));
    const input = container!.querySelector(
      'input[aria-label="Rename: One"]',
    ) as HTMLInputElement;
    act(() => setInputValue(input, 'Renamed'));
    const form = input.closest('form')!;
    act(() =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await flushAsync();
    expect(container!.textContent).toContain('Failed to rename session');
  });
});

describe('SessionOverviewPanel polling', () => {
  it('keeps the old status-report details fresh', async () => {
    sessionsState.sessions = [session('s')];
    vi.useFakeTimers();
    try {
      render();
      statusReload.mockClear();
      await vi.advanceTimersByTimeAsync(10000);
      expect(statusReload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls the session list on an interval when live-state is unavailable', async () => {
    sessionsState.sessions = [session('s')];
    vi.useFakeTimers();
    try {
      render();
      sessionsReload.mockClear();
      await vi.advanceTimersByTimeAsync(3100);
      expect(sessionsReload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the catalog poll for a single-workspace live-state daemon', () => {
    connectionState.capabilities = {
      features: ['workspace_session_live_state'],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s')];
    render();
    expect(scopedSessionsOptions.pollIntervalMs).toBeUndefined();
    expect(statusReportOptions).toEqual({ autoLoad: false, detail: 'full' });
  });

  it('does not poll full status when live-state is available', async () => {
    connectionState.capabilities = {
      features: ['workspace_session_live_state'],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s')];
    vi.useFakeTimers();
    try {
      render();
      statusReload.mockClear();
      await vi.advanceTimersByTimeAsync(20000);
      expect(statusReload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses sidebar-owned live state without starting a duplicate channel', () => {
    connectionState.capabilities = {
      features: ['workspace_session_live_state'],
      workspaceCwd: '/w',
    };
    sessionsState.sessions = [session('s')];
    render({ manageLiveState: false });
    expect(workspaceLiveStateOptions.enabled).toBe(false);
    expect(scopedSessionsOptions.pollIntervalMs).toBeUndefined();
  });

  it('falls back to the catalog poll without live-state', () => {
    sessionsState.sessions = [session('s')];
    render();
    expect(scopedSessionsOptions.pollIntervalMs).toBe(3000);
  });

  it('skips polling while the tab is hidden', async () => {
    sessionsState.sessions = [session('s')];
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    vi.useFakeTimers();
    try {
      render();
      sessionsReload.mockClear();
      await vi.advanceTimersByTimeAsync(6200);
      expect(sessionsReload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
    }
  });

  it('does not overlap polls while one is still in flight', async () => {
    sessionsState.sessions = [session('s')];
    // A never-resolving reload keeps the in-flight guard set.
    sessionsReload.mockImplementation(() => new Promise<never>(() => {}));
    vi.useFakeTimers();
    try {
      render();
      sessionsReload.mockClear();
      await vi.advanceTimersByTimeAsync(9300); // three list ticks
      expect(sessionsReload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      sessionsReload.mockReset();
      sessionsReload.mockImplementation(async () => sessionsState.sessions);
    }
  });

  it('re-queries other workspaces on each list poll (multi-workspace)', async () => {
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/w',
      workspaces: [
        { id: 'w0', cwd: '/w', primary: true, trusted: true },
        { id: 'w1', cwd: '/wsB', primary: false, trusted: true },
      ],
    };
    sessionsState.sessions = [session('a')];
    otherWorkspaceSessions['/wsB'] = [session('b1', { workspaceCwd: '/wsB' })];
    vi.useFakeTimers();
    try {
      render();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10); // settle the initial fan-out
      });
      workspaceClient.listWorkspaceSessionsPage.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100); // one list-poll tick
      });
      expect(workspaceClient.listWorkspaceSessionsPage).toHaveBeenCalledWith(
        '/wsB',
        expect.objectContaining({ archiveState: 'active' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
