/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { FatalInputError, type Config, type Model } from '@qwen-code/core';
import { testListedModel } from '../../../core/src/test-utils/listed-model.js';
import { createStartupModelApplier } from './applyStartupModel.js';

const max = testListedModel('qmodel_38max', {
  display_name: 'Qwen3.8-Max',
  is_new: true,
});

function setup(models: Model[] = [max]) {
  let selected = 'resume-model';
  const manager = {
    listModels: vi.fn(async () => models),
    setMainModel: vi.fn((model: Model, _persist?: boolean) => {
      selected = model.key;
      return true;
    }),
  };
  const config = {
    getModelProviderManager: () => manager,
    reconcileModelWithListedModels: vi.fn(async () => {
      manager.setMainModel(max, false);
    }),
  } as unknown as Config;
  return {
    listModels: manager.listModels,
    setMainModel: manager.setMainModel,
    config,
    selected: () => selected,
  };
}

describe('createStartupModelApplier', () => {
  it.each([max.displayName, undefined])(
    '启动输入 %s 并发及后续调用不重复应用或覆盖用户切模',
    async (input) => {
      const { config, setMainModel, selected } = setup();
      const apply = createStartupModelApplier(input);
      await Promise.all([apply(config), apply(config)]);
      expect(selected()).toBe(max.key);
      expect(config.reconcileModelWithListedModels).toHaveBeenCalledWith({
        modelsWereAwaited: true,
      });
      expect(config.reconcileModelWithListedModels).toHaveBeenCalledOnce();
      expect(setMainModel).toHaveBeenCalledOnce();

      await apply(config);
      expect(config.reconcileModelWithListedModels).toHaveBeenCalledOnce();
    },
  );

  it('不自行解析模型，未知输入交给目录校正回退', async () => {
    const { config, setMainModel } = setup();
    await createStartupModelApplier('unknown-model')(config);
    expect(config.reconcileModelWithListedModels).toHaveBeenCalledOnce();
    expect(setMainModel).toHaveBeenCalledOnce();
  });

  it('目录为空时按未就绪处理，不触发回退', async () => {
    const { config, listModels } = setup([]);
    await createStartupModelApplier('unknown-model')(config);
    expect(listModels).toHaveBeenCalledOnce();
    expect(config.reconcileModelWithListedModels).toHaveBeenCalledWith({
      modelsWereAwaited: false,
    });
  });

  it('空白 -m 直接报错', async () => {
    const { config, setMainModel } = setup();
    await expect(
      createStartupModelApplier('   ')(config),
    ).rejects.toBeInstanceOf(FatalInputError);
    expect(config.reconcileModelWithListedModels).not.toHaveBeenCalled();
    expect(setMainModel).not.toHaveBeenCalled();
  });

  it('目录校正失败时保留错误，后续调用可以重试', async () => {
    const { config } = setup();
    vi.mocked(config.reconcileModelWithListedModels).mockRejectedValueOnce(
      new Error('reconcile failed'),
    );
    const apply = createStartupModelApplier(max.key);
    await expect(apply(config)).rejects.toThrow('reconcile failed');
    await apply(config);
    expect(config.reconcileModelWithListedModels).toHaveBeenCalledTimes(2);
  });

  it('每次启动持有独立动作', async () => {
    const { config, setMainModel } = setup();
    await createStartupModelApplier(max.key)(config);
    await createStartupModelApplier(max.key)(config);
    expect(setMainModel).toHaveBeenCalledTimes(2);
  });
});
