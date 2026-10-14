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
    vi.stubEnv('npm_config_globalconfig', path.join(root, 'global.npmrc'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lookup = () => getGlobalNpmRegistryConfig('@qwen-code/qwen-code');
  function user(contents: string) {
    fs.writeFileSync(path.join(root, '.npmrc'), contents);
  }
  function global(contents: string) {
    fs.writeFileSync(path.join(root, 'global.npmrc'), contents);
  }

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
      'registry=https://registry.test/other/\n//registry.test/private/:_authToken=dummy\n//other.test/:_authToken=dummy',
    );
    expect(lookup().authorization).toBeUndefined();
  });
  it('uses the public registry without ambient NPM_TOKEN', () => {
    vi.stubEnv('NPM_TOKEN', 'unrelated-token');
    expect(lookup()).toEqual({
      registry: new URL('https://registry.npmjs.org/'),
    });
  });
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
