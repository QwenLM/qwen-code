/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { Config } from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useInteractiveProject } from './useInteractiveProject.js';
import type { InteractiveProjectRuntime } from '../../interactiveProjectRuntime.js';

function runtime(root: string): InteractiveProjectRuntime {
  return {
    config: { storage: { getProjectRoot: () => root } } as Config,
    settings: {} as InteractiveProjectRuntime['settings'],
    themeError: null,
  };
}

describe('TUI project replacement', () => {
  it('unmounts the old project and keeps input unavailable until the selected transcript is restored', async () => {
    const first = runtime('/first');
    const next = runtime('/next');
    const create = vi.fn(async () => next);
    const data = {
      sessionId: 'selected',
      sessionPath: '/legacy/selected.jsonl',
      originalCwd: '/next',
      messages: [],
    };
    const { result, unmount } = await renderHook(() =>
      useInteractiveProject(first, create),
    );
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.resume(data, {});
    });
    await waitFor(() =>
      expect(result.current.runtime?.config).toBe(next.config),
    );
    expect(create).toHaveBeenCalledWith(first.config, data);
    expect(result.current.resumedSessionData).toBe(data);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await act(async () => {
      result.current.onInitialResumeComplete?.(true);
    });
    await expect(pending).resolves.toBe(true);
    unmount();
  });

  it('never remounts the disposed Config or resumes input when replacement fails', async () => {
    const first = runtime('/first');
    const create = vi.fn(async () => {
      throw new Error('resource initialization failed');
    });
    const { result, unmount } = await renderHook(() =>
      useInteractiveProject(first, create),
    );
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.resume(
        { sessionId: 'selected', originalCwd: '/next', messages: [] },
        {},
      );
    });
    await expect(pending).resolves.toBe(false);
    expect(result.current.runtime).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(Error);
    unmount();
  });
});
