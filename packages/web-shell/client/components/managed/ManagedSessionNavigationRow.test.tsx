// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { ManagedSessionNavigationRow } from './ManagedSessionNavigationRow';

describe('Managed session navigation row', () => {
  let container: HTMLDivElement;
  let portal: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ManagedSessionNavigationRow>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    portal = document.createElement('div');
    document.body.append(container, portal);
    root = createRoot(container);
    props = {
      session: {
        sessionId: 'session-one',
        title: 'Task one',
        workspace: { workspaceId: 'workspace-one', cwdRelative: 'src' },
        phase: 'completed',
        createdAt: Date.parse('2026-10-16T08:00:00Z'),
        admittedAt: Date.parse('2026-10-16T08:00:00Z'),
        updatedAt: Date.parse('2026-10-16T08:30:00Z'),
        runtimeReady: true,
        runtimeState: 'ready',
        capabilities: { canSend: true, canCancel: false },
      },
      active: true,
      workspaceLabel: 'Project',
      onSelect: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    portal.remove();
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.useRealTimers();
  });

  async function render() {
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <WebShellPortalRootContext.Provider value={portal}>
            <ManagedSessionNavigationRow {...props} />
          </WebShellPortalRootContext.Provider>
        </I18nProvider>,
      ),
    );
  }

  function row() {
    return container.querySelector<HTMLElement>('[role="button"]')!;
  }

  async function hover() {
    await act(async () => {
      row().dispatchEvent(new Event('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
  }

  it('keeps mouse and keyboard actions independent from opening the session', async () => {
    const action = vi.fn();
    props.actions = <button onClick={action}>Action</button>;
    await render();
    await act(async () => {
      container.querySelector('button')!.click();
      container
        .querySelector('button')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
    });
    expect(action).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(row().getAttribute('aria-current')).toBe('page');
    await act(async () => {
      row().click();
      for (const key of ['Enter', ' ']) {
        row().dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      }
    });
    expect(props.onSelect).toHaveBeenCalledTimes(3);
  });

  it('shows available Managed metadata in the host portal and copies its ID', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    props.session.worktree = {
      id: 'worktree-a',
      sessionId: 'session-one',
      workspaceId: 'workspace-one',
      state: 'ready',
      branch: 'worktree-managed-a',
      baseCommit: 'a'.repeat(40),
      cwdRelative: '.qwen-managed-worktrees/a',
      operationId: 'operation-a',
      revision: 1,
    };
    await render();
    expect(container.textContent).not.toContain('worktree-managed-a');
    await hover();
    const details = portal.querySelector('[role="dialog"]')!;
    expect(details.textContent).toContain('Task one');
    expect(details.textContent).toContain('2026-10-16');
    expect(details.textContent).toContain('Project / src');
    expect(details.textContent).toContain('Completed');
    expect(details.textContent).not.toContain('clients');
    expect(details.textContent).toContain('Worktree ready');
    expect(details.textContent).toContain('worktree-managed-a');
    expect(details.textContent).toContain('Base commit: aaaaaaaaaaaa');
    await act(async () =>
      details
        .querySelector<HTMLButtonElement>('[data-web-shell-session-id-copy]')!
        .click(),
    );
    expect(writeText).toHaveBeenCalledWith('session-one');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('shows the lifecycle state and no-workspace label for an unbound session', async () => {
    props.session = {
      ...props.session,
      workspace: undefined,
      lifecycleStatus: 'closed',
    };
    await render();
    await hover();
    const details = portal.querySelector('[role="dialog"]')!;
    expect(details.textContent).toContain('Closed');
    expect(details.textContent).toContain('No workspace');
    expect(details.textContent).not.toContain('Completed');
    expect(details.textContent).not.toContain('clients');
  });
});
