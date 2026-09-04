/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonCapabilities,
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  createLocalFilesRewarm,
  resolveLocalFilesWorkspaceSelector,
} from './LocalFilesControl';

const primary = {
  id: 'ws-1',
  cwd: '/primary',
  kind: 'directory',
  primary: true,
  trusted: true,
} as unknown as DaemonWorkspaceCapability;

const locked = {
  id: 'locked-ws',
  cwd: '/locked',
  kind: 'directory',
  primary: false,
  trusted: true,
} as unknown as DaemonWorkspaceCapability;

const capabilities = {
  qwenCodeVersion: '1.2.3',
  workspaceCwd: '/primary',
  features: ['dynamic_workspace_registration'],
  workspaces: [primary],
} as unknown as DaemonCapabilities;

describe('resolveLocalFilesWorkspaceSelector', () => {
  it('resolves a locked workspace only from the merged list', () => {
    const base = {
      capabilities,
      workspaceCwd: '/locked',
      sessionId: 'session-1',
    };
    // The bare snapshot lacks the locked entry: both sibling voice call sites
    // pass the merged list for exactly this reason.
    expect(resolveLocalFilesWorkspaceSelector(base)).toBeUndefined();
    expect(
      resolveLocalFilesWorkspaceSelector({
        ...base,
        workspaces: [primary, locked],
      }),
    ).toEqual({ kind: 'id', value: 'locked-ws' });
  });

  it('keeps the legacy route for the primary workspace', () => {
    expect(
      resolveLocalFilesWorkspaceSelector({
        capabilities,
        workspaces: [primary, locked],
        workspaceCwd: '/primary',
        sessionId: 'session-1',
      }),
    ).toBeUndefined();
  });
});

describe('createLocalFilesRewarm', () => {
  it('warms the qualified runtime for a secondary selector', async () => {
    const ensureRuntime = vi.fn().mockResolvedValue({});
    const workspaceById = vi.fn(() => ({ ensureRuntime }));
    const client = { workspaceById } as unknown as DaemonClient;
    const preheat = vi.fn();

    await createLocalFilesRewarm({
      client,
      selector: { kind: 'id', value: 'ws-2' },
      preheat,
    })();

    expect(workspaceById).toHaveBeenCalledWith('ws-2');
    expect(ensureRuntime).toHaveBeenCalled();
    expect(preheat).not.toHaveBeenCalled();
  });

  it('falls back to the legacy preheat without a selector or on route failure', async () => {
    const ensureRuntime = vi.fn().mockRejectedValue(new Error('no route'));
    const client = {
      workspaceById: vi.fn(() => ({ ensureRuntime })),
    } as unknown as DaemonClient;
    const preheat = vi.fn();

    await createLocalFilesRewarm({
      client,
      selector: { kind: 'id', value: 'ws-2' },
      preheat,
    })();
    expect(preheat).toHaveBeenCalledTimes(1);

    await createLocalFilesRewarm({ client, selector: undefined, preheat })();
    expect(preheat).toHaveBeenCalledTimes(2);
  });
});
