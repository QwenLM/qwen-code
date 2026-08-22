/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// What makes an A/B's difference evidence is exactly what these tests pin:
// same bytes on both arms (one script, digested), a shared upstream that is
// owned end to end, and an `observed` gate that goes false the moment a
// difference could be the harness's — a dead upstream, a half-run — instead
// of the trees'.

import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAbDrive, type AbDriveArgs } from './ab-drive.js';
import { DRIVE_SENTINEL, type ExecResult } from './drive.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = ''): ExecResult => ({ status: 1, stdout: '', stderr });

function baseArgs(overrides: Partial<AbDriveArgs>): AbDriveArgs {
  const arm = mkdtempSync(join(tmpdir(), 'ab-arm-'));
  return {
    script: 'true',
    armA: arm,
    armB: arm,
    readyTimeout: 1,
    timeout: 1,
    sharedReadyTimeout: 1,
    sharedOnce: false,
    server: `t-${process.pid}`,
    ...overrides,
  };
}

/**
 * A fake tmux + shell that plays the run's own file protocol back at it: the
 * arm loop reads sentinel files from the run's temp dir, so "this session
 * completed" is faked by writing that file when the session starts. `deadShared`
 * writes the SHARED sentinel too — an upstream that exits the moment it is
 * born, which is the confound the `observed` gate exists to catch.
 */
function harness(opts: {
  server: string;
  tmuxAvailable?: boolean;
  deadShared?: boolean;
  sharedReadyPasses?: boolean;
}) {
  const log: string[][] = [];
  const dir = join(tmpdir(), `qwen-review-ab-drive-${opts.server}`);
  const exec = (cmd: string, args: string[]): ExecResult => {
    log.push([cmd, ...args]);
    if (cmd === 'tmux' && args[0] === '-V')
      return opts.tmuxAvailable === false ? fail() : ok('tmux 3.4');
    if (cmd === 'bash') {
      return (opts.sharedReadyPasses ?? true) ? ok() : fail();
    }
    if (cmd === 'tmux' && args[2] === 'new-session') {
      const name = args[5];
      if (name.startsWith('arm-') || opts.deadShared) {
        writeFileSync(join(dir, `${name}.rc`), `${DRIVE_SENTINEL} rc=0\n`);
        writeFileSync(join(dir, `${name}.log`), `${name} output\n`);
      }
      return ok();
    }
    return ok();
  };
  return { exec, log };
}

