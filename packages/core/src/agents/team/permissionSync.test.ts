/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPermissionRequest,
  readPermissionRequest,
  resolvePermissionRequest,
  waitForPermissionResponse,
  clearPermissions,
  resetRequestIdCounter,
} from './permissionSync.js';

vi.mock('../../config/storage.js', () => {
  let mockDir = '/tmp/test';
  return {
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../../config/storage.js')) as any;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-sync-test-'));
  __setMockGlobalDir(tmpDir);
  resetRequestIdCounter();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('permissionSync', () => {
  const teamName = 'test-team';

  it('creates a permission request file', async () => {
    const id = await createPermissionRequest(
      teamName,
      'worker-1',
      'run_shell_command',
      { command: 'rm -rf /' },
    );

    expect(id).toMatch(/^perm-/);

    const req = await readPermissionRequest(teamName, id);
    expect(req).not.toBeNull();
    expect(req!.teammateName).toBe('worker-1');
    expect(req!.toolName).toBe('run_shell_command');
    expect(req!.status).toBe('pending');
    expect(req!.toolInput).toEqual({ command: 'rm -rf /' });
  });

  it('returns null for non-existent request', async () => {
    const req = await readPermissionRequest(teamName, 'nonexistent');
    expect(req).toBeNull();
  });

  it('resolves a pending request as approved', async () => {
    const id = await createPermissionRequest(teamName, 'worker-1', 'edit', {
      file: 'test.ts',
    });

    await resolvePermissionRequest(teamName, id, 'approved');

    const req = await readPermissionRequest(teamName, id);
    expect(req!.status).toBe('approved');
    expect(req!.response!.outcome).toBe('approved');
    expect(req!.response!.resolvedAt).toBeDefined();
  });

  it('resolves a pending request as denied', async () => {
    const id = await createPermissionRequest(teamName, 'worker-1', 'edit', {
      file: 'secret.ts',
    });

    await resolvePermissionRequest(teamName, id, 'denied', 'Not allowed');

    const req = await readPermissionRequest(teamName, id);
    expect(req!.status).toBe('denied');
    expect(req!.response!.reason).toBe('Not allowed');
  });

  it('no-ops when resolving already resolved request', async () => {
    const id = await createPermissionRequest(teamName, 'worker-1', 'edit', {});

    await resolvePermissionRequest(teamName, id, 'approved');
    await resolvePermissionRequest(teamName, id, 'denied');

    const req = await readPermissionRequest(teamName, id);
    expect(req!.status).toBe('approved');
  });

  it('waitForPermissionResponse resolves immediately when already resolved', async () => {
    const id = await createPermissionRequest(teamName, 'worker-1', 'edit', {});
    await resolvePermissionRequest(teamName, id, 'denied');

    const req = await waitForPermissionResponse(teamName, id, 1000, 50);
    expect(req.status).toBe('denied');
  });

  it('waitForPermissionResponse picks up async resolution', async () => {
    const id = await createPermissionRequest(teamName, 'worker-1', 'edit', {});

    // Resolve after 100ms.
    setTimeout(async () => {
      await resolvePermissionRequest(teamName, id, 'approved');
    }, 100);

    const req = await waitForPermissionResponse(teamName, id, 5000, 50);
    expect(req.status).toBe('approved');
  });

  it('waitForPermissionResponse times out', async () => {
    const id = await createPermissionRequest(teamName, 'worker-1', 'edit', {});

    await expect(
      waitForPermissionResponse(teamName, id, 200, 50),
    ).rejects.toThrow('timed out');
  });

  it('clearPermissions removes all files', async () => {
    await createPermissionRequest(teamName, 'worker-1', 'edit', {});
    await createPermissionRequest(teamName, 'worker-2', 'write_file', {});

    await clearPermissions(teamName);

    // Directory should be gone.
    const permDir = path.join(tmpDir, 'teams', teamName, 'permissions');
    await expect(fs.access(permDir)).rejects.toThrow();
  });
});
