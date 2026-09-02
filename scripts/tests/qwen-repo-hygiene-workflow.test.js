/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/repo-hygiene.yml', 'utf8');
const runnerScriptPath = '.qwen/skills/repo-hygiene/scripts/run-agent.mjs';
const gitAvailable = spawnSync('git', ['--version']).status === 0;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function step(name) {
  const escaped = escapeRegExp(name);
  const match = workflow.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|\\n\\s{2}[a-zA-Z0-9_-]+:|$)`,
    ),
  );
  return match?.[0] ?? '';
}

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start === -1) {
    return '';
  }
  const nextJob = workflow.slice(start + 1).search(/\n {2}\S/);
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + 1 + nextJob);
}

// The body of a step's `run: |-` block, dedented to column zero.
function stepBody(name) {
  const body = step(name).match(/run: \|-\n([\s\S]*)$/)?.[1] ?? '';
  return body.replace(/^ {10}/gm, '');
}

// Every embedded `node -e '...'` program in a step, selected by a marker
// substring unique to the block we want. None of the bookkeeping programs
// contain a single quote, so the first whitespace-then-quote line after the
// opening `node -e '` is the real closing delimiter.
function nodeBlock(stepText, marker) {
  const re = /node -e '\n([\s\S]*?)\n[ \t]*'/g;
  let match;
  while ((match = re.exec(stepText)) !== null) {
    if (match[1].includes(marker)) {
      return match[1];
    }
  }
  return '';
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-hygiene-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixtureFix = (id) => ({
  id,
  rootCause: 'r',
  evidence: 'e',
  whyReal: 'w',
  minimalFix: 'm',
});

function seedFindings(workdir, fixes, reportOnly = []) {
  writeFileSync(
    join(workdir, 'findings.json'),
    JSON.stringify({ fixes, reportOnly }, null, 2),
  );
}

function readFindings(workdir) {
  return JSON.parse(readFileSync(join(workdir, 'findings.json'), 'utf8'));
}

function runNodeBlock(script, workdir, env = {}) {
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, WORKDIR: workdir, ...env },
  });
}

function writeQwenStub(dir, lines = []) {
  const stub = join(dir, 'qwen-stub.mjs');
  writeFileSync(stub, ['#!/usr/bin/env node', ...lines, ''].join('\n'));
  chmodSync(stub, 0o755);
  return stub;
}

// A stub that learns its workdir from the runner's prompt (the runner embeds
// `--workdir <dir>` in the Invocation line; the skill body only ever uses the
// `<workdir>` placeholder, so the first literal match is the real one).
function writeWorkdirStub(dir, lines) {
  return writeQwenStub(dir, [
    "import { writeFileSync } from 'node:fs';",
    "const prompt = process.argv[process.argv.indexOf('--prompt') + 1] ?? '';",
    'const workdir = prompt.match(/--workdir (\\S+)/)?.[1];',
    ...lines,
  ]);
}

