/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { act, useState } from 'react';
import { renderWithProviders, withProviders } from '../../test-utils/render.js';
import { RenderModeProvider } from '../contexts/RenderModeContext.js';
import { themeManager } from '../themes/theme-manager.js';
import { DefaultLight } from '../themes/default-light.js';
import { DefaultDark } from '../themes/default.js';
import * as lowlightLoader from './lowlightLoader.js';
import * as colorizer from './CodeColorizer.js';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { LoadedSettings } from '../../config/settings.js';

const originalTheme = themeManager.getActiveTheme().name;
const settledCode = '```javascript\nconst stable = 1;\n```\n\n';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const renderModes = {
  render: { renderMode: 'render' as const, setRenderMode: () => {} },
  raw: { renderMode: 'raw' as const, setRenderMode: () => {} },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  themeManager.setActiveTheme(originalTheme);
});

function view(
  text: string,
  options: {
    isPending?: boolean;
    width?: number;
    height?: number;
    raw?: boolean;
    mathOffset?: number;
  } = {},
) {
  return (
    <RenderModeProvider
      value={options.raw ? renderModes.raw : renderModes.render}
    >
      <MarkdownDisplay
        text={text}
        isPending={options.isPending ?? true}
        contentWidth={options.width ?? 80}
        availableTerminalHeight={options.height ?? 65_536}
        sourceCopyIndexOffsets={{
          mathBlockCount: options.mathOffset ?? 0,
          codeBlockLanguageCounts: new Map(),
        }}
      />
    </RenderModeProvider>
  );
}

function mountView(text: string, settings?: LoadedSettings) {
  type Options = Parameters<typeof view>[1];
  let update!: (text: string, options?: Options) => void;
  function App() {
    const [state, setState] = useState<{ text: string; options?: Options }>({
      text,
    });
    update = (text, options) => setState({ text, options });
    return view(state.text, state.options);
  }
  const app = renderWithProviders(<App />, { settings });
  return {
    ...app,
    update: (text: string, options?: Options) => {
      act(() => update(text, options));
    },
  };
}

