/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/core';

const mocks = vi.hoisted(() => ({ loadCliConfig: vi.fn() }));

vi.mock('../../config/config.js', () => ({
  loadCliConfig: mocks.loadCliConfig,
}));
vi.mock('../../utils/agentUtils.js', () => ({
  AGENT_SOURCE_LABELS: {
    flag: 'Flag',
    project: 'Project',
    user: 'User',
    plugin: 'Plugin',
    'built-in': 'Built-in',
  },
}));
vi.mock('chalk', () => ({ default: { dim: (text: string) => text } }));

import { handleList } from './list.js';

beforeEach(() => {
  mocks.loadCliConfig.mockReset();
  mocks.loadCliConfig.mockResolvedValue({
    initialize: async () => undefined,
    getAgentRegistry: () => ({ getAllDiscoveredDefinitions: () => [] }),
  });
});

describe('agents list setting sources', () => {
  it('recovers the sources the parent command captured from the raw argv', async () => {
    const argv = process.argv;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    process.argv = [
      'node',
      'qwen',
      'agents',
      'list',
      '--setting-sources',
      'project',
    ];
    try {
      await handleList({ settingSources: undefined });
      expect(mocks.loadCliConfig.mock.calls[0]?.[2]).toMatchObject({
        settingSources: ['project'],
      });
    } finally {
      process.argv = argv;
      write.mockRestore();
    }
  });

  it('keeps the user settings layer so folder trust survives --setting-sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-list-trust-'));
    const userDir = join(root, 'home', '.qwen');
    const projectDir = join(root, 'project');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(userDir, 'settings.json'),
      JSON.stringify({
        security: { folderTrust: { enabled: true } },
        permissions: { trustDirectories: [projectDir] },
      }),
    );
    const storage = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(userDir);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const argv = process.argv;
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    process.argv = [
      'node',
      'qwen',
      'agents',
      'list',
      '--setting-sources',
      'project',
    ];
    try {
      await handleList({ settingSources: undefined });
      const call = mocks.loadCliConfig.mock.calls.at(-1);
      // The trust record lives in the user layer; it must not be filtered away,
      // or the project agents are dropped as untrusted.
      expect(call?.[0]?.merged?.permissions?.trustDirectories).toEqual([
        projectDir,
      ]);
      expect(call?.[2]).toMatchObject({ settingSources: ['project'] });
    } finally {
      process.argv = argv;
      write.mockRestore();
      cwd.mockRestore();
      storage.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the value the subcommand option parsed itself', async () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await handleList({ settingSources: ['user'] });
      expect(mocks.loadCliConfig.mock.calls[0]?.[2]).toMatchObject({
        settingSources: ['user'],
      });
    } finally {
      write.mockRestore();
    }
  });
});
