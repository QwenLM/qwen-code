// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, WebShellThemeId } from '../themeContext';
import { NewSessionDotField } from './NewSessionDotField';
import { SpecularComposerEffect } from './SpecularComposerEffect';

const mounted: Array<{
  container: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> = [];

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('composer visual effects fallback', () => {
  it('keeps both animation layers inert when canvas contexts are unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    function Harness() {
      const composerRef = useRef<HTMLDivElement>(null);
      return (
        <ThemeProvider value={WebShellThemeId.Light}>
          <div ref={composerRef} data-web-shell-composer-surface>
            <SpecularComposerEffect targetRef={composerRef} />
            <div data-web-shell-composer-editor />
          </div>
          <NewSessionDotField />
        </ThemeProvider>
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    act(() => root.render(<Harness />));

    expect(
      container.querySelector('[data-web-shell-composer-editor]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-web-shell-composer-specular] canvas'),
    ).toBeNull();
    expect(
      container.querySelector('[data-web-shell-new-session-dot-field] canvas'),
    ).not.toBeNull();
  });

  it('erases dots for the pointer glow regardless of the background color', () => {
    vi.useFakeTimers();
    const addColorStop = vi.fn();
    const compositeOperations: string[] = [];
    const contextStub = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop })),
      fill: vi.fn(),
      fillRect: vi.fn(),
      moveTo: vi.fn(),
      setTransform: vi.fn(),
    };
    Object.defineProperty(contextStub, 'globalCompositeOperation', {
      configurable: true,
      get: () => compositeOperations.at(-1) ?? 'source-over',
      set: (value: string) => compositeOperations.push(value),
    });
    const context = contextStub as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context,
    );

    let drawFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      drawFrame = callback;
      return 1;
    });

    const container = document.createElement('div');
    container.style.setProperty('--background', '#ff00ff');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    act(() =>
      root.render(
        <ThemeProvider value={WebShellThemeId.Light}>
          <NewSessionDotField />
        </ThemeProvider>,
      ),
    );

    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
      vi.advanceTimersByTime(20);
      drawFrame?.(0);
    });

    expect(addColorStop).toHaveBeenCalledWith(0, 'rgba(0, 0, 0, 1)');
    expect(addColorStop).toHaveBeenCalledWith(1, 'rgba(0, 0, 0, 0)');
    expect(compositeOperations).toEqual(['destination-out', 'source-over']);
  });

  it('keeps both animation layers inert under prefers-reduced-motion', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as MediaQueryList,
    );
    const contextStub = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fill: vi.fn(),
      fillRect: vi.fn(),
      moveTo: vi.fn(),
      setTransform: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      contextStub as unknown as CanvasRenderingContext2D,
    );
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    function Harness() {
      const composerRef = useRef<HTMLDivElement>(null);
      return (
        <ThemeProvider value={WebShellThemeId.Light}>
          <div ref={composerRef} data-web-shell-composer-surface>
            <SpecularComposerEffect targetRef={composerRef} />
            <div data-web-shell-composer-editor />
          </div>
          <NewSessionDotField />
        </ThemeProvider>
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    requestAnimationFrameSpy.mockClear();
    setIntervalSpy.mockClear();
    act(() => root.render(<Harness />));

    expect(
      container.querySelector('[data-web-shell-composer-specular] canvas'),
    ).toBeNull();
    expect(
      container.querySelector('[data-web-shell-new-session-dot-field] canvas'),
    ).not.toBeNull();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });
});

