/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeWarningHandler,
  resetWarningHandlerForTests,
} from './warningHandler.js';

const ENV_KEYS = ['NODE_ENV', 'DEBUG', 'QWEN_DEBUG'] as const;

describe('initializeWarningHandler', () => {
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let originalListeners: NodeJS.WarningListener[] = [];
  // Mock prior listener — installed before initializeWarningHandler so it
  // becomes one of the captured "priorListeners" the handler fans out to.
  // This is the channel the real Node default printer travels on, so
  // asserting fan-out here is equivalent to asserting "the default printer
  // would have fired" without coupling tests to internal Node behavior.
  let priorListener: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    originalListeners = [...process.listeners('warning')];
    process.removeAllListeners('warning');
    resetWarningHandlerForTests();
    priorListener = vi.fn();
    process.on('warning', priorListener);
  });

  afterEach(() => {
    resetWarningHandlerForTests();
    process.removeAllListeners('warning');
    for (const l of originalListeners) process.on('warning', l);
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  function makeWarning(name: string, message: string): Error {
    const err = new Error(message);
    err.name = name;
    return err;
  }

  function emit(warning: Error): void {
    // Drive the real listener chain (process.emit dispatches synchronously
    // to every registered 'warning' listener). After initializeWarningHandler,
    // the only listener is ours; it decides whether to fan out to the
    // captured priorListener mock.
    process.emit('warning', warning);
  }

  it('suppresses MaxListenersExceededWarning for AbortSignal in production', () => {
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1509 abort listeners added to [AbortSignal].',
      ),
    );
    expect(priorListener).not.toHaveBeenCalled();
  });

  it('does NOT suppress generic [EventTarget] warnings — only AbortSignal', () => {
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 11 listeners added to [EventTarget].',
      ),
    );
    expect(priorListener).toHaveBeenCalledTimes(1);
  });

  it('suppresses AbortSignal warnings with class metadata, e.g. [AbortSignal{aborted: false}]', () => {
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 11 abort listeners added to [AbortSignal{aborted: false}].',
      ),
    );
    expect(priorListener).not.toHaveBeenCalled();
  });

  it('fans out unrelated warnings to captured prior listeners (e.g. Node default printer)', () => {
    initializeWarningHandler();
    const warning = makeWarning('DeprecationWarning', 'Some legacy thing');
    emit(warning);
    expect(priorListener).toHaveBeenCalledTimes(1);
    expect(priorListener).toHaveBeenCalledWith(warning);
  });

  it('preserves third-party warning listeners — they still fire for non-suppressed warnings', () => {
    const telemetryHook = vi.fn();
    process.on('warning', telemetryHook);
    initializeWarningHandler();
    emit(makeWarning('DeprecationWarning', 'X'));
    expect(priorListener).toHaveBeenCalledTimes(1);
    expect(telemetryHook).toHaveBeenCalledTimes(1);
  });

  it('a buggy prior listener does not break the chain for the rest', () => {
    const buggy = vi.fn(() => {
      throw new Error('boom');
    });
    const downstream = vi.fn();
    process.on('warning', buggy);
    process.on('warning', downstream);
    initializeWarningHandler();
    emit(makeWarning('DeprecationWarning', 'X'));
    expect(buggy).toHaveBeenCalledTimes(1);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it('keeps suppressed warnings visible when DEBUG is set', () => {
    process.env['DEBUG'] = '1';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(priorListener).toHaveBeenCalledTimes(1);
  });

  it('treats DEBUG=0 and DEBUG=false as not set', () => {
    process.env['DEBUG'] = '0';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(priorListener).not.toHaveBeenCalled();
  });

  it('keeps warnings visible when QWEN_DEBUG is set', () => {
    process.env['QWEN_DEBUG'] = '1';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(priorListener).toHaveBeenCalledTimes(1);
  });

  it('keeps warnings visible when NODE_ENV=development', () => {
    process.env['NODE_ENV'] = 'development';
    initializeWarningHandler();
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(priorListener).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — repeated calls install only one listener', () => {
    initializeWarningHandler();
    initializeWarningHandler();
    initializeWarningHandler();
    expect(process.listeners('warning').length).toBe(1);
  });

  it('honors runtime DEBUG toggles — debug check is evaluated per warning', () => {
    initializeWarningHandler();
    // Initially DEBUG unset → suppression active.
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(priorListener).not.toHaveBeenCalled();

    // Flip DEBUG at runtime → next suppressed-pattern warning passes through.
    process.env['DEBUG'] = '1';
    emit(
      makeWarning(
        'MaxListenersExceededWarning',
        'Possible EventTarget memory leak detected. 1500 abort listeners added to [AbortSignal].',
      ),
    );
    expect(priorListener).toHaveBeenCalledTimes(1);
  });
});

describe('initializeWarningHandler — end-to-end stderr behavior', () => {
  // Integration test: spawn a child Node process to verify the real
  // emitWarning → default printer path is actually suppressed. The unit
  // tests above can't catch this because the default printer lives inside
  // Node and writes to stderr via internal mechanisms, not via the same
  // process.stderr.write spy.
  it('a child process with the handler installed does not print suppressed AbortSignal warnings to stderr', async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const here = dirname(fileURLToPath(import.meta.url));
    // Convert the absolute path to a `file://` URL — on Windows, Node's ESM
    // loader rejects raw absolute paths (it treats `D:` as a URL scheme),
    // so import specifiers MUST be file URLs.
    const helperImportSpecifier = pathToFileURL(
      join(here, 'warningHandler.ts'),
    ).href;

    const dir = await mkdtemp(join(tmpdir(), 'warning-handler-e2e-'));
    try {
      const script = `
        import { initializeWarningHandler } from ${JSON.stringify(helperImportSpecifier)};
        delete process.env.DEBUG; delete process.env.QWEN_DEBUG;
        process.env.NODE_ENV = 'production';
        initializeWarningHandler();
        process.emitWarning(
          'Possible EventTarget memory leak detected. 1509 abort listeners added to [AbortSignal].',
          'MaxListenersExceededWarning'
        );
        process.emitWarning('Plain deprecation', 'DeprecationWarning');
      `;
      const scriptPath = join(dir, 'run.mjs');
      await writeFile(scriptPath, script);

      const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (b) => {
        stderr += b.toString();
      });
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));

      expect(stderr).not.toMatch(/abort listeners added to \[AbortSignal\]/);
      // Deprecation should still print via the fanned-out default printer.
      expect(stderr).toMatch(/DeprecationWarning.*Plain deprecation/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
