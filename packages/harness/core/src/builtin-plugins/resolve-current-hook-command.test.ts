/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAND_CLI_BIN } from '../config/brand.js';
import { GLOBAL_CONFIG_DIR } from '../utils/paths.js';
import { resolveCurrentHookCommand } from './resolve-current-hook-command.js';

const originalArgv = process.argv;
const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'execPath',
);

function stubInvocation(execPath: string, argv: string[]): void {
  Object.defineProperty(process, 'execPath', {
    value: execPath,
    configurable: true,
  });
  process.argv = argv;
}

afterEach(() => {
  process.argv = originalArgv;
  if (originalExecPathDescriptor) {
    Object.defineProperty(process, 'execPath', originalExecPathDescriptor);
  }
  vi.unstubAllEnvs();
});

describe('current hook command resolution', () => {
  it('uses process.execPath for Bun virtual entries', () => {
    stubInvocation('/opt/qwen/qwen', [
      '/opt/qwen/qwen',
      '/$bunfs/root/index.js',
    ]);

    expect(resolveCurrentHookCommand()).toEqual(['/opt/qwen/qwen']);
  });

  it('uses the stable symlink for managed versioned binaries', () => {
    const versioned = path.join(
      homedir(),
      GLOBAL_CONFIG_DIR,
      'bin',
      BRAND_CLI_BIN,
      `${BRAND_CLI_BIN}-1.0.19`,
    );
    const stable =
      process.platform === 'win32'
        ? path.join(
            homedir(),
            GLOBAL_CONFIG_DIR,
            'bin',
            BRAND_CLI_BIN,
            `${BRAND_CLI_BIN}.exe`,
          )
        : path.join(homedir(), '.local', 'bin', BRAND_CLI_BIN);
    stubInvocation(versioned, [versioned, '/$bunfs/root/index.js']);

    expect(resolveCurrentHookCommand()).toEqual([stable]);
  });

  it('uses the NPM lifecycle command when launched by npm start', () => {
    vi.stubEnv('npm_lifecycle_event', 'start');
    vi.stubEnv('npm_package_json', '/tmp/test-package/package.json');
    vi.stubEnv(
      'npm_execpath',
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    );
    stubInvocation('/usr/local/bin/node', [
      '/usr/local/bin/node',
      '/tmp/test-package/index.js',
    ]);

    expect(resolveCurrentHookCommand()).toEqual([
      '/usr/local/bin/node',
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      '--prefix',
      '/tmp/test-package',
      'run',
      'start',
      '--',
    ]);
  });
});
