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
  workspaceSkills.mockResolvedValue({
    v: 1,
    workspaceCwd: '/w',
    initialized: true,
    skills: [{ name: 's' }],
  });
  workspaceExtensions.mockResolvedValue({
    v: 1,
    workspaceId: 'w',
    workspaceCwd: '/w',
    trusted: true,
    desiredGeneration: 0,
    appliedGeneration: 0,
    extensions: [],
  });
  workspaceChannels.mockResolvedValue({ revision: '0', instances: {} });
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
    hooks: [],
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
    expect(latest?.loading).toBe(false);
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
});
