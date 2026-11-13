/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_LOOP_SURFACES,
  resolveAgentLoopEnvOverride,
  resolveAgentLoopSwitch,
  resetAgentLoopEnvWarnings,
  type AgentLoopSurface,
} from './agent-loop-rollout.js';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    warn: warnMock,
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const V = 'QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP';
const VE = 'QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP';

describe('resolveAgentLoopEnvOverride', () => {
  it('returns undefined when the variable is unset or blank', () => {
    for (const value of [undefined, '', '   ']) {
      expect(resolveAgentLoopEnvOverride(value, 'headless', V)).toBeUndefined();
    }
  });

  it('forces every surface on with 1 and off with 0', () => {
    for (const surface of AGENT_LOOP_SURFACES) {
      expect(resolveAgentLoopEnvOverride('1', surface, V)).toBe(true);
      expect(resolveAgentLoopEnvOverride('0', surface, V)).toBe(false);
    }
  });

  it('trims the whole value', () => {
    expect(resolveAgentLoopEnvOverride(' 1 ', 'headless', V)).toBe(true);
    expect(resolveAgentLoopEnvOverride(' 0 ', 'headless', V)).toBe(false);
  });

  it('treats a bare surface name as force-on for that surface only', () => {
    expect(resolveAgentLoopEnvOverride('headless', 'headless', V)).toBe(true);
    expect(resolveAgentLoopEnvOverride('headless', 'acp', V)).toBeUndefined();
  });

  it('parses surface=0 and surface=1 tokens', () => {
    const value = 'headless=1,acp=0';
    expect(resolveAgentLoopEnvOverride(value, 'headless', V)).toBe(true);
    expect(resolveAgentLoopEnvOverride(value, 'acp', V)).toBe(false);
    expect(resolveAgentLoopEnvOverride(value, 'ink', V)).toBeUndefined();
  });

  it('trims tokens and handles empty tokens', () => {
    const value = ' headless , , acp = 0 , ';
    expect(resolveAgentLoopEnvOverride(value, 'headless', V)).toBe(true);
    expect(resolveAgentLoopEnvOverride(value, 'acp', V)).toBe(false);
    expect(resolveAgentLoopEnvOverride(value, 'ink', V)).toBeUndefined();
  });

  it('ignores unknown surface names', () => {
    expect(resolveAgentLoopEnvOverride('bogus,headless', 'headless', V)).toBe(
      true,
    );
    expect(resolveAgentLoopEnvOverride('bogus', 'headless', V)).toBeUndefined();
  });

  it('ignores a malformed flag for the addressed surface', () => {
    expect(
      resolveAgentLoopEnvOverride('headless=2', 'headless', V),
    ).toBeUndefined();
    expect(
      resolveAgentLoopEnvOverride('headless=yes', 'headless', V),
    ).toBeUndefined();
  });

  it('takes the first token that names the surface', () => {
    expect(
      resolveAgentLoopEnvOverride('headless=1,headless=0', 'headless', V),
    ).toBe(true);
    expect(
      resolveAgentLoopEnvOverride('headless=0,headless=1', 'headless', V),
    ).toBe(false);
  });

  it('skips a malformed token and applies a later well-formed one', () => {
    expect(
      resolveAgentLoopEnvOverride('headless=2,headless=1', 'headless', V),
    ).toBe(true);
    expect(
      resolveAgentLoopEnvOverride('headless=2,headless=0', 'headless', V),
    ).toBe(false);
  });

  it('does not treat a bare 1/0 inside a list as a whole-value override', () => {
    // The whole-value form is `1` or `0` alone. Inside a list a bare `1` has
    // no surface name, so it is dropped; only the named surfaces are forced.
    expect(resolveAgentLoopEnvOverride('1,acp=0', 'acp', V)).toBe(false);
    expect(
      resolveAgentLoopEnvOverride('1,acp=0', 'headless', V),
    ).toBeUndefined();
  });

  it('handles the hyphenated agent-core surface', () => {
    expect(resolveAgentLoopEnvOverride('agent-core', 'agent-core', V)).toBe(
      true,
    );
    expect(resolveAgentLoopEnvOverride('agent-core=0', 'agent-core', V)).toBe(
      false,
    );
    expect(
      resolveAgentLoopEnvOverride('agent-core', 'headless', V),
    ).toBeUndefined();
  });
});