function runRunner(args, env = {}) {
  return spawnSync(process.execPath, [runnerScriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

function runScan(dir, stub, extraArgs = []) {
  return runRunner([
    '--mode',
    'scan',
    '--workdir',
    dir,
    '--qwen-bin',
    stub,
    ...extraArgs,
  ]);
}

// The gate step runs `sed -i -e EXPR` (GNU style) as its rebase editor. The
// workflow only ever executes on ubuntu-latest, but this suite also runs in
// the macOS merge-queue job, where BSD sed needs `sed -i '' -e EXPR`. Shim
// `sed` on darwin only; on GNU sed the passthrough leaves production behavior
// untouched.
function withGnuSed(env, root) {
  if (process.platform !== 'darwin') {
    return env;
  }
  const bin = join(root, 'gnu-sed-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'sed'),
    [
      '#!/bin/sh',
      'if [ "$1" = "-i" ]; then',
      '  shift',
      '  exec /usr/bin/sed -i \'\' "$@"',
      'fi',
      'exec /usr/bin/sed "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'sed'), 0o755);
  return { ...env, PATH: `${bin}:${env.PATH ?? ''}` };
}

describe('repo-hygiene workflow structure', () => {
  it('splits the patrol into a read-only scan phase and a writing fix phase', () => {
    expect(workflow).toContain("cron: '0 3 * * 1'");
    expect(workflow).toContain("group: 'repo-hygiene'");
    expect(workflow).toContain("WORKDIR: '/tmp/hygiene'");

    const scanJob = job('scan');
    const fixJob = job('fix');
    expect(scanJob).toBeTruthy();
    expect(fixJob).toBeTruthy();
    // The fix phase only runs on a successful scan, and reads the scan's
    // findings artifact rather than re-scanning.
    expect(fixJob).toContain("needs.scan.result == 'success'");
    expect(fixJob).toContain("needs: 'scan'");
    expect(fixJob).toContain('Download scan findings');

    // Both phases are read-only at the permissions level; the push uses the
    // bot PAT, never a workflow write token.
    expect(scanJob).toContain("contents: 'read'");
    expect(fixJob).toContain("contents: 'read'");
  });

  it('skips the whole patrol while a hygiene PR is already open', () => {
    const dedupJob = job('dedup');
    expect(dedupJob).toContain('gh pr list');
    expect(dedupJob).toContain('startswith("hygiene/")');
    expect(dedupJob).toContain('open_prs_present=true');
    // Both downstream jobs gate on the dedup output.
    expect(job('scan')).toContain(
      "needs.dedup.outputs.open_prs_present == 'false'",
    );
    expect(workflow).toContain(
      "steps.dedup.outputs.open_prs_present == 'false'",
    );
  });

  it('bounds every job and the long agent steps with timeouts', () => {
    expect(job('dedup')).toContain('timeout-minutes: 5');
    expect(job('scan')).toContain('timeout-minutes: 120');
    expect(job('fix')).toContain('timeout-minutes: 180');
    expect(step('Run scan agent')).toContain('timeout-minutes: 70');
    expect(step('Run fix agent')).toContain('timeout-minutes: 80');
  });

  it('keeps the scan agent read-only (no commit/add/push, no permissions block)', () => {
    const scanStep = step('Run scan agent');
    expect(scanStep).toContain('"run_shell_command(git diff)"');
    expect(scanStep).toContain('"run_shell_command(git log)"');
    expect(scanStep).not.toContain('run_shell_command(git commit)');
    expect(scanStep).not.toContain('run_shell_command(git add)');
    expect(scanStep).not.toContain('run_shell_command(git push)');
    // Only the fix agent carries an allow/deny permissions block.
    expect(scanStep).not.toContain('"permissions"');
    expect(step('Run fix agent')).toContain('"permissions"');
  });

  it('lets the fix agent commit but never push, and denies build/config writes', () => {
    const fixStep = step('Run fix agent');
    expect(fixStep).toContain('"run_shell_command(git commit)"');
    expect(fixStep).toContain('"run_shell_command(git add)"');
    expect(fixStep).not.toContain('run_shell_command(git push)');
    // The deny list keeps the agent off the workflow, the lockfiles, and the
    // build/lint/test config that verification later relies on.
    for (const denied of [
      'write_file(/.github/**)',
      'write_file(/.git/**)',
      'write_file(**/package.json)',
      'write_file(**/package-lock.json)',
      'write_file(**/eslint.config.*)',
      'write_file(**/vitest.config.*)',
      'write_file(**/vite.config.*)',
      'write_file(**/tsconfig.json)',
    ]) {
      expect(fixStep).toContain(`"${denied}"`);
    }
  });

  it('refuses to fix from a scan that reported it was blocked or malformed', () => {
    const validate = step('Validate findings');
    expect(validate).toContain('if [[ -s "${WORKDIR}/failure.md" ]]; then');
    expect(validate).toContain(
      'if [[ ! -s "${WORKDIR}/findings.json" ]]; then',
    );
    expect(validate).toContain('if ! jq -e . "${WORKDIR}/findings.json"');
    expect(validate).toContain(
      '(.fixes | type == "array") and (.reportOnly | type == "array")',
    );
  });

  it('executes agent-written code only inside a network-less sandbox', () => {
    const verify = step('Independent verification');
    expect(verify).toContain('--network none');
    expect(verify).toContain('--cap-drop ALL');
    expect(verify).toContain('--security-opt no-new-privileges');
    expect(verify).toContain('--init --rm -i');
    // The code-touching checks run inside the image, not on the bare runner.
    expect(verify).toContain(
      'docker run "${SANDBOX_ARGS[@]}" "${QWEN_SANDBOX_IMAGE}" bash -c \'npm run typecheck\'',
    );
    expect(verify).toContain(
      'docker run "${SANDBOX_ARGS[@]}" "${QWEN_SANDBOX_IMAGE}" bash -c \'npm run build\'',
    );
    expect(verify).toContain(
      'docker run "${SANDBOX_ARGS[@]}" "${QWEN_SANDBOX_IMAGE}" bash -c \'npm run lint\'',
    );
    // Gate scripts are re-staged from the trusted checkout right before
    // verification, so an agent write to RUNNER_TEMP cannot redefine a gate.
    expect(verify).toContain(
      'cp .github/scripts/check-settings-schema.sh "${RUNNER_TEMP}/check-settings-schema.sh"',
    );
    expect(verify).toContain(
      'cp .github/scripts/check-autofix-contracts.sh "${RUNNER_TEMP}/check-autofix-contracts.sh"',
    );
    expect(verify).toContain(
      'cp .github/scripts/resolve-owning-packages.sh "${RUNNER_TEMP}/resolve-owning-packages.sh"',
    );
    // WORKDIR holds the PR title/body and findings.json the publish and issue
    // steps consume after verification, so it is mounted read-only: sandboxed
    // code must not rewrite the prose the bot later publishes. HOME and the npm
    // cache live in a dedicated read-write scratch dir instead of WORKDIR.
    expect(verify).toContain(
      '--mount "type=bind,src=${WORKDIR},dst=${WORKDIR},readonly"',
    );
    expect(verify).toContain('SANDBOX_SCRATCH="${WORKDIR}-sandbox"');
    expect(verify).toContain(
      '--mount "type=bind,src=${SANDBOX_SCRATCH},dst=${SANDBOX_SCRATCH}"',
    );
    expect(verify).toContain('-e "HOME=${SANDBOX_SCRATCH}/sandbox-home"');
    expect(verify).toContain(
      '-e "npm_config_cache=${SANDBOX_SCRATCH}/npm-cache"',
    );
    expect(verify).not.toContain('HOME=${WORKDIR}/');
    expect(verify).not.toContain('npm_config_cache=${WORKDIR}/');
  });

  it('pushes from a clean clone with neutralized git config and bypassed hooks', () => {
    const publish = step('Push and open PR');
    expect(publish).toContain('export GIT_CONFIG_GLOBAL=/dev/null');
    expect(publish).toContain('export GIT_CONFIG_SYSTEM=/dev/null');
    expect(publish).toContain(
      'git clone --no-checkout "file://${GITHUB_WORKSPACE}" "${PUSH_DIR}"',
    );
    expect(publish).toContain('push --no-verify');
    // The PAT rides only on the push command line, never into a config file.
    expect(publish).toContain(
      'https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git',
    );
  });
});

describe('repo-hygiene size gate', () => {
  it('pins the per-commit caps, the production-only exclude, and a single full-SHA rebase', () => {
    const gate = step('Gate on agent outcome');
    expect(gate).toContain("MAX_FILES_PER_FIX='3'");
    expect(gate).toContain("MAX_LINES_PER_FIX='100'");
    expect(gate).toContain(
      "PROD_EXCLUDE='(^docs/|\\.md$|\\.test\\.|\\.spec\\.|__tests__/|__snapshots__/)'",
    );
    // One interactive rebase drops every oversized commit at once; sequential
    // rebases only work while drops stay newest-first, so a single todo edit
    // is the load-bearing invariant.
    expect(gate.match(/rebase -i "origin\/main"/g)).toHaveLength(1);
    expect(gate).toContain('GIT_SEQUENCE_EDITOR="sed -i${SED_EXPRS}"');
    // core.abbrev=40 makes the todo list full SHAs so the sed match cannot hit
    // a colliding short-SHA prefix.
    expect(gate).toContain('git -c core.abbrev=40 rebase -i "origin/main"');
    expect(gate).toContain(
      'SED_EXPRS="${SED_EXPRS} -e \'s/^pick \\(${sha}\\)/drop \\1/\'"',
    );
    // A conflicted drop aborts and salvages rather than pushing a half-rebased
    // branch.
    expect(gate).toContain('git rebase --abort || true');
    // The dirty-tree check must precede the no-diff early exit.
    expect(gate.indexOf('git status --porcelain')).toBeLessThan(
      gate.indexOf('git diff --quiet origin/main'),
    );
  });

  it.skipIf(!gitAvailable)(
    'drops oversized commits, keeps boundary and test/docs-only changes, and books them to reportOnly',
    () => {
      withTmpDir((root) => {
        const repo = join(root, 'repo');
        const origin = join(root, 'origin.git');
        const workdir = join(root, 'workdir');
        mkdirSync(repo, { recursive: true });
        mkdirSync(workdir, { recursive: true });

        const gitEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        };
        const git = (args, cwd = repo) => {
          const result = spawnSync('git', args, {
            cwd,
            env: gitEnv,
            encoding: 'utf8',
          });
          if (result.status !== 0) {
            throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
          }
          return result.stdout;
        };

        const BRANCH = 'hygiene/test';
        git(['init', '-q']);
        git(['config', 'user.email', 't@t']);
        git(['config', 'user.name', 't']);
        git(['config', 'commit.gpgsign', 'false']);
        writeFileSync(join(repo, 'README.md'), 'base\n');
        git(['add', '.']);
        git(['commit', '-qm', 'base']);
        git(['branch', '-M', 'main']);
        spawnSync('git', ['clone', '-q', '--bare', repo, origin], {
          env: gitEnv,
          encoding: 'utf8',
        });
        git(['remote', 'add', 'origin', origin]);
        git(['fetch', '-q', 'origin']);
        git(['checkout', '-qb', BRANCH]);

        // A: one production file plus docs/test noise — survives, and the
        // docs/test files must NOT count toward the cap.
        writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
        mkdirSync(join(repo, 'docs'), { recursive: true });
        writeFileSync(join(repo, 'docs', 'x.md'), 'doc\n');
        writeFileSync(join(repo, 'a.test.ts'), 'test\n');
        git(['add', '.']);
        git(['commit', '-qm', 'fix: small [A]']);
        // D: exactly three production files — boundary, survives (cap is > 3).
        for (const n of ['d1', 'd2', 'd3']) {
          writeFileSync(join(repo, `${n}.ts`), `export const ${n} = 1;\n`);
        }
        git(['add', '.']);
        git(['commit', '-qm', 'fix: three files [D]']);
        // E: exactly one hundred production lines — boundary, survives.
        writeFileSync(
          join(repo, 'e.ts'),
          Array.from(
            { length: 100 },
            (_, i) => `export const e${i} = ${i};`,
          ).join('\n') + '\n',
        );
        git(['add', '.']);
        git(['commit', '-qm', 'fix: hundred lines [E]']);
        // B: four production files — dropped by the file cap.
        for (const n of ['b1', 'b2', 'b3', 'b4']) {
          writeFileSync(join(repo, `${n}.ts`), `export const ${n} = 1;\n`);
        }
        git(['add', '.']);
        git(['commit', '-qm', 'fix: too many files [B]']);
        // C: one hundred twenty production lines — dropped by the line cap.
        writeFileSync(
          join(repo, 'c.ts'),
          Array.from(
            { length: 120 },
            (_, i) => `export const c${i} = ${i};`,
          ).join('\n') + '\n',
        );
        git(['add', '.']);
        git(['commit', '-qm', 'fix: too many lines [C]']);

        seedFindings(workdir, ['A', 'D', 'E', 'B', 'C'].map(fixtureFix));
        writeFileSync(join(workdir, 'pr-title.txt'), 'title\n');
        writeFileSync(join(workdir, 'pr-body.md'), 'body\n');
        const ghOutput = join(root, 'gh-output.txt');
        writeFileSync(ghOutput, '');

        const gateScript = join(root, 'gate.sh');
        writeFileSync(
          gateScript,
          stepBody('Gate on agent outcome').replaceAll(
            '${{ steps.branch.outputs.name }}',
            BRANCH,
          ),
        );

        const result = spawnSync('bash', ['-e', gateScript], {
          cwd: repo,
          env: withGnuSed(
            { ...gitEnv, WORKDIR: workdir, GITHUB_OUTPUT: ghOutput },
            root,
          ),
          encoding: 'utf8',
        });

        expect(result.status).toBe(0);
        // The two oversized commits are named and dropped; the boundary and
        // test/docs-only commits are not.
        expect(result.stdout).toContain('touches 4 production files; cap is 3');
        expect(result.stdout).toContain(
          'has 120 production diff lines; cap is 100',
        );
        // Exactly two commits are dropped (the file-cap and line-cap ones).
        // The boundary 3-file and 100-line commits and the test/docs-only
        // commit all survive, so no other "Dropping." message may appear.
        expect(result.stdout.split('Dropping.').length - 1).toBe(2);

        // Only B and C are booked to reportOnly, as dropped-gate.
        const findings = readFindings(workdir);
        expect(findings.fixes.map((f) => f.id).sort()).toEqual(['A', 'D', 'E']);
        expect(findings.reportOnly.map((f) => f.id).sort()).toEqual(['B', 'C']);
        for (const entry of findings.reportOnly) {
          expect(entry.status).toBe('dropped-gate');
          expect(entry.minimalFix).toContain('(dropped by gate');
        }

        // The branch keeps exactly the three surviving commits.
        const subjects = git(['log', '--format=%s', `origin/main..${BRANCH}`]);
        expect(subjects).toContain('fix: small [A]');
        expect(subjects).toContain('fix: three files [D]');
        expect(subjects).toContain('fix: hundred lines [E]');
        expect(subjects).not.toContain('fix: too many files [B]');
        expect(subjects).not.toContain('fix: too many lines [C]');

        // The gate reports the surviving commit count and a fixes result.
        const output = readFileSync(ghOutput, 'utf8');
        expect(output).toContain('result=fixes');
        expect(output).toContain('commits=3');

        // The PR body is annotated with the dropped commits.
        const prBody = readFileSync(join(workdir, 'pr-body.md'), 'utf8');
        expect(prBody).toContain('fix: too many files [B]');
        expect(prBody).toContain('fix: too many lines [C]');
        expect(prBody).not.toContain('fix: small [A]');
      });
    },
    60_000,
  );
});

describe('repo-hygiene findings bookkeeping', () => {
  it('salvages committed findings when the agent fails after committing', () => {
    withTmpDir((workdir) => {
      seedFindings(workdir, [fixtureFix('A'), fixtureFix('B')]);
      const script = nodeBlock(
        step('Salvage committed findings on failure'),
        'salvaged',
      );
      expect(script).toBeTruthy();
      const result = runNodeBlock(script, workdir, {
        SALVAGED_MSGS: 'fix: thing [A]\n',
      });
      expect(result.status).toBe(0);
      const findings = readFindings(workdir);
      expect(findings.fixes.map((f) => f.id)).toEqual(['B']);
      expect(findings.reportOnly).toHaveLength(1);
      expect(findings.reportOnly[0].id).toBe('A');
      expect(findings.reportOnly[0].status).toBe('salvaged');
      expect(findings.reportOnly[0].minimalFix).toContain('(salvaged');
    });
  });

  it('moves every committed finding to reportOnly when the gate fails before push', () => {
    withTmpDir((workdir) => {
      seedFindings(workdir, [fixtureFix('A'), fixtureFix('B')]);
      const script = nodeBlock(step('Gate on agent outcome'), 'gate-failed');
      expect(script).toBeTruthy();
      expect(runNodeBlock(script, workdir).status).toBe(0);
      const findings = readFindings(workdir);
      expect(findings.fixes).toHaveLength(0);
      expect(findings.reportOnly.map((f) => f.id).sort()).toEqual(['A', 'B']);
      for (const entry of findings.reportOnly) {
        expect(entry.status).toBe('gate-failed');
        expect(entry.minimalFix).toContain('(gate failed before push)');
      }
    });
  });

  it('books gate-dropped commits to reportOnly without touching survivors', () => {
    withTmpDir((workdir) => {
      seedFindings(workdir, [fixtureFix('A'), fixtureFix('B')]);
      const script = nodeBlock(step('Gate on agent outcome'), 'dropped-gate');
      expect(script).toBeTruthy();
      const result = runNodeBlock(script, workdir, {
        DROPPED_MSGS: 'fix: too big [B]\n',
      });
      expect(result.status).toBe(0);
      const findings = readFindings(workdir);
      expect(findings.fixes.map((f) => f.id)).toEqual(['A']);
      expect(findings.reportOnly).toHaveLength(1);
      expect(findings.reportOnly[0].id).toBe('B');
      expect(findings.reportOnly[0].status).toBe('dropped-gate');
    });
  });

  it('labels the typecheck breaker reverted-verify and the rest reverted-collateral', () => {
    withTmpDir((workdir) => {
      seedFindings(workdir, [
        fixtureFix('A'),
        fixtureFix('B'),
        fixtureFix('C'),
      ]);
      const script = nodeBlock(
        step('Independent verification'),
        'reverted-verify',
      );
      expect(script).toBeTruthy();
      // C is the breaker (its removal made typecheck pass); A and B are
      // collateral discarded while isolating it.
      const result = runNodeBlock(script, workdir, {
        REVERTED_MSGS: 'fix: a [A]\nfix: b [B]\nfix: c [C]\n',
        BREAKER_MSG: 'fix: c [C]',
      });
      expect(result.status).toBe(0);
      const findings = readFindings(workdir);
      expect(findings.fixes).toHaveLength(0);
      const byId = Object.fromEntries(
        findings.reportOnly.map((f) => [f.id, f]),
      );
      expect(byId.C.status).toBe('reverted-verify');
      expect(byId.C.minimalFix).toContain('typecheck failed');
      expect(byId.A.status).toBe('reverted-collateral');
      expect(byId.B.status).toBe('reverted-collateral');
      expect(byId.A.minimalFix).toContain('collateral');
    });
  });

  it('moves surviving findings to reportOnly when post-typecheck verification fails', () => {
    withTmpDir((workdir) => {
      seedFindings(workdir, [fixtureFix('A'), fixtureFix('B')]);
      const script = nodeBlock(
        step('Independent verification'),
        'failed-verify',
      );
      expect(script).toBeTruthy();
      expect(runNodeBlock(script, workdir).status).toBe(0);
      const findings = readFindings(workdir);
      expect(findings.fixes).toHaveLength(0);
      expect(findings.reportOnly.map((f) => f.id).sort()).toEqual(['A', 'B']);
      for (const entry of findings.reportOnly) {
        expect(entry.status).toBe('failed-verify');
        expect(entry.minimalFix).toContain(
          '(CI verification failed after typecheck)',
        );
      }
    });
  });
});

describe('repo-hygiene runner', () => {
  it('limits the runner to the scan and fix phases', () => {
    const result = runRunner(['--mode', 'bogus', '--print-prompt']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--mode must be one of: scan, fix');
  });

  it('requires --branch for the fix phase', () => {
    withTmpDir((dir) => {
      const result = runRunner(['--mode', 'fix', '--workdir', dir]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--branch is required for fix');
    });
  });

  it('fails fast when a fix phase has no findings to read', () => {
    withTmpDir((dir) => {
      const stub = writeQwenStub(dir, ['process.exit(0);']);
      const result = runRunner([
        '--mode',
        'fix',
        '--branch',
        'hygiene/x',
        '--workdir',
        dir,
        '--qwen-bin',
        stub,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Missing input file(s)');
      expect(result.stderr).toContain('findings.json');
    });
  });

  it('builds scan and fix prompts from the staged skill and structured options', () => {
    withTmpDir((dir) => {
      const scan = runRunner([
        '--mode',
        'scan',
        '--workdir',
        dir,
        '--print-prompt',
      ]);
      expect(scan.status).toBe(0);
      expect(scan.stdout).toContain('Skill directory:');
      expect(scan.stdout).toContain('# Repo Hygiene');
      expect(scan.stdout).toContain('Invocation:');
      expect(scan.stdout).toContain(`Scan phase. --workdir ${dir}`);

      const fix = runRunner([
        '--mode',
        'fix',
        '--branch',
        'hygiene/x',
        '--workdir',
        dir,
        '--print-prompt',
      ]);
      expect(fix.status).toBe(0);
      expect(fix.stdout).toContain(
        `Fix phase. --workdir ${dir} --branch hygiene/x`,
      );
    });
  });

  it('resolves the staged SKILL end-to-end (stage↔resolve contract)', () => {
    const runner = readFileSync(runnerScriptPath, 'utf8');
    withTmpDir((dir) => {
      // Mirror the workflow's staging: hygiene-skill/{SKILL.md,scripts/run-agent.mjs}.
      mkdirSync(join(dir, 'hygiene-skill', 'scripts'), { recursive: true });
      writeFileSync(
        join(dir, 'hygiene-skill', 'SKILL.md'),
        '---\nname: repo-hygiene\n---\nSTAGED_SKILL_SENTINEL\n',
      );
      const stagedRunner = join(
        dir,
        'hygiene-skill',
        'scripts',
        'run-agent.mjs',
      );
      writeFileSync(stagedRunner, runner);
      const ok = spawnSync(
        process.execPath,
        [stagedRunner, '--mode', 'scan', '--workdir', dir, '--print-prompt'],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('STAGED_SKILL_SENTINEL');
      expect(ok.stdout).toMatch(/Skill directory: \S*[/\\]hygiene-skill\n/);
      // The frontmatter must be stripped from the inlined skill.
      expect(ok.stdout).not.toContain('name: repo-hygiene');

      // A flat layout (runner alone, no ../SKILL.md) must crash with ENOENT,
      // proving this test catches a staging regression.
      mkdirSync(join(dir, 'flat'), { recursive: true });
      const flatRunner = join(dir, 'flat', 'run-agent.mjs');
      writeFileSync(flatRunner, runner);
      const flat = spawnSync(
        process.execPath,
        [flatRunner, '--mode', 'scan', '--workdir', dir, '--print-prompt'],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(flat.status).not.toBe(0);
      expect(flat.stderr).toContain('ENOENT');
    });
  });

  it('marks tool-call loop guard failures for human review', () => {
    withTmpDir((dir) => {
      const stub = writeQwenStub(dir, [
        "process.stderr.write('turn_tool_call_cap: too many tool calls\\n');",
        'process.exit(1);',
      ]);
      const result = runScan(dir, stub);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'agent.log'), 'utf8')).toContain(
        'turn_tool_call_cap',
      );
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'Qwen hit the tool-call loop guard during scan',
      );
    });
  });

  it('detects loop guard output even after it falls out of the log tail', () => {
    withTmpDir((dir) => {
      const stub = writeQwenStub(dir, [
        "process.stderr.write('Loop detection halted the run\\n');",
        "process.stdout.write('x'.repeat(21_000));",
        'process.exit(1);',
      ]);
      const result = runScan(dir, stub);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'Qwen hit the tool-call loop guard during scan',
      );
    });
  });

  it('does not mark generic subprocess failures as loop guard', () => {
    withTmpDir((dir) => {
      const stub = writeQwenStub(dir, [
        "process.stderr.write('temporary upstream error\\n');",
        'process.exit(1);',
      ]);
      const result = runScan(dir, stub);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'agent.log'), 'utf8')).toContain(
        'temporary upstream error',
      );
      const failure = readFileSync(join(dir, 'failure.md'), 'utf8');
      expect(failure).toContain('Qwen failed during scan');
      expect(failure).not.toContain('loop guard');
    });
  });

  it('preserves an agent-written failure.md when the subprocess fails', () => {
    withTmpDir((dir) => {
      const stub = writeWorkdirStub(dir, [
        "writeFileSync(`${workdir}/failure.md`, 'agent detail\\n');",
        'process.exit(1);',
      ]);
      const result = runScan(dir, stub);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('preserving agent-written failure.md');
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'agent detail',
      );
    });
  });

  it('treats an agent-written failure.md on a clean exit as a reportable outcome', () => {
    withTmpDir((dir) => {
      const stub = writeWorkdirStub(dir, [
        "writeFileSync(`${workdir}/failure.md`, 'blocked by X\\n');",
        'process.exit(0);',
      ]);
      const result = runScan(dir, stub);
      // Blocked is a reportable outcome, not an infra error: exit 0 so the
      // workflow's validate step (not a crash) decides what to do.
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Repo-hygiene agent wrote failure.md');
    });
  });

  it('fails when the agent exits cleanly without the required output', () => {
    withTmpDir((dir) => {
      const stub = writeQwenStub(dir, ['process.exit(0);']);
      const result = runScan(dir, stub);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'without required output file(s): findings.json',
      );
    });
  });

  it('completes when the agent produces its output', () => {
    withTmpDir((dir) => {
      const stub = writeWorkdirStub(dir, [
        'writeFileSync(`${workdir}/findings.json`, \'{"fixes":[],"reportOnly":[]}\\n\');',
        'process.exit(0);',
      ]);
      const result = runScan(dir, stub);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('completed scan successfully');
    });
  });

  it('kills a hung agent at the timeout and reports it', () => {
    withTmpDir((dir) => {
      const stub = writeQwenStub(dir, [
        'setTimeout(() => process.exit(0), 5000);',
      ]);
      const result = runRunner(
        ['--mode', 'scan', '--workdir', dir, '--qwen-bin', stub],
        { QWEN_TIMEOUT_MS: '100' },
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(dir, 'failure.md'), 'utf8')).toContain(
        'timeout (100ms)',
      );
    });
  }, 15_000);

  it('settles the log stream without hanging on a stream error', () => {
    const runner = readFileSync(runnerScriptPath, 'utf8');
    expect(runner).toContain("log.on('error', () => {});");
    expect(runner).toContain('if (log.destroyed)');
  });
});

