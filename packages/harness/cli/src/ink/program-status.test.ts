/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENV_PROGRAM_STATUS,
  getProgramStatusOverride,
  hasUnknownOscPrintingBug,
  isProgramStatusEnabled,
  resetProgramStatusForTesting,
  setProgramStatusSupported,
  shouldProbeProgramStatus,
  subscribeProgramStatus,
} from './program-status.js';
import { parseMultipleKeypresses, INITIAL_STATE } from './parse-keypress.js';
import { programStatus, TerminalQuerier } from './terminal-querier.js';

afterEach(() => resetProgramStatusForTesting());

describe('program status gating', () => {
  it('reads the program status override', () => {
    expect(getProgramStatusOverride({ [ENV_PROGRAM_STATUS]: '1' })).toBe('on');
    expect(getProgramStatusOverride({ [ENV_PROGRAM_STATUS]: '0' })).toBe('off');
    expect(
      getProgramStatusOverride({ [ENV_PROGRAM_STATUS]: 'yes' }),
    ).toBeUndefined();
    expect(getProgramStatusOverride({})).toBeUndefined();
  });

  it('only probes without an override and outside old VTE', () => {
    expect(shouldProbeProgramStatus({})).toBe(true);
    expect(shouldProbeProgramStatus({ [ENV_PROGRAM_STATUS]: '1' })).toBe(false);
    expect(shouldProbeProgramStatus({ [ENV_PROGRAM_STATUS]: '0' })).toBe(false);
    expect(shouldProbeProgramStatus({ VTE_VERSION: '5202' })).toBe(false);
    expect(shouldProbeProgramStatus({ VTE_VERSION: '7600' })).toBe(true);
    expect(hasUnknownOscPrintingBug({ VTE_VERSION: '5300' })).toBe(false);
  });

  it('is off until the probe succeeds, and the override wins', () => {
    expect(isProgramStatusEnabled({})).toBe(false);
    const listener = vi.fn();
    subscribeProgramStatus(listener);
    setProgramStatusSupported();
    setProgramStatusSupported();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isProgramStatusEnabled({})).toBe(true);
    expect(isProgramStatusEnabled({ [ENV_PROGRAM_STATUS]: '0' })).toBe(false);
    resetProgramStatusForTesting();
    expect(isProgramStatusEnabled({ [ENV_PROGRAM_STATUS]: '1' })).toBe(true);
  });
});

function responsesFrom(input: string) {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, input);
  return items.flatMap((item) => (item.kind === 'response' ? [item.response] : []));
}

describe('programStatus() probe', () => {
  function createQuerier() {
    const write = vi.fn();
    const querier = new TerminalQuerier({ write } as unknown as NodeJS.WriteStream);
    return { querier, write };
  }

  it('writes OSC 7501 ; ? ahead of the DA1 sentinel', () => {
    const { querier, write } = createQuerier();
    void querier.send(programStatus());
    void querier.flush();
    expect(write.mock.calls.map(([s]) => s)).toEqual(['\x1b]7501;?\x1b\\', '\x1b[c']);
  });

  it.each([
    ['ST', '\x1b]7501;?\x1b\\'],
    ['BEL', '\x1b]7501;?\x07'],
    ['capability list', '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'],
  ])('resolves on a %s reply before DA1', async (_name, reply) => {
    const { querier } = createQuerier();
    const result = querier.send(programStatus());
    const flushed = querier.flush();
    for (const r of responsesFrom(`${reply}\x1b[?62;22c`)) querier.onResponse(r);
    await flushed;
    await expect(result).resolves.toMatchObject({ type: 'osc', code: 7501 });
  });

  it('resolves undefined when DA1 arrives first (unsupported, e.g. tmux)', async () => {
    const { querier } = createQuerier();
    const result = querier.send(programStatus());
    const flushed = querier.flush();
    for (const r of responsesFrom('\x1b[?62;22c')) querier.onResponse(r);
    await flushed;
    await expect(result).resolves.toBeUndefined();
  });
});
