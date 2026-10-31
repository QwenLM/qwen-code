/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Settings } from './settingsSchema.js';
import { isLspOptedIn } from './lsp-opt-in.js';

const settingsWith = (lspEnabled?: boolean): Settings =>
  ({ tools: { lspEnabled } }) as unknown as Settings;

describe('isLspOptedIn', () => {
  const realEnv = process.env;
  beforeEach(() => {
    process.env = { ...realEnv };
    delete process.env['QWEN_CODE_ENABLE_LSP'];
    delete process.env['QWEN_CODE_DISABLE_LSP'];
  });
  afterEach(() => {
    process.env = realEnv;
  });

  it('is off with no flag, no setting and no env', () => {
    expect(isLspOptedIn(undefined, settingsWith(undefined))).toBe(false);
  });

  it('turns on from --experimental-lsp alone', () => {
    expect(isLspOptedIn(true, settingsWith(undefined))).toBe(true);
  });

  it('turns on from the setting alone, which is the Desktop path', () => {
    expect(isLspOptedIn(undefined, settingsWith(true))).toBe(true);
  });

  it('turns on from QWEN_CODE_ENABLE_LSP=1 alone', () => {
    expect(
      isLspOptedIn(undefined, settingsWith(false), {
        QWEN_CODE_ENABLE_LSP: '1',
      }),
    ).toBe(true);
  });

  it('honors QWEN_CODE_DISABLE_LSP=1 over the flag and the setting', () => {
    const env = { QWEN_CODE_DISABLE_LSP: '1' };
    expect(isLspOptedIn(true, settingsWith(true), env)).toBe(false);
  });

  it('lets disable win when both env keys are set', () => {
    expect(
      isLspOptedIn(undefined, settingsWith(true), {
        QWEN_CODE_ENABLE_LSP: '1',
        QWEN_CODE_DISABLE_LSP: '1',
      }),
    ).toBe(false);
  });

  it('reads process.env when no env is passed', () => {
    process.env['QWEN_CODE_DISABLE_LSP'] = '1';
    expect(isLspOptedIn(true, settingsWith(true))).toBe(false);
  });

  it('treats a non-"1" env value as absent', () => {
    expect(
      isLspOptedIn(undefined, settingsWith(false), {
        QWEN_CODE_ENABLE_LSP: 'true',
      }),
    ).toBe(false);
  });

  it('accepts a missing settings object without throwing', () => {
    expect(isLspOptedIn(undefined, undefined)).toBe(false);
    expect(isLspOptedIn(true, undefined)).toBe(true);
  });

  it('is not turned on by a sibling tools setting', () => {
    const settings = {
      tools: { workflowsEnabled: true },
    } as unknown as Settings;
    expect(isLspOptedIn(undefined, settings)).toBe(false);
  });
});
