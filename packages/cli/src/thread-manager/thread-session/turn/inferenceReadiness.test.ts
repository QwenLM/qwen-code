/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 推理面就绪：ThreadManager 只负责去重与宿主回调时序。
 * 认证落地与推理准备（refreshAuth / 模型目录 / 归一）全部由 host 注入。
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import type { ThreadInferencePreparation } from '../contract/hostContext.js';
import { SessionPhaseLog } from '../phase-log/sessionPhaseLog.js';
import { createInferenceReadiness } from './inferenceReadiness.js';

function setup(
  options: { catalogReadyInitialize?: boolean; withPrepare?: boolean } = {},
) {
  const config = { getModel: () => 'auto' } as unknown as Config;
  const settings = {
    merged: { security: { auth: { selectedType: 'qoder-browser' } } },
  } as unknown as LoadedSettings;
  const ensureAuthReady = vi.fn(async () => {});
  const prepareInference = vi.fn(
    async (_input: ThreadInferencePreparation) => {},
  );
  const phaseLog = new SessionPhaseLog('s-1');
  const readiness = createInferenceReadiness({
    sessionId: 's-1',
    signal: new AbortController().signal,
    ensureAuthReady,
    ...(options.withPrepare === false ? {} : { prepareInference }),
    getConfig: () => config,
    getSettings: () => settings,
    isCatalogReadyInitializeEnabled: () =>
      options.catalogReadyInitialize ?? false,
    getPhaseLog: () => phaseLog,
  });
  return { readiness, config, ensureAuthReady, prepareInference };
}

describe('createInferenceReadiness', () => {
  it('并发 ensure 只触发一次宿主认证与推理准备', async () => {
    const { readiness, config, ensureAuthReady, prepareInference } = setup({
      catalogReadyInitialize: true,
    });

    await Promise.all([readiness.ensure(), readiness.ensure()]);

    expect(ensureAuthReady).toHaveBeenCalledOnce();
    expect(prepareInference).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        config,
        selectedAuthType: 'qoder-browser',
        catalogReadyInitialize: true,
      }),
    );
  });

  it('宿主不提供推理准备时只等待认证，不自行回退到产品实现', async () => {
    const { readiness, ensureAuthReady, prepareInference } = setup({
      withPrepare: false,
    });

    await readiness.ensure();

    expect(ensureAuthReady).toHaveBeenCalledOnce();
    expect(prepareInference).not.toHaveBeenCalled();
  });

  it('失败后清空记账，下一次 ensure 可以重试', async () => {
    const { readiness, prepareInference } = setup();
    prepareInference.mockRejectedValueOnce(new Error('auth failed'));

    await expect(readiness.ensure()).rejects.toThrow('auth failed');
    await readiness.ensure();

    expect(prepareInference).toHaveBeenCalledTimes(2);
  });
});
