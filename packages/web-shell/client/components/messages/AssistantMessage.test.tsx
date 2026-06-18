// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CompactModeContext } from '../../App';
import { WebShellCustomizationProvider } from '../../customization';
import { I18nProvider } from '../../i18n';
import { AssistantMessage } from './AssistantMessage';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    disconnect: vi.fn(),
  }));
});

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
    root.render(
      <I18nProvider language="en">
        <CompactModeContext.Provider value={false}>
          <WebShellCustomizationProvider value={{ compactThinking: true }}>
            {node}
          </WebShellCustomizationProvider>
        </CompactModeContext.Provider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('AssistantMessage compact thinking', () => {
  it('renders collapsed thinking as markdown', () => {
    const container = render(
      <AssistantMessage content="" thinking="Inspect **workspace** first." />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('workspace');
    expect(container.textContent).toContain('Inspect workspace first.');
  });
});
