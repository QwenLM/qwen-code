// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('../../WebShellContexts', async () => {
  const { createContext } = await import('react');
  return {
    CompactModeContext: createContext(false),
  };
});

// The summary header's only per-render side effects are its `useI18n` calls:
// the expand/collapse title. Counting those calls distinguishes "the header
// re-rendered" from "the parent re-rendered" (the parent re-evaluates the
// running label via `t` on every chunk, the header must not).
const t = vi.hoisted(() =>
  vi.fn((key: string, vars?: Record<string, string | number>) =>
    vars && vars.duration !== undefined
      ? `${key}:${String(vars.duration)}`
      : key,
  ),
);

vi.mock('../../i18n', () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children,
  useI18n: () => ({ language: 'en' as const, t }),
}));

const { ThinkingMessage } = await import('./AssistantMessage');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function headerTitleCallCount(): number {
  return t.mock.calls.filter(
    ([key]) => key === 'thinking.expand' || key === 'thinking.collapse',
  ).length;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  t.mockClear();
});

describe('ThinkingMessage streaming memo boundary', () => {
  it('skips the collapsed summary header on streamed thought chunks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const tree = (content: string) => (
      <ThinkingMessage content={content} isStreaming timestamp={0} />
    );
    act(() => root.render(tree('a')));
    const headerCallsAfterMount = headerTitleCallCount();
    expect(headerCallsAfterMount).toBeGreaterThan(0);

    act(() => root.render(tree('ab')));
    act(() => root.render(tree('abc')));
    act(() => root.render(tree('abcd')));

    // The header did not re-render: its title key was evaluated once at mount.
    expect(headerTitleCallCount()).toBe(headerCallsAfterMount);
    // The parent still re-evaluates the running label on every chunk, so the
    // test would catch a header that rendered along with the parent.
    expect(
      t.mock.calls.filter(([key]) => key === 'thinking.running').length,
    ).toBeGreaterThan(headerCallsAfterMount);
    // The shine animation class stays applied while streaming.
    expect(
      container.querySelector('[class*="thinkingSummaryTextActive"]'),
    ).not.toBeNull();
    // Collapsed: the growing thought body stays hidden.
    expect(container.textContent).not.toContain('abc');
  });

  it('still streams the expanded body while the summary header stays memoized', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const tree = (content: string) => (
      <ThinkingMessage content={content} isStreaming timestamp={0} />
    );
    act(() => root.render(tree('a')));
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[title="thinking.expand"]',
    );
    act(() => toggle?.parentElement?.click());
    const headerCallsAfterExpand = headerTitleCallCount();

    act(() => root.render(tree('ab')));
    act(() => root.render(tree('abc')));
    // Markdown throttles streamed content by 80ms; flush the pending update.
    act(() => vi.advanceTimersByTime(80));

    expect(container.textContent).toContain('abc');
    expect(headerTitleCallCount()).toBe(headerCallsAfterExpand);
  });
});
