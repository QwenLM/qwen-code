// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../themeContext';
import PierreFilePreview from './PierreFilePreview';
import { ErrorBoundary } from '../ErrorBoundary';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  render: vi.fn(),
  cleanUp: vi.fn(),
  setThemeType: vi.fn(),
  virtualizerCleanUp: vi.fn(),
}));
vi.mock('@pierre/diffs', () => ({
  getFiletypeFromFileName: () => 'typescript',
  DIFFS_TAG_NAME: 'diffs-container',
  Virtualizer: class {
    setup() {}
    cleanUp = mocks.virtualizerCleanUp;
  },
  VirtualizedFile: class {
    constructor(options: unknown) {
      mocks.create(options);
    }
    render = mocks.render;
    cleanUp = mocks.cleanUp;
    setThemeType = mocks.setThemeType;
  },
}));

it('cleans up a failed renderer initialization before a local retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.cleanUp.mockClear();
  mocks.virtualizerCleanUp.mockClear();
  mocks.render.mockImplementationOnce(() => {
    throw new Error('Renderer failed');
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (attempt: number) => (
    <ErrorBoundary
      resetKeys={[attempt]}
      fallback={<div role="alert">Preview failed</div>}
    >
      <PierreFilePreview path="app.ts" content="const value = 1;" />
    </ErrorBoundary>
  );
  try {
    await act(async () => root.render(render(0)));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.cleanUp).toHaveBeenCalledOnce();
    expect(mocks.virtualizerCleanUp).toHaveBeenCalledOnce();
    await act(async () => root.render(render(1)));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="pierre-file-preview"]')?.childNodes
        .length,
    ).toBe(1);
  } finally {
    await act(async () => root.unmount());
    log.mockRestore();
    mocks.create.mockClear();
    mocks.render.mockClear();
    mocks.cleanUp.mockClear();
    mocks.setThemeType.mockClear();
    vi.unstubAllGlobals();
  }
});

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
    expect(mocks.setThemeType.mock.calls).toEqual([['dark']]);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        themeType: 'light',
        disableErrorHandling: true,
        tokenizeMaxLength: 10_000,
      }),
    );
    expect(host.firstChild).toBe(file);
    expect(host.scrollTop).toBe(123);
    await act(async () => root.unmount());
    expect(mocks.cleanUp).toHaveBeenCalledOnce();
  } finally {
    if (container.hasChildNodes()) act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('recreates changed files with the current shell theme and pins the character fallback', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.create.mockClear();
  mocks.render.mockClear();
  mocks.cleanUp.mockClear();
  const root = createRoot(document.createElement('div'));
  const render = (path: string, content: string) => (
    <ThemeProvider value="dark">
      <PierreFilePreview path={path} content={content} />
    </ThemeProvider>
  );
  try {
    await act(async () => root.render(render('first.ts', 'small')));
    expect(mocks.render).toHaveBeenLastCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ name: 'first.ts', lang: 'typescript' }),
      }),
    );
    await act(async () =>
      root.render(render('second.ts', 'x'.repeat(1024 * 1024 + 1))),
    );
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.cleanUp).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        themeType: 'dark',
        disableErrorHandling: true,
        tokenizeMaxLength: 10_000,
      }),
    );
    expect(mocks.render).toHaveBeenLastCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ name: 'second.ts', lang: 'text' }),
      }),
    );
    await act(async () => root.render(render('second.ts', 'changed')));
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.render).toHaveBeenLastCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({
          name: 'second.ts',
          contents: 'changed',
          lang: 'typescript',
        }),
      }),
    );
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
