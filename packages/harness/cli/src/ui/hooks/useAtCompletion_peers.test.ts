/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { cleanupTmpDir, createTmpDir } from '@qwen-code/core/test-utils';
import type { Config, LivePeerSession, PeerEntry } from '@qwen-code/core';
import type { Suggestion } from '../components/SuggestionsDisplay.js';

const mocks = vi.hoisted(() => ({
  listAllPeers: vi.fn(),
  isCrossSessionMessagingEnabled: vi.fn(() => true),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    listAllPeers: mocks.listAllPeers,
    isCrossSessionMessagingEnabled: mocks.isCrossSessionMessagingEnabled,
  };
});

const { useAtCompletion } = await import('./useAtCompletion.js');
const { resetPeerRosterForTesting } = await import('./peerRoster.js');
const { baseNameForSession, displayNameForSession, peerHandle, shortRef } =
  await import('@qwen-code/core');

function peer(name: string, socketPath: string): PeerEntry {
  const live: LivePeerSession = {
    pid: 100,
    procStart: 0,
    startedAt: Date.now() - 180_000,
    cwd: '/home/dev/project',
    messagingSocketPath: socketPath,
    peerProtocol: 1,
    kind: 'interactive',
    status: 'idle',
    name,
  };
  return {
    transport: 'uds',
    address: `uds:${socketPath}`,
    session: live,
    baseName: baseNameForSession(live),
    displayName: displayNameForSession(live),
    handle: peerHandle(socketPath),
    ref: shortRef('session', socketPath),
  };
}

function useHarness(
  pattern: string,
  config: Config,
  cwd: string,
  peerMentionsEnabled = true,
) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [, setIsLoadingSuggestions] = useState(false);
  useAtCompletion({
    enabled: true,
    pattern,
    config,
    cwd,
    peerMentionsEnabled,
    setSuggestions,
    setIsLoadingSuggestions,
  });
  return { suggestions };
}

describe('useAtCompletion with peer sessions', () => {
  let testRootDir: string;
  let mockConfig: Config;

  beforeEach(async () => {
    resetPeerRosterForTesting();
    mocks.listAllPeers.mockReset();
    mocks.listAllPeers.mockResolvedValue([peer('reviewer', '/tmp/1.sock')]);
    mocks.isCrossSessionMessagingEnabled.mockReturnValue(true);

    testRootDir = await createTmpDir({});
    mockConfig = {
      getFileFilteringOptions: vi.fn(() => ({
        respectGitIgnore: true,
        respectBrandIgnore: true,
      })),
      getEnableRecursiveFileSearch: () => true,
      getFileFilteringDisableFuzzySearch: () => false,
      getFileFilteringEnableFuzzySearch: () => true,
      getAgentsSettings: () => ({}),
      getMcpClientManager: vi.fn().mockReturnValue({
        getResources: () => [],
      }),
      getAgentRegistry: () => ({ getAllDefinitions: () => [] }),
    } as unknown as Config;
  });

  afterEach(async () => {
    resetPeerRosterForTesting();
    if (testRootDir) await cleanupTmpDir(testRootDir);
    vi.restoreAllMocks();
  });

  it('[AC4] shows the peer once the first roster load lands', async () => {
    // The roster is cold on the first keystroke, so the row can only appear if
    // the load that the search itself kicked off replays the completion.
    const { result } = await renderHook(() =>
      useHarness('rev', mockConfig, testRootDir),
    );

    await waitFor(() => {
      expect(
        result.current.suggestions.some((s) => s.value === 'reviewer'),
      ).toBe(true);
    });

    const row = result.current.suggestions.find((s) => s.value === 'reviewer');
    expect(row?.description).toContain('session');
  });

  it('[AC2] offers no peer rows, and no listing, for the bare @', async () => {
    const { result } = await renderHook(() =>
      useHarness('', mockConfig, testRootDir),
    );

    await waitFor(() => {
      expect(result.current.suggestions).toBeDefined();
    });

    expect(result.current.suggestions.some((s) => s.value === 'reviewer')).toBe(
      false,
    );
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('offers no peer rows when the surface cannot act on them', async () => {
    // Remote-controller mode: submit never reaches the local attachment
    // pipeline, so a row here would insert a token nothing acts on.
    const { result } = await renderHook(() =>
      useHarness('rev', mockConfig, testRootDir, false),
    );

    await waitFor(() => {
      expect(result.current.suggestions).toBeDefined();
    });

    expect(result.current.suggestions.some((s) => s.value === 'reviewer')).toBe(
      false,
    );
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC1] offers no peer rows, and no listing, when the gate is closed', async () => {
    mocks.isCrossSessionMessagingEnabled.mockReturnValue(false);

    const { result } = await renderHook(() =>
      useHarness('rev', mockConfig, testRootDir),
    );

    await waitFor(() => {
      expect(result.current.suggestions).toBeDefined();
    });

    expect(result.current.suggestions.some((s) => s.value === 'reviewer')).toBe(
      false,
    );
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });
});
