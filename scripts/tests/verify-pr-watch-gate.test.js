/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkConflicts,
  claimOwnership,
  conflictingStateFiles,
  deliverGateOutput,
  extractDeliveredHead,
  filterGateOutput,
  isEntryPoint,
  ownedStateFiles,
  ownershipPath,
  releaseOwnership,
  resetWatchCursor,
} from '../../scripts/verify-pr-watch-gate.mjs';
import {
  readState,
  startRound,
  statePath,
} from '../../scripts/verify-pr-watch-state.mjs';

const GATE_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-watch-gate.mjs', import.meta.url),
);

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pr-watch-gate-'));
  tmpDirs.push(dir);
  return dir;
}

describe('filterGateOutput', () => {
  // The scheduler hands every non-empty gate output to the model, so the
  // wrapper is the only place that can keep comment/CI events from waking it.
  it('passes a moved head and a stop, and drops everything else', () => {
    const moved = JSON.stringify({
      headSha: 'b'.repeat(40),
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: 'b'.repeat(40) }],
    });
    const stopped = JSON.stringify({ action: 'stop', reason: 'merged' });
    const fixable = JSON.stringify({
      action: 'fix',
      events: [{ type: 'comment' }],
    });
    const waiting = JSON.stringify({ action: 'wait', events: [] });

    expect(filterGateOutput(moved)).toBe(moved);
    expect(filterGateOutput(stopped)).toBe(stopped);
    expect(filterGateOutput(fixable)).toBe('');
    expect(filterGateOutput(waiting)).toBe('');
  });

  it('leaves a quiet tick quiet', () => {
    expect(filterGateOutput('')).toBe('');
    expect(filterGateOutput('   \n')).toBe('');
  });

  // A probe that changed its output shape must not be mistaken for a quiet
  // tick: forwarding it is loud, swallowing it would hide the breakage.
  it('forwards output it cannot parse instead of swallowing it', () => {
    expect(filterGateOutput('not json')).toBe('not json');
  });
});

describe('conflictingStateFiles', () => {
  it('reports nothing when the PR has no probe state', () => {
    const root = makeRoot();
    expect(conflictingStateFiles(root, 123)).toEqual([]);
  });

  // One cursor serves one watcher: a pre-existing gate cursor means another
  // consumer would take the events this watch needs, stop included.
  it('detects an existing gate cursor', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const [gate] = ownedStateFiles(123);
    writeFileSync(join(root, '.qwen', 'tmp', gate), '{}');

    expect(conflictingStateFiles(root, 123)).toEqual([
      join(root, '.qwen', 'tmp', gate),
    ]);
  });

  // A prepared autofix watch records heads in `knownHeads`, which suppresses
  // the head-move a verification watch would otherwise receive.
  it('detects a prepared autofix watch', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const [, state] = ownedStateFiles(123);
    writeFileSync(join(root, '.qwen', 'tmp', state), '{}');

    expect(conflictingStateFiles(root, 123)).toEqual([
      join(root, '.qwen', 'tmp', state),
    ]);
  });

  // Another PR's state must not block this one.
  it('ignores state for a different PR', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(join(root, '.qwen', 'tmp', ownedStateFiles(124)[0]), '{}');

    expect(conflictingStateFiles(root, 123)).toEqual([]);
  });
});

describe('ownership claim', () => {
  // Two sessions can both run a read-only check before either probe creates a
  // cursor; the atomic create is what makes that race have one winner.
  it('reserves the PR and refuses a second claim', () => {
    const root = makeRoot();
    const first = claimOwnership(root, 123, 1_000_000);
    expect(first.ok).toBe(true);
    expect(first.path).toBe(ownershipPath(root, 123));

    const second = claimOwnership(root, 123, 1_000_000 + 1000);
    expect(second.ok).toBe(false);
  });

  // Not taking over is deliberate: judging a claim stale from a timestamp is
  // itself a race (two sessions can both judge it stale and both write), so a
  // claim left by a dead setup is released with `--release` instead.
  it('refuses an old claim too, leaving release to the operator', () => {
    const root = makeRoot();
    claimOwnership(root, 123, 1_000_000);

    const later = claimOwnership(root, 123, 1_000_000 + 365 * 24 * 3600 * 1000);
    expect(later.ok).toBe(false);
  });

  it('releases a claim, and says so when there was none', () => {
    const root = makeRoot();
    claimOwnership(root, 123, 1_000_000);

    expect(releaseOwnership(root, 123)).toBe(true);
    expect(releaseOwnership(root, 123)).toBe(false);
  });

  it('counts a live claim as a conflict for a read-only check', () => {
    const root = makeRoot();
    claimOwnership(root, 123, 1_000_000);

    expect(checkConflicts(root, 123)).toEqual([ownershipPath(root, 123)]);
  });

  // An unreadable claim is not proof that its setup died; stealing it would
  // let a second install take over while the first watch may still be live.
  it('refuses to steal a claim it cannot parse', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(ownershipPath(root, 123), 'not json');

    expect(claimOwnership(root, 123, 1_000_000).ok).toBe(false);
  });
});

