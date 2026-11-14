// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  SessionSortMenu,
  readSessionSort,
  readWorkspaceFilter,
  writeSessionSort,
  writeWorkspaceFilter,
  type SessionSort,
  type WorkspaceFilter,
} from './SessionSortMenu';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent)
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
if (!Element.prototype.hasPointerCapture)
  Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture)
  Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture)
  Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};

const workspaces: DaemonWorkspaceCapability[] = [
  {
    id: 'qwen',
    cwd: '/tmp/qwen-code',
    displayName: 'Qwen Code',
    primary: true,
    trusted: true,
  },
  {
    id: 'opencode',
    cwd: '/tmp/opencode',
    primary: false,
    trusted: true,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function renderMenu({
  value = 'updatedAt',
  workspaceValue = 'all',
  onChange = vi.fn(),
  onWorkspaceChange = vi.fn(),
  sortEnabled = true,
}: {
  value?: SessionSort;
  workspaceValue?: WorkspaceFilter;
  onChange?: (value: SessionSort) => void;
  onWorkspaceChange?: (value: WorkspaceFilter) => void;
  sortEnabled?: boolean;
} = {}) {
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <SessionSortMenu
          value={value}
          onChange={onChange}
          workspaceValue={workspaceValue}
          onWorkspaceChange={onWorkspaceChange}
          workspaces={workspaces}
          sortEnabled={sortEnabled}
        />
      </I18nProvider>,
    ),
  );
}

async function click(element: HTMLElement): Promise<void> {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.click();
  await Promise.resolve();
}

async function openMenu(): Promise<void> {
  const button = container.querySelector<HTMLElement>(
    'button[aria-label="Display options"]',
  );
  expect(button).not.toBeNull();
  await act(async () => click(button!));
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.includes(label));
}

async function openSubmenu(label: string): Promise<void> {
  const trigger = menuItem(label);
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger!.focus();
    trigger!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await Promise.resolve();
  });
}

function radioItems(): HTMLElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  );
}

describe('SessionSortMenu', () => {
  it('keeps session sorting in a submenu and persists it per host', async () => {
    expect(readSessionSort('a')).toBe('updatedAt');
    writeSessionSort('a', 'lastUserPromptAt');
    expect(readSessionSort('a')).toBe('lastUserPromptAt');
    expect(readSessionSort('b')).toBe('updatedAt');
    const onChange = vi.fn();
    await renderMenu({ onChange });
    await openMenu();
    await openSubmenu('Sort by');
    const items = radioItems();
    expect(items.map((item) => item.textContent)).toEqual([
      'Recent activity',
      'Last question',
    ]);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    await act(async () => click(items[1]!));
    expect(onChange).toHaveBeenCalledWith('lastUserPromptAt');
  });

  it('lists workspace choices with the current selection and label', async () => {
    const onWorkspaceChange = vi.fn();
    await renderMenu({ onWorkspaceChange });
    await openMenu();
    await openSubmenu('Workspace');
    const items = radioItems();
    expect(items.map((item) => item.textContent)).toEqual([
      'All',
      'No workspace',
      'Qwen Code',
      'opencode',
    ]);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    await act(async () => click(items[2]!));
    expect(onWorkspaceChange).toHaveBeenCalledWith('workspace:/tmp/qwen-code');
    await renderMenu({
      workspaceValue: 'workspace:/tmp/qwen-code',
      onWorkspaceChange,
    });
    await openMenu();
    expect(menuItem('Workspace')?.textContent).toContain('Qwen Code');
    await openSubmenu('Workspace');
    const selectedItems = radioItems();
    expect(selectedItems[0]!.getAttribute('aria-checked')).toBe('false');
    expect(selectedItems[2]!.getAttribute('aria-checked')).toBe('true');
  });

  it('persists workspace filtering per host and ignores invalid values', () => {
    expect(readWorkspaceFilter('a')).toBe('all');
    writeWorkspaceFilter('a', 'standalone');
    writeWorkspaceFilter('b', 'workspace:/tmp/qwen-code');
    expect(readWorkspaceFilter('a')).toBe('standalone');
    expect(readWorkspaceFilter('b')).toBe('workspace:/tmp/qwen-code');
    localStorage.setItem('web-shell:workspace-filter:a', 'invalid');
    expect(readWorkspaceFilter('a')).toBe('all');
    localStorage.setItem('web-shell:workspace-filter:a', 'workspace:');
    expect(readWorkspaceFilter('a')).toBe('all');
  });

  it('restores the persisted sort when the sort submenu is unavailable', async () => {
    const onChange = vi.fn();
    const onWorkspaceChange = vi.fn();
    await renderMenu({
      sortEnabled: false,
      onChange,
      onWorkspaceChange,
    });
    await openMenu();
    expect(menuItem('Sort by')).toBeUndefined();
    await act(async () => click(menuItem('Restore defaults')!));
    expect(onWorkspaceChange).toHaveBeenCalledWith('all');
    expect(onChange).toHaveBeenCalledWith('updatedAt');
  });

  it('restores the default workspace filter and session sort', async () => {
    const onChange = vi.fn();
    const onWorkspaceChange = vi.fn();
    await renderMenu({
      value: 'lastUserPromptAt',
      workspaceValue: 'standalone',
      onChange,
      onWorkspaceChange,
    });
    await openMenu();
    const restore = menuItem('Restore defaults');
    expect(restore).toBeDefined();
    await act(async () => click(restore!));
    expect(onWorkspaceChange).toHaveBeenCalledWith('all');
    expect(onChange).toHaveBeenCalledWith('updatedAt');
  });
});
