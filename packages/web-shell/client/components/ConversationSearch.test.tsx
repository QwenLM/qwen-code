// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { ConversationSearchResult } from '../daemon/session/turn-navigation-store';
import { ConversationSearch } from './ConversationSearch';

const mocks = vi.hoisted(() => ({
  transcript: { blocks: [] as DaemonTranscriptBlock[] },
  navigation: { mode: 'idle', sessionId: 'session' },
  viewport: { revision: 0, connected: true },
  scan: vi.fn(),
  subscribe: () => () => {},
  t: (key: string) => key,
}));
vi.mock('../daemon-react-sdk', () => ({
  useTranscriptStore: () => transcriptStore,
}));
vi.mock('../daemon/session/DaemonSessionProvider', () => ({
  useDaemonHistoryNavigationStore: () => historyStore,
}));
vi.mock('../i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
const transcriptStore = {
  subscribe: mocks.subscribe,
  getSnapshot: () => mocks.transcript,
};
const historyStore = {
  subscribe: mocks.subscribe,
  getSnapshot: () => mocks.navigation,
  getViewportSnapshot: () => mocks.viewport,
  scanConversation: mocks.scan,
};
let root: Root | undefined;
let container: HTMLDivElement;
const scrollToMessage = vi.fn(() => true);
const scrollToSearchHit = vi.fn(async () => true);
const props = {
  messageListRef: { current: { scrollToMessage, scrollToSearchHit } },
} as unknown as ComponentProps<typeof ConversationSearch>;

function blocks(count: number): DaemonTranscriptBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    kind: index % 2 ? 'assistant' : 'user',
    text: `Message ${index}`,
    streaming: false,
    createdAt: index,
    updatedAt: index,
    clientReceivedAt: index,
  }));
}
function result(
  overrides: Partial<ConversationSearchResult> = {},
): ConversationSearchResult {
  return {
    hits: [],
    messageCount: 11,
    matchCount: 0,
    complete: true,
    truncated: false,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function render(
  extra: Partial<ComponentProps<typeof ConversationSearch>> = {},
) {
  await act(async () =>
    root!.render(<ConversationSearch {...props} {...extra} />),
  );
}
function trigger() {
  return container.querySelector<HTMLButtonElement>(
    'button[aria-label="chat.searchConversation"]',
  );
}
async function open() {
  await act(async () => trigger()!.click());
}
async function type(query: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function debounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.transcript = { blocks: blocks(11) };
  mocks.navigation = { mode: 'idle', sessionId: 'session' };
  mocks.viewport = { revision: 0, connected: true };
  mocks.scan.mockReset().mockResolvedValue(result());
  scrollToMessage.mockClear();
  scrollToSearchHit.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.useRealTimers();
});

it('shows only above the default threshold, ignoring tool and thought blocks', async () => {
  mocks.transcript = {
    blocks: [
      ...blocks(10),
      {
        id: 'tool',
        kind: 'tool',
        toolCallId: 'tool',
        title: 'Tool',
        status: 'completed',
        preview: { kind: 'generic' },
        createdAt: 20,
        updatedAt: 20,
        clientReceivedAt: 20,
      },
      {
        id: 'thought',
        kind: 'thought',
        text: 'Thinking',
        streaming: false,
        createdAt: 21,
        updatedAt: 21,
        clientReceivedAt: 21,
      },
    ],
  };
  await render();
  expect(trigger()).toBeNull();
  mocks.transcript = { blocks: blocks(11) };
  await render();
  expect(trigger()).not.toBeNull();
});
it('honors a custom threshold and zero', async () => {
  mocks.transcript = { blocks: blocks(2) };
  await render({ threshold: 2 });
  expect(trigger()).toBeNull();
  await render({ threshold: 1 });
  expect(trigger()).not.toBeNull();
  mocks.transcript = { blocks: [] };
  await render({ threshold: 0 });
  expect(trigger()).toBeNull();
  mocks.transcript = { blocks: blocks(1) };
  await render({ threshold: 0 });
  expect(trigger()).not.toBeNull();
});
it('probes unloaded history only far enough to establish the threshold', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.transcript = { blocks: blocks(2) };
  await render();
  expect(mocks.scan).toHaveBeenCalledWith(
    '',
    expect.objectContaining({ stopAfterMessages: 11 }),
  );
  expect(trigger()).not.toBeNull();
});
it.each(['搜索', '[a.b]'])(
  'matches literal Chinese/code text and navigates to its message: %s',
  async (query) => {
    mocks.transcript = {
      blocks: [
        {
          ...blocks(1)[0],
          kind: 'user',
          text: '请搜索代码 [a.b]',
          streaming: false,
        },
      ],
    };
    await render({ threshold: 0 });
    await open();
    await type(query);
    expect(document.querySelector('mark')?.textContent).toBe(query);
    const match = document.querySelector<HTMLButtonElement>('ol button')!;
    await act(async () => match.click());
    expect(scrollToMessage).toHaveBeenCalledWith('message-0');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  },
);
it('debounces queries and ignores an earlier search after the query changes', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  const old = deferred<ConversationSearchResult>();
  mocks.scan.mockReturnValueOnce(old.promise).mockResolvedValue(result());
  await render();
  await open();
  await type('old');
  expect(mocks.scan).not.toHaveBeenCalled();
  await debounce();
  const oldOptions = mocks.scan.mock.calls[0][1];
  await type('new');
  expect(oldOptions.isCurrent()).toBe(false);
  await debounce();
  await act(async () =>
    old.resolve(
      result({
        hits: [
          {
            sessionId: 'session',
            snapshot: 's',
            revision: 1,
            recordId: 'old',
            turnId: 't',
            turnOrdinal: 0,
            role: 'user',
            snippet: 'old result',
            matchStart: 0,
            matchEnd: 3,
          },
        ],
      }),
    ),
  );
  expect(document.querySelector('ol')?.textContent).not.toContain('old result');
  expect(mocks.scan).toHaveBeenLastCalledWith('new', expect.any(Object));
});
it('reports history failure instead of no matches and can retry', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.scan
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(result());
  await render();
  await open();
  await type('missing');
  await debounce();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'chat.searchFailed',
  );
  expect(document.querySelector('[role="status"]')?.textContent).not.toContain(
    'chat.searchNoResults',
  );
  const retry = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'common.retry',
  )!;
  await act(async () => retry.click());
  await debounce();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.scan).toHaveBeenCalledTimes(2);
});
it('Escape cancels pending search without submitting or changing a composer draft', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  const pending = deferred<ConversationSearchResult>();
  mocks.scan.mockReturnValue(pending.promise);
  const draft = document.createElement('textarea');
  draft.value = 'Unsent draft';
  document.body.append(draft);
  const submit = vi.fn();
  document.addEventListener('submit', submit);
  await render();
  await open();
  await type('missing');
  await debounce();
  const options = mocks.scan.mock.calls[0][1];
  await act(async () =>
    document
      .querySelector('input')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(options.isCurrent()).toBe(false);
  expect(draft.value).toBe('Unsent draft');
  expect(submit).not.toHaveBeenCalled();
  document.removeEventListener('submit', submit);
  draft.remove();
});
it('invalidates an in-flight search when the session component unmounts', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.scan.mockReturnValue(new Promise(() => {}));
  await render();
  await open();
  await type('pending');
  await debounce();
  const options = mocks.scan.mock.calls[0][1];
  await act(async () => root!.unmount());
  root = undefined;
  expect(options.isCurrent()).toBe(false);
});