describe('isEntryPoint', () => {
  // `import.meta.url` is percent-encoded; a plain `file://` + path comparison
  // fails on these paths and the wrapper silently does nothing — which the
  // scheduler cannot tell from a quiet tick. The files must exist: the
  // comparison resolves both sides through `realpath`.
  it('matches the executed file under spaces and non-ASCII paths', () => {
    const root = makeRoot();
    for (const name of ['checkout with space', 'checkout 中文']) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'gate.mjs');
      writeFileSync(file, '');
      expect(isEntryPoint(pathToFileURL(file).href, file)).toBe(true);
    }
  });

  it('rejects a different file and a missing argument', () => {
    const file = pathToFileURL('/tmp/a/gate.mjs').href;
    expect(isEntryPoint(file, '/tmp/a/other.mjs')).toBe(false);
    expect(isEntryPoint(file, undefined)).toBe(false);
  });

  // Node resolves the entry module's symlinks, while argv[1] keeps the path the
  // shell was given; a resolve-only comparison would report "not the entry
  // point" and the wrapper would silently do nothing on a symlinked install.
  it.skipIf(process.platform === 'win32')(
    'matches the executed file through a symlinked path',
    () => {
      const root = makeRoot();
      const target = join(root, 'gate.mjs');
      writeFileSync(target, '');
      const link = join(root, 'linked-gate.mjs');
      symlinkSync(target, link);

      expect(isEntryPoint(pathToFileURL(target).href, link)).toBe(true);
    },
  );
});

