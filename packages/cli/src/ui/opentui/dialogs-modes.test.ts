/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the OpenTUI output-style picker to the CONFIGURED style, the way ink's
 * DialogManager pre-selects it (`config.getOutputStyle()?.name`). Resolving
 * through the session instead (`resolveMainSessionOutputStyle`) returns
 * undefined whenever `--system-prompt` or QWEN_SYSTEM_MD replaces the base
 * prompt, which would park the cursor on `default` for a user who still has a
 * style configured — and Enter on that row clears it.
 */

import { describe, it, expect, vi } from 'vitest';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { BUILT_IN_OUTPUT_STYLES } from '@qwen-code/qwen-code-core';
import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import {
  buildOutputStyleItems,
  formatOutputStyleError,
  outputStyleInitialIndex,
} from './dialogs-modes.js';

const CONCISE = BUILT_IN_OUTPUT_STYLES.find((s) => s.name === 'Concise');

/**
 * A config with a style configured; `systemPrompt` set is the
 * `--system-prompt` / QWEN_SYSTEM_MD session whose effective style is
 * suppressed.
 */
const configWith = (
  style: OutputStyleDefinition | undefined,
  systemPrompt?: string,
): Config =>
  ({
    getOutputStyle: () => style,
    getSystemPrompt: () => systemPrompt,
    getExperimentalZedIntegration: () => false,
    isInteractive: () => true,
  }) as unknown as Config;

describe('buildOutputStyleItems (ink OutputStyleDialog parity)', () => {
  it('lists default first, then every built-in style in order', () => {
    const items = buildOutputStyleItems();
    expect(items[0]).toMatchObject({ key: 'default', style: undefined });
    expect(items.slice(1).map((item) => item.key)).toEqual(
      BUILT_IN_OUTPUT_STYLES.map((style) => style.name),
    );
    // The default row applies "no style"; every other row carries its style.
    expect(items.slice(1).every((item) => item.style !== undefined)).toBe(true);
  });
});

describe('outputStyleInitialIndex', () => {
  const items = buildOutputStyleItems();

  it('pre-selects the configured style', () => {
    expect(outputStyleInitialIndex(items, configWith(CONCISE))).toBe(
      items.findIndex((item) => item.key === 'Concise'),
    );
  });

  it('falls back to default when no style is configured', () => {
    expect(outputStyleInitialIndex(items, configWith(undefined))).toBe(0);
  });

  it('still pre-selects it when the system prompt is replaced', () => {
    // The regression: resolveMainSessionOutputStyle returns undefined here, so
    // the cursor would sit on `default` and Enter would clear the user's style.
    const index = outputStyleInitialIndex(
      items,
      configWith(CONCISE, 'REPLACED SYSTEM PROMPT'),
    );
    expect(index).toBe(items.findIndex((item) => item.key === 'Concise'));
    expect(items[index]?.key).not.toBe('default');
  });
});

describe('formatOutputStyleError (ink failure-message parity)', () => {
  it('names the setting that failed, keeping the underlying message', () => {
    expect(formatOutputStyleError(new Error('EACCES: permission denied'))).toBe(
      'Failed to set "general.outputStyle": EACCES: permission denied',
    );
  });

  it('handles a non-Error rejection', () => {
    expect(formatOutputStyleError('settings file is read-only')).toBe(
      'Failed to set "general.outputStyle": settings file is read-only',
    );
  });
});