describe('specular effect idle bail-out', () => {
  it('stops the rAF loop when idle and restarts on pointer proximity', () => {
    const drawArrays = vi.fn();
    const clear = vi.fn();
    const glStub = {
      ARRAY_BUFFER: 0x8892,
      BLEND: 0x0be2,
      COLOR_BUFFER_BIT: 0x4000,
      COMPILE_STATUS: 0x8b81,
      FLOAT: 0x1406,
      FRAGMENT_SHADER: 0x8b30,
      LINK_STATUS: 0x8b82,
      ONE: 1,
      ONE_MINUS_SRC_ALPHA: 0x0303,
      STATIC_DRAW: 0x88e4,
      TRIANGLES: 0x0004,
      VERTEX_SHADER: 0x8b31,
      attachShader: vi.fn(),
      bindBuffer: vi.fn(),
      blendFunc: vi.fn(),
      bufferData: vi.fn(),
      clear,
      compileShader: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      createProgram: vi.fn(() => ({})),
      createShader: vi.fn(() => ({})),
      deleteBuffer: vi.fn(),
      deleteProgram: vi.fn(),
      deleteShader: vi.fn(),
      drawArrays,
      enable: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      getAttribLocation: vi.fn(() => 0),
      getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
      getProgramParameter: vi.fn(() => true),
      getShaderParameter: vi.fn(() => true),
      getUniformLocation: vi.fn(() => ({})),
      linkProgram: vi.fn(),
      shaderSource: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform3f: vi.fn(),
      useProgram: vi.fn(),
      vertexAttribPointer: vi.fn(),
      viewport: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      glStub as unknown as WebGL2RenderingContext,
    );

    const rafCallbacks: FrameRequestCallback[] = [];
    let rafId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback);
      return ++rafId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    function Harness() {
      const composerRef = useRef<HTMLDivElement>(null);
      return (
        <ThemeProvider value={WebShellThemeId.Dark}>
          <div ref={composerRef} data-web-shell-composer-surface>
            <SpecularComposerEffect targetRef={composerRef} />
            <div data-web-shell-composer-editor />
          </div>
        </ThemeProvider>
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    act(() => root.render(<Harness />));

    expect(rafCallbacks.length).toBe(1);

    let now = 0;
    const drainFrames = (count: number, stepMs: number) => {
      for (let i = 0; i < count; i++) {
        const callback = rafCallbacks.shift();
        if (!callback) break;
        now += stepMs;
        callback(now);
      }
    };

    // Run enough idle frames for brightness to decay below 0.002
    drainFrames(120, 16);
    const drawsAfterDecay = drawArrays.mock.calls.length;

    // The loop should have stopped — no new rAF callback queued
    expect(rafCallbacks.length).toBe(0);
    // The last frame cleared but did not draw
    expect(clear.mock.calls.length).toBeGreaterThan(drawsAfterDecay);

    // A nearby pointer move restarts the loop
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
    });
    expect(rafCallbacks.length).toBe(1);

    drainFrames(1, 16);
    expect(drawArrays.mock.calls.length).toBeGreaterThan(drawsAfterDecay);
  });
});

describe('dot field settled skip', () => {
  it('skips canvas draws when all dots are settled and engagement is zero', () => {
    vi.useFakeTimers();
    const contextStub = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fill: vi.fn(),
      fillRect: vi.fn(),
      moveTo: vi.fn(),
      setTransform: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      contextStub as unknown as CanvasRenderingContext2D,
    );

    let drawFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      drawFrame = callback;
      return 1;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    act(() =>
      root.render(
        <ThemeProvider value={WebShellThemeId.Dark}>
          <NewSessionDotField />
        </ThemeProvider>,
      ),
    );

    // Run many idle frames so dots settle and engagement stays 0
    for (let i = 0; i < 200; i++) {
      act(() => {
        vi.advanceTimersByTime(20);
        drawFrame?.(i * 16);
      });
    }

    const arcCallsAfterSettle = contextStub.arc.mock.calls.length;
    const fillCallsAfterSettle = contextStub.fill.mock.calls.length;

    // Run more frames — draws should be skipped
    for (let i = 200; i < 220; i++) {
      act(() => {
        vi.advanceTimersByTime(20);
        drawFrame?.(i * 16);
      });
    }

    expect(contextStub.arc.mock.calls.length).toBe(arcCallsAfterSettle);
    expect(contextStub.fill.mock.calls.length).toBe(fillCallsAfterSettle);
  });
});
