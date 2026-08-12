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
    onEdit: vi.fn(),
    onRestoreUnknown: vi.fn(),
    onDiscardUnknown: vi.fn(),
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
        canMutateMidTurn
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

  it('renders image thumbnails after the text', () => {
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: '带图消息',
          images: [{ data: 'aW1n', media_type: 'image/png' }],
        },
      ],
    });
    expect(container.textContent).toContain('带图消息');
    const img = container.querySelector<HTMLImageElement>(
      'img[class*="queuedPromptImage"]',
    );
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,aW1n');
    expect(img?.getAttribute('alt')).toBe('用户上传的图片 1');
    // The thumbnail sits in the row after the text span.
    const row = container.querySelector('[class*="queuedPromptText"]');
    expect(row).not.toBeNull();
    const position = row?.compareDocumentPosition(img as Node) ?? 0;
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not render unsafe image data URIs', () => {
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: '不安全图片',
          images: [{ data: 'PHNjcmlwdD4=', media_type: 'text/html' }],
        },
      ],
    });

    expect(
      container.querySelector('img[class*="queuedPromptImage"]'),
    ).toBeNull();
    expect(container.querySelector('[class*="queuedPromptImages"]')).toBeNull();
  });

  it('calls onImagePreview when a thumbnail is clicked', () => {
    const onImagePreview = vi.fn();
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: '带图消息',
          images: [{ data: 'aW1n', media_type: 'image/png' }],
        },
      ],
      onImagePreview,
    });
    const img = container.querySelector<HTMLImageElement>(
      'img[class*="queuedPromptImage"]',
    );
    expect(img).not.toBeNull();
    expect(img?.classList.toString()).toContain('queuedPromptImageInteractive');
    act(() => img?.click());
    expect(onImagePreview).toHaveBeenCalledWith(
      'data:image/png;base64,aW1n',
      '用户上传的图片 1',
    );
    expect(img?.getAttribute('role')).toBe('button');
    expect(img?.tabIndex).toBe(0);
    act(() => {
      img?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      img?.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });
    expect(onImagePreview).toHaveBeenCalledTimes(3);
  });

  it('shows server queue status without an insert action', () => {
    const { container } = setup({
      prompts: [{ id: 1, text: '等待处理', serverState: 'queued' }],
    });

    expect(container.textContent).toContain('服务器排队中...');
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    expect(
      container.querySelector('[class*="queuedPromptSpinner"]'),
    ).toBeNull();
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(container.textContent).not.toContain('插入');
  });

  it('allows deleting but not editing a summary-only server row', () => {
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: '[image]',
          serverPromptId: 'server-1',
          serverState: 'queued',
          payloadCompleteness: 'summary-only',
        },
      ],
    });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t('queue.delete')}"]`,
    );
    const editButton = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t('queue.edit')}"]`,
    );
    expect(deleteButton?.disabled).toBe(false);
    expect(editButton?.disabled).toBe(true);
    expect(editButton?.title).toBe(t('queue.summaryEditDisabled'));
    expect(container.textContent).not.toContain(t('queue.footer'));
  });

  it('keeps a mid-turn prompt queued until injection', () => {
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: '补充信息',
          midTurnState: 'queued',
          midTurnMessageId: 'mid-1',
        },
      ],
    });

    expect(container.textContent).toContain('排队中...');
    expect(container.querySelectorAll('button')).toHaveLength(2);
    const status = container.querySelector('[role="status"]');
    expect(status?.previousElementSibling?.textContent).toBe('补充信息');
    expect(status?.nextElementSibling?.querySelectorAll('button')).toHaveLength(
      2,
    );
    expect(
      [...container.querySelectorAll('button')].every(
        (button) => !button.disabled,
      ),
    ).toBe(true);
  });

  it('keeps actions disabled when an older daemon returns no message id', () => {
    const { container } = setup({
      prompts: [{ id: 1, text: '补充信息', midTurnState: 'queued' }],
    });

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it('hides mid-turn mutation actions without the capability', () => {
    const { container } = setup({
      canMutateMidTurn: false,
      prompts: [
        {
          id: 1,
          text: '补充信息',
          midTurnState: 'queued',
          midTurnMessageId: 'mid-1',
        },
      ],
    });

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps the spinner while a prompt is still submitting', () => {
    const { container } = setup({
      prompts: [{ id: 1, text: '正在发送', serverState: 'submitting' }],
    });

    expect(container.textContent).toContain('提交中...');
    expect(
      container.querySelector('[class*="queuedPromptSpinner"]'),
    ).toBeTruthy();
  });

  it('requires confirmation before restoring an unknown local payload', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container, handlers } = setup({
      prompts: [
        {
          id: 1,
          text: '',
          images: [{ data: 'cG5n', media_type: 'image/png' }],
          admissionOutcome: 'unknown',
          payloadCompleteness: 'complete',
          payloadAvailable: true,
        },
      ],
    });
    const restore = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t('queue.restoreUnknown')}"]`,
    );
    const discard = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t('queue.discardUnknown')}"]`,
    );

    act(() => restore?.click());
    expect(handlers.onRestoreUnknown).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    act(() => restore?.click());
    expect(handlers.onRestoreUnknown).toHaveBeenCalledWith(1);
    act(() => discard?.click());
    expect(handlers.onDiscardUnknown).toHaveBeenCalledWith(1);
    expect(container.textContent).not.toContain(t('queue.footer'));
    confirm.mockRestore();
  });

  it('warns when an unknown local copy may match a server summary', () => {
    const { container } = setup({
      prompts: [
        {
          id: 1,
          text: 'uncertain',
          admissionOutcome: 'unknown',
          payloadCompleteness: 'complete',
          payloadAvailable: true,
        },
        {
          id: 2,
          text: '[image]',
          serverPromptId: 'server-1',
          serverState: 'queued',
          payloadCompleteness: 'summary-only',
        },
      ],
    });

    expect(container.textContent).toContain(t('queue.mayCorrespond'));
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

  it('does not render an insert action for a command prompt', () => {
    const { container } = setup({
      prompts: [{ id: 1, text: '/help me' }],
    });
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.textContent).not.toContain('插入');
  });
});
