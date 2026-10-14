/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalMode,
  Config,
  type ConfigParameters,
  type SessionRestoreProjection,
} from '@qwen-code/qwen-code-core';
import {
  applyRestoredSessionApprovalMode,
  recordDaemonSessionApprovalModeFromConfig,
} from './session-approval-mode-persistence.js';

function recordingProjection(
  mode: ApprovalMode,
  prePlanMode?: ApprovalMode,
  planExecutionMode?: ApprovalMode,
): SessionRestoreProjection {
  return {
    sessionId: 'session-1',
    filePath: '/tmp/session.jsonl',
    startTime: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    runtime: {
      apiHistory: [],
      uiTelemetryEvents: [],
      recording: {
        lastCompletedUuid: 'leaf',
        turnParentUuids: [null],
        sessionApprovalMode: {
          mode,
          ...(prePlanMode ? { prePlanMode } : {}),
          ...(planExecutionMode ? { planExecutionMode } : {}),
        },
      },
      goalRecords: [],
      initialTurn: 0,
      backgroundNotificationTaskIds: [],
    },
  };
}

function createConfig(overrides: Partial<ConfigParameters> = {}): Config {
  return new Config({
    targetDir: '.',
    cwd: '.',
    debugMode: false,
    model: 'test-model',
    chatRecording: false,
    approvalMode: ApprovalMode.DEFAULT,
    ...overrides,
  });
}

describe('session-approval-mode-persistence', () => {
  it('records the current Plan state with its predecessor', async () => {
    const config = createConfig();
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    config.setApprovalMode(ApprovalMode.YOLO);
    config.setApprovalMode(ApprovalMode.PLAN);
    const recordSessionApprovalMode = vi.fn().mockResolvedValue(true);
    vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
      recordSessionApprovalMode,
    } as never);

    await recordDaemonSessionApprovalModeFromConfig(config);

    expect(recordSessionApprovalMode).toHaveBeenCalledWith({
      mode: ApprovalMode.PLAN,
      prePlanMode: ApprovalMode.YOLO,
    });
  });

  it('restores a privileged mode in a currently trusted workspace', () => {
    const config = createConfig();
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

    applyRestoredSessionApprovalMode(
      config,
      recordingProjection(ApprovalMode.YOLO),
    );

    expect(config.getApprovalMode()).toBe(ApprovalMode.YOLO);
  });

  it('restores Plan with the saved predecessor', () => {
    const config = createConfig();
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

    applyRestoredSessionApprovalMode(
      config,
      recordingProjection(ApprovalMode.PLAN, ApprovalMode.YOLO),
    );

    expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
    expect(config.getPrePlanMode()).toBe(ApprovalMode.YOLO);
    config.setApprovalMode(config.getPrePlanMode(), {
      fromApprovedPlanExit: true,
    });
    expect(config.getApprovalMode()).toBe(ApprovalMode.YOLO);
  });

  it('restores a changed Plan execution mode without losing its predecessor', () => {
    const config = createConfig();
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    applyRestoredSessionApprovalMode(
      config,
      recordingProjection(
        ApprovalMode.PLAN,
        ApprovalMode.YOLO,
        ApprovalMode.AUTO_EDIT,
      ),
    );

    expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
    expect(config.getPrePlanMode()).toBe(ApprovalMode.YOLO);
    expect(config.getPlanExecutionMode()).toBe(ApprovalMode.AUTO_EDIT);
  });

  it('drops an untrusted Plan execution privilege while retaining safe Plan', () => {
    const config = createConfig();
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
    applyRestoredSessionApprovalMode(
      config,
      recordingProjection(
        ApprovalMode.PLAN,
        ApprovalMode.DEFAULT,
        ApprovalMode.YOLO,
      ),
    );

    expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
    expect(config.getPrePlanMode()).toBe(ApprovalMode.DEFAULT);
    expect(config.getPlanExecutionMode()).toBeUndefined();
  });

  it('does not queue a manual Plan-exit notice while restoring', () => {
    const config = createConfig({
      approvalMode: ApprovalMode.PLAN,
      sessionWorkflowEnabled: true,
    });
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
    config.setSessionWorkflowPlanRevision({
      planId: 'plan-1',
      sourceCallId: 'call-1',
      todoIds: ['todo-1'],
    });

    applyRestoredSessionApprovalMode(
      config,
      recordingProjection(ApprovalMode.DEFAULT),
    );

    expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
    expect(config.consumePendingManualPlanExitNotice()).toBe(false);
    expect(config.getSessionWorkflowPlanRevision()?.approved).toBeUndefined();
  });

  it('keeps the startup mode when trust rejects a saved privilege', () => {
    const config = createConfig();
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);

    applyRestoredSessionApprovalMode(
      config,
      recordingProjection(ApprovalMode.YOLO),
    );

    expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
  });

  it('restores Plan with a safe predecessor when trust rejects the saved one', () => {
    const config = createConfig();
    vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);

    applyRestoredSessionApprovalMode(
      config,
      recordingProjection(ApprovalMode.PLAN, ApprovalMode.YOLO),
    );

    expect(config.getApprovalMode()).toBe(ApprovalMode.PLAN);
    expect(config.getPrePlanMode()).toBe(ApprovalMode.DEFAULT);
  });

  it.each([{ bareMode: true }, { safeMode: true }])(
    'does not restore historical privileges under $bareMode/$safeMode startup policy',
    (policy) => {
      const config = createConfig(policy);
      vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);

      applyRestoredSessionApprovalMode(
        config,
        recordingProjection(ApprovalMode.YOLO),
      );

      expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
    },
  );

  it('does not fail cold restore when applying the recorded state throws', () => {
    const config = {
      getBareMode: vi.fn().mockReturnValue(false),
      isSafeMode: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.PLAN),
      setApprovalMode: vi.fn(() => {
        throw new Error('transition failed');
      }),
    } as unknown as Config;

    expect(() =>
      applyRestoredSessionApprovalMode(
        config,
        recordingProjection(ApprovalMode.PLAN, ApprovalMode.DEFAULT),
      ),
    ).not.toThrow();
  });
});
