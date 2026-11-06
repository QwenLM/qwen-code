/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';

describe('DaemonClient workspace management', () => {
  it('activates a subscription without replacing the selected workspace model', async () => {
    const activation = {
      authType: 'qwen-subscription',
      modelId: null,
      runtimeSync: { status: 'applied' },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(activation));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(
      client
        .workspaceById('secondary')
        .activateSubscription({ preserveModel: true }),
    ).resolves.toEqual(activation);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://daemon/workspaces/secondary/auth/subscription',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ preserveModel: true }),
      }),
    );
  });

  it('sends the exact scratch request and parses the workspace response', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'scratch-id',
          cwd: '/managed/scratch-Ab3',
          primary: false,
          trusted: true,
          persisted: false,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const result = await client.addScratchWorkspace();

    expect(result.cwd).toBe('/managed/scratch-Ab3');
    expect(fetch).toHaveBeenCalledWith(
      'http://daemon/workspaces',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'scratch' }),
      }),
    );
  });
});
