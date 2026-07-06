// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionSummary,
  DaemonStatusReportSession,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// --- Mutable mock state, reset in beforeEach ---
let connectionState: {
  sessionId?: string;
  capabilities?: { features?: string[] };
  workspaceCwd?: string;
};
let sessionsState: {
  sessions: DaemonSessionSummary[];
  loading: boolean;
  error?: Error;
};
let statusState: {
  report?: { full?: { sessions: DaemonStatusReportSession[] } };
};

const sessionsReload = vi.fn(async () => sessionsState.sessions);
const statusReload = vi.fn(async () => statusState.report);

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connectionState,
  useSessions: () => ({ ...sessionsState, reload: sessionsReload }),
  useStatusReport: () => ({ ...statusState, reload: statusReload }),
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
let openSpy: ReturnType<typeof vi.fn>;
const originalOpen = window.open;

beforeEach(() => {
  connectionState = {
    sessionId: 's-run',
    capabilities: { features: [] },
    workspaceCwd: '/w',
  };
  sessionsState = { sessions: [], loading: false };
  statusState = { report: { full: { sessions: [] } } };
  sessionsReload.mockClear();
  statusReload.mockClear();
  onOpenSession = vi.fn();
  openSpy = vi.fn().mockReturnValue({ focus: vi.fn() });
  window.open = openSpy as unknown as typeof window.open;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.open = originalOpen;
});

function render(props: { onOpenSplit?: (ids: string[]) => void } = {}): void {
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

function rerender(props: { onOpenSplit?: (ids: string[]) => void } = {}): void {
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <SessionOverviewPanel onOpenSession={onOpenSession} {...props} />
      </I18nProvider>,
    ),
  );
}

function cardLabels(): string[] {
  return Array.from(container!.querySelectorAll('ul li')).map(
    (li) => li.querySelectorAll('button')[0]?.textContent?.trim() ?? '',
  );
}

function selectAllCheckbox(): HTMLInputElement {
  return container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
}
function tabButton(): HTMLButtonElement {
  return Array.from(container!.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Open in new tab'),
  ) as HTMLButtonElement;
}

describe('deriveSessionCards', () => {
  it('ranks needs-approval above running above idle, then by recency', () => {
    const sessions = [
      session('s-idle', { displayName: 'idle', hasActivePrompt: false }),
      session('s-run', { displayName: 'run', hasActivePrompt: true }),
      session('s-appr', { displayName: 'appr', hasActivePrompt: false }),
    ];
    const status = [statusSession('s-appr', { pendingPermissionCount: 1 })];
    const cards = deriveSessionCards(sessions, status, 's-run');
    expect(cards.map((c) => c.sessionId)).toEqual(['s-appr', 's-run', 's-idle']);
    expect(cards.map((c) => c.status)).toEqual([
      'needsApproval',
      'running',
      'idle',
    ]);
  });

  it('needs-approval wins even when the prompt is also active (blocked turn)', () => {
    const sessions = [session('s', { hasActivePrompt: true })];
    const status = [
      statusSession('s', { hasActivePrompt: true, pendingPermissionCount: 2 }),
    ];
    expect(deriveSessionCards(sessions, status, undefined)[0].status).toBe(
      'needsApproval',
    );
  });

  it('treats sessions absent from the status report as idle', () => {
    const cards = deriveSessionCards([session('cold')], [], undefined);
    expect(cards[0].status).toBe('idle');
  });

  it('labels with displayName, falling back to a short id, and flags current', () => {
    const cards = deriveSessionCards(
      [
        session('abcdef1234567890', {}),
        session('named', { displayName: '  Named  ' }),
      ],
      [],
      'named',
    );
    const byId = new Map(cards.map((c) => [c.sessionId, c]));
    expect(byId.get('abcdef1234567890')!.label).toBe('abcdef12');
    expect(byId.get('named')!.label).toBe('Named');
    expect(byId.get('named')!.isCurrent).toBe(true);
    expect(byId.get('abcdef1234567890')!.isCurrent).toBe(false);
  });

  it('carries model and client count from the status report', () => {
    const cards = deriveSessionCards(
      [session('s', { clientCount: 2 })],
      [statusSession('s', { currentModelId: 'qwen-max', clientCount: 2 })],
      undefined,
    );
    expect(cards[0].model).toBe('qwen-max');
    expect(cards[0].clientCount).toBe(2);
  });
});

