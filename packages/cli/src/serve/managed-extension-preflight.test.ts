/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ManagedPackageContributions } from '@qwen-code/qwen-code-core/extension/managed-package.js';
import { preflightManagedExtensionPackage } from './managed-extension-preflight.js';

const empty: ManagedPackageContributions = {
  skills: [],
  commands: [],
  agents: [],
  context: [],
  mcpServers: {},
  hooks: {},
  settings: [],
};
it('checks target executables and package scripts without executing code, while reporting dynamic dependency boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-preflight-'));
  try {
    const script = path.join(root, 'probe.js');
    await fs.writeFile(script, 'throw new Error("must not execute")');
    const contribution = {
      ...empty,
      mcpServers: { test: { command: process.execPath, args: [script] } },
    };
    await expect(
      preflightManagedExtensionPackage(contribution, root, root, {
        PATH: '/usr/bin:/bin',
      }),
    ).resolves.toEqual({ dynamicCommands: 0 });
    await fs.rm(script);
    await expect(
      preflightManagedExtensionPackage(contribution, root, root, {}),
    ).rejects.toThrow();
    await expect(
      preflightManagedExtensionPackage(
        {
          ...empty,
          mcpServers: { bad: { command: 'missing-extension-interpreter-123' } },
        },
        root,
        root,
        { PATH: root },
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      preflightManagedExtensionPackage(
        {
          ...empty,
          hooks: {
            PreToolUse: [
              { hooks: [{ type: 'command', command: 'echo dynamic | cat' }] },
            ],
          },
        },
        root,
        root,
        { PATH: '/usr/bin:/bin' },
      ),
    ).resolves.toEqual({ dynamicCommands: 1 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
