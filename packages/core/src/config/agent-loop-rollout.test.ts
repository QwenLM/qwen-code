/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_LOOP_SURFACES,
  resolveAgentLoopEnvOverride,
  resolveAgentLoopSwitch,
  type AgentLoopSurface,
} from './agent-loop-rollout.js';

describe('resolveAgentLoopEnvOverride', () => {
  it('returns undefined when the variable is unset or blank', () => {
    for (const value of [undefined, '', '   ']) {
      expect(resolveAgentLoopEnvOverride(value, 'headless')).toBeUndefined();
    }
  });

  it('forces every surface on with 1 and off with 0', () => {
    for (const surface of AGENT_LOOP_SURFACES) {
      expect(resolveAgentLoopEnvOverride('1', surface)).toBe(true);
      expect(resolveAgentLoopEnvOverride('0', surface)).toBe(false);
    }
  });

  it('trims the whole value', () => {
    expect(resolveAgentLoopEnvOverride(' 1 ', 'headless')).toBe(true);
    expect(resolveAgentLoopEnvOverride(' 0 ', 'headless')).toBe(false);
  });

  it('treats a bare surface name as force-on for that surface only', () => {
    expect(resolveAgentLoopEnvOverride('headless', 'headless')).toBe(true);
    expect(resolveAgentLoopEnvOverride('headless', 'acp')).toBeUndefined();
  });

  it('parses surface=0 and surface=1 tokens', () => {
    const value = 'headless=1,acp=0';
    expect(resolveAgentLoopEnvOverride(value, 'headless')).toBe(true);
    expect(resolveAgentLoopEnvOverride(value, 'acp')).toBe(false);
    expect(resolveAgentLoopEnvOverride(value, 'ink')).toBeUndefined();
  });

  it('trims tokens and handles empty tokens', () => {
    const value = ' headless , , acp = 0 , ';
    expect(resolveAgentLoopEnvOverride(value, 'headless')).toBe(true);
    expect(resolveAgentLoopEnvOverride(value, 'acp')).toBe(false);
    expect(resolveAgentLoopEnvOverride(value, 'ink')).toBeUndefined();
  });

  it('ignores unknown surface names', () => {
    expect(resolveAgentLoopEnvOverride('bogus,headless', 'headless')).toBe(
      true,
    );
    expect(resolveAgentLoopEnvOverride('bogus', 'headless')).toBeUndefined();
  });

  it('ignores a malformed flag for the addressed surface', () => {
    expect(
      resolveAgentLoopEnvOverride('headless=2', 'headless'),
    ).toBeUndefined();
    expect(
      resolveAgentLoopEnvOverride('headless=yes', 'headless'),
    ).toBeUndefined();
  });

  it('takes the first token that names the surface', () => {
    expect(
      resolveAgentLoopEnvOverride('headless=1,headless=0', 'headless'),
    ).toBe(true);
    expect(
      resolveAgentLoopEnvOverride('headless=0,headless=1', 'headless'),
    ).toBe(false);
  });

  it('skips a malformed token and applies a later well-formed one', () => {
    expect(
      resolveAgentLoopEnvOverride('headless=2,headless=1', 'headless'),
    ).toBe(true);
    expect(
      resolveAgentLoopEnvOverride('headless=2,headless=0', 'headless'),
    ).toBe(false);
  });

  it('does not treat a bare 1/0 inside a list as a whole-value override', () => {
    // The whole-value form is `1` or `0` alone. Inside a list a bare `1` has
    // no surface name, so it is dropped; only the named surfaces are forced.
    expect(resolveAgentLoopEnvOverride('1,acp=0', 'acp')).toBe(false);
    expect(resolveAgentLoopEnvOverride('1,acp=0', 'headless')).toBeUndefined();
  });

  it('handles the hyphenated agent-core surface', () => {
    expect(resolveAgentLoopEnvOverride('agent-core', 'agent-core')).toBe(true);
    expect(resolveAgentLoopEnvOverride('agent-core=0', 'agent-core')).toBe(
      false,
    );
    expect(
      resolveAgentLoopEnvOverride('agent-core', 'headless'),
    ).toBeUndefined();
  });
});

describe('resolveAgentLoopSwitch', () => {
  const surface: AgentLoopSurface = 'headless';

  it('falls back to the built-in default when nothing is set', () => {
    expect(
      resolveAgentLoopSwitch({ env: undefined, setting: undefined, surface }),
    ).toBe(false);
  });

  it('uses the explicit setting when the env does not address the surface', () => {
    expect(
      resolveAgentLoopSwitch({ env: undefined, setting: true, surface }),
    ).toBe(true);
    expect(resolveAgentLoopSwitch({ env: 'acp', setting: true, surface })).toBe(
      true,
    );
    expect(
      resolveAgentLoopSwitch({ env: undefined, setting: false, surface }),
    ).toBe(false);
  });

  it('lets the env override the setting in both directions', () => {
    expect(resolveAgentLoopSwitch({ env: '1', setting: false, surface })).toBe(
      true,
    );
    expect(resolveAgentLoopSwitch({ env: '0', setting: true, surface })).toBe(
      false,
    );
    expect(
      resolveAgentLoopSwitch({ env: 'headless=0', setting: true, surface }),
    ).toBe(false);
  });

  it('lets an explicit false setting beat the built-in default', () => {
    // The built-in default is false today; an explicit false must still be
    // honored once a surface default flips to true. The resolution order is
    // observable here through the env: a list that does not name the surface
    // leaves the explicit false in charge.
    expect(
      resolveAgentLoopSwitch({ env: 'acp=1', setting: false, surface }),
    ).toBe(false);
  });
});
