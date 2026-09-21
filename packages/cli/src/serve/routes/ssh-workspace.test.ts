/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshWorkspaceError } from '@qwen-code/qwen-code-core/services/ssh-workspace.js';
import type { SshWorkspace } from '@qwen-code/qwen-code-core/services/ssh-workspace.js';
import { SSH_WORKSPACE_SCRIPT } from '@qwen-code/qwen-code-core/services/ssh-workspace-script.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerSshWorkspaceBoundary } from './ssh-workspace.js';

const ssh = vi.hoisted(() => ({
  execute: vi.fn(),
  request: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));
vi.mock(
  '@qwen-code/qwen-code-core/services/ssh-workspace.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/services/ssh-workspace.js')
      >();
    return {
      ...actual,
      SshWorkspaceClient: class {
        constructor(workspace: SshWorkspace) {
          ssh.create(workspace);
        }
        execute = ssh.execute;
        request = ssh.request;
        dispose = ssh.dispose;
      },
    };
  },
);

describe.skipIf(process.platform === 'win32')(
  'SSH workspace boundary and Git inspection',
  () => {
    let directory: string;
    let remote: string;
    let primary: WorkspaceRuntime;
    let runtime: WorkspaceRuntime;
    let registry: ReturnType<typeof createWorkspaceRegistry>;
    let app: ReturnType<typeof express>;
    const executeFile = promisify(execFile);
    beforeEach(() => {
      directory = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-ssh-routes-')));
      remote = join(directory, 'remote');
      const anchor = join(directory, 'anchor');
      const local = join(directory, 'local');
      for (const dir of [remote, anchor, local]) mkdirSync(dir);
      primary = {
        workspaceId: 'primary',
        workspaceCwd: local,
        primary: true,
        trusted: true,
        routeFileSystemFactory: {},
      } as WorkspaceRuntime;
      runtime = {
        workspaceId: 'ssh-workspace',
        workspaceCwd: anchor,
        primary: false,
        trusted: true,
        generationGuard: createWorkspaceGenerationGuard(),
        routeFileSystemFactory: {
          sshWorkspace: { host: 'fixture-host', directory: remote },
        },
      } as WorkspaceRuntime;
      registry = createWorkspaceRegistry([primary, runtime]);
      app = express();
      registerSshWorkspaceBoundary(app, registry);
      app.get('/workspaces/registrations', (_req, res) =>
        res.json({ registrations: [] }),
      );
      app.use((_req, res) => res.status(599).json({ localRouteReached: true }));
      ssh.execute.mockImplementation(async (command: string) => {
        try {
          const result = await executeFile('/bin/sh', ['-c', command], {
            cwd: remote,
            maxBuffer: 32 * 1024 * 1024,
          });
          return { ...result, exitCode: 0 };
        } catch (error) {
          const failure = error as Error & {
            code: number;
            stdout: string;
            stderr: string;
          };
          return {
            stdout: failure.stdout,
            stderr: failure.stderr,
            exitCode: failure.code,
          };
        }
      });
      ssh.request.mockImplementation(
        (operation: string, params: Record<string, unknown>) =>
          new Promise((resolve, reject) => {
            const child = spawn('python3', ['-c', SSH_WORKSPACE_SCRIPT]);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.on('error', reject);
            child.on('close', (code) => {
              if (code !== 0) {
                reject(new Error(stderr));
                return;
              }
              const reply = JSON.parse(stdout) as {
                ok: boolean;
                result: unknown;
                error?: { code: string; message: string };
              };
              if (reply.ok) resolve(reply.result);
              else
                reject(
                  new SshWorkspaceError(
                    reply.error!.code,
                    reply.error!.message,
                  ),
                );
            });
            child.stdin.end(
              JSON.stringify({ root: remote, operation, params }),
            );
          }),
      );
    });
    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    function git(...args: string[]) {
      return execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-C', remote, ...args],
        { encoding: 'utf8' },
      );
    }
    function init(commit = true) {
      git('init', '-q');
      git('config', 'user.name', 'SSH Test');
      git('config', 'user.email', 'ssh-test@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      if (commit) {
        writeFileSync(join(remote, 'tracked.txt'), 'before\n');
        git('add', '.');
        git('commit', '-qm', 'initial');
      }
    }
    const url = (suffix: string) => `/workspaces/ssh-workspace${suffix}`;

    it('returns the local API non-repository shapes without reaching a local Git route', async () => {
      const status = await supertest(app).get(url('/git'));
      expect(status.status).toBe(200);
      expect(status.body).toEqual({
        v: 2,
        workspaceCwd: runtime.workspaceCwd,
        branch: null,
      });
      const diff = await supertest(app).get(url('/git/diff'));
      expect(diff.status).toBe(200);
      expect(diff.body).toMatchObject({
        available: false,
        filesCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        files: [],
        hiddenCount: 0,
      });
      expect(diff.headers['cache-control']).toBe('no-store');
      expect(ssh.create).toHaveBeenCalledWith({
        host: 'fixture-host',
        directory: remote,
      });
    });

    it('counts staged, unstaged and untracked remote entries', async () => {
      init();
      writeFileSync(join(remote, 'tracked.txt'), 'after\n');
      writeFileSync(join(remote, 'staged.txt'), 'staged\n');
      git('add', 'staged.txt');
      writeFileSync(join(remote, 'untracked.txt'), 'untracked\n');
      const response = await supertest(app).get(url('/git'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        v: 2,
        staged: 1,
        unstaged: 1,
        untracked: 1,
        conflicted: 0,
        stashCount: 0,
      });
      expect(ssh.dispose).toHaveBeenCalledOnce();
    });

    it('counts actual remote stashes', async () => {
      init();
      writeFileSync(join(remote, 'tracked.txt'), 'stash change');
      git('add', '.');
      git('stash', 'push', '-m', 'test stash');
      const response = await supertest(app).get(url('/git'));
      expect(response.status).toBe(200);
      expect(response.body.stashCount).toBe(1);
    });

    it('rejects a bare repository with the declared working-tree error', async () => {
      git('init', '--bare', '-q');
      const response = await supertest(app).get(url('/git'));
      expect(response.status).toBe(501);
      expect(response.body.error).toContain('requires a working tree');
    });

    it('stops after an in-flight Git result when its runtime generation closes', async () => {
      ssh.execute.mockImplementationOnce(async () => {
        runtime.generationGuard!.close();
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      });
      const response = await supertest(app).get(url('/git'));
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('workspace_runtime_unavailable');
      expect(ssh.execute).toHaveBeenCalledOnce();
      expect(ssh.dispose).toHaveBeenCalledOnce();
    });

    it('treats hostile file names literally and clears inherited Git selectors', async () => {
      init();
      const name = "file ' ; $(touch injected).txt";
      writeFileSync(join(remote, name), 'before\n');
      git('add', '--', name);
      git('commit', '-qm', 'quoted file');
      writeFileSync(join(remote, name), 'after\n');
      vi.stubEnv('GIT_DIR', join(directory, 'wrong-repository'));
      const response = await supertest(app)
        .get(url('/git/diff/file'))
        .query({ path: name });
      expect(response.status).toBe(200);
      expect(response.body.hunks[0].lines).toContain('+after');
      const status = await supertest(app).get(url('/git'));
      expect(status.body.untracked).toBe(0);
    });

    it('cancels an active remote Git request when the HTTP client disconnects', async () => {
      let started!: () => void;
      let cancelled!: () => void;
      const start = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cancel = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      ssh.execute.mockImplementationOnce(
        (_command, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => {
                cancelled();
                reject(
                  new SshWorkspaceError('cancelled', 'client disconnected'),
                );
              },
              { once: true },
            );
            started();
          }),
      );
      const server = app.listen(0, '127.0.0.1');
      const abort = new AbortController();
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('No HTTP address');
        const response = fetch(
          `http://127.0.0.1:${address.port}${url('/git')}`,
          { signal: abort.signal },
        ).catch((error: unknown) => error);
        await start;
        abort.abort();
        await response;
        await cancel;
        expect(ssh.execute).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(ssh.dispose).toHaveBeenCalledOnce());
      } finally {
        abort.abort();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns counts without details above the 500-file threshold', async () => {
      init();
      for (let index = 0; index < 501; index++)
        writeFileSync(join(remote, `file-${index}.txt`), 'line\n');
      const response = await supertest(app).get(url('/git/diff'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        available: true,
        filesCount: 501,
        files: [],
        hiddenCount: 501,
      });
      expect(ssh.request).not.toHaveBeenCalled();
    });

    it('keeps SSH workspace metadata, rename and removal on their owning routes', async () => {
      expect((await supertest(app).get(url(''))).status).toBe(599);
      expect((await supertest(app).patch(url(''))).status).toBe(599);
      expect((await supertest(app).delete(url(''))).status).toBe(599);
      expect(ssh.execute).not.toHaveBeenCalled();
    });

    it('counts all untracked lines while limiting rendered rows to 50', async () => {
      init();
      for (let index = 0; index < 60; index++)
        writeFileSync(join(remote, `file-${index}.txt`), 'one\ntwo\n');
      const response = await supertest(app).get(url('/git/diff'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        available: true,
        filesCount: 60,
        linesAdded: 120,
        linesRemoved: 0,
        hiddenCount: 10,
      });
      expect(response.body.files).toHaveLength(50);
      expect(ssh.request).toHaveBeenCalledOnce();
      expect(ssh.request).toHaveBeenCalledWith(
        'gitUntrackedStats',
        expect.objectContaining({ paths: expect.any(Array) }),
        expect.any(AbortSignal),
      );
    });

    it('handles binary files and symbolic links without following the link or failing the overview', async () => {
      init();
      writeFileSync(join(remote, 'binary'), Buffer.from([0, 1, 2]));
      symlinkSync(join(directory, 'outside-secret'), join(remote, 'link'));
      writeFileSync(
        join(directory, 'outside-secret'),
        'outside-secret-content',
      );
      const response = await supertest(app).get(url('/git/diff'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ filesCount: 2, linesAdded: 0 });
      expect(response.body.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'binary',
            isBinary: true,
            isUntracked: true,
          }),
          expect.objectContaining({
            path: 'link',
            isBinary: true,
            isUntracked: true,
          }),
        ]),
      );
      const file = await supertest(app)
        .get(url('/git/diff/file'))
        .query({ path: 'link' });
      expect(file.status).toBe(200);
      expect(file.body).toMatchObject({ available: false, hunks: [] });
      expect(JSON.stringify(response.body)).not.toContain(
        'outside-secret-content',
      );
    });

    it('marks large untracked previews as truncated without reading the whole file', async () => {
      init();
      writeFileSync(
        join(remote, 'large.txt'),
        'line\n'.repeat(450) + 'x'.repeat(17 * 1024 * 1024),
      );
      const overview = await supertest(app).get(url('/git/diff'));
      expect(overview.status).toBe(200);
      expect(overview.body.files[0]).toMatchObject({
        path: 'large.txt',
        isBinary: false,
        truncated: true,
      });
      const file = await supertest(app)
        .get(url('/git/diff/file'))
        .query({ path: 'large.txt' });
      expect(file.status).toBe(200);
      expect(file.body.truncated).toBe(true);
      expect(file.body.hunks[0].lines).toHaveLength(400);
    });

    it('includes staged and working changes on an unborn branch', async () => {
      init(false);
      writeFileSync(join(remote, 'new.txt'), 'staged\n');
      git('add', 'new.txt');
      writeFileSync(join(remote, 'new.txt'), 'working\nsecond\n');
      const response = await supertest(app).get(url('/git/diff'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        filesCount: 1,
        linesAdded: 2,
        linesRemoved: 0,
      });
      const file = await supertest(app)
        .get(url('/git/diff/file'))
        .query({ path: 'new.txt' });
      expect(file.status).toBe(200);
      expect(file.body.hunks[0].lines).toEqual(['+working', '+second']);
    });

    it('marks deletions and preserves rename hunks with a literal old path', async () => {
      init();
      writeFileSync(join(remote, 'rename-old.txt'), 'one\ntwo\nthree\nfour\n');
      git('add', '.');
      git('commit', '-qm', 'add rename source');
      git('rm', 'tracked.txt');
      git('mv', 'rename-old.txt', 'rename-new.txt');
      writeFileSync(
        join(remote, 'rename-new.txt'),
        'one\ntwo\nthree\nfour\nfive\n',
      );
      const response = await supertest(app).get(url('/git/diff'));
      expect(response.status).toBe(200);
      expect(response.body.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'tracked.txt', isDeleted: true }),
        ]),
      );
      const file = await supertest(app)
        .get(url('/git/diff/file'))
        .query({ path: 'rename-new.txt', oldPath: 'rename-old.txt' });
      expect(file.status).toBe(200);
      expect(file.body.hunks[0].lines).toContain('+five');
      expect(file.body.hunks[0].lines).toContain(' two');
    });

    it('reports transient operations and hides diffs while a merge is in progress', async () => {
      init();
      writeFileSync(join(remote, '.git/MERGE_HEAD'), git('rev-parse', 'HEAD'));
      const status = await supertest(app).get(url('/git'));
      expect(status.status).toBe(200);
      expect(status.body.operation).toBe('merge');
      const diff = await supertest(app).get(url('/git/diff'));
      expect(diff.status).toBe(200);
      expect(diff.body.available).toBe(false);
    });

    it('rejects unsupported operations through canonical and symlink workspace selectors', async () => {
      const alias = join(directory, 'alias');
      symlinkSync(runtime.workspaceCwd, alias);
      for (const selector of [
        'ssh-workspace',
        `${runtime.workspaceCwd}/.`,
        alias,
      ]) {
        const response = await supertest(app).post(
          `/workspaces/${encodeURIComponent(selector)}/git/push`,
        );
        expect(response.status).toBe(501);
        expect(response.body.code).toBe('ssh_workspace_operation_unsupported');
      }
      expect(ssh.execute).not.toHaveBeenCalled();
    });

    it('passes local workspaces and process-global registration routes through', async () => {
      expect(
        (await supertest(app).post('/workspaces/primary/git/push')).status,
      ).toBe(599);
      expect(
        (await supertest(app).get('/workspaces/registrations')).status,
      ).toBe(200);
      expect(
        (
          await supertest(app).post(
            `/workspaces/${encodeURIComponent(join(directory, 'cold-local-workspace'))}/sessions`,
          )
        ).status,
      ).toBe(599);
      expect(ssh.execute).not.toHaveBeenCalled();
    });

    it('preserves local session storage and runtime controls while rejecting project services', async () => {
      for (const suffix of [
        '/sessions',
        '/file',
        '/file/bytes',
        '/stat',
        '/list',
        '/glob',
        '/voice',
        '/sessions/search',
        '/sessions/live-state',
        '/session-info',
        '/session-groups',
        '/session/id/export',
        '/session/id/archive/export',
        '/session/id/transcript',
        '/session/id/turn-index',
        '/trust',
        '/permissions',
        '/runtime/status',
        '/providers',
        '/tools',
      ]) {
        expect((await supertest(app).get(url(suffix))).status).toBe(599);
      }
      for (const suffix of [
        '/acp',
        '/voice',
        '/voice/transcribe',
        '/trust/request',
        '/permissions',
        '/runtime/ensure',
        '/runtime/stop',
        '/sessions/archive',
        '/sessions/unarchive',
        '/sessions/delete',
        '/session-groups',
      ]) {
        expect((await supertest(app).post(url(suffix))).status).toBe(599);
      }
      for (const suffix of [
        '/session/id/metadata',
        '/session/id/organization',
        '/session-groups/group',
      ]) {
        expect((await supertest(app).patch(url(suffix))).status).toBe(599);
      }
      expect(
        (await supertest(app).delete(url('/session-groups/group'))).status,
      ).toBe(599);
      for (const suffix of [
        '/runtime/mcp',
        '/skills',
        '/extensions',
        '/local-open',
        '/permissions/new-unsafe-operation',
        '/sessions/new-unsafe-operation',
      ]) {
        expect((await supertest(app).get(url(suffix))).status).toBe(501);
      }
      registry.beginDrain(runtime);
      expect((await supertest(app).post(url('/trust/request'))).status).toBe(
        599,
      );
      expect(ssh.execute).not.toHaveBeenCalled();
    });

    it('fails closed for untrusted, draining and closed-generation SSH runtimes', async () => {
      const mutable = runtime as { trusted: boolean };
      mutable.trusted = false;
      expect((await supertest(app).get(url('/git'))).status).toBe(403);
      mutable.trusted = true;
      registry.beginDrain(runtime);
      expect((await supertest(app).get(url('/git'))).body.code).toBe(
        'workspace_runtime_unavailable',
      );
      registry.cancelDrain(runtime);
      runtime.generationGuard!.close();
      expect((await supertest(app).get(url('/git'))).body.code).toBe(
        'workspace_runtime_unavailable',
      );
      expect(ssh.execute).not.toHaveBeenCalled();
    });

    it('rejects invalid file paths and workspace overrides before starting SSH', async () => {
      for (const file of ['../outside', '/etc/passwd', 'C:/outside']) {
        expect(
          (
            await supertest(app)
              .get(url('/git/diff/file'))
              .query({ path: file })
          ).status,
        ).toBe(400);
      }
      expect(
        (await supertest(app).get(url('/git')).query({ cwd: remote })).status,
      ).toBe(501);
      expect(ssh.execute).not.toHaveBeenCalled();
    });

    it('returns connection failures without reaching local Git or retrying', async () => {
      ssh.execute.mockRejectedValueOnce(
        new SshWorkspaceError('ssh_failed', 'connection lost'),
      );
      const response = await supertest(app).get(url('/git'));
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: 'ssh_workspace_unavailable',
        error: 'connection lost',
      });
      expect(ssh.execute).toHaveBeenCalledOnce();
      expect(ssh.dispose).toHaveBeenCalledOnce();
    });
  },
);
