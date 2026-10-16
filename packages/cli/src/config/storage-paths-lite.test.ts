/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  expandsAgainstHome,
  getGlobalQwenDirLite,
  getSystemDefaultsPath,
  getSystemSettingsPath,
  isFullyQualifiedPath,
  passedEnvironment,
  readEnvironmentVariable,
  spawnedEnvironmentView,
} from './storage-paths-lite.js';

describe('settings locations in a given environment', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const runOn = (value: string) =>
    Object.defineProperty(process, 'platform', { value });
  const home = path.resolve('/located', 'qwen-home');
  const settingsPath = path.resolve('/located', 'settings.json');
  const defaultsPath = path.resolve('/located', 'system-defaults.json');

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
  });

  it.each([
    ['~', true],
    ['~/qwen', true],
    ['~\\qwen', true],
    ['~qwen', false],
    ['qwen/~', false],
    ['', false],
  ])(
    'treats %j as expanding against the home directory: %s',
    (dir, expected) => {
      expect(expandsAgainstHome(dir)).toBe(expected);
    },
  );

  // A session host locates its user directory with core's Storage; the
  // evaluation must locate the same one.
  it.each(['~', '~/qwen', '~\\qwen', '~qwen', 'qwen', home, '', undefined])(
    'locates QWEN_HOME=%j where core does',
    (value) => {
      vi.stubEnv('QWEN_HOME', value);

      expect(getGlobalQwenDirLite()).toBe(Storage.getGlobalQwenDir());
      expect(getGlobalQwenDirLite({ QWEN_HOME: value })).toBe(
        Storage.getGlobalQwenDir(),
      );
    },
  );

  it('passes on what spawn passes on: inherited keys, and every value but undefined as a string', () => {
    const environment = Object.assign(
      Object.create({ INHERITED: 'from the prototype' }),
      {
        NUMBER: 123,
        NULL: null,
        ZERO: 0,
        FALSE: false,
        EMPTY: '',
        UNSET: undefined,
        'UNSET=': undefined,
        TEXT: 'text',
      },
    ) as NodeJS.ProcessEnv;

    expect({ ...passedEnvironment(environment) }).toStrictEqual({
      NUMBER: '123',
      NULL: 'null',
      ZERO: '0',
      FALSE: 'false',
      EMPTY: '',
      TEXT: 'text',
      INHERITED: 'from the prototype',
    });
    expect(readEnvironmentVariable(environment, 'INHERITED')).toBe(
      'from the prototype',
    );
  });

  it.each([undefined, null, '', 0, false])(
    'refuses %j for an environment, for which spawn passes on its own',
    (environment) => {
      expect(() =>
        passedEnvironment(environment as unknown as NodeJS.ProcessEnv),
      ).toThrow(TypeError);
    },
  );

  it.each<[string, unknown]>([
    ['a Symbol value', { MODE: Symbol('plan') }],
    ['a NUL byte in a name', { 'MO\0DE': 'plan' }],
    ['a NUL byte in a value', { MODE: 'pl\0an' }],
    ['a NUL byte in a value that is not a string', { MODE: ['pl\0an'] }],
    ['a name that contains =', { 'MODE=alt': 'plan' }],
    ['a name that starts with =', { '=MODE': 'plan' }],
  ])(
    'refuses %s, which a process would not receive as it is',
    (_name, environment) => {
      runOn('linux');

      expect(() => passedEnvironment(environment as NodeJS.ProcessEnv)).toThrow(
        TypeError,
      );
    },
  );

  it('names the variable it refuses, and not its value', () => {
    runOn('linux');
    const unreadable = Object.defineProperty({}, 'MODE', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    }) as NodeJS.ProcessEnv;

    expect(() => passedEnvironment({ 'MODE=alt': 'secret' })).toThrow(
      /^The environment variable "MODE=alt" cannot be passed on as it is\.$/,
    );
    expect(() => passedEnvironment({ MODE: 'sec\0ret' })).toThrow(
      /^The environment variable "MODE" cannot be passed on as it is\.$/,
    );
    expect(() => passedEnvironment(unreadable)).toThrow(
      /^The environment variable "MODE" cannot be read: unreadable$/,
    );
  });

  // The oracle for the model: what a real child process reads.
  it('agrees with what a spawned process reads from its process.env', () => {
    const names = [
      'INHERITED',
      'NUMBER',
      'NULL',
      'EMPTY',
      'UNSET',
      'MODE',
      'mode',
      '0',
      '01',
    ];
    const environment = Object.assign(
      Object.create({ INHERITED: 'from the prototype' }),
      {
        NUMBER: 123,
        NULL: null,
        EMPTY: '',
        UNSET: undefined,
        MODE: 'plan',
        mode: 'default',
        '0': 'an index',
        '01': 'padded',
      },
    ) as NodeJS.ProcessEnv;
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((name) => process.env[name] ?? null)))`,
      ],
      { env: environment, encoding: 'utf8' },
    );
    const view = spawnedEnvironmentView(environment);

    expect(JSON.parse(child.stdout)).toEqual(
      names.map((name) => view[name] ?? null),
    );
  });

  it('passes on a Windows name that starts with =, but not one split by =', () => {
    runOn('win32');

    // Windows keeps the current directory of each drive under such a name.
    expect({ ...passedEnvironment({ '=C:': 'C:\\qwen' }) }).toStrictEqual({
      '=C:': 'C:\\qwen',
    });
    expect(() => passedEnvironment({ '=C:=alt': 'C:\\qwen' })).toThrow(
      TypeError,
    );
  });

  it('reads an inherited key on Windows too', () => {
    runOn('win32');

    expect(
      readEnvironmentVariable(
        Object.create({ qwen_home: home }) as NodeJS.ProcessEnv,
        'QWEN_HOME',
      ),
    ).toBe(home);
  });

  it('enumerates only the names spawn passes on, and on Windows finds any spelling', () => {
    runOn('win32');
    const view = spawnedEnvironmentView({
      MODE: 'plan',
      mode: 'default',
      zeta: 'last',
    });

    expect(Object.keys(view)).toEqual(['MODE', 'zeta']);
    expect(view['mode']).toBe('plan');
    expect(view['Mode']).toBe('plan');
    expect(view['ZETA']).toBe('last');
    expect('mode' in view).toBe(true);
    expect('ZETA' in view).toBe(true);
    expect('other' in view).toBe(false);
  });

  it.each(['linux', 'win32'])(
    'leaves out names like an array index, which process.env does not return, on %s',
    (platformName) => {
      runOn(platformName);
      const environment = {
        '0': 'zero',
        '4294967294': 'the last index',
        '4294967295': 'not an index',
        '01': 'padded',
        MODE: 'plan',
      };

      expect({ ...spawnedEnvironmentView(environment) }).toStrictEqual({
        '4294967295': 'not an index',
        '01': 'padded',
        MODE: 'plan',
      });
      expect(readEnvironmentVariable(environment, '0')).toBeUndefined();
    },
  );

  it('finds a name spelled in another case on Windows', () => {
    runOn('win32');

    expect(getGlobalQwenDirLite({ qwen_home: home })).toBe(home);
    expect(
      getSystemSettingsPath({ Qwen_Code_System_Settings_Path: settingsPath }),
    ).toBe(settingsPath);
    expect(
      getSystemDefaultsPath({ qwen_code_system_defaults_path: defaultsPath }),
    ).toBe(defaultsPath);
  });

  it('passes on the first spelling in sorted order on Windows, as spawn does', () => {
    runOn('win32');
    const other = path.resolve('/other');

    // Upper case sorts first, so the exact name wins over other spellings.
    expect(getGlobalQwenDirLite({ qwen_home: other, QWEN_HOME: home })).toBe(
      home,
    );
    expect(getGlobalQwenDirLite({ qwen_home: other, Qwen_Home: home })).toBe(
      home,
    );
    // A first spelling without a value is not passed on at all.
    expect(
      getGlobalQwenDirLite({ QWEN_HOME: undefined, qwen_home: other }),
    ).toBe(path.join(os.homedir(), '.qwen'));
  });

  it.each([
    ['C:\\qwen', true],
    ['c:/qwen', true],
    ['\\\\server\\share\\qwen', true],
    ['//server/share/qwen', true],
    ['\\\\?\\C:\\qwen', true],
    ['\\\\', false],
    ['\\\\server', false],
    ['\\qwen', false],
    ['/qwen', false],
    ['C:qwen', false],
    ['qwen', false],
  ])('on Windows, treats %s as fully qualified: %s', (location, expected) => {
    runOn('win32');

    expect(isFullyQualifiedPath(location)).toBe(expected);
  });

  it('matches names exactly on other platforms', () => {
    runOn('linux');

    expect(getGlobalQwenDirLite({ qwen_home: home })).toBe(
      path.join(os.homedir(), '.qwen'),
    );
  });
});
