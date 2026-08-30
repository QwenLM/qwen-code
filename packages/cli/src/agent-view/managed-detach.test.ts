/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detachCurrentSessionToAgentView } from './managed-detach.js';

describe('detachCurrentSessionToAgentView', () => {
  it('asks the supervisor to adopt the current idle session', async () => {
    const globalDir = '/tmp/qwen-agent-view-detach';
    const adopt = vi.fn(async () => ({ sessionId, adopted: true }));
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const config = {
      getSessionId: () => sessionId,
      getProjectRoot: () => path.join(globalDir, 'project'),
      getTargetDir: () => path.join(globalDir, 'project', 'src'),
      getApprovalMode: () => 'default',
      getSandbox: () => undefined,
    };

    const result = await detachCurrentSessionToAgentView(config, {
      globalDir,
      terminal: { columns: 100, rows: 40 },
      ensureSupervisor: async () => ({
        adopt,
      }),
    });

    expect(result).toEqual({ sessionId });
    expect(adopt).toHaveBeenCalledWith({
      sessionId,
      projectCwd: path.resolve(globalDir, 'project'),
      activeCwd: path.resolve(globalDir, 'project', 'src'),
      approvalMode: 'default',
      sandbox: undefined,
      terminal: { columns: 100, rows: 40 },
    });
  });

  it('does not stringify a missing approval mode', async () => {
    const adopt = vi.fn(async () => ({ sessionId, adopted: true }));
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const config = {
      getSessionId: () => sessionId,
      getProjectRoot: () => '/project',
      getTargetDir: () => '/project',
      getApprovalMode: () => undefined,
      getSandbox: () => undefined,
    };

    await detachCurrentSessionToAgentView(config, {
      ensureSupervisor: async () => ({ adopt }),
    });

    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: undefined,
      }),
    );
  });

  it('passes a string sandbox mode through without JSON quoting', async () => {
    const adopt = vi.fn(async () => ({ sessionId, adopted: true }));
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const config = {
      getSessionId: () => sessionId,
      getProjectRoot: () => '/project',
      getTargetDir: () => '/project',
      getApprovalMode: () => undefined,
      getSandbox: () => 'linux',
    };

    await detachCurrentSessionToAgentView(config, {
      ensureSupervisor: async () => ({ adopt }),
    });

    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: 'linux',
      }),
    );
  });

  it('does not stringify a null sandbox mode', async () => {
    const adopt = vi.fn(async () => ({ sessionId, adopted: true }));
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const config = {
      getSessionId: () => sessionId,
      getProjectRoot: () => '/project',
      getTargetDir: () => '/project',
      getApprovalMode: () => undefined,
      getSandbox: () => null,
    };

    await detachCurrentSessionToAgentView(config, {
      ensureSupervisor: async () => ({ adopt }),
    });

    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: undefined,
      }),
    );
  });

  it('JSON-stringifies an object sandbox config', async () => {
    const adopt = vi.fn(async () => ({ sessionId, adopted: true }));
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const config = {
      getSessionId: () => sessionId,
      getProjectRoot: () => '/project',
      getTargetDir: () => '/project',
      getApprovalMode: () => undefined,
      getSandbox: () => ({ command: 'docker', image: 'qwen-sandbox' }),
    };

    await detachCurrentSessionToAgentView(config, {
      ensureSupervisor: async () => ({ adopt }),
    });

    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: '{"command":"docker","image":"qwen-sandbox"}',
      }),
    );
  });
});
