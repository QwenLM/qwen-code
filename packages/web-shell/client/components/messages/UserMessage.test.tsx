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

  it('keeps only the chevron clickable; the summary is inert text', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({
          hiddenCount: 5,
          elapsedMs: 12_400,
          inputTokens: 3100,
        })}
        onToggleCollapse={() => {}}
      />,
    );
    const btn = container.querySelector('button')!;
    // The button carries only the chevron glyph — never the summary text.
    expect(btn.textContent).toBe('▸');
    const meta = btn.nextElementSibling!;
    expect(meta.tagName).toBe('SPAN');
    expect(meta.textContent).toContain('5 steps');
  });

  it('renders identical summary text collapsed vs expanded (no reflow)', () => {
    const base = {
      hiddenCount: 5,
      elapsedMs: 12_400,
      inputTokens: 3100,
      outputTokens: 5100,
    };
    const metaOf = (c: HTMLElement) =>
      c.querySelector('button')!.nextElementSibling!.textContent;
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
    // Same summary in both states — only the chevron glyph flips.
    expect(metaOf(collapsed)).toBe(metaOf(expanded));
    expect(collapsed.querySelector('button')!.textContent).toBe('▸');
    expect(expanded.querySelector('button')!.textContent).toBe('▾');
  });

  it('renders just the step count when no metadata is measured', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({ hiddenCount: 3 })}
        onToggleCollapse={() => {}}
      />,
    );
    const meta = container.querySelector('button')!.nextElementSibling!;
    expect(meta.textContent).toContain('3 steps');
    expect(meta.textContent).not.toContain('·');
  });

  it('shows cached reads parenthetically on input when present', () => {
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
    expect(container.textContent).toContain('↑3.1k (2.8k cached) ↓5.1k');
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