describe('repo-hygiene PR label step', () => {
  // The label block sits inside the much larger 'Push and open PR' step;
  // extract just it and replay it under `bash -e` against a recording gh
  // stub, like the pr-self-report-label suite does.
  const labelBlock = stepBody('Push and open PR').match(
    /# Label requested by issue #7383[\s\S]*?\nfi\n/,
  )?.[0];

  const runLabelBlock = ({ probeOk = true, postOk = true } = {}) =>
    withTmpDir((dir) => {
      const callsLog = join(dir, 'calls.log');
      writeFileSync(
        join(dir, 'gh'),
        [
          '#!/bin/bash',
          `echo "gh $*" >> '${callsLog}'`,
          'case "$*" in',
          `  *labels/autofix%2Frepo-hygiene*) [ '${probeOk}' = true ] || exit 1 ;;`,
          `  *'-X POST'*) [ '${postOk}' = true ] || exit 1 ;;`,
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(join(dir, 'gh'), 0o755);
      const script = join(dir, 'label.sh');
      writeFileSync(script, labelBlock);
      const result = spawnSync('bash', ['-e', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'o/r',
          PR_URL: 'https://github.com/o/r/pull/77',
        },
      });
      return {
        status: result.status,
        out: result.stdout,
        calls: existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : '',
      };
    });

  it('extracts the label block verbatim from the publish step', () => {
    expect(labelBlock).toBeTruthy();
    // The probe encodes the slashed label name in the PATH SEGMENT.
    expect(labelBlock).toContain('labels/autofix%2Frepo-hygiene');
  });

  it('adds the label through REST when the probe finds it', () => {
    const added = runLabelBlock();
    expect(added.status).toBe(0);
    expect(added.calls).toContain(
      'gh api repos/o/r/labels/autofix%2Frepo-hygiene',
    );
    // The PR number comes from the ${PR_URL##*/} extraction.
    expect(added.calls).toContain(
      'gh api -X POST repos/o/r/issues/77/labels -f labels[]=autofix/repo-hygiene',
    );
  });

  it('skips without creating when the probe cannot confirm the label', () => {
    const skipped = runLabelBlock({ probeOk: false });
    expect(skipped.status).toBe(0);
    expect(skipped.calls).not.toContain('-X POST');
    expect(skipped.out).toContain(
      'Could not verify label autofix/repo-hygiene; skipping',
    );
  });

  it('warns but does not fail the step when the POST fails', () => {
    const failed = runLabelBlock({ postOk: false });
    expect(failed.status).toBe(0);
    expect(failed.out).toContain('Could not add label autofix/repo-hygiene');
  });
});
