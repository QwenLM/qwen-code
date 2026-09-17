// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  DaemonTranscriptBlock,
  SessionSource,
} from '@qwen-code/sdk/daemon';
import {
  WebShellCustomizationProvider,
  type WebShellSourceIconResolver,
} from '../../customization';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { AssistantMessage } from '../messages/AssistantMessage';
import { WebShellTranscript } from '../WebShellTranscript';
import { MessageList } from '../MessageList';
import type { Message } from '../../adapters/types';
import { getSourceEntries } from './sourceEntries';

const web: SessionSource = {
  id: 'web',
  title: 'Web source',
  kind: 'link',
  locator: { type: 'url', url: 'https://example.com/source' },
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};
const file: SessionSource = {
  ...web,
  id: 'file',
  kind: 'file',
  title: 'data.csv',
  locator: { type: 'workspace_file', workspacePath: 'data.csv' },
  workspaceCwd: '/workspace',
};
const entries = getSourceEntries([web, file], []);
const selector = '[data-web-shell-turn-sources-trigger]';
const popup = '[data-web-shell-turn-sources]';
let root: Root;
let container: HTMLDivElement;
function render(node: ReactNode) {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root.render(<I18nProvider language="en">{node}</I18nProvider>));
}
function click(node: Element | null) {
  expect(node).not.toBeNull();
  act(() => (node as HTMLElement).click());
}
function mask() {
  return container
    .querySelector(selector)
    ?.querySelector<HTMLElement>('[aria-hidden]')?.style.maskImage;
}
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  container = undefined!;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('does not revisit historical sources or redraw their icons for streaming text', async () => {
  vi.useFakeTimers();
  const readLocator = vi.fn(() => web.locator);
  const source = {
    ...web,
    get locator() {
      return readLocator();
    },
  };
  const sources = getSourceEntries([source], []);
  const icon = vi.fn(() => '/sources.svg');
  const customization = {
    getAssistantSourcesIcon: icon,
    sourceReferences: [
      { sessionId: 'session', turnId: 'first', sourceId: web.id },
    ],
  };
  const history: Message[] = [
    { id: 'first', role: 'user', content: 'First question' },
    { id: 'done', role: 'assistant', content: 'Completed report' },
    { id: 'second', role: 'user', content: 'Second question' },
  ];
  const tree = (text: string) => (
    <StrictMode>
      <WebShellCustomizationProvider value={customization}>
        <MessageList
          messages={[
            ...history,
            { id: 'live', role: 'assistant', content: text, isStreaming: true },
          ]}
          isResponding
          pendingApproval={null}
          sourceEntries={sources}
          sourceSessionId="session"
        />
      </WebShellCustomizationProvider>
    </StrictMode>
  );
  render(tree('Partial'));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(container.querySelector(selector)?.textContent).toBe('1 source');
  expect(icon).toHaveBeenCalled();
  readLocator.mockClear();
  icon.mockClear();
  render(tree('Partial report'));
  render(tree('Partial report continues'));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(container.textContent).toContain('Partial report continues');
  expect(readLocator).not.toHaveBeenCalled();
  expect(icon).not.toHaveBeenCalled();
});

it.each([
  ['inventory', []],
  ['references', [file.id]],
  ['session', [file.id]],
  ['workspace', [web.id]],
] as const)(
  'refreshes streaming sources when %s changes',
  (changed, expected) => {
    let sources = getSourceEntries([web, file], []);
    let references = [
      { sessionId: 'session', turnId: 'first', sourceId: web.id },
    ];
    let sessionId = 'session';
    let workspaceCwd = '/workspace';
    const icon = vi.fn<WebShellSourceIconResolver>(() => '/sources.svg');
    const history: Message[] = [
      { id: 'first', role: 'user', content: 'First question' },
      {
        id: 'registration',
        role: 'tool_group',
        tools: [
          {
            callId: 'register',
            toolName: 'record_source',
            status: 'completed',
            args: { locator: file.locator },
          },
        ],
      },
      { id: 'done', role: 'assistant', content: 'Completed report' },
      { id: 'second', role: 'user', content: 'Second question' },
    ];
    const tree = (text: string) => (
      <WebShellCustomizationProvider
        value={{ getAssistantSourcesIcon: icon, sourceReferences: references }}
      >
        <MessageList
          messages={[
            ...history,
            { id: 'live', role: 'assistant', content: text, isStreaming: true },
          ]}
          isResponding
          pendingApproval={null}
          sourceEntries={sources}
          sourceSessionId={sessionId}
          workspaceCwd={workspaceCwd}
        />
      </WebShellCustomizationProvider>
    );
    render(tree('Partial'));
    expect(container.querySelector(selector)?.textContent).toBe('2 sources');
    if (changed === 'inventory') sources = [];
    if (changed === 'references') references = [];
    if (changed === 'session') sessionId = 'other';
    if (changed === 'workspace') workspaceCwd = '/other';
    render(tree('Partial report'));
    if (!expected.length) expect(container.querySelector(selector)).toBeNull();
    else {
      expect(container.querySelector(selector)?.textContent).toBe('1 source');
      expect(
        icon.mock.calls
          .at(-1)?.[0]
          .map((entry) =>
            entry.type === 'source'
              ? entry.source.id
              : entry.attachment.attachmentId,
          ),
      ).toEqual(expected);
    }
  },
);

