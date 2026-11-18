// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { dp } from './dialogStyles';
import { DaemonAvailabilityContext } from '../../daemon/availability-context.js';
import { DaemonUnavailableError } from '../../daemon/availability.js';
import { offlineDaemon } from '../../daemon/availability.test-fixtures.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

let sessions: DaemonSessionSummary[] = [
  {
    sessionId: 's0',
    workspaceCwd: '/work/repo',
    displayName: 'S0',
    clientCount: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    sessionId: 's1',
    workspaceCwd: '/work/repo',
    displayName: 'S1',
    clientCount: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    sessionId: 'me',
    workspaceCwd: '/work/repo',
    displayName: 'Current Session',
    clientCount: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const deleteSessionMock = vi.fn();
const deleteSessionsMock = vi.fn();
let scopedSessionsOptions: unknown;
let scopedSessionsError: Error | undefined;
let scopedSessionsLoading = false;
const initialSessions = sessions.slice();

let attachedSessionId = 'me';

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({ sessionId: attachedSessionId }),
}));

vi.mock('../../hooks/useScopedSessions', () => ({
  useScopedSessions: (_workspaceCwd: unknown, options: unknown) => {
    scopedSessionsOptions = options;
    return {
      sessions,
      loading: scopedSessionsLoading,
      error: scopedSessionsError,
      deleteSession: deleteSessionMock,
      deleteSessions: deleteSessionsMock,
    };
  },
}));

const { DeleteSessionDialog } = await import('./DeleteSessionDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let onDeleted: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

function renderDialog(availability?: ReturnType<typeof offlineDaemon>) {
  const dialog = (
    <DeleteSessionDialog
      onDeleted={onDeleted}
      onError={onError}
      onClose={onClose}
    />
  );
  root!.render(
    <I18nProvider language="en">
      {availability ? (
        <DaemonAvailabilityContext.Provider value={availability.availability}>
          {dialog}
        </DaemonAvailabilityContext.Provider>
      ) : (
        dialog
      )}
    </I18nProvider>,
  );
}

function mount(availability?: ReturnType<typeof offlineDaemon>) {
  onDeleted = vi.fn();
  onError = vi.fn();
  onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    renderDialog(availability);
  });
}

function rerender() {
  act(() => {
    renderDialog();
  });
}

function rows(): HTMLElement[] {
  return Array.from(container!.querySelectorAll('[role="option"]'));
}

function hint(): string {
  return (
    container!.querySelector<HTMLElement>(`.${dp('picker-search-hint')}`)
      ?.textContent ?? ''
  );
}

