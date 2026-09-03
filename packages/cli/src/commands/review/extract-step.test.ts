/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

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
 * The guarantee stated exactly: the emitted file is HEADER + the body
 * VERBATIM, and every header line is inert — a comment, or one of the shell
 * directives the caller names here.
 *
 * Deliberately not "filter the script for lines that look executable": such a
 * filter has to drop `set -e` to work, which makes it blind to a header that
 * leaked exactly that line, and it cannot tell the header's directive from one
 * the `run:` body legitimately contains. Splitting the file at the body's own
 * length needs to know nothing about what the header emits.
 */
const expectVerbatimBody = (
  scriptPath: string,
  body: string,
  allowedDirectives: string[],
): void => {
  const emitted = readFileSync(scriptPath, 'utf8');
  const withNewline = body.endsWith('\n') ? body : `${body}\n`;
  expect(emitted.endsWith(withNewline)).toBe(true);
  const header = emitted.slice(0, emitted.length - withNewline.length);
  const live = header
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));
  expect(live).toEqual(allowedDirectives);
};

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
    // Executable, with the runner's default shell recorded. Windows has no
    // POSIX mode bits; stat reports 0o666.
    if (process.platform !== 'win32') {
      expect(statSync(meta.scriptPath).mode & 0o111).not.toBe(0);
    }
    expect(meta.shell).toBe('bash');
  });

  it('says in the SCRIPT where it must run, labelled with the level', () => {
    // The env block is commented into the header so a reader of the script
    // alone can see it. The working directory changes what the script does
    // just as much, and this file's own argument for reading all three levels
    // is that a step run "in the wrong directory, and nothing says so" is the
    // transcription error the command exists to remove.
    const meta = runExtractStep({
      workflow: write(WF_LEVELS),
      job: 'inherit-only',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    const script = readFileSync(meta.scriptPath, 'utf8');
    expect(script).toContain(
      '# working-directory [workflow] (run FROM here): repo-root',
    );
    // A comment, not a `cd` — the value may hold `${{ }}`, and this command
    // substitutes nothing.
    expect(script).not.toMatch(/^cd /m);
  });

  it('lists a ${{ }} hiding in working-directory or shell, not just the script', () => {
    // The stub list is read as complete: "these are all the values to supply".
    // A working-directory of `${{ github.workspace }}/x` left off it is a
    // caller told there is nothing to stub, who then runs in a literal
    // `${{ … }}` directory.
    const wf = `
name: t
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: \${{ github.workspace }}/packages/cli
    steps:
      - name: Run
        run: npm run build
`;
    const meta = runExtractStep({
      workflow: write(wf),
      job: 'j',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    expect(meta.expressions).toEqual(['${{ github.workspace }}']);
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

  it('refuses an AMBIGUOUS step name instead of silently taking the first', () => {
    // A job may legally hold two steps with the same name. Taking the first is
    // the failure this command's own header names — "picks the same-named step
    // from the wrong job" — and it is worst in the use this command exists
    // for: A/B extraction runs it once per tree, so a PR that adds or reorders
    // a duplicate leaves the two sides comparing different steps and reporting
    // on one.
    const dup = `
name: t
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Post comment
        run: echo one
      - name: Post comment
        run: echo two
`;
    const wf = write(dup);
    expect(() =>
      runExtractStep({
        workflow: wf,
        job: 'j',
        step: 'Post comment',
        out: join(dir, 's'),
      }),
    ).toThrow(/ambiguous.*indices 0, 1.*pass the index/s);
    // The index is never ambiguous, and still selects.
    expect(
      runExtractStep({ workflow: wf, job: 'j', step: '1', out: join(dir, 's') })
        .index,
    ).toBe(1);
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
    // GitHub runs a `shell: sh` step as `sh -e {0}` — `-e`, and only `-e`.
    // Both halves are load-bearing: dropping the line makes an extracted `sh`
    // step run past a failure the runner would have stopped on, and adding
    // pipefail claims a bash feature `sh` does not have.
    expect(script).toContain('\nset -e\n');
    expect(script).not.toContain('pipefail');
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
    // A block scalar's continuation lines are the failure: commented only on
    // the first line, `  "maxSessionTurns": 60` and `}` run as commands, and
    // the header's own `set -e` kills the step before its body.
    expectVerbatimBody(meta.scriptPath, 'echo hi', ['set -e']);
    const script = readFileSync(meta.scriptPath, 'utf8');
    expect(script).toContain('# env [step] SETTINGS_JSON={');
    // Continuation lines keep the block scalar's own indentation after the `#`.
    expect(script).toContain('#     "maxSessionTurns": 60');
    expect(script).toContain('#   }');
  });

  it('keeps a body that itself contains `set -e` — the header is split off by length, not by filtering', () => {
    const wf = `
name: t
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: |-
          set -e
          echo hi
`;
    const meta = runExtractStep({
      workflow: write(wf),
      job: 'j',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    // The body's own `set -e` is body, not header: 434 real steps in this
    // repo's workflows include such a line, and an oracle that filtered it out
    // would be blind to a header that leaked exactly that.
    expectVerbatimBody(meta.scriptPath, 'set -e\necho hi', ['set -e']);
  });

  it('carries pipefail when the shell is DECLARED bash, and not when it is defaulted', () => {
    const declared = `
name: t
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - name: Run
        run: a | b
`;
    // \`shell: bash\` makes the runner use \`bash --noprofile --norc -eo pipefail\`;
    // the default is a bare \`bash -e\`. A pipeline whose middle stage fails
    // aborts under the first and not the second.
    expectVerbatimBody(
      runExtractStep({
        workflow: write(declared),
        job: 'j',
        step: 'Run',
        out: join(dir, 'a.sh'),
      }).scriptPath,
      'a | b',
      ['set -eo pipefail'],
    );
    const defaulted = `
name: t
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: a | b
`;
    expectVerbatimBody(
      runExtractStep({
        workflow: write(defaulted),
        job: 'j',
        step: 'Run',
        out: join(dir, 'b.sh'),
      }).scriptPath,
      'a | b',
      ['set -e'],
    );
  });

  it('shebangs only the command word of a shell TEMPLATE, and records the whole of it', () => {
    const wf = `
name: t
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        shell: perl {0}
        run: print 1;
`;
    const meta = runExtractStep({
      workflow: write(wf),
      job: 'j',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    expect(meta.shell).toBe('perl {0}');
    const script = readFileSync(meta.scriptPath, 'utf8');
    expect(script).toContain('#!/usr/bin/env perl\n');
    expect(script).toContain('# shell (runner invokes it this way): perl {0}');
    // Not bash, so no `set -e` is invented for it.
    expectVerbatimBody(meta.scriptPath, 'print 1;', []);
  });

  it('orders the env NEAREST FIRST — the step own vars are not buried', () => {
    const meta = runExtractStep({
      workflow: write(WF_LEVELS),
      job: 'build',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    // Measured on qwen-autofix.yml:route:0, merge order put 20 inherited
    // entries ahead of the step's own 26 in a 49-line header.
    expect(Object.keys(meta.env)).toEqual([
      'LOCAL', // step
      'NODE_ENV', // job
      'GLOBAL_FLAG', // workflow
    ]);
  });

  it('renders a valueless env key as the empty string, not "null"', () => {
    const wf = `
name: t
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        env:
          EMPTY:
          NUM: 7
        run: echo hi
`;
    const meta = runExtractStep({
      workflow: write(wf),
      job: 'j',
      step: 'Run',
      out: join(dir, 'step.sh'),
    });
    expect(meta.env).toEqual({ EMPTY: '', NUM: '7' });
  });

  it('separates a missing file from a malformed one', () => {
    expect(() =>
      runExtractStep({
        workflow: join(dir, 'nope.yml'),
        job: 'j',
        step: '0',
        out: join(dir, 's'),
      }),
    ).toThrow(/cannot read .*ENOENT/);
    expect(() =>
      runExtractStep({
        workflow: write('jobs: [\n'),
        job: 'j',
        step: '0',
        out: join(dir, 's'),
      }),
    ).toThrow(/cannot parse/);
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

describe('multi-line env values stay comments', () => {
  it('prefixes EVERY line of a block-scalar env value', () => {
    // An unprefixed second line would sit in the script as an executable line.
    const wf = [
      'jobs:',
      '  j:',
      '    steps:',
      '      - name: s',
      '        env:',
      '          SCRIPT: |',
      '            first',
      '            rm -rf /tmp/x',
      '        run: echo ok',
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'qwen-es-env-'));
    const p = join(dir, 'wf.yml');
    writeFileSync(p, wf);
    const meta = runExtractStep({
      workflow: p,
      job: 'j',
      step: 's',
      out: join(dir, 'o.sh'),
    });
    const script = readFileSync(meta.scriptPath, 'utf8');
    for (const line of script.split('\n')) {
      if (line.includes('rm -rf')) expect(line.startsWith('#')).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('expressionsOf / invokedCommandsOf', () => {
  it('captures an expression containing its own closing brace', () => {
    expect(expressionsOf("a ${{ format('{0}', x) }} b")).toEqual([
      "${{ format('{0}', x) }}",
    ]);
  });

  it('still enumerates a real site below a MALFORMED one', () => {
    // A non-greedy scan with no opener guard runs from the broken `${{` all
    // the way to the next site's `}}` and swallows it — the injection site
    // below silently stops being reported, which is the one direction this
    // helper must not fail in.
    expect(
      expressionsOf(
        'echo ${{ github.event.issue.title }\nrun: echo ${{ github.event.comment.body }}',
      ),
    ).toEqual(['${{ github.event.comment.body }}']);
  });

  it('ends a plain <<WORD heredoc only at column 0, as bash does', () => {
    // An indented `EOF` inside a plain heredoc is still BODY. Ending there
    // leaked the rest of the body into the command list, and the entry it
    // produced was `rm` — a frightening thing to hand a reviewer with nothing
    // behind it.
    expect(invokedCommandsOf('cat <<EOF\n  EOF\n  rm -rf /\nEOF\nls')).toEqual([
      'cat',
      'ls',
    ]);
  });

  it('ends a <<-WORD heredoc on an indented terminator', () => {
    // Looser than bash (which strips tabs, not spaces) on purpose: looser can
    // only end a body EARLY, which over-reports, and an under-report is the
    // worse direction here.
    expect(invokedCommandsOf('cat <<-EOF\n  body\n  EOF\nls')).toEqual([
      'cat',
      'ls',
    ]);
  });

  it('does not read $(( )) arithmetic as a command substitution', () => {
    // Measured across this repo's 434 run: steps — the single largest source
    // of junk in the list. Nothing inside `$(( ))` runs, so an operand named
    // like a variable is not a command anyone can stub.
    expect(invokedCommandsOf('N=$((N + 1))')).toEqual([]);
    expect(invokedCommandsOf('echo $((COUNT * 2))')).toEqual([]);
    // ...and a real substitution on the same line is still found.
    expect(invokedCommandsOf('N=$((N + 1)); gh api x')).toEqual(['gh']);
  });

  it('finds the OUTER command of a nested $( )', () => {
    // `[^()]*` only ever matched the innermost pair, so this reported
    // `build_url` and lost `gh` — a missed stub, and the extraction reaches
    // the network.
    expect(invokedCommandsOf('X=$(gh api $(build_url $(region)))')).toEqual([
      'build_url',
      'gh',
      'region',
    ]);
  });

  it('does not read a subcommand as a command when an assignment spans words', () => {
    // The assignment-prefix skip stepped over `X=$(gh` and put `api` in
    // command position. A closed assignment still steps over correctly.
    expect(invokedCommandsOf('X=$(date) aws s3 cp a b')).toEqual([
      'aws',
      'date',
    ]);
    expect(invokedCommandsOf('FOO=1 BAR=2 aws s3 cp a b')).toEqual(['aws']);
  });

  it('dedupes expression sites across script and env', () => {
    expect(expressionsOf('a ${{ x }} b ${{ x }}', '${{ y }}')).toEqual([
      '${{ x }}',
      '${{ y }}',
    ]);
  });

  it('captures an expression that CONTAINS a brace, and the site after it', () => {
    // The live shape: `format('refs/pull/{0}/head', …)` appears in this repo's
    // workflows. Stopping at the first `}` does not mis-list such a site, it
    // drops it — and a stub list that silently omits an entry reads as
    // "nothing more to supply".
    expect(
      expressionsOf(
        "ref: ${{ github.ref || format('refs/pull/{0}/head', github.event.number) }} then ${{ github.repository }}",
      ),
    ).toEqual([
      "${{ github.ref || format('refs/pull/{0}/head', github.event.number) }}",
      '${{ github.repository }}',
    ]);
  });

  it('reports nothing for an unterminated site rather than swallowing the rest', () => {
    expect(expressionsOf('${{ github.ref')).toEqual([]);
    expect(expressionsOf('${{ a }} ${{ unterminated')).toEqual(['${{ a }}']);
  });

  it.each([
    [
      'adjacent sites with nothing between them',
      '${{ a }}${{ b }}',
      ['${{ a }}', '${{ b }}'],
    ],
    [
      'a JSON literal inside the expression',
      '${{ fromJSON(\'{"k":1}\').k }}',
      ['${{ fromJSON(\'{"k":1}\').k }}'],
    ],
    ['an empty expression', '${{}}', ['${{}}']],
    ['a repeated site, deduped', 'x ${{ a }} y ${{ a }}', ['${{ a }}']],
  ])('handles %s', (_name, input, expected) => {
    expect(expressionsOf(input as string)).toEqual(expected);
  });

  it('reads pipeline segments and skips keywords, builtins, and VAR= prefixes', () => {
    expect(
      invokedCommandsOf(
        'if true; then\n  FOO=1 gh api x | jq .id && curl -s y\nfi\necho done',
      ),
    ).toEqual(['curl', 'gh', 'jq']);
  });

  // Each of these was measured as a junk source on this repo's 434 real steps:
  // together they accounted for the worst case's 63 "commands", of which the
  // overwhelming majority were prose. A stub list is a starting point only if
  // its entries are plausibly commands.
  it('does not split a ${{ }} expression on its own `||`', () => {
    // `${{ a || b }}` is not a pipeline, and neither operand is a command.
    expect(invokedCommandsOf('X="${{ matrix.foo || matrix.arch }}"')).toEqual(
      [],
    );
    expect(invokedCommandsOf('${{ steps.x.outputs.cmd }} --flag')).toEqual([]);
  });

  it('treats a heredoc body as data, not as a list of commands', () => {
    expect(
      invokedCommandsOf('cat <<EOF > f\nCI Evidence PR and agent\nEOF\njq .'),
    ).toEqual(['cat', 'jq']);
    // A quoted terminator behaves the same.
    expect(invokedCommandsOf("cat <<'EOF'\ncurl evil\nEOF")).toEqual(['cat']);
  });

  it('does not mistake a QUOTED `<<EOF` for a heredoc opener', () => {
    // The failure this guards is not a missing entry but a missing REST: a
    // false opener waits for a terminator that never comes, so every later
    // line is skipped and the list comes back empty and plausible.
    expect(
      invokedCommandsOf('echo "write <<EOF for a heredoc"\ncurl x\njq .'),
    ).toEqual(['curl', 'jq']);
  });

  // Adversarial shapes, each with the answer bash would give. The two that
  // matter most are UNDER-reports: a command missing from the list is a stub
  // the verifier never writes, so the extraction reaches the real network.
  it.each([
    ['nested $( ) inside quotes', 'x="$(a)" && b', ['a', 'b']],
    [
      'case labels, whose command follows on the same line',
      'case "$v" in\n  blocked) gh x ;;\n  ok) jq . ;;\nesac',
      ['gh', 'jq'],
    ],
    ['subshell', '( cd /tmp && tar cf x ) | gzip', ['gzip', 'tar']],
    [
      'function definition and its call',
      'foo() {\n  curl x\n}\nfoo',
      ['curl', 'foo'],
    ],
    [
      'a second heredoc on the same line',
      'cat <<A <<B\nx\nA\ny\nB\njq .',
      ['cat', 'jq'],
    ],
    [
      'an indented heredoc terminator',
      "cat <<-'EOF'\n\tcurl evil\n\tEOF\njq .",
      ['cat', 'jq'],
    ],
    ['an expression in command position', '${{ steps.a.outputs.cmd }} arg', []],
    ['an expression beside a real pipe', 'x="${{ a || b }}" | jq .', ['jq']],
    ['a backtick substitution', 'x=`date`\ncurl y', ['curl']],
    ['a bare redirect', '> f\ncurl x', ['curl']],
  ])('reads %s', (_name, script, expected) => {
    expect(invokedCommandsOf(script as string)).toEqual(expected);
  });

  it('reads a backslash-continued command as ONE command', () => {
    // Scanning the continuation as its own line puts the next ARGUMENT in
    // command position — measured on this repo as `libx11-dev` reported as a
    // command from an `apt-get install -y \` continuation.
    expect(
      invokedCommandsOf(
        'apt-get install -y \\\n  libx11-dev \\\n  libxext-dev',
      ),
    ).toEqual(['apt-get']);
    // The continued line still contributes its own pipeline segments.
    expect(invokedCommandsOf('gh api x \\\n  --paginate | jq .')).toEqual([
      'gh',
      'jq',
    ]);
  });

  it('does not read the inside of a quoted assignment as the command', () => {
    // Measured shape from qwen-triage.yml: the `name=` prefix is stepped over
    // and the next WORD taken as the command — but that word is inside the
    // value, not after it.
    expect(
      invokedCommandsOf("EVIDENCE_SECTION=$'### Evidence images\\n'"),
    ).toEqual([]);
    // A command substitution inside the value is still a real invocation.
    expect(invokedCommandsOf('body="$(sanitize < "$REPORT")"')).toEqual([
      'sanitize',
    ]);
  });

  it('carries an unterminated quote across lines, and ends it at a trailing comment', () => {
    // A multi-line string's continuation lines are data.
    expect(
      invokedCommandsOf('msg="line one\ncurl evil\nline three"\njq .'),
    ).toEqual(['jq']);
    // ...but an apostrophe in a trailing comment must not open one.
    expect(
      invokedCommandsOf("gh api x # don't treat this as a quote\njq ."),
    ).toEqual(['gh', 'jq']);
  });
});
