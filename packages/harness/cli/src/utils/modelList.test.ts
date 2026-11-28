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
  type MockInstance,
  vi,
} from 'vitest';
import type { Model } from '@qwen-code/core';

const mocks = vi.hoisted(() => ({
  exitCli: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock('./exitCli.js', () => ({ exitCli: mocks.exitCli }));

import { formatModelListText, runModelListCommand } from './modelList.js';

const model = (source: string, key: string, displayName: string): Model =>
  ({ source, key, displayName, enabled: true }) as unknown as Model;

const config = {
  getModelProviderManager: () => ({ listModels: mocks.listModels }),
};

describe('open-source model list', () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exitCli.mockResolvedValue(undefined);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('formats built-in and custom model rows', () => {
    expect(
      formatModelListText([
        model('qwen-provider', 'qwen-max', 'Qwen Max'),
        model('custom', 'custom-key', 'Custom'),
      ]),
    ).toBe('MODEL\nQwen Max (qwen-max)\nCustom (custom-key)\n');
  });

  it('lists models from the provider manager without auth', async () => {
    mocks.listModels.mockResolvedValue([model('custom', 'custom-key', 'Custom')]);

    await runModelListCommand({ config: config as never });

    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith('MODEL\nCustom (custom-key)\n');
    expect(mocks.exitCli).toHaveBeenCalledWith(0);
  });

  it('warns on an empty list', async () => {
    mocks.listModels.mockResolvedValue([]);

    await runModelListCommand({ config: config as never });

    expect(stderr).toHaveBeenCalledWith('Warning: no models available.\n');
    expect(mocks.exitCli).toHaveBeenCalledWith(0);
  });

  it('reports a provider failure', async () => {
    mocks.listModels.mockRejectedValue(new Error('catalog unavailable'));

    await runModelListCommand({ config: config as never });

    expect(stderr).toHaveBeenCalledWith(
      'Failed to fetch model list: catalog unavailable\n',
    );
    expect(mocks.exitCli).toHaveBeenCalledWith(1);
  });
});