describe('runAbDrive, harnessed', () => {
  it('refuses a server name it cannot safely own, starting nothing', () => {
    const h = harness({ server: 'x' });
    const r = runAbDrive(baseArgs({ server: '../../PWNED', exec: h.exec }));
    expect(r.observed).toBe(false);
    expect(r.note).toContain('restricted');
    expect(h.log).toEqual([]);
  });

  it('reports the environment gap when tmux is absent', () => {
    const h = harness({ server: 't', tmuxAvailable: false });
    const r = runAbDrive(baseArgs({ exec: h.exec }));
    expect(r.observed).toBe(false);
    expect(r.note).toContain('tmux is not available');
  });

  it('names the missing arm instead of driving what does not exist', () => {
    const h = harness({ server: 't' });
    const r = runAbDrive(
      baseArgs({ armB: '/nope/never/exists', exec: h.exec }),
    );
    expect(r.observed).toBe(false);
    expect(r.note).toContain('--arm-b');
  });

  it('drives both arms with one script and pairs the captures', () => {
    const args = baseArgs({});
    const h = harness({ server: args.server });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.observed).toBe(true);
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('completed');
    expect(r.a?.output).toContain('arm-a output');
    expect(r.b?.output).toContain('arm-b output');
    expect(r.identicalOutput).toBe(false);
    expect(r.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    // Cleanup is unconditional and last — a leaked server is the next run's
    // wrong observation.
    expect(h.log.at(-1)).toEqual(['tmux', '-L', args.server, 'kill-server']);
  });

  it('per-arm mode stands the shared process up fresh for EACH arm and tears each down', () => {
    const args = baseArgs({ shared: 'run-daemon', sharedReady: 'probe' });
    const h = harness({ server: args.server });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.mode).toBe('per-arm');
    expect(r.observed).toBe(true);
    // Log rows are [cmd, ...args]: the tmux verb sits at index 3, the
    // session name at 6 (new-session) / 5 (kill-session).
    const starts = h.log.filter((l) => l[3] === 'new-session').map((l) => l[6]);
    expect(starts).toEqual(['hold', 'shared-a', 'arm-a', 'shared-b', 'arm-b']);
    const kills = h.log.filter((l) => l[3] === 'kill-session').map((l) => l[5]);
    expect(kills).toEqual(['shared-a', 'shared-b']);
  });

  it('--shared-once starts ONE instance, on arm a, and both arms see it', () => {
    const args = baseArgs({
      shared: 'run-daemon',
      sharedOnce: true,
    });
    const h = harness({ server: args.server });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.mode).toBe('once');
    expect(r.observed).toBe(true);
    const starts = h.log.filter((l) => l[3] === 'new-session').map((l) => l[6]);
    expect(starts).toEqual(['hold', 'shared-a', 'arm-a', 'arm-b']);
    expect(r.a?.sharedAliveAtEnd).toBe(true);
    expect(r.b?.sharedAliveAtEnd).toBe(true);
  });

  it('a shared process that never becomes ready stops a --shared-once run outright', () => {
    // In once mode the one instance serves both arms; there is nothing arm b
    // could salvage, so nothing is driven and nothing reads as evidence.
    const args = baseArgs({
      shared: 'run-daemon',
      sharedReady: 'probe',
      sharedOnce: true,
    });
    const h = harness({ server: args.server, sharedReadyPasses: false });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.observed).toBe(false);
    expect(r.a).toBeNull();
    expect(r.b).toBeNull();
    expect(r.note).toContain('never became ready');
    expect(h.log.some((l) => l[3] === 'new-session' && l[6] === 'arm-a')).toBe(
      false,
    );
  });

  it('a shared process that dies before its arm finishes fails the observed gate', () => {
    // Both arms "completed" — and the report still refuses the comparison,
    // because whatever an arm observed after its upstream died is an
    // observation of a dead upstream, not of the tree.
    const args = baseArgs({ shared: 'run-daemon' });
    const h = harness({ server: args.server, deadShared: true });
    const r = runAbDrive({ ...args, exec: h.exec });
    expect(r.a?.outcome).toBe('completed');
    expect(r.b?.outcome).toBe('completed');
    expect(r.a?.sharedAliveAtEnd).toBe(false);
    expect(r.observed).toBe(false);
    expect(r.note).toContain('died');
  });
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe.skipIf(!hasTmux || process.platform === 'win32')(
  'runAbDrive, driven for real',
  () => {
    it('same bytes, two trees: each arm reports its own root and its own content', () => {
      const armA = mkdtempSync(join(tmpdir(), 'ab-real-a-'));
      const armB = mkdtempSync(join(tmpdir(), 'ab-real-b-'));
      writeFileSync(join(armA, 'marker.txt'), 'CONTENT-OF-A\n');
      writeFileSync(join(armB, 'marker.txt'), 'CONTENT-OF-B\n');
      const r = runAbDrive({
        script: 'cat marker.txt; echo "arm=$AB_ARM root=$AB_ARM_ROOT"',
        armA,
        armB,
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 5,
        sharedOnce: false,
        server: `abreal-${process.pid}`,
      });
      expect(r.observed).toBe(true);
      expect(r.a?.exitCode).toBe(0);
      expect(r.a?.output).toContain('CONTENT-OF-A');
      expect(r.a?.output).toContain('arm=a');
      expect(r.a?.output).toContain(armA);
      expect(r.b?.output).toContain('CONTENT-OF-B');
      expect(r.b?.output).toContain('arm=b');
      expect(r.identicalOutput).toBe(false);
    });

    it('per-arm shared: each arm reads its OWN instance, and teardown leaves nothing', () => {
      const armA = mkdtempSync(join(tmpdir(), 'ab-real-sa-'));
      const armB = mkdtempSync(join(tmpdir(), 'ab-real-sb-'));
      const server = `abreals-${process.pid}`;
      const r = runAbDrive({
        // The shared process writes its identity, then stays up past the arm.
        shared: 'echo "upstream-for-$AB_ARM" > up.txt; sleep 30',
        sharedReady: 'test -f up.txt',
        script: 'cat up.txt',
        armA,
        armB,
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 10,
        sharedOnce: false,
        server,
      });
      expect(r.observed).toBe(true);
      expect(r.a?.output).toContain('upstream-for-a');
      expect(r.b?.output).toContain('upstream-for-b');
      expect(r.a?.sharedAliveAtEnd).toBe(true);
      expect(r.b?.sharedAliveAtEnd).toBe(true);
      // The namespaced server is gone: a leaked one would be the next run's
      // wrong observation.
      expect(spawnSync('tmux', ['-L', server, 'ls']).status).not.toBe(0);
      expect(existsSync(join(tmpdir(), `qwen-review-ab-drive-${server}`))).toBe(
        false,
      );
    });

    it('an upstream that exits at birth is a confound, not a comparison', () => {
      const armA = mkdtempSync(join(tmpdir(), 'ab-real-da-'));
      const r = runAbDrive({
        shared: 'true',
        script: 'sleep 1; echo watched-nothing',
        armA,
        armB: armA,
        readyTimeout: 5,
        timeout: 30,
        sharedReadyTimeout: 5,
        sharedOnce: false,
        server: `abreald-${process.pid}`,
      });
      expect(r.a?.outcome).toBe('completed');
      expect(r.a?.sharedAliveAtEnd).toBe(false);
      expect(r.observed).toBe(false);
      expect(r.note).toContain('died');
    });
  },
);
