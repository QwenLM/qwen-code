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

// Keep chokidar fully in-process so watcher lifecycle tests can trigger file
// events deterministically without arming real filesystem watchers.
const chokidarMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const watcher = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return watcher;
    }),
    close: vi.fn(async () => {}),
  };
  return {
    handlers,
    watch: vi.fn(() => watcher),
    watcher,
  };
});

const debugLoggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('chokidar', () => ({
  watch: chokidarMock.watch,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  createDebugLogger: vi.fn(() => debugLoggerMock),
}));

// The watcher intentionally keeps its refresh pipeline private. These tests
// exercise it directly to cover semantic diffing and timeout behavior without
// waiting on real chokidar scheduling.
type TestableWatcher = {
  listener?: (event: unknown) => void | Promise<void>;
  handleChange(): Promise<void>;
  notifyListener(event: unknown): Promise<boolean>;
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-watcher-'));
  tempDirs.push(dir);
  return dir;
}

describe('LspConfigWatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    chokidarMock.handlers.clear();
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

  // Invalid JSON should be visible to the user, but it must not replace the
  // current runtime state. A later delete still needs to reconcile to empty.
  it('notifies invalid config and notifies on later deletion', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, '.lsp.json');
    fs.writeFileSync(configPath, '{"typescript":{"command":"tsserver"}}');
    const watcher = new LspConfigWatcher(dir) as unknown as TestableWatcher;
    const listener = vi.fn();
    watcher.listener = listener;

    fs.writeFileSync(configPath, '{');
    await watcher.handleChange();
    expect(listener).toHaveBeenCalledWith({
      path: configPath,
      changeType: 'invalid',
      error:
        'Invalid JSON in .lsp.json; existing LSP runtime state is unchanged.',
    });

    fs.unlinkSync(configPath);
    await watcher.handleChange();
    expect(listener).toHaveBeenCalledWith({
      path: configPath,
      changeType: 'deleted',
    });
  });

  it('reports read errors separately from invalid JSON', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, '.lsp.json');
    const watcher = new LspConfigWatcher(dir) as unknown as TestableWatcher;
    const listener = vi.fn();
    watcher.listener = listener;
    fs.mkdirSync(configPath);

    await watcher.handleChange();

    expect(listener).toHaveBeenCalledWith({
      path: configPath,
      changeType: 'invalid',
      error:
        'Failed to read .lsp.json; existing LSP runtime state is unchanged.',
    });
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'Failed to read .lsp.json:',
      expect.objectContaining({ code: 'EISDIR' }),
    );
  });

  it('retries the same config content when listener notification fails', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, '.lsp.json');
    const watcher = new LspConfigWatcher(dir) as unknown as TestableWatcher;
    const listener = vi
      .fn()
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined);
    watcher.listener = listener;

    fs.writeFileSync(configPath, '{"typescript":{"command":"tsserver"}}');
    await watcher.handleChange();
    await watcher.handleChange();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      path: configPath,
      changeType: 'created',
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      path: configPath,
      changeType: 'created',
    });
  });

  it('debounces duplicate filesystem events', async () => {
    vi.useFakeTimers();
    const dir = makeTempDir();
    const configPath = path.join(dir, '.lsp.json');
    const watcher = new LspConfigWatcher(dir);
    const listener = vi.fn();
    watcher.startWatching(listener);
    const onAll = chokidarMock.handlers.get('all');
    expect(onAll).toBeDefined();

    fs.writeFileSync(configPath, '{"typescript":{"command":"tsserver"}}');
    onAll?.('add', configPath);
    onAll?.('change', configPath);
    await vi.advanceTimersByTimeAsync(LspConfigWatcher.DEBOUNCE_MS);

    expect(listener).toHaveBeenCalledTimes(1);
    await watcher.stopWatching();
  });

  it('waits for an active listener before stopping', async () => {
    vi.useFakeTimers();
    const dir = makeTempDir();
    const configPath = path.join(dir, '.lsp.json');
    let resolveListener: (() => void) | undefined;
    const listener = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveListener = resolve;
        }),
    );
    const watcher = new LspConfigWatcher(dir);
    watcher.startWatching(listener);
    const onAll = chokidarMock.handlers.get('all');
    expect(onAll).toBeDefined();

    fs.writeFileSync(configPath, '{"typescript":{"command":"tsserver"}}');
    onAll?.('add', configPath);
    await vi.advanceTimersByTimeAsync(LspConfigWatcher.DEBOUNCE_MS);
    expect(listener).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = watcher.stopWatching().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(chokidarMock.watcher.close).not.toHaveBeenCalled();

    resolveListener?.();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(chokidarMock.watcher.close).toHaveBeenCalledOnce();
  });

  // Listener timeout is the isolation boundary between file watching and the
  // running CLI session: a hung reload callback should be logged and swallowed.
  it('times out a hanging listener without throwing', async () => {
    vi.useFakeTimers();
    const dir = makeTempDir();
    const watcher = new LspConfigWatcher(dir) as unknown as TestableWatcher;
    watcher.listener = vi.fn(() => new Promise<void>(() => {}));

    const notifyPromise = watcher.notifyListener({
      path: path.join(dir, '.lsp.json'),
      changeType: 'modified',
    });
    await vi.advanceTimersByTimeAsync(LspConfigWatcher.LISTENER_TIMEOUT_MS);
    await expect(notifyPromise).resolves.toBe(false);

    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'LSP config change listener error:',
      expect.any(Error),
    );
  });
});
