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

    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    requestAnimationFrameSpy.mockClear();
    setIntervalSpy.mockClear();
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
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });

  it('erases dots for the pointer glow regardless of the background color', () => {
    vi.useFakeTimers();
    const addColorStop = vi.fn();
    const compositeOperations: string[] = [];
    const globalAlphas: number[] = [];
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
    Object.defineProperty(contextStub, 'globalAlpha', {
      configurable: true,
      get: () => globalAlphas.at(-1) ?? 1,
      set: (value: number) => globalAlphas.push(value),
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

    // Move the pointer across two speed samples so the field measures a real
    // non-zero speed instead of relying on the unset previous-position seed.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 300, clientY: 300 }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(20);
      drawFrame?.(0);
    });

    expect(addColorStop).toHaveBeenCalledWith(0, 'rgba(0, 0, 0, 1)');
    expect(addColorStop).toHaveBeenCalledWith(1, 'rgba(0, 0, 0, 0)');
    expect(compositeOperations).toEqual(['destination-out', 'source-over']);
    expect(globalAlphas).toHaveLength(2);
    expect(globalAlphas[0]).toBeLessThan(1);
    expect(globalAlphas[1]).toBe(1);
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

  it('cancels the dot field interval and animation frame on unmount', () => {
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
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => {});
    const clearIntervalSpy = vi
      .spyOn(window, 'clearInterval')
      .mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ThemeProvider value={WebShellThemeId.Dark}>
          <NewSessionDotField />
        </ThemeProvider>,
      ),
    );

    act(() => root.unmount());
    container.remove();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(cancelAnimationFrameSpy).toHaveBeenCalled();
  });
});

describe('specular effect idle bail-out', () => {
  it('stops the rAF loop only after brightness decays below the threshold', () => {
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

    // Start at the real clock so the first delta is positive; the effect
    // seeds lastFrame from performance.now() and a synthetic clock starting
    // at zero would produce negative deltas that break the exponential decay.
    let now = performance.now();
    const drainFrames = (count: number, stepMs: number) => {
      for (let i = 0; i < count; i++) {
        const callback = rafCallbacks.shift();
        if (!callback) break;
        now += stepMs;
        callback(now);
      }
    };

    // Move the pointer close so proximity (and therefore brightness) rises,
    // then drain frames while the highlight is visibly above the threshold.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
    });
    drainFrames(30, 16);
    const drawsWhileBright = drawArrays.mock.calls.length;
    expect(drawsWhileBright).toBeGreaterThan(0);

    // Move the pointer far away so proximity drops to zero and brightness
    // decays exponentially until the bail-out threshold is crossed.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 300, clientY: 300 }),
      );
    });
    drainFrames(120, 16);

    // The loop kept drawing through the decay, then stopped — no new rAF
    // callback queued, and the final frame cleared without drawing.
    expect(drawArrays.mock.calls.length).toBeGreaterThan(drawsWhileBright);
    expect(rafCallbacks.length).toBe(0);
    expect(clear.mock.calls.length).toBeGreaterThan(
      drawArrays.mock.calls.length,
    );

    // A nearby pointer move restarts the loop.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
    });
    expect(rafCallbacks.length).toBe(1);
  });
});

describe('specular effect pointer leave', () => {
  it('resets proximity so the idle bail-out fires after the pointer leaves', () => {
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

    let now = performance.now();
    const drainFrames = (count: number, stepMs: number) => {
      for (let i = 0; i < count; i++) {
        const callback = rafCallbacks.shift();
        if (!callback) break;
        now += stepMs;
        callback(now);
      }
    };

    // Move the pointer close so proximity rises and the loop is drawing.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
    });
    drainFrames(10, 16);
    expect(drawArrays.mock.calls.length).toBeGreaterThan(0);

    // Pointer leaves the document — proximity resets to zero.
    act(() => {
      document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));
    });

    // Brightness decays and the idle bail-out stops the loop.
    drainFrames(120, 16);
    expect(rafCallbacks.length).toBe(0);
  });
});

