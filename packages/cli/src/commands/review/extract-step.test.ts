/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The risk is silent wrongness, not crashes: extracting the same-named step
// from the wrong job, dropping the env that changes the script's behaviour, or
// inventing values for `${{ }}` sites. Each test pins one of those against a
// realistic workflow shape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExtractStep,
  expressionsOf,
  invokedCommandsOf,
} from './extract-step.js';

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
    const script = readFileSync(meta.scriptPath, 'utf8');
    expect(script).toContain('# env GH_TOKEN=${{ secrets.GITHUB_TOKEN }}');
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
