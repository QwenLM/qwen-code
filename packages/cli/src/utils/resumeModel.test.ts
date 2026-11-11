/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  type Config,
  ModelProviderManager,
  type Model,
  type ModelConfig,
} from '@qwen-code/core';
import {
  restoreModelFromResumeData,
  restoreRuntimeConfigFromResumeData,
} from './resumeModel.js';
import { testListedModel } from '../../../core/src/test-utils/listed-model.js';

let listedModels: Model[] = [];
let preferences: Map<string, ModelConfig>;
let setModelConfig: MockInstance<ModelProviderManager['setModelConfig']>;

function makeConfig(): Config {
  return {
    getCliModel: vi.fn().mockReturnValue(undefined),
    getCliReasoningEffort: vi.fn().mockReturnValue(undefined),
    getCliContextWindow: vi.fn().mockReturnValue(undefined),
    getModelRequestIdentity: vi.fn(() => 'account-1'),
    getSessionId: vi.fn(() => 'session-1'),
    getModel: vi.fn().mockReturnValue('current-model'),
    getAvailableContextWindows: vi.fn().mockReturnValue([128000, 200000]),
    setModel: vi.fn(async function (this: Config, model: string) {
      vi.mocked(this.getModel).mockReturnValue(model);
      return true;
    }),
    getModelProviderManager: () =>
      Object.create(ModelProviderManager.prototype) as ModelProviderManager,
  } as unknown as Config;
}

function addCatalogModel(key: string, enable = true) {
  listedModels.push(testListedModel(key, { enable }));
}

/** 与 provider 一致的补丁语义：字段级合并，显式 undefined 表示清除。 */
function applyPatch(base: ModelConfig, patch: ModelConfig): ModelConfig {
  const next: Record<string, Record<string, unknown> | undefined> = {
    ...(base as Record<string, Record<string, unknown>>),
  };
  for (const [group, fields] of Object.entries(patch)) {
    if (fields === undefined) {
      delete next[group];
      continue;
    }
    const merged = { ...next[group] };
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) delete merged[field];
      else merged[field] = value;
    }
    next[group] = merged;
  }
  return next as ModelConfig;
}

function resetCatalogModels() {
  listedModels = [];
  preferences = new Map();
  vi.spyOn(ModelProviderManager.prototype, 'listModels').mockImplementation(
    async () => listedModels,
  );
  vi.spyOn(ModelProviderManager.prototype, 'getModel').mockImplementation(
    async (key) => listedModels.find((model) => model.key === key),
  );
  vi.spyOn(
    ModelProviderManager.prototype,
    'getModelConfig',
  ).mockImplementation((target) =>
    preferences.get(typeof target === 'string' ? target : target.key),
  );
  setModelConfig = vi
    .spyOn(ModelProviderManager.prototype, 'setModelConfig')
    .mockImplementation((model, patch) => {
      preferences.set(
        model.key,
        applyPatch(preferences.get(model.key) ?? {}, patch),
      );
      return true;
    });
}

/** 某模型收到的偏好写入：[patch, persist]。 */
function writesTo(key: string): Array<[ModelConfig, boolean | undefined]> {
  return setModelConfig.mock.calls
    .filter(([model]) => model.key === key)
    .map(([, patch, persist]) => [patch, persist]);
}

