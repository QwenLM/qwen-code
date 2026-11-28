// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import {
  SessionActionSheet,
  type SessionActionSheetGroupPicker,
  type SessionActionSheetItem,
} from './SessionActionSheet';

let container: HTMLDivElement;
let portalRoot: HTMLDivElement;
let root: Root;

const baseSession: DaemonSessionSummary = {
  sessionId: 'sess-mobile-001',
  workspaceCwd: '/repo/demo',
  displayName: 'Fix touch sidebar menu on iPad',
  updatedAt: '2026-11-28T10:00:00Z',
  clientCount: 1,
  branch: { name: 'feat/touch-sidebar' },
  prs: [
    {
      number: 42,
      url: 'https://github.com/example/repo/pull/42',
      state: 'open',
    },
  ],
};

beforeEach(() => {
  container = document.createElement('div');
  portalRoot = document.createElement('div');
  document.body.append(container, portalRoot);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  portalRoot.remove();
});

function renderSheet(props: {
  open?: boolean;
  showDetails?: boolean;
  actions: SessionActionSheetItem[];
  groupPicker?: SessionActionSheetGroupPicker;
  onOpenChange?: (open: boolean) => void;
}) {
  function Wrapper() {
    const [open, setOpen] = useState(props.open ?? true);
    return (
      <I18nProvider initialLanguage="en">
        <WebShellPortalRootContext.Provider value={portalRoot}>
          <SessionActionSheet
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              props.onOpenChange?.(next);
            }}
            session={baseSession}
            label={baseSession.displayName!}
            time="2m ago"
            completedUnread={false}
            showDetails={props.showDetails ?? true}
            actions={props.actions}
            groupPicker={props.groupPicker}
          />
        </WebShellPortalRootContext.Provider>
      </I18nProvider>
    );
  }
  act(() => {
    root.render(<Wrapper />);
  });
}

describe('SessionActionSheet', () => {
  it('renders embedded session details and action items inside the portal root', () => {
    const onPin = vi.fn();
    const onDelete = vi.fn();
    renderSheet({
      actions: [
        { id: 'pin', label: 'Pin', onSelect: onPin },
        {
          id: 'delete',
          label: 'Delete',
          destructive: true,
          opensDialog: true,
          onSelect: onDelete,
        },
      ],
    });

    const sheet = portalRoot.querySelector(
      '[data-web-shell-session-action-sheet]',
    );
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain('Fix touch sidebar menu on iPad');
    expect(sheet?.textContent).toContain('/repo/demo');
    expect(sheet?.textContent).toContain('feat/touch-sidebar');
    expect(sheet?.textContent).toContain('sess-mobile-001');
    expect(sheet?.textContent).toContain('#42');
    expect(
      sheet?.querySelector('[data-web-shell-session-id-copy]'),
    ).not.toBeNull();

    const pinButton = Array.from(sheet!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Pin'),
    );
    expect(pinButton).toBeDefined();
    act(() => {
      pinButton!.click();
    });
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('navigates to the in-sheet group picker and assigns group or color', async () => {
    const onAssignGroup = vi.fn();
    const onAssignColor = vi.fn();
    const onCreateGroup = vi.fn();
    const onLoad = vi.fn().mockResolvedValue(true);

    renderSheet({
      actions: [
        {
          id: 'group',
          label: 'Group',
          opensGroupSubpage: true,
          onSelect: () => undefined,
        },
      ],
      groupPicker: {
        loading: false,
        groups: [{ id: 'g1', name: 'Work', color: 'blue' }],
        colorOptions: ['red', 'blue'],
        selectedGroupId: null,
        selectedColor: null,
        onLoad,
        onAssignGroup,
        onAssignColor,
        onCreateGroup,
      },
    });

    const sheet = portalRoot.querySelector(
      '[data-web-shell-session-action-sheet]',
    )!;
    const groupButton = Array.from(sheet.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Group'),
    )!;

    await act(async () => {
      groupButton.click();
      await Promise.resolve();
    });

    expect(onLoad).toHaveBeenCalledTimes(1);
    const workItem = Array.from(
      sheet.querySelectorAll('[role="menuitemradio"]'),
    ).find((el) => el.textContent?.includes('Work')) as HTMLButtonElement;
    expect(workItem).toBeDefined();

    act(() => {
      workItem.click();
    });
    expect(onAssignGroup).toHaveBeenCalledWith('g1');
  });

  it('hands off dialog-opening actions cleanly when closing', async () => {
    vi.useFakeTimers();
    try {
      const onRename = vi.fn();
      const onOpenChange = vi.fn();
      renderSheet({
        onOpenChange,
        actions: [
          {
            id: 'rename',
            label: 'Rename',
            opensDialog: true,
            onSelect: onRename,
          },
        ],
      });

      const sheet = portalRoot.querySelector(
        '[data-web-shell-session-action-sheet]',
      )!;
      const renameButton = Array.from(sheet.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Rename'),
      )!;

      act(() => {
        renameButton.click();
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);

      act(() => {
        vi.runAllTimers();
      });
      expect(onRename).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
