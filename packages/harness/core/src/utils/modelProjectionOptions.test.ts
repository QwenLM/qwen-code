/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import { buildModelProjectionOptions } from './modelProjectionOptions.js';

// 模拟名称相同的本地配置，验证已选定的模型不会误用它。
const config = {
  getCustomProviderRegistry: () => ({
    getProviderForModel: () => ({ providerId: 'local-provider' }),
  }),
} as unknown as Config;

describe('buildModelProjectionOptions', () => {
  const resolvedBy = (source: string) =>
    ({
      model: { key: 'target', source },
      config: {},
      source: 'fixed',
    }) as unknown as ModelSelection;

  it('keeps provider-served selections out of local cleanup', () => {
    expect(
      buildModelProjectionOptions(config, 'target', resolvedBy('qoder')),
    ).toEqual({ targetModel: 'target' });
  });

  it('uses the selected provider instead of the registry fallback', () => {
    expect(
      buildModelProjectionOptions(
        config,
        'target',
        resolvedBy('resolved-provider'),
      ),
    ).toEqual({
      targetModel: 'target',
      targetCustomProviderId: 'resolved-provider',
    });
  });

  it('resolves direct targets for callers without a resolved route', () => {
    expect(buildModelProjectionOptions(config, 'target')).toEqual({
      targetModel: 'target',
      targetCustomProviderId: 'local-provider',
    });
    expect(buildModelProjectionOptions(undefined, 'target')).toEqual({
      targetModel: 'target',
    });
  });
});
