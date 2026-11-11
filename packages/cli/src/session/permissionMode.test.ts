/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENV_RUNNING_ENV,
  type Config,
  type PermissionMode,
} from '@qwen-code/core';
import {
  applyIndependentPermissionMode,
  applyIndependentPlanMode,
  applyIndependentSessionMode,
  applySdkPermissionMode,
  computeAvailablePermissionModes,
  getSdkPermissionMode,
  mapSdkPermissionMode,
  parseSdkPermissionMode,
  parseSdkPermissionModeArray,
  permissionModeToSdk,
} from './permissionMode.js';

function makeConfig(opts: {
  planEnabled: boolean;
  disabledModes?: readonly PermissionMode[];
}): Config {
  return {
    isPlanEnabled: () => opts.planEnabled,
    getPermissionModeRestriction: (mode: PermissionMode) =>
      opts.disabledModes?.includes(mode) ? 'Mode restricted' : undefined,
  } as unknown as Config;
}

function makeTransitionConfig(opts?: {
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto';
  planActive?: boolean;
  planEnabled?: boolean;
  setPermissionModeError?: Error;
}) {
  let permissionMode = opts?.permissionMode ?? 'default';
  let planActive = opts?.planActive ?? false;
  const calls: string[] = [];
  const planStateManager = {
    get isActive() {
      return planActive;
    },
    enter: vi.fn(() => {
      calls.push('enter');
      planActive = true;
    }),
    exit: vi.fn(() => {
      calls.push('exit');
      planActive = false;
    }),
  };
  const config = {
    getPermissionMode: vi.fn(() => permissionMode),
    setPermissionMode: vi.fn((mode: typeof permissionMode) => {
      calls.push(`set:${mode}`);
      if (opts?.setPermissionModeError) {
        throw opts.setPermissionModeError;
      }
      permissionMode = mode;
    }),
    isPlanMode: vi.fn(() => planActive),
    isPlanEnabled: vi.fn(() => opts?.planEnabled ?? true),
    planStateManager,
    resetPreApprovedPrompts: vi.fn(() => calls.push('reset')),
    notifyPlanStateChanged: vi.fn(() => calls.push('notify')),
  } as unknown as Config;
  return {
    config,
    calls,
    get permissionMode() {
      return permissionMode;
    },
    get planActive() {
      return planActive;
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('computeAvailablePermissionModes', () => {
  it('keeps Auto selectable when the global policy disables it', () => {
    vi.stubEnv(ENV_RUNNING_ENV, undefined);
    expect(
      computeAvailablePermissionModes(
        makeConfig({ planEnabled: true, disabledModes: ['auto'] }),
      ),
    ).toEqual(['default', 'acceptEdits', 'auto']);
  });

  it('keeps the cloud wire mode selectable when the global policy disables it', () => {
    vi.stubEnv(ENV_RUNNING_ENV, 'cloud');
    expect(
      computeAvailablePermissionModes(
        makeConfig({ planEnabled: true, disabledModes: ['yolo'] }),
      ),
    ).toEqual(['bypassPermissions', 'default', 'acceptEdits', 'auto']);
  });

  it('returns local modes without requiring a Config', () => {
    vi.stubEnv(ENV_RUNNING_ENV, undefined);
    expect(computeAvailablePermissionModes()).toEqual([
      'default',
      'acceptEdits',
      'auto',
    ]);
  });

  it('returns default, acceptEdits, auto when plan disabled', () => {
    vi.stubEnv(ENV_RUNNING_ENV, undefined);
    expect(
      computeAvailablePermissionModes(makeConfig({ planEnabled: false })),
    ).toEqual(['default', 'acceptEdits', 'auto']);
  });

  it('includes bypassPermissions before auto when ENV_RUNNING_ENV=cloud', () => {
    vi.stubEnv(ENV_RUNNING_ENV, 'cloud');
    expect(
      computeAvailablePermissionModes(makeConfig({ planEnabled: true })),
    ).toEqual(['bypassPermissions', 'default', 'acceptEdits', 'auto']);
  });

  it('does not include bypassPermissions when ENV_RUNNING_ENV is unset', () => {
    vi.stubEnv(ENV_RUNNING_ENV, undefined);
    const modes = computeAvailablePermissionModes(
      makeConfig({ planEnabled: true }),
    );
    expect(modes).not.toContain('bypassPermissions');
  });

  it('does not include bypassPermissions for non-cloud env values', () => {
    vi.stubEnv(ENV_RUNNING_ENV, 'local');
    const modes = computeAvailablePermissionModes(
      makeConfig({ planEnabled: true }),
    );
    expect(modes).not.toContain('bypassPermissions');
  });

  it('includes auto when the global policy does not restrict it', () => {
    vi.stubEnv(ENV_RUNNING_ENV, undefined);
    const planOn = computeAvailablePermissionModes(
      makeConfig({ planEnabled: true }),
    );
    const planOff = computeAvailablePermissionModes(
      makeConfig({ planEnabled: false }),
    );
    expect(planOn).toContain('auto');
    expect(planOff).toContain('auto');
  });
});

describe('parseSdkPermissionModeArray', () => {
  it('returns undefined for non-arrays', () => {
    expect(parseSdkPermissionModeArray(null)).toBeUndefined();
    expect(parseSdkPermissionModeArray(undefined)).toBeUndefined();
    expect(parseSdkPermissionModeArray('default')).toBeUndefined();
    expect(parseSdkPermissionModeArray(42)).toBeUndefined();
    expect(parseSdkPermissionModeArray({})).toBeUndefined();
  });

  it('filters non-string and out-of-set entries', () => {
    expect(
      parseSdkPermissionModeArray([
        'default',
        'plan',
        'bogus',
        42,
        null,
        'acceptEdits',
        'dontAsk',
        'auto',
      ]),
    ).toEqual(['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']);
  });

  it('returns empty array when every entry is invalid', () => {
    expect(parseSdkPermissionModeArray(['bogus', 42, null])).toEqual([]);
  });

  it('accepts empty arrays', () => {
    expect(parseSdkPermissionModeArray([])).toEqual([]);
  });
});

describe('permissionModeToSdk', () => {
  it('passes SDK modes through', () => {
    expect(permissionModeToSdk('default')).toBe('default');
    expect(permissionModeToSdk('acceptEdits')).toBe('acceptEdits');
    expect(permissionModeToSdk('dontAsk')).toBe('dontAsk');
    expect(permissionModeToSdk('auto')).toBe('auto');
  });

  // The one name that differs. Clients have always sent and read
  // `bypassPermissions`; only the internal name moved.
  it('sends yolo out under its wire name', () => {
    expect(permissionModeToSdk('yolo')).toBe('bypassPermissions');
  });

  it('falls back to default for non-SDK modes (e.g. plan)', () => {
    expect(permissionModeToSdk('plan' as never)).toBe('default');
    expect(permissionModeToSdk('unsupported' as never)).toBe('default');
  });
});

describe('mapSdkPermissionMode', () => {
  it('maps SDK strings back to PermissionMode', () => {
    expect(mapSdkPermissionMode('default')).toBe('default');
    expect(mapSdkPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(mapSdkPermissionMode('dontAsk')).toBe('dontAsk');
    expect(mapSdkPermissionMode('auto')).toBe('auto');
  });

  it('reads the wire name bypassPermissions as yolo', () => {
    expect(mapSdkPermissionMode('bypassPermissions')).toBe('yolo');
  });

  it('does not accept the internal name on the wire', () => {
    expect(mapSdkPermissionMode('yolo')).toBeUndefined();
  });

  it('returns undefined for plan because it is not a core PermissionMode', () => {
    expect(mapSdkPermissionMode('plan')).toBeUndefined();
  });

  it('returns undefined for unknown strings and non-strings', () => {
    expect(mapSdkPermissionMode('bogus')).toBeUndefined();
    expect(mapSdkPermissionMode(42)).toBeUndefined();
    expect(mapSdkPermissionMode(null)).toBeUndefined();
    expect(mapSdkPermissionMode(undefined)).toBeUndefined();
  });
});

describe('parseSdkPermissionMode', () => {
  it('accepts plan as an SDK wire compatibility value', () => {
    expect(parseSdkPermissionMode('plan')).toBe('plan');
  });

  it('accepts core modes and rejects unknown values', () => {
    expect(parseSdkPermissionMode('auto')).toBe('auto');
    expect(parseSdkPermissionMode('bogus')).toBeUndefined();
    expect(parseSdkPermissionMode(null)).toBeUndefined();
  });
});

describe('applySdkPermissionMode', () => {
  it.each(['default', 'auto'] as const)(
    'enters plan without changing the underlying %s permission mode',
    (permissionMode) => {
      const state = makeTransitionConfig({ permissionMode });

      expect(applySdkPermissionMode(state.config, 'plan')).toBeUndefined();

      expect(state.permissionMode).toBe(permissionMode);
      expect(state.planActive).toBe(true);
      expect(state.calls).toEqual(['enter', 'reset', 'notify']);
      expect(getSdkPermissionMode(state.config)).toBe('plan');
    },
  );

  it('treats repeated plan requests as idempotent', () => {
    const state = makeTransitionConfig({
      permissionMode: 'auto',
      planActive: true,
    });

    expect(applySdkPermissionMode(state.config, 'plan')).toBeUndefined();

    expect(state.permissionMode).toBe('auto');
    expect(state.planActive).toBe(true);
    expect(state.calls).toEqual([]);
  });

  it.each([
    { initialMode: 'default', requestedMode: 'auto' },
    { initialMode: 'auto', requestedMode: 'default' },
  ] as const)(
    'exits plan and applies $requestedMode from $initialMode',
    ({ initialMode, requestedMode }) => {
      const state = makeTransitionConfig({
        permissionMode: initialMode,
        planActive: true,
      });

      expect(applySdkPermissionMode(state.config, requestedMode)).toBe(
        requestedMode,
      );

      expect(state.permissionMode).toBe(requestedMode);
      expect(state.planActive).toBe(false);
      expect(state.calls).toEqual([
        `set:${requestedMode}`,
        'exit',
        'notify',
      ]);
      expect(getSdkPermissionMode(state.config)).toBe(requestedMode);
    },
  );

  it('keeps plan active when the requested core mode is rejected', () => {
    const state = makeTransitionConfig({
      permissionMode: 'default',
      planActive: true,
      setPermissionModeError: new Error('mode rejected'),
    });

    expect(() =>
      applySdkPermissionMode(state.config, 'bypassPermissions'),
    ).toThrow('mode rejected');

    expect(state.permissionMode).toBe('default');
    expect(state.planActive).toBe(true);
    expect(state.calls).toEqual(['set:yolo']);
  });

  it('rejects plan when the feature is disabled', () => {
    const state = makeTransitionConfig({ planEnabled: false });

    expect(() => applySdkPermissionMode(state.config, 'plan')).toThrow(
      'Plan mode is disabled.',
    );
    expect(state.planActive).toBe(false);
  });

  it('rejects plan while dontAsk is active', () => {
    const state = makeTransitionConfig({ permissionMode: 'dontAsk' });

    expect(() => applySdkPermissionMode(state.config, 'plan')).toThrow(
      'Plan mode is unavailable',
    );
    expect(state.planActive).toBe(false);
  });
});

describe('independent SDK daemon session modes', () => {
  it('changes Permission without exiting active Plan', () => {
    const state = makeTransitionConfig({
      permissionMode: 'acceptEdits',
      planActive: true,
    });

    applyIndependentPermissionMode(state.config, 'auto');

    expect(state.permissionMode).toBe('auto');
    expect(state.planActive).toBe(true);
    expect(state.calls).toEqual(['set:auto']);
  });

  it('rejects dontAsk without exiting active Plan or applying Permission', () => {
    const state = makeTransitionConfig({
      permissionMode: 'acceptEdits',
      planActive: true,
    });

    expect(() =>
      applyIndependentPermissionMode(state.config, 'dontAsk'),
    ).toThrow('Plan mode is unavailable');
    expect(state.permissionMode).toBe('acceptEdits');
    expect(state.planActive).toBe(true);
    expect(state.calls).toEqual([]);
  });

  it('changes Plan without changing Permission', () => {
    const state = makeTransitionConfig({ permissionMode: 'acceptEdits' });

    applyIndependentPlanMode(state.config, true);

    expect(state.permissionMode).toBe('acceptEdits');
    expect(state.planActive).toBe(true);
    expect(state.calls).toEqual(['enter', 'reset', 'notify']);
  });

  it('rejects an invalid creation pair before applying either field', () => {
    const state = makeTransitionConfig({ permissionMode: 'default' });

    expect(() =>
      applyIndependentSessionMode(state.config, {
        permissionMode: 'dontAsk',
        planMode: true,
      }),
    ).toThrow('Plan mode is unavailable');
    expect(state.permissionMode).toBe('default');
    expect(state.planActive).toBe(false);
    expect(state.calls).toEqual([]);
  });
});
