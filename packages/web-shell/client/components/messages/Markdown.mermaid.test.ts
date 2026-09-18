/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(() => Promise.resolve({ svg: '<svg>diagram</svg>' })),
}));

vi.mock('mermaid', () => ({ default: mermaidMock }));

const { Markdown } = await import('./Markdown');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function mountMermaid(renderMode: 'interactive' | 'readonly' | 'document') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const render = (mode: 'interactive' | 'readonly' | 'document') =>
    act(() => {
      root.render(
        createElement(
          TranscriptRenderModeProvider,
          { value: mode },
          createElement(Markdown, {
            content: '```mermaid\ngraph TD\nA --> B\n```',
          }),
        ),
      );
    });
  render(renderMode);
  return { container, render };
}

function mountManyMermaids(count: number): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      createElement(
        TranscriptRenderModeProvider,
        { value: 'readonly' },
        ...Array.from({ length: count }, (_, index) =>
          createElement(Markdown, {
            key: index,
            content: `\`\`\`mermaid\ngraph TD\nA${index} --> B${index}\n\`\`\``,
          }),
        ),
      ),
    );
  });
  return container;
}

async function startMermaidRender(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mermaidMock.initialize.mockClear();
  mermaidMock.render.mockReset();
  mermaidMock.render.mockResolvedValue({ svg: '<svg>diagram</svg>' });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe('Markdown Mermaid render modes', () => {
  it('renders a mermaid fence as its own source in document mode', async () => {
    const view = mountMermaid('document');
    await startMermaidRender();

    // Document mode is an exported file: it degrades the fence to a plain <pre>
    // so the export bundle can drop mermaid entirely (#11091).
    expect(mermaidMock.initialize).not.toHaveBeenCalled();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(view.container.querySelector('pre code')?.textContent).toContain(
      'graph TD',
    );
    expect(view.container.querySelector('svg')).toBeNull();
    // Deliberately no interactive arm here: leaving a render in flight would
    // hold the module-level `mermaidRenderQueue` pending past this test and
    // stall every later one. The cases below cover interactive rendering.
  });

  it('applies resource limits outside interactive mode', async () => {
    let resolveFirstRender: ((value: { svg: string }) => void) | undefined;
    mermaidMock.render.mockImplementationOnce(
      () =>
        new Promise<{ svg: string }>((resolve) => {
          resolveFirstRender = resolve;
        }),
    );
    const view = mountMermaid('interactive');
    await startMermaidRender();

    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);
    expect(mermaidMock.initialize.mock.calls[0]?.[0]).not.toHaveProperty(
      'maxTextSize',
    );
    expect(mermaidMock.initialize.mock.calls[0]?.[0]).not.toHaveProperty(
      'maxEdges',
    );

    view.render('readonly');
    await startMermaidRender();
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRender?.({ svg: '<svg>interactive</svg>' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(2);
    expect(mermaidMock.initialize.mock.calls[1]?.[0]).toMatchObject({
      maxTextSize: 50_000,
      maxEdges: 500,
    });

    view.render('interactive');
    await startMermaidRender();
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(3);
    expect(mermaidMock.initialize.mock.calls[2]?.[0]).not.toHaveProperty(
      'maxTextSize',
    );
    expect(mermaidMock.initialize.mock.calls[2]?.[0]).not.toHaveProperty(
      'maxEdges',
    );
  });

  it('times out outside interactive mode', async () => {
    let resolveInteractiveRender:
      | ((value: { svg: string }) => void)
      | undefined;
    mermaidMock.render
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            resolveInteractiveRender = resolve;
          }),
      );
    const view = mountMermaid('readonly');
    await startMermaidRender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(view.container.querySelector('pre code')?.textContent).toContain(
      'graph TD',
    );

    view.render('interactive');
    await startMermaidRender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(view.container.querySelector('pre code')).toBeNull();

    await act(async () => {
      resolveInteractiveRender?.({ svg: '<svg>interactive</svg>' });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('does not charge queue wait time against readonly renders', async () => {
    mermaidMock.render.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ svg: '<svg>diagram</svg>' }), 300);
        }),
    );
    const container = mountManyMermaids(40);
    await startMermaidRender();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });

    expect(mermaidMock.render).toHaveBeenCalledTimes(40);
    expect(container.querySelectorAll('svg')).toHaveLength(40);
    expect(container.querySelector('pre code')).toBeNull();
  });
});
