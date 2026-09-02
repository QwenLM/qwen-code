// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  forwardRef,
  type ButtonHTMLAttributes,
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
    updatePositionStrategy,
    className,
  }: PropsWithChildren<{
    avoidCollisions?: boolean;
    collisionBoundary?: Element;
    collisionPadding?: number;
    updatePositionStrategy?: 'optimized' | 'always';
    className?: string;
  }>) {
    const subContentProps = {
      avoidCollisions,
      collisionBoundary,
      collisionPadding,
      updatePositionStrategy,
      className,
    };
    dropdownMenu.subContentProps = subContentProps;
    dropdownMenu.subContentPropsHistory.push(subContentProps);
    return (
      <div data-slot="dropdown-menu-sub-content" className={className}>
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
let portalRoot: HTMLDivElement;
let onError: ReturnType<typeof vi.fn>;
let getCollisionBoundary: ReturnType<typeof vi.fn>;
let clipboardDescriptor: PropertyDescriptor | undefined;

function render(sessionOverride: DaemonSessionSummary = session): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <div
          ref={(element) => {
            if (element) {
              webShellRoot = element;
            }
          }}
          data-web-shell-root
        >
          <aside>
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

function getStatus(): HTMLElement {
  const status = portalRoot.querySelector<HTMLElement>('[role="status"]');
  expect(status).not.toBeNull();
  return status!;
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

function mockClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  vi.restoreAllMocks();
});

describe('SessionDetailsSubmenu', () => {
  it('uses the non-portal WebShell root for narrow-screen collision flipping', async () => {
    render();
    dropdownMenu.subContentPropsHistory = [];
    await openDetails();

    const firstOpenProps = dropdownMenu.subContentPropsHistory.at(0) as {
      collisionBoundary?: Element;
    };
    const subContentProps = dropdownMenu.subContentProps as {
      avoidCollisions?: boolean;
      collisionBoundary?: Element;
      collisionPadding?: number;
      updatePositionStrategy?: 'optimized' | 'always';
    };
    expect(getCollisionBoundary).toHaveBeenCalled();
    expect(firstOpenProps.collisionBoundary).toBe(webShellRoot);
    expect(subContentProps.avoidCollisions).toBe(true);
    expect(subContentProps.collisionBoundary).toBe(webShellRoot);
    expect(subContentProps.collisionBoundary).not.toBe(portalRoot);
    expect(subContentProps.collisionPadding).toBe(8);
    expect(subContentProps.updatePositionStrategy).toBe('always');
  });

  it('copies the complete session ID through the copy menu item', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render();
    await openDetails();

    expect(getMenuItem('Copy session ID')).not.toBeNull();
    expect(getStatus().textContent).toBe('');
    const selectEvent = await selectCopy();

    expect(selectEvent.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith(session.sessionId);
    expect(getStatus().textContent).toBe('Session ID copied');
    expect(getStatus().getAttribute('aria-live')).toBe('polite');
  });

  it('clears copied feedback when Details closes or its session changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    render();
    await openDetails();
    await selectCopy();
    expect(getStatus().textContent).toBe('Session ID copied');

    await openDetails();
    expect(getStatus().textContent).toBe('');

    await openDetails();
    await selectCopy();
    expect(getStatus().textContent).toBe('Session ID copied');
    render({ ...session, sessionId: 'different-session-id' });
    expect(getStatus().textContent).toBe('');
  });

  it('ignores a pending copy result after Details closes and reopens', async () => {
    const pendingCopy = deferred<void>();
    mockClipboard(vi.fn().mockReturnValue(pendingCopy.promise));
    render();
    await openDetails();
    await selectCopy();

    await openDetails();
    await openDetails();
    await act(async () => {
      pendingCopy.resolve(undefined);
      await pendingCopy.promise;
    });

    expect(getStatus().textContent).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });

  it('only applies the latest copy attempt for the current session', async () => {
    const firstCopy = deferred<void>();
    const secondCopy = deferred<void>();
    const staleError = new Error('stale clipboard failure');
    mockClipboard(
      vi
        .fn()
        .mockReturnValueOnce(firstCopy.promise)
        .mockReturnValueOnce(secondCopy.promise),
    );
    render();
    await openDetails();
    await selectCopy();
    await selectCopy();

    await act(async () => {
      secondCopy.resolve(undefined);
      await secondCopy.promise;
    });
    expect(getStatus().textContent).toBe('Session ID copied');

    await act(async () => {
      firstCopy.reject(staleError);
      await firstCopy.promise.catch(() => undefined);
    });
    expect(getStatus().textContent).toBe('Session ID copied');
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores a pending copy failure after the session changes', async () => {
    const pendingCopy = deferred<void>();
    const staleError = new Error('stale clipboard failure');
    mockClipboard(vi.fn().mockReturnValue(pendingCopy.promise));
    render();
    await openDetails();
    await selectCopy();

    render({ ...session, sessionId: 'different-session-id' });
    await act(async () => {
      pendingCopy.reject(staleError);
      await pendingCopy.promise.catch(() => undefined);
    });

    expect(getStatus().textContent).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports clipboard failures through the existing error path', async () => {
    const error = new Error('clipboard denied');
    mockClipboard(vi.fn().mockRejectedValue(error));
    render();
    await openDetails();

    await selectCopy();

    expect(getStatus().textContent).toBe('');
    expect(onError).toHaveBeenCalledWith(error, 'Failed to copy session ID');
  });

  it('reports an unavailable clipboard through the existing error path', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    render();
    await openDetails();

    await selectCopy();

    expect(getStatus().textContent).toBe('');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Clipboard API is unavailable' }),
      'Failed to copy session ID',
    );
  });
});