it('navigates to an unloaded historical result and keeps the dialog open on location failure', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  const hit = {
    sessionId: 'session',
    snapshot: 's',
    revision: 0,
    recordId: 'history',
    turnId: 't',
    turnOrdinal: 0,
    role: 'assistant' as const,
    snippet: 'older text',
    matchStart: 0,
    matchEnd: 5,
  };
  mocks.scan.mockResolvedValue(result({ hits: [hit], matchCount: 1 }));
  scrollToSearchHit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await render();
  await open();
  await type('older');
  await debounce();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('ol button')!.click(),
  );
  expect(scrollToSearchHit).toHaveBeenCalledWith(hit, expect.any(Function));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'chat.searchLocateFailed',
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('ol button')!.click(),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('invalidates search and reprobes visibility when the history revision changes', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.transcript = { blocks: blocks(2) };
  await render();
  expect(trigger()).not.toBeNull();
  mocks.scan.mockResolvedValue(result({ messageCount: 2 }));
  mocks.viewport = { revision: 1, connected: true };
  await render();
  expect(trigger()).toBeNull();
  expect(mocks.scan).toHaveBeenCalledTimes(2);
});
it('blocks composer shortcuts while open and releases the blocker when closed', async () => {
  const release = vi.fn();
  const register = vi.fn(() => release);
  await render({ registerInteractionBlocker: register });
  expect(register).not.toHaveBeenCalled();
  await open();
  expect(register).toHaveBeenCalledTimes(1);
  await act(async () =>
    document
      .querySelector('input')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
  );
  expect(release).toHaveBeenCalledTimes(1);
});

