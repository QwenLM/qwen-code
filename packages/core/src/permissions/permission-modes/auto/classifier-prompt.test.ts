/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigHomeDirCache } from '../../../utils/paths.js';

const emptySlots = {
  environment: [],
  hardDeny: [],
  softDeny: [],
  allow: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  _resetConfigHomeDirCache();
});

beforeEach(() => {
  vi.resetModules();
  _resetConfigHomeDirCache();
});

describe('classifier prompt config paths', () => {
  it('uses the default user config root', async () => {
    const { buildClassifierPromptFromSlots } = await import(
      './classifier-prompt.js'
    );

    expect(buildClassifierPromptFromSlots(emptySlots)).toContain(
      '~/.qwen/settings.json',
    );
  });

  it('uses an explicit user config root', async () => {
    vi.stubEnv('QWEN_CONFIG_DIR', '/custom/root');
    _resetConfigHomeDirCache();

    const { buildClassifierPromptFromSlots } = await import(
      './classifier-prompt.js'
    );
    const prompt = buildClassifierPromptFromSlots(emptySlots);

    expect(prompt).toContain('/custom/root/settings.json');
    expect(prompt).not.toContain('~/.qwen');
  });
});
