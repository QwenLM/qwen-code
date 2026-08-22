/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  uiTelemetryService,
  type Config,
  type UiTelemetryReplaySnapshot,
} from '@qwen-code/qwen-code-core';
import { restoreTelemetryReplay } from './telemetry-rollback.js';

describe('restoreTelemetryReplay', () => {
  const makeConfig = (warn: ReturnType<typeof vi.fn>) =>
    ({
      getDebugLogger: () => ({ warn }),
    }) as unknown as Config;

  it('restores the snapshot on the telemetry service', () => {
    const snapshot = {
      sessionId: 'session-a',
    } as unknown as UiTelemetryReplaySnapshot;
    const restore = vi
      .spyOn(uiTelemetryService, 'restoreFromReplaySnapshot')
      .mockImplementation(() => {});
    const warn = vi.fn();

    restoreTelemetryReplay(snapshot, makeConfig(warn), '/resume');

    expect(restore).toHaveBeenCalledWith(snapshot);
    expect(warn).not.toHaveBeenCalled();

    restore.mockRestore();
  });

  it('logs and swallows restore failures so the rollback is not blocked', () => {
    const snapshot = {
      sessionId: 'session-a',
    } as unknown as UiTelemetryReplaySnapshot;
    const restore = vi
      .spyOn(uiTelemetryService, 'restoreFromReplaySnapshot')
      .mockImplementation(() => {
        throw new Error('restore boom');
      });
    const warn = vi.fn();

    expect(() =>
      restoreTelemetryReplay(snapshot, makeConfig(warn), '/branch'),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Telemetry rollback after failed /branch init'),
    );

    restore.mockRestore();
  });
});
