/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAgentProgramProbeCache,
  findOnPath,
  parseSemver,
  probeAgentPrograms,
  PROGRAM_PROBE_CACHE_MS,
} from './program-probe.js';

const BIN = join('/', 'opt', 'bin');

function probeWith(
  files: string[],
  versions: Record<string, string | Error>,
  env: NodeJS.ProcessEnv = { PATH: BIN },
  now = () => 0,
) {
  const calls: string[] = [];
  const result = probeAgentPrograms({
    env,
    platform: 'linux',
    isExecutable: (file) => files.includes(file),
    runVersion: async (executable) => {
      calls.push(executable);
      const answer = versions[executable];
      if (answer instanceof Error) throw answer;
      return answer ?? '';
    },
    now,
  });
  return { result, calls };
}

describe('probeAgentPrograms', () => {
  beforeEach(() => clearAgentProgramProbeCache());

  it('reports qwen always, and claude / codex by PATH and version floor', async () => {
    const claude = join(BIN, 'claude');
    const codex = join(BIN, 'codex');
    const { result } = probeWith([claude, codex], {
      [claude]: '2.1.289 (Claude Code)\n',
      [codex]: 'codex-cli 0.99.0\n',
    });
    expect(await result).toEqual([
      { program: 'qwen', available: true },
      { program: 'claude', version: '2.1.289 (Claude Code)', available: true },
      {
        program: 'codex',
        version: 'codex-cli 0.99.0',
        available: false,
        reason: expect.stringContaining('below the minimum 0.100.0'),
      },
    ]);
  });

  it('reports a missing program and a failing --version', async () => {
    const claude = join(BIN, 'claude');
    const { result } = probeWith([claude], {
      [claude]: new Error('timed out'),
    });
    const probes = await result;
    expect(probes[1]).toMatchObject({
      program: 'claude',
      available: false,
      reason: expect.stringContaining('timed out'),
    });
    expect(probes[2]).toMatchObject({
      program: 'codex',
      available: false,
      reason: 'codex was not found on PATH.',
    });
  });

  it('honours QWEN_AGENT_CLAUDE_PATH / QWEN_AGENT_CODEX_PATH', async () => {
    const custom = join('/', 'custom', 'claude-dev');
    const { result, calls } = probeWith(
      [custom],
      { [custom]: 'claude 2.0.0' },
      {
        PATH: BIN,
        QWEN_AGENT_CLAUDE_PATH: custom,
        QWEN_AGENT_CODEX_PATH: '/nope/codex',
      },
    );
    const probes = await result;
    expect(calls).toEqual([custom]);
    expect(probes[1]).toMatchObject({ program: 'claude', available: true });
    expect(probes[2]).toMatchObject({
      program: 'codex',
      available: false,
      reason: expect.stringContaining('QWEN_AGENT_CODEX_PATH'),
    });
  });

  it('treats an unparsable version as available', async () => {
    const codex = join(BIN, 'codex');
    const { result } = probeWith([codex], { [codex]: 'nightly build' });
    expect((await result)[2]).toEqual({
      program: 'codex',
      version: 'nightly build',
      available: true,
    });
  });

  it('caches for 60s per environment', async () => {
    const claude = join(BIN, 'claude');
    let clock = 0;
    const first = probeWith(
      [claude],
      { [claude]: '2.1.0' },
      { PATH: BIN },
      () => clock,
    );
    await first.result;
    const second = probeWith(
      [claude],
      { [claude]: '2.1.0' },
      { PATH: BIN },
      () => clock,
    );
    await second.result;
    expect(second.calls).toEqual([]);
    clock = PROGRAM_PROBE_CACHE_MS;
    const third = probeWith(
      [claude],
      { [claude]: '2.1.0' },
      { PATH: BIN },
      () => clock,
    );
    await third.result;
    expect(third.calls).toEqual([claude]);
  });
});

describe('findOnPath', () => {
  it('uses PATHEXT on Windows', () => {
    const found = findOnPath(
      'claude',
      { Path: 'C:\\npm;C:\\other', PATHEXT: '.EXE;.CMD' },
      'win32',
      (file) => file === join('C:\\npm', 'claude.CMD'),
    );
    expect(found).toBe(join('C:\\npm', 'claude.CMD'));
  });

  it("prefers a PATHEXT match over npm's extension-less sh shim on Windows", () => {
    const files = new Set([
      join('C:\\npm', 'claude'),
      join('C:\\npm', 'claude.CMD'),
    ]);
    const found = findOnPath(
      'claude',
      { Path: 'C:\\npm', PATHEXT: '.EXE;.CMD' },
      'win32',
      (file) => files.has(file),
    );
    expect(found).toBe(join('C:\\npm', 'claude.CMD'));
  });
});

describe('parseSemver', () => {
  it('reads the first x.y.z', () => {
    expect(parseSemver('codex-cli 0.118.0')).toEqual([0, 118, 0]);
    expect(parseSemver('v2.1.5 (Claude Code)')).toEqual([2, 1, 5]);
    expect(parseSemver('dev')).toBeUndefined();
  });
});
