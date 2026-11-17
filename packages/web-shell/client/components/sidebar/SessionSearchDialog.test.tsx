/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { isEditableTarget } from '../../utils/dom';
import { DialogShell } from '../dialogs/DialogShell';
import { SessionSearchDialog } from './SessionSearchDialog';
import { useSessionSearch } from './use-session-search';

vi.mock('./use-session-search', () => ({ useSessionSearch: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof SessionSearchDialog>;
let root: Root;
let container: HTMLDivElement;
let portal: HTMLDivElement;
let trigger: HTMLButtonElement;
let props: Props;
let search: ReturnType<typeof useSessionSearch>;
const fakeClient = {} as NonNullable<Props['client']>;

function Host({ options }: { options: Props }) {
  const [open, setOpen] = useState(true);
  return (
    <I18nProvider language="en">
      <WebShellPortalRootContext.Provider value={portal}>
        {open && (
          <SessionSearchDialog
            {...options}
            onClose={() => {
              options.onClose();
              setOpen(false);
            }}
          />
        )}
      </WebShellPortalRootContext.Provider>
    </I18nProvider>
  );
}

async function render(overrides: Partial<Props> = {}) {
  await act(async () =>
    root.render(<Host options={{ ...props, ...overrides }} />),
  );
}

function input() {
  return portal.querySelector<HTMLInputElement>('input')!;
}

async function key(key: string, options: KeyboardEventInit = {}) {
  let dispatched!: KeyboardEvent;
  await act(async () => {
    dispatched = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    input().dispatchEvent(dispatched);
  });
  return dispatched;
}

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  portal = document.createElement('div');
  trigger = document.createElement('button');
  trigger.textContent = 'Search';
  document.body.append(container, portal, trigger);
  trigger.focus();
  root = createRoot(container);
  search = {
    entries: [
      {
        session: { sessionId: 'same', displayName: 'First chat' },
        workspaceCwd: '/a',
      },
      {
        session: { sessionId: 'same', displayName: 'Second chat' },
        workspaceCwd: '/b',
      },
    ],
    loading: false,
    failed: false,
    retry: vi.fn(),
  };
  vi.mocked(useSessionSearch).mockImplementation(() => search);
  props = {
    client: undefined,
    initialSessions: [],
    workspaces: [
      { cwd: '/a', displayName: 'Alpha' },
      { cwd: '/b', displayName: 'Beta' },
    ],
    includeStandalone: false,
    organizationEnabled: true,
    qualified: true,
    catalogKey: '',
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onQueryChange: vi.fn(),
    restoreFocus: trigger,
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  portal.remove();
  trigger.remove();
  vi.clearAllMocks();
});

it('focuses the real input through its ref and renders in the scoped portal', async () => {
  await render({ client: fakeClient });
  expect(vi.mocked(useSessionSearch).mock.lastCall?.[0].client).toBe(
    fakeClient,
  );
  expect(document.activeElement).toBe(input());
  expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(input().getAttribute('aria-activedescendant')).toBe(
    portal.querySelector('[role="option"]')!.id,
  );
});

it('navigates results and opens the selected workspace even when IDs collide', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await render();
    await key('ArrowDown');
    await key('ArrowUp');
    expect(
      portal.querySelector('[aria-selected="true"]')?.textContent,
    ).toContain('First chat');
    await key('ArrowDown');
    await key('Enter');
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(search.entries[1]);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(portal.querySelector('[role="dialog"]')).toBeNull();
    expect(
      consoleError.mock.calls
        .map((args) => args.join(' '))
        .filter((message) => message.includes('same key')),
    ).toEqual([]);
  } finally {
    consoleError.mockRestore();
  }
});

it('leaves modified arrow keys to the text input', async () => {
  await render();
  expect((await key('ArrowDown', { shiftKey: true })).defaultPrevented).toBe(
    false,
  );
  expect(portal.querySelector('[aria-selected="true"]')?.textContent).toContain(
    'First chat',
  );
});

it('highlights the original text when lowercasing changes its length', async () => {
  search.entries = [
    {
      session: { sessionId: 'istanbul', displayName: 'İstanbul session' },
      workspaceCwd: '/a',
    },
  ];
  await render();
  await type('session');
  const marks = portal.querySelectorAll('mark');
  expect(marks).toHaveLength(1);
  expect(marks[0].textContent).toBe('session');
});

it('closes with Escape and restores focus to the search trigger', async () => {
  await render();
  await key('Escape');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);
});

it('carries the markers that keep the mobile drawer from swallowing gestures', async () => {
  await render();
  const panel = portal.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(panel.hasAttribute('data-web-shell-dialog')).toBe(true);
  expect(panel.hasAttribute('data-keyboard-scope')).toBe(true);

  // The drawer's document-level touchmove blocker exempts descendants of the
  // dialog marker, and its window-capture Escape handler leaves editable or
  // keyboard-scoped targets to the dialog. Both gestures can start on a row
  // or on the close button.
  const row = panel.querySelector<HTMLElement>('[role="option"]')!;
  const close = panel.querySelector<HTMLElement>('button[aria-label="close"]')!;
  expect(row.closest('[data-web-shell-dialog]')).toBe(panel);
  expect(isEditableTarget(row)).toBe(true);
  expect(isEditableTarget(close)).toBe(true);
});

