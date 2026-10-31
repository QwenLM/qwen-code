/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  getGlobalQwenDir,
  getRuntimeBaseDir,
  resetEnvBootstrapForTesting,
} from './paths.js';

/**
 * Each test gets a clean temp homedir (no `.env` files), so the lazy
 * `bootstrapHomeEnvOverrides()` becomes a no-op unless the test explicitly
 * writes `.env` content into the mocked home. ESM bans spying on `os.homedir`,
 * so we redirect via the underlying `HOME` / `USERPROFILE` env vars.
 */
function withCleanHome() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-paths-test-'));
  const realHome = fs.realpathSync(tempHome);
  const originalHomeEnv = process.env['HOME'];
  const originalUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = realHome;
  process.env['USERPROFILE'] = realHome;
  return {
    tempHome: realHome,
    cleanup: () => {
      if (originalHomeEnv !== undefined) {
        process.env['HOME'] = originalHomeEnv;
      } else {
        delete process.env['HOME'];
      }
      if (originalUserProfile !== undefined) {
        process.env['USERPROFILE'] = originalUserProfile;
      } else {
        delete process.env['USERPROFILE'];
      }
      fs.rmSync(realHome, { recursive: true, force: true });
    },
  };
}

describe('vscode-ide-companion paths – getGlobalQwenDir', () => {
  const originalEnv = process.env['QWEN_HOME'];
  let home: ReturnType<typeof withCleanHome>;

  beforeEach(() => {
    resetEnvBootstrapForTesting();
    home = withCleanHome();
  });

  afterEach(() => {
    home.cleanup();
    if (originalEnv !== undefined) {
      process.env['QWEN_HOME'] = originalEnv;
    } else {
      delete process.env['QWEN_HOME'];
    }
  });

  describe('without QWEN_HOME', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalXdg = process.env['XDG_CONFIG_HOME'];
    const legacyDir = () => path.join(home.tempHome, '.qwen');
    const xdgDir = () => path.join(home.tempHome, '.config', 'qwen');

    beforeEach(() => {
      delete process.env['QWEN_HOME'];
      delete process.env['XDG_CONFIG_HOME'];
      Object.defineProperty(process, 'platform', { value: 'linux' });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', platform);
      if (originalXdg !== undefined) {
        process.env['XDG_CONFIG_HOME'] = originalXdg;
      } else {
        delete process.env['XDG_CONFIG_HOME'];
      }
    });

    it('uses ~/.config/qwen for a new install on Linux', () => {
      expect(getGlobalQwenDir()).toBe(xdgDir());
    });

    it('keeps an existing ~/.qwen on Linux until the XDG directory holds the marker', () => {
      fs.mkdirSync(legacyDir());
      expect(getGlobalQwenDir()).toBe(legacyDir());
      fs.mkdirSync(xdgDir(), { recursive: true });
      expect(getGlobalQwenDir()).toBe(legacyDir());
      fs.writeFileSync(path.join(xdgDir(), '.qwen-global-dir'), '');
      expect(getGlobalQwenDir()).toBe(xdgDir());
    });

    it('uses an absolute XDG_CONFIG_HOME', () => {
      const configHome = path.join(home.tempHome, 'xdg-config');
      process.env['XDG_CONFIG_HOME'] = configHome;
      expect(getGlobalQwenDir()).toBe(path.join(configHome, 'qwen'));
    });

    it('ignores a relative XDG_CONFIG_HOME', () => {
      process.env['XDG_CONFIG_HOME'] = 'relative-config';
      expect(getGlobalQwenDir()).toBe(xdgDir());
    });

    it('reads QWEN_HOME from the .env in ~/.config/qwen', () => {
      const configDir = path.resolve('/tmp/from-xdg-dotenv');
      fs.mkdirSync(xdgDir(), { recursive: true });
      fs.writeFileSync(path.join(xdgDir(), '.env'), `QWEN_HOME=${configDir}\n`);
      expect(getGlobalQwenDir()).toBe(configDir);
    });

    it.each(['darwin', 'win32'])('keeps ~/.qwen on %s', (value) => {
      Object.defineProperty(process, 'platform', { value });
      fs.mkdirSync(xdgDir(), { recursive: true });
      expect(getGlobalQwenDir()).toBe(legacyDir());
    });
  });

  it('uses QWEN_HOME when set to absolute path', () => {
    const configDir = path.resolve('/tmp/custom-qwen');
    process.env['QWEN_HOME'] = configDir;
    expect(getGlobalQwenDir()).toBe(configDir);
  });

  it('resolves relative QWEN_HOME against process.cwd', () => {
    process.env['QWEN_HOME'] = 'relative/config';
    expect(getGlobalQwenDir()).toBe(path.resolve('relative/config'));
  });

  it('expands tilde (~/x) in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~/custom-qwen';
    expect(getGlobalQwenDir()).toBe(path.join(home.tempHome, 'custom-qwen'));
  });

  it('expands Windows-style tilde (~\\x) in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~\\custom-qwen';
    expect(getGlobalQwenDir()).toBe(path.join(home.tempHome, 'custom-qwen'));
  });

  it('treats bare tilde (~) as home directory', () => {
    process.env['QWEN_HOME'] = '~';
    expect(getGlobalQwenDir()).toBe(home.tempHome);
  });
});