it('retains progressive matches when a later history page fails', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.scan.mockImplementation(async (_query, options) => {
    options.onProgress(
      result({
        complete: false,
        hits: [
          {
            sessionId: 'session',
            snapshot: 's',
            revision: 0,
            recordId: 'history',
            turnId: 't',
            turnOrdinal: 0,
            role: 'assistant',
            snippet: 'older match',
            matchStart: 0,
            matchEnd: 5,
          },
        ],
        matchCount: 1,
      }),
    );
    throw new Error('later page unavailable');
  });
  await render();
  await open();
  await type('older');
  await debounce();
  expect(document.querySelector('ol')?.textContent).toContain('older match');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'chat.searchFailed',
  );
  expect(document.querySelector('[role="status"]')?.textContent).not.toContain(
    'chat.searchNoResults',
  );
});

it('restores focus through the host when the timeline trigger disappears', async () => {
  const fallback = document.createElement('button');
  document.body.append(fallback);
  const onRestoreFocus = vi.fn(() => fallback.focus());
  try {
    await render({ onRestoreFocus, children: (entry) => <div>{entry}</div> });
    await open();
    await render({ onRestoreFocus, children: () => <div /> });
    expect(trigger()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onRestoreFocus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(fallback);
  } finally {
    fallback.remove();
  }
});

it('does not select a result on a WebKit IME committing Enter', async () => {
  await render();
  await open();
  await type('Message 0');
  expect(document.querySelector('ol button')).not.toBeNull();
  await act(async () => {
    document
      .querySelector<HTMLInputElement>('input[type="search"]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          isComposing: false,
          bubbles: true,
        }),
      );
  });
  expect(scrollToMessage).not.toHaveBeenCalled();
  expect(scrollToSearchHit).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

it('preserves the established threshold after an incomplete search and reprobes on reconnect', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.transcript = { blocks: blocks(2) };
  mocks.scan.mockResolvedValue(result({ messageCount: 11, complete: false }));
  await render();
  expect(trigger()).not.toBeNull();
  await open();
  mocks.scan.mockResolvedValue(result({ messageCount: 0, complete: false }));
  await type('offline query');
  await debounce();
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(trigger()).not.toBeNull();
  mocks.viewport = { ...mocks.viewport, connected: false };
  await render();
  mocks.scan.mockClear();
  mocks.scan.mockResolvedValue(result({ messageCount: 11, complete: false }));
  mocks.viewport = { ...mocks.viewport, connected: true };
  await render();
  expect(mocks.scan).toHaveBeenCalledWith(
    '',
    expect.objectContaining({ stopAfterMessages: 11 }),
  );
});

