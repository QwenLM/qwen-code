/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  FatalSandboxError,
  PRIVATE_ACP_CAPABILITY_ENV,
  QWEN_DIR,
} from '@qwen-code/qwen-code-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: {
      ...actual,
      execSync: execSyncMock,
      spawn: spawnMock,
    },
    execSync: execSyncMock,
    spawn: spawnMock,
  };
});

import { isContainerPathWithinWorkdir } from '../utils/sandbox-path.js';
import {
  BUILTIN_SEATBELT_PROFILES,
  getSandboxPassthroughEnvArgs,
  resolveSeatbeltProfileFile,
  start_sandbox,
} from './sandbox.js';
import { parseSandboxImageName } from '../utils/sandboxImageName.js';
import { parseSandboxMountSpec } from '../utils/sandboxMounts.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('start_sandbox', () => {
  it('passes child environment variables into a container sandbox', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('QWEN_CODE_WARNINGS_FILE', '/tmp/qwen-code-warnings-test.txt');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
      String(filePath),
    );
    execSyncMock.mockReturnValue(Buffer.from(''));

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const capability = 'private-capability';
    const result = start_sandbox(
      { command: 'docker', image: 'example.com/qwen-code:latest' },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js', '--acp'],
      { [PRIVATE_ACP_CAPABILITY_ENV]: capability },
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    const options = spawnMock.mock.calls[1]?.[2];
    expect(args[args.indexOf('--hostname') + 1]).toBe(
      args[args.indexOf('--name') + 1],
    );
    const envFlagIndex = args.indexOf(PRIVATE_ACP_CAPABILITY_ENV);
    expect(args.slice(envFlagIndex - 1, envFlagIndex + 1)).toEqual([
      '--env',
      PRIVATE_ACP_CAPABILITY_ENV,
    ]);
    const warningsFlagIndex = args.indexOf(
      'QWEN_CODE_WARNINGS_FILE=/tmp/qwen-code-warnings-test.txt',
    );
    expect(args.slice(warningsFlagIndex - 1, warningsFlagIndex + 1)).toEqual([
      '--env',
      'QWEN_CODE_WARNINGS_FILE=/tmp/qwen-code-warnings-test.txt',
    ]);
    expect(options).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          [PRIVATE_ACP_CAPABILITY_ENV]: capability,
        }),
      }),
    );

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  // Container cases below share one two-spawn dance: the first spawn is the
  // `docker image inspect` probe, the second is the sandbox itself. Stub the
  // ambient debug knobs too — inheriting a developer's DEBUG_PORT or
  // SANDBOX_PORTS would make these assertions environment-dependent.
  async function runContainerSandbox(
    env: Record<string, string>,
  ): Promise<string[]> {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('DEBUG_PORT', '');
    vi.stubEnv('SANDBOX_PORTS', '');
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
      String(filePath),
    );
    execSyncMock.mockReturnValue(Buffer.from(''));

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox(
      { command: 'docker', image: 'example.com/qwen-code:latest' },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js'],
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
    return args;
  }

  it('does not enable the debugger when DEBUG is the string "false"', async () => {
    // Regression: `DEBUG=false` used to be truthy, so the sandbox started
    // `node --inspect-brk` and waited for a debugger that never attached.
    const args = await runContainerSandbox({ DEBUG: 'false', DEBUG_MODE: '' });
    expect(args.some((arg) => arg.includes('--inspect-brk'))).toBe(false);
    expect(args).not.toContain('9229:9229');
  });

  it('enables the debugger and the 9229 publish when DEBUG=1', async () => {
    const args = await runContainerSandbox({ DEBUG: '1', DEBUG_MODE: '' });
    expect(args.some((arg) => arg.includes('--inspect-brk=0.0.0.0:9229'))).toBe(
      true,
    );
    expect(args).toContain('9229:9229');
  });

  it('keeps DEBUG_MODE from pausing the sandbox at a breakpoint', async () => {
    const args = await runContainerSandbox({ DEBUG: '', DEBUG_MODE: '1' });
    expect(args.some((arg) => arg.includes('--inspect-brk'))).toBe(false);
    expect(args).not.toContain('9229:9229');
  });

  it('parses DEBUG case-insensitively like the sibling sandbox flags', async () => {
    const args = await runContainerSandbox({ DEBUG: ' TRUE ', DEBUG_MODE: '' });
    expect(args.some((arg) => arg.includes('--inspect-brk=0.0.0.0:9229'))).toBe(
      true,
    );
  });

  it('starts the development entrypoint without a breakpoint when DEBUG=false', async () => {
    const args = await runContainerSandbox({
      DEBUG: 'false',
      DEBUG_MODE: '',
      NODE_ENV: 'development',
    });
    const entrypoint = args.at(-1) ?? '';
    expect(entrypoint).toContain('npm rebuild && npm run start --');
    expect(entrypoint).not.toContain('npm run debug --');
  });

  it('lets the runtime choose a hostname for image-ID containers', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv('QWEN_CODE_WARNINGS_FILE', '');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
      String(filePath),
    );
    execSyncMock.mockReturnValue(Buffer.from(''));

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox(
      { command: 'docker', image: `sha256:${'a'.repeat(64)}` },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js', '--acp'],
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    const containerName = args[args.indexOf('--name') + 1];
    expect(containerName.length).toBeGreaterThan(64);
    expect(args).not.toContain('--hostname');

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  it.each([
    'QWEN_CODE_WARNINGS_FILE',
    'QWEN_CODE_MCP_APPROVALS_PATH',
    'QWEN_CODE_HOOK_APPROVALS_PATH',
    'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  ])(
    'omits %s from the container environment when it is unset',
    async (name) => {
      vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
      vi.stubEnv(name, '');
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
        String(filePath),
      );
      execSyncMock.mockReturnValue(Buffer.from(''));

      const imageCheck = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
      });
      const child = new EventEmitter();
      spawnMock
        .mockImplementationOnce(() => {
          queueMicrotask(() => {
            imageCheck.stdout.emit('data', Buffer.from('image-id'));
            imageCheck.emit('close', 0);
          });
          return imageCheck;
        })
        .mockReturnValueOnce(child);

      const result = start_sandbox(
        { command: 'docker', image: 'example.com/qwen-code:latest' },
        [],
        undefined,
        [process.execPath, '/path/to/cli.js'],
      );

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      const args = spawnMock.mock.calls[1]?.[1] as string[];
      expect(args.filter((arg) => arg.startsWith(`${name}=`))).toEqual([]);

      child.emit('close', 0);
      await expect(result).resolves.toBe(0);
    },
  );

  it.each([
    'QWEN_CODE_WARNINGS_FILE',
    'QWEN_CODE_MCP_APPROVALS_PATH',
    'QWEN_CODE_HOOK_APPROVALS_PATH',
    'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  ])('translates %s before forwarding it on Windows', async (name) => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.stubEnv(name, 'C:\\Users\\test\\Temp\\qwen-code-test.txt');
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
      String(filePath),
    );
    execSyncMock.mockReturnValue(Buffer.from(''));

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('image-id'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox(
      { command: 'docker', image: 'example.com/qwen-code:latest' },
      [],
      undefined,
      [process.execPath, '/path/to/cli.js'],
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    const args = spawnMock.mock.calls[1]?.[1] as string[];
    const flag = `${name}=/c/Users/test/Temp/qwen-code-test.txt`;
    const flagIndex = args.indexOf(flag);
    expect(args.slice(flagIndex - 1, flagIndex + 1)).toEqual(['--env', flag]);

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });

  it.each([
    {
      store: path.join(process.cwd(), '.qwen', 'trustedFolders.json'),
      exists: true,
    },
    { store: '/opt/qwen-external-trust/trustedFolders.json', exists: true },
    // A store the host has not created yet must still reach the container:
    // its fallback under QWEN_HOME cannot hold the decision (#16397).
    { store: '/opt/qwen-external-trust/trustedFolders.json', exists: false },
  ])(
    'forwards a custom trust store without mounting the store file ($store, exists: $exists)',
    async ({ store, exists }) => {
      const image = 'example.com/qwen-code:latest';
      vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      vi.spyOn(fs, 'existsSync').mockImplementation(
        (filePath) => filePath !== store || exists,
      );
      vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
        String(filePath),
      );
      execSyncMock.mockReturnValue(Buffer.from(''));

      const launch = async () => {
        spawnMock.mockReset();
        const imageCheck = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
        });
        const child = new EventEmitter();
        spawnMock
          .mockImplementationOnce(() => {
            queueMicrotask(() => {
              imageCheck.stdout.emit('data', Buffer.from('image-id'));
              imageCheck.emit('close', 0);
            });
            return imageCheck;
          })
          .mockReturnValueOnce(child);

        const result = start_sandbox(
          { command: 'docker', image },
          [],
          undefined,
          [process.execPath, '/path/to/cli.js'],
        );

        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
        const args = spawnMock.mock.calls[1]?.[1] as string[];
        child.emit('close', 0);
        await expect(result).resolves.toBe(0);

        // The container name is random per launch and also reaches --hostname
        // and the SANDBOX env var.
        const containerName = args[args.indexOf('--name') + 1];
        return args.map((arg) => arg.split(containerName).join('<container>'));
      };

      vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', '');
      const withoutOverride = await launch();
      vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', store);
      const args = await launch();

      expect(withoutOverride).toContain('--volume');
      const envFlag = `QWEN_CODE_TRUSTED_FOLDERS_PATH=${store}`;
      expect(
        args.filter((arg) => arg.startsWith('QWEN_CODE_TRUSTED_FOLDERS_PATH=')),
      ).toEqual([envFlag]);
      const envIndex = args.indexOf(envFlag);
      expect(args.slice(envIndex - 1, envIndex + 1)).toEqual([
        '--env',
        envFlag,
      ]);
      // Past the image the pair is a container command argument, not an env.
      expect(envIndex).toBeLessThan(args.indexOf(image));
      // The override may add that one pair and nothing else. Mounting the
      // store — as a file or as a directory above it, on either side of the
      // spec, under any flag spelling — makes it a mount point, and the
      // temp-sibling rename in atomicWriteFileSync then fails with EBUSY, so
      // a trust answer given inside the sandbox is discarded.
      expect([
        ...args.slice(0, envIndex - 1),
        ...args.slice(envIndex + 1),
      ]).toEqual(withoutOverride);
    },
  );

  it('checks image presence with an offline inspect that sees digest references', async () => {
    vi.stubEnv('SANDBOX_SET_UID_GID', 'false');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'realpathSync').mockImplementation((filePath) =>
      String(filePath),
    );
    execSyncMock.mockReturnValue(Buffer.from(''));

    const digestImage =
      'ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    const imageCheck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });
    const child = new EventEmitter();
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          imageCheck.stdout.emit('data', Buffer.from('sha256:local'));
          imageCheck.emit('close', 0);
        });
        return imageCheck;
      })
      .mockReturnValueOnce(child);

    const result = start_sandbox({ command: 'docker', image: digestImage }, []);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    // Digest references never appear in a `docker images -q <image>` listing
    // even when the content is local, which forced a needless network pull
    // (and a FatalSandboxError whenever the registry was unreachable) at
    // every consumer startup; the presence check must be the offline
    // `image inspect` (#9527 review).
    expect(spawnMock.mock.calls[0]).toEqual([
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', digestImage],
    ]);
    // Content found locally: no pull is attempted — the next spawn is the
    // sandbox run itself.
    expect((spawnMock.mock.calls[1]?.[1] as string[])[0]).toBe('run');

    child.emit('close', 0);
    await expect(result).resolves.toBe(0);
  });
});

