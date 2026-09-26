/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import { Config } from '../config/config.js';
import type { ManagedToolSession } from '../tools/managed-tool-session.js';

export function createManagedAgentTestConfig() {
  const sessions: ManagedToolSession[] = [];
  const factory = (): ManagedToolSession => {
    const session: ManagedToolSession = {
      sessionId: `managed-agent-${sessions.length}`,
      platform: 'darwin',
      shellConfiguration: {
        shell: 'bash',
        executable: 'bash',
        argsPrefix: ['-c'],
      },
      getClient: vi
        .fn()
        .mockRejectedValue(new Error('Unexpected Runtime acquire')),
      close: vi.fn().mockResolvedValue(undefined),
      createChild: factory,
    };
    sessions.push(session);
    return session;
  };
  const config = new Config({
    targetDir: '/tmp',
    cwd: '/tmp',
    debugMode: false,
    model: 'test-model',
    telemetry: { enabled: false },
    usageStatisticsEnabled: false,
    useRipgrep: false,
    managedToolSessionFactory: factory,
  });
  return { config, sessions };
}
