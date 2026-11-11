/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';
import stripAnsi from 'strip-ansi';
import type { ActiveHook } from '../types.js';

/** Collapses a hook's custom status message onto a single line. */
function normalizeStatusMessage(message: string | undefined): string {
  if (!message) return '';
  // Cc covers CR/LF/TAB and other C0/C1 controls; Zl/Zp are the Unicode
  // line and paragraph separators.
  return stripAnsi(message)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
}

/**
 * Status-row text for the displayed hook batch. Uses the first unfinished
 * hook's custom statusMessage when it has one, otherwise names the event.
 * Batches of more than one hook add completed/total progress.
 */
export function getHookStatusText(
  activeHooks: readonly ActiveHook[],
  get: I18nService['get'],
  elapsedSeconds?: number,
): string | undefined {
  const first = activeHooks[0];
  if (!first) return undefined;

  const total = first.total;
  const settled = activeHooks.filter((hook) => hook.settled).length;
  const many = total > 1;
  const message = normalizeStatusMessage(
    activeHooks.find((hook) => !hook.settled)?.statusMessage,
  );

  const text = get(
    message
      ? many
        ? 'status.hook.message.many'
        : 'status.hook.message.one'
      : many
        ? 'status.hook.running.many'
        : 'status.hook.running.one',
    { message, event: first.eventName, settled, total },
  );
  if (elapsedSeconds === undefined) return text;
  return get('status.hook.elapsed', {
    text,
    seconds: elapsedSeconds,
  });
}
