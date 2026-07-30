// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  forwardRef,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  type PropsWithChildren,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

const { dropdownMenu } = vi.hoisted(() => ({
  dropdownMenu: {
    subContentProps: null as unknown,
    subContentPropsHistory: [] as unknown[],
    open: false,
    onOpenChange: null as ((open: boolean) => void) | null,
    copyItemOnSelect: null as ((event: Event) => void) | null,
    portalRoot: null as HTMLElement | null,
  },
}));

vi.mock('../ui/dropdown-menu', () => {
  function DropdownMenuSub({
    children,
    open = false,
    onOpenChange = () => {},
  }: PropsWithChildren<{
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }>) {
    dropdownMenu.open = open;
    dropdownMenu.onOpenChange = onOpenChange;
    return dropdownMenu.portalRoot
      ? createPortal(children, dropdownMenu.portalRoot)
      : children;
  }

  const DropdownMenuSubTrigger = forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement>
  >(function DropdownMenuSubTrigger({ onClick, ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        onClick={(event) => {
          onClick?.(event);
          const nextOpen = !dropdownMenu.open;
          dropdownMenu.onOpenChange?.(nextOpen);
        }}
      />
    );
  });

  function DropdownMenuSubContent({
    children,
    avoidCollisions,
    collisionBoundary,
    collisionPadding,
    className,
    onClick,
  }: PropsWithChildren<{
    avoidCollisions?: boolean;
    collisionBoundary?: Element;
    collisionPadding?: number;
    className?: string;
    onClick?: MouseEventHandler<HTMLDivElement>;
  }>) {
    const subContentProps = {
      avoidCollisions,
      collisionBoundary,
      collisionPadding,
      className,
    };
    dropdownMenu.subContentProps = subContentProps;
    dropdownMenu.subContentPropsHistory.push(subContentProps);
    return (
      <div
        data-slot="dropdown-menu-sub-content"
        className={className}
        onClick={onClick}
      >
        {children}
      </div>
    );
  }

  function DropdownMenuItem({
    children,
    onSelect,
    ...props
  }: PropsWithChildren<{
    onSelect?: (event: Event) => void;
  }>) {
    dropdownMenu.copyItemOnSelect = onSelect ?? null;
    return (
      <div role="menuitem" {...props}>
        {children}
      </div>
    );
  }

  return {
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuItem,
  };
});

const { I18nProvider } = await import('../../i18n');
const { SessionDetailsSubmenu } = await import('./SessionDetailsSubmenu');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  sessionId:
    'session-id-that-remains-complete-when-the-visible-value-is-truncated',
  displayName: 'Long running session',
  clientCount: 2,
  hasActivePrompt: true,
} as DaemonSessionSummary;

let root: Root;
let container: HTMLDivElement;
let webShellRoot: HTMLDivElement;
let sidebarBoundary: HTMLElement;
let portalRoot: HTMLDivElement;
let onError: ReturnType<typeof vi.fn>;
let getCollisionBoundary: ReturnType<typeof vi.fn>;
let clipboardDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;
let requestAnimationFrameDescriptor: PropertyDescriptor | undefined;
let cancelAnimationFrameDescriptor: PropertyDescriptor | undefined;
let nextAnimationFrame = 0;
const animationFrameCallbacks = new Map<number, FrameRequestCallback>();
const resizeObservers: ResizeObserverMock[] = [];

class ResizeObserverMock {
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }
}

function render(sessionOverride: DaemonSessionSummary = session): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <div
          ref={(element) => {
            if (element) webShellRoot = element;
          }}
          data-web-shell-root
        >
          <aside
            ref={(element) => {
              if (element) sidebarBoundary = element;
            }}
          >
            <SessionDetailsSubmenu
              session={sessionOverride}
              label="Long running session"
              completedUnread
              onError={onError}
              getCollisionBoundary={getCollisionBoundary}
            />
          </aside>
        </div>
      </I18nProvider>,
    );
  });
}

function getMenuItem(label: string): HTMLElement {
  const item = portalRoot.querySelector<HTMLElement>(
    `[role="menuitem"][aria-label="${label}"]`,
  );
  expect(item).not.toBeNull();
  return item!;
}

