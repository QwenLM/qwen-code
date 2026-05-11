/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { RenderInline } from './InlineMarkdownRenderer.js';
import { resetSupportsHyperlinksCache } from './osc8.js';

describe('<RenderInline />', () => {
  it('leaves shell-style dollar variables untouched by default', () => {
    const { lastFrame } = renderWithProviders(
      <RenderInline text="echo $HOME && echo $PATH" />,
    );

    expect(lastFrame()).toContain('echo $HOME && echo $PATH');
  });

  it('renders inline math only when explicitly enabled', () => {
    const { lastFrame } = renderWithProviders(
      <RenderInline text="value $\\alpha$" enableInlineMath />,
    );

    expect(lastFrame()).toContain('α');
    expect(lastFrame()).not.toContain('$\\alpha$');
  });

  it('does not parse ordinary dollar amounts as inline math', () => {
    const { lastFrame } = renderWithProviders(
      <RenderInline text="cost is $5 and $10 later" enableInlineMath />,
    );

    expect(lastFrame()).toContain('cost is $5 and $10 later');
  });

  describe('markdown link OSC 8 wrapping', () => {
    const savedEnv = { ...process.env };
    const savedIsTTY = process.stdout.isTTY;

    beforeEach(() => {
      resetSupportsHyperlinksCache();
    });

    afterEach(() => {
      process.env = { ...savedEnv };
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: savedIsTTY,
      });
      resetSupportsHyperlinksCache();
    });

    function setEnvForHyperlinkSupport(supported: boolean) {
      for (const key of [
        'NO_COLOR',
        'FORCE_COLOR',
        'CI',
        'TMUX',
        'STY',
        'TERM_PROGRAM',
        'WT_SESSION',
        'KITTY_WINDOW_ID',
        'VTE_VERSION',
        'DOMTERM',
        'JEDITERM_SOURCE_ARGS',
        'TERMINAL_EMULATOR',
        'COLORTERM',
        'TERM',
        'FORCE_HYPERLINK',
        'QWEN_DISABLE_HYPERLINKS',
      ]) {
        delete process.env[key];
      }
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: supported,
      });
      if (supported) {
        process.env['TERM_PROGRAM'] = 'iTerm.app';
      } else {
        process.env['NO_COLOR'] = '1';
      }
    }

    it('emits an OSC 8 envelope around the label when supported', () => {
      setEnvForHyperlinkSupport(true);
      const url = 'https://very.long.example.com/path/to/thing?with=params';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`click [here](${url}) please`} />,
      );

      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      expect(out).toContain('here');
      expect(out).toContain('\x1b]8;;\x07');
      // The legacy `(url)` suffix should not be shown when the terminal
      // supports OSC 8 — the clickable label is the visible affordance.
      expect(out).not.toContain(`(${url})`);
    });

    it('falls back to legacy "label (url)" rendering when unsupported', () => {
      setEnvForHyperlinkSupport(false);
      const url = 'https://example.com/page';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`see [docs](${url})`} />,
      );

      const out = lastFrame() ?? '';
      expect(out).not.toContain('\x1b]8;;');
      expect(out).toContain('docs');
      expect(out).toContain(`(${url})`);
    });

    it('wraps bare URLs in an OSC 8 envelope when supported', () => {
      setEnvForHyperlinkSupport(true);
      const url = 'https://example.com/very/long/url';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`go to ${url} now`} />,
      );

      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      expect(out).toContain(url);
      expect(out).toContain('\x1b]8;;\x07');
    });

    it('leaves bare URLs unwrapped when unsupported', () => {
      setEnvForHyperlinkSupport(false);
      const url = 'https://example.com/plain';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`visit ${url}`} />,
      );

      const out = lastFrame() ?? '';
      expect(out).not.toContain('\x1b]8;;');
      expect(out).toContain(url);
    });
  });
});
