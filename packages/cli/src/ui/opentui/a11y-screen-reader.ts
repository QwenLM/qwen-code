/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink screen-reader mode (`ui.accessibility.screenReader`,
 * `Config.getScreenReader()`). When enabled, the original ink TUI:
 *
 *  - renders plain text only (ink's `renderNodeToScreenReaderOutput` squashes
 *    text nodes without styles, borders or backgrounds),
 *  - never enters the virtual viewport / alternate screen
 *    (`shouldUseVirtualViewport(...)` → false, `alternateScreen: useVP`),
 *  - has no mouse support at all (OpenTUI boots with `useMouse: true`, so the
 *    parity here is disabling it),
 *  - writes append-only output (`<Static>` content is written exactly once,
 *    the dynamic block only erases its own previous lines),
 *  - skips the redraw optimizer and synchronized-output wrappers
 *    (`startInteractiveUI` gates both on `!config.getScreenReader()`).
 *
 * Pure logic + the append-only writer; the renderer wiring consumes these.
 */

import wrapAnsi from 'wrap-ansi';
import ansiEscapes from 'ansi-escapes';
import type { CliRendererConfig } from '@opentui/core';
import {
  isInteractiveTerminal,
  shouldUseVirtualViewport,
} from '../utils/terminal-buffer.js';
import { stripAnsi } from './a11y-plain-text.js';

export interface ScreenReaderPolicy {
  /** Whether screen-reader mode is active. */
  enabled: boolean;
  /** Ink parity: squash text nodes, no styles/borders/backgrounds. */
  plainText: boolean;
  /** Ink parity: static output is written once, never repainted. */
  appendOnly: boolean;
  /** Ink parity: `shouldUseVirtualViewport` — always false in SR mode. */
  virtualViewport: boolean;
  /** Ink parity: no mouse when the screen reader is active. */
  mouse: boolean;
  /** Ink parity: `installSynchronizedOutput` is skipped in SR mode. */
  synchronizedOutput: boolean;
  /** Ink parity: `installTerminalRedrawOptimizer` is skipped in SR mode. */
  redrawOptimizer: boolean;
}

export interface ScreenReaderPolicyOptions {
  /** `Config.getScreenReader()` value (CLI flag ?? settings ?? undefined). */
  screenReader: boolean | undefined;
  /** `settings.merged.ui?.useTerminalBuffer` (defaults to true, as ink). */
  useTerminalBuffer?: boolean | undefined;
  /** Defaults to probing the real terminal, like `startInteractiveUI`. */
  isTTY?: boolean | undefined;
  /** Defaults to `process.env`, like `isInteractiveTerminal`. */
  env?: Record<string, string | undefined>;
}

/** Parity of the config resolution: the flag defaults to false. */
export function isScreenReaderEnabled(
  screenReader: boolean | undefined,
): boolean {
  return screenReader ?? false;
}

/**
 * Resolves the full screen-reader policy. Every flag reproduces the original
 * ink startup logic for the same inputs.
 */
export function resolveScreenReaderPolicy(
  options: ScreenReaderPolicyOptions,
): ScreenReaderPolicy {
  const enabled = isScreenReaderEnabled(options.screenReader);
  const interactive = isInteractiveTerminal(
    options.isTTY,
    options.env ?? process.env,
  );
  // Ink gates both installs on process.stdout.isTTY — an omitted isTTY probes
  // the real stdout, never "false".
  const stdoutIsTTY = options.isTTY ?? process.stdout.isTTY;
  return {
    enabled,
    plainText: enabled,
    appendOnly: enabled,
    virtualViewport: shouldUseVirtualViewport(
      options.useTerminalBuffer,
      enabled,
      interactive,
    ),
    mouse: !enabled,
    synchronizedOutput: Boolean(stdoutIsTTY) && !enabled,
    redrawOptimizer: Boolean(stdoutIsTTY) && !enabled,
  };
}

/** The subset of OpenTUI renderer options this policy controls. */
export type ScreenReaderRendererOptions = Pick<
  CliRendererConfig,
  'useMouse' | 'screenMode'
>;

