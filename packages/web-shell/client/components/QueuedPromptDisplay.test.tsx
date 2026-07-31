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
    onImmediateInsert: vi.fn(),
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
        insertActionsEnabled
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

  it('hides insert actions when the daemon lacks the capability', () => {
    const { container } = setup({ insertActionsEnabled: false });
    expect(container.textContent).not.toContain('立即插入');
    expect(container.querySelector('.lucide-corner-down-right')).toBeNull();
    expect(container.querySelector('.lucide-zap')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(4);
  });

  it('keeps insert available for a server-queued prompt', () => {
    const onInsert = vi.fn();
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: '等待处理',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        },
      ],
      onInsert,
    });

    expect(container.textContent).toContain('排队中...');
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    expect(
      container.querySelector('[class*="queuedPromptSpinner"]'),
    ).toBeNull();
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    const state = container.querySelector('[class*="queuedPromptState"]');
    const actions = container.querySelector('[class*="queuedPromptActions"]');
    expect(state?.nextElementSibling).toBe(actions);
    const insert = buttons.find(
      (button) => button.textContent?.trim() === '插入',
    );
    expect(insert?.querySelector('.lucide-corner-down-right')).toBeTruthy();
    expect(
      insert?.querySelector('[class*="queuedPromptActionIcon"]'),
    ).toBeNull();
    expect(insert?.title).toBe(
      '不中断当前输出，在同一回合的下一次模型调用时生效。',
    );
    const immediate = buttons.find((button) =>
      button.textContent?.includes('立即插入'),
    );
    expect(immediate?.querySelector('.lucide-zap')).toBeTruthy();
    expect(
      immediate?.querySelector('[class*="queuedPromptActionIcon"]'),
    ).toBeNull();
    expect(immediate?.title).toBe(
      '打断当前模型输出，在同一回合立即插入并继续生成。',
    );
    act(() =>
      insert!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onInsert).toHaveBeenCalledWith(1);
  });

  it('offers immediate insert for server-queued prompts', () => {
    const onImmediateInsert = vi.fn();
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: '队首消息',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        },
        {
          id: 2,
          text: '后续消息',
          serverPromptId: 'prompt-2',
          serverState: 'queued',
        },
      ],
      onImmediateInsert,
    });

    const immediateButtons = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent?.includes('立即插入'),
    );
    expect(immediateButtons).toHaveLength(2);
    act(() =>
      immediateButtons[1]!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(onImmediateInsert).toHaveBeenCalledWith(2);
  });

  it('shows immediate insert progress in place of queue actions', () => {
    const inserting = setup({
      prompts: [
        {
          id: 1,
          text: '准备立即插入',
          midTurnState: 'submitting',
          midTurnImmediate: true,
        },
      ],
    });
    const waiting = setup({
      prompts: [
        {
          id: 2,
          text: '等待立即生效',
          midTurnState: 'queued',
          midTurnImmediate: true,
        },
      ],
    });

    expect(inserting.container.textContent).toContain('正在立即插入...');
    expect(
      inserting.container.querySelector('[class*="queuedPromptSpinner"]'),
    ).toBeTruthy();
    expect(inserting.container.querySelectorAll('button')).toHaveLength(0);
    expect(waiting.container.textContent).toContain('等待立即生效...');
    expect(
      waiting.container.querySelector('[class*="queuedPromptSpinner"]'),
    ).toBeNull();
    expect(waiting.container.querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps an accepted mid-turn insert visible until it is injected', () => {
    const { container } = setup({
      prompts: [{ id: 1, text: '等待插入', midTurnState: 'queued' }],
    });

    expect(container.textContent).toContain('等待插入');
    expect(container.textContent).toContain('等待模型接收...');
    expect(
      container.querySelector('[role="status"]')?.getAttribute('title'),
    ).toBe('将在下一次模型调用时生效。');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(0);
  });

  it('keeps the spinner while a prompt or insert is still submitting', () => {
    const prompt = setup({
      prompts: [{ id: 1, text: '正在发送', serverState: 'submitting' }],
    });
    const insert = setup({
      prompts: [{ id: 2, text: '正在插入', midTurnState: 'submitting' }],
    });

    expect(prompt.container.textContent).toContain('提交中...');
    expect(insert.container.textContent).toContain('正在插入当前回合...');
    for (const { container } of [prompt, insert]) {
      expect(
        container.querySelector('[class*="queuedPromptSpinner"]'),
      ).toBeTruthy();
    }
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

  it('truncates a text-only queued prompt at the visible preview budget', () => {
    const text = 'x'.repeat(300);
    const { container } = setup({ prompts: [{ id: 1, text }] });

    expect(
      container.querySelector('[class*="queuedPromptText"]')?.textContent,
    ).toBe(`${text.slice(0, 240)}...`);
  });

  it('truncates trailing text after an atomic tag consumes the visible preview budget', () => {
    const visibleTag = 'x'.repeat(240);
    const serialized = `<context>${visibleTag}</context>`;
    const trailingText = ' explain the table';
    const { container } = setup(
      { prompts: [{ id: 1, text: `${serialized}${trailingText}` }] },
      {
        parseUserMessageContent: () => [
          {
            type: 'tag',
            tag: { id: 'orders', value: visibleTag, serialized },
          },
          { type: 'text', text: trailingText },
        ],
      },
    );

    expect(
      container.querySelector('[class*="queuedPromptText"]')?.textContent,
    ).toBe(`${visibleTag}...`);
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