describe('resolveSeatbeltProfileFile', () => {
  it('strips the chunks segment from bundled seatbelt profile paths', () => {
    const bundleDir = path.resolve(path.sep, 'tmp', 'qwen', 'lib');
    const chunkUrl = pathToFileURL(
      path.join(bundleDir, 'chunks', 'sandbox-AAAA.js'),
    ).toString();

    expect(resolveSeatbeltProfileFile('permissive-open', chunkUrl)).toBe(
      path.join(bundleDir, 'sandbox-macos-permissive-open.sb'),
    );
  });

  it('keeps source-mode seatbelt profile paths next to the module', () => {
    const serveDir = path.resolve(
      path.sep,
      'repo',
      'packages',
      'cli',
      'src',
      'serve',
    );
    const sourceUrl = pathToFileURL(
      path.join(serveDir, 'sandbox.ts'),
    ).toString();

    expect(resolveSeatbeltProfileFile('restrictive-closed', sourceUrl)).toBe(
      path.join(serveDir, 'sandbox-macos-restrictive-closed.sb'),
    );
  });

  it('keeps every builtin seatbelt profile colocated with the real module', () => {
    // Uses the default `import.meta.url` (the real module location), so this
    // fails loudly if sandbox.ts or the .sb profiles move without the other.
    // Iterate the module's own list rather than a hand-copied snapshot, so a
    // profile added to `BUILTIN_SEATBELT_PROFILES` without its `.sb` file
    // fails here instead of on a `sandbox-exec` ENOENT at launch. The length
    // guard keeps an emptied list from passing the loop vacuously.
    expect(BUILTIN_SEATBELT_PROFILES.length).toBeGreaterThan(0);
    for (const profile of BUILTIN_SEATBELT_PROFILES) {
      const profileFile = resolveSeatbeltProfileFile(profile);
      expect(fs.existsSync(profileFile), `missing ${profileFile}`).toBe(true);
    }
  });

  it('keeps custom seatbelt profiles under project settings', () => {
    const bundleDir = path.resolve(path.sep, 'tmp', 'qwen', 'lib');
    const chunkUrl = pathToFileURL(
      path.join(bundleDir, 'chunks', 'sandbox-AAAA.js'),
    ).toString();

    expect(resolveSeatbeltProfileFile('project-profile', chunkUrl)).toBe(
      path.join(QWEN_DIR, 'sandbox-macos-project-profile.sb'),
    );
  });

  it('throws missing file errors with the resolved seatbelt profile path', async () => {
    vi.stubEnv('SEATBELT_PROFILE', 'permissive-open');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const expectedPath = resolveSeatbeltProfileFile('permissive-open');

    await expect(
      start_sandbox({ command: 'sandbox-exec', image: '' }),
    ).rejects.toThrow(
      new FatalSandboxError(
        `Missing macos seatbelt profile file '${expectedPath}'`,
      ),
    );
  });

  it.each([
    ['managed ACP', '1', true],
    ['ordinary', undefined, false],
  ])(
    'handles Electron Node mode for a %s seatbelt re-exec',
    async (_name, marker, expected) => {
      vi.stubEnv('QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE', marker ?? '');
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'realpathSync').mockImplementation(
        (filePath) => String(filePath) || '/tmp',
      );
      execSyncMock.mockReturnValue(Buffer.from('/tmp/cache\n'));

      const child = new EventEmitter();
      spawnMock.mockReturnValue(child);
      const result = start_sandbox(
        { command: 'sandbox-exec', image: '' },
        [],
        undefined,
        [process.execPath, '/path/to/cli.js', '--acp'],
      );

      const args = spawnMock.mock.calls[0]?.[1] as string[];
      expect(args.at(-1)?.includes('ELECTRON_RUN_AS_NODE=1')).toBe(expected);

      child.emit('close', 0);
      await expect(result).resolves.toBe(0);
    },
  );

  it.each([
    ['false', false],
    ['1', true],
  ])(
    'sets NODE_OPTIONS --inspect-brk only for an enabled DEBUG=%s seatbelt run',
    async (debugValue, expected) => {
      // The seatbelt branch embeds the flag inside the final `sh -c` payload,
      // so a truthiness regression here would hang macOS sandboxes with no
      // docker `--publish` output to point at it.
      vi.stubEnv('DEBUG', debugValue);
      vi.stubEnv('DEBUG_MODE', '');
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      vi.spyOn(fs, 'realpathSync').mockImplementation(
        (filePath) => String(filePath) || '/tmp',
      );
      execSyncMock.mockReturnValue(Buffer.from('/tmp/cache\n'));

      const child = new EventEmitter();
      spawnMock.mockReturnValue(child);
      const result = start_sandbox(
        { command: 'sandbox-exec', image: '' },
        [],
        undefined,
        [process.execPath, '/path/to/cli.js', '--acp'],
      );

      const args = spawnMock.mock.calls[0]?.[1] as string[];
      expect(args.at(-1)?.includes('NODE_OPTIONS="--inspect-brk"')).toBe(
        expected,
      );

      child.emit('close', 0);
      await expect(result).resolves.toBe(0);
    },
  );
});

