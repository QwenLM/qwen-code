/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandleRegistry } from './handles.js';
import type { JobRecord } from './handles.js';
import type { BackendHandle } from '../adaptor/types.js';

function backend(id: string, adaptor = 'qwen-code'): BackendHandle {
  return { id, adaptor };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HandleRegistry sessions', () => {
  it('returns the same handle for the same backend session (idempotent)', () => {
    const registry = new HandleRegistry();

    const first = registry.session(backend('abc'));
    const again = registry.session(backend('abc'));

    expect(first).toBe('session_1');
    expect(again).toBe(first);
  });

  it('assigns incrementing handles to distinct backends', () => {
    const registry = new HandleRegistry();

    expect(registry.session(backend('abc'))).toBe('session_1');
    expect(registry.session(backend('def'))).toBe('session_2');
    // Same id under a different adaptor is a different backend.
    expect(registry.session(backend('abc', 'acp'))).toBe('session_3');
    expect(registry.listSessions().size).toBe(3);
  });

  it('resolves session handles with surrounding whitespace trimmed', () => {
    const registry = new HandleRegistry();
    const handle = registry.session(backend('abc'));

    expect(registry.resolveSession(` ${handle} `)).toEqual(backend('abc'));
    expect(registry.resolveSession('session_99')).toBeUndefined();
  });
});

describe('HandleRegistry jobs', () => {
  it('creates jobs with incrementing handles and accepted state', () => {
    const registry = new HandleRegistry();
    const sessionHandle = registry.session(backend('abc'));

    const job = registry.createJob({
      sessionHandle,
      backend: backend('abc'),
      jobRef: 'prompt-1',
      task: 'run the tests',
    });

    expect(job).toEqual({
      jobHandle: 'job_1',
      sessionHandle,
      backend: backend('abc'),
      jobRef: 'prompt-1',
      state: 'accepted',
      task: 'run the tests',
      createdAt: 1_000_000,
    });
    expect(
      registry.createJob({
        sessionHandle,
        backend: backend('abc'),
        task: 'another task',
      }).jobHandle,
    ).toBe('job_2');
  });

  it('omits jobRef when none was supplied', () => {
    const registry = new HandleRegistry();
    const job = registry.createJob({
      sessionHandle: 'session_1',
      backend: backend('abc'),
      task: 'no ref',
    });

    expect('jobRef' in job).toBe(false);
    expect(registry.jobByRef('prompt-x')).toBeUndefined();
  });

  it('resolves jobs by trimmed handle and by backend jobRef', () => {
    const registry = new HandleRegistry();
    const job = registry.createJob({
      sessionHandle: 'session_1',
      backend: backend('abc'),
      jobRef: 'prompt-7',
      task: 'build',
    });

    expect(registry.resolveJob(` ${job.jobHandle} `)).toBe(job);
    expect(registry.resolveJob('job_99')).toBeUndefined();
    expect(registry.jobByRef('prompt-7')).toBe(job);
    expect(registry.jobByRef('prompt-8')).toBeUndefined();
  });

  it('picks the newest non-terminal job as the active job for a session', () => {
    const registry = new HandleRegistry();
    const create = (task: string): JobRecord => {
      vi.advanceTimersByTime(1_000);
      return registry.createJob({
        sessionHandle: 'session_1',
        backend: backend('abc'),
        task,
      });
    };

    const older = create('older');
    const newer = create('newer');
    expect(registry.activeJobForSession('session_1')?.task).toBe('newer');

    newer.state = 'done';
    expect(registry.activeJobForSession('session_1')?.task).toBe('older');

    older.state = 'failed';
    expect(registry.activeJobForSession('session_1')).toBeUndefined();

    const cancelled = create('cancelled one');
    cancelled.state = 'cancelled';
    expect(registry.activeJobForSession('session_1')).toBeUndefined();

    const running = create('running one');
    running.state = 'running';
    expect(registry.activeJobForSession('session_1')).toBe(running);
  });

  it('scopes the active job lookup to the requested session', () => {
    const registry = new HandleRegistry();
    registry.createJob({
      sessionHandle: 'session_1',
      backend: backend('abc'),
      task: 'for session 1',
    });

    expect(registry.activeJobForSession('session_2')).toBeUndefined();
  });
});

describe('HandleRegistry assets', () => {
  it('registers assets and resolves trimmed handles', () => {
    const registry = new HandleRegistry();
    const asset = registry.registerAsset({
      path: '/tmp/shot.png',
      mimeType: 'image/png',
    });

    expect(asset.assetHandle).toBe('asset_1');
    expect(registry.resolveAsset(' asset_1 ')).toBe(asset);
  });

  it('keeps at most 32 assets, evicting the oldest first', () => {
    const registry = new HandleRegistry();
    for (let index = 1; index <= 33; index++) {
      registry.registerAsset({
        path: `/tmp/shot-${index}.png`,
        mimeType: 'image/png',
      });
    }

    expect(registry.resolveAsset('asset_1')).toBeUndefined();
    expect(registry.resolveAsset('asset_2')?.path).toBe('/tmp/shot-2.png');
    expect(registry.resolveAsset('asset_33')?.path).toBe('/tmp/shot-33.png');

    registry.registerAsset({ path: '/tmp/shot-34.png', mimeType: 'image/png' });
    expect(registry.resolveAsset('asset_2')).toBeUndefined();
    expect(registry.resolveAsset('asset_3')).toBeDefined();
  });
});
