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

const coreMocks = vi.hoisted(() => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  sessionLogger: { setExitContext: vi.fn() },
}));

vi.mock('@qwen-code/core', () => ({
  getErrorMessage: coreMocks.getErrorMessage,
  sessionLogger: coreMocks.sessionLogger,
  runLogger: { warn: vi.fn() },
}));

const sharedMocks = vi.hoisted(() => ({
  listPluginsForCommand: vi.fn(async () => 'No plugins installed.'),
}));

vi.mock('@qwen-code/core/plugin-management', () => ({
  listPluginsForCommand: sharedMocks.listPluginsForCommand,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(() => {
    throw new Error('Legacy loader must not be used');
  }),
  getFlagSettingsInput: vi.fn(),
  restoreLoadedEnvironment: vi.fn(),
}));

vi.mock('../../config/createCliSettingsService.js', () => ({
  createCliSettingsService: async () => ({
    resolve: () => ({ merged: {}, errors: [] }),
  }),
}));

vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(async () => {}),
}));

import { handleList, createListCommand } from './list.js';

describe('plugins list command', () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    vi.clearAllMocks();
    sharedMocks.listPluginsForCommand.mockResolvedValue(
      'No plugins installed.',
    );
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  it('has the expected command definition', () => {
    const cmd = createListCommand();
    expect(cmd.name()).toBe('list');
  });

  it('writes the listing produced by listPluginsForCommand', async () => {
    sharedMocks.listPluginsForCommand.mockResolvedValueOnce('<listing output>');

    await handleList();

    expect(sharedMocks.listPluginsForCommand).toHaveBeenCalled();
    expect(stdoutWriteSpy).toHaveBeenCalledWith('<listing output>\n');
  });
});
