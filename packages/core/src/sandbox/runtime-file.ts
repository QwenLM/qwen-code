/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  encodeTextFileContentAsync,
  type CoreWriteTextFileRequest,
} from '../services/fileSystemService.js';
import {
  getSandboxFileVersion,
  type SandboxFileVersion,
} from './file-version.js';
import { writeSandboxFile } from './file-worker-client.js';
import { assertShellSandboxCwd } from './runtime-shell-policy.js';

export function captureRuntimeFileVersion(
  config: Config,
  filePath: string,
): SandboxFileVersion | null | undefined {
  if (!config.getShellExecutionSandbox?.()) return undefined;
  return getSandboxFileVersion(filePath);
}

export async function writeRuntimeFile(
  config: Config,
  params: CoreWriteTextFileRequest,
  expected: SandboxFileVersion | null | undefined,
  signal: AbortSignal,
): Promise<void> {
  const policy = config.getShellExecutionSandbox?.();
  if (!policy) {
    await config.getFileSystemService().writeTextFile(params);
    return;
  }
  signal.throwIfAborted();
  if (expected === undefined) throw new Error('Missing sandbox file version.');
  assertShellSandboxCwd(policy, config.getTargetDir());
  const content = await encodeTextFileContentAsync(
    params.path,
    params.content,
    params._meta,
  );
  await writeSandboxFile(
    policy,
    {
      operation: 'write',
      destination: params.path,
      content,
      expected,
    },
    signal,
  );
}
