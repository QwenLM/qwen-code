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
  let prevented = false;
  await act(async () => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    input().dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  return prevented;
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
  expect(await key('ArrowDown', { shiftKey: true })).toBe(false);
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

it('does not open a result when Enter confirms an IME composition', async () => {
  await render();
  await key('Enter', { isComposing: true });
  await key('Enter', { keyCode: 229 });
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(portal.querySelector('[role="dialog"]')).not.toBeNull();
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
