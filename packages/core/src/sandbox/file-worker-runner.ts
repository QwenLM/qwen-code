/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { assertSandboxFileVersion } from './file-version.js';
import { readSandboxWriteRequest } from './file-worker-protocol.js';

export async function runFileWorker(
  input: AsyncIterable<Uint8Array>,
  writeReply: (reply: string) => void,
): Promise<number> {
  try {
    const request = await readSandboxWriteRequest(input);
    const assertCanCommit = () =>
      assertSandboxFileVersion(request.destination, request.expected);
    assertCanCommit();
    await mkdir(path.dirname(request.destination), { recursive: true });
    await atomicWriteFile(request.destination, request.content, {
      assertCanCommit,
    });
    writeReply(JSON.stringify({ ok: true }) + '\n');
    return 0;
  } catch (error) {
    writeReply(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: (error as NodeJS.ErrnoException)?.code,
      }) + '\n',
    );
    return 1;
  }
}
