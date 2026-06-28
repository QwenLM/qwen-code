/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LspConfigWatcher } from './lsp-config-watcher.js';

const debugLoggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  createDebugLogger: vi.fn(() => debugLoggerMock),
}));

type TestableWatcher = {
  listener?: (event: unknown) => void | Promise<void>;
  handleChange(): Promise<void>;
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-watcher-'));
  tempDirs.push(dir);
  return dir;
}

describe('LspConfigWatcher', () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create .lsp.json during construction', () => {
    const dir = makeTempDir();
    new LspConfigWatcher(dir);

    expect(fs.existsSync(path.join(dir, '.lsp.json'))).toBe(false);
  });

  it('notifies on create and suppresses formatting-only changes', async () => {
    const dir = makeTempDir();
    const watcher = new LspConfigWatcher(dir) as unknown as TestableWatcher;
    const listener = vi.fn();
    watcher.listener = listener;

    fs.writeFileSync(
      path.join(dir, '.lsp.json'),
      '{"typescript":{"command":"tsserver"}}',
    );
    await watcher.handleChange();
    expect(listener).toHaveBeenCalledWith({
      path: path.join(dir, '.lsp.json'),
      changeType: 'created',
    });
    expect(debugLoggerMock.info).toHaveBeenCalledWith(
      `LSP config changed: created ${path.join(dir, '.lsp.json')}`,
    );

    fs.writeFileSync(
      path.join(dir, '.lsp.json'),
      JSON.stringify({ typescript: { command: 'tsserver' } }, null, 2),
    );
    await watcher.handleChange();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify on parse failure and notifies on later deletion', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, '.lsp.json');
    fs.writeFileSync(configPath, '{"typescript":{"command":"tsserver"}}');
    const watcher = new LspConfigWatcher(dir) as unknown as TestableWatcher;
    const listener = vi.fn();
    watcher.listener = listener;

    fs.writeFileSync(configPath, '{');
    await watcher.handleChange();
    expect(listener).not.toHaveBeenCalled();

    fs.unlinkSync(configPath);
    await watcher.handleChange();
    expect(listener).toHaveBeenCalledWith({
      path: configPath,
      changeType: 'deleted',
    });
  });
});
