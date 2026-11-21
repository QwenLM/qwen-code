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
  realpathSync,
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

function makeGitEnv(homeDir) {
  const emptyConfig = join(homeDir, '.gitconfig-empty');
  writeFileSync(emptyConfig, '');
  return {
    ...process.env,
    HOME: homeDir,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
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

  it('leaves state untouched and still emits stop while suppressing fix and wait', () => {
    const root = makeRoot();
    const stopPayload = JSON.stringify({ action: 'stop', reason: 'merged' });
    const emitted = [];
    for (const payload of [
      stopPayload,
      JSON.stringify({ action: 'fix', headSha: HEAD }),
      JSON.stringify({ action: 'wait', events: [] }),
      'not json',
    ]) {
      deliverGateOutput(payload, {
        stateRoot: root,
        pr: 123,
        repo: 'QwenLM/qwen-code',
        emit: (line) => emitted.push(line),
      });
    }
    expect(emitted).toEqual([stopPayload, 'not json']);
    expect(existsSync(statePath(root, 123))).toBe(false);
  });

  it('still returns kept output, invokes emit, and leaves corrupt or locked state unmutated', () => {
    const moved = JSON.stringify({
      headSha: HEAD,
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: HEAD }],
    });
    const corruptRoot = makeRoot();
    mkdirSync(join(corruptRoot, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(statePath(corruptRoot, 123), '{corrupt');
    const corruptEmitted = [];
    expect(
      deliverGateOutput(moved, {
        stateRoot: corruptRoot,
        pr: 123,
        repo: 'QwenLM/qwen-code',
        emit: (line) => corruptEmitted.push(line),
      }),
    ).toBe(moved);
    expect(corruptEmitted).toEqual([moved]);
    expect(readFileSync(statePath(corruptRoot, 123), 'utf8')).toBe('{corrupt');

    const lockedRoot = makeRoot();
    mkdirSync(join(lockedRoot, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(`${statePath(lockedRoot, 123)}.lock`, '99999:held\n');
    const lockedEmitted = [];
    expect(
      deliverGateOutput(moved, {
        stateRoot: lockedRoot,
        pr: 123,
        repo: 'QwenLM/qwen-code',
        emit: (line) => lockedEmitted.push(line),
      }),
    ).toBe(moved);
    expect(lockedEmitted).toEqual([moved]);
    expect(existsSync(statePath(lockedRoot, 123))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'pre-records delivered resync head and repo through the gate CLI',
    () => {
      const root = makeRoot();
      expect(
        spawnSync('git', ['init', root], { env: makeGitEnv(makeRoot()) })
          .status,
      ).toBe(0);
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

      // Script inside its own git repo (plus a linked worktree), cwd inside an
      // unrelated git repo -> every verb resolves to cloneRoot, never cwd.
      const gitEnv = makeGitEnv(makeRoot());
      const cloneRoot = makeRoot();
      expect(
        spawnSync('git', ['init', cloneRoot], { env: gitEnv }).status,
      ).toBe(0);
      const cloneGate = stageScripts(cloneRoot);
      expect(
        spawnSync('git', ['-C', cloneRoot, 'add', '.'], { env: gitEnv }).status,
      ).toBe(0);
      expect(
        spawnSync(
          'git',
          [
            '-C',
            cloneRoot,
            '-c',
            'user.email=test@example.com',
            '-c',
            'user.name=Test',
            'commit',
            '-m',
            'init',
          ],
          { env: gitEnv },
        ).status,
      ).toBe(0);
      const linkedWt = makeRoot();
      rmSync(linkedWt, { recursive: true, force: true });
      expect(
        spawnSync(
          'git',
          ['-C', cloneRoot, 'worktree', 'add', linkedWt, '-b', 'wt-branch'],
          { env: gitEnv },
        ).status,
      ).toBe(0);
      const linkedGate = join(linkedWt, 'scripts', 'verify-pr-watch-gate.mjs');

      const otherCwd = makeRoot();
      expect(spawnSync('git', ['init', otherCwd], { env: gitEnv }).status).toBe(
        0,
      );
      const pwdLogA = join(otherCwd, 'probe-pwd.txt');
      const [gateName] = ownedStateFiles(123);
      const cliA = join(otherCwd, 'stub-qwen');
      writeFileSync(
        cliA,
        `#!/usr/bin/env bash
pwd -P > '${pwdLogA}'
mkdir -p "$(pwd -P)/.qwen/tmp"
printf '{"headSha":"abc1234"}' > "$(pwd -P)/.qwen/tmp/${gateName}"
printf '%s\\n' '${moved}'
`,
        { mode: 0o755 },
      );

      // --check --claim from unrelated cwd still claims in cloneRoot.
      const claimRes = spawnSync(
        process.execPath,
        [linkedGate, '123', '--check', '--claim'],
        { cwd: otherCwd, encoding: 'utf8' },
      );
      expect(claimRes.status).toBe(0);
      expect(existsSync(ownershipPath(cloneRoot, 123))).toBe(true);
      expect(existsSync(ownershipPath(otherCwd, 123))).toBe(false);

      const resA = spawnSync(
        process.execPath,
        [linkedGate, '123', '--repo', 'QwenLM/qwen-code', '--cli', cliA],
        { cwd: otherCwd, encoding: 'utf8' },
      );
      expect(resA.status).toBe(0);
      expect(resA.stdout.trim()).toBe(moved);
      expect(realpathSync(readFileSync(pwdLogA, 'utf8').trim())).toBe(
        realpathSync(cloneRoot),
      );
      const gateFileInClone = join(cloneRoot, '.qwen', 'tmp', gateName);
      expect(existsSync(gateFileInClone)).toBe(true);
      expect(existsSync(join(otherCwd, '.qwen', 'tmp', gateName))).toBe(false);
      expect(
        readState(cloneRoot, 123).deferredHeads.map((e) => e.head),
      ).toEqual([HEAD]);
      expect(existsSync(statePath(otherCwd, 123))).toBe(false);

      // R2-1 / R3-1: --release --reset-cursor from unrelated otherCwd removes
      // the probe-written cursor & claim in cloneRoot instead of otherCwd.
      const resetFromOther = spawnSync(
        process.execPath,
        [cloneGate, '123', '--release', '--reset-cursor'],
        { cwd: otherCwd, encoding: 'utf8' },
      );
      expect(resetFromOther.status).toBe(0);
      expect(resetFromOther.stderr).toContain(
        'removed probe cursor (last head abc1234)',
      );
      expect(existsSync(ownershipPath(cloneRoot, 123))).toBe(false);
      expect(existsSync(gateFileInClone)).toBe(false);
      expect(existsSync(ownershipPath(otherCwd, 123))).toBe(false);

      // Script outside any git repo (/trusted-scripts layout), cwd inside a
      // git repo -> never writes shadow state into cwd; probe warns and --check/--release exit 2.
      const nonGitRoot = makeRoot();
      const isolatedGate = stageScripts(nonGitRoot);
      const cwdGit = makeRoot();
      expect(spawnSync('git', ['init', cwdGit], { env: gitEnv }).status).toBe(
        0,
      );
      expect(resolveDeliveryRoot(null, nonGitRoot)).toMatchObject({
        root: null,
      });
      for (const verbArgs of [
        ['123', '--check'],
        ['123', '--check', '--claim'],
        ['123', '--release'],
        ['123', '--release', '--reset-cursor'],
      ]) {
        const refused = spawnSync(
          process.execPath,
          [isolatedGate, ...verbArgs],
          { cwd: cwdGit, encoding: 'utf8' },
        );
        expect(refused.status, verbArgs.join(' ')).toBe(2);
        expect(refused.stderr).toContain('is not a git worktree');
        expect(existsSync(ownershipPath(cwdGit, 123))).toBe(false);
      }
      const pwdLogB = join(nonGitRoot, 'probe-pwd.txt');
      const cliB = join(nonGitRoot, 'stub-qwen');
      writeFileSync(
        cliB,
        `#!/usr/bin/env bash
pwd -P > '${pwdLogB}'
mkdir -p "$(pwd -P)/.qwen/tmp"
printf '{"headSha":"abc1234"}' > "$(pwd -P)/.qwen/tmp/${gateName}"
printf '%s\\n' '${moved}'
`,
        { mode: 0o755 },
      );
      const resB = spawnSync(
        process.execPath,
        [isolatedGate, '123', '--repo', 'QwenLM/qwen-code', '--cli', cliB],
        { cwd: cwdGit, encoding: 'utf8' },
      );
      expect(resB.status).toBe(2);
      expect(resB.stdout).toBe('');
      expect(resB.stderr).toContain('is not a git worktree');
      expect(existsSync(pwdLogB)).toBe(false);
      expect(existsSync(join(cwdGit, '.qwen', 'tmp', gateName))).toBe(false);
      expect(existsSync(statePath(cwdGit, 123))).toBe(false);

      // R3-2: reject empty, flag-like, or relative --state-root (plus sibling flag usage errors).
      const isolatedCwd = makeRoot();
      for (const [badArgs, pattern] of [
        [['123', '--check', '--state-root', ''], /must be an absolute path/],
        [
          ['123', '--check', '--state-root', '--claim'],
          /must be an absolute path/,
        ],
        [
          ['123', '--check', '--state-root', 'relroot'],
          /must be an absolute path/,
        ],
        [['123', '--repo', '--cli', 'qwen'], /--repo requires/],
        [['123', '--repo', 'QwenLM/qwen-code', '--cli', ''], /--cli requires/],
        [['123', '--unknown-flag'], /unknown option/],
      ]) {
        const res = spawnSync(process.execPath, [GATE_SCRIPT, ...badArgs], {
          cwd: isolatedCwd,
          encoding: 'utf8',
        });
        expect(res.status, badArgs.join(' ')).toBe(2);
        expect(res.stderr, badArgs.join(' ')).toMatch(pattern);
      }
      expect(existsSync(ownershipPath(isolatedCwd, 123))).toBe(false);
      expect(existsSync(join(isolatedCwd, 'relroot'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'spawns the probe child in --state-root with expected argv and propagates failing probe exit codes',
    () => {
      const moved = JSON.stringify({
        headSha: HEAD,
        action: 'resync',
        events: [{ type: 'head_moved_externally', sha: HEAD }],
      });
      const gitEnv = makeGitEnv(makeRoot());
      const stateRoot = makeRoot();
      expect(
        spawnSync('git', ['init', stateRoot], { env: gitEnv }).status,
      ).toBe(0);
      const callerCwd = makeRoot();
      expect(
        spawnSync('git', ['init', callerCwd], { env: gitEnv }).status,
      ).toBe(0);

      const pwdLog = join(stateRoot, 'child-pwd.txt');
      const argvLog = join(stateRoot, 'child-argv.txt');
      const [gateName] = ownedStateFiles(123);
      const cli = join(callerCwd, 'stub-qwen');
      writeFileSync(
        cli,
        `#!/usr/bin/env bash
pwd -P > '${pwdLog}'
printf '%s\\n' "$@" > '${argvLog}'
mkdir -p "$(pwd -P)/.qwen/tmp"
printf '{"headSha":"${HEAD}"}' > "$(pwd -P)/.qwen/tmp/${gateName}"
printf '%s\\n' '${moved}'
`,
        { mode: 0o755 },
      );

      const ok = spawnSync(
        process.execPath,
        [
          GATE_SCRIPT,
          '123',
          '--repo',
          'QwenLM/qwen-code',
          '--cli',
          cli,
          '--state-root',
          stateRoot,
        ],
        { cwd: callerCwd, encoding: 'utf8' },
      );
      expect(ok.status).toBe(0);
      expect(ok.stdout.trim()).toBe(moved);
      expect(realpathSync(readFileSync(pwdLog, 'utf8').trim())).toBe(
        realpathSync(stateRoot),
      );
      expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual([
        'autofix-pr',
        'snapshot',
        '123',
        '--gate',
        '--repo',
        'QwenLM/qwen-code',
      ]);
      expect(existsSync(join(stateRoot, '.qwen', 'tmp', gateName))).toBe(true);
      expect(existsSync(join(callerCwd, '.qwen', 'tmp', gateName))).toBe(false);
      expect(
        readState(stateRoot, 123).deferredHeads.map((e) => e.head),
      ).toEqual([HEAD]);

      const failRoot = makeRoot();
      expect(spawnSync('git', ['init', failRoot], { env: gitEnv }).status).toBe(
        0,
      );
      const failCli = join(callerCwd, 'failing-qwen');
      writeFileSync(
        failCli,
        `#!/usr/bin/env bash
printf 'probe boom\\n' >&2
exit 3
`,
        { mode: 0o755 },
      );
      const failed = spawnSync(
        process.execPath,
        [
          GATE_SCRIPT,
          '123',
          '--repo',
          'QwenLM/qwen-code',
          '--cli',
          failCli,
          '--state-root',
          failRoot,
        ],
        { cwd: callerCwd, encoding: 'utf8' },
      );
      expect(failed.status).toBe(3);
      expect(failed.stderr).toContain('probe boom');
      expect(failed.stdout).toBe('');
      expect(existsSync(statePath(failRoot, 123))).toBe(false);

      // Probe tick refuses non-git --state-root with exit 2 without spawning
      // the probe, while --check --claim still accepts an explicit directory.
      const nonGitStateRoot = makeRoot();
      const ranMarker = join(nonGitStateRoot, 'probe-ran');
      const markerCli = join(callerCwd, 'marker-qwen');
      writeFileSync(
        markerCli,
        `#!/usr/bin/env bash
touch '${ranMarker}'
`,
        { mode: 0o755 },
      );
      const nonGitProbe = spawnSync(
        process.execPath,
        [
          GATE_SCRIPT,
          '123',
          '--repo',
          'QwenLM/qwen-code',
          '--cli',
          markerCli,
          '--state-root',
          nonGitStateRoot,
        ],
        { cwd: callerCwd, encoding: 'utf8' },
      );
      expect(nonGitProbe.status).toBe(2);
      expect(nonGitProbe.stderr).toContain('is not a git worktree');
      expect(existsSync(ranMarker)).toBe(false);
      expect(
        runGateCli([
          '123',
          '--check',
          '--claim',
          '--state-root',
          nonGitStateRoot,
        ]).status,
      ).toBe(0);
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

  it('supports plain --release when autofix-pr cursor and state exist without touching autofix files', () => {
    const root = makeRoot();
    claimOwnership(root, 123);
    const [gateName, stateName] = ownedStateFiles(123);
    const gateFile = join(root, '.qwen', 'tmp', gateName);
    const autofixState = join(root, '.qwen', 'tmp', stateName);
    writeFileSync(gateFile, '{"headSha":"abc"}');
    writeFileSync(autofixState, '{"owner":"autofix"}');

    const res = runGateCli(['123', '--release', '--state-root', root]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('released PR 123');
    expect(existsSync(ownershipPath(root, 123))).toBe(false);
    expect(readFileSync(gateFile, 'utf8')).toBe('{"headSha":"abc"}');
    expect(readFileSync(autofixState, 'utf8')).toBe('{"owner":"autofix"}');
  });

  it('removes an unreadable or headless probe cursor alongside releasing the claim', () => {
    for (const payload of ['not json', '{}']) {
      const root = makeRoot();
      claimOwnership(root, 123);
      const [gateName] = ownedStateFiles(123);
      const gateFile = join(root, '.qwen', 'tmp', gateName);
      writeFileSync(gateFile, payload);

      const res = runGateCli([
        '123',
        '--release',
        '--reset-cursor',
        '--state-root',
        root,
      ]);
      expect(res.status).toBe(0);
      expect(res.stderr).toContain('removed probe cursor');
      expect(res.stderr).not.toContain('last head');
      expect(existsSync(ownershipPath(root, 123))).toBe(false);
      expect(existsSync(gateFile)).toBe(false);
    }
  });
});