describe('SessionOverviewPanel', () => {
  it('renders an empty state when there are no sessions', () => {
    render();
    expect(container!.textContent).toContain('No sessions yet');
  });

  it('renders cards ranked with needs-approval first', () => {
    sessionsState.sessions = [
      session('s-idle', { displayName: 'Bravo' }),
      session('s-run', { displayName: 'Alpha', hasActivePrompt: true }),
      session('s-appr', { displayName: 'Charlie' }),
    ];
    statusState.report = {
      full: { sessions: [statusSession('s-appr', { pendingPermissionCount: 1 })] },
    };
    render();
    expect(cardLabels()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('switches the current session when a card label is clicked', () => {
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    render();
    const label = container!.querySelector('ul li button') as HTMLButtonElement;
    act(() => label.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenSession).toHaveBeenCalledWith('s-run');
  });

  it('always shows selection + the "Open in new tab" batch action', () => {
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    render();
    expect(container!.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container!.textContent).toContain('Open in new tab');
    // The removed Window Management tiling affordance is gone.
    expect(container!.textContent).not.toContain('Tile across displays');
  });

  it('opens the selected sessions as a split in ONE new tab (?split=…)', () => {
    sessionsState.sessions = [
      session('s-idle', { displayName: 'Bravo' }),
      session('s-appr', { displayName: 'Charlie' }),
    ];
    statusState.report = {
      full: { sessions: [statusSession('s-appr', { pendingPermissionCount: 1 })] },
    };
    render();
    const selectAll = container!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => selectAll.click());
    const tabButton = Array.from(container!.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Open in new tab'),
    ) as HTMLButtonElement;
    expect(tabButton.disabled).toBe(false);
    act(() =>
      tabButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // A single new tab whose URL carries the ranked split (needs-approval first).
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target] = openSpy.mock.calls[0];
    expect(target).toBe('_blank');
    expect(decodeURIComponent(String(url))).toContain('split=s-appr,s-idle');
  });

  it('opens the selected sessions in split, in ranked order', () => {
    sessionsState.sessions = [
      session('s-idle', { displayName: 'Bravo' }),
      session('s-appr', { displayName: 'Charlie' }),
    ];
    statusState.report = {
      full: { sessions: [statusSession('s-appr', { pendingPermissionCount: 1 })] },
    };
    const onOpenSplit = vi.fn();
    render({ onOpenSplit });
    const selectAll = container!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => selectAll.click());
    const splitButton = Array.from(container!.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Open in split'),
    ) as HTMLButtonElement;
    act(() =>
      splitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // needs-approval (Charlie) is ranked ahead of idle (Bravo).
    expect(onOpenSplit).toHaveBeenCalledWith(['s-appr', 's-idle']);
  });

  it('toggling a card checkbox selects it without switching sessions', () => {
    sessionsState.sessions = [session('s-run', { displayName: 'Alpha' })];
    render();
    const cardCheckbox = container!.querySelector(
      'ul li input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => cardCheckbox.click());
    expect(cardCheckbox.checked).toBe(true);
    // Selecting must not navigate — that's what the label button is for.
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('surfaces the popup-blocked notice when window.open is blocked', () => {
    sessionsState.sessions = [session('s1', { displayName: 'One' })];
    openSpy.mockReturnValue(null); // browser blocked the pop-up
    render();
    act(() => selectAllCheckbox().click());
    act(() =>
      tabButton().dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(container!.textContent).toContain('Pop-up blocked');
  });

  it('does not re-select a session that left the list and came back', () => {
    sessionsState.sessions = [
      session('a', { displayName: 'A' }),
      session('b', { displayName: 'B' }),
    ];
    render();
    act(() => selectAllCheckbox().click()); // a + b selected
    expect(selectAllCheckbox().checked).toBe(true);

    // 'a' leaves the list → its selection is pruned.
    sessionsState.sessions = [session('b', { displayName: 'B' })];
    rerender();
    // 'a' comes back → it must NOT be pre-selected (only b remains selected).
    sessionsState.sessions = [
      session('a', { displayName: 'A' }),
      session('b', { displayName: 'B' }),
    ];
    rerender();
    expect(selectAllCheckbox().checked).toBe(false);
    act(() =>
      tabButton().dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // Only 'b' is opened — the returned 'a' was pruned, not silently reselected.
    const url = new URL(String(openSpy.mock.calls[0][0]));
    expect(url.searchParams.get('split')).toBe('b');
  });

  it('caps the split to 6 sessions and warns when more are selected', () => {
    sessionsState.sessions = Array.from({ length: 8 }, (_, i) =>
      session(`s${i}`, { displayName: `S${i}` }),
    );
    const onOpenSplit = vi.fn();
    render({ onOpenSplit });
    act(() => selectAllCheckbox().click()); // all 8 selected
    // A hint tells the user only the first 6 will open.
    expect(container!.textContent).toContain('Only the first 6');
    // New-tab URL carries at most 6 ids.
    act(() =>
      tabButton().dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    const split = new URL(String(openSpy.mock.calls[0][0])).searchParams.get(
      'split',
    );
    expect(split!.split(',')).toHaveLength(6);
    // In-window split is likewise capped.
    const splitButton = Array.from(container!.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Open in split'),
    ) as HTMLButtonElement;
    act(() =>
      splitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onOpenSplit.mock.calls[0][0]).toHaveLength(6);
  });
});
