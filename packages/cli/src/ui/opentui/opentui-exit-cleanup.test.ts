/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  runExitCleanup,
  _resetCleanupFunctionsForTest,
} from '../../utils/cleanup.js';
import { registerOpenTuiExitCleanup } from './opentui-exit-cleanup.js';

function makeConfig(recording: boolean): Config {
  return {
    getSessionId: () => 'sess-42',
    getChatRecordingService: () => (recording ? {} : undefined),
    getTranscriptPath: () => '/tmp/does-not-exist-transcript.jsonl',
  } as unknown as Config;
}

describe('registerOpenTuiExitCleanup', () => {
  let writeSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    _resetCleanupFunctionsForTest();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    _resetCleanupFunctionsForTest();
  });

  it('destroys the renderer during exit cleanup', async () => {
    const destroy = vi.fn();
    registerOpenTuiExitCleanup({ renderer: { destroy } });
    await runExitCleanup();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('echoes the farewell to stdout during exit cleanup', async () => {
    const destroy = vi.fn();
    registerOpenTuiExitCleanup({
      renderer: { destroy },
      config: makeConfig(false),
    });
    await runExitCleanup();
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Agent powering down. Goodbye!');
  });

  it('survives a renderer destroy that throws', async () => {
    const destroy = vi.fn(() => {
      throw new Error('destroy failed');
    });
    registerOpenTuiExitCleanup({
      renderer: { destroy },
      config: makeConfig(false),
    });
    await expect(runExitCleanup()).resolves.toBeUndefined();
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Agent powering down. Goodbye!');
  });

  it('returns deregister handles that remove the cleanups', async () => {
    const destroy = vi.fn();
    const handles = registerOpenTuiExitCleanup({ renderer: { destroy } });
    for (const h of handles) h();
    await runExitCleanup();
    expect(destroy).not.toHaveBeenCalled();
  });
});
