/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exitSuccessfully } from './exitLifecycle.js';
import { runListExtensionsOption } from './listExtensions.js';

vi.mock('./exitLifecycle.js', () => ({
  exitSuccessfully: vi.fn(),
}));

describe('runListExtensionsOption', () => {
  type OptionContext = Parameters<typeof runListExtensionsOption>[0];
  type OptionCoordinator = Parameters<typeof runListExtensionsOption>[1];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exitSuccessfully).mockResolvedValue(undefined as never);
  });

  it('lists enabled extensions and exits successfully', async () => {
    const config = {
      getEnabledPlugins: vi.fn().mockReturnValue([{ name: 'sample-plugin' }]),
    };
    const startupCoordinator = {} as OptionCoordinator;
    const context = {
      phase: 'configured',
      config,
    } as unknown as OptionContext;

    await runListExtensionsOption(context, startupCoordinator);

    expect(exitSuccessfully).toHaveBeenCalledWith(
      config,
      startupCoordinator,
      'Listed extensions successfully',
      'gemini.listExtensions',
    );
  });
});
