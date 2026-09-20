/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeBwrap, sandboxAsset } from './bwrap-execution.js';
import type { BwrapPolicy } from './bwrap-execution.js';
import {
  encodeSandboxWriteRequest,
  MAX_FILE_HEADER_BYTES,
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
  let reply = '';
  let diagnostics = '';
  const appendBounded = (current: string, chunk: string) =>
    (current + chunk).slice(-MAX_FILE_HEADER_BYTES);
  const handle = await executeBwrap(
    policy,
    {
      executable: process.execPath,
      args: [sandboxAsset('file-worker')],
      cwd: policy.workspace,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdin,
    },
    (event) => {
      if (event.type !== 'data' || typeof event.chunk !== 'string') return;
      if (event.stream === 'stdout') reply = appendBounded(reply, event.chunk);
      else if (event.stream === 'stderr')
        diagnostics = appendBounded(diagnostics, event.chunk);
    },
    signal,
    false,
    {},
    { streamStdout: true },
  );
  const result = await handle.result;
  if (
    result.sandboxStatus.state !== 'confirmed' ||
    result.error ||
    result.aborted
  ) {
    const detail = [result.error?.message, diagnostics || result.output]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `Sandbox file write failed (${result.sandboxStatus.state}): ${detail}`,
    );
  }
  if (result.sandboxStatus.exitCode === 0) return;
  let parsedReply: Record<string, unknown> | undefined;
  try {
    parsedReply = JSON.parse(reply.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Sandbox file worker exited ${result.sandboxStatus.exitCode}: ${diagnostics || result.output || reply || 'invalid reply'}`,
    );
  }
  if (parsedReply['ok'] === false && typeof parsedReply['error'] === 'string') {
    throw Object.assign(new Error(parsedReply['error']), {
      ...(typeof parsedReply['code'] === 'string'
        ? { code: parsedReply['code'] }
        : {}),
    });
  }
  throw new Error('Invalid sandbox file worker reply.');
}