describe('getSandboxPassthroughEnvArgs', () => {
  it('passes operator state into container sandboxes', () => {
    expect(
      getSandboxPassthroughEnvArgs({
        QWEN_CODE_MODELS_DEV: 'off',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        QWEN_CODE_MODELS_DEV_URL: 'https://mirror.example/api.json',
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        QWEN_CODE_CUSTOM_SANDBOX_IMAGE: 'example.com/qwen:1.0.0',
        QWEN_CODE_HOST_UPDATE_RELAUNCH: 'false',
        QWEN_CODE_SERVE: '1',
        QWEN_CODE_DESKTOP: '1',
        QWEN_CODE_ENABLE_WORKFLOWS: '1',
        QWEN_CODE_DISABLE_WORKFLOWS: '1',
      }),
    ).toEqual([
      '--env',
      'QWEN_CODE_MODELS_DEV=off',
      '--env',
      'QWEN_CODE_MODELS_DEV_REFRESH=off',
      '--env',
      'QWEN_CODE_MODELS_DEV_URL=https://mirror.example/api.json',
      '--env',
      'QWEN_CODE_SKIP_UPDATE_CHECK_ONCE=true',
      '--env',
      'QWEN_CODE_CUSTOM_SANDBOX_IMAGE=example.com/qwen:1.0.0',
      '--env',
      'QWEN_CODE_HOST_UPDATE_RELAUNCH=false',
      '--env',
      'QWEN_CODE_SERVE=1',
      '--env',
      'QWEN_CODE_DESKTOP=1',
      '--env',
      'QWEN_CODE_ENABLE_WORKFLOWS=1',
      '--env',
      'QWEN_CODE_DISABLE_WORKFLOWS=1',
    ]);
  });
});

