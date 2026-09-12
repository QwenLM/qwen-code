// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebShellCustomizationProvider } from '../../customization';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { buildScheduledTaskRunContent } from '../../utils/scheduledTaskRunContent';
import { UserMessage } from './UserMessage';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

// React tracks a controlled field's value internally, so writing `.value`
// directly is ignored; go through the prototype setter and fire `input`.
function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function referenceAnnotation(
  content: string,
  text: string,
  reference: {
    id: string;
    kind?: string;
    label?: string;
    value?: string;
    serialized?: string;
    removable?: boolean;
  },
) {
  const start = content.indexOf(text);
  if (start < 0) {
    throw new Error(`Missing annotation text: ${text}`);
  }
  return {
    type: 'reference' as const,
    start,
    end: start + text.length,
    text,
    reference,
  };
}

function findByTitle(container: HTMLElement, title: string): Element | null {
  return (
    Array.from(container.querySelectorAll('[title]')).find(
      (element) => element.getAttribute('title') === title,
    ) ?? null
  );
}

describe('UserMessage', () => {
  it('renders content', () => {
    const container = render(<UserMessage content="hello world" />);
    expect(container.textContent).toContain('hello world');
  });

  it('edits the message in place and submits the edited text', () => {
    const onEditSubmit = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content="hello world"
          editing
          onEditSubmit={onEditSubmit}
          onEditCancel={vi.fn()}
        />
      </I18nProvider>,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');

    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe('hello world');
    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Send',
    );

    act(() => {
      setTextareaValue(textarea!, 'edited text');
    });
    act(() => {
      send?.click();
    });

    expect(onEditSubmit).toHaveBeenCalledWith('edited text');
  });

  it('cancels the in-place editor on Escape', () => {
    const onEditCancel = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content="hello world"
          editing
          onEditSubmit={vi.fn()}
          onEditCancel={onEditCancel}
        />
      </I18nProvider>,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');

    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(onEditCancel).toHaveBeenCalledTimes(1);
  });

  it('shows progress and ignores input while the edit is being sent', () => {
    const onEditSubmit = vi.fn();
    const onEditCancel = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content="hello world"
          editing
          submittingEdit
          onEditSubmit={onEditSubmit}
          onEditCancel={onEditCancel}
        />
      </I18nProvider>,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    const buttons = [...container.querySelectorAll('button')];
    const send = buttons.find((button) => button.textContent === 'Sending…');

    expect(send).not.toBeUndefined();
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(textarea?.readOnly).toBe(true);

    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      send?.click();
    });

    expect(onEditSubmit).not.toHaveBeenCalled();
    expect(onEditCancel).not.toHaveBeenCalled();
  });

  it('submits on Enter and keeps Shift+Enter for a newline', () => {
    const onEditSubmit = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content="hello world"
          editing
          onEditSubmit={onEditSubmit}
          onEditCancel={vi.fn()}
        />
      </I18nProvider>,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');

    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(onEditSubmit).not.toHaveBeenCalled();

    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onEditSubmit).toHaveBeenCalledWith('hello world');
  });

  it('disables Send while the draft is empty', () => {
    const onEditSubmit = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content="hello world"
          editing
          onEditSubmit={onEditSubmit}
          onEditCancel={vi.fn()}
        />
      </I18nProvider>,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Send',
    );

    act(() => {
      setTextareaValue(textarea!, '   ');
    });
    expect(send?.disabled).toBe(true);

    act(() => {
      send?.click();
    });
    expect(onEditSubmit).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'Escape'])(
    'ignores IME-owned %s after compositionend',
    (key) => {
      const onEditSubmit = vi.fn();
      const onEditCancel = vi.fn();
      const container = render(
        <I18nProvider language="en">
          <UserMessage
            content="中文草稿"
            editing
            onEditSubmit={onEditSubmit}
            onEditCancel={onEditCancel}
          />
        </I18nProvider>,
      );
      const event = new KeyboardEvent('keydown', {
        key,
        keyCode: 229,
        isComposing: false,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        container.querySelector('textarea')!.dispatchEvent(event);
      });
      expect(onEditSubmit).not.toHaveBeenCalled();
      expect(onEditCancel).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it('can edit and resend an attachment-only message', () => {
    const onEditSubmit = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content=""
          images={[{ data: 'aW1hZ2U=', mimeType: 'image/png' }]}
          editing
          onEditSubmit={onEditSubmit}
        />
      </I18nProvider>,
    );
    expect(container.querySelector('textarea')).not.toBeNull();
    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Send',
    )!;
    expect(send.disabled).toBe(false);
    act(() => {
      send.click();
    });
    expect(onEditSubmit).toHaveBeenCalledWith('');
  });

  it('does not render an in-place editor by default', () => {
    const container = render(
      <I18nProvider language="en">
        <UserMessage content="hello world" />
      </I18nProvider>,
    );
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('does not visually clip an overflowing message in document mode', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    const container = render(
      <TranscriptRenderModeProvider value="document">
        <UserMessage content="full exported prompt" />
      </TranscriptRenderModeProvider>,
    );
    const content = container.querySelector('[class*="chatContent"]');

    expect(content?.className).not.toContain('chatContentCollapsed');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('full exported prompt');
  });

  it('renders scheduled-task context as a compact localized card', () => {
    const renderUserMessageContent = vi.fn(() => <span>custom message</span>);
    const content =
      'Scheduled task: Review PRs\n' +
      'Task ID: task-1\n' +
      'Schedule: 0 * * * *\n' +
      'Triggered at: 2026-08-26T07:27:00.000Z\n' +
      'Trigger: scheduled\n' +
      'Session: new chat for this run\n\n' +
      'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.\n\n' +
      'review the next PR';
    const container = render(
      <I18nProvider language="zh-CN">
        <WebShellCustomizationProvider value={{ renderUserMessageContent }}>
          <UserMessage content={content} />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );

    expect(
      container.querySelector('[data-web-shell-scheduled-task-run-message]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('定时任务运行');
    expect(container.textContent).toContain('Review PRs');
    expect(container.textContent).toContain('任务 ID: task-1');
    expect(container.textContent).toContain('定时触发');
    expect(container.textContent).toContain('每次新会话');
    expect(container.textContent).toContain('review the next PR');
    expect(container.textContent).not.toContain(
      'Do not create or modify a schedule',
    );
    expect(renderUserMessageContent).not.toHaveBeenCalled();
  });

  it('renders persistent scheduled-task context with a fixed-session badge', () => {
    const content = buildScheduledTaskRunContent({
      id: 'task-3',
      name: 'Daily\n\u001b[31mrestart\u001b[0m',
      cron: '0 9 * * *',
      triggeredAt: Date.parse('2026-09-11T01:00:00.000Z'),
      trigger: 'scheduled',
      sessionMode: 'persistent',
      prompt: 'restart the server',
    });
    const container = render(
      <I18nProvider language="zh-CN">
        <UserMessage content={content} />
      </I18nProvider>,
    );

    expect(
      container.querySelector('[data-web-shell-scheduled-task-run-message]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('定时任务运行');
    expect(container.textContent).toContain('固定会话');
    expect(container.textContent).not.toContain('每次新会话');
    expect(container.textContent).toContain('Daily restart');
    expect(container.textContent).toContain('restart the server');
  });

  it('linkifies URLs inside a scheduled-task prompt', () => {
    const content =
      'Scheduled task: Check incidents\n' +
      'Task ID: task-2\n' +
      'Schedule: 0 * * * *\n' +
      'Triggered at: 2026-08-26T07:27:00.000Z\n' +
      'Trigger: scheduled\n' +
      'Session: new chat for this run\n\n' +
      'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.\n\n' +
      'check https://status.example.com/incidents, then reply';
    const container = render(<UserMessage content={content} />);

    const message = container.querySelector(
      '[data-web-shell-scheduled-task-run-message]',
    );
    expect(message).not.toBeNull();
    const link = message?.querySelector(
      'a[href="https://status.example.com/incidents"]',
    );
    expect(link).not.toBeNull();
    expect(container.textContent).toContain(', then reply');
  });

  it('renders an accessible retry action for a failed send', () => {
    const onRetrySend = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content="hello world"
          sendFailed
          onRetrySend={onRetrySend}
        />
      </I18nProvider>,
    );

    expect(container.textContent).toContain('Failed to send');
    const retry = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry sending message"]',
    );
    expect(retry?.type).toBe('button');
    expect(retry?.title).toBe('Retry sending message');
    expect(retry?.textContent).toBe('Try again');

    act(() => retry?.click());
    expect(onRetrySend).toHaveBeenCalledTimes(1);
  });

  it('does not render send failure controls by default', () => {
    const container = render(<UserMessage content="hello world" />);

    expect(container.textContent).not.toContain('Failed to send');
    expect(
      container.querySelector('button[aria-label="Retry sending message"]'),
    ).toBeNull();
  });

  it('renders file references as chips from input annotations', () => {
    const content = 'list @.qwen/ files';
    const container = render(
      <UserMessage
        content={content}
        inputAnnotations={[
          referenceAnnotation(content, '@.qwen/', {
            id: 'file:@.qwen/',
            kind: 'file',
            value: '.qwen/',
            serialized: '@.qwen/',
          }),
        ]}
      />,
    );
    const chip = container.querySelector('[title="@.qwen/"]');

    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('.qwen/');
    expect(container.textContent).toContain('list .qwen/ files');
  });

  it('uses configured composer tag icons for annotation chips', () => {
    const content = 'list @.qwen/ files';
    const container = render(
      <WebShellCustomizationProvider
        value={{
          composerTagIcons: { file: '/custom-file.svg' },
        }}
      >
        <UserMessage
          content={content}
          inputAnnotations={[
            referenceAnnotation(content, '@.qwen/', {
              id: 'file:@.qwen/',
              kind: 'file',
              value: '.qwen/',
              serialized: '@.qwen/',
            }),
          ]}
        />
      </WebShellCustomizationProvider>,
    );
    const icon = container.querySelector<HTMLElement>(
      '[title="@.qwen/"] [aria-hidden="true"]',
    );

    expect(icon).not.toBeNull();
    expect(icon?.style.getPropertyValue('--user-message-tag-icon-url')).toBe(
      'url("/custom-file.svg")',
    );
  });

  it('renders extension and MCP references as chips from input annotations', () => {
    const content = '@ext:browser and @mcp:docs';
    const container = render(
      <UserMessage
        content={content}
        inputAnnotations={[
          referenceAnnotation(content, '@ext:browser', {
            id: 'extension:@ext:browser',
            kind: 'extension',
            value: 'browser',
            serialized: '@ext:browser',
          }),
          referenceAnnotation(content, '@mcp:docs', {
            id: 'mcp:@mcp:docs',
            kind: 'mcp',
            value: 'docs',
            serialized: '@mcp:docs',
          }),
        ]}
      />,
    );

    expect(container.querySelector('[title="@ext:browser"]')).not.toBeNull();
    expect(container.querySelector('[title="@mcp:docs"]')).not.toBeNull();
    expect(container.textContent).toContain('browser and docs');
  });

  it.each(['extension', 'file', 'mcp', 'skill'] as const)(
    'renders the built-in %s icon for annotation chips',
    (kind) => {
      const serialized = `@${kind}:reference`;
      const container = render(
        <UserMessage
          content={serialized}
          inputAnnotations={[
            referenceAnnotation(serialized, serialized, {
              id: `${kind}:reference`,
              kind,
              value: kind,
              serialized,
            }),
          ]}
        />,
      );

      expect(
        container.querySelector(`[title="${serialized}"] [aria-hidden="true"]`),
      ).not.toBeNull();
    },
  );

  it('does not render inline email addresses as chips', () => {
    const container = render(<UserMessage content="mail me at a@b.test" />);

    expect(container.querySelector('[title="@b.test"]')).toBeNull();
    expect(container.textContent).toContain('a@b.test');
  });

  it('linkifies URLs in text parts from a host-provided parser', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => [
            { type: 'text', text: 'see https://example.com/parsed ' },
            {
              type: 'tag',
              tag: {
                id: 'file:readme',
                kind: 'file',
                value: 'readme',
                serialized: '@file:readme',
              },
            },
          ],
        }}
      >
        <UserMessage content="see https://example.com/parsed @file:readme" />
      </WebShellCustomizationProvider>,
    );

    expect(
      container.querySelector('a[href="https://example.com/parsed"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('readme');
  });

  it('renders URLs in message text as external links', () => {
    const container = render(
      <UserMessage content="see https://example.com/docs, then reply" />,
    );

    const link = container.querySelector(
      '[data-web-shell-user-bubble] a[href="https://example.com/docs"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain(
      'see https://example.com/docs, then reply',
    );
  });

  it('renders URLs as links alongside annotated reference chips', () => {
    const content = 'open https://example.com with @ext:browser';
    const container = render(
      <UserMessage
        content={content}
        inputAnnotations={[
          referenceAnnotation(content, '@ext:browser', {
            id: '@ext:browser',
            kind: 'extension',
            value: 'browser',
            serialized: '@ext:browser',
          }),
        ]}
      />,
    );

    expect(
      container.querySelector('a[href="https://example.com"]'),
    ).not.toBeNull();
    expect(container.querySelector('[title="@ext:browser"]')).not.toBeNull();
  });

  it('keeps references as text without input annotations', () => {
    const container = render(<UserMessage content="open @dataset:users" />);

    expect(container.querySelector('[title="@dataset:users"]')).toBeNull();
    expect(container.textContent).toContain('open @dataset:users');
  });

  it('renders extensionless file references from input annotations', () => {
    const content = 'open @Makefile and @src/Makefile';
    const container = render(
      <UserMessage
        content={content}
        inputAnnotations={[
          referenceAnnotation(content, '@Makefile', {
            id: 'file:@Makefile',
            kind: 'file',
            value: 'Makefile',
            serialized: '@Makefile',
          }),
          referenceAnnotation(content, '@src/Makefile', {
            id: 'file:@src/Makefile',
            kind: 'file',
            value: 'src/Makefile',
            serialized: '@src/Makefile',
          }),
        ]}
      />,
    );

    expect(container.querySelector('[title="@Makefile"]')).not.toBeNull();
    expect(container.querySelector('[title="@src/Makefile"]')).not.toBeNull();
    expect(container.textContent).toContain('open Makefile and src/Makefile');
  });

  it('keeps MCP resource trailing punctuation from input annotations', () => {
    const serialized = '@docs\\:res\\://doc.';
    const content = `open ${serialized} now`;
    const container = render(
      <UserMessage
        content={content}
        inputAnnotations={[
          referenceAnnotation(content, serialized, {
            id: `mcp:${serialized}`,
            kind: 'mcp',
            value: 'docs:res://doc.',
            serialized,
          }),
        ]}
      />,
    );

    expect(findByTitle(container, serialized)).not.toBeNull();
    expect(container.textContent).toContain('open docs:res://doc. now');
  });

  it('keeps escaped trailing punctuation from input annotations', () => {
    const serialized = '@path\\:';
    const content = `open ${serialized}`;
    const container = render(
      <UserMessage
        content={content}
        inputAnnotations={[
          referenceAnnotation(content, serialized, {
            id: `file:${serialized}`,
            kind: 'file',
            value: 'path:',
            serialized,
          }),
        ]}
      />,
    );

    expect(findByTitle(container, serialized)).not.toBeNull();
    expect(container.textContent).toContain('open path:');
  });

  it('renders custom provider references from input annotations', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          composerTagIcons: { dataset: '/dataset.svg' },
        }}
      >
        <UserMessage
          content="open @dataset:users"
          inputAnnotations={[
            {
              type: 'reference',
              start: 5,
              end: 19,
              text: '@dataset:users',
              reference: {
                id: 'dataset:users',
                kind: 'dataset',
                label: 'Dataset',
                value: 'users',
                serialized: '@dataset:users',
              },
            },
          ]}
        />
      </WebShellCustomizationProvider>,
    );
    const chip = container.querySelector('[title="@dataset:users"]');
    const icon = chip?.querySelector<HTMLElement>('[aria-hidden="true"]');

    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('Datasetusers');
    expect(icon?.style.getPropertyValue('--user-message-tag-icon-url')).toBe(
      'url("/dataset.svg")',
    );
  });

  it('renders images when provided', () => {
    const container = render(
      <UserMessage
        content="check this"
        images={[{ data: 'abc', mimeType: 'image/png' }]}
      />,
    );
    expect(container.textContent).toContain('check this');
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,abc');
  });

  it('opens the image preview on click', () => {
    const onImagePreview = vi.fn();
    const container = render(
      <UserMessage
        content=""
        images={[{ data: 'abc', mimeType: 'image/png' }]}
        onImagePreview={onImagePreview}
      />,
    );
    const img = container.querySelector('img')!;
    expect(container.querySelector('[data-web-shell-user-bubble]')).toBeNull();
    act(() => img.click());
    expect(onImagePreview).toHaveBeenCalledWith(
      'data:image/png;base64,abc',
      expect.any(String),
      undefined,
    );
  });

  it('keeps uploaded images attachment-backed when opening the preview', () => {
    const onImagePreview = vi.fn();
    const container = render(
      <UserMessage
        content=""
        images={[
          {
            data: 'abc',
            mimeType: 'image/png',
            attachmentId: 'photo.png',
          },
        ]}
        onImagePreview={onImagePreview}
      />,
    );

    act(() => container.querySelector('img')?.click());
    expect(onImagePreview).toHaveBeenCalledWith(
      'data:image/png;base64,abc',
      expect.any(String),
      { kind: 'attachment', attachmentId: 'photo.png' },
    );
  });

  it('renders BMP images through the shared safe-source policy', () => {
    const container = render(
      <UserMessage
        content=""
        images={[{ data: 'Qk0=', mimeType: 'image/bmp' }]}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/bmp;base64,Qk0=',
    );
  });

  it('renders file attachment chips when provided', () => {
    const container = render(
      <UserMessage
        content="check this"
        files={[{ name: 'app.log', mimeType: 'text/plain' }]}
      />,
    );
    expect(container.textContent).toContain('check this');
    expect(container.textContent).toContain('app.log');
  });

  it('does not render an empty bubble for a file-only message', () => {
    const container = render(
      <UserMessage
        content=""
        files={[{ name: 'app.log', mimeType: 'text/plain' }]}
      />,
    );

    expect(
      container.querySelector('[data-web-shell-user-files]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-web-shell-user-bubble]')).toBeNull();
  });

  it('flashes the wrapper for a located file-only message', () => {
    const container = render(
      <UserMessage
        content=""
        files={[{ name: 'app.log', mimeType: 'text/plain' }]}
        isLocateFlashing
      />,
    );

    expect(
      container.querySelector('[data-web-shell-user-files]')?.parentElement
        ?.className,
    ).toContain('flash');
  });

  it.each([
    ['report.HTML', 'text/html', 'HTML', 'html'],
    ['README', 'text/plain', 'text/plain', 'file-text'],
    ['LICENSE', '', 'FILE', 'file'],
  ])('renders attachment metadata for %s', (name, mimeType, type, icon) => {
    const container = render(
      <UserMessage content="" files={[{ name, mimeType }]} />,
    );
    const card = container.querySelector('[data-web-shell-user-files]');
    expect(card?.querySelector(`[title="${name}"]`)?.textContent).toBe(name);
    expect(card?.querySelector(`[title="${type}"]`)?.textContent).toBe(type);
    expect(
      card?.querySelector(
        icon === 'file-text'
          ? 'svg.lucide-file-text'
          : `[data-file-type-icon="${icon}"]`,
      ),
    ).not.toBeNull();
  });

  it('previews a sent text attachment when its chip is clicked', () => {
    const onAttachmentPreview = vi.fn();
    const container = render(
      <I18nProvider language="en">
        <UserMessage
          content="check this"
          files={[
            {
              name: 'app.log',
              mimeType: 'text/plain',
              text: 'line one',
            },
          ]}
          onAttachmentPreview={onAttachmentPreview}
        />
      </I18nProvider>,
    );

    act(() => {
      (container.querySelector('[role="button"]') as HTMLElement).click();
    });

    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'app.log',
      mimeType: 'text/plain',
      text: 'line one',
    });
    const chip = container.querySelector('[role="button"]') as HTMLElement;
    expect(
      container.querySelector('[data-web-shell-user-bubble]')?.contains(chip),
    ).toBe(false);
  });

  it('previews a replayed daemon attachment by id', () => {
    const onAttachmentPreview = vi.fn();
    const container = render(
      <UserMessage
        content="check this"
        files={[
          {
            name: 'data.json',
            mimeType: 'text/plain',
            attachmentId: 'attachment-1',
          },
        ]}
        onAttachmentPreview={onAttachmentPreview}
      />,
    );

    act(() => {
      (container.querySelector('[role="button"]') as HTMLElement).click();
    });

    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'data.json',
      mimeType: 'text/plain',
      attachmentId: 'attachment-1',
    });
  });

  it.each(['Enter', ' '])(
    'previews a file attachment with the %s key',
    (key) => {
      const onAttachmentPreview = vi.fn();
      const container = render(
        <UserMessage
          content="check this"
          files={[
            {
              name: 'data.json',
              mimeType: 'application/json',
              attachmentId: 'data.json',
            },
          ]}
          onAttachmentPreview={onAttachmentPreview}
        />,
      );
      const chip = container.querySelector('[role="button"]') as HTMLElement;

      act(() => {
        chip.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });

      expect(onAttachmentPreview).toHaveBeenCalledWith({
        name: 'data.json',
        mimeType: 'application/json',
        attachmentId: 'data.json',
      });
    },
  );

  it('previews a local attachment blob after a failed send', () => {
    const onAttachmentPreview = vi.fn();
    const data = new Blob(['draft']);
    const container = render(
      <UserMessage
        content="check this"
        files={[{ name: 'draft.txt', mimeType: 'text/plain', data }]}
        onAttachmentPreview={onAttachmentPreview}
      />,
    );

    act(() => {
      (container.querySelector('[role="button"]') as HTMLElement).click();
    });

    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'draft.txt',
      mimeType: 'text/plain',
      data,
    });
  });

  it('previews a sent workspace file tag by path', () => {
    const onAttachmentPreview = vi.fn();
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => [
            {
              type: 'tag',
              tag: {
                id: 'file:docs/notes.txt',
                value: 'docs/notes.txt',
                kind: 'file',
                serialized: '@docs/notes.txt',
              },
            },
          ],
        }}
      >
        <UserMessage
          content="@docs/notes.txt"
          onAttachmentPreview={onAttachmentPreview}
        />
      </WebShellCustomizationProvider>,
    );

    act(() => {
      (container.querySelector('[role="button"]') as HTMLElement).click();
    });

    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'notes.txt',
      workspacePath: 'docs/notes.txt',
    });
    expect(container.querySelector('svg.lucide-file-text')).not.toBeNull();
    expect(container.textContent).toContain('docs/notes.txt');
  });

  it('does not make a sent directory tag previewable', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => [
            {
              type: 'tag',
              tag: {
                id: 'file:@docs/',
                value: 'docs',
                kind: 'file',
                metadata: { fileKind: 'directory' },
                serialized: '@docs/',
              },
            },
          ],
        }}
      >
        <UserMessage content="@docs/" onAttachmentPreview={vi.fn()} />
      </WebShellCustomizationProvider>,
    );

    expect(container.querySelector('[role="button"]')).toBeNull();
  });

  it('uses a custom content renderer when provided', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          renderUserMessageContent: ({ content, inputAnnotations }) => (
            <span data-testid="tag-chip">
              {content.slice(1)}:{inputAnnotations?.length ?? 0}
            </span>
          ),
        }}
      >
        <UserMessage
          content="@.husky/_/husky.sh xuyao"
          inputAnnotations={[
            {
              type: 'reference',
              start: 0,
              end: 19,
              text: '@.husky/_/husky.sh',
              reference: {
                id: 'file:@.husky/_/husky.sh',
                kind: 'file',
                value: '.husky/_/husky.sh',
                serialized: '@.husky/_/husky.sh',
              },
            },
          ]}
        />
      </WebShellCustomizationProvider>,
    );

    expect(container.querySelector('[data-testid="tag-chip"]')).not.toBeNull();
    expect(container.textContent).toContain('.husky/_/husky.sh xuyao:1');
  });

  it('renders parsed user-message tag parts', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => [
            { type: 'text', text: 'open ' },
            {
              type: 'tag',
              tag: {
                id: 'ctx-1',
                label: 'Table',
                value: 'orders',
                serialized: '<context />',
              },
            },
          ],
        }}
      >
        <UserMessage content="open <context />" />
      </WebShellCustomizationProvider>,
    );

    expect(container.textContent).toContain('open ');
    expect(container.textContent).toContain('Table');
    expect(container.textContent).toContain('orders');
  });

  it('guards parsed tag mask icon sources', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => [
            {
              type: 'tag',
              tag: {
                id: 'ctx-1',
                label: 'Table',
                value: 'orders',
                icon: 'javascript:alert(1)',
              },
            },
          ],
        }}
      >
        <UserMessage content="<context />" />
      </WebShellCustomizationProvider>,
    );

    expect(container.textContent).toContain('orders');
    expect(container.innerHTML).not.toContain('javascript:alert');
    expect(
      container.querySelector('[style*="--user-message-tag-icon-url"]'),
    ).toBeNull();
  });

  it('renders kind-based tags like composer chips without the raw label', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => [
            { type: 'text', text: 'explain ' },
            {
              type: 'tag',
              tag: {
                id: 'ctx-1',
                label: '@',
                value: 'project.orders',
                kind: 'table',
                serialized: '<context />',
              },
            },
            { type: 'text', text: ' now' },
          ],
        }}
      >
        <UserMessage content="explain <context /> now" />
      </WebShellCustomizationProvider>,
    );

    expect(container.textContent).toBe('explain project.orders now');
    expect(container.querySelector('[title="project.orders"]')).not.toBeNull();
  });

  it('uses custom composer tag icons for parsed user-message tags', () => {
    const container = render(
      <WebShellCustomizationProvider
        value={{
          composerTagIcons: {
            table: 'https://example.test/table.svg',
          },
          parseUserMessageContent: () => [
            {
              type: 'tag',
              tag: {
                id: 'ctx-1',
                value: 'project.orders',
                kind: 'table',
                serialized: '<context />',
              },
            },
          ],
        }}
      >
        <UserMessage content="<context />" />
      </WebShellCustomizationProvider>,
    );

    expect(
      container.querySelector('[style*="https://example.test/table.svg"]'),
    ).not.toBeNull();
  });

  it('fires user-message tag clicks with the user-message placement', () => {
    const onComposerTagClick = vi.fn();
    const container = render(
      <WebShellCustomizationProvider
        value={{
          onComposerTagClick,
          parseUserMessageContent: () => [
            {
              type: 'tag',
              tag: {
                id: 'ctx-1',
                value: 'project.orders',
                kind: 'table',
                serialized: '<context />',
              },
            },
          ],
        }}
      >
        <UserMessage content="<context />" />
      </WebShellCustomizationProvider>,
    );
    const chip = container.querySelector('[role="button"]') as HTMLElement;

    act(() => chip.click());
    expect(onComposerTagClick).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: 'user-message',
        readonly: true,
        tag: expect.objectContaining({ id: 'ctx-1' }),
        anchorRect: expect.any(Object),
      }),
    );

    act(() => {
      chip.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onComposerTagClick).toHaveBeenCalledTimes(2);
    expect(onComposerTagClick).toHaveBeenLastCalledWith(
      expect.objectContaining({
        placement: 'user-message',
        readonly: true,
      }),
    );
  });

  it('falls back to raw content when user-message parsing throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => {
            throw new Error('bad host payload');
          },
        }}
      >
        <UserMessage content="raw <broken /> https://example.com/x" />
      </WebShellCustomizationProvider>,
    );

    expect(container.textContent).toBe('raw <broken /> https://example.com/x');
    expect(
      container.querySelector('a[href="https://example.com/x"]'),
    ).not.toBeNull();
    warn.mockRestore();
  });

  it('falls back when user-message tag rendering throws', () => {
    const renderError = new Error('bad tag renderer');
    const tooltipError = new Error('bad tag tooltip');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = render(
      <WebShellCustomizationProvider
        value={{
          parseUserMessageContent: () => [
            {
              type: 'tag',
              tag: {
                id: 'ctx-1',
                label: 'Table',
                value: 'orders',
                serialized: '<context />',
              },
            },
          ],
          renderComposerTag: () => {
            throw renderError;
          },
          renderComposerTagTooltip: () => {
            throw tooltipError;
          },
        }}
      >
        <UserMessage content="<context />" />
      </WebShellCustomizationProvider>,
    );

    expect(container.textContent).toContain('Table');
    expect(container.textContent).toContain('orders');
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] user message tag render failed',
      renderError,
    );
    expect(warn).toHaveBeenCalledWith(
      '[WebShell] user message tag tooltip render failed',
      tooltipError,
    );
    warn.mockRestore();
  });
});