it('does not open a result when Enter confirms an IME composition', async () => {
  await render();
  await key('Enter', { isComposing: true });
  await key('Enter', { keyCode: 229 });
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
});

it.each([
  ['isComposing', { isComposing: true }],
  ['keyCode 229', { keyCode: 229 }],
])(
  'keeps the dialog open when Escape cancels an IME composition (%s)',
  async (_name, init) => {
    await render();
    const escape = await key('Escape', init);
    expect(escape.defaultPrevented).toBe(false);
    expect(escape.key).toBe('Escape');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
  },
);

it('resets the highlight to the first result when the query changes', async () => {
  await render();
  await key('ArrowDown');
  let rows = Array.from(
    portal.querySelectorAll<HTMLElement>('[role="option"]'),
  );
  expect(rows[1].getAttribute('aria-selected')).toBe('true');

  await type('chat');
  rows = Array.from(portal.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(rows[0].getAttribute('aria-selected')).toBe('true');
  expect(rows[1].getAttribute('aria-selected')).toBe('false');
});

it('suppresses the resting row hover tint while navigating by keyboard', async () => {
  await render();
  let rows = Array.from(
    portal.querySelectorAll<HTMLElement>('[role="option"]'),
  );
  // Pointer mode: the active row is filled, the resting row keeps the hover
  // affordance.
  expect(rows[0].classList.contains('bg-accent')).toBe(true);
  expect(rows[1].classList.contains('bg-accent')).toBe(false);
  expect(rows[1].classList.contains('hover:bg-accent/60')).toBe(true);

  await key('ArrowDown');
  rows = Array.from(portal.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(rows[1].classList.contains('bg-accent')).toBe(true);
  expect(rows[1].classList.contains('hover:bg-accent/60')).toBe(false);
  expect(rows[0].classList.contains('bg-accent')).toBe(false);
  expect(rows[0].classList.contains('hover:bg-accent/60')).toBe(false);
});

it('matches a typed regex metacharacter literally', async () => {
  search.entries = [
    {
      session: { sessionId: 'paren', displayName: 'parse (legacy' },
      workspaceCwd: '/a',
    },
  ];
  await render();
  await type('(');
  expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
  expect(portal.querySelector('mark')?.textContent).toBe('(');
});

it('ignores list keys while a dialog shell above holds focus', async () => {
  await render();
  const shellContainer = document.createElement('div');
  document.body.append(shellContainer);
  const shellRoot = createRoot(shellContainer);
  const closeShell = vi.fn();
  await act(async () =>
    shellRoot.render(
      <I18nProvider language="en">
        <DialogShell title="Rename session" onClose={closeShell}>
          <input aria-label="Rename input" />
        </DialogShell>
      </I18nProvider>,
    ),
  );
  const renameInput = document.querySelector<HTMLInputElement>(
    'input[aria-label="Rename input"]',
  )!;
  expect(document.activeElement).toBe(renameInput);
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => shellRoot.unmount());
  shellContainer.remove();
});

it('shows loading before the empty result and lets users retry partial failures', async () => {
  search.entries = [];
  search.loading = true;
  await render();
  await type('missing');
  expect(portal.textContent).toContain('Searching sessions…');
  expect(portal.textContent).not.toContain('No sessions found');
  search.loading = false;
  await render();
  expect(portal.textContent).toContain('No sessions found');
  expect(portal.textContent).toContain('Try a different title');
  search.failed = true;
  await render();
  expect(portal.textContent).toContain('Some sessions could not be searched.');
  expect(portal.textContent).not.toContain('No sessions found');
  search.entries = [
    {
      session: { sessionId: 'found', displayName: 'Available chat' },
      workspaceCwd: '/a',
    },
  ];
  await render();
  expect(portal.textContent).toContain('Some sessions could not be searched.');
  expect(portal.textContent).toContain('Available chat');
  const retry = Array.from(portal.querySelectorAll('button')).find(
    (button) => button.textContent === 'Try again',
  )!;
  await act(async () => retry.click());
  expect(search.retry).toHaveBeenCalledOnce();
  expect(props.onClose).not.toHaveBeenCalled();
});

it('shows a useful recent-session empty state before a query', async () => {
  search.entries = [];
  await render();
  expect(portal.textContent).toContain(
    'Your recent sessions will appear here.',
  );
  expect(portal.textContent).not.toContain('No sessions found');
});

it('forwards queries to custom content without taking over its selection', async () => {
  await render({
    client: fakeClient,
    customContent: <button>Host result</button>,
  });
  expect(vi.mocked(useSessionSearch).mock.lastCall?.[0].client).toBeUndefined();
  await type('host query');
  expect(props.onQueryChange).toHaveBeenCalledExactlyOnceWith('host query');
  expect(portal.textContent).toContain('Host result');
  expect(portal.querySelector('[role="listbox"]')).toBeNull();
  expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  await key('Enter');
  expect(props.onSelect).not.toHaveBeenCalled();
});
