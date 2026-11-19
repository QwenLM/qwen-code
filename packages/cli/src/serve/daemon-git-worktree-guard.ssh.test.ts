/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalToolGuardPrepareRequest } from '@qwen-code/acp-bridge/bridgeOptions';
import { createDaemonToolGuard } from './daemon-git-worktree-guard.js';

describe('daemon tool guard for SSH workspaces', () => {
  let root: string;
  let anchor: string;
  const remote = '/srv/project';
  const url = `ssh://dev-host${remote}`;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ssh-guard-')));
    vi.stubEnv('QWEN_HOME', root);
    anchor = path.join(
      root,
      'ssh-workspaces',
      createHash('sha256').update(url).digest('hex'),
      'workspace',
    );
    await mkdir(anchor, { recursive: true });
    await writeFile(
      path.join(anchor, '..', 'connection.json'),
      JSON.stringify({ url }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function request(cwd = anchor): ExternalToolGuardPrepareRequest {
    return {
      sessionId: 'ssh-session',
      promptId: 'prompt',
      toolCallId: 'shell',
      toolName: 'run_shell_command',
      arguments: { command: 'pwd', directory: remote },
      effectiveCwd: cwd,
    } as ExternalToolGuardPrepareRequest;
  }

  it('accepts remote command directories only for a verified SSH session anchor', async () => {
    const guard = createDaemonToolGuard();

    await expect(guard(request())).resolves.toEqual({ allowed: true });
    const local = path.join(root, 'local-workspace');
    await mkdir(local);
    await expect(guard(request(local))).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('outside the session working directory'),
    });
  });

  it('preserves required external guard decisions for remote shell calls', async () => {
    const denial = { allowed: false, reason: 'external policy denied' };
    const externalGuard = vi.fn().mockResolvedValue(denial);
    const guard = createDaemonToolGuard(externalGuard);
    const call = request();

    await expect(guard(call)).resolves.toEqual(denial);
    expect(externalGuard).toHaveBeenCalledWith(call);
  });

  it('fails closed when the SSH descriptor does not match the trusted anchor', async () => {
    await writeFile(
      path.join(anchor, '..', 'connection.json'),
      JSON.stringify({ url: 'ssh://other-host/srv/project' }),
    );
    await expect(createDaemonToolGuard()(request())).rejects.toThrow(
      'identity does not match',
    );
  });
});
