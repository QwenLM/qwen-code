// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { UserMessage } from './UserMessage';
import type { TurnCollapseHead } from '../../adapters/types';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
  mounted.push({ root, container });
  return container;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function head(over: Partial<TurnCollapseHead> = {}): TurnCollapseHead {
  return { turnId: 'u1', collapsed: true, hiddenCount: 5, ...over };
}

describe('UserMessage collapse toggle', () => {
  it('renders no toggle without collapse metadata', () => {
    const container = render(<UserMessage content="hi" />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows the step count and aria-expanded=false when collapsed', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head()}
        onToggleCollapse={() => {}}
      />,
    );
    const btn = container.querySelector('button')!;
    expect(btn).not.toBeNull();
    expect(container.textContent).toContain('5 steps');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('pluralizes a single step as "1 step"', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({ hiddenCount: 1 })}
        onToggleCollapse={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('1 step');
    expect(text).not.toContain('1 steps');
  });

  it('marks aria-expanded=true when expanded', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({ collapsed: false })}
        onToggleCollapse={() => {}}
      />,
    );
    expect(
      container.querySelector('button')!.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('calls onToggleCollapse with the turn id when the chevron is clicked', () => {
    const onToggle = vi.fn();
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({ turnId: 'turn-7' })}
        onToggleCollapse={onToggle}
      />,
    );
    click(container.querySelector('button')!);
    expect(onToggle).toHaveBeenCalledWith('turn-7');
  });

  it('appends elapsed and ↑input ↓output tokens when present', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({
          hiddenCount: 5,
          elapsedMs: 12_400,
          inputTokens: 3100,
          outputTokens: 5100,
        })}
        onToggleCollapse={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('5 steps');
    expect(text).toContain('12.4s');
    expect(text).toContain('↑3.1k');
    expect(text).toContain('↓5.1k');
  });

  it('puts the chevron + step count in the toggle, metrics inert', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({
          hiddenCount: 5,
          elapsedMs: 12_400,
          inputTokens: 3100,
          outputTokens: 5100,
        })}
        onToggleCollapse={() => {}}
      />,
    );
    const btn = container.querySelector('button')!;
    // The toggle carries the chevron AND the step count (a roomy target)…
    expect(btn.textContent).toMatch(/^[▸▾] 5 steps$/);
    // …while the metrics live outside the button, in an inert span.
    expect(btn.textContent).not.toContain('12.4s');
    const meta = btn.nextElementSibling!;
    expect(meta.tagName).toBe('SPAN');
    expect(meta.textContent).toContain('12.4s');
    expect(meta.textContent).toContain('↑3.1k');
  });

  it('keeps the toggle + metrics stable collapsed vs expanded (no reflow)', () => {
    const base = {
      hiddenCount: 5,
      elapsedMs: 12_400,
      inputTokens: 3100,
      outputTokens: 5100,
    };
    const metaOf = (c: HTMLElement) =>
      c.querySelector('button')!.nextElementSibling!.textContent;
    const btnOf = (c: HTMLElement) =>
      c.querySelector('button')!.textContent;
    const collapsed = render(
      <UserMessage
        content="hi"
        collapse={head({ ...base, collapsed: true })}
        onToggleCollapse={() => {}}
      />,
    );
    const expanded = render(
      <UserMessage
        content="hi"
        collapse={head({ ...base, collapsed: false })}
        onToggleCollapse={() => {}}
      />,
    );
    // Inert metrics identical; the toggle differs only by the chevron glyph
    // (same-width in the mono font), so the row never reflows on toggle.
    expect(metaOf(collapsed)).toBe(metaOf(expanded));
    expect(btnOf(collapsed)).toBe('▸ 5 steps');
    expect(btnOf(expanded)).toBe('▾ 5 steps');
  });

  it('renders only the toggle when no metrics are measured', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({ hiddenCount: 3 })}
        onToggleCollapse={() => {}}
      />,
    );
    const btn = container.querySelector('button')!;
    expect(btn.textContent).toContain('3 steps');
    // No metrics → no inert span and no stray separator.
    expect(btn.nextElementSibling).toBeNull();
    expect(container.textContent).not.toContain('·');
  });

  it('shows cached reads parenthetically on input, with their share', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({
          inputTokens: 3100,
          outputTokens: 5100,
          cachedTokens: 2800,
        })}
        onToggleCollapse={() => {}}
      />,
    );
    expect(container.textContent).toContain('↑3.1k (2.8k cached, 90%) ↓5.1k');
  });

  it('ticks elapsed from liveStartedAt on a live turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const container = render(
        <UserMessage
          content="hi"
          collapse={head({
            hiddenCount: 0,
            liveStartedAt: 7_600,
            inputTokens: 5,
            outputTokens: 5,
          })}
          onToggleCollapse={() => {}}
        />,
      );
      // now (10_000) − liveStartedAt (7_600) = 2.4s, ticked live.
      expect(container.textContent).toContain('2.4s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits the cached note when there are no cached reads', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({ inputTokens: 3100, outputTokens: 5100 })}
        onToggleCollapse={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('↑3.1k ↓5.1k');
    expect(text).not.toContain('cached');
  });

  it('renders a chevron-less metrics line for a step-less turn', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({
          hiddenCount: 0,
          elapsedMs: 1_200,
          inputTokens: 1200,
          outputTokens: 45,
        })}
        onToggleCollapse={() => {}}
      />,
    );
    // No fold control when there is nothing to fold…
    expect(container.querySelector('button')).toBeNull();
    // …but the metrics still show, without a step count.
    const text = container.textContent ?? '';
    expect(text).toContain('1.2s');
    expect(text).toContain('↑1.2k');
    expect(text).not.toContain('step');
  });
});
