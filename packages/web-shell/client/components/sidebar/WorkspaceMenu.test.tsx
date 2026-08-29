// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  WorkspaceMenu,
  hasWorkspaceMenuActions,
  type WorkspaceMenuActions,
} from './WorkspaceMenu';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const workspace: DaemonWorkspaceCapability = {
  id: 'ws-api',
  cwd: '/tmp/qwen-api-service',
  primary: false,
  trusted: true,
  removable: true,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
}

function click(element: HTMLElement): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function open(): Promise<HTMLElement[]> {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Workspace actions"]',
  );
  expect(trigger).not.toBeNull();
  await act(async () => {
    click(trigger!);
    await Promise.resolve();
  });
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  );
}

function labels(items: HTMLElement[]): string[] {
  return items.map((item) => item.textContent ?? '');
}

describe('WorkspaceMenu', () => {
  it('renders nothing without actions', async () => {
    expect(hasWorkspaceMenuActions({})).toBe(false);
    await render(<WorkspaceMenu workspace={workspace} actions={{}} />);
    expect(container.innerHTML).toBe('');
  });

  it('forwards outside-dismissal hooks to the menu content', async () => {
    const onPointerDownOutside = vi.fn();
    const onCloseAutoFocus = vi.fn((event: Event) => event.preventDefault());
    await render(
      <WorkspaceMenu
        workspace={workspace}
        actions={{ copyPath: vi.fn() }}
        onPointerDownOutside={onPointerDownOutside}
        onCloseAutoFocus={onCloseAutoFocus}
      />,
    );
    await open();
    // Radix registers its outside-press listener a macrotask after opening
    // (so the opening click cannot dismiss the menu); wait for it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      await Promise.resolve();
    });
    expect(onPointerDownOutside).toHaveBeenCalledTimes(1);
    // FocusScope dispatches the close-auto-focus event from a macrotask
    // after the content unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it('lists only the offered actions, in a fixed order', async () => {
    const actions: WorkspaceMenuActions = {
      copyPath: vi.fn(),
      remove: vi.fn(),
    };
    await render(<WorkspaceMenu workspace={workspace} actions={actions} />);
    const items = await open();
    expect(labels(items)).toEqual(['Copy path', 'Remove workspace']);
    expect(items[1]!.getAttribute('aria-label')).toBe(
      'Remove workspace: /tmp/qwen-api-service',
    );
    expect(document.body.querySelectorAll('[role="separator"]').length).toBe(1);
  });

  it('shows the management group with live counts and dispatches its target', async () => {
    const openManagement = vi.fn();
    await render(
      <WorkspaceMenu
        workspace={workspace}
        actions={{ rename: vi.fn(), openManagement, reload: vi.fn() }}
        overview={{
          mcp: {
            initialized: true,
            configured: 4,
            connected: 3,
            failed: 1,
            disabled: 0,
          },
          skills: { initialized: true, total: 12, enabled: 12 },
          fetchedAt: 1,
        }}
      />,
    );
    const items = await open();
    expect(labels(items)).toEqual([
      'Rename…',
      'MCP3/4',
      'Skills12',
      'Extensions',
      'Channels',
      'Settings',
      'Reload runtime',
    ]);
    expect(document.body.textContent).toContain('Manage');
    await act(async () => {
      click(items[2]!);
    });
    expect(openManagement).toHaveBeenCalledWith('skills');
  });

  it('invokes the selected action and reports open state changes', async () => {
    const rename = vi.fn();
    const onOpenChange = vi.fn();
    await render(
      <WorkspaceMenu
        workspace={workspace}
        actions={{ rename, newWorktreeSession: vi.fn() }}
        onOpenChange={onOpenChange}
      />,
    );
    const items = await open();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(labels(items)).toEqual(['Rename…', 'New worktree task']);
    await act(async () => {
      click(items[0]!);
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('signals close when unmounted while open', async () => {
    const onOpenChange = vi.fn();
    await render(
      <WorkspaceMenu
        workspace={workspace}
        actions={{ copyPath: vi.fn() }}
        onOpenChange={onOpenChange}
      />,
    );
    await open();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      root.render(<I18nProvider language="en">{null}</I18nProvider>);
    });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('disables the trigger', async () => {
    await render(
      <WorkspaceMenu
        workspace={workspace}
        actions={{ copyPath: vi.fn() }}
        disabled
      />,
    );
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Workspace actions"]',
      )?.disabled,
    ).toBe(true);
  });
});
