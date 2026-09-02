/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync('.github/workflows/pr-self-report-label.yml', 'utf8'),
);
const runBlock = workflow.jobs.label.steps[0].run;

// The step decides label state from two inputs: the logins that opened the PR's
// closed issues (gh api graphql) and whether the label is already present (gh pr
// view). Stub both and record which mutation, if any, it makes. The
// GH_DELETE_FAILS / GH_POST_FAILS knobs make the matching REST call exit 1
// with the knob value on stderr (shaped like a real gh HTTP error), so BOTH
// failure policies the workflow introduces are pinned — DELETE tolerance and
// POST loudness — instead of the catch-all silently exiting 0.
const GH_STUB = [
  '#!/usr/bin/env bash',
  'echo "gh $*" >> "${CALLS_LOG}"',
  'case "$*" in',
  "  *'api graphql'*) [ \"${GH_API_FAILS:-false}\" = true ] && exit 1; printf '%s\\n' ${GH_ISSUE_AUTHORS:-} ;;",
  "  *'pr view'*labels*) { [ \"${GH_HAS_LABEL:-false}\" = true ] && printf 'true' || printf 'false'; } ;;",
  '  *\'api -X DELETE\'*) [ -z "${GH_DELETE_FAILS:-}" ] || { printf \'%s\' "${GH_DELETE_FAILS}" >&2; exit 1; } ;;',
  '  *\'api -X POST\'*) [ -z "${GH_POST_FAILS:-}" ] || { printf \'%s\' "${GH_POST_FAILS}" >&2; exit 1; } ;;',
  '  *) : ;;',
  'esac',
  'exit 0',
].join('\n');

// The replayed DELETE URI-encodes the slashed label with a REAL jq — stub it
// on PATH like gh so the suite never depends on the host having jq (a fresh
// macOS has none, and the %2F assertion would fail opaquely). Supports only
// the one form the workflow executes — and ENFORCES it, program included:
// jq -rn --arg NAME VALUE '$NAME|@uri'. Any other program exits 1, so a
// mutation of the workflow's filter (e.g. dropping `|@uri`) fails the suite
// instead of riding the stub's unconditional percent-encoding.
const JQ_STUB = [
  '#!/usr/bin/env bash',
  // The FULL argv is enforced, not just the program: `-rn` is what makes jq
  // ignore the empty stdin of a run step (with `-r` alone it evaluates zero
  // inputs and prints nothing), and the binding NAME must be `l` or real jq
  // exits 3 on `$l is not defined`. Either mutation expands the command
  // substitution to an empty string, the DELETE hits …/labels/ with no name
  // segment, and the 404 race-tolerance swallows it — silent green.
  '[[ $# -eq 5 && "$1" == "-rn" && "$2" == "--arg" && "$3" == "l" && "$5" == \'$l|@uri\' ]] || exit 1',
  'value="$4"',
  'out=""',
  'for ((i = 0; i < ${#value}; i++)); do',
  '  c="${value:i:1}"',
  '  if [[ "$c" =~ [A-Za-z0-9._~-] ]]; then out+="$c"; else printf -v hex \'%02X\' "\'$c"; out+="%$hex"; fi',
  'done',
  'printf \'%s\' "$out"',
].join('\n');

