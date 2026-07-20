// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  WebShellCustomizationProvider,
  type WebShellCustomization,
  type UserMessageContentParser,
} from '../customization';
import { getTranslator } from '../i18n';
import { QueuedPromptDisplay, type QueuedPrompt } from './QueuedPromptDisplay';

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
  customization: WebShellCustomization = {},
) {
  const handlers = {
    onDelete: vi.fn(),
    onInsert: vi.fn(),
    onEdit: vi.fn(),
  };
  const prompts: QueuedPrompt[] = overrides.prompts
    ? [...overrides.prompts]
    : [
        { id: 1, text: '排队消息一' },
        { id: 2, text: '排队消息二' },
      ];
  const container = render(
    <WebShellCustomizationProvider value={customization}>
      <QueuedPromptDisplay
        prompts={prompts}
        t={t}
        {...handlers}
        {...overrides}
      />
    </WebShellCustomizationProvider>,
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

  it('renders queued reference annotations as tags', () => {
    const serialized = '<context id="orders">orders</context>';
    const text = `inspect ${serialized} now`;
    const start = text.indexOf(serialized);
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text,
          inputAnnotations: [
            {
              type: 'reference',
              start,
              end: start + serialized.length,
              text: serialized,
              reference: {
                id: 'orders',
                kind: 'data-table',
                label: 'Table',
                value: 'orders',
                serialized,
              },
            },
          ],
        },
      ],
    });

    expect(container.textContent).toContain('inspect');
    expect(container.textContent).toContain('Table');
    expect(container.textContent).toContain('orders');
    expect(container.textContent).not.toContain(serialized);
  });

  it('parses the complete legacy queued prompt before rendering its tag', () => {
    const serialized = `<context>${'x'.repeat(300)}</context>`;
    const text = `${serialized} explain the table`;
    const parser = vi.fn(() => [
      {
        type: 'tag' as const,
        tag: { id: 'orders', value: 'orders', serialized },
      },
      { type: 'text' as const, text: ' explain the table' },
    ]);
    const { container } = setup(
      { prompts: [{ id: 1, text }] },
      { parseUserMessageContent: parser },
    );

    expect(parser).toHaveBeenCalledWith(text);
    expect(container.textContent).toContain('orders');
    expect(container.textContent).not.toContain(serialized);
  });

  it('falls back to raw queued text when parser output cannot recreate it', () => {
    const text = '<context id="orders">orders</context>';
    const { container } = setup(
      { prompts: [{ id: 1, text }] },
      {
        parseUserMessageContent: () => [
          { type: 'text', text: 'different content' },
        ],
      },
    );

    expect(container.textContent).toContain(text);
    expect(container.textContent).not.toContain('different content');
  });

  it('falls back to raw queued text when a tag field is malformed', () => {
    const text = '<context id="orders">orders</context>';
    const malformedParser = (() => [
      {
        type: 'tag',
        tag: { id: 'orders', serialized: 1 },
      },
    ]) as unknown as UserMessageContentParser;
    const { container } = setup(
      { prompts: [{ id: 1, text }] },
      { parseUserMessageContent: malformedParser },
    );

    expect(container.textContent).toContain(text);
  });

  it('omits an atomic tag that exceeds the visible preview budget', () => {
    const visibleTag = 'x'.repeat(241);
    const serialized = `<context>${visibleTag}</context>`;
    const { container } = setup(
      { prompts: [{ id: 1, text: serialized }] },
      {
        parseUserMessageContent: () => [
          {
            type: 'tag',
            tag: { id: 'orders', value: visibleTag, serialized },
          },
        ],
      },
    );

    expect(container.textContent).toContain('...');
    expect(container.textContent).not.toContain(visibleTag);
    expect(container.textContent).not.toContain(serialized);
  });

  it('falls back to raw queued text when parsing throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = setup(
      { prompts: [{ id: 1, text: 'raw <broken /> content' }] },
      {
        parseUserMessageContent: () => {
          throw new Error('bad host payload');
        },
      },
    );

    expect(container.textContent).toContain('raw <broken /> content');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
