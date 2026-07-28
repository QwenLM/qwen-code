import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PINNED_CUA_DRIVER_VERSION } from '../../shared/cua-driver-version.ts';
import {
  CuaReadinessMonitor,
  findInstalledCuaDriver,
  hasExpectedCuaDriverIdentity,
  isCuaDriverBundleExecutablePath,
  parseCuaPermissionStatus,
  validateCuaDriverBundle,
} from '../cua-readiness.ts';

describe('CuaDriver readiness', () => {
  it('stays synchronized with the core Computer Use driver pin', async () => {
    const source = await readFile(
      fileURLToPath(
        new URL(
          '../../../../../../core/src/tools/computer-use/constants.ts',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const coreVersion = source.match(
      /export const CUA_DRIVER_VERSION = '([^']+)'/u,
    )?.[1];
    assert.equal(coreVersion, PINNED_CUA_DRIVER_VERSION);
  });

  it('does not treat other installed CuaDriver versions as ready', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qwen-live-cua-versions-'));
    const executable = (version: string) =>
      join(
        home,
        '.qwen',
        'computer-use',
        `cua-driver-rs-${version}`,
        `cua-driver-rs-${version}-darwin-arm64`,
        'CuaDriver.app',
        'Contents',
        'MacOS',
        'cua-driver',
      );
    const install = async (version: string) => {
      const target = executable(version);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'signed fixture');
    };
    const checked: string[] = [];
    const validate = async (target: string) => {
      checked.push(target);
      try {
        await access(target);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await install('0.5.1');
      await install('9.9.9');
      assert.equal(
        await findInstalledCuaDriver(home, 'arm64', validate),
        undefined,
      );
      assert.deepEqual(checked, [executable(PINNED_CUA_DRIVER_VERSION)]);

      await install(PINNED_CUA_DRIVER_VERSION);
      assert.equal(
        await findInstalledCuaDriver(home, 'arm64', validate),
        executable(PINNED_CUA_DRIVER_VERSION),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('requires both grants and the live capture probe for Appshot', () => {
    assert.deepEqual(
      parseCuaPermissionStatus(
        JSON.stringify({
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          source: { attribution: 'driver-daemon' },
        }),
      ),
      {
        installed: true,
        accessibility: 'granted',
        screenRecording: 'granted',
        appshot: true,
      },
    );
    assert.equal(
      parseCuaPermissionStatus(
        JSON.stringify({
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: false,
          source: { attribution: 'driver-daemon' },
        }),
      ).appshot,
      false,
    );
  });

  it('fails closed for standalone, terminal, IDE, and missing provenance', () => {
    const untrustedSources: unknown[] = [
      { attribution: 'caller' },
      {
        attribution: 'caller',
        executable: '/Applications/Terminal.app/Contents/MacOS/Terminal',
      },
      {
        attribution: 'caller',
        executable:
          '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
      },
      undefined,
    ];
    for (const source of untrustedSources) {
      assert.deepEqual(
        parseCuaPermissionStatus(
          JSON.stringify({
            accessibility: true,
            screen_recording: true,
            screen_recording_capturable: true,
            source,
          }),
        ),
        {
          installed: true,
          accessibility: 'not_determined',
          screenRecording: 'not_determined',
          appshot: false,
        },
      );
    }

    assert.deepEqual(
      parseCuaPermissionStatus('{"status":"unknown","daemon_running":false}'),
      {
        installed: true,
        accessibility: 'not_determined',
        screenRecording: 'not_determined',
        appshot: false,
      },
    );
  });

  it('requires the fixed CuaDriver bundle and signing identities', () => {
    assert.equal(
      isCuaDriverBundleExecutablePath(
        '/tmp/release/CuaDriver.app/Contents/MacOS/cua-driver',
      ),
      true,
    );
    assert.equal(isCuaDriverBundleExecutablePath('/tmp/cua-driver'), false);
    assert.equal(
      hasExpectedCuaDriverIdentity(
        ['Identifier=com.trycua.driver', 'TeamIdentifier=YCK386LBJ7'].join(
          '\n',
        ),
      ),
      true,
    );
    assert.equal(
      hasExpectedCuaDriverIdentity(
        ['Identifier=com.trycua.driver', 'TeamIdentifier=UNTRUSTED'].join('\n'),
      ),
      false,
    );
  });

  it('rejects the wrong bundle version or signing identity at the pinned path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-live-cua-'));
    const executable = join(
      root,
      '.qwen',
      'computer-use',
      `cua-driver-rs-${PINNED_CUA_DRIVER_VERSION}`,
      `cua-driver-rs-${PINNED_CUA_DRIVER_VERSION}-darwin-arm64`,
      'CuaDriver.app',
      'Contents',
      'MacOS',
      'cua-driver',
    );
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    try {
      let commands = 0;
      const valid = await validateCuaDriverBundle(
        executable,
        async (_file, args) => {
          commands += 1;
          if (args.includes('Print :CFBundleIdentifier')) {
            return { stdout: 'com.trycua.driver\n', stderr: '' };
          }
          if (args.includes('Print :CFBundleShortVersionString')) {
            return {
              stdout: `${PINNED_CUA_DRIVER_VERSION}\n`,
              stderr: '',
            };
          }
          return args.includes('-dv')
            ? {
                stdout: '',
                stderr:
                  'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\n',
              }
            : { stdout: '', stderr: '' };
        },
      );
      assert.equal(valid, true);
      assert.equal(commands, 4);

      const wrongVersion = await validateCuaDriverBundle(
        executable,
        async (_file, args) => {
          if (args.includes('Print :CFBundleIdentifier')) {
            return { stdout: 'com.trycua.driver\n', stderr: '' };
          }
          if (args.includes('Print :CFBundleShortVersionString')) {
            return { stdout: '9.9.9\n', stderr: '' };
          }
          return args.includes('-dv')
            ? {
                stdout: '',
                stderr:
                  'Identifier=com.trycua.driver\nTeamIdentifier=YCK386LBJ7\n',
              }
            : { stdout: '', stderr: '' };
        },
      );
      assert.equal(wrongVersion, false);

      const invalid = await validateCuaDriverBundle(
        executable,
        async (_file, args) => {
          if (args.includes('Print :CFBundleIdentifier')) {
            return { stdout: 'com.trycua.driver\n', stderr: '' };
          }
          if (args.includes('Print :CFBundleShortVersionString')) {
            return {
              stdout: `${PINNED_CUA_DRIVER_VERSION}\n`,
              stderr: '',
            };
          }
          return {
            stdout: '',
            stderr: 'Identifier=com.trycua.driver\nTeamIdentifier=OTHER\n',
          };
        },
      );
      assert.equal(invalid, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('revalidates the installed bundle identity on every poll', async () => {
    const states: Array<{ installed: boolean; appshot: boolean }> = [];
    let validations = 0;
    const monitor = new CuaReadinessMonitor(
      (state) => states.push(state),
      60_000,
      async () => {
        validations += 1;
        return validations === 1 ? '/validated/cua-driver' : undefined;
      },
      async () => ({
        stdout: JSON.stringify({
          accessibility: true,
          screen_recording: true,
          screen_recording_capturable: true,
          source: { attribution: 'driver-daemon' },
        }),
        stderr: '',
      }),
    );

    await monitor.poll();
    await monitor.poll();

    assert.equal(validations, 2);
    assert.deepEqual(
      states.map(({ installed, appshot }) => ({ installed, appshot })),
      [
        { installed: true, appshot: true },
        { installed: false, appshot: false },
      ],
    );
  });

  it('does not run a validated driver after the monitor stops', async () => {
    const findResolvers: Array<(path: string) => void> = [];
    let commands = 0;
    const monitor = new CuaReadinessMonitor(
      () => undefined,
      60_000,
      () =>
        new Promise<string>((resolve) => {
          findResolvers.push(resolve);
        }),
      async () => {
        commands += 1;
        return { stdout: '{}', stderr: '' };
      },
    );

    monitor.start();
    monitor.requestPermission('accessibility');
    monitor.stop();
    for (const resolve of findResolvers) resolve('/validated/cua-driver');
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(commands, 0);
  });
});
