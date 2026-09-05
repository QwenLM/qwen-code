/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalMode,
  type Config,
  type SessionRestoreProjection,
} from '@qwen-code/qwen-code-core';
import { applyRestoredSessionApprovalMode } from './session-approval-mode-persistence.js';

function projection(
  sessionApprovalMode: NonNullable<
    SessionRestoreProjection['runtime']['recording']['sessionApprovalMode']
  >,
): SessionRestoreProjection {
  return {
    sessionId: 'session',
    filePath: '/tmp/session.jsonl',
    startTime: '2026-09-05T00:00:00.000Z',
    lastUpdated: '2026-09-05T00:00:00.000Z',
    runtime: {
      apiHistory: [],
      uiTelemetryEvents: [],
      recording: {
        lastCompletedUuid: 'record',
        turnParentUuids: [],
        sessionApprovalMode,
      },
      goalRecords: [],
      initialTurn: 0,
      backgroundNotificationTaskIds: [],
    },
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    isSafeMode: vi.fn(() => false),
    getBareMode: vi.fn(() => false),
    setApprovalMode: vi.fn(),
    restoreApprovalModeState: vi.fn(),
    ...overrides,
  } as unknown as Config;
}

describe('applyRestoredSessionApprovalMode', () => {
  it('restores a valid session value', () => {
    const target = config();
    const payload = {
      mode: ApprovalMode.PLAN,
      prePlanMode: ApprovalMode.AUTO_EDIT,
    };

    applyRestoredSessionApprovalMode(
      target,
      projection({ kind: 'valid', payload }),
    );

    expect(target.restoreApprovalModeState).toHaveBeenCalledWith(payload);
    expect(target.setApprovalMode).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid latest record', () => {
    const target = config();

    applyRestoredSessionApprovalMode(target, projection({ kind: 'invalid' }));

    expect(target.restoreApprovalModeState).toHaveBeenCalledWith({
      mode: ApprovalMode.DEFAULT,
    });
    expect(target.setApprovalMode).not.toHaveBeenCalled();
  });

  it('falls back to default when current policy rejects restored state', () => {
    const rejected = new Error('privileged mode rejected');
    const restoreApprovalModeState = vi
      .fn()
      .mockImplementationOnce(() => {
        throw rejected;
      })
      .mockImplementationOnce(() => undefined);
    const target = config({ restoreApprovalModeState });

    applyRestoredSessionApprovalMode(
      target,
      projection({
        kind: 'valid',
        payload: { mode: ApprovalMode.YOLO },
      }),
    );

    expect(restoreApprovalModeState).toHaveBeenNthCalledWith(1, {
      mode: ApprovalMode.YOLO,
    });
    expect(restoreApprovalModeState).toHaveBeenNthCalledWith(2, {
      mode: ApprovalMode.DEFAULT,
    });
  });

  it('keeps the restricted boot mode instead of restoring session state', () => {
    const target = config({ isSafeMode: vi.fn(() => true) });

    applyRestoredSessionApprovalMode(
      target,
      projection({
        kind: 'valid',
        payload: { mode: ApprovalMode.YOLO },
      }),
    );

    expect(target.restoreApprovalModeState).not.toHaveBeenCalled();
    expect(target.setApprovalMode).not.toHaveBeenCalled();
  });
});
