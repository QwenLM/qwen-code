/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  managedCapabilitiesToDaemon,
  managedPhaseToConnectionStatus,
  managedSessionToConnection,
} from './managed-connection-adapter.js';
import type { ManagedAgentSessionSummary } from './managed-agent-provider.js';

function summary(
  patch: Partial<ManagedAgentSessionSummary> = {},
): ManagedAgentSessionSummary {
  return {
    sessionId: 's1',
    title: '会话标题',
    createdAt: 1,
    admittedAt: 1,
    updatedAt: 2,
    phase: 'completed',
    runtimeReady: true,
    runtimeState: 'ready',
    approvalMode: 'yolo',
    agentId: 'qwen-code',
    workspace: { workspaceId: 'w1', cwdRelative: '.', state: 'ready' },
    capabilities: { canSend: true, canCancel: true },
    ...patch,
  } as ManagedAgentSessionSummary;
}

describe('managedPhaseToConnectionStatus', () => {
  it('无 summary 时为 idle', () => {
    expect(managedPhaseToConnectionStatus(undefined)).toBe('idle');
  });

  it('运行时就绪即 connected，不因某轮结束而误判断连', () => {
    expect(managedPhaseToConnectionStatus(summary({ phase: 'completed' }))).toBe(
      'connected',
    );
    expect(
      managedPhaseToConnectionStatus(summary({ phase: 'agent_running' })),
    ).toBe('connected');
  });

  it('已受理但运行时未就绪时为 connecting', () => {
    for (const phase of [
      'created',
      'admitted',
      'runtime_starting',
      'waiting_runtime',
    ] as const) {
      expect(
        managedPhaseToConnectionStatus(
          summary({ phase, runtimeReady: false }),
        ),
      ).toBe('connecting');
    }
  });

  it('failed 映射为 error', () => {
    expect(managedPhaseToConnectionStatus(summary({ phase: 'failed' }))).toBe(
      'error',
    );
  });
});

describe('managedCapabilitiesToDaemon', () => {
  it('无 capabilities 时返回 undefined，让 ChatPane 走缺省', () => {
    expect(managedCapabilitiesToDaemon(undefined)).toBeUndefined();
  });

  it('后端声明的能力翻译成 feature tag', () => {
    const caps = managedCapabilitiesToDaemon({
      canSend: true,
      canCancel: true,
      inputAttachments: true,
    });
    expect(caps?.features).toContain('session_attachments');
    expect(caps?.features).toContain('session_generation');
    expect(caps?.mode).toBe('http-bridge');
  });

  it('未声明或 false 的能力不加入 features，不伪造支持', () => {
    const caps = managedCapabilitiesToDaemon({
      canSend: false,
      canCancel: false,
      inputAttachments: false,
      modelChange: false,
    });
    expect(caps?.features).toEqual([]);
  });

  it('Managed 无轮内插话协议，永不加入 mid-turn tag', () => {
    const caps = managedCapabilitiesToDaemon({ canSend: true, canCancel: true });
    expect(caps?.features).not.toContain('session_mid_turn_send_now');
  });
});

describe('managedSessionToConnection', () => {
  it('映射 ChatPane 需要的核心字段', () => {
    const c = managedSessionToConnection({
      summary: summary(),
      sessionId: 's1',
      currentModel: 'qwen3-max',
      skills: ['skill-a'],
    });
    expect(c.sessionId).toBe('s1');
    expect(c.workspaceCwd).toBe('.');
    expect(c.displayName).toBe('会话标题');
    expect(c.currentMode).toBe('yolo');
    expect(c.currentModel).toBe('qwen3-max');
    expect(c.skills).toEqual(['skill-a']);
    expect(c.status).toBe('connected');
  });

  it('summary 未返回时保留宿主选中的 sessionId，供 ChatPane 显示 loading', () => {
    const c = managedSessionToConnection({
      summary: undefined,
      sessionId: 'pending',
      loadingTranscript: true,
    });
    expect(c.sessionId).toBe('pending');
    expect(c.status).toBe('idle');
    expect(c.loadingTranscript).toBe(true);
  });

  it('Managed 无对应语义的字段留空，不塞占位值', () => {
    const c = managedSessionToConnection({ summary: summary(), sessionId: 's1' });
    expect(c.goalState).toBeUndefined();
    expect(c.backgroundTurn).toBeUndefined();
    expect(c.planExecutionMode).toBeUndefined();
    expect(c.gitBranch).toBeUndefined();
    expect(c.gitStatus).toBeUndefined();
    expect(c.tokenUsage).toBeUndefined();
  });

  it('失败会话收敛发送入口并透出错误文本', () => {
    const c = managedSessionToConnection({
      summary: summary({
        phase: 'failed',
        failure: { code: 'X', message: '运行时失败' },
      }),
      sessionId: 's1',
    });
    expect(c.runtimeStopped).toBe(true);
    expect(c.error).toBe('运行时失败');
  });

  it('后端确认会话缺失时如实标记 missingSession', () => {
    const c = managedSessionToConnection({
      summary: summary(),
      sessionId: 's1',
      missingSession: true,
    });
    expect(c.missingSession).toBe(true);
  });
});