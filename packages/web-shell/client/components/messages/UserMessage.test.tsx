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

  it('shows the hidden-step count and aria-expanded=false when collapsed', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head()}
        onToggleCollapse={() => {}}
      />,
    );
    const btn = container.querySelector('button')!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('5 steps');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('pluralizes a single hidden step as "1 step"', () => {
    const container = render(
      <UserMessage
        content="hi"
        collapse={head({ hiddenCount: 1 })}
        onToggleCollapse={() => {}}
      />,
    );
    const text = container.querySelector('button')!.textContent ?? '';
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

  it('calls onToggleCollapse with the turn id on click', () => {
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
});