it('shows real source entries on a report without footnotes and reuses its open action', () => {
  const open = vi.fn();
  render(
    <AssistantMessage
      content="A report without footnotes."
      showFooterActions
      turnSources={entries}
      onSourceOpen={open}
    />,
  );
  const sources = container.querySelector(selector)!;
  expect(sources.textContent).toBe('2 sources');
  expect(sources.parentElement).toBe(
    container.querySelector('[aria-label="Copy"]')?.parentElement,
  );
  click(sources);
  const list = document.querySelector(popup)!;
  expect(list.textContent).toContain('Web source');
  expect(list.textContent).toContain('data.csv');
  expect(list.querySelector('[data-web-shell-footnote-card]')).toBeNull();
  click(list.querySelector('[aria-label="Open source Web source"]'));
  expect(open).toHaveBeenCalledWith(entries[0]);
});

it('returns keyboard focus to the trigger after activating a source', () => {
  const open = vi.fn();
  render(
    <AssistantMessage
      content="Report"
      showFooterActions
      turnSources={entries}
      onSourceOpen={open}
    />,
  );
  const trigger = container.querySelector<HTMLButtonElement>(selector)!;
  click(trigger);
  const row = document.querySelector<HTMLButtonElement>(
    '[aria-label="Open source Web source"]',
  )!;
  act(() => row.focus());
  click(row);
  expect(open).toHaveBeenCalledWith(entries[0]);
  expect(document.querySelector(popup)).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it.each(['Escape', 'source activation'])(
  'dismisses re-hovered sources after %s without losing keyboard focus',
  (action) => {
    vi.useFakeTimers();
    render(
      <AssistantMessage
        content="Report"
        showFooterActions
        turnSources={entries}
        onSourceOpen={vi.fn()}
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(selector)!;
    const hover = () =>
      act(() => {
        trigger.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      });
    const leave = () => {
      act(() =>
        trigger.dispatchEvent(
          new MouseEvent('pointerout', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        ),
      );
      act(() => vi.advanceTimersByTime(250));
    };
    hover();
    leave();
    expect(document.querySelector(popup)).toBeNull();

    act(() => trigger.focus());
    const row = document.querySelector<HTMLButtonElement>(
      '[aria-label="Open source Web source"]',
    )!;
    act(() => row.focus());
    if (action === 'Escape') {
      act(() =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      );
    } else {
      click(row);
    }
    expect(document.querySelector(popup)).toBeNull();
    expect(document.activeElement).toBe(trigger);
    for (let i = 0; i < 2; i++) {
      hover();
      expect(document.querySelector(popup)).not.toBeNull();
      leave();
      expect(document.querySelector(popup)).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }

    act(() => trigger.blur());
    act(() => trigger.focus());
    hover();
    leave();
    expect(document.querySelector(popup)).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

it('preserves focus when the host moves it into the source preview', () => {
  const target = document.createElement('button');
  document.body.append(target);
  try {
    render(
      <AssistantMessage
        content="Report"
        showFooterActions
        turnSources={entries}
        onSourceOpen={() => target.focus()}
      />,
    );
    click(container.querySelector(selector));
    const row = document.querySelector<HTMLButtonElement>(
      '[aria-label="Open source Web source"]',
    )!;
    act(() => row.focus());
    click(row);
    expect(document.querySelector(popup)).toBeNull();
    expect(document.activeElement).toBe(target);
  } finally {
    target.remove();
  }
});

it('returns focus after activating a source inside a shadow portal', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const portal = document.createElement('div');
  host.attachShadow({ mode: 'open' }).append(portal);
  try {
    render(
      <WebShellPortalRootContext.Provider value={portal}>
        <AssistantMessage
          content="Report"
          showFooterActions
          turnSources={entries}
          onSourceOpen={vi.fn()}
        />
      </WebShellPortalRootContext.Provider>,
    );
    const trigger = container.querySelector<HTMLButtonElement>(selector)!;
    click(trigger);
    const row = portal.querySelector<HTMLButtonElement>(
      '[aria-label="Open source Web source"]',
    )!;
    act(() => row.focus());
    expect(document.activeElement).toBe(host);
    click(row);
    expect(portal.querySelector(popup)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally {
    host.remove();
  }
});

it('never substitutes footnote counts when turn sources are absent', () => {
  render(
    <AssistantMessage
      content={'Report[^a][^b].\n\n[^a]: One.\n[^b]: Two.'}
      showFooterActions
    />,
  );
  expect(container.querySelector(selector)).toBeNull();
  expect(
    container.querySelector('[data-web-shell-footnote-trigger]')?.textContent,
  ).toBe('2');
  expect(
    container.querySelector('[data-web-shell-footnote-sources-trigger]'),
  ).toBeNull();
});

it('passes the full source list to its icon callback independently of inline footnote icons', () => {
  const icon = vi.fn<WebShellSourceIconResolver>(() => '/source-icon.svg');
  const inline = vi.fn(() => '/inline-icon.svg');
  render(
    <WebShellCustomizationProvider
      value={{
        getAssistantSourcesIcon: icon,
        markdown: { getInlineFootnoteIcon: inline },
      }}
    >
      <AssistantMessage
        content={'Report[^a].\n\n[^a]: Note.'}
        showFooterActions
        turnSources={entries}
      />
    </WebShellCustomizationProvider>,
  );
  expect(icon).toHaveBeenCalledWith(entries);
  expect(mask()).toContain('/source-icon.svg');
  expect(
    container
      .querySelector(`${selector} span`)
      ?.classList.contains('-translate-y-px'),
  ).toBe(false);
  expect(
    container
      .querySelector('[data-web-shell-footnote-trigger] span')
      ?.getAttribute('style'),
  ).toContain('/inline-icon.svg');
});

it.each([
  undefined,
  null,
  '',
  'javascript:alert(1)',
  'data:image/svg+xml;base64,PHN2Zz4=',
])('uses the default source icon for %s', (value) => {
  render(
    <AssistantMessage
      content="Report"
      showFooterActions
      turnSources={entries}
    />,
  );
  const fallback = mask();
  render(
    <WebShellCustomizationProvider
      value={{ getAssistantSourcesIcon: () => value }}
    >
      <AssistantMessage
        content="Report"
        showFooterActions
        turnSources={entries}
      />
    </WebShellCustomizationProvider>,
  );
  expect(mask()).toBe(fallback);
});

it('contains icon exceptions and removes an open source view when the list disappears', () => {
  const customization = {
    getAssistantSourcesIcon: () => {
      throw new Error('Host icon');
    },
  };
  const tree = (withSources: boolean) => (
    <WebShellCustomizationProvider value={customization}>
      <AssistantMessage
        content="Report"
        showFooterActions
        turnSources={withSources ? entries : []}
      />
    </WebShellCustomizationProvider>
  );
  render(tree(true));
  click(container.querySelector(selector));
  expect(document.querySelector(popup)).not.toBeNull();
  render(tree(false));
  expect(container.querySelector(selector)).toBeNull();
  expect(document.querySelector(popup)).toBeNull();
});

it('keeps read-only source data scoped to its turn and renders the footer only on final answers', () => {
  const block = (
    id: string,
    kind: 'user' | 'assistant' | 'thinking',
    text: string,
  ): DaemonTranscriptBlock =>
    ({
      id,
      kind,
      text,
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    }) as DaemonTranscriptBlock;
  const blocks = [
    block('one', 'user', 'First question'),
    block('step', 'assistant', 'Intermediate'),
    block('thinking', 'thinking', 'Thinking'),
    block('answer-one', 'assistant', 'First report'),
    block('two', 'user', 'Second question'),
    block('answer-two', 'assistant', 'Second report'),
  ];
  render(
    <WebShellTranscript
      blocks={blocks}
      collapseCompletedTurns={false}
      sourceSessionId="session"
      sources={[web, file]}
      sourceReferences={[
        { sessionId: 'session', turnId: 'one', sourceId: web.id },
        { sessionId: 'session', turnId: 'two', sourceId: web.id },
        { sessionId: 'session', turnId: 'two', sourceId: file.id },
        { sessionId: 'foreign', turnId: 'one', sourceId: file.id },
      ]}
    />,
  );
  expect(
    [...container.querySelectorAll(selector)].map((node) => node.textContent),
  ).toEqual(['1 source', '2 sources']);
});

it('updates cached message rows after sources arrive without another user interaction', () => {
  const blocks = [
    {
      id: 'question',
      kind: 'user',
      text: 'Question',
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    },
    {
      id: 'answer',
      kind: 'assistant',
      text: 'Answer',
      createdAt: 2,
      updatedAt: 2,
      clientReceivedAt: 2,
    },
  ] as DaemonTranscriptBlock[];
  const refs = [{ sessionId: 'session', turnId: 'question', sourceId: web.id }];
  const tree = (sources: readonly SessionSource[]) => (
    <WebShellTranscript
      blocks={blocks}
      sourceSessionId="session"
      sources={sources}
      sourceReferences={refs}
    />
  );
  render(tree([]));
  expect(container.querySelector(selector)).toBeNull();
  render(tree([web]));
  expect(container.querySelector(selector)?.textContent).toBe('1 source');
  render(tree([]));
  expect(container.querySelector(selector)).toBeNull();
});
