/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, AgentSideConnection } from '@agentclientprotocol/sdk';
import { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import {
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
} from '@qwen-code/acp-bridge/status';
import { expect, it, vi } from 'vitest';
import type { CliArgs } from '../config/config.js';
import { LoadedSettings } from '../config/settings.js';
import { runAcpAgent } from './acpAgent.js';
import { Session } from './session/Session.js';

const transport = vi.hoisted(() => {
  let close = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    agent: undefined as Agent | undefined,
    close,
    closed,
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    extNotification: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentclientprotocol/sdk')>()),
  AgentSideConnection: class {
    closed = transport.closed;
    sessionUpdate = transport.sessionUpdate;
    extNotification = transport.extNotification;

    constructor(factory: (connection: AgentSideConnection) => Agent) {
      transport.agent = factory(this as unknown as AgentSideConnection);
    }
  },
}));

vi.mock('@qwen-code/acp-bridge/ndJsonStream', () => ({
  ndJsonStream: vi.fn(),
}));

it('carries real Config Plan policy through ACP control, context and mode notifications', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-plan-config-'));
  vi.stubEnv('QWEN_HOME', directory);
  vi.stubEnv('QWEN_RUNTIME_DIR', directory);
  vi.stubEnv('QWEN_SERVE_NO_MCP_POOL', '1');
  const originalConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
  };
  const config = new Config({
    sessionId: 'dac-plan-config',
    cwd: directory,
    targetDir: directory,
    debugMode: false,
    model: 'test-model',
    trustedFolder: true,
    approvalMode: ApprovalMode.DEFAULT,
    chatRecording: false,
    usageStatisticsEnabled: false,
    telemetry: { enabled: false },
    overrideExtensions: [],
  });
  const settingsFile = {
    path: join(directory, 'settings.json'),
    settings: {},
    originalSettings: {},
  };
  const settings = new LoadedSettings(
    settingsFile,
    settingsFile,
    settingsFile,
    settingsFile,
    true,
    new Set(),
  );
  // No model or MCP initialization is needed for the ACP control surface.
  vi.spyOn(config, 'initialize').mockResolvedValue(undefined);
  const running = runAcpAgent(config, settings, {} as CliArgs);
  let session: Session | undefined;
  try {
    await vi.waitFor(() => expect(transport.agent).toBeDefined());
    const agent = transport.agent!;
    session = new Session(
      config.getSessionId(),
      config,
      transport as unknown as AgentSideConnection,
      settings,
    );
    // Install the fixture at the same registry consumed by the real ext routes.
    (agent as unknown as { sessions: Map<string, Session> }).sessions.set(
      config.getSessionId(),
      session,
    );
    for (const [planMode, policy] of [
      [true, ApprovalMode.YOLO],
      [true, ApprovalMode.AUTO_EDIT],
      [false, ApprovalMode.AUTO_EDIT],
    ] as const) {
      const result = await agent.extMethod!(
        SERVE_CONTROL_EXT_METHODS.sessionApprovalMode,
        { sessionId: config.getSessionId(), mode: policy, planMode },
      );
      const mode = planMode ? ApprovalMode.PLAN : policy;
      expect(config.getApprovalMode()).toBe(mode);
      expect(config.getPlanExecutionMode()).toBe(planMode ? policy : undefined);
      expect(result).toMatchObject({ current: mode });
      expect(result['planExecutionMode']).toBe(planMode ? policy : undefined);
      const context = await agent.extMethod!(
        SERVE_STATUS_EXT_METHODS.sessionContext,
        { sessionId: config.getSessionId() },
      );
      expect(context).toMatchObject({
        state: {
          modes: {
            currentModeId: mode,
            ...(planMode ? { _meta: { planExecutionMode: policy } } : {}),
          },
        },
      });
      if (!planMode) {
        expect(context).not.toHaveProperty(
          'state.modes._meta.planExecutionMode',
        );
      }
      await session.setMode({ sessionId: config.getSessionId(), modeId: mode });
      const notification = transport.extNotification.mock.lastCall;
      expect(notification?.[0]).toBe('qwen/notify/session/mode-update');
      expect(notification?.[1]).toMatchObject({ currentModeId: mode });
      expect(notification?.[1]['planExecutionMode']).toBe(
        planMode ? policy : undefined,
      );
    }
  } finally {
    transport.close();
    await running;
    await config.shutdown({ shutdownTelemetry: false });
    Object.assign(console, originalConsole);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
