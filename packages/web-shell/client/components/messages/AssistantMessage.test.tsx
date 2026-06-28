// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import {
  AssistantMessage,
  formatThinkingDuration,
  getThinkingSummaryKey,
  MarkdownContext,
} from '@qwen-code/chat-panel';
import { Markdown, isSafeImageSrc } from './Markdown';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The panel reads its markdown renderer from context; inject web-shell's so the
// enhanced-table behaviour under test is exercised (EnhancedMarkdownTable reads
// the web-shell I18nProvider below).
const markdownSeam = {
  renderMarkdown: (props: Parameters<typeof Markdown>[0]) => (
    <Markdown {...props} />
  ),
  isSafeImageSrc,
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <MarkdownContext.Provider value={markdownSeam}>
          {node}
        </MarkdownContext.Provider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('AssistantMessage thinking logic', () => {
  it('uses the running summary while streaming before answer content', () => {
    expect(getThinkingSummaryKey({ isStreaming: true })).toBe(
      'thinking.running',
    );
  });

  it('uses the finished summary after streaming ends', () => {
    expect(getThinkingSummaryKey({ isStreaming: false })).toBe('thinking.done');
    expect(getThinkingSummaryKey({})).toBe('thinking.done');
  });

  it('formats thinking durations', () => {
    expect(formatThinkingDuration(-1000)).toBe('1s');
    expect(formatThinkingDuration(0)).toBe('1s');
    expect(formatThinkingDuration(1499)).toBe('1s');
    expect(formatThinkingDuration(59_400)).toBe('59s');
    expect(formatThinkingDuration(65_000)).toBe('1m 5s');
    expect(formatThinkingDuration(120_000)).toBe('2m');
  });
});

describe('AssistantMessage markdown tables', () => {
  const tableMarkdown = [
    '| Team | Score |',
    '| --- | ---: |',
    '| Alpha | 10 |',
  ].join('\n');

  it('enhances completed assistant tables', () => {
    const container = render(<AssistantMessage content={tableMarkdown} />);

    expect(container.textContent).toContain('Quick copy');
    expect(container.textContent).toContain('Details');
  });

  it('keeps streaming assistant tables plain', () => {
    const container = render(
      <AssistantMessage content={tableMarkdown} isStreaming />,
    );

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).not.toContain('Quick copy');
  });
});
