// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

const { I18nProvider } = await import('../../i18n');
const { SessionDetailsSubmenu } = await import('./SessionDetailsSubmenu');

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

const session = {
  sessionId: 'session-id-copied-by-real-radix-keyboard-interaction',
  displayName: 'Keyboard session',
  clientCount: 1,
  hasActivePrompt: false,
} as DaemonSessionSummary;

let root: Root;
let container: HTMLDivElement;
let webShellRoot: HTMLDivElement;
let clipboardDescriptor: PropertyDescriptor | undefined;

function render(onError: ReturnType<typeof vi.fn>): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <div
          ref={(element) => {
            if (element) webShellRoot = element;
          }}
          data-web-shell-root
        >
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button">More actions</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <SessionDetailsSubmenu
                  session={session}
                  label="Keyboard session"
                  completedUnread={false}
                  onError={onError}
                  getCollisionBoundary={() => webShellRoot}
                />
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </I18nProvider>,
    );
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse',
      }),
    );
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

async function focus(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.focus();
    await Promise.resolve();
  });
}

function getMenuItem(label: string): HTMLElement {
  const item = document.body.querySelector<HTMLElement>(
    `[data-slot="dropdown-menu-item"][aria-label="${label}"]`,
  );
  expect(item).not.toBeNull();
  return item!;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  vi.restoreAllMocks();
});

describe('SessionDetailsSubmenu keyboard behavior', () => {
  it('copies through Enter and Space on the real Radix menu item', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(vi.fn());

    const actions = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'More actions',
    );
    expect(actions).toBeDefined();
    await click(actions!);

    const details = document.body.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-sub-trigger"]',
    );
    expect(details).not.toBeNull();
    await focus(details!);
    await pressKey(details!, 'ArrowRight');

    const copy = getMenuItem('Copy session ID');
    const detailsContent = document.body.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-sub-content"]',
    );
    expect(detailsContent?.classList.contains('min-w-0')).toBe(true);
    expect(detailsContent?.classList.contains('min-w-[96px]')).toBe(false);
    expect(detailsContent?.classList.contains('p-3')).toBe(true);
    expect(detailsContent?.classList.contains('p-1')).toBe(false);
    expect(copy.classList.contains('cursor-pointer')).toBe(true);
    expect(copy.classList.contains('cursor-default')).toBe(false);
    await focus(copy);
    expect(document.activeElement).toBe(copy);
    await pressKey(copy, 'Enter');
    expect(document.activeElement).toBe(copy);
    await pressKey(copy, ' ');
    expect(document.activeElement).toBe(copy);

    expect(writeText).toHaveBeenNthCalledWith(1, session.sessionId);
    expect(writeText).toHaveBeenNthCalledWith(2, session.sessionId);
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe(
      'Session ID copied',
    );
  });
});