describe('specular effect WebGL cleanup', () => {
  it('releases WebGL resources on unmount', () => {
    const loseContext = vi.fn();
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
      clear: vi.fn(),
      compileShader: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      createProgram: vi.fn(() => ({})),
      createShader: vi.fn(() => ({})),
      deleteBuffer: vi.fn(),
      deleteProgram: vi.fn(),
      deleteShader: vi.fn(),
      drawArrays: vi.fn(),
      enable: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      getAttribLocation: vi.fn(() => 0),
      getExtension: vi.fn(() => ({ loseContext })),
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
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
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
    act(() => root.render(<Harness />));

    expect(
      container.querySelector('[data-web-shell-composer-specular] canvas'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();

    expect(glStub.deleteBuffer).toHaveBeenCalled();
    expect(glStub.deleteProgram).toHaveBeenCalled();
    expect(glStub.deleteShader).toHaveBeenCalled();
    expect(loseContext).toHaveBeenCalled();
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

describe('dot field pointer speed baseline', () => {
  it('does not report a phantom speed burst on the first pointer move', () => {
    vi.useFakeTimers();
    const addColorStop = vi.fn();
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

    // A lone first pointer move must seed the previous position so the speed
    // sample stays zero and no glow burst is drawn.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
      vi.advanceTimersByTime(20);
      drawFrame?.(0);
    });

    expect(addColorStop).not.toHaveBeenCalled();
  });
});

describe('dot field static grid and idle loop', () => {
  const mockDotsRect = () =>
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 30,
      height: 30,
      top: 0,
      left: 0,
      right: 30,
      bottom: 30,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

  const makeContextStub = () => ({
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fill: vi.fn(),
    fillRect: vi.fn(),
    moveTo: vi.fn(),
    setTransform: vi.fn(),
  });

  it('renders the static dot grid once under prefers-reduced-motion', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as MediaQueryList,
    );
    mockDotsRect();
    const contextStub = makeContextStub();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      contextStub as unknown as CanvasRenderingContext2D,
    );
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });
    rafSpy.mockClear();
    act(() =>
      root.render(
        <ThemeProvider value={WebShellThemeId.Dark}>
          <NewSessionDotField />
        </ThemeProvider>,
      ),
    );

    // A 30px box at a 15px step yields a 2×2 grid that must be painted even
    // though every dot is already settled on its anchor.
    expect(contextStub.arc.mock.calls.length).toBeGreaterThan(0);
    expect(contextStub.fill).toHaveBeenCalled();
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('paints the grid on the first frame before any pointer movement', () => {
    vi.useFakeTimers();
    mockDotsRect();
    const contextStub = makeContextStub();
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

    act(() => {
      drawFrame?.(0);
    });

    expect(contextStub.arc.mock.calls.length).toBeGreaterThan(0);
    expect(contextStub.fill).toHaveBeenCalled();
  });

  it('stops the rAF loop when idle and restarts on pointer movement', () => {
    vi.useFakeTimers();
    mockDotsRect();
    const contextStub = makeContextStub();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      contextStub as unknown as CanvasRenderingContext2D,
    );

    const rafCallbacks: FrameRequestCallback[] = [];
    let rafId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback);
      return ++rafId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

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

    expect(rafCallbacks.length).toBe(1);

    // First frame paints the grid and re-arms the loop.
    act(() => {
      rafCallbacks.shift()?.(0);
    });
    // The next idle frame settles and stops the loop without re-arming it.
    act(() => {
      vi.advanceTimersByTime(20);
      rafCallbacks.shift()?.(16);
    });
    expect(rafCallbacks.length).toBe(0);

    // Pointer movement wakes the loop again.
    act(() => {
      window.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 100, clientY: 100 }),
      );
    });
    expect(rafCallbacks.length).toBe(1);
  });
});