async function openDetails(): Promise<void> {
  const details = Array.from(portalRoot.querySelectorAll('button')).find(
    (button) => button.textContent?.includes('Details'),
  );
  expect(details).not.toBeUndefined();
  await click(details!);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function selectCopy(): Promise<Event> {
  const onSelect = dropdownMenu.copyItemOnSelect;
  expect(onSelect).not.toBeNull();
  const event = new Event('select', { cancelable: true });
  await act(async () => {
    onSelect!(event);
    await Promise.resolve();
  });
  return event;
}

function resizeEntry(width: number, height: number): ResizeObserverEntry {
  return {
    target: webShellRoot,
    contentRect: { width, height } as DOMRectReadOnly,
  } as ResizeObserverEntry;
}

async function triggerBoundaryResize(
  width: number,
  height: number,
): Promise<void> {
  const observer = resizeObservers.at(-1);
  expect(observer).toBeDefined();
  await act(async () => {
    observer!.callback(
      [resizeEntry(width, height)],
      observer as unknown as ResizeObserver,
    );
    await Promise.resolve();
  });
}

async function flushAnimationFrame(): Promise<void> {
  const callbacks = [...animationFrameCallbacks.values()];
  animationFrameCallbacks.clear();
  await act(async () => {
    callbacks.forEach((callback) => callback(0));
    await Promise.resolve();
  });
}

function mockClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  portalRoot = document.createElement('div');
  portalRoot.dataset.webShellPortalRoot = '';
  document.body.appendChild(portalRoot);
  root = createRoot(container);
  onError = vi.fn();
  getCollisionBoundary = vi.fn(() => webShellRoot);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  dropdownMenu.subContentProps = null;
  dropdownMenu.subContentPropsHistory = [];
  dropdownMenu.open = false;
  dropdownMenu.onOpenChange = null;
  dropdownMenu.copyItemOnSelect = null;
  dropdownMenu.portalRoot = portalRoot;
  resizeObserverDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'ResizeObserver',
  );
  requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'requestAnimationFrame',
  );
  cancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverMock,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const frame = ++nextAnimationFrame;
      animationFrameCallbacks.set(frame, callback);
      return frame;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (frame: number) => animationFrameCallbacks.delete(frame),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  portalRoot.remove();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  if (resizeObserverDescriptor) {
    Object.defineProperty(
      globalThis,
      'ResizeObserver',
      resizeObserverDescriptor,
    );
  } else {
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
  if (requestAnimationFrameDescriptor) {
    Object.defineProperty(
      globalThis,
      'requestAnimationFrame',
      requestAnimationFrameDescriptor,
    );
  } else {
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
  if (cancelAnimationFrameDescriptor) {
    Object.defineProperty(
      globalThis,
      'cancelAnimationFrame',
      cancelAnimationFrameDescriptor,
    );
  } else {
    Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
  animationFrameCallbacks.clear();
  resizeObservers.length = 0;
  nextAnimationFrame = 0;
  vi.restoreAllMocks();
});

describe('SessionDetailsSubmenu', () => {
  it('uses the non-portal WebShell root for narrow-screen collision flipping', async () => {
    render();
    await openDetails();

    const subContentProps = dropdownMenu.subContentProps as {
      avoidCollisions?: boolean;
      collisionBoundary?: Element;
      collisionPadding?: number;
    };
    expect(getCollisionBoundary).toHaveBeenCalledOnce();
    expect(portalRoot.querySelector('button')).not.toBeNull();
    expect(webShellRoot.contains(portalRoot)).toBe(false);
    expect(webShellRoot.contains(sidebarBoundary)).toBe(true);
    expect(subContentProps.avoidCollisions).toBe(true);
    expect(subContentProps.collisionBoundary).not.toBeNull();
    expect(subContentProps.collisionBoundary).toBe(webShellRoot);
    expect(subContentProps.collisionBoundary).not.toBe(portalRoot);
    expect(subContentProps.collisionPadding).toBe(8);
  });

  it('reconfigures once for a real root boundary size change', async () => {
    render();
    await openDetails();

    const content = portalRoot.querySelector(
      '[data-slot="dropdown-menu-sub-content"]',
    );
    expect(content).not.toBeNull();
    const firstObserver = resizeObservers.at(-1);
    expect(firstObserver?.observe).toHaveBeenCalledWith(webShellRoot);

    await triggerBoundaryResize(320, 480);
    expect(animationFrameCallbacks.size).toBe(0);

    await triggerBoundaryResize(320, 480);
    expect(animationFrameCallbacks.size).toBe(0);

    await triggerBoundaryResize(280, 480);

    expect(animationFrameCallbacks.size).toBe(1);
    await flushAnimationFrame();

    expect(getCollisionBoundary).toHaveBeenCalledOnce();
    expect(
      (dropdownMenu.subContentProps as { collisionBoundary?: Element })
        .collisionBoundary,
    ).toBe(webShellRoot);
    expect(
      portalRoot.querySelector('[data-slot="dropdown-menu-sub-content"]'),
    ).toBe(content);
    expect(resizeObservers).toHaveLength(1);
    expect(firstObserver?.disconnect).not.toHaveBeenCalled();

    await triggerBoundaryResize(280, 480);
    expect(animationFrameCallbacks.size).toBe(0);

    await openDetails();
    expect(firstObserver?.disconnect).toHaveBeenCalledOnce();
  });

  it('copies the complete session ID through the copy menu item', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render();
    await openDetails();

    expect(getMenuItem('Copy session ID')).not.toBeNull();
    const selectEvent = await selectCopy();

    expect(selectEvent.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith(session.sessionId);
    const status = portalRoot.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toBe('Session ID copied');
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('clears copied feedback when Details closes or its session changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render();
    await openDetails();
    await selectCopy();
    expect(portalRoot.querySelector('[role="status"]')).not.toBeNull();

    await openDetails();
    expect(portalRoot.querySelector('[role="status"]')).toBeNull();

    await openDetails();
    await selectCopy();
    expect(portalRoot.querySelector('[role="status"]')).not.toBeNull();
    render({ ...session, sessionId: 'different-session-id' });
    expect(portalRoot.querySelector('[role="status"]')).toBeNull();
  });

  it('reports clipboard failures through the existing error path', async () => {
    const error = new Error('clipboard denied');
    mockClipboard(vi.fn().mockRejectedValue(error));
    render();
    await openDetails();

    await selectCopy();

    expect(portalRoot.querySelector('[role="status"]')).toBeNull();
    expect(onError).toHaveBeenCalledWith(error, 'Failed to copy session ID');
  });
});