describe('restoreModelFromResumeData', () => {
  beforeEach(() => {
    resetCatalogModels();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores the resume model when the catalog knows it is enabled', async () => {
    addCatalogModel('resume-model', true);
    const config = makeConfig();

    await restoreModelFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'resume-model',
    });

    expect(config.setModel).toHaveBeenCalledWith('resume-model', true);
  });

  it('skips a resume model that is missing from a loaded catalog', async () => {
    addCatalogModel('other-model', true);
    const config = makeConfig();

    await restoreModelFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'missing-model',
    });

    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('skips a resume model that is disabled in the catalog', async () => {
    addCatalogModel('disabled-model', false);
    const config = makeConfig();

    await restoreModelFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'disabled-model',
    });

    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('keeps an explicit CLI model override', async () => {
    addCatalogModel('resume-model', true);
    const config = makeConfig();
    vi.mocked(config.getCliModel).mockReturnValue('cli-model');

    await restoreModelFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'resume-model',
    });

    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('carries the CLI reasoning onto the resumed model and keeps its sampling', async () => {
    addCatalogModel('current-model');
    addCatalogModel('resume-model');
    preferences.set('current-model', { reasoning: { effort: 'low' } });
    preferences.set('resume-model', {
      reasoning: { effort: 'high' },
      sampling: { temperature: 0.8 },
    });
    const config = makeConfig();
    vi.mocked(config.getCliReasoningEffort).mockReturnValue('low');

    await restoreModelFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'resume-model',
    });

    expect(preferences.get('resume-model')).toMatchObject({
      reasoning: { effort: 'low' },
      sampling: { temperature: 0.8 },
    });
    expect(writesTo('resume-model').every(([, persist]) => !persist)).toBe(
      true,
    );
  });
});

describe('restoreRuntimeConfigFromResumeData', () => {
  beforeEach(() => {
    resetCatalogModels();
    addCatalogModel('current-model');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores the resume context window after restoring the model', async () => {
    addCatalogModel('resume-model', true);
    const config = makeConfig();
    vi.mocked(config.getAvailableContextWindows).mockReturnValue([
      128000, 256000,
    ]);

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'resume-model',
      contextWindow: 256000,
    });

    expect(config.setModel).toHaveBeenCalledWith('resume-model', true);
    expect(writesTo('resume-model')).toEqual([
      [{ context: { contextWindow: 256000 } }, undefined],
    ]);
  });

  it('restores model-scoped runtime settings when the active CLI model resolves to the resumed model', async () => {
    addCatalogModel('resume-model', true);
    const config = makeConfig();
    vi.mocked(config.getCliModel).mockReturnValue('Resume Model');
    vi.mocked(config.getModel).mockReturnValue('resume-model');
    vi.mocked(config.getAvailableContextWindows).mockReturnValue([
      128000, 400000,
    ]);

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'resume-model',
      generation: { temperature: 0.6 },
      reasoningEffort: 'high',
      contextWindow: 400000,
    });

    expect(config.setModel).not.toHaveBeenCalled();
    expect(preferences.get('resume-model')).toMatchObject({
      reasoning: { effort: 'high' },
      sampling: { temperature: 0.6 },
      context: { contextWindow: 400000 },
    });
  });

  it('keeps model-scoped CLI settings when the resumed model is unknown', async () => {
    const config = makeConfig();
    vi.mocked(config.getCliModel).mockReturnValue('cli-model');
    vi.mocked(config.getModel).mockReturnValue('cli-model');

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      generation: { temperature: 0.6 },
      reasoningEffort: 'high',
      contextWindow: 128000,
    });

    expect(setModelConfig).not.toHaveBeenCalled();
  });

  it('restores normalized generation config as session-only preference', async () => {
    const config = makeConfig();

    const restored = await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      generation: {
        temperature: 0.6,
        topK: 40,
        reasoning: { effort: 'high', preserve: false },
      },
    });

    expect(preferences.get('current-model')).toMatchObject({
      reasoning: { effort: 'high', preserve: false },
      sampling: { temperature: 0.6, topK: 40 },
    });
    expect(writesTo('current-model').every(([, persist]) => !persist)).toBe(
      true,
    );
    expect(restored.generation).toEqual({
      temperature: 0.6,
      topK: 40,
      reasoning: { effort: 'high', preserve: false },
    });
  });

  it('clears generation config when the resumed session explicitly had none', async () => {
    preferences.set('current-model', { sampling: { temperature: 0.2 } });
    const config = makeConfig();

    const restored = await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      generation: null,
    });

    expect(
      preferences.get('current-model')?.sampling?.temperature,
    ).toBeUndefined();
    expect(restored.generation).toBeNull();
  });

  it('keeps a CLI reasoning override while restoring sampling fields', async () => {
    preferences.set('current-model', { reasoning: { effort: 'max' } });
    const config = makeConfig();
    vi.mocked(config.getCliReasoningEffort).mockReturnValue('max');

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      generation: {
        temperature: 0.7,
        reasoning: { effort: 'low', budgetTokens: 1024 },
      },
      reasoningEffort: 'low',
    });

    expect(preferences.get('current-model')).toMatchObject({
      reasoning: { effort: 'max' },
      sampling: { temperature: 0.7 },
    });
    expect(
      preferences.get('current-model')?.reasoning?.thinking,
    ).toBeUndefined();
  });

  it('clears a context window when the resumed session explicitly had none', async () => {
    preferences.set('current-model', { context: { contextWindow: 128000 } });
    const config = makeConfig();

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      contextWindow: null,
    });

    expect(writesTo('current-model')).toEqual([
      [{ context: { contextWindow: undefined } }, undefined],
    ]);
    vi.unstubAllEnvs();
  });

  it('skips context restore when --context-window was provided', async () => {
    const config = makeConfig();
    vi.mocked(config.getCliContextWindow).mockReturnValue('128000');

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      contextWindow: 256000,
    });

    expect(setModelConfig).not.toHaveBeenCalled();
  });

  it('skips a context window unsupported by the resumed model', async () => {
    const config = makeConfig();
    vi.mocked(config.getAvailableContextWindows).mockReturnValue([128000]);

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      contextWindow: 256000,
    });

    expect(setModelConfig).not.toHaveBeenCalled();
  });

  it('skips an effort the model rejects without failing the resume', async () => {
    setModelConfig.mockImplementationOnce(() => {
      throw new Error('unsupported effort');
    });
    const config = makeConfig();

    const restored = await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      reasoningEffort: 'max',
    });

    expect(restored.reasoningEffort).toBeUndefined();
  });

  it('does not apply context when the resume model could not be restored', async () => {
    addCatalogModel('other-model', true);
    const config = makeConfig();

    await restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      model: 'missing-model',
      contextWindow: 128000,
    });

    expect(config.setModel).not.toHaveBeenCalled();
    expect(setModelConfig).not.toHaveBeenCalled();
  });
});

