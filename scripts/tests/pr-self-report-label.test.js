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
  'value=""',
  'prog=""',
  'while [[ $# -gt 0 ]]; do',
  '  if [[ "$1" == "--arg" ]]; then value="$3"; shift 3; else prog="$1"; shift; fi',
  'done',
  '[[ "$prog" == \'$l|@uri\' ]] || exit 1',
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

// Scans one workflow file for `gh pr edit` label mutations. Comments are
// stripped before matching — a comment QUOTING the banned pattern documents
// the ban, it does not run it. Backslash continuations are joined so a
// wrapped flag still counts, and the reported line is the PHYSICAL line
// where the command starts: indices into the joined text no longer
// correspond to file lines (every benign join above an offender shifts
// them).
function ghPrEditLabelOffenders(file, raw) {
  const banned = /gh pr edit .*(--add-label|--remove-label)/;
  const offenders = [];
  let joined = '';
  let start = 0;
  for (const [i, line] of raw.split('\n').entries()) {
    if (joined === '') start = i + 1;
    const text = line.replace(/#.*$/, '');
    joined += ` ${text}`;
    if (text.endsWith('\\')) continue;
    if (banned.test(joined)) offenders.push(`${file}:${start}`);
    joined = '';
  }
  return offenders;
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
  it('ignores comments and reports the command start line', () => {
    // A comment quoting the banned pattern documents the ban — it must not
    // fail CI (the house style is dense why-comments; two of the guarded
    // workflows name `gh pr edit` in comments already).
    expect(
      ghPrEditLabelOffenders(
        'w.yml',
        '# do not revert to gh pr edit --add-label here\n',
      ),
    ).toEqual([]);
    // An executable violation is still caught…
    expect(
      ghPrEditLabelOffenders(
        'w.yml',
        'gh pr edit "${PR}" --add-label "${LABEL}"\n',
      ),
    ).toEqual(['w.yml:1']);
    // …even wrapped across continuations, and at the PHYSICAL line where
    // the command starts: line 5 here, where the two benign joins above
    // would shift any index computed from the joined text.
    const wrapped = [
      'gh label create x \\',
      '  --color BFD4F2',
      'echo hi \\',
      '  there',
      'gh pr edit "${PR}" \\',
      '  --add-label "${LABEL}"',
    ].join('\n');
    expect(ghPrEditLabelOffenders('w.yml', wrapped)).toEqual(['w.yml:5']);
  });

  it('no workflow mutates labels through gh pr edit', () => {
    const dir = '.github/workflows';
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const offenders = [];
    for (const file of files) {
      offenders.push(
        ...ghPrEditLabelOffenders(file, readFileSync(join(dir, file), 'utf8')),
      );
    }
    expect(offenders).toEqual([]);
  });
});