describe('pr-self-report-label', () => {
  const run = ({
    prAuthor = 'alice',
    issueAuthors = '',
    hasLabel = false,
    apiFails = false,
    deleteFails = '',
    postFails = '',
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'lbl-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const callsLog = join(dir, 'calls.log');
    writeFileSync(join(bin, 'gh'), GH_STUB);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(bin, 'jq'), JQ_STUB);
    chmodSync(join(bin, 'jq'), 0o755);
    const out = execFileSync('bash', ['-c', runBlock], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CALLS_LOG: callsLog,
        REPO: 'o/r',
        PR: '1',
        PR_AUTHOR: prAuthor,
        LABEL: 'review/self-reported',
        GH_ISSUE_AUTHORS: issueAuthors,
        GH_HAS_LABEL: String(hasLabel),
        GH_API_FAILS: String(apiFails),
        GH_DELETE_FAILS: deleteFails,
        GH_POST_FAILS: postFails,
      },
      encoding: 'utf8',
    });
    const calls = existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : '';
    rmSync(dir, { recursive: true, force: true });
    return {
      // Label mutations are REST — `gh pr edit`'s GraphQL lookup requests
      // repository.pullRequest.projectCards, which GitHub rejects on the gh
      // builds that still send it (this job's runner image does), so it
      // exits 1 before mutating (43 straight CI failures of the add/remove
      // arms, 2026-08-04..08). The full method + path is asserted,
      // including the %2F: the label is a PATH SEGMENT in the DELETE and
      // contains a slash, so an unencoded call 404s.
      added:
        /api -X POST repos\/o\/r\/issues\/1\/labels -f labels\[\]=review\/self-reported/.test(
          calls,
        ),
      removed:
        /api -X DELETE repos\/o\/r\/issues\/1\/labels\/review%2Fself-reported/.test(
          calls,
        ),
      labelCreated: /label create/.test(calls),
      out: out.trim(),
    };
  };

  it('labels a PR that closes an issue its own author opened', () => {
    expect(run({ prAuthor: 'alice', issueAuthors: 'alice' })).toMatchObject({
      added: true,
      removed: false,
      labelCreated: true,
    });
    // One self-reported issue among several linked is enough.
    expect(
      run({ prAuthor: 'alice', issueAuthors: 'bob\nalice\ncarol' }).added,
    ).toBe(true);
  });

  it('removes the label once no closed issue is self-reported', () => {
    // The link was re-pointed to someone else's issue…
    expect(
      run({ prAuthor: 'alice', issueAuthors: 'bob', hasLabel: true }),
    ).toMatchObject({ added: false, removed: true });
    // …or removed entirely.
    expect(
      run({ prAuthor: 'alice', issueAuthors: '', hasLabel: true }).removed,
    ).toBe(true);
  });

  it('makes no change when the label already matches the state', () => {
    expect(
      run({ prAuthor: 'alice', issueAuthors: 'alice', hasLabel: true }),
    ).toMatchObject({ added: false, removed: false });
    expect(
      run({ prAuthor: 'alice', issueAuthors: 'bob', hasLabel: false }),
    ).toMatchObject({ added: false, removed: false });
    // A PR that closes no issue is never labelled.
    expect(
      run({ prAuthor: 'alice', issueAuthors: '', hasLabel: false }),
    ).toMatchObject({ added: false, removed: false });
  });

  it('fails open: a GraphQL failure never adds or removes the label', () => {
    // gh api graphql 5xx → API_OK=false. The label state is unknown, so the
    // step must leave it untouched rather than read empty results as
    // "no self-reported link" and strip a correct label.
    expect(
      run({ prAuthor: 'alice', hasLabel: true, apiFails: true }),
    ).toMatchObject({ added: false, removed: false });
    expect(
      run({ prAuthor: 'alice', hasLabel: false, apiFails: true }),
    ).toMatchObject({ added: false, removed: false });
  });

  it('pins the REST failure policies: 404 race silent, other DELETEs warned, POST loud', () => {
    // DELETE: the presence check is not atomic with the DELETE — a 404 race
    // means the desired end state already holds: green, no warning, and the
    // removal is logged.
    const race = run({
      prAuthor: 'alice',
      issueAuthors: 'bob',
      hasLabel: true,
      deleteFails: 'HTTP 404: Not Found (https://api.github.com/…)',
    });
    expect(race.removed).toBe(true);
    expect(race.out).not.toContain('::warning::');
    // R7-5: a 404 race means the end state holds → the success claim fires,
    // the "did not land" claim must not.
    expect(race.out).toContain('removed');
    expect(race.out).not.toContain('removal did not land');
    // Any other DELETE failure keeps the step green (the job only re-runs
    // on the next PR event) but MUST surface — a silent run would claim
    // "removed" while the label stays on the PR.
    const failed = run({
      prAuthor: 'alice',
      issueAuthors: 'bob',
      hasLabel: true,
      deleteFails: 'HTTP 500',
    });
    expect(failed.removed).toBe(true);
    expect(failed.out).toContain('::warning::');
    expect(failed.out).toContain('removal failed');
    expect(failed.out).toContain('HTTP 500');
    // R7-5: the LBL_DEL_FAILED branching — a failed DELETE must NOT claim
    // the label was removed (the lying-log shape this change exists to kill).
    expect(failed.out).toContain('removal did not land');
    expect(failed.out).not.toContain('removed');
    // R10-1/R10-3: the tolerated token is exactly "HTTP 404" — a transport
    // failure embedding a 404-bearing request URL must warn and report
    // not-landed, never read as the already-off case (the loose *404*
    // match hit the URL's PR number and claimed "removed").
    const transport = run({
      prAuthor: 'alice',
      issueAuthors: 'bob',
      hasLabel: true,
      deleteFails:
        'gh: Delete "https://api.github.com/repos/o/r/issues/4041/labels/review%2Fself-reported": dial tcp 140.82.121.4:443: connect: connection refused',
    });
    expect(transport.removed).toBe(true);
    expect(transport.out).toContain('::warning::');
    expect(transport.out).toContain('removal failed');
    expect(transport.out).toContain('removal did not land');
    expect(transport.out).not.toContain('removed');
    // POST carries NO tolerance: a label that fails to apply must fail the
    // step (the runBlock sets -e), not leave the PR unlabeled behind green.
    expect(() =>
      run({ prAuthor: 'alice', issueAuthors: 'alice', postFails: 'HTTP 500' }),
    ).toThrow();
  });

  it('never interpolates PR-controlled data into the run body (env only)', () => {
    // pull_request_target hardening: the author/number/label reach the script
    // only through env, so a crafted title or body cannot inject shell.
    expect(runBlock).not.toMatch(/\$\{\{/);
  });
});

