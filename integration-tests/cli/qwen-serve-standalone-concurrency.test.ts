/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnDaemon, type SpawnedDaemon } from './_daemon-harness.js';

const sandboxed = Boolean(
  process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
);

describe.skipIf(process.platform === 'win32' || sandboxed)(
  'standalone sessions across daemon processes',
  () => {
    let fixtureDirectory: string;
    let sharedRuntime: string;
    const daemons: SpawnedDaemon[] = [];

    beforeAll(async () => {
      fixtureDirectory = await fs.realpath(
        await fs.mkdtemp(path.join(tmpdir(), 'qwen-standalone-concurrency-')),
      );
      sharedRuntime = path.join(fixtureDirectory, 'shared-runtime');
      await fs.mkdir(sharedRuntime, { mode: 0o700 });
      for (const name of ['workspace-a', 'workspace-b']) {
        const workspaceCwd = path.join(fixtureDirectory, name);
        await fs.mkdir(workspaceCwd, { mode: 0o700 });
        daemons.push(
          await spawnDaemon({
            workspaceCwd,
            bootTimeoutMs: 60_000,
            env: {
              // Stable Live discovery uses the OS home, independently of QWEN_HOME.
              HOME: fixtureDirectory,
              QWEN_HOME: path.join(fixtureDirectory, `config-${name}`),
              QWEN_RUNTIME_DIR: sharedRuntime,
              OPENAI_API_KEY: 'fake-key',
              OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
              OPENAI_MODEL: 'fake-model',
              QWEN_MODEL: 'fake-model',
            },
          }),
        );
      }
    }, 120_000);

    afterAll(async () => {
      await Promise.all(daemons.map((daemon) => daemon.dispose()));
      if (fixtureDirectory) {
        await fs.rm(fixtureDirectory, { recursive: true, force: true });
      }
    });

    it('shares one Conversations root while fencing the same session', async () => {
      const [first, second] = daemons;
      expect(first.daemon.pid).not.toBe(second.daemon.pid);
      const ownerPath = path.join(
        fixtureDirectory,
        '.qwen',
        'conversations',
        'runtime-owner.json',
      );
      await Promise.all(
        daemons.flatMap((daemon) =>
          ['/standalone/sessions', '/standalone/session-options'].map(
            async (route) => {
              const response = await fetch(`${daemon.base}${route}`, {
                headers: { Authorization: `Bearer ${daemon.token}` },
                signal: AbortSignal.timeout(60_000),
              });
              const body: unknown = await response.json();
              expect(response.status, JSON.stringify(body)).toBe(200);
            },
          ),
        ),
      );
      await expect(fs.lstat(ownerPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const firstSession = await first.client.createStandaloneSession();
      const secondSession = await second.client.createStandaloneSession();
      expect(secondSession.sessionId).not.toBe(firstSession.sessionId);
      await expect(
        second.client.loadStandaloneSession(firstSession.sessionId),
      ).rejects.toMatchObject({
        status: 409,
        body: { code: 'session_writer_conflict' },
      });
      await expect(
        first.client.loadStandaloneSession(secondSession.sessionId),
      ).rejects.toMatchObject({
        status: 409,
        body: { code: 'session_writer_conflict' },
      });
      await expect(fs.lstat(ownerPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);
