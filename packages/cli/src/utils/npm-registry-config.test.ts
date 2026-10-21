/**
 * @license
 * Copyright 2026 Alibaba Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getGlobalNpmRegistryConfig } from './npm-registry-config.js';

const actualExecPath = process.execPath;
const actualPlatform = process.platform;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe('global npm registry configuration', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-config-'));
    for (const key of Object.keys(process.env)) {
      if (/^npm_config_/i.test(key)) vi.stubEnv(key, undefined);
    }
    vi.mocked(os.homedir).mockReturnValue(root);
    Object.defineProperty(process, 'execPath', {
      value: path.join(root, 'runtime', 'bin', 'node'),
    });
    vi.stubEnv('npm_config_globalconfig', path.join(root, 'global.npmrc'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'execPath', { value: actualExecPath });
    Object.defineProperty(process, 'platform', { value: actualPlatform });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lookup = () => getGlobalNpmRegistryConfig('@qwen-code/qwen-code');
  function user(contents: string) {
    fs.writeFileSync(path.join(root, '.npmrc'), contents);
  }
  function global(contents: string) {
    fs.writeFileSync(path.join(root, 'global.npmrc'), contents);
  }

  it.each(['linux', 'win32'])(
    'reads the adjacent bundled npm builtin defaults on %s',
    (platform) => {
      const runtime = path.join(root, 'runtime');
      Object.defineProperty(process, 'platform', { value: platform });
      Object.defineProperty(process, 'execPath', {
        value:
          platform === 'win32'
            ? path.join(runtime, 'node.exe')
            : path.join(runtime, 'bin', 'node'),
      });
      const npm = path.join(
        runtime,
        ...(platform === 'win32' ? [] : ['lib']),
        'node_modules',
        'npm',
      );
      fs.mkdirSync(npm, { recursive: true });
      const builtin = path.join(npm, 'npmrc');
      fs.writeFileSync(
        builtin,
        'registry=https://builtin.test/\n//builtin.test/:_authToken=synthetic-token',
      );
      expect(lookup()).toEqual({
        registry: new URL('https://builtin.test/'),
        authorization: 'Bearer synthetic-token',
      });

      vi.stubEnv('npm_config_globalconfig', undefined);
      const prefix = path.join(root, 'distribution');
      fs.mkdirSync(path.join(prefix, 'etc'), { recursive: true });
      fs.writeFileSync(
        path.join(prefix, 'etc', 'npmrc'),
        'registry=https://prefix.test/',
      );
      fs.writeFileSync(builtin, `prefix=${prefix}`);
      expect(lookup().registry.href).toBe('https://prefix.test/');

      const userconfig = path.join(root, 'distribution-user.npmrc');
      fs.writeFileSync(userconfig, 'registry=https://builtin-user.test/');
      fs.writeFileSync(builtin, `userconfig=${userconfig}`);
      expect(lookup().registry.href).toBe('https://builtin-user.test/');
      const explicit = path.join(root, 'explicit-user.npmrc');
      fs.writeFileSync(explicit, 'registry=https://env-user.test/');
      vi.stubEnv('npm_config_userconfig', explicit);
      expect(lookup().registry.href).toBe('https://env-user.test/');
      vi.stubEnv('npm_config_userconfig', undefined);

      fs.writeFileSync(
        path.join(root, 'global.npmrc'),
        'registry=https://builtin-global.test/',
      );
      fs.writeFileSync(
        builtin,
        `globalconfig=${path.join(root, 'global.npmrc')}`,
      );
      expect(lookup().registry.href).toBe('https://builtin-global.test/');
      user('registry=https://user.test/');
      expect(lookup().registry.href).toBe('https://user.test/');
      vi.stubEnv('npm_config_registry', 'https://env.test/');
      expect(lookup().registry.href).toBe('https://env.test/');
    },
  );

  it.each(['linux', 'win32'])(
    'keeps builtin scoped registry and auth below matching global, user and env keys on %s',
    (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      const npm = path.join(
        root,
        'runtime',
        platform === 'win32' ? 'bin' : 'lib',
        'node_modules',
        'npm',
      );
      fs.mkdirSync(npm, { recursive: true });
      fs.writeFileSync(
        path.join(npm, 'npmrc'),
        '@qwen-code:registry=https://scope.test/\n//scope.test/:_authToken=builtin',
      );
      global('registry=https://global.test/\n//scope.test/:_authToken=global');
      expect(lookup()).toEqual({
        registry: new URL('https://scope.test/'),
        authorization: 'Bearer global',
      });
      user('//scope.test/:_authToken=user');
      expect(lookup().authorization).toBe('Bearer user');
      vi.stubEnv('npm_config_//scope.test/:_authToken', 'env');
      expect(lookup().authorization).toBe('Bearer env');
    },
  );

  it('merges global, user and env per key before selecting scoped registry', () => {
    global(
      'registry=https://global.test/\n@qwen-code:registry=https://scope-global.test/',
    );
    user('registry=https://user.test/');
    vi.stubEnv('npm_config_registry', 'https://env.test/');
    expect(lookup().registry.href).toBe('https://scope-global.test/');
    user('@qwen-code:registry=https://scope-user.test/');
    expect(lookup().registry.href).toBe('https://scope-user.test/');
    vi.stubEnv('npm_config_@qwen-code:registry', 'https://scope-env.test/');
    expect(lookup().registry.href).toBe('https://scope-env.test/');
  });
  it('reads explicit config files and env registry override', () => {
    const filename = path.join(root, 'custom.npmrc');
    fs.writeFileSync(filename, 'registry=https://user.test/');
    vi.stubEnv('NPM_CONFIG_USERCONFIG', filename);
    expect(lookup().registry.href).toBe('https://user.test/');
    vi.stubEnv('npm_config_registry', 'https://env.test/');
    expect(lookup().registry.href).toBe('https://env.test/');
  });
  it.each(['userconfig', 'globalconfig'])(
    'trims the environment %s path before reading it',
    (key) => {
      const filename = path.join(root, 'custom.npmrc');
      fs.writeFileSync(filename, 'registry=https://custom.test/');
      vi.stubEnv(`npm_config_${key}`, ` ${filename} `);
      expect(lookup().registry.href).toBe('https://custom.test/');
    },
  );
  it('trims environment authentication without restoring an overridden token', () => {
    user('registry=https://registry.test/\n//registry.test/:_authToken=user');
    vi.stubEnv('npm_config_//registry.test/:_authToken', ' synthetic-env ');
    expect(lookup().authorization).toBe('Bearer synthetic-env');
    vi.stubEnv('npm_config_//registry.test/:_authToken', ' ');
    expect(lookup().authorization).toBeUndefined();
  });
  it('uses prefix to locate global configuration', () => {
    vi.stubEnv('npm_config_globalconfig', undefined);
    const prefix = path.join(root, 'prefix');
    fs.mkdirSync(path.join(prefix, 'etc'), { recursive: true });
    fs.writeFileSync(
      path.join(prefix, 'etc/npmrc'),
      'registry=https://global.test/',
    );
    user(`prefix=${prefix}`);
    expect(lookup().registry.href).toBe('https://global.test/');
  });
  it('parses comments, quotes and env interpolation without changing token bytes', () => {
    vi.stubEnv('LOCAL_REGISTRY_TOKEN', 'dummy-token');
    user(
      'registry="https://registry.test/feed/"\n//registry.test/:_authToken=host-token\n//registry.test/feed/:_authToken=${LOCAL_REGISTRY_TOKEN} # comment',
    );
    expect(lookup().authorization).toBe('Bearer dummy-token');
    user(
      'registry=https://registry.test/\n//registry.test/:_authToken=token\\#with\\;characters',
    );
    expect(lookup().authorization).toBe('Bearer token#with;characters');
  });
  it.each(['npmrc', 'environment'])(
    'expands the registry scope, authentication key and value in %s',
    (source) => {
      vi.stubEnv('REGISTRY_HOST', 'registry.test');
      vi.stubEnv('scope', 'qwen-code');
      vi.stubEnv('LOCAL_REGISTRY_TOKEN', 'synthetic-template');
      user('registry=https://default.test/');
      const values = [
        ['@${scope}:registry', 'https://${REGISTRY_HOST}/'],
        ['//${REGISTRY_HOST}/:_authToken', '${LOCAL_REGISTRY_TOKEN}'],
      ];
      if (source === 'npmrc') {
        user(values.map(([key, value]) => `${key}=${value}`).join('\n'));
      } else {
        for (const [key, value] of values) {
          vi.stubEnv(`npm_config_${key}`, value);
        }
      }
      expect(lookup()).toEqual({
        registry: new URL('https://registry.test/'),
        authorization: 'Bearer synthetic-template',
      });
    },
  );
  it.each([
    ['//registry.test', 'bare-host'],
    ['//registry.test/private', 'path'],
    ['//registry.test/private/', 'path-with-slash'],
  ])('finds authentication at %s for a child registry', (key, token) => {
    user(
      `registry=https://registry.test/private/child/\n${key}:_authToken=${token}`,
    );
    expect(lookup().authorization).toBe(`Bearer ${token}`);
  });
  it('selects the longest auth path before parent and bare-host tokens', () => {
    user(
      'registry=https://registry.test/private/child/\n//registry.test:_authToken=host\n//registry.test/:_authToken=root\n//registry.test/private:_authToken=path\n//registry.test/private/:_authToken=path-slash',
    );
    expect(lookup().authorization).toBe('Bearer path-slash');
  });
  it.each([
    ['_auth=dXNlcjpwYXNz', 'Basic dXNlcjpwYXNz'],
    [
      'username=user\n//registry.test/:_password=cGFzcw==',
      'Basic dXNlcjpwYXNz',
    ],
  ])(
    'retains registry-scoped basic credentials (%s)',
    (config, authorization) => {
      user(`registry=https://registry.test/\n//registry.test/:${config}`);
      expect(lookup().authorization).toBe(authorization);
    },
  );
  it('never sends credentials for a different registry host or sibling path', () => {
    user(
      'registry=https://registry.test/other/\n//registry.test/private/:_authToken=dummy\n//registry.test/oth:_authToken=dummy\n//other.test:_authToken=dummy',
    );
    expect(lookup().authorization).toBeUndefined();
  });
  it('uses the public registry without ambient NPM_TOKEN', () => {
    vi.stubEnv('NPM_TOKEN', 'unrelated-token');
    expect(lookup()).toEqual({
      registry: new URL('https://registry.npmjs.org/'),
    });
  });
  it.each(['', 'relative-home'])(
    'never loads project npmrc when the OS home is %j',
    (home) => {
      const projectHome = path.join(root, home);
      fs.mkdirSync(projectHome, { recursive: true });
      const projectConfig = path.join(projectHome, '.npmrc');
      fs.writeFileSync(
        projectConfig,
        'registry=https://untrusted.test/\n//untrusted.test/:_authToken=${NPM_TOKEN}',
      );
      vi.stubEnv('NPM_TOKEN', 'synthetic-secret');
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      vi.mocked(os.homedir).mockReturnValue(home);

      expect(lookup()).toEqual({
        registry: new URL('https://registry.npmjs.org/'),
      });

      vi.mocked(os.homedir).mockReturnValue(projectHome);
      expect(lookup()).toEqual({
        registry: new URL('https://untrusted.test/'),
        authorization: 'Bearer synthetic-secret',
      });
    },
  );
  it('keeps explicit user configuration available without an OS home', () => {
    user('registry=https://explicit.test/');
    vi.mocked(os.homedir).mockReturnValue('');
    vi.stubEnv('npm_config_userconfig', path.join(root, '.npmrc'));
    expect(lookup().registry.href).toBe('https://explicit.test/');
  });
  it('rejects tilde configuration paths without a trusted home', () => {
    vi.mocked(os.homedir).mockReturnValue('');
    vi.stubEnv('npm_config_userconfig', '~/.npmrc');
    expect(lookup).toThrow('without an absolute home directory');
  });
  it.each(['', ' '])(
    'fails closed when an explicitly empty config path resolves to a directory (%j)',
    (value) => {
      user(`globalconfig=${value}`);
      vi.stubEnv('npm_config_globalconfig', undefined);
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      expect(lookup).toThrow('Unable to read npm registry configuration');
    },
  );
  it('redacts malformed credential errors before constructing a request', () => {
    user(
      'registry=https://registry.test/\n//registry.test/:_authToken="dummy-secret\\ninvalid"',
    );
    expect(lookup).toThrow('Invalid npm registry authentication configuration');
    try {
      lookup();
    } catch (error) {
      expect(String(error)).not.toContain('dummy-secret');
    }
  });
  it.each([
    'https://user:secret@registry.test',
    'ftp://registry.test',
    'invalid-secret-value',
  ])(
    'rejects unsafe registry config without exposing its value (%s)',
    (registry) => {
      user(`registry=${registry}`);
      expect(lookup).toThrow('Invalid npm registry configuration');
      try {
        lookup();
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    },
  );
});
