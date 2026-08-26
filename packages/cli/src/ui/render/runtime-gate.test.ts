/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BUN_FALLBACK_COMMAND,
  ensureOpenTuiRuntimeSupported,
  loadNodeFfi,
  openTuiRuntimeFailureLines,
  probeOpenTuiRuntime,
} from './runtime-gate.js';

const missingNodeFfi = () => {
  const error = new Error('No such built-in module: node:ffi');
  (error as NodeJS.ErrnoException).code = 'ERR_UNKNOWN_BUILTIN_MODULE';
  throw error;
};

const bunVersions = { ...process.versions, bun: '1.3.14' };

const nodeVersions = Object.fromEntries(
  Object.entries(process.versions).filter(([key]) => key !== 'bun'),
) as NodeJS.Process['versions'];

const neitherVersions = {} as NodeJS.Process['versions'];

describe('probeOpenTuiRuntime', () => {
  it('passes on Bun without touching node:ffi', () => {
    const probe = probeOpenTuiRuntime(bunVersions, missingNodeFfi);
    expect(probe).toEqual({
      runtime: 'bun',
      supported: true,
      reason: 'Bun 1.3.14 loads the native renderer through bun:ffi',
    });
  });

  it('fails closed when node:ffi cannot be loaded (Node v24 reproduction)', () => {
    const probe = probeOpenTuiRuntime(nodeVersions, missingNodeFfi);
    expect(probe.supported).toBe(false);
    expect(probe.runtime).toBe('node');
    expect(probe.reason).toContain(process.versions['node']);
    expect(probe.reason).toContain('cannot load node:ffi');
  });

  it('passes on a Node build where node:ffi actually loads', () => {
    const loader = vi.fn(() => ({}));
    const probe = probeOpenTuiRuntime(nodeVersions, loader);
    expect(probe.supported).toBe(true);
    expect(probe.runtime).toBe('node');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an unknown runtime', () => {
    const probe = probeOpenTuiRuntime(neitherVersions, vi.fn());
    expect(probe.supported).toBe(false);
    expect(probe.runtime).toBe('unknown');
  });

  it('matches the real node:ffi loadability of the current runtime', () => {
    const probe = probeOpenTuiRuntime();
    if (process.versions['bun']) {
      expect(probe.supported).toBe(true);
      return;
    }
    let loadable = true;
    try {
      loadNodeFfi();
    } catch {
      loadable = false;
    }
    expect(probe.supported).toBe(loadable);
  });
});

describe('openTuiRuntimeFailureLines', () => {
  it('names the runtime failure and provides the verified Bun command', () => {
    const unsupported = probeOpenTuiRuntime(nodeVersions, missingNodeFfi);
    const text = openTuiRuntimeFailureLines(unsupported).join('\n');
    expect(text).toContain('@opentui/core 0.5.8');
    expect(text).toContain(BUN_FALLBACK_COMMAND);
    expect(text).not.toContain('Node v24 is supported');
  });
});

describe('ensureOpenTuiRuntimeSupported', () => {
  it('writes the Bun command to stderr and exits nonzero when unsupported', () => {
    const writeError = vi.fn();
    const exit = vi.fn((() => {
      throw new Error('exit');
    }) as (code: number) => never);
    expect(() =>
      ensureOpenTuiRuntimeSupported({
        versions: nodeVersions,
        loader: missingNodeFfi,
        writeError,
        exit,
      }),
    ).toThrow('exit');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(writeError.mock.calls.map(([line]) => line).join('\n')).toContain(
      BUN_FALLBACK_COMMAND,
    );
  });

  it('is a no-op on supported runtimes', () => {
    const writeError = vi.fn();
    const exit = vi.fn((() => {
      throw new Error('exit');
    }) as (code: number) => never);
    ensureOpenTuiRuntimeSupported({
      versions: bunVersions,
      loader: missingNodeFfi,
      writeError,
      exit,
    });
    ensureOpenTuiRuntimeSupported({
      versions: nodeVersions,
      loader: () => ({}),
      writeError,
      exit,
    });
    expect(writeError).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
