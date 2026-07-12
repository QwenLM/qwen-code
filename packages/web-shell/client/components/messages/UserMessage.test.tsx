// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebShellCustomizationProvider } from '../../customization';
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

  it('does not render inline email addresses as chips', () => {
    const container = render(<UserMessage content="mail me at a@b.test" />);

    expect(container.querySelector('[title="@b.test"]')).toBeNull();
    expect(container.textContent).toContain('a@b.test');
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
        <UserMessage content="raw <broken /> content" />
      </WebShellCustomizationProvider>,
    );

    expect(container.textContent).toBe('raw <broken /> content');
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
