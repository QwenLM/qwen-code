/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { RenderInline } from './InlineMarkdownRenderer.js';
import { HYPERLINK_ENV_KEYS } from './osc8.js';

describe('<RenderInline />', () => {
  const savedEnv = { ...process.env };
  const savedIsTTY = process.stdout.isTTY;
  const savedPlatform = process.platform;

  beforeEach(() => {
    process.env = { ...savedEnv };
    // Force unsupported by default so the pre-existing assertions in this
    // file (math, dollar variables, plain-text fast path) don't accidentally
    // pick up OSC 8 bytes from a developer's iTerm2 session.
    for (const key of HYPERLINK_ENV_KEYS) {
      delete process.env[key];
    }
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: savedIsTTY,
    });
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: savedPlatform,
    });
  });

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
    function enableHyperlinks() {
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      });
      process.env['TERM_PROGRAM'] = 'iTerm.app';
      process.env['TERM_PROGRAM_VERSION'] = '3.5.0';
    }

    it('wraps a safe http(s) link and shows only the label (no `(url)` suffix)', () => {
      enableHyperlinks();
      const url = 'https://very.long.example.com/path/to/thing?with=params';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`click [here](${url}) please`} />,
      );

      const out = lastFrame() ?? '';
      // Envelope is present, pointing at the URL.
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      expect(out).toContain('\x1b]8;;\x07');
      // Visible label is rendered…
      expect(out).toContain('here');
      // …and the long URL is NOT repeated as plain text — capable terminals
      // expose the target via hover / copy-link instead.
      expect(out).not.toContain(`(${url})`);
    });

    it('falls back to showing the URL as label when [](url) has empty label', () => {
      enableHyperlinks();
      const url = 'https://example.com/x';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`go [](${url}) home`} />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      // Empty label would render an invisible link, so show the URL itself.
      expect(out).toContain(url);
    });

    it('does not wrap dangerous schemes (javascript:, data:, file:, …)', () => {
      enableHyperlinks();
      for (const url of [
        'javascript:alert',
        'data:text/html',
        'file:///etc/passwd',
        'vbscript:msgbox',
      ]) {
        const { lastFrame } = renderWithProviders(
          <RenderInline text={`click [bad](${url}) end`} />,
        );
        const out = lastFrame() ?? '';
        expect(out, `scheme should not wrap: ${url}`).not.toContain('\x1b]8;;');
        // The URL stays visible so the user can read what they would click.
        // Strip any Ink-inserted soft wraps before checking for the URL.
        expect(out.replace(/\s+/g, ' ')).toContain(url);
      }
    });

    it('falls back to plain "label (url)" rendering on unsupported terminals', () => {
      // Default: hyperlinks disabled (isTTY=false from beforeEach).
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
      enableHyperlinks();
      const url = 'https://example.com/very/long/url';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`go to ${url} now`} />,
      );

      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      expect(out).toContain(url);
      expect(out).toContain('\x1b]8;;\x07');
    });

    it('trims trailing sentence punctuation from the OSC 8 target only', () => {
      enableHyperlinks();
      const url = 'https://example.com/page';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`see ${url}.`} />,
      );

      const out = lastFrame() ?? '';
      // Visible bytes retain the period (no regression).
      expect(out).toContain(`${url}.`);
      // OSC 8 target is the URL without the trailing period.
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      expect(out).not.toContain(`\x1b]8;;${url}.\x07`);
    });

    it('leaves bare URLs unwrapped when unsupported', () => {
      const url = 'https://example.com/plain';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`visit ${url}`} />,
      );

      const out = lastFrame() ?? '';
      expect(out).not.toContain('\x1b]8;;');
      expect(out).toContain(url);
    });

    it('refuses to emit OSC 8 inside tmux without FORCE_HYPERLINK', () => {
      enableHyperlinks();
      process.env['TMUX'] = '/tmp/tmux-1000/default,1,0';
      const url = 'https://example.com/page';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`[ref](${url})`} />,
      );
      const out = lastFrame() ?? '';
      expect(out).not.toContain('\x1b]8;;');
    });

    it('preserves balanced parens inside the link URL (Wikipedia-style)', () => {
      enableHyperlinks();
      const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`see [wiki](${url}) ok`} />,
      );
      const out = lastFrame() ?? '';
      // Envelope target must be the full URL including the inner `)` — even
      // though the URL isn't shown as visible text in wrap mode, it has to
      // be byte-correct in the envelope so clicking resolves.
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      // Visible bytes are just the label.
      expect(out).toContain('wiki');
      expect(out).not.toContain(`(${url})`);
    });

    it('does not wrap a URL that contains whitespace', () => {
      // The link regex accepts `[^()]*` inside the URL group, which includes
      // whitespace. Every terminal rejects/truncates an OSC 8 target with
      // embedded whitespace, so we must NOT wrap — falling through preserves
      // the legacy "broken URL is at least visible" behavior.
      enableHyperlinks();
      const { lastFrame } = renderWithProviders(
        <RenderInline text="see [doc](https://x.com path with space) end" />,
      );
      const out = lastFrame() ?? '';
      expect(out).not.toContain('\x1b]8;;');
      expect(out.replace(/\s+/g, ' ')).toContain('https://x.com path');
    });

    it('does not wrap a URL containing NBSP / Unicode whitespace', () => {
      // `/\s/` in JavaScript matches U+00A0 NBSP and other Unicode spaces,
      // so model output that smuggles them into the URL still falls through
      // to the legacy rendering.
      enableHyperlinks();
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`[a](https://x.com\u00a0b)`} />,
      );
      const out = lastFrame() ?? '';
      expect(out).not.toContain('\x1b]8;;');
    });

    it('trims a trailing `>` from a CommonMark autolink URL target', () => {
      // `<https://x.com>` in the markdown source surfaces as the bare URL
      // `https://x.com>` after the regex matches; the trim function strips
      // the `>` from the OSC 8 target while the visible text keeps it.
      enableHyperlinks();
      const url = 'https://example.com/auto';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`see <${url}> ok`} />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      expect(out).not.toContain(`\x1b]8;;${url}>\x07`);
    });

    it('mid-stream unclosed-link state emits a well-formed envelope, not a half-envelope', () => {
      // Streaming chunks arrive faster than the human eye; MarkdownDisplay
      // re-renders the whole line on each tick. While a chunk is in flight
      // and the closing `)` hasn't arrived, the link branch can't match, so
      // the bare-URL alternative wraps the partial URL. That's acceptable:
      // the next tick produces the full link. What we MUST guarantee is
      // that the envelope is always balanced — never a half-open OSC 8.
      enableHyperlinks();
      const { lastFrame } = renderWithProviders(
        <RenderInline text="partial [foo](https://example.com/page" />,
      );
      const out = lastFrame() ?? '';
      // Same count of opens (`\x1b]8;;…\x07`) and closes (`\x1b]8;;\x07`).
      // eslint-disable-next-line no-control-regex
      const opens = (out.match(/\x1b\]8;;[^\x07]+\x07/g) ?? []).length;
      // eslint-disable-next-line no-control-regex
      const closes = (out.match(/\x1b\]8;;\x07/g) ?? []).length;
      expect(opens).toBe(closes);
    });

    it('chunked stream finalizes to a single full link envelope', () => {
      enableHyperlinks();
      const url = 'https://example.com/page';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`done [foo](${url}) ok`} />,
      );
      const out = lastFrame() ?? '';
      // Final-state assertion: one envelope pointing at the URL, label only
      // in the visible bytes.
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      expect(out).toContain('foo');
      expect(out).not.toContain(`(${url})`);
    });

    it('sanitizes bidi controls in the URL when used as visible text', () => {
      // The OSC 8 target inside `osc8Open` is sanitized, but a model that
      // emits `[](https://example.com/a‮evil)` (empty label) would
      // otherwise render the raw URL — including the RLO — as visible text
      // via the `safeLabel || url` fallback. Same risk for the deceptive
      // `(url)` suffix. Both must render the sanitized URL.
      enableHyperlinks();
      const dirtyUrl = 'https://example.com/a\u202eevil';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`see [](${dirtyUrl})`} />,
      );
      const out = lastFrame() ?? '';
      // The OSC target is sanitized (RLO byte stripped).
      expect(out).toContain('\x1b]8;;https://example.com/aevil\x07');
      // The visible URL fallback also has the RLO stripped.
      expect(out).not.toContain('\u202e');
    });

    it('sanitizes bidi controls in the visible label (anti-spoof)', () => {
      // U+202E (RLO) injected into a label would visually reverse the
      // trailing bytes, letting a "click [safe.com](https://evil.com)"
      // render as a different host than the URL — a spoofing vector that
      // OSC 8's clickable region makes more dangerous than the legacy
      // `label (url)` rendering, because the user no longer sees the
      // URL in plain text.
      enableHyperlinks();
      const url = 'https://example.com/page';
      const spoofLabel = 'safe.com\u202emoc.live';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`click [${spoofLabel}](${url}) end`} />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      // The RLO byte must NOT survive into the rendered visible label.
      expect(out).not.toContain('\u202e');
    });

    it('keeps the `(url)` suffix when the label looks like a mismatched URL', () => {
      // Anti-spoof: if the model emits `[https://google.com](https://evil.com)`
      // the OSC 8 branch must NOT hide the actual target, or the user sees
      // a clickable "google.com" that resolves to evil.com.
      enableHyperlinks();
      const target = 'https://attacker.com/phish';
      const { lastFrame } = renderWithProviders(
        <RenderInline
          text={`click [https://google.com/auth](${target}) end`}
        />,
      );
      const out = lastFrame() ?? '';
      // Envelope is still emitted so the label is clickable.
      expect(out).toContain(`\x1b]8;;${target}\x07`);
      // Visible label remains.
      expect(out).toContain('https://google.com/auth');
      // The real target stays visible right next to the link.
      expect(out).toContain(`(${target})`);
    });

    it('keeps the `(url)` suffix for bare-host labels (e.g. `google.com`)', () => {
      // The most natural click-deception form: the model writes a bare
      // hostname as the label that doesn't match the URL's host.
      enableHyperlinks();
      const target = 'https://attacker.com/phish';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`go to [google.com](${target}) end`} />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${target}\x07`);
      expect(out).toContain('google.com');
      expect(out).toContain(`(${target})`);
    });

    it('elides `(url)` when label==url (no deception risk)', () => {
      // The model echoing a URL as both label and target is fine — the user
      // sees the URL either way, no deception. Keep the existing elision.
      enableHyperlinks();
      const url = 'https://example.com/page';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`see [${url}](${url}) end`} />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain(`\x1b]8;;${url}\x07`);
      // No duplicated `(url)` suffix — the label already shows the URL.
      expect(out).not.toContain(`(${url})`);
    });

    it('non-TTY fallback is byte-identical to the legacy `label (url)` form', () => {
      // Pin the contract from the PR: when the terminal does not advertise
      // OSC 8 support, output must contain no OSC 8 envelope bytes and the
      // visible payload must be the legacy `label (url)` form. A regression
      // that adds a stray escape on the off-path would slip past the
      // `not.toContain('\x1b]8;;')` checks elsewhere if accompanied by
      // other escapes, so anchor a stricter substring assertion here too.
      // (isTTY=false from the suite-wide beforeEach disables hyperlinks.)
      const url = 'https://example.com/page';
      const { lastFrame } = renderWithProviders(
        <RenderInline text={`see [docs](${url})`} />,
      );
      const out = lastFrame() ?? '';
      // No OSC 8 envelope, no related escape introducer.
      expect(out).not.toContain('\x1b]8');
      // Exactly one occurrence of the legacy form, with the URL fully present.
      expect(out).toContain(`docs`);
      expect(out).toContain(`(${url})`);
    });
  });
});