/**
 * Renderer options for `createCliRenderer`. Screen-reader mode keeps the
 * main screen (ink never enters the alternate screen in SR mode); otherwise
 * OpenTUI's own default (`alternate-screen`) is preserved.
 */
export function screenReaderRendererOptions(
  policy: ScreenReaderPolicy,
): ScreenReaderRendererOptions {
  return policy.enabled
    ? { useMouse: false, screenMode: 'main-screen' }
    : { useMouse: true, screenMode: 'alternate-screen' };
}

/** Structural view of the OpenTUI renderer's mutable mouse switch. */
export interface MouseToggleableRenderer {
  useMouse: boolean;
}

/** Live-applies the policy to a running renderer (mouse today). */
export function applyScreenReaderPolicy(
  renderer: MouseToggleableRenderer,
  policy: ScreenReaderPolicy,
): void {
  renderer.useMouse = policy.mouse;
}

// ---------------------------------------------------------------------------
// Append-only writer — parity of ink's isScreenReaderEnabled render loop
// (ink.js): static output is appended once (erasing the pending dynamic
// block first), dynamic output replaces only its own previous lines, and an
// unchanged dynamic block is not rewritten.
// ---------------------------------------------------------------------------

/**
 * Escape sequence that erases `count` lines ending at the cursor — ink
 * parity via the shared ansi-escapes helper (the trailing cursorLeft is
 * required because EL and CUU preserve the cursor column).
 */
export function eraseLines(count: number): string {
  return count <= 0 ? '' : ansiEscapes.eraseLines(count);
}

/**
 * Hard-wraps text at `width` display columns, exactly like ink's
 * screen-reader path (`wrapAnsi(output, width, {trim: false, hard: true })`
 * in ink.js): multi-word blocks break at word boundaries and only words
 * wider than the width are severed; CJK glyphs count as 2 columns. Widths
 * <= 0 disable wrapping.
 */
export function hardWrap(text: string, width: number): string {
  if (width <= 0) return text;
  return wrapAnsi(text, width, { trim: false, hard: true });
}

export class ScreenReaderOutputWriter {
  private lastDynamic = '';
  private lastDynamicHeight = 0;

  constructor(
    private readonly write: (chunk: string) => void,
    private readonly columns: () => number = () => Number.POSITIVE_INFINITY,
  ) {}

  /**
   * Content crossing this writer is plain-text-only on the main screen, and
   * the writer itself enforces that: shell/tool output legitimately carries
   * captured escape bytes, and without stripping here a malicious model/tool
   * result could execute OSC 52 clipboard writes or title/cursor sequences
   * with no renderer buffer in between. Bare C0 controls (except the
   * newline the writer itself appends) are dropped too.
   */
  private sanitize(text: string): string {
    // eslint-disable-next-line no-control-regex
    return stripAnsi(text).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  }

  /**
   * Writes static (append-only) content exactly once. Ink erases the pending
   * dynamic block before appending static content and resets its height.
   */
  appendStatic(text: string): void {
    const clean = this.sanitize(text);
    if (clean.length === 0) return;
    if (this.lastDynamicHeight > 0) {
      this.write(eraseLines(this.lastDynamicHeight));
    }
    this.lastDynamic = '';
    this.lastDynamicHeight = 0;
    this.write(clean.endsWith('\n') ? clean : `${clean}\n`);
  }

  /**
   * Replaces the dynamic block in place (no append). The text is sanitized
   * and hard-wrapped at the writer's column width; an unchanged block is
   * not rewritten.
   */
  updateDynamic(text: string): void {
    const output = hardWrap(this.sanitize(text), this.columns());
    if (output === this.lastDynamic) return;
    this.write(eraseLines(this.lastDynamicHeight) + output);
    this.lastDynamic = output;
    this.lastDynamicHeight = output === '' ? 0 : output.split('\n').length;
  }

  /** Clears the current dynamic block (e.g. on unmount). */
  clearDynamic(): void {
    if (this.lastDynamicHeight > 0) {
      this.write(eraseLines(this.lastDynamicHeight));
    }
    this.lastDynamic = '';
    this.lastDynamicHeight = 0;
  }
}
