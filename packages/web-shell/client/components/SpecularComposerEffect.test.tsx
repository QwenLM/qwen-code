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
});
