/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { getGlobalQwenDir, getRuntimeBaseDir } from './paths.js';

describe('vscode-ide-companion paths – getGlobalQwenDir', () => {
  const originalEnv = process.env['QWEN_HOME'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['QWEN_HOME'] = originalEnv;
    } else {
      delete process.env['QWEN_HOME'];
    }
  });

  it('defaults to ~/.qwen when QWEN_HOME is not set', () => {
    delete process.env['QWEN_HOME'];
    expect(getGlobalQwenDir()).toBe(path.join(os.homedir(), '.qwen'));
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
    expect(getGlobalQwenDir()).toBe(path.join(os.homedir(), 'custom-qwen'));
  });

  it('expands Windows-style tilde (~\\x) in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~\\custom-qwen';
    expect(getGlobalQwenDir()).toBe(path.join(os.homedir(), 'custom-qwen'));
  });

  it('treats bare tilde (~) as home directory', () => {
    process.env['QWEN_HOME'] = '~';
    expect(getGlobalQwenDir()).toBe(os.homedir());
  });
});

describe('vscode-ide-companion paths – getRuntimeBaseDir', () => {
  const originalHome = process.env['QWEN_HOME'];
  const originalRuntime = process.env['QWEN_RUNTIME_DIR'];

  afterEach(() => {
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
    expect(getRuntimeBaseDir()).toBe(path.join(os.homedir(), 'custom-runtime'));
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
