/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '@qwen-code/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('judgment settings loading', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'qwen-judgment-settings-'));
    await mkdir(path.join(root, 'user'));
    await mkdir(path.join(root, 'workspace'));
    vi.stubEnv(ENV_CONFIG_DIR, path.join(root, 'user'));

    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.resetModules();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });
  it('loads the native settings and expands the key without rewriting the source', async () => {
    const source = {
      judgment: {
        backend: 'typesafe',
        model: 'jev-latest',
        baseUrl: 'https://api.typesafe.ai',
        apiKey: '${TYPESAFE_API_KEY}',
      },
    };
    const file = path.join(root, 'user', 'settings.json');
    await writeFile(file, JSON.stringify(source));
    const { loadSettings } = await import('../test-utils/resolveSettings.js');
    const loaded = loadSettings(path.join(root, 'workspace'));
    expect(loaded.merged.judgment).toEqual({
      ...source.judgment,
      apiKey: 'test-key',
    });
    expect(loaded.user.originalSettings.judgment).toEqual(source.judgment);
  });
  it('does not create a default judgment configuration', async () => {
    const { loadSettings } = await import('../test-utils/resolveSettings.js');
    expect(
      loadSettings(path.join(root, 'workspace')).merged.judgment,
    ).toBeUndefined();
  });
  it('accepts explicit classifier selections and rejects unknown selectors', async () => {
    const { validateSettings } = await import('./settings-validation.js');
    expect(validateSettings({ autoMode: { classifier: 'jev' } }).success).toBe(
      true,
    );
    expect(validateSettings({ autoMode: { classifier: 'llm' } }).success).toBe(
      true,
    );
    expect(
      validateSettings({ autoMode: { classifier: 'unknown' } }).success,
    ).toBe(false);
  });
  it.each(['local', 'online', 'invalid'])(
    'rejects unsupported backend %s',
    async (backend) => {
      const { validateSettings } = await import('./settings-validation.js');
      expect(
        validateSettings({ judgment: { backend, model: 'model' } }).success,
      ).toBe(false);
    },
  );
  it('requires all TypeSafe connection fields', async () => {
    const { validateSettings } = await import('./settings-validation.js');
    expect(
      validateSettings({
        judgment: { backend: 'typesafe', model: 'jev-latest' },
      }).success,
    ).toBe(false);
  });
  it('loads Bailian without API credentials and validates backend choices', async () => {
    await writeFile(
      path.join(root, 'user', 'settings.json'),
      JSON.stringify({
        judgment: { backend: 'bailian' },
      }),
    );
    const { loadSettings } = await import('../test-utils/resolveSettings.js');
    expect(loadSettings(path.join(root, 'workspace')).merged.judgment).toEqual({
      backend: 'bailian',
    });
    const { validateSettings } = await import('./settings-validation.js');
    expect(validateSettings({ judgment: { backend: 'bailian' } }).success).toBe(
      true,
    );
    expect(
      validateSettings({
        judgment: { backend: 'bailian', model: 'custom-jev' },
      }).success,
    ).toBe(true);
    for (const extra of [
      { apiKey: 'secret' },
      { baseUrl: 'https://untrusted.invalid' },
    ]) {
      expect(
        validateSettings({ judgment: { backend: 'bailian', ...extra } })
          .success,
      ).toBe(false);
    }
  });
});

it('validates experimental question mode selectors', async () => {
  const { validateSettings } = await import('./settings-validation.js');
  for (const mode of ['single', 'multi'])
    expect(
      validateSettings({
        autoMode: { classifier: 'jev', jevQuestionMode: mode },
      }).success,
    ).toBe(true);
  expect(
    validateSettings({
      autoMode: { classifier: 'jev', jevQuestionMode: 'other' },
    }).success,
  ).toBe(false);
});
