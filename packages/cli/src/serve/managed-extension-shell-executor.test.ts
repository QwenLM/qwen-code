/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { ManagedExtensionExecutionUnknownError } from './managed-extension-error.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
  ManagedMcpToolUnknownError,
} from './managed-runtime-tool-executor.js';

it('retains an unproven extension Shell as unknown without settling or replaying the native invocation', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'extension-executor-'),
  );
  const runShell = vi.fn(async () => {
    throw new ManagedExtensionExecutionUnknownError(
      'Original owner stop is unknown.',
    );
  });
  const native = createManagedToolSet(directory, 'owner');
  const resolver = vi.fn(async () => ({ ...native, runShell }));
  const executor = new ManagedToolExecutor(resolver);
  const input = {
    command: 'printf test',
    managedExtension: {
      harnessSessionId: 'root',
      configRevision: 1,
      pin: {
        extensionId: 'one',
        packageRevision: 1,
        packageDigest: 'a'.repeat(64),
      },
    },
  };
  const reference = {
    sessionId: 'owner',
    promptId: 'prompt',
    callId: 'original-step',
    argsDigest: managedToolDigest(input),
  };
  try {
    await expect(
      executor.execute(reference, 'run_shell_command', input),
    ).rejects.toBeInstanceOf(ManagedMcpToolUnknownError);
    expect(executor.status(reference)).toMatchObject({ state: 'unknown' });
    expect(executor.isSessionConfigurationIdle('owner')).toBe(false);
    expect(resolver).toHaveBeenCalledWith(reference, {
      toolName: 'run_shell_command',
      input,
    });
    await expect(
      executor.execute(reference, 'run_shell_command', input),
    ).rejects.toBeInstanceOf(ManagedMcpToolUnknownError);
    expect(runShell).toHaveBeenCalledTimes(1);
  } finally {
    await executor.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
