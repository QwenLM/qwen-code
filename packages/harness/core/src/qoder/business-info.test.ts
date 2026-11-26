/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyBusinessSubTask,
  resolveBusinessSubTask,
  type BusinessInfo,
} from './business-info.js';
import { ENV_BUSINESS_SUB_TASK } from '../config/brand.js';

const baseBusiness: BusinessInfo = { version: 'test', id: 'b1' };

describe('resolveBusinessSubTask', () => {
  beforeEach(() => {
    vi.stubEnv(ENV_BUSINESS_SUB_TASK, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps internal query sources regardless of override', () => {
    expect(resolveBusinessSubTask('generate_session_title', 'sdk_tag')).toBe(
      'title_generation',
    );
    expect(resolveBusinessSubTask('prompt_suggestion', 'sdk_tag')).toBe(
      'prompt_suggestion',
    );
    expect(resolveBusinessSubTask('awareness', 'sdk_tag')).toBe(
      'awareness_nudge',
    );
  });

  it('uses the override when no internal query source matches', () => {
    expect(resolveBusinessSubTask(undefined, 'sdk_tag')).toBe('sdk_tag');
  });

  it('prefers the override over the environment variable', () => {
    vi.stubEnv(ENV_BUSINESS_SUB_TASK, 'env_tag');
    expect(resolveBusinessSubTask(undefined, 'sdk_tag')).toBe('sdk_tag');
  });

  it('falls back to the environment variable when the override is blank', () => {
    vi.stubEnv(ENV_BUSINESS_SUB_TASK, 'env_tag');
    expect(resolveBusinessSubTask(undefined, '   ')).toBe('env_tag');
    expect(resolveBusinessSubTask(undefined)).toBe('env_tag');
  });

  it('returns undefined when no source provides a value', () => {
    expect(resolveBusinessSubTask(undefined, undefined)).toBeUndefined();
  });
});

describe('applyBusinessSubTask', () => {
  beforeEach(() => {
    vi.stubEnv(ENV_BUSINESS_SUB_TASK, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('applies the override as sub_task', () => {
    const result = applyBusinessSubTask(baseBusiness, undefined, 'sdk_tag');
    expect(result.sub_task).toBe('sdk_tag');
  });

  it('strips sub_task when nothing resolves', () => {
    const result = applyBusinessSubTask(
      { ...baseBusiness, sub_task: 'stale' },
      undefined,
    );
    expect(result).not.toHaveProperty('sub_task');
  });
});
