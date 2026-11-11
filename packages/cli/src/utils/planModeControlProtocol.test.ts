/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  coreEvents,
  type Config,
} from '@qwen-code/core';
import {
  buildPlanModeSnapshot,
  installPlanModeEventBridge,
  setSdkPlanMode,
} from './planModeControlProtocol.js';

function makeConfig(options?: {
  active?: boolean;
  permissionMode?: 'default' | 'acceptEdits' | 'dontAsk';
  enabled?: boolean;
}) {
  let active = options?.active ?? false;
  const calls: string[] = [];
  const config = {
    isPlanMode: vi.fn(() => active),
    isPlanEnabled: vi.fn(() => options?.enabled ?? true),
    getPermissionMode: vi.fn(() => options?.permissionMode ?? 'default'),
    planStateManager: {
      get isActive() {
        return active;
      },
      enter: vi.fn(() => {
        calls.push('enter');
        active = true;
      }),
      exit: vi.fn(() => {
        calls.push('exit');
        active = false;
      }),
    },
    resetPreApprovedPrompts: vi.fn(() => calls.push('reset')),
    notifyPlanStateChanged: vi.fn(() => calls.push('notify')),
  } as unknown as Config;
  return { config, calls };
}

describe('Plan Mode SDK control protocol', () => {
  it('enters and exits Plan Mode without changing permission mode', () => {
    const { config, calls } = makeConfig({
      permissionMode: 'acceptEdits',
    });

    expect(setSdkPlanMode(config, true)).toEqual({ active: true });
    expect(config.getPermissionMode()).toBe('acceptEdits');
    expect(calls).toEqual(['enter', 'reset', 'notify']);

    calls.length = 0;
    expect(setSdkPlanMode(config, false)).toEqual({ active: false });
    expect(config.getPermissionMode()).toBe('acceptEdits');
    expect(calls).toEqual(['exit', 'notify']);
  });

  it('treats repeated requests as idempotent snapshots', () => {
    const { config, calls } = makeConfig({ active: true });

    expect(setSdkPlanMode(config, true)).toEqual({ active: true });
    expect(calls).toEqual([]);
    expect(buildPlanModeSnapshot(config)).toEqual({ active: true });
  });

  it('rejects entry when Plan Mode is disabled or permission mode blocks it', () => {
    const disabled = makeConfig({ enabled: false });
    expect(() => setSdkPlanMode(disabled.config, true)).toThrow(
      'Plan mode is disabled.',
    );

    const blocked = makeConfig({ permissionMode: 'dontAsk' });
    expect(() => setSdkPlanMode(blocked.config, true)).toThrow(
      'Plan mode is unavailable',
    );
  });

  it('projects PlanStateChanged as a full SDK snapshot and unsubscribes', () => {
    const writeNdjson = vi.fn();
    const unsubscribe = installPlanModeEventBridge({
      writeNdjson,
      sessionId: 'session-plan',
    });

    coreEvents.emitPlanStateChanged('session-plan', true);
    expect(writeNdjson).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        subtype: 'plan_mode_changed',
        plan_mode: { active: true },
        session_id: 'session-plan',
      }),
    );

    unsubscribe();
    coreEvents.emitPlanStateChanged('session-plan', false);
    expect(writeNdjson).toHaveBeenCalledTimes(1);
  });
});
