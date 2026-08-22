/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Yargs wiring smoke tests for the audit subcommands the /audit skill
// orchestrates via shell calls. The skill's command lines are hand-typed
// against these builder definitions; a builder↔handler rename on one side
// (e.g. `report-slug` builder / `reportSlug` handler) ships green through
// a direct-handler test because yargs' camelCase mapping is the only thing
// that bridges them. Each test runs REAL yargs parse and asserts the
// handler receives the required options under their camelCase names.
// Mirrors the parse-args precedent.

import { describe, expect, it, vi } from 'vitest';
import type { CommandModule } from 'yargs';
import yargs from 'yargs';
import { planFilesCommand } from './plan-files.js';
import { agentPromptCommand } from './agent-prompt.js';
import { snapshotCommand, driftCheckCommand } from './snapshot.js';
import { guardCheckCommand } from './guard-check.js';
import { checkAnchorsCommand } from './check-anchors.js';

function parsedArgv(command: CommandModule, argv: string[]): unknown {
  const handler = vi.fn();
  void yargs(argv)
    .command({ ...command, handler })
    .strict()
    .exitProcess(false)
    .parse();
  expect(handler).toHaveBeenCalledTimes(1);
  return handler.mock.calls[0][0];
}

describe('audit subcommand yargs wiring', () => {
  it('delivers plan-files options as camelCase keys', () => {
    const argv = parsedArgv(planFilesCommand, [
      'plan-files',
      'mod',
      '--out',
      'plan.json',
      '--args-report',
      'a.json',
    ]) as Record<string, unknown>;
    expect(argv['path']).toBe('mod');
    expect(argv['out']).toBe('plan.json');
    expect(argv['argsReport']).toBe('a.json');
    // No default in the builder: the flag arrives undefined unless
    // passed. Truthiness (not undefined-ness) is what runPlanFiles'
    // either-or guard keys on.
    expect(argv['applyExcludeRemedy']).toBeFalsy();
  });

  it('refuses plan-files without the required --out', () => {
    expect(() => parsedArgv(planFilesCommand, ['plan-files', 'mod'])).toThrow(
      /out/,
    );
  });

  it('delivers agent-prompt options as camelCase keys', () => {
    const argv = parsedArgv(agentPromptCommand, [
      'agent-prompt',
      '--plan',
      'plan.json',
      '--role',
      '1a',
      '--probes',
      'opted-in',
    ]) as Record<string, unknown>;
    expect(argv['plan']).toBe('plan.json');
    expect(argv['role']).toBe('1a');
    expect(argv['probes']).toBe('opted-in');
  });

  it('delivers snapshot options as camelCase keys', () => {
    const argv = parsedArgv(snapshotCommand, [
      'snapshot',
      '--plan',
      'plan.json',
      '--out',
      'sc.sidecar',
    ]) as Record<string, unknown>;
    expect(argv['plan']).toBe('plan.json');
    expect(argv['out']).toBe('sc.sidecar');
  });

  it('delivers drift-check options as camelCase keys', () => {
    const argv = parsedArgv(driftCheckCommand, [
      'drift-check',
      '--plan',
      'plan.json',
      '--sidecar',
      'sc.sidecar',
    ]) as Record<string, unknown>;
    expect(argv['plan']).toBe('plan.json');
    expect(argv['sidecar']).toBe('sc.sidecar');
  });

  it('delivers guard-check options as camelCase keys', () => {
    const argv = parsedArgv(guardCheckCommand, [
      'guard-check',
      '--report-slug',
      'mod',
      '--plan',
      'plan.json',
    ]) as Record<string, unknown>;
    expect(argv['reportSlug']).toBe('mod');
    expect(argv['plan']).toBe('plan.json');
  });

  it('refuses guard-check without the required --report-slug', () => {
    expect(() => parsedArgv(guardCheckCommand, ['guard-check'])).toThrow(
      /report-slug/,
    );
  });

  it('delivers check-anchors options as camelCase keys', () => {
    const argv = parsedArgv(checkAnchorsCommand, [
      'check-anchors',
      '--plan',
      'plan.json',
      '--findings',
      'findings.json',
      '--report',
      'draft.md',
    ]) as Record<string, unknown>;
    expect(argv['plan']).toBe('plan.json');
    expect(argv['findings']).toBe('findings.json');
    expect(argv['report']).toBe('draft.md');
  });
});
