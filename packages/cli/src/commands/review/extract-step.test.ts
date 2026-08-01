/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The risk is silent wrongness, not crashes: extracting the same-named step
// from the wrong job, dropping the env that changes the script's behaviour —
// including the two levels, job and workflow, that the step's own text does not
// show — inventing values for `${{ }}` sites, or emitting a header whose own
// lines end up in command position. Each test pins one of those against a
// realistic workflow shape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExtractStep,
  expressionsOf,
  invokedCommandsOf,
} from './extract-step.js';

/**
 * The lines the shell would actually EXECUTE. The guarantee the header owes is
 * not "the env appears somewhere" but "nothing except the `run:` body ever
 * reaches command position" — assert the effect, not the `#` that implements it.
 */
const executableLines = (script: string): string[] =>
  script
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .filter((l) => l !== 'set -e');

const hasBash = ((): boolean => {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const WF = `
name: triage
on: [workflow_dispatch]
jobs:
  precheck:
    runs-on: ubuntu-latest
    steps:
      - name: Post comment
        run: echo precheck-arm
  publish-verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Post comment
        working-directory: scripts
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPORT: report.md
        run: |
          body="$(sanitize < "$REPORT")"
          gh api "repos/\${{ github.repository }}/issues/comments" -f body="$body" | jq .id
`;

// `env:`, `shell:` and `working-directory:` are three-level settings. Not a
// contrived shape: this repo carries workflow-level `env:` in 7 workflows,
// job-level `env:` in 10, and job-level `defaults.run` in qwen-triage.yml.
const WF_LEVELS = `
name: levels
on: [push]
env:
  GLOBAL_FLAG: workflow-level
  NODE_ENV: development
defaults:
  run:
    working-directory: repo-root
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      NODE_ENV: production
    defaults:
      run:
        shell: sh
        working-directory: packages/cli
    steps:
      - name: Run
        env:
          LOCAL: 1
        run: echo "$NODE_ENV $GLOBAL_FLAG $LOCAL"
  inherit-only:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: echo "$GLOBAL_FLAG"
`;

// A step-level env whose value is a YAML block scalar — the shape
// .github/workflows/qwen-autofix.yml uses for SETTINGS_JSON.
const WF_BLOCK_ENV = `
name: autofix
on: [push]
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        env:
          SETTINGS_JSON: |-
            {
              "maxSessionTurns": 60
            }
        run: echo hi
`;

describe('runExtractStep', () => {
  let dir: string;
  const write = (content: string): string => {
    const p = join(dir, 'wf.yml');
    writeFileSync(p, content);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-extract-step-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts the named step from the NAMED job, not a same-named sibling', () => {
    const meta = runExtractStep({
      workflow: write(WF),
      job: 'publish-verify',
      step: 'Post comment',
      out: join(dir, 'step.sh'),
    });
    const script = readFileSync(meta.scriptPath, 'utf8');
    expect(script).toContain('sanitize < "$REPORT"');
    expect(script).not.toContain('precheck-arm');
    expect(meta.index).toBe(1);
    expect(meta.workingDirectory).toBe('scripts');
    // Executable, with the runner's default shell recorded.
    expect(statSync(meta.scriptPath).mode & 0o111).not.toBe(0);
    expect(meta.shell).toBe('bash');
  });

  it('carries the env VERBATIM as comments — never half-substituted exports', () => {
    const meta = runExtractStep({
      workflow: write(WF),
      job: 'publish-verify',
      step: 'Post comment',
      out: join(dir, 'step.sh'),
    });
    expect(meta.env).toEqual({
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      REPORT: 'report.md',
    });
    expect(meta.envSources).toEqual({ GH_TOKEN: 'step', REPORT: 'step' });
    const script = readFileSync(meta.scriptPath, 'utf8');
    expect(script).toContain(
      '# env [step] GH_TOKEN=${{ secrets.GITHUB_TOKEN }}',
    );
    expect(script).not.toContain('export GH_TOKEN');
  });

  it('lists every ${{ }} site as the stub list, evaluating none', () => {
    const meta = runExtractStep({
      workflow: write(WF),
      job: 'publish-verify',
      step: 'Post comment',
      out: join(dir, 'step.sh'),
    });
    expect(meta.expressions).toEqual([
      '${{ github.repository }}',
      '${{ secrets.GITHUB_TOKEN }}',
    ]);
    // The expression survives verbatim in the emitted script.
    expect(readFileSync(meta.scriptPath, 'utf8')).toContain(
      'repos/${{ github.repository }}/issues',
    );
  });

  it('names the commands the script invokes, as a stubbing starting point', () => {
    const meta = runExtractStep({
      workflow: write(WF),
      job: 'publish-verify',
      step: '1',
      out: join(dir, 'step.sh'),
    });
    expect(meta.invokes).toContain('gh');
    expect(meta.invokes).toContain('jq');
    expect(meta.invokes).toContain('sanitize');
  });

  it('refuses a uses: step, an unknown job, and an unknown step — each naming the candidates', () => {
    const wf = write(WF);
    expect(() =>
      runExtractStep({
        workflow: wf,
        job: 'publish-verify',
        step: '0',
        out: join(dir, 's'),
      }),
    ).toThrow(/no `run:` script/);
    expect(() =>
      runExtractStep({
        workflow: wf,
        job: 'nope',
        step: 'x',
        out: join(dir, 's'),
      }),
    ).toThrow(/jobs: precheck, publish-verify/);
    expect(() =>
      runExtractStep({
        workflow: wf,
        job: 'precheck',
        step: 'Postt',
        out: join(dir, 's'),
      }),
    ).toThrow(/0: Post comment/);
  });

  it('resolves env and defaults across ALL THREE levels, nearest wins', () => {
    const meta = runExtractStep({
      workflow: write(WF_LEVELS),
      job: 'build',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    // The effective environment the runner would hand the step — not the
    // step-level slice, which would leave `$NODE_ENV` and `$GLOBAL_FLAG` unset
    // and the extraction quietly measuring a different script.
    expect(meta.env).toEqual({
      GLOBAL_FLAG: 'workflow-level',
      NODE_ENV: 'production', // job overrides the workflow-level `development`
      LOCAL: '1',
    });
    expect(meta.envSources).toEqual({
      GLOBAL_FLAG: 'workflow',
      NODE_ENV: 'job',
      LOCAL: 'step',
    });
    // `defaults.run` is a level too: the job's beats the workflow's.
    expect(meta.shell).toBe('sh');
    expect(meta.workingDirectory).toBe('packages/cli');
    const script = readFileSync(meta.scriptPath, 'utf8');
    expect(script).toContain('#!/usr/bin/env sh');
    expect(script).toContain('# env [job] NODE_ENV=production');
    expect(script).not.toContain('NODE_ENV=development');
  });

  it('falls back to workflow-level defaults when the job sets none', () => {
    const meta = runExtractStep({
      workflow: write(WF_LEVELS),
      job: 'inherit-only',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    expect(meta.workingDirectory).toBe('repo-root');
    expect(meta.shell).toBe('bash');
    expect(meta.env).toEqual({
      GLOBAL_FLAG: 'workflow-level',
      NODE_ENV: 'development',
    });
  });

  it('leaves nothing but the run: body in command position, for a MULTI-LINE env value', () => {
    const meta = runExtractStep({
      workflow: write(WF_BLOCK_ENV),
      job: 'fix',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    const script = readFileSync(meta.scriptPath, 'utf8');
    // A block scalar's continuation lines are the failure: commented only on
    // the first line, `  "maxSessionTurns": 60` and `}` run as commands, and
    // the header's own `set -e` kills the step before its body.
    expect(executableLines(script)).toEqual(['echo hi']);
    expect(script).toContain('# env [step] SETTINGS_JSON={');
    // Continuation lines keep the block scalar's own indentation after the `#`.
    expect(script).toContain('#     "maxSessionTurns": 60');
    expect(script).toContain('#   }');
  });

  it.skipIf(!hasBash)(
    'emits a script bash will parse, even with a multi-line env value',
    () => {
      const meta = runExtractStep({
        workflow: write(WF_BLOCK_ENV),
        job: 'fix',
        step: 'Run',
        out: join(dir, 'step.sh'),
      });
      expect(() =>
        execFileSync('bash', ['-n', meta.scriptPath], { stdio: 'pipe' }),
      ).not.toThrow();
    },
  );
});

describe('expressionsOf / invokedCommandsOf', () => {
  it('dedupes expression sites across script and env', () => {
    expect(expressionsOf('a ${{ x }} b ${{ x }}', '${{ y }}')).toEqual([
      '${{ x }}',
      '${{ y }}',
    ]);
  });

  it('reads pipeline segments and skips keywords, builtins, and VAR= prefixes', () => {
    expect(
      invokedCommandsOf(
        'if true; then\n  FOO=1 gh api x | jq .id && curl -s y\nfi\necho done',
      ),
    ).toEqual(['curl', 'gh', 'jq']);
  });
});