describe('vscode-ide-companion paths – getRuntimeBaseDir', () => {
  const originalHome = process.env['QWEN_HOME'];
  const originalRuntime = process.env['QWEN_RUNTIME_DIR'];
  let home: ReturnType<typeof withCleanHome>;

  beforeEach(() => {
    resetEnvBootstrapForTesting();
    home = withCleanHome();
  });

  afterEach(() => {
    home.cleanup();
    if (originalHome !== undefined) {
      process.env['QWEN_HOME'] = originalHome;
    } else {
      delete process.env['QWEN_HOME'];
    }
    if (originalRuntime !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntime;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
  });

  it('falls back to getGlobalQwenDir() when neither env var is set', () => {
    delete process.env['QWEN_HOME'];
    delete process.env['QWEN_RUNTIME_DIR'];
    expect(getRuntimeBaseDir()).toBe(getGlobalQwenDir());
  });

  it('uses QWEN_RUNTIME_DIR when set to absolute path', () => {
    delete process.env['QWEN_HOME'];
    const runtimeDir = path.resolve('/tmp/custom-runtime');
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    expect(getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('resolves relative QWEN_RUNTIME_DIR against process.cwd', () => {
    delete process.env['QWEN_HOME'];
    process.env['QWEN_RUNTIME_DIR'] = 'relative/runtime';
    expect(getRuntimeBaseDir()).toBe(path.resolve('relative/runtime'));
  });

  it('expands tilde (~/x) in QWEN_RUNTIME_DIR', () => {
    delete process.env['QWEN_HOME'];
    process.env['QWEN_RUNTIME_DIR'] = '~/custom-runtime';
    expect(getRuntimeBaseDir()).toBe(
      path.join(home.tempHome, 'custom-runtime'),
    );
  });

  it('falls back to QWEN_HOME when QWEN_RUNTIME_DIR is unset', () => {
    delete process.env['QWEN_RUNTIME_DIR'];
    const configDir = path.resolve('/tmp/custom-qwen');
    process.env['QWEN_HOME'] = configDir;
    expect(getRuntimeBaseDir()).toBe(configDir);
  });

  it('QWEN_RUNTIME_DIR takes priority over QWEN_HOME', () => {
    const configDir = path.resolve('/tmp/custom-qwen');
    const runtimeDir = path.resolve('/tmp/custom-runtime');
    process.env['QWEN_HOME'] = configDir;
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    expect(getRuntimeBaseDir()).toBe(runtimeDir);
  });
});

describe('vscode-ide-companion paths – .env bootstrap', () => {
  const originalHome = process.env['QWEN_HOME'];
  const originalRuntime = process.env['QWEN_RUNTIME_DIR'];
  let home: ReturnType<typeof withCleanHome>;

  beforeEach(() => {
    resetEnvBootstrapForTesting();
    home = withCleanHome();
    delete process.env['QWEN_HOME'];
    delete process.env['QWEN_RUNTIME_DIR'];
  });

  afterEach(() => {
    home.cleanup();
    if (originalHome !== undefined) {
      process.env['QWEN_HOME'] = originalHome;
    } else {
      delete process.env['QWEN_HOME'];
    }
    if (originalRuntime !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntime;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
  });

  it('reads QWEN_HOME from <homedir>/.qwen/.env', () => {
    const configDir = path.resolve('/tmp/from-qwen-dotenv');
    fs.mkdirSync(path.join(home.tempHome, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(home.tempHome, '.qwen', '.env'),
      `QWEN_HOME=${configDir}\n`,
    );
    expect(getGlobalQwenDir()).toBe(configDir);
    expect(process.env['QWEN_HOME']).toBe(configDir);
  });

  it('reads QWEN_HOME from <homedir>/.env when ~/.qwen/.env is absent', () => {
    const configDir = path.resolve('/tmp/from-home-dotenv');
    fs.writeFileSync(
      path.join(home.tempHome, '.env'),
      `QWEN_HOME=${configDir}\n`,
    );
    expect(getGlobalQwenDir()).toBe(configDir);
    expect(process.env['QWEN_HOME']).toBe(configDir);
  });

  it('process env wins over .env file', () => {
    const envDir = path.resolve('/tmp/from-process-env');
    const dotenvDir = path.resolve('/tmp/from-dotenv');
    process.env['QWEN_HOME'] = envDir;
    fs.mkdirSync(path.join(home.tempHome, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(home.tempHome, '.qwen', '.env'),
      `QWEN_HOME=${dotenvDir}\n`,
    );
    expect(getGlobalQwenDir()).toBe(envDir);
  });

  it('reads QWEN_RUNTIME_DIR from <QWEN_HOME>/.env when QWEN_HOME is preset', () => {
    const configDir = path.join(home.tempHome, 'custom-qwen');
    const runtimeDir = path.resolve('/tmp/from-runtime-dotenv');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.env'),
      `QWEN_RUNTIME_DIR=${runtimeDir}\n`,
    );
    process.env['QWEN_HOME'] = configDir;
    expect(getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('does not read <homedir>/.env when QWEN_HOME is preset', () => {
    const configDir = path.resolve('/tmp/preset-qwen-home');
    process.env['QWEN_HOME'] = configDir;
    fs.writeFileSync(
      path.join(home.tempHome, '.env'),
      `QWEN_RUNTIME_DIR=/tmp/should-be-ignored\n`,
    );
    expect(getRuntimeBaseDir()).toBe(configDir);
    expect(process.env['QWEN_RUNTIME_DIR']).toBeUndefined();
  });

  it('reads QWEN_RUNTIME_DIR from <new QWEN_HOME>/.env after discovery via ~/.qwen/.env', () => {
    const configDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-bootstrap-cfg-')),
    );
    const runtimeDir = path.resolve('/tmp/from-discovered-runtime');
    fs.mkdirSync(path.join(home.tempHome, '.qwen'), { recursive: true });
    fs.writeFileSync(
      path.join(home.tempHome, '.qwen', '.env'),
      `QWEN_HOME=${configDir}\n`,
    );
    fs.writeFileSync(
      path.join(configDir, '.env'),
      `QWEN_RUNTIME_DIR=${runtimeDir}\n`,
    );
    try {
      expect(getRuntimeBaseDir()).toBe(runtimeDir);
      expect(process.env['QWEN_HOME']).toBe(configDir);
      expect(process.env['QWEN_RUNTIME_DIR']).toBe(runtimeDir);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