describe('streaming Markdown reuse', () => {
  it('R3-7 invalidates a frozen code prefix after line-number settings change', async () => {
    const empty = () => ({ path: '', settings: {}, originalSettings: {} });
    const user = {
      path: '',
      settings: { ui: { showLineNumbers: true } },
      originalSettings: {},
    };
    const settings = new LoadedSettings(
      empty(),
      empty(),
      user,
      empty(),
      true,
      new Set(),
    );
    const spy = vi.spyOn(colorizer, 'colorizeCode');
    const app = mountView(settledCode + 'tail', settings);
    await tick();
    app.update(settledCode + 'tail grows');
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain('1 const stable = 1;');
    user.settings.ui.showLineNumbers = false;
    settings.recomputeMerged();
    app.update(settledCode + 'tail grows again');
    await tick();
    expect(app.lastFrame()).toContain('const stable = 1;');
    expect(app.lastFrame()).not.toContain('1 const stable = 1;');
    app.unmount();
  });

  it('does not rebuild completed code while the following paragraph grows', async () => {
    const spy = vi.spyOn(colorizer, 'colorizeCode');
    const app = mountView(settledCode + 'tail');
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    for (const tail of [
      'tail grows',
      'tail grows again',
      'tail grows again.',
    ]) {
      app.update(settledCode + tail);
      await tick();
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).toContain('tail grows again.');

    app.update(settledCode + 'tail grows again.', { isPending: false });
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(app.lastFrame()).toContain('const stable = 1;');
  });

  it('highlights only changed code lines and keeps its cache bounded', async () => {
    const lowlight = lowlightLoader.getLowlightInstance()!;
    const spy = vi.spyOn(lowlight, 'highlight');
    const cache: colorizer.CodeHighlightCache = { lines: new Map() };
    const code = (tail: string, language = 'javascript') =>
      colorizer.colorizeCode(
        `const stable = 1;\n${tail}`,
        language,
        undefined,
        80,
        {
          highlightCache: cache,
        },
      );
    const app = renderWithProviders(<>{code('let tail = 1;')}</>);
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    app.rerender(withProviders(<>{code('let tail = 2;')}</>));
    await tick();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(cache.lines.size).toBe(2);
    expect(cache.lines.has('let tail = 1;')).toBe(false);
    expect(app.lastFrame()).toContain('let tail = 2;');

    app.rerender(withProviders(<>{code('let tail = 2;', 'typescript')}</>));
    await tick();
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('retries a transient highlighting failure instead of caching fallback text', async () => {
    const lowlight = lowlightLoader.getLowlightInstance()!;
    const spy = vi.spyOn(lowlight, 'highlight').mockImplementationOnce(() => {
      throw new Error('transient fixture failure');
    });
    const cache: colorizer.CodeHighlightCache = { lines: new Map() };
    const code = () =>
      colorizer.colorizeCode('const stable = 1;', 'javascript', undefined, 80, {
        highlightCache: cache,
      });
    const app = renderWithProviders(<>{code()}</>);
    await tick();
    expect(app.lastFrame()).toContain('const stable = 1;');
    expect(cache.lines.size).toBe(0);
    app.rerender(withProviders(<>{code()}</>));
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(cache.lines.size).toBe(1);
  });

  it('rebuilds a frozen block when the highlighter finishes loading', async () => {
    const lowlight = lowlightLoader.getLowlightInstance()!;
    const getter = vi
      .spyOn(lowlightLoader, 'getLowlightInstance')
      .mockReturnValue(null);
    const spy = vi.spyOn(lowlight, 'highlight');
    const renderSpy = vi.spyOn(colorizer, 'colorizeCode');
    const app = mountView(settledCode + 'tail');
    await tick();
    expect(spy).not.toHaveBeenCalled();
    app.update(settledCode + 'tail while loading');
    await tick();
    expect(renderSpy).toHaveBeenCalledTimes(2);
    getter.mockReturnValue(lowlight);
    app.update(settledCode + 'tail grows');
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['paragraphs', 'First **bold**.\n\nNext paragraph.\n\nTail'],
    ['fences', settledCode + '~~~text\n```\ninside\n~~~\n\nTail'],
    ['math', '$$\nx^2\n$$\n\nParagraph\n\n$$\ny^2\n$$\n\nTail'],
    ['tables', '| A | B |\n|---|---|\n| x | y |\n\nParagraph\n\nTail'],
    ['lists', '- first\n  - nested\n\n- second\n\nTail'],
    ['CRLF', (settledCode + 'Tail').replaceAll('\n', '\r\n')],
  ])('matches fresh rendering throughout %s chunking', async (_, source) => {
    const app = mountView('');
    for (let end = 1; end < source.length; end += 7) {
      const text = source.slice(0, end);
      app.update(text);
      await tick();
      const fresh = renderWithProviders(view(text));
      await tick();
      expect(app.lastFrame()).toBe(fresh.lastFrame());
      fresh.unmount();
    }
    app.update(source, { isPending: false });
    await tick();
    const fresh = renderWithProviders(view(source, { isPending: false }));
    await tick();
    expect(app.lastFrame()).toBe(fresh.lastFrame());
  });

  it('matches fresh output after rewrite, shrink, resize, raw mode and copy offsets', async () => {
    const source = '$$\nx^2\n$$\n\n' + settledCode + 'tail growing';
    const app = mountView(source);
    await tick();
    const changes = [
      { text: source.replace('stable = 1', 'replaced = 2') },
      { text: source.slice(0, -4) },
      { text: source, options: { width: 20, height: 12 } },
      { text: source, options: { raw: true } },
      { text: source, options: { mathOffset: 4 } },
      { text: source, options: { isPending: false } },
    ];
    for (const change of changes) {
      app.update(change.text, change.options);
      await tick();
      const fresh = renderWithProviders(view(change.text, change.options));
      await tick();
      expect(app.lastFrame()).toBe(fresh.lastFrame());
      fresh.unmount();
    }
  });

  it('rebuilds stable content when the active theme changes', async () => {
    const spy = vi.spyOn(colorizer, 'colorizeCode');
    const app = mountView(settledCode + 'tail');
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    themeManager.setActiveTheme(
      themeManager.getActiveTheme() === DefaultLight
        ? DefaultDark.name
        : DefaultLight.name,
    );
    app.update(settledCode + 'tail grows');
    await tick();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
