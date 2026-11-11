/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyLoadedSettings,
  makeFakeConfig,
  createIsolatedPermissionSession,
  checkWithOverride,
} from './config.js';

describe('Config settings ownership', () => {
  it('keeps empty settings isolated between default test configs', () => {
    const first = makeFakeConfig().getLoadedSettings();
    const second = makeFakeConfig().getLoadedSettings();
    const flag = { model: { name: 'session-model' } };
    first.setFlagSettings({ path: '', settings: flag, originalSettings: flag });

    expect(first).not.toBe(second);
    expect(first.merged.model.name).toBe('session-model');
    expect(second.flag.settings).toEqual({});
    expect(second.merged).toEqual({});
    expect(first.user.readOnly).toBe(true);
    expect(first.user.path).toBe('');
  });

  it('retains the caller-provided instance', () => {
    const loadedSettings = createEmptyLoadedSettings();
    expect(makeFakeConfig({ loadedSettings }).getLoadedSettings()).toBe(
      loadedSettings,
    );
  });
});

describe('temporary approval handler in test fixtures', () => {
  it('restores the original handler before another check starts', async () => {
    const original = vi.fn(async () => ({ kind: 'approved' as const }));
    const permission = createIsolatedPermissionSession({
      permissionMode: 'default',
      rules: { allow: {}, deny: {}, ask: {} },
      cwd: '/repo',
      additionalDirectories: [],
      askHandler: original,
      toolCheckerMap: new Map([
        [
          'Question',
          {
            check: () => ({
              kind: 'ask',
              reason: {
                message: 'Answer',
                attribution: { type: 'interaction', reason: 'Answer required' },
              },
            }),
          },
        ],
      ]),
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const temporary = vi.fn(async () => {
      await pending;
      return { kind: 'rejected' as const };
    });
    const request = { toolName: 'Question', input: {}, toolUseId: 'first' };
    try {
      const first = checkWithOverride(permission, request, {
        askHandler: temporary,
      });
      expect(
        (await permission.check({ ...request, toolUseId: 'second' })).kind,
      ).toBe('allow');
      release();
      expect((await first).kind).toBe('deny');
      expect(original).toHaveBeenCalledOnce();
      expect(temporary).toHaveBeenCalledOnce();
    } finally {
      release();
      await permission.dispose();
    }
  });
});
