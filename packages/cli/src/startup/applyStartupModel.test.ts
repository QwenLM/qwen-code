/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FatalInputError,
  type Config,
  type Model,
  type ModelProviderManager,
} from '@qwen-code/core';
import { testListedModel } from '../../../core/src/test-utils/listed-model.js';
import {
  resolveStartupModel,
  createStartupModelApplier,
} from './applyStartupModel.js';

const max = testListedModel('qmodel_38max', {
  display_name: 'Qwen3.8-Max',
  is_new: true,
});

function setup(models: Model[] = [max]) {
  let selected = 'resume-model';
  const manager = {
    listModels: vi.fn(async () => models),
    getModel: vi.fn(async (key: string) =>
      models.find((model) => model.key === key),
    ),
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
    getSessionId: () => 'startup-model-test',
  } as unknown as Config;
  return {
    manager: manager as unknown as ModelProviderManager,
    listModels: manager.listModels,
    getModel: manager.getModel,
    setMainModel: manager.setMainModel,
    config,
    selected: () => selected,
  };
}

describe('resolveStartupModel', () => {
  it.each(['qmodel_38max', 'QMODEL_38MAX', 'Qwen3.8-Max', 'qwen3.8-max'])(
    '解析 key 或展示名 %s，使用命中模型且不持久化',
    async (input) => {
      const { manager, setMainModel } = setup();
      await expect(resolveStartupModel(manager, input)).resolves.toEqual(max);
      expect(setMainModel).not.toHaveBeenCalled();
    },
  );

  it('未指定模型时不读取目录或切换主模型', async () => {
    const { manager, listModels, setMainModel } = setup();
    await resolveStartupModel(manager, undefined);
    expect(listModels).not.toHaveBeenCalled();
    expect(setMainModel).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'unknown-model'])(
    '拒绝非法输入 %j，保留当前模型',
    async (input) => {
      const { manager, setMainModel, selected } = setup();
      await expect(resolveStartupModel(manager, input)).rejects.toBeInstanceOf(
        FatalInputError,
      );
      expect(setMainModel).not.toHaveBeenCalled();
      expect(selected()).toBe('resume-model');
    },
  );

  it('拒绝禁用模型', async () => {
    const { manager, setMainModel } = setup([{ ...max, enabled: false }]);
    await expect(resolveStartupModel(manager, max.displayName)).rejects.toThrow(
      'not available',
    );
    expect(setMainModel).not.toHaveBeenCalled();
  });

  it('展示名重名时要求指定 key；完整 key 使用实际 source', async () => {
    const custom = { ...max, key: 'gateway/max', source: 'gateway' };
    const { manager, setMainModel } = setup([max, custom]);
    await expect(resolveStartupModel(manager, max.displayName)).rejects.toThrow(
      'Ambiguous',
    );
    expect(setMainModel).not.toHaveBeenCalled();
    await expect(resolveStartupModel(manager, custom.key)).resolves.toEqual(
      custom,
    );
    expect(setMainModel).not.toHaveBeenCalled();
  });

  it('精确 key 优先于大小写 key 和同名展示名', async () => {
    const { manager, setMainModel } = setup([
      max,
      { ...max, key: 'QMODEL_38MAX' },
      { ...max, key: 'other', displayName: max.key },
    ]);
    await expect(resolveStartupModel(manager, max.key)).resolves.toEqual(max);
    expect(setMainModel).not.toHaveBeenCalled();
  });

  it('空目录不回退 auto', async () => {
    const { manager, selected } = setup([]);
    await expect(resolveStartupModel(manager, max.displayName)).rejects.toThrow(
      'Unknown model',
    );
    expect(selected()).toBe('resume-model');
  });

  it.each([max.key, max.displayName])(
    '目录隐藏模型时保留 %s 的原始准入错误',
    async (input) => {
      const { manager, listModels, getModel, setMainModel } = setup();
      const error = new Error('Provider denied access');
      listModels.mockResolvedValueOnce([]);
      getModel.mockRejectedValueOnce(error);
      await expect(resolveStartupModel(manager, input)).rejects.toBe(error);
      expect(setMainModel).not.toHaveBeenCalled();
    },
  );

  it('解析后准入被撤销时保留错误且不修改模型', async () => {
    const { manager, getModel, setMainModel } = setup();
    const error = new Error('Access changed');
    getModel.mockRejectedValueOnce(error);
    await expect(resolveStartupModel(manager, max.key)).rejects.toBe(error);
    expect(setMainModel).not.toHaveBeenCalled();
  });

  it('解析后模型被移除时不应用过期目录快照', async () => {
    const { manager, getModel, setMainModel } = setup();
    getModel.mockResolvedValueOnce(undefined);
    await expect(resolveStartupModel(manager, max.key)).rejects.toThrow(
      'not available',
    );
    expect(setMainModel).not.toHaveBeenCalled();
  });
});

describe('createStartupModelApplier', () => {
  it('覆盖恢复模型，并发及后续调用不重复应用或覆盖用户切模', async () => {
    const { config, manager, setMainModel, selected } = setup();
    const apply = createStartupModelApplier(max.displayName);
    await Promise.all([apply(config), apply(config)]);
    expect(selected()).toBe(max.key);
    expect(config.reconcileModelWithListedModels).toHaveBeenCalledWith({
      onInvalidCliModel: 'throw',
    });
    expect(config.reconcileModelWithListedModels).toHaveBeenCalledOnce();
    expect(setMainModel).toHaveBeenCalledOnce();

    manager.setMainModel({ ...max, key: 'user-selection' }, false);
    await apply(config);
    expect(selected()).toBe('user-selection');
    expect(setMainModel).toHaveBeenCalledTimes(2);
    expect(config.reconcileModelWithListedModels).toHaveBeenCalledOnce();
  });

  it('目录准备失败后可以重试', async () => {
    const { config, listModels, setMainModel } = setup();
    listModels.mockRejectedValueOnce(new Error('catalog failed'));
    const apply = createStartupModelApplier(max.key);
    await expect(apply(config)).rejects.toThrow('catalog failed');
    expect(setMainModel).not.toHaveBeenCalled();
    await apply(config);
    expect(setMainModel).toHaveBeenCalledOnce();
  });

  it('启动偏好校正失败时保留错误，后续调用可以重试', async () => {
    const { config } = setup();
    vi.mocked(config.reconcileModelWithListedModels).mockRejectedValueOnce(
      new Error('reconcile failed'),
    );
    const apply = createStartupModelApplier(max.key);
    await expect(apply(config)).rejects.toThrow('reconcile failed');
    await apply(config);
    expect(config.reconcileModelWithListedModels).toHaveBeenCalledTimes(2);
  });

  it('每次启动持有独立动作；未指定时不要求 Config 模型能力', async () => {
    await createStartupModelApplier(undefined)({} as Config);
    const { config, setMainModel } = setup();
    await createStartupModelApplier(max.key)(config);
    await createStartupModelApplier(max.key)(config);
    expect(setMainModel).toHaveBeenCalledTimes(2);
  });
});
