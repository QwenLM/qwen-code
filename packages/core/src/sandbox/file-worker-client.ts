/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeBwrap, sandboxAsset } from './bwrap-execution.js';
import type { BwrapPolicy } from './bwrap-execution.js';
import {
  encodeSandboxWriteRequest,
  type SandboxWriteRequest,
} from './file-worker-protocol.js';

export async function writeSandboxFile(
  policy: BwrapPolicy,
  request: SandboxWriteRequest,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (policy.filesystem === 'read-only') {
    throw Object.assign(
      new Error('File writes are disabled by the read-only sandbox policy.'),
      { code: 'EROFS' },
    );
  }
  const stdin = encodeSandboxWriteRequest(request);
  const handle = await executeBwrap(
    policy,
    {
      executable: process.execPath,
      args: [sandboxAsset('file-worker')],
      cwd: policy.workspace,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdin,
    },
    () => {},
    signal,
  );
  const result = await handle.result;
  if (
    result.sandboxStatus.state !== 'confirmed' ||
    result.error ||
    result.aborted
  ) {
    throw new Error(
      `Sandbox file write failed (${result.sandboxStatus.state}): ${result.error?.message ?? result.output}`,
    );
  }
  const reply = JSON.parse(result.output.trim()) as Record<string, unknown>;
  if (reply['ok'] === false && typeof reply['error'] === 'string') {
    throw Object.assign(new Error(reply['error']), {
      ...(typeof reply['code'] === 'string' ? { code: reply['code'] } : {}),
    });
  }
  if (result.sandboxStatus.exitCode !== 0 || reply['ok'] !== true)
    throw new Error('Invalid sandbox file worker reply.');
}
