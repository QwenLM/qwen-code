/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';
import { EnvConfigService } from '../env-config-service.js';
import { installConfigService, stopConfigService } from '../index.js';
import { getAutoModeReviewPresets } from './autoModeReviewPresets.js';
import defaults from './autoModeReviewPresets.defaults.json' with { type: 'json' };
import { runLogger } from '../../utils/runLogger.js';

const key = `${BRAND_FIXED_ENV_PREFIX}CONFIG_AUTO_MODE_REVIEW_PRESETS`;
let environment: NodeJS.ProcessEnv;
const empty = {
  commands: [],
  git_subcommands: [],
  find_delete: false,
  mkfs_variants: false,
};

beforeEach(() => {
  environment = {};
  installConfigService(new EnvConfigService({ environment }));
  getAutoModeReviewPresets();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stopConfigService();
});

describe('auto_mode_review_presets', () => {
  it('uses the initial QCS payload as the built-in fallback', () => {
    expect(getAutoModeReviewPresets()).toEqual(defaults);
    environment[key] = JSON.stringify(defaults);
    expect(getAutoModeReviewPresets()).toEqual(defaults);
  });

  it('replaces defaults and accepts an explicitly empty policy', () => {
    const custom = {
      ...empty,
      commands: ['docker'],
      git_subcommands: [['fetch'], ['remote', 'remove']],
    };
    environment[key] = JSON.stringify(custom);
    expect(getAutoModeReviewPresets()).toEqual(custom);
    environment[key] = JSON.stringify(empty);
    expect(getAutoModeReviewPresets()).toEqual(empty);
  });

  it.each([
    '',
    'not-json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ commands: [] }),
    JSON.stringify({ ...empty, commands: [''] }),
    JSON.stringify({ ...empty, commands: ['git reset'] }),
    JSON.stringify({ ...empty, commands: ['/bin/rm'] }),
    JSON.stringify({ ...empty, commands: ['rm*'] }),
    JSON.stringify({ ...empty, commands: [7] }),
    JSON.stringify({ ...empty, git_subcommands: ['reset'] }),
    JSON.stringify({ ...empty, git_subcommands: [[]] }),
    JSON.stringify({ ...empty, git_subcommands: [['stash', null]] }),
    JSON.stringify({ ...empty, find_delete: 'false' }),
    JSON.stringify({ ...empty, mkfs_variants: 0 }),
  ])('restores defaults on an invalid update: %s', (value) => {
    environment[key] = JSON.stringify(empty);
    expect(getAutoModeReviewPresets()).toEqual(empty);
    environment[key] = value;
    expect(getAutoModeReviewPresets()).toEqual(defaults);
  });

  it('restores defaults when the key or config source disappears', async () => {
    environment[key] = JSON.stringify(empty);
    expect(getAutoModeReviewPresets()).toEqual(empty);
    delete environment[key];
    expect(getAutoModeReviewPresets()).toEqual(defaults);
    environment[key] = JSON.stringify(empty);
    await stopConfigService();
    expect(getAutoModeReviewPresets()).toEqual(defaults);
  });

  it('does not warn for missing or valid values, including empty presets', () => {
    const warn = vi.spyOn(runLogger, 'warn');
    getAutoModeReviewPresets();
    environment[key] = JSON.stringify(defaults);
    getAutoModeReviewPresets();
    environment[key] = JSON.stringify(empty);
    getAutoModeReviewPresets();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once for repeated invalid values and warns again when they change', () => {
    const warn = vi.spyOn(runLogger, 'warn');
    environment[key] = 'invalid';
    for (let i = 0; i < 3; i++) {
      expect(getAutoModeReviewPresets()).toEqual(defaults);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid auto_mode_review_presets; using built-in defaults',
      ),
    );
    environment[key] = '{}';
    getAutoModeReviewPresets();
    getAutoModeReviewPresets();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, JSON.stringify(empty)])(
    'warns again after recovery through %s',
    (recovered) => {
      const warn = vi.spyOn(runLogger, 'warn');
      environment[key] = 'invalid';
      getAutoModeReviewPresets();
      environment[key] = recovered;
      getAutoModeReviewPresets();
      environment[key] = 'invalid';
      getAutoModeReviewPresets();
      expect(warn).toHaveBeenCalledTimes(2);
    },
  );
});
