// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebShellCustomizationProvider } from '../../customization';
import { I18nProvider } from '../../i18n';
import { ThemeProvider } from '../../themeContext';
import { Markdown } from './Markdown';
import {
  ECHARTS_FULLDATA_SANITIZER_KEY_OVERLAP,
  EchartsFullDataBlock,
  createEchartsFullDataRenderer,
  type EchartsFullDataOption,
  type EchartsRuntime,
  type EchartsRuntimeLoader,
} from './EchartsFullDataBlock';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function mount(node: ReactNode): Promise<{
  container: HTMLElement;
  root: Root;
  rerender(next: ReactNode): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted.push({ root, container });
  return {
    container,
    root,
    rerender: async (next: ReactNode) => {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

async function render(node: ReactNode): Promise<HTMLElement> {
  return (await mount(<I18nProvider language="en">{node}</I18nProvider>))
    .container;
}

async function flushChart(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderEchartsMarkdown({
  code,
  fenceLanguage = 'echarts-fulldata',
  loadEcharts,
  language = 'en',
  source = 'assistant',
}: {
  code: string;
  fenceLanguage?: string;
  loadEcharts?: EchartsRuntimeLoader;
  language?: 'en' | 'zh-CN';
  source?: 'assistant' | 'thinking';
}): Promise<HTMLElement> {
  return render(
    <I18nProvider language={language}>
      <ThemeProvider value="dark">
        <WebShellCustomizationProvider
          value={{
            markdown: {
              renderCodeBlock: createEchartsFullDataRenderer({ loadEcharts }),
            },
          }}
        >
          <Markdown
            content={`\`\`\`${fenceLanguage}\n${code}\n\`\`\``}
            source={source}
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

function getDataRows(container: HTMLElement): string[][] {
  return Array.from(container.querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.querySelectorAll('td'))
      .slice(1)
      .map((cell) => cell.textContent?.trim() ?? ''),
  );
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
  it('keeps top-level allowlist keys disjoint from nested denylist keys', () => {
    expect(ECHARTS_FULLDATA_SANITIZER_KEY_OVERLAP).toEqual([]);
  });

  it('does not render echarts blocks from thinking markdown', async () => {
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };
    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: { source: [[1]] },
        series: [{ type: 'bar' }],
      }),
      loadEcharts: () => runtime,
      source: 'thinking',
    });

    expect(runtime.init).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="echarts-fulldata-rendered"]'),
    ).toBeNull();
    expect(container.textContent).toContain('echarts-fulldata');
  });

  it('renders echarts blocks with case-insensitive fence language matching', async () => {
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };
    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: { source: [[1]] },
        series: [{ type: 'bar' }],
      }),
      fenceLanguage: 'ECharts-FullData',
      loadEcharts: () => runtime,
    });
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-testid="echarts-fulldata-rendered"]'),
    ).not.toBeNull();
    expect(container.querySelector('pre code')).toBeNull();
  });

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
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(runtime.init).toHaveBeenCalledWith(expect.any(HTMLElement), 'dark');
    const renderedOption = setOption.mock.calls[0]?.[0] as
      | EchartsFullDataOption
      | undefined;
    expect(renderedOption).toEqual(
      expect.not.objectContaining({ title: expect.anything() }),
    );
    expect(renderedOption).toEqual(
      expect.objectContaining({
        backgroundColor: '#0d0d0d',
        color: expect.arrayContaining(['#8AA0FF', '#60CCC5']),
        grid: expect.objectContaining({ containLabel: true }),
      }),
    );
    expect(renderedOption?.xAxis).toEqual(
      expect.objectContaining({
        axisLabel: expect.objectContaining({ color: '#9aa3b7' }),
      }),
    );
    expect(renderedOption?.series).toEqual([
      expect.objectContaining({
        barMaxWidth: 42,
        itemStyle: expect.objectContaining({ borderRadius: [3, 3, 0, 0] }),
      }),
    ]);
    expect(container.textContent).toContain('Weekly orders');
    expect(container.textContent).not.toContain('echarts-fulldata');
    expect(
      container.querySelector('section[aria-label="Weekly orders"]'),
    ).not.toBeNull();

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['', '']);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Show chart',
      'Show data',
    ]);

    await act(async () => {
      buttons[1]?.click();
    });

    const headerTexts = Array.from(container.querySelectorAll('th')).map(
      (cell) => cell.textContent?.trim() ?? '',
    );
    expect(headerTexts[1]).toContain('day');
    expect(headerTexts[2]).toContain('orders');
    expect(container.textContent).toContain('Quick copy');
    expect(
      container.querySelector('button[aria-label="Sort by orders"]'),
    ).not.toBeNull();
    expect(getDataRows(container)).toEqual([
      ['Mon', '120'],
      ['Tue', '200'],
    ]);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Sort by orders"]')
        ?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Sort by orders, ascending"]',
        )
        ?.click();
    });

    expect(getDataRows(container)).toEqual([
      ['Tue', '200'],
      ['Mon', '120'],
    ]);
  });

  it('normalizes {c} label templates for object-row datasets', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Monthly metrics' },
      dataset: {
        dimensions: ['month', 'convRate', 'aov'],
        source: [
          { month: 'Jan', convRate: 3.1, aov: 186 },
          { month: 'Feb', convRate: 3.4, aov: 192 },
        ],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'line',
          encode: { x: 'month', y: 'convRate' },
          label: { show: true, formatter: '{c}%' },
        },
        {
          type: 'line',
          encode: { x: 'month', y: 'aov' },
          label: { show: true, formatter: '¥{c}' },
        },
      ],
    };
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();

    const renderedOption = setOption.mock.calls[0]?.[0] as {
      series?: Array<{ label?: { formatter?: string } }>;
    };
    expect(renderedOption.series?.[0]?.label?.formatter).toBe('{@convRate}%');
    expect(renderedOption.series?.[1]?.label?.formatter).toBe('¥{@aov}');
  });

  it('renders array-row datasets with named dimensions in the data view', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [
          ['Mon', 120],
          ['Tue', 200],
        ],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
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
    await flushChart();
    await act(async () => {
      container.querySelectorAll('button')[1]?.click();
    });

    expect(getDataRows(container)).toEqual([
      ['Mon', '120'],
      ['Tue', '200'],
    ]);
  });

  it('preserves array-row columns for unnamed object dimensions', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: [{}, { name: 'orders' }],
        source: [['Mon', 120]],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 0, y: 1 } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
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
    await flushChart();
    await act(async () => {
      container.querySelectorAll('button')[1]?.click();
    });

    const headerTexts = Array.from(container.querySelectorAll('th')).map(
      (cell) => cell.textContent?.trim() ?? '',
    );
    expect(headerTexts[1]).toContain('0');
    expect(headerTexts[2]).toContain('orders');
    expect(getDataRows(container)).toEqual([['Mon', '120']]);
  });

  it('keeps the parsed option stable across parent rerenders with unchanged code', async () => {
    const code = JSON.stringify({
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    });
    const dispose = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose,
      })),
    };
    const renderer = createEchartsFullDataRenderer({
      loadEcharts: () => runtime,
    });
    const content = `\`\`\`echarts-fulldata\n${code}\n\`\`\``;
    const tree = (nonce: number) => (
      <div data-nonce={nonce}>
        <ThemeProvider value="dark">
          <WebShellCustomizationProvider
            value={{
              markdown: {
                renderCodeBlock: renderer,
              },
            }}
          >
            <Markdown content={content} source="assistant" />
          </WebShellCustomizationProvider>
        </ThemeProvider>
      </div>
    );

    const { rerender } = await mount(tree(1));
    await flushChart();
    await rerender(tree(2));
    await flushChart();

    expect(runtime.init).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('does not recompute chart options when toggling data view', async () => {
    const plainOption: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    let cloneCount = 0;
    const option = {
      ...plainOption,
      toJSON: () => {
        cloneCount += 1;
        return plainOption;
      },
    } as EchartsFullDataOption & { toJSON: () => EchartsFullDataOption };
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
    await flushChart();

    await act(async () => {
      container.querySelectorAll('button')[1]?.click();
    });
    await act(async () => {
      container.querySelectorAll('button')[0]?.click();
    });
    await flushChart();

    expect(cloneCount).toBe(1);
    expect(runtime.init).toHaveBeenCalledTimes(2);
    expect(setOption).toHaveBeenCalledTimes(2);
  });

  it('does not recreate the chart when the loader prop identity changes', async () => {
    const option: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const dispose = vi.fn();
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose,
      })),
    };
    const tree = (nonce: number) => (
      <I18nProvider language="en">
        <div data-nonce={nonce}>
          <EchartsFullDataBlock
            option={option}
            theme="dark"
            loadEcharts={() => runtime}
          />
        </div>
      </I18nProvider>
    );

    const { rerender } = await mount(tree(1));
    await flushChart();
    await rerender(tree(2));
    await flushChart();

    expect(runtime.init).toHaveBeenCalledOnce();
    expect(setOption).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('restyles the existing chart when the theme changes', async () => {
    const plainOption: EchartsFullDataOption = {
      title: { text: 'Weekly orders' },
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    let cloneCount = 0;
    const option = {
      ...plainOption,
      toJSON: () => {
        cloneCount += 1;
        return plainOption;
      },
    } as EchartsFullDataOption & { toJSON: () => EchartsFullDataOption };
    const dispose = vi.fn();
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose,
      })),
    };
    const tree = (theme: 'dark' | 'light') => (
      <I18nProvider language="en">
        <EchartsFullDataBlock
          option={option}
          theme={theme}
          loadEcharts={() => runtime}
        />
      </I18nProvider>
    );

    const { rerender } = await mount(tree('dark'));
    await flushChart();
    await rerender(tree('light'));
    await flushChart();

    expect(cloneCount).toBe(1);
    expect(runtime.init).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(setOption).toHaveBeenCalledTimes(2);
    expect(setOption.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ backgroundColor: '#0d0d0d' }),
    );
    expect(setOption.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ backgroundColor: '#ffffff' }),
    );
  });

  it('shows loading while the chart runtime loader is pending', async () => {
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };
    let resolveRuntime: (runtime: EchartsRuntime) => void = () => {};
    const runtimePromise = new Promise<EchartsRuntime>((resolve) => {
      resolveRuntime = resolve;
    });

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtimePromise}
      />,
    );

    expect(container.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => {
      resolveRuntime(runtime);
      await runtimePromise;
      await Promise.resolve();
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(runtime.init).toHaveBeenCalledOnce();
  });

  it('observes chart container resize after initialization', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class ResizeObserverStub {
      observe = observe;
      disconnect = disconnect;
    }
    globalThis.ResizeObserver =
      ResizeObserverStub as unknown as typeof ResizeObserver;
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    try {
      await render(
        <EchartsFullDataBlock
          option={option}
          theme="dark"
          loadEcharts={() => runtime}
        />,
      );
      await flushChart();

      expect(observe).toHaveBeenCalledWith(expect.any(HTMLElement));
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('reports synchronous loader failures inside the chart card', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => {
          throw new Error('loader failed');
        }}
      />,
    );
    await flushChart();

    expect(container.textContent).toContain('loader failed');
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell] echarts-fulldata render failed:',
      expect.any(Error),
    );
  });

  it('reports async loader rejections inside the chart card', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => Promise.reject(new Error('async loader failed'))}
      />,
    );
    await flushChart();

    expect(container.textContent).toContain('async loader failed');
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell] echarts-fulldata render failed:',
      expect.any(Error),
    );
  });

  it('disposes a partially initialized chart when setOption fails', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const dispose = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(() => {
          throw new Error('setOption failed');
        }),
        resize: vi.fn(),
        dispose,
      })),
    };
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };

    const container = await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();

    expect(container.textContent).toContain('setOption failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell] echarts-fulldata render failed:',
      expect.any(Error),
    );
  });

  it('recovers from chart errors after option changes', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const dispose = vi.fn();
    const setOption = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('setOption failed');
      })
      .mockImplementation(() => {});
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose,
      })),
    };
    const baseOption: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const nextOption: EchartsFullDataOption = {
      ...baseOption,
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Tue', orders: 200 }],
      },
    };

    const { container, root } = await mount(
      <I18nProvider language="en">
        <EchartsFullDataBlock
          option={baseOption}
          theme="dark"
          loadEcharts={() => runtime}
        />
      </I18nProvider>,
    );
    await flushChart();

    expect(container.textContent).toContain('setOption failed');
    expect(
      container.querySelector('[data-testid="echarts-fulldata-chart"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <EchartsFullDataBlock
            option={nextOption}
            theme="dark"
            loadEcharts={() => runtime}
          />
        </I18nProvider>,
      );
    });
    await flushChart();

    expect(container.textContent).not.toContain('setOption failed');
    expect(runtime.init).toHaveBeenCalledTimes(2);
    expect(setOption).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell] echarts-fulldata render failed:',
      expect.any(Error),
    );
  });

  it('sanitizes unsafe chart option fields before calling ECharts', async () => {
    const option: EchartsFullDataOption = {
      dataset: [
        {
          dimensions: ['day', 'orders'],
          source: [{ day: '<img src=x onerror=alert(1)>', orders: 120 }],
          transform: { type: 'filter' },
        },
        {
          dimensions: ['day', 'orders'],
          source: [{ day: 'Tue', orders: 999 }],
        },
      ] as EchartsFullDataOption['dataset'],
      graphic: { type: 'text', style: { text: '<img src=x>' } },
      legend: {
        data: ['Mon', 'Tue'],
      },
      tooltip: {
        formatter: '<img src=x onerror=alert(1)>',
        extraCssText: 'background-image:url(https://example.test/x.png)',
      },
      xAxis: { type: 'category', data: ['Mon', 'Tue'] },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'line',
          datasetIndex: 1,
          data: [120, 999],
          href: 'javascript:alert(1)',
          id: 'data:text/html,<svg onload=alert(1)>',
          name: '<a'.repeat(32),
          encode: { x: 'day', y: 'orders' },
          itemStyle: {
            image: 'https://example.test/marker.png',
          },
          renderItem: 'javascript:alert(1)',
          src: 'https://example.test/marker.png',
          symbol: 'image://https://example.test/marker.png',
          tooltip: {
            appendToBody: true,
            enterable: true,
            formatter: '<img src=x onerror=alert(1)>',
            renderMode: 'html',
          },
        },
      ],
    };
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };

    await render(
      <EchartsFullDataBlock
        option={option}
        theme="dark"
        loadEcharts={() => runtime}
      />,
    );
    await flushChart();

    const renderedOption = setOption.mock.calls[0]?.[0] as {
      dataset?: {
        source?: Array<Record<string, unknown>>;
        transform?: unknown;
      };
      graphic?: unknown;
      legend?: { data?: unknown };
      tooltip?: {
        formatter?: unknown;
        extraCssText?: string;
        renderMode?: string;
        enterable?: boolean;
      };
      xAxis?: { data?: unknown };
      series?: Array<{
        data?: unknown;
        datasetIndex?: unknown;
        href?: unknown;
        id?: unknown;
        itemStyle?: { image?: unknown };
        name?: string;
        renderItem?: unknown;
        src?: unknown;
        symbol?: string;
        tooltip?: {
          appendToBody?: boolean;
          confine?: boolean;
          enterable?: boolean;
          formatter?: unknown;
          renderMode?: string;
        };
      }>;
    };
    expect(renderedOption.graphic).toBeUndefined();
    expect(renderedOption.dataset?.transform).toBeUndefined();
    expect(renderedOption.dataset?.source?.[0]?.day).toBe('');
    expect(renderedOption.dataset?.source).toHaveLength(1);
    expect(renderedOption.legend?.data).toBeUndefined();
    expect(renderedOption.tooltip?.formatter).toBeUndefined();
    expect(renderedOption.tooltip?.extraCssText).not.toContain('https://');
    expect(renderedOption.tooltip).toEqual(
      expect.objectContaining({
        enterable: false,
        renderMode: 'richText',
      }),
    );
    expect(renderedOption.xAxis?.data).toBeUndefined();
    expect(renderedOption.series?.[0]?.data).toBeUndefined();
    expect(renderedOption.series?.[0]?.datasetIndex).toBeUndefined();
    expect(renderedOption.series?.[0]?.href).toBeUndefined();
    expect(renderedOption.series?.[0]?.id).toBeUndefined();
    expect(renderedOption.series?.[0]?.itemStyle?.image).toBeUndefined();
    expect(renderedOption.series?.[0]?.name).toBeUndefined();
    expect(renderedOption.series?.[0]?.renderItem).toBeUndefined();
    expect(renderedOption.series?.[0]?.src).toBeUndefined();
    expect(renderedOption.series?.[0]?.symbol).toBe('circle');
    expect(renderedOption.series?.[0]?.tooltip?.formatter).toBeUndefined();
    expect(renderedOption.series?.[0]?.tooltip).toEqual(
      expect.objectContaining({
        appendToBody: false,
        confine: true,
        enterable: false,
        renderMode: 'richText',
      }),
    );
  });

  it('ignores malformed title array entries', async () => {
    const option: EchartsFullDataOption = {
      title: [
        null,
        { text: 'Recovered title' },
      ] as unknown as EchartsFullDataOption['title'],
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
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
    await flushChart();

    expect(container.textContent).toContain('Recovered title');
  });

  it('shows an error when the chart runtime is unavailable', async () => {
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };

    const container = await render(
      <EchartsFullDataBlock option={option} theme="dark" />,
    );
    await flushChart();

    expect(container.textContent).toContain('Chart runtime is unavailable.');
    expect(
      container.querySelector('[data-testid="echarts-fulldata-chart"]'),
    ).not.toBeNull();
  });

  it('localizes chart chrome strings', async () => {
    const option: EchartsFullDataOption = {
      dataset: {
        source: [{ day: 'Mon', orders: 120 }],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar' }],
    };
    const { container } = await mount(
      <I18nProvider language="zh-CN">
        <EchartsFullDataBlock option={option} theme="dark" />
      </I18nProvider>,
    );
    await flushChart();

    expect(container.textContent).toContain('图表加载中');
    expect(container.textContent).toContain('图表运行时不可用。');
    expect(
      container.querySelector('button[aria-label="显示图表"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="显示数据"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="视图模式"]')).not.toBeNull();
  });

  it('caps the rendered data table rows', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      day: `Day ${index + 1}`,
      orders: index + 1,
    }));
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: ['day', 'orders'],
        source: rows,
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 'day', y: 'orders' } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
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
    await flushChart();
    await act(async () => {
      container.querySelectorAll('button')[1]?.click();
    });

    expect(container.textContent).toContain('Showing 500 of 501 rows');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(500);
  });

  it('caps the rendered data table columns', async () => {
    const columns = Array.from({ length: 60 }, (_, index) => `Metric ${index}`);
    const option: EchartsFullDataOption = {
      dataset: {
        dimensions: columns,
        source: [columns.map((_, index) => index)],
      },
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', encode: { x: 0, y: 1 } }],
    };
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption: vi.fn(),
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
    await flushChart();
    await act(async () => {
      container.querySelectorAll('button')[1]?.click();
    });

    expect(container.textContent).toContain('Showing 50 of 60 columns');
    expect(container.querySelectorAll('thead th')).toHaveLength(50);
    expect(container.querySelectorAll('tbody td')).toHaveLength(50);
  });

  it('accepts chart data at the row and cell limits', async () => {
    const setOption = vi.fn();
    const runtime: EchartsRuntime = {
      init: vi.fn(() => ({
        setOption,
        resize: vi.fn(),
        dispose: vi.fn(),
      })),
    };
    const columns = Array.from({ length: 40 }, (_, index) => `metric${index}`);
    const rows = Array.from({ length: 1000 }, () => columns.map(() => 1));

    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: {
          dimensions: columns,
          source: rows,
        },
        xAxis: { type: 'category' },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', encode: { x: 0, y: 1 } }],
      }),
      loadEcharts: () => runtime,
    });
    await flushChart();

    expect(container.textContent).not.toContain('too many');
    expect(setOption).toHaveBeenCalledOnce();
  });

  it('rejects chart data over the row limit', async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => [index]);

    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: {
          source: rows,
        },
        series: [{ type: 'bar' }],
      }),
    });

    expect(container.textContent).toContain(
      'Chart data has too many rows. Maximum supported rows: 2000.',
    );
  });

  it('rejects chart data over the cell limit', async () => {
    const columns = Array.from({ length: 40 }, (_, index) => `metric${index}`);
    const rows = Array.from({ length: 1001 }, () => columns.map(() => 1));

    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: {
          dimensions: columns,
          source: rows,
        },
        series: [{ type: 'bar' }],
      }),
    });

    expect(container.textContent).toContain(
      'Chart data has too many cells. Maximum supported cells: 40000.',
    );
  });

  it('rejects chart data over the series limit', async () => {
    const series = Array.from({ length: 101 }, () => ({ type: 'line' }));

    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: {
          source: [[1]],
        },
        series,
      }),
    });

    expect(container.textContent).toContain(
      'Chart data has too many series. Maximum supported series: 100.',
    );
  });

  it('rejects chart data over the nesting depth limit', async () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < 42; index += 1) {
      nested = { child: nested };
    }

    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: {
          source: [[1]],
        },
        series: [{ type: 'bar' }],
        title: nested,
      }),
    });

    expect(container.textContent).toContain('Chart data is too deeply nested.');
  });

  it('rejects chart code over the size limit before parsing', async () => {
    const container = await renderEchartsMarkdown({
      code: 'x'.repeat(500_001),
    });

    expect(container.textContent).toContain(
      'Chart data is too large. Maximum supported size: 500000 characters.',
    );
  });

  it('rejects chart data without dataset source rows', async () => {
    const container = await renderEchartsMarkdown({
      code: JSON.stringify({
        dataset: {
          source: [],
        },
        series: [{ type: 'bar' }],
      }),
    });

    expect(container.textContent).toContain(
      'Chart data must include dataset.source.',
    );
  });

  it('rejects syntactically valid JSON that is not an option object', async () => {
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
            content={'```echarts-fulldata\nnull\n```'}
            source="assistant"
          />
        </WebShellCustomizationProvider>
      </ThemeProvider>,
    );

    expect(container.textContent).toContain(
      'Chart data must be a JSON object.',
    );
    expect(container.querySelector('pre code')).toBeNull();
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
