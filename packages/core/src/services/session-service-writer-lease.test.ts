/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionService } from './sessionService.js';
import {
  getSessionWriterLockPath,
  SessionWriterConflictError,
  SessionWriterUnavailableError,
} from './session-writer-lease.js';

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

async function createService(): Promise<{
  runtimeBaseDir: string;
  service: SessionService;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-session-service-lease-'),
  );
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  return {
    runtimeBaseDir,
    service: new SessionService(workspace, { runtimeBaseDir }),
  };
}

describe('SessionService.acquireSessionWriterLease', () => {
  it('uses the service runtime root and rejects a second writer', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const { runtimeBaseDir, service } = await createService();
    const lease = await service.acquireSessionWriterLease(sessionId, {
      processKind: 'daemon',
      reclaimPolicy: 'never',
    });

    await expect(
      fs.stat(getSessionWriterLockPath(runtimeBaseDir, sessionId)),
    ).resolves.toBeDefined();
    await expect(
      service.acquireSessionWriterLease(sessionId, {
        processKind: 'daemon',
        reclaimPolicy: 'never',
      }),
    ).rejects.toThrow(SessionWriterConflictError);

    await lease.release();
  });

  it('rejects an invalid id before creating the lock directory', async () => {
    const { runtimeBaseDir, service } = await createService();

    await expect(
      service.acquireSessionWriterLease('../invalid', {
        processKind: 'daemon',
        reclaimPolicy: 'never',
      }),
    ).rejects.toThrow(SessionWriterUnavailableError);
    await expect(
      fs.stat(path.dirname(getSessionWriterLockPath(runtimeBaseDir, 'valid'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
