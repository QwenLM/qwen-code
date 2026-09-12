// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
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
import { AssistantMessage } from '../messages/AssistantMessage';
import { WebShellTranscript } from '../WebShellTranscript';
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
  vi.restoreAllMocks();
});

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
