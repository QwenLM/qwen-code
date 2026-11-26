/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '@qwen-code/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'settings-agent-overrides-'));
  await mkdir(join(root, 'user'));
  await mkdir(join(root, 'workspace'));
  vi.stubEnv(ENV_CONFIG_DIR, join(root, 'user'));

  vi.resetModules();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

it('loads tool overrides without recovery removing them or rewriting disk', async () => {
  const overrides = {
    demo: {
      tools: ['read_file'],
    },
    empty: { tools: [] },
  };
  const raw = JSON.stringify({ agents: { overrides } });
  const path = join(root, 'user', 'settings.json');
  await writeFile(path, raw);
  const { loadSettings } = await import('../test-utils/resolveSettings.js');
  const settings = loadSettings(join(root, 'workspace'));
  expect(settings.errors).toEqual([]);
  expect(settings.user.originalSettings.agents?.overrides).toEqual(overrides);
  expect(settings.merged.agents.overrides).toEqual(overrides);
  expect(await readFile(path, 'utf8')).toBe(raw);
});

it.each([{ tools: [1] }, { tools: 'read_file' }])(
  'rejects malformed override fields: %j',
  async (override) => {
    const { validateSettings } = await import('./settings-validation.js');
    const result = validateSettings({
      agents: { overrides: { demo: override } },
    });
    expect(result.success).toBe(false);
  },
);

it('rejects inline MCP overrides and removes them when loading trusted project settings', async () => {
  const input = {
    agents: {
      overrides: {
        demo: {
          tools: ['read_file'],
          mcpServers: { inline: { command: 'must-not-run' } },
        },
      },
    },
  };
  const { validateSettings } = await import('./settings-validation.js');
  const result = validateSettings(input);
  expect(result.success).toBe(false);
  expect(result.error?.issues).toContainEqual(
    expect.objectContaining({
      code: 'unrecognized_keys',
      path: ['agents', 'overrides', 'demo'],
      keys: ['mcpServers'],
    }),
  );
  const trust = await import('./trustedFolders.js');
  vi.spyOn(trust, 'isWorkspaceTrusted').mockReturnValue({
    isTrusted: true,
    source: undefined,
  });
  const { Storage } = await import('@qwen-code/core');
  const workspace = join(root, 'workspace');
  const path = new Storage(workspace).getWorkspaceSettingsPath();
  await mkdir(dirname(path), { recursive: true });
  const raw = JSON.stringify(input);
  await writeFile(path, raw);
  const { loadSettings } = await import('../test-utils/resolveSettings.js');
  const settings = loadSettings(workspace);
  expect(settings.isTrusted).toBe(true);
  expect(settings.project.settings.agents?.overrides?.['demo']).toEqual({
    tools: ['read_file'],
  });
  expect(settings.merged.agents.overrides['demo']).toEqual({
    tools: ['read_file'],
  });
  expect(await readFile(path, 'utf8')).toBe(raw);
});
