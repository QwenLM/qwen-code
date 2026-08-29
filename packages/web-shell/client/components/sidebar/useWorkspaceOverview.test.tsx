// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import {
  WORKSPACE_OVERVIEW_MAX_MISSES,
  WORKSPACE_OVERVIEW_POLL_MS,
  useWorkspaceOverview,
  type UseWorkspaceOverviewOptions,
  type WorkspaceOverviewResult,
} from './useWorkspaceOverview';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const workspaceMcp = vi.fn();
const workspaceSkills = vi.fn();
const workspaceExtensions = vi.fn();
const workspaceChannels = vi.fn();
const workspaceMemory = vi.fn();
const workspaceHooks = vi.fn();
const workspaceByCwd = vi.fn();

function makeClient(handle: Record<string, unknown>): DaemonClient {
  workspaceByCwd.mockImplementation(() => handle);
  return { workspaceByCwd } as unknown as DaemonClient;
}

const fullHandle = {
  workspaceMcp,
  workspaceSkills,
  workspaceExtensions,
  workspaceChannels,
  workspaceMemory,
  workspaceHooks,
};

function skillsStatus(count: number) {
  return {
    v: 1,
    workspaceCwd: '/w',
    initialized: true,
    skills: Array.from({ length: count }, (_, index) => ({
      name: `skill-${index}`,
    })),
  };
}

let root: Root;
let container: HTMLDivElement;
let latest: WorkspaceOverviewResult | undefined;

function Probe({
  client,
  cwd,
  options,
}: {
  client: DaemonClient;
  cwd: string | undefined;
  options: UseWorkspaceOverviewOptions;
}) {
  latest = useWorkspaceOverview(client, cwd, options);
  return null;
}