describe('isContainerPathWithinWorkdir', () => {
  it('allows the workdir itself', () => {
    expect(isContainerPathWithinWorkdir('/repo/app', '/repo/app')).toBe(true);
  });

  it('allows paths under the workdir', () => {
    expect(isContainerPathWithinWorkdir('/repo/app', '/repo/app/bin')).toBe(
      true,
    );
  });

  it('rejects sibling paths with the same prefix', () => {
    expect(
      isContainerPathWithinWorkdir('/repo/app', '/repo/app-tools/bin'),
    ).toBe(false);
  });

  it('allows absolute paths under the filesystem root workdir', () => {
    expect(isContainerPathWithinWorkdir('/', '/bin')).toBe(true);
  });

  it('normalizes trailing slashes and case for container paths', () => {
    expect(
      isContainerPathWithinWorkdir('/C/Repo/App/', '/c/repo/app/bin'),
    ).toBe(true);
  });

  it('handles converted Windows drive roots without matching sibling drives', () => {
    expect(isContainerPathWithinWorkdir('/c', '/c/tools')).toBe(true);
    expect(isContainerPathWithinWorkdir('/c', '/c2/tools')).toBe(false);
  });
});

describe('parseSandboxImageName', () => {
  it('uses the image basename and tag for container names', () => {
    expect(parseSandboxImageName('ghcr.io/qwenlm/qwen-code:0.18.3')).toBe(
      'qwen-code-0.18.3',
    );
  });

  it('handles registry ports without treating them as tags', () => {
    expect(
      parseSandboxImageName('localhost:5000/team/qwen-code-sandbox:dev'),
    ).toBe('qwen-code-sandbox-dev');
  });

  it('handles registry ports when the image is untagged', () => {
    expect(parseSandboxImageName('localhost:5000/team/qwen-code-sandbox')).toBe(
      'qwen-code-sandbox',
    );
  });

  it('drops digests from generated container names', () => {
    expect(
      parseSandboxImageName(
        'registry.example.com/team/qwen-code-sandbox@sha256:abcdef',
      ),
    ).toBe('qwen-code-sandbox');
  });

  it('keeps tags when dropping digests from generated container names', () => {
    expect(
      parseSandboxImageName(
        'registry.example.com/team/qwen-code-sandbox:dev@sha256:abcdef',
      ),
    ).toBe('qwen-code-sandbox-dev');
  });
});