it('keeps the established entry when a disconnected live update would trigger a probe', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.transcript = { blocks: blocks(2) };
  mocks.scan.mockResolvedValue(result({ messageCount: 11, complete: false }));
  await render();
  expect(trigger()).not.toBeNull();
  mocks.scan.mockClear();
  mocks.scan.mockResolvedValue(result({ messageCount: 0, complete: false }));
  mocks.viewport = { ...mocks.viewport, connected: false };
  mocks.transcript = { blocks: blocks(3) };
  await render();
  expect(trigger()).not.toBeNull();
  expect(mocks.scan).not.toHaveBeenCalled();
});

it('keeps the selected live identity and Enter target when historical results arrive', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  const pending = deferred<ConversationSearchResult>();
  mocks.scan.mockReturnValue(pending.promise);
  await render();
  await open();
  await type('Message');
  await debounce();
  const input = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  for (let index = 0; index < 2; index++) {
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
  }
  const selectedText = document.querySelector(
    '[aria-current="true"]',
  )?.textContent;
  expect(selectedText).toBe('chat.searchUserMessage 2');
  const progress = result({
    complete: false,
    hits: [
      {
        sessionId: 'session',
        snapshot: 's',
        revision: 0,
        recordId: 'old-message',
        turnId: 'old-turn',
        turnOrdinal: 0,
        role: 'user',
        snippet: 'Message from history',
        matchStart: 0,
        matchEnd: 7,
      },
    ],
    matchCount: 1,
  });
  await act(async () => mocks.scan.mock.calls[0][1].onProgress(progress));
  expect(document.querySelector('[aria-current="true"]')?.textContent).toBe(
    selectedText,
  );
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ),
  );
  expect(scrollToMessage).toHaveBeenCalledWith('message-2');
  expect(scrollToSearchHit).not.toHaveBeenCalled();
});

it('retries a successful but incomplete history scan without editing the query', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.scan
    .mockResolvedValueOnce(result({ complete: false, messageCount: 0 }))
    .mockResolvedValueOnce(result());
  await render();
  await open();
  await type('missing');
  await debounce();
  const retry = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) => button.textContent === 'common.retry');
  expect(retry).toBeDefined();
  expect(retry!.parentElement?.textContent).toContain('chat.searchFailed');
  await act(async () => retry!.click());
  await debounce();
  expect(mocks.scan).toHaveBeenCalledTimes(2);
  expect(mocks.scan).toHaveBeenLastCalledWith(
    'missing',
    expect.objectContaining({ onProgress: expect.any(Function) }),
  );
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('connects combobox selection to the active listbox option across arrows and progress', async () => {
  mocks.navigation = { mode: 'ready', sessionId: 'session' };
  mocks.scan.mockReturnValue(new Promise(() => {}));
  await render();
  await open();
  await type('Message');
  await debounce();
  const input = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  expect(input.getAttribute('role')).toBe('combobox');
  expect(input.getAttribute('aria-expanded')).toBe('true');
  const list = document.getElementById(input.getAttribute('aria-controls')!);
  expect(list?.getAttribute('role')).toBe('listbox');
  const options = Array.from(list!.querySelectorAll('[role="option"]'));
  expect(options).toHaveLength(11);
  expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
  for (let index = 0; index < 2; index++) {
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
  }
  expect(input.getAttribute('aria-activedescendant')).toBe(options[2]!.id);
  expect(options[2]!.getAttribute('aria-selected')).toBe('true');
  expect(options[0]!.getAttribute('aria-selected')).toBe('false');
  await act(async () =>
    mocks.scan.mock.calls[0][1].onProgress(
      result({
        complete: false,
        hits: [
          {
            sessionId: 'session',
            snapshot: 's',
            revision: 0,
            recordId: 'older',
            turnId: 'turn',
            turnOrdinal: 0,
            role: 'user',
            snippet: 'Message from history',
            matchStart: 0,
            matchEnd: 7,
          },
        ],
      }),
    ),
  );
  const active = document.getElementById(
    input.getAttribute('aria-activedescendant')!,
  );
  expect(active?.textContent).toBe('chat.searchUserMessage 2');
  expect(active?.getAttribute('aria-selected')).toBe('true');
  expect(list!.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
});
