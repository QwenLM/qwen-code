/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { BridgeExecutionSelection } from '@qwen-code/acp-bridge/bridgeOptions';
import { createManagedExecutionEngine } from './managed-execution-engine.js';

function spawnSelection(workspaceCwd: string): BridgeExecutionSelection {
  return {
    daemonOwnedStandalone: false,
    operation: 'spawn',
    request: { workspaceCwd },
  } as BridgeExecutionSelection;
}

describe('createManagedExecutionEngine', () => {
  it('evaluates the compatibility of the workspace the selector names', async () => {
    const engine = createManagedExecutionEngine({
      legacy: {},
      host: {
        workspaceCwd: process.cwd(),
        workspaceTrusted: false,
        environment: {},
        forwardedArgs: [],
        hasLiveMcpServers: () => false,
      },
    });

    await expect(
      engine.evaluate(spawnSelection(process.cwd())),
    ).resolves.toEqual({
      status: 'deferred',
      reason: 'the workspace is not trusted',
    });
  });

  it('keeps a session out of Managed while the runtime holds an added MCP server', async () => {
    const engine = createManagedExecutionEngine({
      legacy: {},
      host: {
        workspaceCwd: process.cwd(),
        workspaceTrusted: true,
        environment: {},
        forwardedArgs: [],
        hasLiveMcpServers: () => true,
      },
    });

    await expect(
      engine.evaluate(spawnSelection(process.cwd())),
    ).resolves.toEqual({
      status: 'deferred',
      reason: 'MCP servers were added to the running workspace',
    });
  });
});
