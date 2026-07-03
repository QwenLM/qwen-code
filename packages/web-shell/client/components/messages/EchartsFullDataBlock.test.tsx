// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebShellCustomizationProvider } from '../../customization';
import { ThemeProvider } from '../../themeContext';
import { Markdown } from './Markdown';
import {
  EchartsFullDataBlock,
  createEchartsFullDataRenderer,
  type EchartsFullDataOption,
  type EchartsRuntime,
} from './EchartsFullDataBlock';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('EchartsFullDataBlock', () => {
  it('renders chart/data icon switching from dataset-backed options', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [
          { day: 'Mon', orders: 120 },
          { day: 'Tue', orders: 200 },
        ],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(setOption).toHaveBeenCalledWith(
      expect.not.objectContaining({ title: expect.anything() }),
    );
    expect(container.textContent).toContain('Weekly orders');
    expect(container.textContent).not.toContain('echarts-fulldata');

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['', '']);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Show chart',
      'Show data',
    ]);

    await act(async () => {
      buttons[1]?.click();
    });

    expect(
      Array.from(container.querySelectorAll('th')).map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(['day', 'orders']);
    expect(
      Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) =>
          cell.textContent?.trim(),
        ),
      ),
    ).toEqual([
      ['Mon', '120'],
      ['Tue', '200'],
    ]);
  });

  it('handles invalid chart JSON without falling back to the visible fence', async () => {
    const container = await render(
      <ThemeProvider value="dark">
        <WebShellCustomizationProvider
          value={{
            markdown: {
              renderCodeBlock: createEchartsFullDataRenderer(),
            },
          }}
        >
          <Markdown
            content={'```echarts-fulldata\n{\n```'}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>,
    );

    expect(
      container.querySelector('[data-testid="echarts-fulldata-rendered"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('echarts-fulldata');
    expect(container.querySelector('pre code')).toBeNull();
  });

  it('shows loading instead of parse errors while chart JSON is streaming', async () => {
    const container = await render(
      <ThemeProvider value="dark">
        <WebShellCustomizationProvider
          value={{
            markdown: {
              renderCodeBlock: createEchartsFullDataRenderer(),
            },
          }}
        >
          <Markdown
            content={'```echarts-fulldata\n{\n  "title"\n```'}
            source="assistant"
            isStreaming
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>,
    );

    expect(
      container.querySelector('[data-testid="echarts-fulldata-rendered"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Expected property');
    expect(container.textContent).not.toContain('echarts-fulldata');
    expect(container.querySelector('pre code')).toBeNull();
  });
});
