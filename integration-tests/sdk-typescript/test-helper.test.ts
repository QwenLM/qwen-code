/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SDKTestHelper } from './test-helper.js';

describe('SDKTestHelper settings file', () => {
  let helper: SDKTestHelper;

  afterEach(async () => {
    await helper?.cleanup();
  });

  it('disables managed auto-memory by default', async () => {
    helper = new SDKTestHelper();
    const dir = await helper.setup('sdk managed memory default off');

    const written = JSON.parse(
      await readFile(join(dir, '.qwen', 'settings.json'), 'utf-8'),
    ) as { memory?: Record<string, unknown> };
    expect(written.memory).toEqual({
      enableManagedAutoMemory: false,
      enableManagedAutoDream: false,
    });
  });

  it('lets a suite opt back in via settings', async () => {
    helper = new SDKTestHelper();
    const dir = await helper.setup('sdk managed memory opted back in', {
      settings: { memory: { enableManagedAutoMemory: true } },
    });

    const written = JSON.parse(
      await readFile(join(dir, '.qwen', 'settings.json'), 'utf-8'),
    ) as { memory?: Record<string, unknown> };
    expect(written.memory).toEqual({
      enableManagedAutoMemory: true,
      enableManagedAutoDream: false,
    });
  });
});
