/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { ContainerExecutionEnvironment } from './container-execution-environment.js';
import type { ExecutionWorkerRequest } from './execution-environment.js';

const runtime = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  ...runtime,
}));

describe.skipIf(process.platform === 'win32')(
  'container execution transport',
  () => {
    let root: string;
    let environment: ContainerExecutionEnvironment;
    let child: EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    let hold: string | undefined;
    let messages: Array<{ id: string; request: ExecutionWorkerRequest }>;
    let cancellations: string[];
    const signal = new AbortController().signal;
    const result = {
      llmContent: 'read completed',
      returnDisplay: 'read completed',
    };
    const reply = (id: string, value: unknown) =>
      child.stdout.write(`${JSON.stringify({ id, result: value })}\n`);

    const createEnvironment = () =>
      ContainerExecutionEnvironment.create(
        new Config({
          targetDir: join(root, 'workspace'),
          cwd: join(root, 'workspace'),
          debugMode: false,
          deferTelemetryInitialization: true,
        }),
        {
          runtime: 'docker',
          image: 'fixture',
          bundleDirectory: join(root, 'bundle'),
          trustedDirectories: [],
          runtimeEnv: {},
          environment: [],
          containerHome: '/executor-home',
        },
        signal,
      );

    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'execution-transport-')),
      );
      const workspace = join(root, 'workspace');
      const bundle = join(root, 'bundle');
      await mkdir(workspace);
      await mkdir(bundle);
      await writeFile(join(bundle, 'execution-worker.js'), '');
      hold = undefined;
      messages = [];
      cancellations = [];
      child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => child.emit('close'),
      });
      child.stdin.on('data', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if ('cancel' in message) {
          cancellations.push(message.cancel);
          return;
        }
        messages.push(message);
        if (message.request.method === hold) return;
        reply(
          message.id,
          message.request.method === 'prepare'
            ? {
                params: message.request.request.params,
                description: 'read',
                locations: [],
              }
            : message.request.method === 'execute'
              ? result
              : null,
        );
      });
      runtime.spawn.mockReturnValue(child);
      runtime.execFile.mockImplementation(
        (_runtime, _args, _options, callback) => callback(null, '{}', ''),
      );
      environment = await createEnvironment();
    });

    afterEach(async () => {
      vi.useRealTimers();
      await environment?.dispose();
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      await rm(root, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    const prepare = (id: string) =>
      environment.prepare({ id, toolName: 'read_file', params: {} }, signal);

    const prepareInstall = () =>
      environment.prepare(
        {
          id: 'install',
          toolName: 'run_shell_command',
          params: { command: 'npm install' },
        },
        signal,
      );

    const gitMask = (args: string[]): string => {
      const suffix = `:${join(root, 'workspace', '.git')}:ro`;
      const volume = args.find((arg) => arg.endsWith(suffix));
      expect(volume).toBeDefined();
      return volume!.slice(0, -suffix.length);
    };

    it('keeps an initially absent root .git masked on the primary and later install workers', async () => {
      const primaryArgs = runtime.execFile.mock.calls.find(
        (call) => call[1][0] === 'create',
      )![1];
      const mask = gitMask(primaryArgs);
      expect((await lstat(mask)).isDirectory()).toBe(true);
      const entry = join(root, 'workspace', '.git');
      await expect(lstat(entry)).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(entry);
      await writeFile(join(entry, 'config'), 'workspace metadata');
      await prepareInstall();
      const creates = runtime.execFile.mock.calls.filter(
        (call) => call[1][0] === 'create',
      );
      expect(creates).toHaveLength(2);
      expect(gitMask(creates[1][1])).toBe(mask);
      expect(creates[1][1]).not.toContain('--network');
      expect(await readFile(join(entry, 'config'), 'utf8')).toBe(
        'workspace metadata',
      );
    });

    it.each(['file', 'directory'])(
      'uses an empty read-only mask matching an existing .git %s',
      async (kind) => {
        await environment.dispose();
        const entry = join(root, 'workspace', '.git');
        if (kind === 'directory') await mkdir(entry);
        else await writeFile(entry, 'gitdir: ../metadata');
        runtime.execFile.mockClear();
        environment = await createEnvironment();
        const args = runtime.execFile.mock.calls.find(
          (call) => call[1][0] === 'create',
        )![1];
        const mask = gitMask(args);
        expect((await lstat(mask)).isDirectory()).toBe(kind === 'directory');
        if (kind === 'file') expect(await readFile(mask, 'utf8')).toBe('');
      },
    );

    it.each(['file', 'symlink'])(
      'refuses an install worker when an absent .git becomes a %s',
      async (kind) => {
        const entry = join(root, 'workspace', '.git');
        if (kind === 'file') await writeFile(entry, 'gitdir: ../metadata');
        else await symlink(join(root, 'bundle'), entry, 'dir');
        runtime.execFile.mockClear();
        runtime.spawn.mockClear();
        await expect(prepareInstall()).rejects.toThrow(
          kind === 'file' ? 'changed type' : 'symlinked .git',
        );
        expect(
          runtime.execFile.mock.calls.some((call) => call[1][0] === 'create'),
        ).toBe(false);
        expect(runtime.spawn).not.toHaveBeenCalled();
      },
    );

    it('refuses an install worker when a .git file becomes a directory', async () => {
      await environment.dispose();
      const entry = join(root, 'workspace', '.git');
      await writeFile(entry, 'gitdir: ../metadata');
      environment = await createEnvironment();
      await rm(entry);
      await mkdir(entry);
      runtime.execFile.mockClear();
      runtime.spawn.mockClear();
      await expect(prepareInstall()).rejects.toThrow('changed type');
      expect(
        runtime.execFile.mock.calls.some((call) => call[1][0] === 'create'),
      ).toBe(false);
      expect(runtime.spawn).not.toHaveBeenCalled();
    });

    it('does not create an install container after disposal during its filesystem check', async () => {
      runtime.execFile.mockClear();
      runtime.spawn.mockClear();
      const installation = prepareInstall().catch((error: unknown) => error);
      const disposal = environment.dispose();
      expect(await installation).toMatchObject({
        message: expect.stringContaining('disposed during startup'),
      });
      await disposal;
      expect(
        runtime.execFile.mock.calls.some((call) => call[1][0] === 'create'),
      ).toBe(false);
      expect(runtime.spawn).not.toHaveBeenCalled();
    });

    it.each(['type change', 'disposal'])(
      'does not attach an install worker after %s during container creation',
      async (change) => {
        let finishCreate: (() => void) | undefined;
        runtime.execFile.mockClear();
        runtime.spawn.mockClear();
        runtime.execFile.mockImplementation(
          (_runtime, args, _options, callback) => {
            if (args[0] === 'create') {
              finishCreate = () => callback(null, '', '');
            } else callback(null, '{}', '');
          },
        );
        const installation = prepareInstall().catch((error: unknown) => error);
        await vi.waitFor(() => expect(finishCreate).toBeDefined());
        let disposal: Promise<void> | undefined;
        if (change === 'type change') {
          await writeFile(
            join(root, 'workspace', '.git'),
            'gitdir: ../metadata',
          );
        } else {
          disposal = environment.dispose();
        }
        finishCreate!();
        expect(await installation).toMatchObject({
          message: expect.stringContaining(
            change === 'type change'
              ? 'changed type'
              : 'disposed during startup',
          ),
        });
        await disposal;
        expect(runtime.spawn).not.toHaveBeenCalled();
        const created = runtime.execFile.mock.calls.find(
          (call) => call[1][0] === 'create',
        )![1];
        expect(
          runtime.execFile.mock.calls.map((call) => call[1]),
        ).toContainEqual(['rm', '-f', created[created.indexOf('--name') + 1]]);
      },
    );

    it('rejects server errors from a successful info command before creating a container', async () => {
      await environment.dispose();
      runtime.execFile.mockClear();
      runtime.spawn.mockClear();
      runtime.execFile.mockImplementation(
        (_runtime, args, _options, callback) => {
          if (args[0] === 'info') {
            callback(
              null,
              JSON.stringify({
                ServerErrors: ['daemon unavailable', 'connection refused'],
              }),
              '',
            );
          } else {
            callback(
              args[0] === 'create' ? new Error('unexpected create') : null,
              '',
              '',
            );
          }
        },
      );
      await expect(createEnvironment()).rejects.toThrow(
        'docker info failed: daemon unavailable; connection refused',
      );
      expect(runtime.execFile.mock.calls.map((call) => call[1][0])).toEqual([
        'info',
      ]);
      expect(runtime.spawn).not.toHaveBeenCalled();
    });

    it.each([undefined, null, []])(
      'still attempts cleanup after an ambiguous create failure when ServerErrors is %j',
      async (serverErrors) => {
        await environment.dispose();
        runtime.execFile.mockClear();
        runtime.spawn.mockClear();
        runtime.execFile.mockImplementation(
          (_runtime, args, _options, callback) => {
            callback(
              args[0] === 'create' ? new Error('create response lost') : null,
              args[0] === 'info'
                ? JSON.stringify({ ServerErrors: serverErrors })
                : '',
              '',
            );
          },
        );
        await expect(createEnvironment()).rejects.toThrow(
          'create response lost',
        );
        expect(runtime.execFile.mock.calls.map((call) => call[1][0])).toEqual([
          'info',
          'create',
          'rm',
        ]);
        expect(runtime.spawn).not.toHaveBeenCalled();
      },
    );

    it('cancels only the interrupted request and ignores its late reply without replay', async () => {
      await prepare('a');
      await prepare('b');
      hold = 'execute';
      const controller = new AbortController();
      const a = environment
        .execute('a', controller.signal)
        .catch((error: unknown) => error);
      const b = environment
        .execute('b', signal)
        .catch((error: unknown) => error);
      const [requestA, requestB] = messages.filter(
        (message) => message.request.method === 'execute',
      );
      controller.abort();
      expect(await a).toMatchObject({
        message: expect.stringMatching(
          /cancelled.*write may have completed.*[Nn]o operation was replayed/,
        ),
      });
      expect(cancellations).toEqual([requestA.id]);
      reply(requestA.id, { llmContent: 'late abandoned result' });
      reply(requestB.id, result);
      expect(await b).toEqual(result);
      hold = undefined;
      await prepare('c');
      await expect(environment.execute('c', signal)).resolves.toEqual(result);
      expect(
        messages.filter((message) => message.request.method === 'execute'),
      ).toHaveLength(3);
    });

    it('recovers after a housekeeping timeout and retries synchronization without replaying tools', async () => {
      // AbortSignal.timeout uses native timers, so replace only that clock.
      const controller = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(controller.signal);
      hold = 'invalidateReadCache';
      const invalidation = environment
        .invalidateReadCache()
        .catch((error: unknown) => error);
      controller.abort();
      timeout.mockRestore();
      expect(await invalidation).toMatchObject({
        message: expect.stringMatching(/cancel/i),
      });
      expect(cancellations).toHaveLength(1);
      hold = undefined;
      await expect(environment.invalidateReadCache()).resolves.toBeUndefined();
      await prepare('next');
      await expect(environment.execute('next', signal)).resolves.toEqual(
        result,
      );
      expect(
        messages.filter((message) => message.request.method === 'execute'),
      ).toHaveLength(1);
    });

    it('still fails every pending and future request on a broken transport', async () => {
      await prepare('a');
      await prepare('b');
      hold = 'execute';
      const a = environment
        .execute('a', signal)
        .catch((error: unknown) => error);
      const b = environment
        .execute('b', signal)
        .catch((error: unknown) => error);
      child.stdin.emit('error', new Error('broken pipe'));
      for (const execution of [a, b]) {
        expect(await execution).toMatchObject({
          message: expect.stringContaining('broken pipe'),
        });
      }
      await expect(prepare('c')).rejects.toThrow('broken pipe');
      expect(cancellations).toEqual([]);
      expect(
        messages.filter((message) => message.request.method === 'execute'),
      ).toHaveLength(2);
    });

    it('reports the exact container and temporary directory before slow disposal completes', async () => {
      vi.useFakeTimers();
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      let finishRemoval!: () => void;
      runtime.execFile.mockImplementation(
        (_runtime, _args, _options, callback) => {
          finishRemoval = () => callback(null, '', '');
        },
      );
      const temporaryDirectory = environment.outputDirectory.replace(
        /\/output$/,
        '',
      );
      const create = runtime.execFile.mock.calls.find(
        (call) => call[1][0] === 'create',
      )!;
      const name = create[1][create[1].indexOf('--name') + 1];
      let completed = false;
      const disposal = environment.dispose().then(() => {
        completed = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(500);
        expect(completed).toBe(false);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(name));
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(temporaryDirectory),
        );
        finishRemoval();
        await disposal;
        expect(completed).toBe(true);
        await expect(
          import('node:fs/promises').then(({ access }) =>
            access(temporaryDirectory),
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        finishRemoval?.();
        warning.mockRestore();
        vi.useRealTimers();
      }
    });
  },
);
