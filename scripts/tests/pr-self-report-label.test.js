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
      added: /add-label/.test(calls),
      removed: /remove-label/.test(calls),
      out: out.trim(),
    };
  };

  it('labels a PR that closes an issue its own author opened', () => {
    expect(run({ prAuthor: 'alice', issueAuthors: 'alice' })).toMatchObject({
      added: true,
      removed: false,
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
