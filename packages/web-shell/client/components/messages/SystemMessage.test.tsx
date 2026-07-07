// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { SystemMessage } from './SystemMessage';

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

describe('SystemMessage — prompt_cancelled marker', () => {
  it('renders the user-cancelled marker as a status region', () => {
    const container = render(
      <SystemMessage content="" variant="info" source="prompt_cancelled" />,
    );
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe('You cancelled this request');
  });

  it('ignores message content when rendering the cancelled marker', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text that must not leak"
        variant="info"
        source="prompt_cancelled"
      />,
    );
    expect(container.textContent).toBe('You cancelled this request');
    expect(container.textContent).not.toContain('raw daemon text');
  });

  it('renders a normal message without the status marker for other sources', () => {
    const container = render(
      <SystemMessage content="a plain note" variant="error" />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('a plain note');
  });
});
