// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
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

  it('renders file references as chips by default', () => {
    const container = render(<UserMessage content="list @.qwen/ files" />);
    const chip = container.querySelector('[title="@.qwen/"]');

    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('.qwen/');
    expect(container.textContent).toContain('list .qwen/ files');
  });

  it('renders extension and MCP references as chips by default', () => {
    const container = render(
      <UserMessage content="@ext:browser and @mcp:docs" />,
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
});
