/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentPromptCommand } from './agent-prompt.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { buildFilesPlan, collectAuditFiles } from './lib/files-plan.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-agent-prompt-'));
  mkdirSync(join(dir, 'mod'), { recursive: true });
  writeFileSync(join(dir, 'mod', 'a.ts'), 'const a = 1;\n');
  vi.mocked(writeStdoutLine).mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePlan(effort: 'low' | 'medium' | 'high'): string {
  const plan = buildFilesPlan(
    join(dir, 'mod'),
    join(dir, 'mod'),
    effort,
    collectAuditFiles(join(dir, 'mod')),
  );
  const planPath = join(dir, `plan-${effort}.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  return planPath;
}

const run = (argv: Record<string, unknown>) =>
  (agentPromptCommand.handler as (a: unknown) => void)({
    _: ['audit', 'agent-prompt'],
    ...argv,
  });

describe('agentPromptCommand handler', () => {
  it('prints a role brief for a role in the roster', () => {
    run({ plan: writePlan('medium'), role: '1a', probes: 'declined' });
    const printed = vi.mocked(writeStdoutLine).mock.calls[0][0];
    expect(printed).toContain('You are Agent 1a');
    // Declined probe opt-in strips the execution instructions.
    expect(printed).toContain('Execution is NOT opted in');
  });

  it('maps the opted-in probe flag to the probe discipline', () => {
    // The 'opted-in' → probesConsented === true mapping is load-bearing:
    // without it every opted-in run prints the declined brief and the
    // verifier tier silently caps at code reads.
    run({ plan: writePlan('medium'), role: '1a', probes: 'opted-in' });
    const printed = vi.mocked(writeStdoutLine).mock.calls[0][0];
    expect(printed).toContain('A probe runs only against a scratch copy');
    expect(printed).not.toContain('Execution is NOT opted in');
  });

  it('refuses the low reader at medium and a roster role at low', () => {
    expect(() =>
      run({
        plan: writePlan('medium'),
        role: 'low-reader',
        probes: 'declined',
      }),
    ).toThrow(/only valid for a low-tier plan/);
    // Low plans carry an empty roster: every dimension role is refused.
    expect(() =>
      run({ plan: writePlan('low'), role: '1a', probes: 'declined' }),
    ).toThrow(/not in this plan's roster/);
  });

  it('refuses a stale-plan role that is not in the roster', () => {
    // 'toString' rides the prototype-membership hole a raw .includes()
    // call would leave open: it is an Object.prototype member, not a role.
    expect(() =>
      run({ plan: writePlan('medium'), role: 'toString', probes: 'declined' }),
    ).toThrow(/must be one of/);
  });

  it('fails closed when the plan carries a non-array roster', () => {
    const planPath = writePlan('medium');
    const parsed = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    // A string roster ('1a' .includes('1a') === true, '12' admits '2')
    // must fail closed, not reach substring membership.
    parsed['roster'] = '12';
    writeFileSync(planPath, JSON.stringify(parsed));
    expect(() =>
      run({ plan: planPath, role: '2', probes: 'declined' }),
    ).toThrow(/not in this plan's roster/);
  });
});