describe('resolveAgentLoopSwitch', () => {
  const surface: AgentLoopSurface = 'headless';

  it('falls back to the supplied per-switch default when nothing is set', () => {
    expect(
      resolveAgentLoopSwitch({
        env: undefined,
        setting: undefined,
        surface,
        surfaceDefault: false,
        variable: V,
      }),
    ).toBe(false);
  });

  it('uses the explicit setting when the env does not address the surface', () => {
    expect(
      resolveAgentLoopSwitch({
        env: undefined,
        setting: true,
        surface,
        surfaceDefault: false,
        variable: V,
      }),
    ).toBe(true);
    expect(
      resolveAgentLoopSwitch({
        env: 'acp',
        setting: true,
        surface,
        surfaceDefault: false,
        variable: V,
      }),
    ).toBe(true);
    expect(
      resolveAgentLoopSwitch({
        env: undefined,
        setting: false,
        surface,
        surfaceDefault: false,
        variable: V,
      }),
    ).toBe(false);
  });

  it('lets the env override the setting in both directions', () => {
    expect(
      resolveAgentLoopSwitch({
        env: '1',
        setting: false,
        surface,
        surfaceDefault: false,
        variable: V,
      }),
    ).toBe(true);
    expect(
      resolveAgentLoopSwitch({
        env: '0',
        setting: true,
        surface,
        surfaceDefault: false,
        variable: V,
      }),
    ).toBe(false);
    expect(
      resolveAgentLoopSwitch({
        env: 'headless=0',
        setting: true,
        surface,
        surfaceDefault: false,
        variable: V,
      }),
    ).toBe(false);
  });

  it('lets an explicit false setting beat a true per-switch default', () => {
    // The acceptance for per-switch tables: a flipped default must not override
    // an explicit opt-out. Removing the `setting !== undefined` branch reds this.
    expect(
      resolveAgentLoopSwitch({
        env: undefined,
        setting: false,
        surface,
        surfaceDefault: true,
        variable: V,
      }),
    ).toBe(false);
  });

  it('falls through to a true per-switch default only when the setting is unset', () => {
    // The acceptance for per-switch tables: with no setting and no env, the
    // caller-supplied default wins. Re-merging the two switch tables reds the
    // event-bus getter's independence (see config.test.ts).
    expect(
      resolveAgentLoopSwitch({
        env: undefined,
        setting: undefined,
        surface,
        surfaceDefault: true,
        variable: V,
      }),
    ).toBe(true);
  });
});

describe('resolveAgentLoopEnvOverride warning dedup', () => {
  beforeEach(() => {
    resetAgentLoopEnvWarnings();
    warnMock.mockClear();
  });

  it('warns once per distinct token across repeated resolutions', () => {
    expect(resolveAgentLoopEnvOverride('bogus', 'headless', V)).toBeUndefined();
    expect(resolveAgentLoopEnvOverride('bogus', 'headless', V)).toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('warns separately for different tokens', () => {
    resolveAgentLoopEnvOverride('bogus', 'headless', V);
    resolveAgentLoopEnvOverride('headless=2', 'headless', V);
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it('dedup does not change the resolved value', () => {
    expect(resolveAgentLoopEnvOverride('bogus,headless=1', 'headless', V)).toBe(
      true,
    );
    expect(resolveAgentLoopEnvOverride('bogus,headless=1', 'headless', V)).toBe(
      true,
    );
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('attributes the same typo in both switches to each variable', () => {
    // The two switches share this resolver; a token mistyped into both must
    // warn once per variable, each line naming its own variable. Keying the
    // dedup on the bare token reds this (the second switch stays silent).
    expect(
      resolveAgentLoopEnvOverride('headles', 'headless', V),
    ).toBeUndefined();
    expect(
      resolveAgentLoopEnvOverride('headles', 'headless', VE),
    ).toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(warnMock).toHaveBeenCalledWith(
      `ignoring unknown agent-loop surface token "headles" in ${V}`,
    );
    expect(warnMock).toHaveBeenCalledWith(
      `ignoring unknown agent-loop surface token "headles" in ${VE}`,
    );
  });
});
