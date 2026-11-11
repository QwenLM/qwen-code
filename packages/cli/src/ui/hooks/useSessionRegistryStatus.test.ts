/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The status derivation is tested through the hook rather than through
 * `AppContainer`: the write-per-transition property is the whole point of
 * extracting it, and asserting a call count through a component of several
 * thousand lines would measure the harness rather than the rule.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { StreamingState } from '../types.js';
import {
  deriveSessionStatus,
  useSessionRegistryStatus,
} from './useSessionRegistryStatus.js';

const refreshSessionRegistryEntry = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, refreshSessionRegistryEntry };
});

interface Props {
  state: StreamingState;
  shell: boolean;
}

const renderStatus = (initialProps: Props) =>
  renderHook<void, Props>(
    ({ state, shell }) => useSessionRegistryStatus(state, shell),
    { initialProps },
  );

describe('deriveSessionStatus', () => {
  it('reports an idle session', () => {
    expect(deriveSessionStatus(StreamingState.Idle, false)).toBe('idle');
  });

  it('reports a responding session as busy', () => {
    expect(deriveSessionStatus(StreamingState.Responding, false)).toBe('busy');
  });

  it('reports a confirmation prompt as waiting', () => {
    expect(
      deriveSessionStatus(StreamingState.WaitingForConfirmation, false),
    ).toBe('waiting');
  });

  it('reports shell mode on an otherwise idle session', () => {
    expect(deriveSessionStatus(StreamingState.Idle, true)).toBe('shell');
  });

  it('lets model activity outrank shell mode', () => {
    // A peer asking "can this session take work now?" is answered by the agent
    // being mid-turn, whatever the prompt happens to be doing.
    expect(deriveSessionStatus(StreamingState.Responding, true)).toBe('busy');
    expect(
      deriveSessionStatus(StreamingState.WaitingForConfirmation, true),
    ).toBe('waiting');
  });
});

describe('useSessionRegistryStatus', () => {
  beforeEach(() => {
    refreshSessionRegistryEntry.mockReset();
  });

  it('[AC5] publishes the initial status once', async () => {
    await renderStatus({ state: StreamingState.Idle, shell: false });

    expect(refreshSessionRegistryEntry).toHaveBeenCalledTimes(1);
    expect(refreshSessionRegistryEntry).toHaveBeenCalledWith({ status: 'idle' });
  });

  it('[AC6] does not publish again when the status is unchanged', async () => {
    const { rerender } = await renderStatus({
      state: StreamingState.Idle,
      shell: false,
    });

    // The host component re-renders about once a second; a write per render
    // would touch a directory every peer on the machine scans.
    for (let i = 0; i < 20; i++) {
      rerender({ state: StreamingState.Idle, shell: false });
    }

    expect(refreshSessionRegistryEntry).toHaveBeenCalledTimes(1);
  });

  it('[AC5] publishes each transition exactly once', async () => {
    const { rerender } = await renderStatus({
      state: StreamingState.Idle,
      shell: false,
    });

    rerender({ state: StreamingState.Responding, shell: false });
    rerender({ state: StreamingState.Responding, shell: false });
    rerender({ state: StreamingState.WaitingForConfirmation, shell: false });
    rerender({ state: StreamingState.Idle, shell: true });

    expect(refreshSessionRegistryEntry.mock.calls.map(([arg]) => arg)).toEqual([
      { status: 'idle' },
      { status: 'busy' },
      { status: 'waiting' },
      { status: 'shell' },
    ]);
  });

  it('[AC6] ignores an input change that does not move the status', async () => {
    const { rerender } = await renderStatus({
      state: StreamingState.Responding,
      shell: false,
    });

    // Shell mode toggling under an active turn changes an input but not the
    // answer, so it must not reach the registry.
    rerender({ state: StreamingState.Responding, shell: true });
    rerender({ state: StreamingState.Responding, shell: false });

    expect(refreshSessionRegistryEntry).toHaveBeenCalledTimes(1);
    expect(refreshSessionRegistryEntry).toHaveBeenCalledWith({ status: 'busy' });
  });
});
