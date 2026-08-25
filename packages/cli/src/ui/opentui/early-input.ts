/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Early-input injection for the OpenTUI entry (ink parity).
 *
 * `gemini.tsx` starts `startEarlyInputCapture()` during startup so keystrokes
 * typed while the CLI boots are not lost. The ink branch drains the buffer
 * with `stopAndGetCapturedInput()` and feeds it to the keypress provider as
 * `initialCapturedInput` (`startInteractiveUI.tsx:172-176`). The OpenTUI
 * branch never drained it, so captured input sat in the buffer forever and
 * was never injected. This module drains the buffer and hands the text to
 * the composer.
 */

import { stopAndGetCapturedInput } from '../../utils/earlyInputCapture.js';

/**
 * Decodes a captured startup-input buffer into composer text. The capture
 * filter already drops terminal response sequences; what remains is user
 * input. Control bytes that are not meaningful as composer text (e.g. raw
 * `\r`, `\x03`, arrow-key escapes) are stripped — the goal is to recover
 * typed characters, not to replay editing keys. Newlines (`\n`) are kept.
 */
export function decodeCapturedInput(buffer: Buffer): string {
  if (buffer.length === 0) return '';
  const text = buffer.toString('utf8');
  // Keep printable characters, spaces and newlines; drop other control
  // characters (and the ESC sequences they may lead) so stray Ctrl+C /
  // carriage-return / escape bytes don't corrupt the composer.
  /* eslint-disable no-control-regex -- stripping C0 control bytes is the point. */
  return (
    text
      .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '') // CSI sequences (arrows, etc.)
      // SS3 function-key sequences (F1-F4 etc., ESC O + final) survive the
      // capture filter as user input (classifyEscapeSequence preserves them);
      // strip the whole sequence here or the C0 pass below removes the bare
      // ESC and leaks the O+letter payload into the composer.
      .replace(/\u001BO[A-Za-z]/g, '')
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
  );
  /* eslint-enable no-control-regex */
}

/**
 * Drains the early-capture buffer exactly once and decodes it to text.
 * Returns an empty string when nothing was captured.
 */
export function drainCapturedInputAsText(): string {
  return decodeCapturedInput(stopAndGetCapturedInput());
}

/**
 * Injects captured startup input into a composer handle once it is attached.
 * The composer may not exist on the very first effect tick (the input prompt
 * attaches its handle in an effect), so this polls briefly until the handle
 * is present or the attempt budget is exhausted. Returns a disposer.
 */
export function injectCapturedInput(
  getText: () => { setText: (t: string) => void } | null,
  text: string,
  opts: {
    intervalMs?: number;
    maxAttempts?: number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
  } = {},
): () => void {
  if (text.length === 0) return () => {};
  const intervalMs = opts.intervalMs ?? 25;
  const maxAttempts = opts.maxAttempts ?? 40;
  const setTimeoutFn =
    opts.setTimeoutFn ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimeoutFn =
    opts.clearTimeoutFn ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let attempts = 0;
  let timer: unknown = null;
  let disposed = false;

  const attempt = () => {
    if (disposed) return;
    const handle = getText();
    if (handle) {
      handle.setText(text);
      return;
    }
    attempts += 1;
    if (attempts >= maxAttempts) return;
    timer = setTimeoutFn(attempt, intervalMs);
  };

  // Run the first attempt asynchronously so the composer's own mount effect
  // (which attaches the handle) gets a chance to run first.
  timer = setTimeoutFn(attempt, intervalMs);

  return () => {
    disposed = true;
    if (timer !== null) clearTimeoutFn(timer);
  };
}