// Scans the DECODED `run:` scripts of one parsed workflow for `gh pr edit`
// label mutations — what bash will actually execute, not the YAML surface.
// Scanning raw lines was evaded three ways (all reproduced): a `#` inside a
// quoted string ate the trailing backslash, a wrap INSIDE the command
// prefix (`gh \` / `pr edit`, or `--add-\` / `label`) never re-joined into
// the literal the regex wanted, and a folded scalar (`run: >`) has no
// backslashes at all. Parsing the YAML resolves folding; joining
// continuations the way bash does (backslash-newline removed, nothing
// inserted) resolves the wraps; the whitespace-tolerant regex resolves the
// prefix splits. Only WHOLE-line comments are stripped — a `#` mid-line may
// sit inside a quoted string, and a comment quoting the ban documents it.
// Offenders are reported as file » job » step (never a line number: those
// stop corresponding to the file after joining).
function ghPrEditLabelOffenders(file, raw) {
  const banned = /gh\s+pr\s+edit[\s\S]*?(--add-label|--remove-label)/;
  const offenders = [];
  const doc = parse(raw);
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    (job?.steps ?? []).forEach((step, i) => {
      if (typeof step?.run !== 'string') return;
      const script = step.run
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n')
        .replace(/\\\n/g, '');
      if (banned.test(script)) {
        offenders.push(`${file} » ${jobId} » ${step.name ?? `step ${i}`}`);
      }
    });
  }
  return offenders;
}

// The argv form (`execFileSync('gh', ['pr', 'edit', …, '--add-label'])`) is
// how scripts under .github/scripts spell the same broken command — the
// release path shipped it silently for months behind continue-on-error.
function ghPrEditLabelArgvOffenders(file, raw) {
  return /['"]pr['"],\s*['"]edit['"][\s\S]{0,400}?(--add-label|--remove-label)/.test(
    raw,
  )
    ? [file]
    : [];
}