describe('parseSandboxMountSpec', () => {
  it('defaults container path and options', () => {
    expect(parseSandboxMountSpec('/host/path')).toEqual({
      from: '/host/path',
      to: '/host/path',
      opts: 'ro',
    });
  });

  it('parses explicit container path and options', () => {
    expect(parseSandboxMountSpec('/host/path:/container/path:rw')).toEqual({
      from: '/host/path',
      to: '/container/path',
      opts: 'rw',
    });
  });

  it('defaults an empty container path to the host path', () => {
    expect(parseSandboxMountSpec('/host/path::rw')).toEqual({
      from: '/host/path',
      to: '/host/path',
      opts: 'rw',
    });
  });

  it('keeps the drive-letter colon in Windows host paths', () => {
    expect(
      parseSandboxMountSpec('C:\\Users\\me:/workspace:rw', 'win32'),
    ).toEqual({
      from: 'C:\\Users\\me',
      to: '/workspace',
      opts: 'rw',
    });
  });

  it('keeps the drive-letter colon in Windows host paths with forward slashes', () => {
    expect(parseSandboxMountSpec('C:/Users/me:/workspace:rw', 'win32')).toEqual(
      {
        from: 'C:/Users/me',
        to: '/workspace',
        opts: 'rw',
      },
    );
  });

  it('keeps a bare Windows host path intact', () => {
    expect(parseSandboxMountSpec('C:\\Users\\me', 'win32')).toEqual({
      from: 'C:\\Users\\me',
      to: 'C:\\Users\\me',
      opts: 'ro',
    });
  });
});