function dangerButton(): HTMLButtonElement {
  return Array.from(container!.querySelectorAll('button')).find((b) =>
    b.className.includes(dp('dialog-danger-button')),
  ) as HTMLButtonElement;
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

function clickRow(index: number) {
  act(() => {
    rows()[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!;

function typeFilter(value: string) {
  act(() => {
    const el = container!.querySelector('input')!;
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const isCursor = (el: HTMLElement) => el.className.includes(dp('selected'));
const isChecked = (el: HTMLElement) => el.textContent?.includes('[x]') === true;

beforeEach(() => {
  deleteSessionMock.mockReset();
  deleteSessionsMock.mockReset();
  scopedSessionsError = undefined;
  scopedSessionsLoading = false;
  attachedSessionId = 'me';
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  sessions = initialSessions.slice();
});

describe('DeleteSessionDialog selection', () => {
  it('excludes Qwen Live tasks from permanent deletion', () => {
    sessions = [
      {
        ...initialSessions[0],
        sourceType: 'qwen-live',
        displayName: 'Live task',
      },
      initialSessions[1],
    ];
    mount();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('S1');
    expect(container!.textContent).not.toContain('Live task');
  });

  it('keeps the keyboard cursor separate from the checked set; Enter only toggles', () => {
    mount();

    expect(scopedSessionsOptions).toEqual({
      autoLoad: true,
      maxAgeMs: 1_000,
    });

    // Opens with no highlight and nothing checked; delete stays disabled.
    expect(rows().some(isCursor)).toBe(false);
    expect(rows().some(isChecked)).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // The first ArrowDown lands the cursor on row 0 without checking it.
    press('ArrowDown');
    expect(isCursor(rows()[0])).toBe(true);
    expect(isChecked(rows()[0])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Enter toggles the cursor row's checkbox — it must not delete anything.
    press('Enter');
    expect(isChecked(rows()[0])).toBe(true);
    expect(dangerButton().disabled).toBe(false);
    expect(deleteSessionsMock).not.toHaveBeenCalled();
    expect(deleteSessionMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Moving the cursor keeps prior checks intact (multi-select).
    press('ArrowDown');
    expect(isCursor(rows()[1])).toBe(true);
    expect(isChecked(rows()[0])).toBe(true);
    expect(isChecked(rows()[1])).toBe(false);

    press('Enter');
    expect(isChecked(rows()[1])).toBe(true);

    // Enter on an already-checked row unchecks it.
    press('Enter');
    expect(isChecked(rows()[1])).toBe(false);
    expect(isChecked(rows()[0])).toBe(true);
  });

  it('checks and deletes the current session row when it is idle', async () => {
    deleteSessionsMock.mockResolvedValue({
      removed: ['me'],
      notFound: [],
      errors: [],
    });
    mount();

    // A click checks the current session row like any other row (#12619).
    clickRow(2);
    expect(isChecked(rows()[2])).toBe(true);
    expect(dangerButton().disabled).toBe(false);

    // Keyboard Enter toggles the current row's checkbox too.
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    expect(isCursor(rows()[2])).toBe(true);
    press('Enter');
    expect(isChecked(rows()[2])).toBe(false);
    press('Enter');
    expect(isChecked(rows()[2])).toBe(true);

    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(deleteSessionsMock).toHaveBeenCalledWith(['me']);
    expect(onDeleted).toHaveBeenCalledWith(['me'], {
      attachedSessionId: 'me',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the current session row unselectable while it is running', () => {
    sessions = [
      initialSessions[0],
      initialSessions[1],
      { ...initialSessions[2], hasActivePrompt: true },
    ];
    mount();

    clickRow(2);
    expect(isChecked(rows()[2])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Keyboard Enter on the running current row must not check it either.
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    expect(isCursor(rows()[2])).toBe(true);
    press('Enter');
    expect(isChecked(rows()[2])).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('keeps the current session row unselectable while only background work runs', () => {
    // The sidebar refuses to delete this row; the dialog must agree, or the
    // two entry points disagree about what "still working" means.
    sessions = [
      initialSessions[0],
      initialSessions[1],
      {
        ...initialSessions[2],
        hasRunningBackgroundTasks: true,
        activeWorkState: 'idle',
      },
    ];
    mount();

    clickRow(2);
    expect(isChecked(rows()[2])).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('refuses to confirm a row that turned busy after it was ticked', async () => {
    // The guard has to sit on the request, not only on the click: a blocked
    // row can no longer be unchecked, so a stale checked set would otherwise
    // still reach the multi-select delete.
    deleteSessionsMock.mockResolvedValue({
      removed: [initialSessions[0].sessionId],
      notFound: [],
      errors: [],
    });
    const idle = [
      initialSessions[0],
      initialSessions[1],
      { ...initialSessions[2], activeWorkState: 'idle' },
    ];
    const busy = [
      initialSessions[0],
      initialSessions[1],
      {
        ...initialSessions[2],
        hasRunningBackgroundTasks: true,
        activeWorkState: 'idle',
      },
    ];
    sessions = idle;
    mount();
    clickRow(2);
    expect(isChecked(rows()[2])).toBe(true);
    expect(dangerButton().disabled).toBe(false);

    // Alone, the stale selection must disarm the button and uncheck the row:
    // a blocked row cannot be unchecked by hand, so leaving it ticked would
    // count a session the request omits.
    sessions = busy;
    rerender();
    expect(dangerButton().disabled).toBe(true);
    expect(isChecked(rows()[2])).toBe(false);
    expect(deleteSessionsMock).not.toHaveBeenCalled();

    // Alongside another row the button stays armed, so the request itself has
    // to drop the row that turned busy — and the count the user reads must
    // agree with what is actually sent.
    sessions = idle;
    rerender();
    clickRow(2);
    clickRow(0);
    expect(hint()).toContain('2');
    sessions = busy;
    rerender();
    expect(dangerButton().disabled).toBe(false);
    expect(isChecked(rows()[2])).toBe(false);
    expect(hint()).toContain('1');
    expect(hint()).not.toContain('2');
    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(deleteSessionsMock).toHaveBeenCalledWith([
      initialSessions[0].sessionId,
    ]);
  });

  it('refuses a non-attached row whose only activity is background work', async () => {
    // The sidebar row already refuses this session and the delete route has no
    // idle guard, so the dialog must not be the way around it.
    deleteSessionsMock.mockResolvedValue({
      removed: ['s1'],
      notFound: [],
      errors: [],
    });
    const busyFirst = {
      ...initialSessions[0],
      hasRunningBackgroundTasks: true,
      activeWorkState: 'idle' as const,
    };
    sessions = initialSessions.slice();
    mount();
    clickRow(0);
    clickRow(1);
    expect(dangerButton().disabled).toBe(false);

    sessions = [busyFirst, initialSessions[1], initialSessions[2]];
    rerender();
    expect(rows()[0]!.getAttribute('aria-disabled')).toBe('true');
    expect(isChecked(rows()[0]!)).toBe(false);
    expect(hint()).toContain('1');
    expect(hint()).not.toContain('2');
    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(deleteSessionsMock).toHaveBeenCalledWith(['s1']);
  });

  it('keeps a non-attached row with a running turn selectable', () => {
    // Only background work blocks other rows. Widening the guard to every
    // kind of live work would make this row untickable here while the sidebar
    // still offers Delete for it.
    sessions = [
      { ...initialSessions[0], hasActivePrompt: true },
      initialSessions[1],
      initialSessions[2],
    ];
    mount();
    clickRow(0);
    expect(isChecked(rows()[0]!)).toBe(true);
    expect(dangerButton().disabled).toBe(false);
  });

  it('names the reason when a refused row is clicked', () => {
    // The danger button is disabled in this state, so the click on the row is
    // the only place the refusal can reach the user.
    sessions = [
      {
        ...initialSessions[0],
        hasRunningBackgroundTasks: true,
        activeWorkState: 'idle',
      },
      initialSessions[1],
      { ...initialSessions[2], hasActivePrompt: true },
    ];
    mount();
    clickRow(0);
    expect(isChecked(rows()[0]!)).toBe(false);
    expect(hint()).toBe(
      'A session with background work cannot be deleted; deleting would stop it',
    );
    clickRow(2);
    expect(isChecked(rows()[2]!)).toBe(false);
    expect(hint()).toBe(
      'Cannot delete the current session while it is running.',
    );
    // A successful tick clears the refusal so the count is readable again.
    clickRow(1);
    expect(isChecked(rows()[1]!)).toBe(true);
    expect(hint()).toContain('1');
  });

  it('drops the refusal once the row stops being blocked', () => {
    // The refusal describes live state, not a durable error: when the
    // background command finishes, the hint must stop asserting it even
    // though no further click happened.
    const firstRowBusy = (busy: boolean) => {
      sessions = [
        {
          ...initialSessions[0],
          hasRunningBackgroundTasks: busy,
          activeWorkState: 'idle',
        },
        initialSessions[1],
        initialSessions[2],
      ];
    };
    firstRowBusy(true);
    mount();
    clickRow(1);
    clickRow(0);
    expect(hint()).toBe(
      'A session with background work cannot be deleted; deleting would stop it',
    );
    firstRowBusy(false);
    rerender();
    expect(hint()).toContain('1');
    expect(hint()).not.toContain('background work');
    // And it must not come back on its own: a later busy tick is not a click.
    firstRowBusy(true);
    rerender();
    expect(hint()).toContain('1');
    expect(hint()).not.toContain('background work');
    // The guard must not latch either: once idle, the row ticks again.
    firstRowBusy(false);
    rerender();
    clickRow(0);
    expect(isChecked(rows()[0]!)).toBe(true);
  });

  it('re-reads the refusal reason from the row instead of the click', () => {
    // The row stays refused across an attachment change, but which rule
    // refuses it does not stay the same.
    sessions = [
      initialSessions[0],
      initialSessions[1],
      {
        ...initialSessions[2],
        hasActivePrompt: true,
        hasRunningBackgroundTasks: true,
        activeWorkState: 'idle',
      },
    ];
    mount();
    clickRow(2);
    expect(hint()).toBe(
      'Cannot delete the current session while it is running.',
    );
    attachedSessionId = 's1';
    rerender();
    expect(hint()).toBe(
      'A session with background work cannot be deleted; deleting would stop it',
    );
  });

  it('keeps a load error in the hint when a row is ticked', () => {
    // Clearing the refusal must not clobber an unrelated error sharing the hint.
    scopedSessionsError = new Error('load boom');
    sessions = initialSessions.slice();
    mount();
    expect(hint()).toContain('load boom');
    clickRow(1);
    expect(isChecked(rows()[1]!)).toBe(true);
    expect(hint()).toContain('load boom');
  });

  it('clears checked rows and disarms delete when the filter changes', () => {
    mount();

    clickRow(0);
    clickRow(1);
    expect(isChecked(rows()[0])).toBe(true);
    expect(isChecked(rows()[1])).toBe(true);
    expect(dangerButton().disabled).toBe(false);

    typeFilter('s1');
    expect(rows()).toHaveLength(1);
    expect(isChecked(rows()[0])).toBe(false);
    expect(rows().some(isCursor)).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('matches a session by its bound PR number in the filter', () => {
    sessions = [
      {
        sessionId: 'pr-session',
        workspaceCwd: '/work/repo',
        displayName: 'Fix CI',
        clientCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        prs: [{ number: 9517, url: 'https://github.com/o/r/pull/9517' }],
      },
      {
        sessionId: 'other',
        workspaceCwd: '/work/repo',
        displayName: 'Unrelated',
        clientCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    mount();

    typeFilter('#9517');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Fix CI');

    typeFilter('#9999');
    expect(rows()).toHaveLength(0);
  });

  it('prunes stale checked ids after an unfiltered session refresh', async () => {
    mount();

    clickRow(0);
    clickRow(1);
    expect(dangerButton().disabled).toBe(false);

    sessions = [
      {
        sessionId: 'me',
        displayName: 'Current Session',
        clientCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    rerender();

    expect(rows()).toHaveLength(1);
    expect(isChecked(rows()[0])).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('shows a delete outcome ahead of a stale load error', async () => {
    scopedSessionsError = new Error('boom');
    deleteSessionsMock.mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [{ sessionId: 's0', error: 'locked' }],
    });
    mount();

    clickRow(0);
    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(hint()).toContain('Failed to delete 1 session(s): locked');
    expect(hint()).not.toContain('boom');
  });

  it('shows a delete outcome ahead of an outstanding refusal', async () => {
    deleteSessionsMock.mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [{ sessionId: 's1', error: 'locked' }],
    });
    sessions = [
      {
        ...initialSessions[0],
        hasRunningBackgroundTasks: true,
        activeWorkState: 'idle',
      },
      initialSessions[1],
      initialSessions[2],
    ];
    mount();
    clickRow(1);
    clickRow(0);
    expect(hint()).toContain('background work');

    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(hint()).toContain('Failed to delete 1 session(s): locked');
    expect(hint()).not.toContain('background work');
  });

  it('keeps the loading placeholder above a stale load error', () => {
    scopedSessionsLoading = true;
    scopedSessionsError = new Error('boom');
    mount();

    const list = container!.querySelector('[role="listbox"]')!;
    expect(list.textContent).toContain('Loading...');
    expect(list.textContent).not.toContain('boom');
  });

  it('keeps the outage copy visible while the catalog reports loading', async () => {
    scopedSessionsLoading = true;
    const { availability } = offlineDaemon();
    mount({ availability });
    await act(async () => {
      await availability.check(true);
    });

    const list = container!.querySelector('[role="listbox"]')!;
    expect(list.textContent).toContain('Cannot reach the service.');
    availability.dispose();
  });

  it('reports an outage during delete as the localized service message', async () => {
    const { availability } = offlineDaemon();
    deleteSessionsMock.mockRejectedValue(new DaemonUnavailableError());
    mount({ availability });
    await act(async () => {
      await availability.check(true);
    });
    clickRow(0);
    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      'Cannot reach the service.',
    );
    availability.dispose();
  });

  it('keeps the outage copy ahead of a delete outcome', async () => {
    const { availability } = offlineDaemon();
    deleteSessionsMock.mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [{ sessionId: 's0', error: 'locked' }],
    });
    mount({ availability });
    await act(async () => {
      await availability.check(true);
    });
    clickRow(0);
    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(hint()).toContain('Cannot reach the service.');
    expect(hint()).not.toContain('Failed to delete 1 session(s): locked');
    availability.dispose();
  });

  it('deletes the checked sessions via the batch API and closes', async () => {
    deleteSessionsMock.mockResolvedValue({
      removed: ['s0', 's1'],
      notFound: [],
      errors: [],
    });
    mount();

    clickRow(0);
    clickRow(1);
    expect(dangerButton().disabled).toBe(false);

    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(deleteSessionsMock).toHaveBeenCalledWith(['s0', 's1']);
    expect(onDeleted).toHaveBeenCalledWith(['s0', 's1'], {
      attachedSessionId: 'me',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
