/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { stubSnapshotSource } from '../test-utils/listed-model.js';
import { getDefaultUtilityModel } from './defaultUtilityModel.js';

describe('getDefaultUtilityModel', () => {
  it('uses lite without a catalog dependency', async () => {
    const snapshot = stubSnapshotSource();
    snapshot.manager.listModels.mockRejectedValue(
      new Error('catalog unavailable'),
    );
    expect(await getDefaultUtilityModel(snapshot.source)).toBe('lite');
    expect(snapshot.manager.listModels).not.toHaveBeenCalled();
  });
});