describe('恢复查询的异步隔离', () => {
  beforeEach(resetCatalogModels);
  afterEach(() => vi.restoreAllMocks());

  it.each(['model', 'account', 'session'])(
    '丢弃查询期间 %s 变化后的恢复结果',
    async (changed) => {
      const config = makeConfig();
      let complete!: (models: Model[]) => void;
      vi.mocked(
        config.getModelProviderManager().listModels,
      ).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const restoring = restoreRuntimeConfigFromResumeData(config, {
        sessionId: 'session-1',
        messages: [],
        model: 'resume-model',
        generation: { temperature: 0.6 },
        reasoningEffort: 'high',
        contextWindow: 128000,
      });
      if (changed === 'model')
        vi.mocked(config.getModel).mockReturnValue('new-model');
      if (changed === 'account')
        vi.mocked(config.getModelRequestIdentity).mockReturnValue('account-2');
      if (changed === 'session')
        vi.mocked(config.getSessionId).mockReturnValue('session-2');
      complete([]);
      await restoring;
      expect(config.setModel).not.toHaveBeenCalled();
      expect(setModelConfig).not.toHaveBeenCalled();
    },
  );

  it('等待 generation 提交后才恢复 effort', async () => {
    addCatalogModel('current-model');
    const config = makeConfig();
    let complete!: () => void;
    const getModel = vi.mocked(config.getModelProviderManager().getModel);
    getModel.mockImplementationOnce(
      (key) =>
        new Promise((resolve) => {
          complete = () =>
            resolve(listedModels.find((model) => model.key === key));
        }),
    );
    const restoring = restoreRuntimeConfigFromResumeData(config, {
      sessionId: 'session-1',
      messages: [],
      generation: { temperature: 0.6 },
      reasoningEffort: 'high',
    });
    await vi.waitFor(() => expect(getModel).toHaveBeenCalled());
    expect(setModelConfig).not.toHaveBeenCalled();
    complete();
    await restoring;
    const writes = writesTo('current-model');
    expect(writes).toHaveLength(2);
    expect(writes[0]![0].sampling?.temperature).toBe(0.6);
    expect(writes[1]![0]).toEqual({ reasoning: { effort: 'high' } });
  });
});
