/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyVerifyPrCoordinateEnv,
  VERIFY_PR_COORDINATE_ENV,
} from './verify-pr-coordinates.js';
import { WORKSPACE_RESTRICTED_ROOT_SETTINGS } from './settingsUtils.js';

describe('applyVerifyPrCoordinateEnv', () => {
  it('fills both variables when the environment has neither', () => {
    const env: NodeJS.ProcessEnv = {};
    const applied = applyVerifyPrCoordinateEnv(
      { assetsRepo: 'wenshao/qwen-code', assetsBranch: 'assets/wenshao' },
      env,
    );

    expect(applied).toEqual([
      VERIFY_PR_COORDINATE_ENV.assetsRepo,
      VERIFY_PR_COORDINATE_ENV.assetsBranch,
    ]);
    expect(env['QWEN_VERIFY_ASSETS_REPO']).toBe('wenshao/qwen-code');
    expect(env['QWEN_VERIFY_ASSETS_BRANCH']).toBe('assets/wenshao');
  });

  it('leaves an exported variable alone, so a one-off run still wins', () => {
    const env: NodeJS.ProcessEnv = {
      QWEN_VERIFY_ASSETS_REPO: 'QwenLM/qwen-code',
    };

    applyVerifyPrCoordinateEnv({ assetsRepo: 'wenshao/qwen-code' }, env);

    expect(env['QWEN_VERIFY_ASSETS_REPO']).toBe('QwenLM/qwen-code');
  });

  it('treats an empty export as unset', () => {
    const env: NodeJS.ProcessEnv = { QWEN_VERIFY_ASSETS_BRANCH: '' };

    applyVerifyPrCoordinateEnv({ assetsBranch: 'assets/pr1-validation' }, env);

    expect(env['QWEN_VERIFY_ASSETS_BRANCH']).toBe('assets/pr1-validation');
  });

  it('ignores blank values and absent settings', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(applyVerifyPrCoordinateEnv(undefined, env)).toEqual([]);
    expect(applyVerifyPrCoordinateEnv({ assetsRepo: '   ' }, env)).toEqual([]);
    expect(env['QWEN_VERIFY_ASSETS_REPO']).toBeUndefined();
  });

  it('trims the configured value', () => {
    const env: NodeJS.ProcessEnv = {};

    applyVerifyPrCoordinateEnv({ assetsRepo: ' wenshao/qwen-code ' }, env);

    expect(env['QWEN_VERIFY_ASSETS_REPO']).toBe('wenshao/qwen-code');
  });

  // A long-lived process reloads settings without restarting; an add-only
  // bridge would keep publishing to the host the previous value named.
  it('replaces a value it wrote when the setting changes', () => {
    const env: NodeJS.ProcessEnv = {};

    applyVerifyPrCoordinateEnv({ assetsRepo: 'wenshao/qwen-code' }, env);
    applyVerifyPrCoordinateEnv({ assetsRepo: 'QwenLM/qwen-code' }, env);

    expect(env['QWEN_VERIFY_ASSETS_REPO']).toBe('QwenLM/qwen-code');
  });

  it('removes a value it wrote when the setting disappears', () => {
    const env: NodeJS.ProcessEnv = {};

    applyVerifyPrCoordinateEnv({ assetsRepo: 'wenshao/qwen-code' }, env);
    applyVerifyPrCoordinateEnv(undefined, env);

    expect(env['QWEN_VERIFY_ASSETS_REPO']).toBeUndefined();
  });

  it('leaves an exported value in place when the setting disappears', () => {
    const env: NodeJS.ProcessEnv = { QWEN_VERIFY_ASSETS_REPO: 'operator/fork' };

    applyVerifyPrCoordinateEnv({ assetsRepo: 'wenshao/qwen-code' }, env);
    applyVerifyPrCoordinateEnv(undefined, env);

    expect(env['QWEN_VERIFY_ASSETS_REPO']).toBe('operator/fork');
  });

  // The list is what strips a workspace value before the merge; deleting the
  // entry would silently let a cloned repository choose the publishing host.
  it('is registered as a workspace-restricted root', () => {
    expect([...WORKSPACE_RESTRICTED_ROOT_SETTINGS]).toContain('verifyPr');
  });
});
