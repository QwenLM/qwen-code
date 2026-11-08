/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel } from './internal/testUtils.js';
import { _setSandboxMountExistsForTest } from './workspacePaths.js';

// #7139 wiring for the bridge ingestion site: `resolveWorkspaceKey` guards
// with `path.isAbsolute` before canonicalizing, so a Windows-shaped
// `workspaceCwd` arriving via spawnOrAttach (clients, persisted
// registrations) must be translated to its bind mount first — the sibling
// of the dispatch/request-helpers/route/boot-validator wiring tests.
describe('bridge spawnOrAttach inside a POSIX container sandbox (#7139)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    _setSandboxMountExistsForTest(undefined);
  });

  it.skipIf(process.platform === 'win32')(
    'accepts a Windows-shaped workspaceCwd bound to its mount location',
    async () => {
      vi.stubEnv('SANDBOX', 'qwen-code-sandbox-0');
      _setSandboxMountExistsForTest((p) => p === '/c/qwen-repro');
      const handle = makeChannel();
      const bridge = makeBridge({
        boundWorkspace: '/c/qwen-repro',
        channelFactory: vi.fn().mockResolvedValue(handle.channel),
      });
      try {
        const session = await bridge.spawnOrAttach({
          workspaceCwd: 'C:\\qwen-repro',
        });
        expect(session.sessionId).toBeTruthy();
      } finally {
        await bridge.shutdown();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'still rejects a Windows-shaped workspaceCwd outside a sandbox',
    async () => {
      vi.stubEnv('SANDBOX', '');
      const handle = makeChannel();
      const bridge = makeBridge({
        boundWorkspace: '/c/qwen-repro',
        channelFactory: vi.fn().mockResolvedValue(handle.channel),
      });
      try {
        await expect(
          bridge.spawnOrAttach({ workspaceCwd: 'C:\\qwen-repro' }),
        ).rejects.toThrow('workspaceCwd must be an absolute path');
      } finally {
        await bridge.shutdown();
      }
    },
  );
});