describe('deliverGateOutput and #17371 pre-delivery', () => {
  const HEAD = 'b'.repeat(40);
  const runGateCli = (args) =>
    spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
      encoding: 'utf8',
    });

  it('extracts headSha from a resync payload and ignores non-resync actions', () => {
    const moved = JSON.stringify({
      headSha: HEAD,
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: HEAD }],
    });
    const eventOnly = JSON.stringify({
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: HEAD }],
    });
    expect(extractDeliveredHead(moved)).toBe(HEAD);
    expect(extractDeliveredHead(eventOnly)).toBe(HEAD);
    expect(
      extractDeliveredHead(JSON.stringify({ action: 'stop', headSha: HEAD })),
    ).toBeNull();
    expect(
      extractDeliveredHead(JSON.stringify({ action: 'fix', headSha: HEAD })),
    ).toBeNull();
    expect(extractDeliveredHead('not json')).toBeNull();
  });

  it('pre-records resync headSha in deferredHeads and promotes on startRound', () => {
    const root = makeRoot();
    const moved = JSON.stringify({
      headSha: HEAD,
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: HEAD }],
    });
    expect(
      deliverGateOutput(moved, {
        stateRoot: root,
        pr: 123,
        repo: 'QwenLM/qwen-code',
      }),
    ).toBe(moved);
    const preState = readState(root, 123);
    expect(preState.deferredHeads.map((e) => e.head)).toEqual([HEAD]);
    const preSeq = preState.deferredHeads[0].seq;
    expect(preSeq).toBe(1);

    const started = startRound(root, {
      pr: 123,
      head: HEAD,
      round: 1,
      artifactDir: null,
      repo: 'QwenLM/qwen-code',
    });
    expect(started.duplicate).toBeUndefined();
    const afterState = readState(root, 123);
    expect(afterState.deferredHeads).toEqual([]);
    expect(afterState.inFlightHeads[0]).toMatchObject({
      head: HEAD,
      round: 1,
      seq: preSeq,
    });
  });

  it('leaves state untouched on stop, fix, wait, or non-JSON output', () => {
    const root = makeRoot();
    for (const payload of [
      JSON.stringify({ action: 'stop', reason: 'merged' }),
      JSON.stringify({ action: 'fix', headSha: HEAD }),
      JSON.stringify({ action: 'wait', events: [] }),
      'not json',
    ]) {
      deliverGateOutput(payload, {
        stateRoot: root,
        pr: 123,
        repo: 'QwenLM/qwen-code',
      });
    }
    expect(existsSync(statePath(root, 123))).toBe(false);
  });

  it('still returns kept output if state file is corrupt or lock is held', () => {
    const moved = JSON.stringify({
      headSha: HEAD,
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: HEAD }],
    });
    const corruptRoot = makeRoot();
    mkdirSync(join(corruptRoot, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(statePath(corruptRoot, 123), '{corrupt');
    expect(
      deliverGateOutput(moved, {
        stateRoot: corruptRoot,
        pr: 123,
        repo: 'QwenLM/qwen-code',
      }),
    ).toBe(moved);

    const lockedRoot = makeRoot();
    mkdirSync(join(lockedRoot, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(`${statePath(lockedRoot, 123)}.lock`, '99999:held\n');
    expect(
      deliverGateOutput(moved, {
        stateRoot: lockedRoot,
        pr: 123,
        repo: 'QwenLM/qwen-code',
      }),
    ).toBe(moved);
  });

  it.skipIf(process.platform === 'win32')(
    'pre-records delivered resync head through the gate CLI',
    () => {
      const root = makeRoot();
      const cli = join(root, 'stub-qwen');
      const moved = JSON.stringify({
        headSha: HEAD,
        action: 'resync',
        events: [{ type: 'head_moved_externally', sha: HEAD }],
      });
      writeFileSync(cli, `#!/usr/bin/env bash\nprintf '%s\\n' '${moved}'\n`, {
        mode: 0o755,
      });
      const res = runGateCli([
        '123',
        '--repo',
        'QwenLM/qwen-code',
        '--cli',
        cli,
        '--state-root',
        root,
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(moved);
      expect(readState(root, 123).deferredHeads.map((e) => e.head)).toEqual([
        HEAD,
      ]);
    },
  );
});

describe('resetWatchCursor and --release --reset-cursor', () => {
  const runGateCli = (args) =>
    spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
      encoding: 'utf8',
    });

  it('removes both ownership claim and probe cursor so --check --claim succeeds', () => {
    const root = makeRoot();
    expect(
      runGateCli(['123', '--check', '--claim', '--state-root', root]).status,
    ).toBe(0);
    const [gateName] = ownedStateFiles(123);
    const gateFile = join(root, '.qwen', 'tmp', gateName);
    writeFileSync(gateFile, '{"headSha":"abc"}');

    // Claim and cursor both exist; --check blocks re-install before reset.
    expect(runGateCli(['123', '--check', '--state-root', root]).status).toBe(3);

    const reset = runGateCli([
      '123',
      '--release',
      '--reset-cursor',
      '--state-root',
      root,
    ]);
    expect(reset.status).toBe(0);
    expect(reset.stderr).toContain('removed probe cursor');
    expect(existsSync(ownershipPath(root, 123))).toBe(false);
    expect(existsSync(gateFile)).toBe(false);
    expect(
      runGateCli(['123', '--check', '--claim', '--state-root', root]).status,
    ).toBe(0);
  });

  it('refuses when autofix-pr state exists or cursor has no verify-pr claim', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const [gateName, stateName] = ownedStateFiles(123);
    const gateFile = join(root, '.qwen', 'tmp', gateName);
    const autofixState = join(root, '.qwen', 'tmp', stateName);
    writeFileSync(gateFile, '{"headSha":"abc"}');

    const unclaimed = runGateCli([
      '123',
      '--release',
      '--reset-cursor',
      '--state-root',
      root,
    ]);
    expect(unclaimed.status).toBe(3);
    expect(existsSync(gateFile)).toBe(true);

    claimOwnership(root, 123);
    writeFileSync(autofixState, '{}');
    const withState = runGateCli([
      '123',
      '--release',
      '--reset-cursor',
      '--state-root',
      root,
    ]);
    expect(withState.status).toBe(3);
    expect(existsSync(gateFile)).toBe(true);
    expect(existsSync(ownershipPath(root, 123))).toBe(true);
    expect(readFileSync(gateFile, 'utf8')).toBe('{"headSha":"abc"}');
  });

  it('rejects --reset-cursor without --release', () => {
    const root = makeRoot();
    expect(resetWatchCursor(root, 999).ok).toBe(true);
    const bad = runGateCli(['123', '--reset-cursor', '--state-root', root]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('--reset-cursor requires --release');
  });
});