describe('gh pr edit label mutations are banned in workflow files', () => {
  // `gh pr edit` label mutations fail wherever the gh build still requests
  // repository.pullRequest.projectCards: GitHub answers the Projects
  // (classic) deprecation as an error and the command exits 1 before
  // applying the change. Three workflows carried label mutations through it
  // and every such arm failed silently-green (the runs only passed when
  // there was nothing to do) or warned with a misdiagnosis. Labels go
  // through the REST issues/labels endpoints, which never touch that query.
  // Scope is workflow YAML: .github/scripts/classify-release-notes.mjs still
  // toggles skip-changelog-auto through `gh pr edit` on the release path and
  // needs its own conversion.
  it('catches every executable shape and ignores documentation', () => {
    const wf = (run) =>
      `jobs:\n  j:\n    steps:\n      - name: s\n        run: |\n${run
        .split('\n')
        .map((l) => `          ${l}`)
        .join('\n')}\n`;
    // A comment quoting the banned pattern documents the ban — no offence.
    expect(
      ghPrEditLabelOffenders(
        'w.yml',
        wf('# do not revert to gh pr edit --add-label here\necho ok'),
      ),
    ).toEqual([]);
    // Plain violation.
    expect(
      ghPrEditLabelOffenders('w.yml', wf('gh pr edit 1 --add-label x')),
    ).toEqual(['w.yml » j » s']);
    // Evasion 1 (reproduced by review): a `#` inside a quoted string on the
    // first line of a continuation — per-line comment stripping ate the
    // trailing backslash and never joined the halves.
    expect(
      ghPrEditLabelOffenders(
        'w.yml',
        wf(
          'echo "🏷️ #${PR}: applying" && gh pr edit "${PR}" \\\n  --add-label "${LABEL}"',
        ),
      ),
    ).toEqual(['w.yml » j » s']);
    // Evasion 2: a wrap INSIDE the command prefix and inside a flag token —
    // bash joins backslash-newline with nothing inserted.
    expect(
      ghPrEditLabelOffenders('w.yml', wf('gh \\\n  pr edit 1 --add-label x')),
    ).toEqual(['w.yml » j » s']);
    expect(
      ghPrEditLabelOffenders('w.yml', wf('gh pr edit 1 --add-\\\nlabel x')),
    ).toEqual(['w.yml » j » s']);
    // Evasion 3: a folded scalar has no backslashes on any physical line.
    expect(
      ghPrEditLabelOffenders(
        'w.yml',
        'jobs:\n  j:\n    steps:\n      - name: s\n        run: >\n          gh pr edit 1\n          --add-label x\n',
      ),
    ).toEqual(['w.yml » j » s']);
    // The argv form used by .mjs scripts.
    expect(
      ghPrEditLabelArgvOffenders(
        's.mjs',
        "execFileSync('gh', ['pr', 'edit', n, '--repo', r, '--add-label', L]);",
      ),
    ).toEqual(['s.mjs']);
    expect(
      ghPrEditLabelArgvOffenders(
        's.mjs',
        "execFileSync('gh', ['api', '-X', 'POST', `repos/x/issues/1/labels`]);",
      ),
    ).toEqual([]);
  });

  it('no workflow or script mutates labels through gh pr edit', () => {
    const offenders = [];
    for (const file of readdirSync('.github/workflows').filter((f) =>
      /\.ya?ml$/.test(f),
    )) {
      offenders.push(
        ...ghPrEditLabelOffenders(
          file,
          readFileSync(join('.github/workflows', file), 'utf8'),
        ),
      );
    }
    for (const file of readdirSync('.github/scripts').filter((f) =>
      /\.mjs$/.test(f),
    )) {
      offenders.push(
        ...ghPrEditLabelArgvOffenders(
          file,
          readFileSync(join('.github/scripts', file), 'utf8'),
        ),
      );
    }
    expect(offenders).toEqual([]);
  });
});

describe('REST DELETE idiom stays in sync across workflows', () => {
  // The one non-obvious line — URI-encoding a slash-containing label as a
  // DELETE path segment, plus the 404 race tolerance — exists in two
  // workflows and cannot be shared (workflow run blocks have no include).
  // This pin makes them drift-proof: normalize the label variable and the
  // two must be byte-identical.
  it('pr-self-report-label and qwen-autofix delete labels identically', () => {
    const idiom = (file, labelVar) => {
      const raw = readFileSync(join('.github/workflows', file), 'utf8');
      const m = raw.match(
        /if ! REMOVE_ERR="\$\(gh api -X DELETE[^\n]*\n[^\n]*404[^\n]*\n/,
      );
      expect(m, `${file}: DELETE idiom not found`).toBeTruthy();
      return m[0]
        .replace(new RegExp(labelVar, 'g'), 'LBL')
        .replace(/^\s+/gm, '');
    };
    expect(idiom('pr-self-report-label.yml', 'LABEL')).toEqual(
      idiom('qwen-autofix.yml', 'TAKEOVER_LABEL'),
    );
  });
});
