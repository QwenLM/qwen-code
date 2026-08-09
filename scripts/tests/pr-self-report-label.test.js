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
// view). Stub both and record which mutation, if any, it makes.
const GH_STUB = [
  '#!/usr/bin/env bash',
  'echo "gh $*" >> "${CALLS_LOG}"',
  'case "$*" in',
  "  *'api graphql'*) [ \"${GH_API_FAILS:-false}\" = true ] && exit 1; printf '%s\\n' ${GH_ISSUE_AUTHORS:-} ;;",
  "  *'pr view'*labels*) { [ \"${GH_HAS_LABEL:-false}\" = true ] && printf 'true' || printf 'false'; } ;;",
  '  *) : ;;',
  'esac',
  'exit 0',
].join('\n');

// The replayed DELETE URI-encodes the slashed label with a REAL jq — stub it
// on PATH like gh so the suite never depends on the host having jq (a fresh
// macOS has none, and the %2F assertion would fail opaquely). Supports only
// the one form the workflow executes: jq -rn --arg NAME VALUE '$NAME|@uri'.
const JQ_STUB = [
  '#!/usr/bin/env bash',
  'value=""',
  'while [[ $# -gt 0 ]]; do',
  '  if [[ "$1" == "--arg" ]]; then value="$3"; shift 3; else shift; fi',
  'done',
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

  it('never interpolates PR-controlled data into the run body (env only)', () => {
    // pull_request_target hardening: the author/number/label reach the script
    // only through env, so a crafted title or body cannot inject shell.
    expect(runBlock).not.toMatch(/\$\{\{/);
  });
});

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
  it('no workflow mutates labels through gh pr edit', () => {
    const dir = '.github/workflows';
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const offenders = [];
    for (const file of files) {
      // Join backslash continuations first: `.` does not span newlines, so a
      // wrapped `gh pr edit … \` with the label flag on the next line would
      // otherwise slip past the per-line scan.
      const text = readFileSync(join(dir, file), 'utf8').replace(
        /\\\n\s*/g,
        ' ',
      );
      for (const [i, line] of text.split('\n').entries()) {
        if (/gh pr edit .*(--add-label|--remove-label)/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
