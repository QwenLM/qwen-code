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
    expect(registry.jobByRef(backend('abc'), 'prompt-x')).toBeUndefined();
  });

  it('returns the existing record instead of minting a duplicate for a known jobRef', () => {
    const registry = new HandleRegistry();
    const first = registry.createJob({
      sessionHandle: 'session_1',
      backend: backend('abc'),
      jobRef: 'prompt-1',
      task: 'original task',
    });
    first.state = 'running';

    // A steer that joined the running turn reports the SAME jobRef: the
    // registry must not orphan the running job behind a second record.
    const again = registry.createJob({
      sessionHandle: 'session_1',
      backend: backend('abc'),
      jobRef: 'prompt-1',
      task: 'joined instruction',
    });

    expect(again).toBe(first);
    expect(again.jobHandle).toBe('job_1');
    expect(registry.resolveJob('job_2')).toBeUndefined();
    expect(registry.activeJobForSession('session_1')).toBe(first);

    first.state = 'done';
    expect(registry.activeJobForSession('session_1')).toBeUndefined();
  });

  it('scopes jobRefs by owning adaptor — identical refs never collide across backends', () => {
    // jobRefs are adaptor-local (serve mints prompt UUIDs, an ACP adaptor
    // counts turn-1, turn-2): the owning adaptor must scope the lookup key.
    const registry = new HandleRegistry();
    const serveJob = registry.createJob({
      sessionHandle: 'session_1',
      backend: backend('abc'),
      jobRef: 'turn-1',
      task: 'serve task',
    });
    const acpJob = registry.createJob({
      sessionHandle: 'session_2',
      backend: backend('x', 'acp'),
      jobRef: 'turn-1',
      task: 'acp task',
    });

    expect(acpJob).not.toBe(serveJob);
    expect(acpJob.jobHandle).toBe('job_2');
    // Each backend's lookup resolves to its own record…
    expect(registry.jobByRef(backend('abc'), 'turn-1')).toBe(serveJob);
    expect(registry.jobByRef(backend('x', 'acp'), 'turn-1')).toBe(acpJob);
    // …and the same jobRef under an unknown backend is simply unknown.
    expect(registry.jobByRef(backend('x', 'other'), 'turn-1')).toBeUndefined();
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
    expect(registry.jobByRef(backend('abc'), 'prompt-7')).toBe(job);
    expect(registry.jobByRef(backend('abc'), 'prompt-8')).toBeUndefined();
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
