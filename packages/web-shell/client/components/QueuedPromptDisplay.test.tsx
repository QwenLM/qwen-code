// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getTranslator } from '../i18n';
import {
  QueuedPromptDisplay,
  type QueuedPromptView,
} from './QueuedPromptDisplay';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = getTranslator('zh-CN');
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function setup(
  overrides: Partial<React.ComponentProps<typeof QueuedPromptDisplay>> = {},
) {
  const handlers = {
    onDelete: vi.fn(),
    onInsert: vi.fn(),
    onEdit: vi.fn(),
  };
  const prompts: QueuedPromptView[] = overrides.prompts
    ? [...overrides.prompts]
    : [
        { id: 1, text: '排队消息一' },
        { id: 2, text: '排队消息二' },
      ];
  const container = render(
    <QueuedPromptDisplay
      prompts={prompts}
      t={t}
      {...handlers}
      {...overrides}
    />,
  );
  return { container, handlers };
}

describe('QueuedPromptDisplay', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = setup({ prompts: [] });
    expect(container.textContent).toBe('');
  });

  it('lists each queued prompt', () => {
    const { container } = setup();
    expect(container.textContent).toContain('排队消息一');
    expect(container.textContent).toContain('排队消息二');
  });

  it('passes the prompt id to per-row delete', () => {
    const { container, handlers } = setup({
      prompts: [{ id: 42, text: 'only one' }],
    });
    const del = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === t('queue.delete'),
    );
    act(() => del!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(handlers.onDelete).toHaveBeenCalledWith(42);
  });

  it('disables insert for a command prompt', () => {
    const { container } = setup({
      prompts: [{ id: 1, text: '/help me' }],
    });
    const insert = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent || '').includes(t('queue.insert')),
    );
    expect(insert).toBeTruthy();
    expect((insert as HTMLButtonElement).disabled).toBe(true);
  });
});
