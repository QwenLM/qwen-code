/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  join(root, '.github/workflows/main-ci-failure-resolve.yml'),
  'utf8',
);
const yml = parse(workflow);
const reporter = parse(
  readFileSync(
    join(root, '.github/workflows/main-ci-failure-issue.yml'),
    'utf8',
  ),
);
const job = yml.jobs.resolve;
const script = job.steps.find(
  (step) => step.name === 'Close the issues this green run covers',
).run;
// Replay uses bash plus jq; the static workflow checks above still run where
// those documented test prerequisites are absent.
const replayable =
  process.platform !== 'win32' &&
  spawnSync('bash', ['--version']).status === 0 &&
  spawnSync('jq', ['--version']).status === 0;

describe('main CI failure resolver', () => {
  it('watches the same workflows as the reporter', () => {
    // The reporter files by workflow; a resolver that misses one leaves that
    // family open forever, and a resolver that watches an unfiled workflow
    // would close issues nobody created.
    expect([...yml.on.workflow_run.workflows].sort()).toEqual(
      [...reporter.on.workflow_run.workflows].sort(),
    );
    expect(Object.keys(yml.on.workflow_run).sort()).toEqual([
      'types',
      'workflows',
    ]);
    expect(yml.on.workflow_run.types).toEqual(['completed']);
  });

  it('runs for a green main run or a green pre-merged PR gate', () => {
    // Pin the whole expression so a later arm cannot admit another PR
    // workflow, whose job closure would not prove a main regression resolved.
    // The dispatch arm mirrors the
    // reporter's: SDK Java runs on dispatch and schedule only, so without it
    // that whole family never retires.
    expect(job.if).toBe(
      "${{ github.repository == 'QwenLM/qwen-code' && " +
        "github.event.workflow_run.conclusion == 'success' && " +
        "((github.event.workflow_run.head_branch == 'main' && " +
        "(github.event.workflow_run.event == 'push' || " +
        "(github.event.workflow_run.event == 'schedule' && " +
        'contains(fromJSON(\'["E2E Tests","Qwen Code CI","SDK Java","Desktop Checks","tui-parity","Managed Agent loop verification"]\'), github.event.workflow.name)))) || ' +
        "(github.event.workflow_run.event == 'workflow_dispatch' && " +
        "github.event.workflow_run.head_branch == 'main' && " +
        "github.event.workflow.name == 'SDK Java') || " +
        "((github.event.workflow_run.event == 'pull_request' || " +
        "github.event.workflow_run.event == 'pull_request_review') && " +
        "github.event.workflow.name == 'Managed Agent gate')) }}",
    );
    expect(yml.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'write',
      'pull-requests': 'read',
    });
    expect(job.concurrency).toEqual(reporter.jobs.file_issue.concurrency);
    expect(job.steps[0].env.GH_TOKEN).toBe('${{ github.token }}');
  });

  it('closes only issues this run proves are resolved', () => {
    // Age guard: an issue a newer failing run just touched is not covered by
    // this green run.
    expect(script).toContain('.updatedAt < $run_started');
    // Per-signature issues are not closed by a green run that skipped the leg
    // they name, so every failing job in the body must be a successful job of
    // this run.
    expect(script).toContain('grep -Fxq -- "${job_name}" "${green_jobs}"');
    expect(script).toContain('--reason completed');
    // Closing the whole family on a run with no successful jobs would retire
    // issues a skipped lane never disproved.
    expect(script).toContain('recorded no successful jobs; closing nothing');
    // The reporter owns the PAT fallback; the resolver only needs to read its
    // own run and write issues, so it must not add a second copy of that
    // secret path.
    expect(script).not.toContain('CI_DEV_BOT_PAT');
    expect(script).toContain('/commits/${RUN_HEAD_SHA}/pulls');
  });

  it('matches the reporter’s title families', () => {
    expect(script).toContain('(.title == $family)');
    expect(script).toContain('startswith($family + " — ")');
    expect(script).toContain('startswith($family + " on ")');
  });

  function runResolver({
    issues,
    views,
    greenJobs,
    runEvent = 'push',
    runHeadSha = '',
    prAssociation = true,
  }) {
    const directory = mkdtempSync(join(tmpdir(), 'main-ci-resolve-'));
    const bin = join(directory, 'bin');
    const ghLog = join(directory, 'gh-calls');
    const greenFile = join(directory, 'green-jobs.txt');
    const issuesFile = join(directory, 'issues.json');
    const viewDir = join(directory, 'views');
    const scriptPath = join(directory, 'resolver.sh');
    mkdirSync(bin);
    mkdirSync(viewDir);
    writeFileSync(greenFile, greenJobs.map((job) => `${job}\n`).join(''));
    writeFileSync(issuesFile, JSON.stringify(issues));
    writeFileSync(scriptPath, script, { mode: 0o755 });
    for (const [number, view] of Object.entries(views)) {
      writeFileSync(
        join(viewDir, `issue-${number}.json`),
        JSON.stringify(view),
      );
    }
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\n' +
        'printf "%s\\n" "$*" >> "$GH_CALL_LOG"\n' +
        'if [ "$1" = api ]; then\n' +
        '  case "$2" in */pulls) printf "%s\\n" "$GH_PR_ASSOCIATION"; exit 0;; esac\n' +
        '  cat "$GH_GREEN_JOBS"; exit 0\n' +
        'fi\n' +
        'if [ "$1" = issue ] && [ "$2" = list ]; then cat "$GH_ISSUES"; exit 0; fi\n' +
        'if [ "$1" = issue ] && [ "$2" = view ]; then\n' +
        '  cat "$GH_ISSUE_DIR/issue-$3.json" || exit 1\n' +
        '  exit 0\n' +
        'fi\n' +
        'if [ "$1" = issue ] && [ "$2" = close ]; then exit 0; fi\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
    try {
      const result = spawnSync('bash', [scriptPath], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_CALL_LOG: ghLog,
          GH_GREEN_JOBS: greenFile,
          GH_ISSUES: issuesFile,
          GH_ISSUE_DIR: viewDir,
          GH_PR_ASSOCIATION: prAssociation,
          GH_TOKEN: 'workflow-token',
          CONFIGURED_BOT_LOGIN: 'qwen-code-dev-bot',
          REPO: 'QwenLM/qwen-code',
          RUN_ID: '12345',
          RUN_STARTED_AT: '2026-11-26T12:00:00Z',
          RUN_URL: 'https://github.example/run/12345',
          RUN_HEAD_SHA: runHeadSha,
          RUN_EVENT: runEvent,
          WORKFLOW_NAME:
            runEvent === 'push' ? 'Qwen Code CI' : 'Managed Agent gate',
        },
      });
      return { result, calls: readFileSync(ghLog, 'utf8') };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  function listedIssue(number, author, updatedAt = '2026-11-26T11:00:00Z') {
    return {
      number,
      title: 'Main CI failed: Qwen Code CI — sample failure',
      author: { login: author },
      updatedAt,
    };
  }

  function issueView(number, body, overrides = {}) {
    return {
      number,
      title: 'Main CI failed: Qwen Code CI — sample failure',
      state: 'OPEN',
      author: { login: 'qwen-code-dev-bot' },
      createdAt: '2026-11-26T10:00:00Z',
      updatedAt: '2026-11-26T11:00:00Z',
      body: `${body}\n\n<!-- qwen-managed-agent-ci-failure:test-run -->`,
      comments: [],
      ...overrides,
    };
  }

  it.skipIf(!replayable)(
    'closes only a reporter-owned issue whose latest recognizable record is covered',
    () => {
      const body = '- [`Linux unit tests`](https://github.example/job/1)';
      const { result, calls } = runResolver({
        issues: [
          listedIssue(101, 'qwen-code-dev-bot'),
          listedIssue(102, 'yiliang114'),
        ],
        views: {
          101: issueView(101, body, {
            comments: [
              {
                author: { login: 'qwen-code-dev-bot' },
                createdAt: '2026-11-26T11:30:00Z',
                body: 'This comment records no failure jobs.',
              },
              {
                author: { login: 'yiliang114' },
                createdAt: '2026-11-26T11:45:00Z',
                body: '<!-- qwen-main-ci-failure:human -->\n- [`Windows unit tests`](https://github.example/job/human)',
              },
            ],
          }),
        },
        greenJobs: ['Linux unit tests'],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain('issue close 101');
      expect(calls).not.toContain('issue close 102');
      expect(calls).not.toContain('issue view 102');
    },
  );

  it.skipIf(!replayable)(
    'keeps a legacy indented job list open when that job was not green',
    () => {
      const body =
        '- Workflow: Qwen Code CI\n- Failed jobs:\n  - `Windows unit tests` — failed in step `Run tests`';
      const { result, calls } = runResolver({
        issues: [listedIssue(201, 'app/github-actions')],
        views: {
          201: issueView(201, body, {
            author: { login: 'app/github-actions' },
            body: `${body}\n\n<!-- qwen-main-ci-failure:legacy -->`,
          }),
        },
        greenJobs: ['Linux unit tests'],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).not.toContain('issue close 201');
    },
  );

  it.skipIf(!replayable)(
    'retires a PR gate failure only on the same PR and commit',
    () => {
      const sha = 'ec948cf2cdc1';
      const body = `[Run 45591376211](https://github.example/run/45591376211) · commit \`${sha}\`\n\n- [\`SDK Java (full) / MySQL / Java 21\`](https://github.example/job/1)`;
      const greenJobs = ['SDK Java (full) / MySQL / Java 21'];
      const headSha = `${sha}abcdef`;
      const gateView = (number) =>
        issueView(number, body, {
          title: 'Main CI failed: Managed Agent gate — sample failure',
        });
      const gateIssue = (number) => ({
        ...listedIssue(number, 'qwen-code-dev-bot'),
        title: 'Main CI failed: Managed Agent gate — sample failure',
      });
      const { result, calls } = runResolver({
        issues: [gateIssue(501), gateIssue(502), gateIssue(503)],
        views: {
          501: gateView(501),
          502: gateView(502),
          503: gateView(503),
        },
        greenJobs,
        runEvent: 'pull_request',
        runHeadSha: headSha,
        prAssociation: true,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(calls, `${result.stdout}\n${result.stderr}`).toContain(
        'issue close 501',
      );

      const otherPr = runResolver({
        issues: [gateIssue(502)],
        views: { 502: gateView(502) },
        greenJobs,
        runEvent: 'pull_request_review',
        runHeadSha: `${sha}abcdef`,
        prAssociation: false,
      });
      expect(otherPr.result.status, otherPr.result.stderr).toBe(0);
      expect(otherPr.calls).not.toContain('issue close 502');

      const rebuiltCommit = runResolver({
        issues: [gateIssue(503)],
        views: { 503: gateView(503) },
        greenJobs,
        runEvent: 'pull_request',
        runHeadSha: 'a-rebuilt-commit',
        prAssociation: true,
      });
      expect(rebuiltCommit.result.status, rebuiltCommit.result.stderr).toBe(0);
      expect(rebuiltCommit.calls).not.toContain('issue close 503');

      const rebuiltPr = runResolver({
        issues: [gateIssue(504)],
        views: { 504: gateView(504) },
        greenJobs,
        runEvent: 'pull_request',
        runHeadSha: headSha,
        prAssociation: false,
      });
      expect(rebuiltPr.result.status, rebuiltPr.result.stderr).toBe(0);
      expect(rebuiltPr.calls).not.toContain('issue close 504');
    },
  );

  it.skipIf(!replayable).each([
    { name: 'per-commit', marker: 'qwen-main-ci-failure' },
    { name: 'per-signature', marker: 'qwen-main-ci-failure-sig' },
  ])(
    'closes a covered legacy $name report written by the workflow identity',
    ({ marker }) => {
      const body =
        '- Workflow: Qwen Code CI\n- Failed jobs:\n  - `Windows unit tests` — failed in step `Run tests`';
      const { result, calls } = runResolver({
        issues: [listedIssue(202, 'app/github-actions')],
        views: {
          202: issueView(202, body, {
            author: { login: 'app/github-actions' },
            body: `${body}\n\n<!-- ${marker}:historical -->`,
          }),
        },
        greenJobs: ['Windows unit tests'],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain('issue close 202');
    },
  );

  it.skipIf(!replayable)(
    'uses the newest reporter failure comment instead of the stale issue body',
    () => {
      const body = '- [`Linux unit tests`](https://github.example/job/1)';
      const comment =
        '- [`macOS unit tests`](https://github.example/job/2)\n\n<!-- qwen-managed-agent-ci-failure:recurrence -->';
      const { result, calls } = runResolver({
        issues: [listedIssue(301, 'qwen-code-dev-bot')],
        views: {
          301: issueView(301, body, {
            comments: [
              {
                author: { login: 'qwen-code-dev-bot' },
                createdAt: '2026-11-26T11:30:00Z',
                body: comment,
              },
            ],
          }),
        },
        greenJobs: ['Linux unit tests'],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).not.toContain('issue close 301');
    },
  );

  it.skipIf(!replayable)(
    're-checks issue state before closing and leaves unrecognized records open',
    () => {
      const { result, calls } = runResolver({
        issues: [
          listedIssue(401, 'qwen-code-dev-bot'),
          listedIssue(402, 'qwen-code-dev-bot'),
          listedIssue(403, 'qwen-code-dev-bot'),
        ],
        views: {
          401: issueView(
            401,
            '- [`Linux unit tests`](https://github.example/job/1)',
            {
              comments: [
                {
                  author: { login: 'qwen-code-dev-bot' },
                  createdAt: '2026-11-26T11:30:00Z',
                  body: 'No job list was available for this failure.\n\n<!-- qwen-managed-agent-ci-failure:jobless-recurrence -->',
                },
              ],
            },
          ),
          402: issueView(
            402,
            '- [`Linux unit tests`](https://github.example/job/1)',
            {
              updatedAt: '2026-11-26T12:00:00Z',
            },
          ),
          403: issueView(
            403,
            '- [`Linux unit tests`](https://github.example/job/1)',
            {
              state: 'CLOSED',
            },
          ),
        },
        greenJobs: ['Linux unit tests'],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(calls).not.toContain('issue close 401');
      expect(calls).not.toContain('issue close 402');
      expect(calls).not.toContain('issue close 403');
      expect(result.stdout).toContain(
        'Could not identify the latest failure jobs in #401',
      );
    },
  );
});
