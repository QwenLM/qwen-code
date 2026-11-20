/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
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
  resolveDeliveryRoot,
} from '../../scripts/verify-pr-watch-gate.mjs';
import {
  readState,
  startRound,
  statePath,
} from '../../scripts/verify-pr-watch-state.mjs';

const GATE_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-watch-gate.mjs', import.meta.url),
);
const STATE_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-watch-state.mjs', import.meta.url),
);
const CHECK_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
);
const ENTRY_POINT_LIB = fileURLToPath(
  new URL('../../scripts/lib/entry-point.js', import.meta.url),
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

  it('pre-records resync headSha with repo in deferredHeads BEFORE emit and promotes on startRound', () => {
    const root = makeRoot();
    const moved = JSON.stringify({
      headSha: HEAD,
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: HEAD }],
    });
    let stateAtEmit = null;
    expect(
      deliverGateOutput(moved, {
        stateRoot: root,
        pr: 123,
        repo: 'QwenLM/qwen-code',
        emit: (line) => {
          expect(line).toBe(moved);
          stateAtEmit = readState(root, 123);
        },
      }),
    ).toBe(moved);
    expect(stateAtEmit).not.toBeNull();
    expect(stateAtEmit.repo).toBe('QwenLM/qwen-code');
    expect(stateAtEmit.deferredHeads.map((e) => e.head)).toEqual([HEAD]);
    const preSeq = stateAtEmit.deferredHeads[0].seq;
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

  it('still returns kept output and leaves corrupt or locked state unmutated', () => {
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
    expect(readFileSync(statePath(corruptRoot, 123), 'utf8')).toBe('{corrupt');

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
    expect(existsSync(statePath(lockedRoot, 123))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'pre-records delivered resync head and repo through the gate CLI',
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
      const saved = readState(root, 123);
      expect(saved.repo).toBe('QwenLM/qwen-code');
      expect(saved.deferredHeads.map((e) => e.head)).toEqual([HEAD]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'resolves default delivery root from the script git worktree and never falls back to cwd',
    () => {
      const stageScripts = (targetRoot) => {
        const scriptsDir = join(targetRoot, 'scripts');
        const libDir = join(scriptsDir, 'lib');
        mkdirSync(libDir, { recursive: true });
        copyFileSync(GATE_SCRIPT, join(scriptsDir, 'verify-pr-watch-gate.mjs'));
        copyFileSync(
          STATE_SCRIPT,
          join(scriptsDir, 'verify-pr-watch-state.mjs'),
        );
        copyFileSync(CHECK_SCRIPT, join(scriptsDir, 'verify-pr-check.mjs'));
        copyFileSync(ENTRY_POINT_LIB, join(libDir, 'entry-point.js'));
        return join(scriptsDir, 'verify-pr-watch-gate.mjs');
      };

      const moved = JSON.stringify({
        headSha: HEAD,
        action: 'resync',
        events: [{ type: 'head_moved_externally', sha: HEAD }],
      });

      // Script inside its own git repo, cwd elsewhere -> writes in script's repo.
      const cloneRoot = makeRoot();
      expect(spawnSync('git', ['init', cloneRoot]).status).toBe(0);
      const cloneGate = stageScripts(cloneRoot);
      const otherCwd = makeRoot();
      expect(spawnSync('git', ['init', otherCwd]).status).toBe(0);
      const cliA = join(otherCwd, 'stub-qwen');
      writeFileSync(cliA, `#!/usr/bin/env bash\nprintf '%s\\n' '${moved}'\n`, {
        mode: 0o755,
      });
      const resA = spawnSync(
        process.execPath,
        [cloneGate, '123', '--repo', 'QwenLM/qwen-code', '--cli', cliA],
        { cwd: otherCwd, encoding: 'utf8' },
      );
      expect(resA.status).toBe(0);
      expect(resA.stdout.trim()).toBe(moved);
      expect(
        readState(cloneRoot, 123).deferredHeads.map((e) => e.head),
      ).toEqual([HEAD]);
      expect(existsSync(statePath(otherCwd, 123))).toBe(false);

      // Script outside any git repo (/trusted-scripts layout), cwd inside a
      // git repo -> never writes shadow state into cwd; warns on stderr.
      const nonGitRoot = makeRoot();
      const isolatedGate = stageScripts(nonGitRoot);
      const cwdGit = makeRoot();
      expect(spawnSync('git', ['init', cwdGit]).status).toBe(0);
      expect(resolveDeliveryRoot(null, nonGitRoot)).toMatchObject({
        root: null,
      });
      const cliB = join(nonGitRoot, 'stub-qwen');
      writeFileSync(cliB, `#!/usr/bin/env bash\nprintf '%s\\n' '${moved}'\n`, {
        mode: 0o755,
      });
      const resB = spawnSync(
        process.execPath,
        [isolatedGate, '123', '--repo', 'QwenLM/qwen-code', '--cli', cliB],
        { cwd: cwdGit, encoding: 'utf8' },
      );
      expect(resB.status).toBe(0);
      expect(resB.stdout.trim()).toBe(moved);
      expect(resB.stderr).toContain('pre-delivery skipped');
      expect(resB.stderr).toContain('is not a git worktree');
      expect(existsSync(statePath(cwdGit, 123))).toBe(false);
    },
  );
});

describe('resetWatchCursor and --release --reset-cursor', () => {
  const runGateCli = (args) =>
    spawnSync(process.execPath, [GATE_SCRIPT, ...args], {
      encoding: 'utf8',
    });

  it('removes both ownership claim and probe cursor, reports last headSha, and tolerates an absent cursor', () => {
    const root = makeRoot();
    expect(
      runGateCli(['123', '--check', '--claim', '--state-root', root]).status,
    ).toBe(0);

    // Ordinary first-migration path: claim exists with no cursor yet -> ENOENT tolerated.
    const ordinaryReset = runGateCli([
      '123',
      '--release',
      '--reset-cursor',
      '--state-root',
      root,
    ]);
    expect(ordinaryReset.status).toBe(0);
    expect(existsSync(ownershipPath(root, 123))).toBe(false);

    // Re-claim with an active probe cursor -> reset reports cursor headSha and clears both.
    expect(
      runGateCli(['123', '--check', '--claim', '--state-root', root]).status,
    ).toBe(0);
    const [gateName] = ownedStateFiles(123);
    const gateFile = join(root, '.qwen', 'tmp', gateName);
    writeFileSync(gateFile, '{"headSha":"abc1234"}');

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
    expect(reset.stderr).toContain('removed probe cursor (last head abc1234)');
    expect(existsSync(ownershipPath(root, 123))).toBe(false);
    expect(existsSync(gateFile)).toBe(false);
    expect(
      runGateCli(['123', '--check', '--claim', '--state-root', root]).status,
    ).toBe(0);
  });

  it('keeps the ownership claim intact when cursor unlink fails', () => {
    const root = makeRoot();
    claimOwnership(root, 123);
    const [gateName] = ownedStateFiles(123);
    const gateDir = join(root, '.qwen', 'tmp', gateName);
    mkdirSync(gateDir, { recursive: true });

    const res = resetWatchCursor(root, 123);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('cursor-unlink-failed');
    expect(existsSync(ownershipPath(root, 123))).toBe(true);

    const cliRes = runGateCli([
      '123',
      '--release',
      '--reset-cursor',
      '--state-root',
      root,
    ]);
    expect(cliRes.status).toBe(3);
    expect(cliRes.stderr).toContain('failed to remove probe cursor');
    expect(existsSync(ownershipPath(root, 123))).toBe(true);
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
