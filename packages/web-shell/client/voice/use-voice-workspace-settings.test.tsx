/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { useVoiceWorkspaceSettings } from './use-voice-workspace-settings';
import type { VoiceWorkspaceTarget } from './voice-workspace-target';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const targetA: VoiceWorkspaceTarget = {
  route: 'workspace-qualified',
  cwd: '/a',
  workspaceKey: 'a',
  ownerKey: 'a:session',
  sessionId: 'session-a',
  selector: { kind: 'id', value: 'a' },
  streamPath: 'workspaces/a/voice/stream',
};
const targetB: VoiceWorkspaceTarget = {
  route: 'workspace-qualified',
  cwd: '/b',
  workspaceKey: 'b',
  ownerKey: 'b:session',
  sessionId: 'session-b',
  selector: { kind: 'id', value: 'b' },
  streamPath: 'workspaces/b/voice/stream',
};

function settings(value: string) {
  return {
    v: 1 as const,
    settings: [
      {
        key: 'voiceModel',
        type: 'string',
        label: 'Voice model',
        category: 'model',
        requiresRestart: false,
        default: '',
        values: { effective: value, workspace: value },
      },
    ],
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let currentTarget: VoiceWorkspaceTarget | undefined;
let currentRevision = '0';
let result: ReturnType<typeof useVoiceWorkspaceSettings> | undefined;
const workspaceSettingsA = vi.fn();
const workspaceSettingsB = vi.fn();
const client = {
  workspaceById: vi.fn((id: string) => ({
    workspaceSettings: id === 'a' ? workspaceSettingsA : workspaceSettingsB,
  })),
} as unknown as DaemonClient;

function Host() {
  result = useVoiceWorkspaceSettings(
    client,
    currentTarget,
    true,
    currentRevision,
  );
  return null;
}

async function render() {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(<Host />);
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  result = undefined;
  currentTarget = undefined;
  currentRevision = '0';
  workspaceSettingsA.mockReset();
  workspaceSettingsB.mockReset();
});

describe('useVoiceWorkspaceSettings', () => {
  it('loads only the qualified Voice descriptor', async () => {
    currentTarget = targetA;
    workspaceSettingsA.mockResolvedValue(settings('voice-a'));

    await render();

    expect(result?.descriptor?.values.effective).toBe('voice-a');
    expect(workspaceSettingsA).toHaveBeenCalledOnce();
  });

  it('keeps the current descriptor visible during a same-owner refresh', async () => {
    workspaceSettingsA.mockResolvedValueOnce(settings('voice-a'));
    currentTarget = targetA;
    await render();
    expect(result?.descriptor?.values.effective).toBe('voice-a');

    let resolveRefresh: (value: ReturnType<typeof settings>) => void = () =>
      undefined;
    workspaceSettingsA.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    currentRevision = '1';
    await render();
    expect(result?.descriptor?.values.effective).toBe('voice-a');

    await act(async () => {
      resolveRefresh(settings('new-a'));
      await Promise.resolve();
    });
    expect(result?.descriptor?.values.effective).toBe('new-a');
  });

  it('rejects stale A to B to A responses by request generation', async () => {
    let resolveFirstA: (value: ReturnType<typeof settings>) => void = () =>
      undefined;
    workspaceSettingsA
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstA = resolve;
        }),
      )
      .mockResolvedValueOnce(settings('new-a'));
    workspaceSettingsB.mockResolvedValue(settings('voice-b'));
    currentTarget = targetA;
    await render();

    currentTarget = targetB;
    await render();
    expect(result?.descriptor?.values.effective).toBe('voice-b');

    currentTarget = targetA;
    currentRevision = '1';
    await render();
    expect(result?.descriptor?.values.effective).toBe('new-a');

    await act(async () => {
      resolveFirstA(settings('stale-a'));
      await Promise.resolve();
    });
    expect(result?.descriptor?.values.effective).toBe('new-a');
  });

  it('does not let an old target reload invalidate the current target', async () => {
    currentTarget = targetA;
    workspaceSettingsA.mockResolvedValue(settings('voice-a'));
    await render();
    const reloadA = result?.reload;
    if (!reloadA) throw new Error('target A reload was not available');

    workspaceSettingsB.mockResolvedValue(settings('voice-b'));
    currentTarget = targetB;
    await render();
    expect(result?.descriptor?.values.effective).toBe('voice-b');

    await act(async () => {
      await reloadA();
    });

    expect(workspaceSettingsA).toHaveBeenCalledOnce();
    expect(result?.descriptor?.values.effective).toBe('voice-b');
  });
});