async function render(
  client: DaemonClient,
  cwd: string | undefined,
  options: UseWorkspaceOverviewOptions,
): Promise<void> {
  await act(async () => {
    root.render(<Probe client={client} cwd={cwd} options={options} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
  vi.clearAllMocks();
  workspaceMcp.mockResolvedValue({
    v: 1,
    workspaceCwd: '/w',
    initialized: true,
    discoveryState: 'completed',
    servers: [
      {
        kind: 'mcp_server',
        name: 'a',
        status: 'ok',
        transport: 'stdio',
        disabled: false,
        mcpStatus: 'connected',
      },
    ],
  });
  workspaceSkills.mockResolvedValue(skillsStatus(1));
  workspaceExtensions.mockResolvedValue({
    v: 1,
    workspaceId: 'w',
    workspaceCwd: '/w',
    trusted: true,
    desiredGeneration: 0,
    appliedGeneration: 0,
    extensions: [
      { extensionId: 'a', effectiveActivation: 'enabled' },
      { extensionId: 'b', effectiveActivation: 'disabled' },
    ],
  });
  workspaceChannels.mockResolvedValue({
    revision: '0',
    instances: { gh: { runtime: { state: 'connected' } } },
  });
  workspaceMemory.mockResolvedValue({
    v: 1,
    workspaceCwd: '/w',
    initialized: true,
    files: [],
    totalBytes: 0,
    fileCount: 2,
    ruleCount: 5,
  });
  workspaceHooks.mockResolvedValue({
    v: 1,
    workspaceCwd: '/w',
    initialized: true,
    disabled: false,
    hooks: [{ name: 'lint' }],
    events: {},
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe('useWorkspaceOverview', () => {
  it('does not fetch while disabled', async () => {
    await render(makeClient(fullHandle), '/w', { enabled: false });
    await flush();
    expect(workspaceByCwd).not.toHaveBeenCalled();
    expect(latest?.overview).toBeUndefined();
  });

  it('fetches only the requested facets', async () => {
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['mcp', 'context'],
    });
    await flush();
    expect(workspaceByCwd).toHaveBeenCalledWith('/w');
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
    expect(workspaceMemory).toHaveBeenCalledTimes(1);
    expect(workspaceSkills).not.toHaveBeenCalled();
    expect(workspaceExtensions).not.toHaveBeenCalled();
    expect(workspaceChannels).not.toHaveBeenCalled();
    expect(workspaceHooks).not.toHaveBeenCalled();
    expect(latest?.overview?.mcp).toMatchObject({
      configured: 1,
      connected: 1,
    });
    expect(latest?.overview?.context).toEqual({
      initialized: true,
      fileCount: 2,
      ruleCount: 5,
    });
    expect(latest?.overview?.skills).toBeUndefined();
    expect(latest?.overview?.extensions).toBeUndefined();
    expect(latest?.overview?.channels).toBeUndefined();
    expect(latest?.overview?.hooks).toBeUndefined();
  });

  it('maps the daemon-side and opt-in facets when requested', async () => {
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['extensions', 'channels', 'hooks'],
    });
    await flush();
    expect(workspaceExtensions).toHaveBeenCalledTimes(1);
    expect(workspaceChannels).toHaveBeenCalledTimes(1);
    expect(workspaceHooks).toHaveBeenCalledTimes(1);
    expect(workspaceMcp).not.toHaveBeenCalled();
    expect(latest?.overview).toMatchObject({
      extensions: { total: 2, active: 1 },
      channels: { configured: 1, connected: 1, failed: 0 },
      hooks: { initialized: true, count: 1, disabled: false },
    });
  });

  it('keeps other facets when one call fails and survives a missing method', async () => {
    workspaceSkills.mockRejectedValue(new Error('404'));
    const { workspaceMemory: _omit, ...withoutMemory } = fullHandle;
    await render(makeClient(withoutMemory), '/w', {
      enabled: true,
      items: ['mcp', 'skills', 'context'],
    });
    await flush();
    expect(latest?.overview?.mcp).toBeDefined();
    expect(latest?.overview?.skills).toBeUndefined();
    expect(latest?.overview?.context).toBeUndefined();
  });

  it('keeps other facets when one answers with a malformed body', async () => {
    // A reduced 200 body makes the summarizer throw; that facet stays
    // unknown and the healthy ones still land.
    workspaceChannels.mockResolvedValue({});
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['mcp', 'channels'],
    });
    await flush();
    expect(latest?.overview?.mcp).toBeDefined();
    expect(latest?.overview?.channels).toBeUndefined();
  });

  it('fetches a facet added to the requested set', async () => {
    const client = makeClient(fullHandle);
    await render(client, '/w', { enabled: true, items: ['mcp'] });
    await flush();
    expect(workspaceSkills).not.toHaveBeenCalled();
    await render(client, '/w', { enabled: true, items: ['mcp', 'skills'] });
    await flush();
    expect(workspaceSkills).toHaveBeenCalledTimes(1);
    expect(latest?.overview?.skills?.total).toBe(1);
    await render(client, '/w', { enabled: true, items: [] });
    await flush();
    expect(latest?.overview).toBeUndefined();
  });

  it('refetches for a new cwd and discards the old cwd round still in flight', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const oldMcp = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const newMcp = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/w2',
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    workspaceByCwd.mockImplementation((cwd: string) =>
      cwd === '/w2' ? { workspaceMcp: newMcp } : { workspaceMcp: oldMcp },
    );
    const client = { workspaceByCwd } as unknown as DaemonClient;
    await render(client, '/w', { enabled: true, items: ['mcp'] });
    await flush();
    expect(oldMcp).toHaveBeenCalledTimes(1);
    await render(client, '/w2', { enabled: true, items: ['mcp'] });
    await flush();
    expect(workspaceByCwd).toHaveBeenCalledWith('/w2');
    expect(latest?.overview?.mcp?.configured).toBe(0);
    await act(async () => {
      resolveOld({
        v: 1,
        workspaceCwd: '/w',
        initialized: true,
        discoveryState: 'completed',
        servers: [
          {
            kind: 'mcp_server',
            name: 'stale',
            status: 'ok',
            transport: 'stdio',
            disabled: false,
            mcpStatus: 'connected',
          },
        ],
      });
    });
    await flush();
    expect(latest?.overview?.mcp?.configured).toBe(0);
  });

  it('ignores an older round that lands after a newer one', async () => {
    let resolveSlow: (value: unknown) => void = () => {};
    workspaceSkills
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce(skillsStatus(2));
    const client = makeClient(fullHandle);
    await render(client, '/w', {
      enabled: true,
      items: ['skills'],
      reloadToken: 0,
    });
    await flush();
    expect(latest?.overview).toBeUndefined();
    // Round 2 (reload token) lands first.
    await render(client, '/w', {
      enabled: true,
      items: ['skills'],
      reloadToken: 1,
    });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(2);
    // Round 1 resolves late with older data and must not win.
    await act(async () => {
      resolveSlow(skillsStatus(1));
    });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(2);
  });

  it('drops a facet after consecutive unanswered rounds', async () => {
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['skills'],
      pollIntervalMs: 1_000,
    });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(1);
    workspaceSkills.mockRejectedValue(new Error('route gone'));
    for (let round = 1; round < WORKSPACE_OVERVIEW_MAX_MISSES; round += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      await flush();
      expect(latest?.overview?.skills?.total).toBe(1);
    }
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(latest?.overview?.skills).toBeUndefined();
    // A later answer restores it.
    workspaceSkills.mockResolvedValue(skillsStatus(4));
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(4);
  });

  it('never carries a facet from the previous cwd into the next one', async () => {
    const wMcp = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/w',
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const w2Mcp = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/w2',
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    workspaceByCwd.mockImplementation((cwd: string) =>
      cwd === '/w2'
        ? { workspaceMcp: w2Mcp, workspaceSkills }
        : { workspaceMcp: wMcp, workspaceSkills },
    );
    const client = { workspaceByCwd } as unknown as DaemonClient;
    await render(client, '/w', { enabled: true, items: ['mcp', 'skills'] });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(1);
    // The next workspace cannot answer skills at all.
    workspaceSkills.mockRejectedValue(new Error('no route'));
    await render(client, '/w2', { enabled: true, items: ['mcp', 'skills'] });
    await flush();
    expect(latest?.overview?.mcp).toBeDefined();
    expect(latest?.overview?.skills).toBeUndefined();
  });

  it('refetches as soon as it is enabled again', async () => {
    const client = makeClient(fullHandle);
    await render(client, '/w', { enabled: true, items: ['mcp'] });
    await flush();
    expect(latest?.overview?.mcp).toBeDefined();
    await render(client, '/w', { enabled: false, items: ['mcp'] });
    await flush();
    expect(latest?.overview).toBeUndefined();
    await render(client, '/w', { enabled: true, items: ['mcp'] });
    await flush();
    expect(workspaceMcp).toHaveBeenCalledTimes(2);
    expect(latest?.overview?.mcp).toBeDefined();
  });

  it('keeps the last known value of a facet across a transient failure', async () => {
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['skills'],
      pollIntervalMs: 1_000,
    });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(1);
    workspaceSkills.mockRejectedValueOnce(new Error('blip'));
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(workspaceSkills).toHaveBeenCalledTimes(2);
    expect(latest?.overview?.skills?.total).toBe(1);
  });

  it('lands a later successful round over the previous snapshot', async () => {
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['skills'],
      pollIntervalMs: 1_000,
    });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(1);
    workspaceSkills.mockResolvedValueOnce(skillsStatus(2));
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await flush();
    expect(latest?.overview?.skills?.total).toBe(2);
  });

  it('polls only while the document is visible and refetches on focus', async () => {
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['mcp'],
      pollIntervalMs: 1_000,
    });
    await flush();
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(workspaceMcp).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(workspaceMcp).toHaveBeenCalledTimes(3);
  });

  it('polls at the 30s default when no interval is given', async () => {
    await render(makeClient(fullHandle), '/w', {
      enabled: true,
      items: ['mcp'],
    });
    await flush();
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_OVERVIEW_POLL_MS - 1);
    });
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(workspaceMcp).toHaveBeenCalledTimes(2);
  });

  it('clears the snapshot and stops polling once disabled', async () => {
    const client = makeClient(fullHandle);
    await render(client, '/w', {
      enabled: true,
      items: ['mcp'],
      pollIntervalMs: 1_000,
    });
    await flush();
    expect(latest?.overview?.mcp).toBeDefined();
    await render(client, '/w', {
      enabled: false,
      items: ['mcp'],
      pollIntervalMs: 1_000,
    });
    await flush();
    expect(latest?.overview).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
  });

  it('drops a round still in flight when disabled before it lands', async () => {
    let resolveMcp: (value: unknown) => void = () => {};
    workspaceMcp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMcp = resolve;
        }),
    );
    const client = makeClient(fullHandle);
    await render(client, '/w', { enabled: true, items: ['mcp'] });
    await flush();
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
    expect(latest?.overview).toBeUndefined();
    await render(client, '/w', { enabled: false, items: ['mcp'] });
    await act(async () => {
      resolveMcp({
        v: 1,
        workspaceCwd: '/w',
        initialized: true,
        servers: [],
      });
    });
    await flush();
    expect(latest?.overview).toBeUndefined();
  });

  it('refetches when the reload token changes', async () => {
    const client = makeClient(fullHandle);
    await render(client, '/w', {
      enabled: true,
      items: ['mcp'],
      reloadToken: 0,
    });
    await flush();
    await render(client, '/w', {
      enabled: true,
      items: ['mcp'],
      reloadToken: 1,
    });
    await flush();
    expect(workspaceMcp).toHaveBeenCalledTimes(2);
  });

  it('does not refetch for a fresh but equal items array', async () => {
    const client = makeClient(fullHandle);
    await render(client, '/w', { enabled: true, items: ['mcp', 'skills'] });
    await flush();
    await render(client, '/w', { enabled: true, items: ['skills', 'mcp'] });
    await flush();
    await render(client, '/w', { enabled: true, items: ['mcp', 'skills'] });
    await flush();
    expect(workspaceMcp).toHaveBeenCalledTimes(1);
    expect(workspaceSkills).toHaveBeenCalledTimes(1);
  });
});
