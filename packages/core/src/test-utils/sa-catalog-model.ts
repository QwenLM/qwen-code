/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../provider/model/model.js';
import type { ListedModelEntryFixture } from './listed-model-entry.js';
import { testListedModel } from './listed-model.js';

/** SA 平台模型夹具：默认带 0.3 价格系数的 system 来源服务端模型。 */
export function testServiceAccountCatalogModel(
  key: string,
  overrides: Partial<ListedModelEntryFixture> = {},
): Model {
  return testListedModel(key, { price_factor: 0.3, ...overrides });
}
