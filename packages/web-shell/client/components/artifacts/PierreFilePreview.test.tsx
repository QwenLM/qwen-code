// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../themeContext';
import PierreFilePreview from './PierreFilePreview';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  render: vi.fn(),
  cleanUp: vi.fn(),
  setThemeType: vi.fn(),
}));
vi.mock('@pierre/diffs', () => ({
  DIFFS_TAG_NAME: 'diffs-container',
  Virtualizer: class {
    setup() {}
    cleanUp() {}
  },
  VirtualizedFile: class {
    constructor() {
      mocks.create();
    }
    render = mocks.render;
    cleanUp = mocks.cleanUp;
    setThemeType = mocks.setThemeType;
  },
}));

it('updates the theme without replacing the virtualized file or scroll position', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ThemeProvider value="light">
          <PierreFilePreview path="app.ts" content="const value = 1;" />
        </ThemeProvider>,
      ),
    );
    const host = container.querySelector<HTMLElement>(
      '[data-testid="pierre-file-preview"]',
    )!;
    const file = host.firstChild;
    host.scrollTop = 123;
    await act(async () =>
      root.render(
        <ThemeProvider value="dark">
          <PierreFilePreview path="app.ts" content="const value = 1;" />
        </ThemeProvider>,
      ),
    );
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(mocks.cleanUp).not.toHaveBeenCalled();
    expect(mocks.setThemeType.mock.calls).toEqual([['light'], ['dark']]);
    expect(host.firstChild).toBe(file);
    expect(host.scrollTop).toBe(123);
    await act(async () => root.unmount());
    expect(mocks.cleanUp).toHaveBeenCalledOnce();
  } finally {
    if (container.hasChildNodes()) act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
