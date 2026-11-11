/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_DISCOVERY_WAIT_MS,
  waitForScriptMcpServers,
} from '../codemode/host.js';
import type { Config } from '../config/config.js';

describe('waiting for MCP discovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the servers a script references, or all of them for discovery', async () => {
    const whenDiscovered = vi.fn(async () => {});
    const config = {
      getMcpClientManager: () => ({ whenDiscovered }),
    } as unknown as Config;
    const signal = new AbortController().signal;
    await waitForScriptMcpServers(config, 'text(1);', signal);
    expect(whenDiscovered).not.toHaveBeenCalled();
    await waitForScriptMcpServers(
      config,
      'await tools.mcp__dev_docs__search({}); await tools["mcp__github__get_file"]({});',
      signal,
    );
    expect(whenDiscovered).toHaveBeenLastCalledWith(['dev_docs', 'github']);
    await waitForScriptMcpServers(config, 'await searchTools("x");', signal);
    expect(whenDiscovered).toHaveBeenLastCalledWith(undefined);
  });

  it('stops waiting after the bound or when the script is cancelled', async () => {
    vi.useFakeTimers();
    const config = {
      getMcpClientManager: () => ({
        whenDiscovered: () => new Promise<void>(() => {}),
      }),
    } as unknown as Config;
    const bounded = waitForScriptMcpServers(
      config,
      'ALL_TOOLS',
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(MCP_DISCOVERY_WAIT_MS);
    await expect(bounded).resolves.toBeUndefined();
    const controller = new AbortController();
    const cancelled = waitForScriptMcpServers(config, 'ALL_TOOLS', controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toBeUndefined();
  });
});
