/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  on: vi.fn(),
  postMessage: vi.fn(),
  unref: vi.fn(),
  exit: vi.fn(),
  timeout: vi.fn(() => 17_000),
  importFailure: false,
  enableGuard: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({ parentPort: state, workerData: {} }));
vi.mock('@qwen-code/core', () => ({
  enableDetachedProcessGuard: state.enableGuard,
  traceStartupStepAsync: vi.fn((_step, action) => action()),
  runLogger: { error: vi.fn() },
}));
vi.mock('./workerCwdShim.js', () => ({ installWorkerCwdShim: vi.fn() }));
vi.mock('../qwen.js', () => ({ main: vi.fn() }));
vi.mock('../startup/sessionConfigHome.js', () => ({
  initializeSessionConfigHome: vi.fn(),
}));
vi.mock('../config/configDirFlag.js', () => ({
  applyConfigDirFlagFromArgv: vi.fn(),
}));
vi.mock('../utils/cleanup.js', () => {
  if (state.importFailure) throw new Error('cleanup module unavailable');
  return {
    gracefulExit: state.exit,
    getExitCleanupTimeoutMs: state.timeout,
  };
});
const previousExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.importFailure = false;
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.doUnmock('../utils/cleanup.js');
});

async function closeHandler() {
  const { runWorkerCli } = await import('./workerRuntime.js');
  await runWorkerCli();
  expect(state.enableGuard).toHaveBeenCalledOnce();
  return state.on.mock.calls.find(([event]) => event === 'message')![1] as (
    message: unknown,
  ) => void;
}

it('deduplicates host close before the import settles and preserves a prior failure', async () => {
  const close = await closeHandler();
  process.exitCode = 1;
  close({ type: 'irrelevant' });
  close({ type: 'runtime.close' });
  close({ type: 'runtime.close' });
  await vi.waitFor(() => expect(state.exit).toHaveBeenCalledOnce());
  expect(state.postMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'runtime.closing',
    timeoutMs: 17_000,
  });
  expect(state.exit).toHaveBeenCalledWith(1, { exitReason: 'natural_end' });
});

it('observes a failed cleanup import and exits with failure', async () => {
  const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
  state.importFailure = true;
  vi.doMock('../utils/cleanup.js', () => {
    throw new Error('cleanup module unavailable');
  });
  const close = await closeHandler();
  close({ type: 'runtime.close' });
  await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
  expect(state.postMessage).not.toHaveBeenCalled();
});
