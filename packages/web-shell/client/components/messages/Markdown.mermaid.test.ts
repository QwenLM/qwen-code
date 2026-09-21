/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(() =>
    Promise.resolve({ svg: '<svg width="300" height="150">diagram</svg>' }),
  ),
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
  mermaidMock.render.mockResolvedValue({
    svg: '<svg width="300" height="150">diagram</svg>',
  });
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

describe('Markdown mermaid zoom', () => {
  async function mountZoomableDiagram() {
    const view = mountMermaid('interactive');
    await startMermaidRender();
    const stage = view.container.querySelector('svg')?.parentElement;
    if (!(stage instanceof HTMLElement)) throw new Error('no diagram mounted');
    const viewport = stage.parentElement;
    if (!(viewport instanceof HTMLElement)) throw new Error('no viewport');
    // No i18n provider here, so `t()` returns the key and that is the title.
    const button = (title: string) => {
      const found = view.container.querySelector<HTMLButtonElement>(
        `button[title="${title}"]`,
      );
      if (!found) throw new Error(`no ${title} button`);
      return found;
    };
    return {
      stage,
      viewport,
      zoomIn: button('mermaid.zoomIn'),
      zoomOut: button('mermaid.zoomOut'),
      zoomReset: button('mermaid.zoomReset'),
    };
  }

  // The scaling itself is a layout effect of the `zoom` property, which jsdom
  // does not model; it is covered by a browser-side probe instead.
  it('offers the reset only while the view is zoomed or panned', async () => {
    const { zoomOut, zoomReset } = await mountZoomableDiagram();

    expect(zoomReset.disabled).toBe(true);

    act(() => zoomOut.click());
    expect(zoomReset.disabled).toBe(false);

    act(() => zoomReset.click());
    expect(zoomReset.disabled).toBe(true);
  });

  it('holds the canvas at the diagram height while zooming', async () => {
    const { stage, viewport, zoomOut, zoomReset } =
      await mountZoomableDiagram();

    // 150 (the rendered svg) + the canvas padding on both sides, and the box the
    // zoom scales is the diagram's own 300.
    expect(viewport.style.height).toBe('182px');
    expect(stage.style.width).toBe('300px');

    act(() => zoomOut.click());
    expect(viewport.style.height).toBe('182px');

    act(() => zoomReset.click());
    expect(viewport.style.height).toBe('182px');
  });

  it('offers the grab cursor only while the diagram reaches past the canvas', async () => {
    const { viewport, zoomIn } = await mountZoomableDiagram();

    // jsdom lays nothing out, so the canvas reports no overflow to begin with.
    expect(viewport.className).not.toContain('mermaidPannable');

    // Give it geometry, then let the zoom re-measure (that is the same path a
    // real zoom takes).
    Object.defineProperty(viewport, 'scrollWidth', {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(viewport, 'clientWidth', {
      value: 100,
      configurable: true,
    });
    act(() => zoomIn.click());
    expect(viewport.className).toContain('mermaidPannable');
  });

  it('pans the viewport instead of moving the diagram box', async () => {
    const { stage, viewport, zoomReset } = await mountZoomableDiagram();

    act(() => {
      viewport.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 500 }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 200 }),
      );
    });
    // Dragging left reveals what is to the right of the fold. jsdom has no
    // layout, so this pins the delta wiring; the browser-side clamp that makes
    // the same drag a no-op on a diagram that already fits is not visible here.
    expect(viewport.scrollLeft).toBe(300);
    expect(zoomReset.disabled).toBe(false);
    // Panning is the viewport's scroll position, not a shifted box.
    expect(stage.style.transform).toBe('');

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    act(() => zoomReset.click());
    expect(viewport.scrollLeft).toBe(0);
  });

  it('takes a percentage-width diagram size from its viewBox', async () => {
    // Outside flowchart mermaid emits `width="100%"` and no height at all, and a
    // `fit-content` box cannot resolve that percentage: it fell back to the
    // 300x150 default object size. The viewBox is what has to size it.
    mermaidMock.render.mockResolvedValueOnce({
      svg: '<svg width="100%" viewBox="0 0 400 200">diagram</svg>',
    });
    const view = mountMermaid('interactive');
    await startMermaidRender();
    const stage = view.container.querySelector('svg')?.parentElement;
    if (!(stage instanceof HTMLElement)) throw new Error('no diagram mounted');
    const viewport = stage.parentElement;
    if (!(viewport instanceof HTMLElement)) throw new Error('no viewport');

    expect(stage.style.width).toBe('400px');
    expect(viewport.style.height).toBe('232px');
  });
});
