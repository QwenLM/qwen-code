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

describe('UserMessage', () => {
  it('renders content', () => {
    const container = render(<UserMessage content="hello world" />);
    expect(container.textContent).toContain('hello world');
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
          renderUserMessageContent: ({ content }) => (
            <span data-testid="tag-chip">{content.slice(1)}</span>
          ),
        }}
      >
        <UserMessage content="@.husky/_/husky.sh xuyao" />
      </WebShellCustomizationProvider>,
    );

    expect(container.querySelector('[data-testid="tag-chip"]')).not.toBeNull();
    expect(container.textContent).toContain('.husky/_/husky.sh xuyao');
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
});
