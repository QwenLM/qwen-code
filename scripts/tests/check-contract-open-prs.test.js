/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STATUS_CONTEXT,
  mainContract,
  run,
} from '../check-contract-open-prs.js';
import { CONTRACT_DOCUMENT } from '../contract-version-utils.js';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-contract-open-prs.js',
);
const MAIN_SHA = 'fbde5cf0'.padEnd(40, '0');

const document = (version, note = 'a') =>
  JSON.stringify({ openapi: '3.1.0', info: { title: 't', version }, note });
const MAIN_TEXT = document('1.38.0', 'main');

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-contract-open-prs-'));
  const file = join(root, CONTRACT_DOCUMENT);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${MAIN_TEXT}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// An open PR as the API lists it: every path ADDED unless given as
// [path, changeType]. `doc` is the document text its head answers through
// the contents API (null means the API cannot answer it), `current` the
// status its last commit carries, `currentOid` that commit when it is not
// the head.
const pr = (number, files, extra = {}) => ({
  number,
  headRefOid: String(number).padEnd(40, 'a'),
  files: files.map((file) =>
    Array.isArray(file)
      ? { path: file[0], changeType: file[1] }
      : { path: file, changeType: 'ADDED' },
  ),
  ...extra,
});
const touching = (changeType = 'ADDED') => [CONTRACT_DOCUMENT, changeType];

// A fake `gh` serving the PR list two PRs per page and each PR's files two
// per page, so both cursors are exercised, answering each touching PR's
// document from `doc`, and recording every call.
function fakeGh(prs, { failPost = [], graphqlError } = {}) {
  const calls = [];
  const flags = (args) => {
    const out = {};
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '-f' || args[index] === '-F') {
        const [key, ...value] = args[index + 1].split('=');
        out[key] = { value: value.join('='), typed: args[index] === '-F' };
      }
    }
    return out;
  };
  const filePage = (files, cursor) => {
    const start = Number(cursor ?? 0);
    const end = start + 2;
    return {
      pageInfo: { hasNextPage: end < files.length, endCursor: String(end) },
      nodes: files.slice(start, end),
    };
  };
  const gh = async (args) => {
    calls.push(args);
    const f = flags(args);
    if (args[1] === 'graphql') {
      if (graphqlError) throw new Error(graphqlError);
      expect(f.owner.value).toBe('QwenLM');
      expect(f.name.value).toBe('qwen-code');
      if (f.query.value.includes('pullRequests(')) {
        expect(f.query.value).toContain('states: OPEN, baseRefName: "main"');
        // The last commit is the head; the fake serves `current` for it.
        expect(f.query.value).toContain('commits(last: 1)');
        expect(f.query.value).toContain(`context(name: "${STATUS_CONTEXT}")`);
        const start = Number(f.cursor?.value ?? 0);
        const end = start + 2;
        return JSON.stringify({
          data: {
            repository: {
              pullRequests: {
                pageInfo: {
                  hasNextPage: end < prs.length,
                  endCursor: String(end),
                },
                nodes: prs.slice(start, end).map((node) => ({
                  number: node.number,
                  headRefOid: node.headRefOid,
                  changedFiles: node.changedFiles ?? node.files.length,
                  commits: {
                    nodes: [
                      {
                        commit: {
                          oid: node.currentOid ?? node.headRefOid,
                          status: node.current
                            ? { context: node.current }
                            : null,
                        },
                      },
                    ],
                  },
                  files: filePage(node.files),
                })),
              },
            },
          },
        });
      }
      // GraphQL rejects a string where the query declares Int!.
      expect(f.number.typed).toBe(true);
      const target = prs.find((node) => node.number === Number(f.number.value));
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: { files: filePage(target.files, f.cursor.value) },
          },
        },
      });
    }
    if (args[1] !== '--method') {
      // The contents API: repos/<repo>/contents/<document>?ref=<sha>.
      const [endpoint, query] = args[1].split('?');
      expect(endpoint).toBe(
        `repos/QwenLM/qwen-code/contents/${CONTRACT_DOCUMENT}`,
      );
      const sha = new URLSearchParams(query).get('ref');
      const target = prs.find((node) => node.headRefOid === sha);
      if (!target?.doc) throw new Error('HTTP 404: Not Found');
      return JSON.stringify({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(target.doc, 'utf8').toString('base64'),
      });
    }
    const sha = args[3].split('/').pop();
    if (failPost.includes(sha)) {
      throw new Error('HTTP 422: No commit found\n::error::forged ##[group]x');
    }
    return '{}';
  };
  const posts = () =>
    calls
      .filter((args) => args[1] === '--method')
      .map((args) => {
        const f = flags(args);
        return {
          path: args[3],
          state: f.state.value,
          context: f.context.value,
          description: f.description.value,
          targetUrl: f.target_url?.value,
        };
      });
  return { gh, calls, posts };
}

async function check(prs, options = {}) {
  const fake = fakeGh(prs, options);
  const result = await run({
    root,
    repo: 'QwenLM/qwen-code',
    mainSha: MAIN_SHA,
    targetUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/1',
    dryRun: options.dryRun ?? false,
    gh: fake.gh,
  });
  const byPr = Object.fromEntries(
    fake
      .posts()
      .map((post) => [Number(post.path.split('/').pop().slice(0, 5)), post]),
  );
  return { ...result, posts: fake.posts(), byPr, calls: fake.calls };
}

describe('check-contract-open-prs', () => {
  it('fails a PR that declares the version main already carries', async () => {
    // The stall #13163 landed: document changed, info.version unmoved.
    const { posts, failed, lines } = await check([
      pr(13598, ['README.md', touching()], { doc: document('1.38.0', 'pr') }),
    ]);
    expect(failed).toBe(0);
    expect(posts).toEqual([
      {
        path: `repos/QwenLM/qwen-code/statuses/${'13598'.padEnd(40, 'a')}`,
        state: 'failure',
        context: STATUS_CONTEXT,
        description: "1.38.0 does not advance past main's 1.38.0",
        targetUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/1',
      },
    ]);
    expect(lines[0]).toBe(
      '### Contract versions of open PRs against main@fbde5cf',
    );
  });

  it('fails a PR that declares a version below main', async () => {
    const { byPr } = await check([
      pr(13545, [touching()], { doc: document('1.34.0', 'pr') }),
    ]);
    expect(byPr[13545]).toMatchObject({
      state: 'failure',
      description: "1.34.0 regresses below main's 1.38.0",
    });
  });

  it('compares versions numerically: 1.9.0 is below 1.37.0, and a missing segment reads as zero', async () => {
    // Witness through the API path for the numeric compare: a lexicographic
    // one ranks '1.9.0' above '1.37.0' and lets the regression pass.
    const { byPr } = await check([
      pr(10001, [touching()], { doc: document('1.9.0', 'pr') }),
      pr(10002, [touching()], { doc: document('1.38', 'pr') }),
      pr(10003, [touching()], { doc: document('1.039.0', 'pr') }),
    ]);
    expect(byPr[10001].description).toBe("1.9.0 regresses below main's 1.38.0");
    expect(byPr[10002].description).toBe(
      "1.38 does not advance past main's 1.38.0",
    );
    expect(byPr[10003].state).toBe('success');
  });

  it('passes a version ahead of main and names every other open PR claiming it', async () => {
    const { byPr } = await check([
      pr(10001, [touching()], { doc: document('1.39.0', 'one') }),
      pr(10002, [touching()], { doc: document('1.39.0', 'two') }),
      pr(10003, [touching()], { doc: document('1.40.0', 'three') }),
    ]);
    expect(byPr[10001]).toMatchObject({
      state: 'success',
      description:
        '1.39.0 is unique against main; also claimed by open PRs: #10002',
    });
    expect(byPr[10002].description).toContain('#10001');
    expect(byPr[10003]).toMatchObject({
      state: 'success',
      description: '1.40.0 is unique against main',
    });
  });

  it('fails a PR whose head document does not parse or declares no numeric version', async () => {
    const { byPr } = await check([
      pr(10001, [touching()], { doc: '{"info":' }),
      pr(10002, [touching()], { doc: document('1.39-SNAPSHOT') }),
    ]);
    expect(byPr[10001]).toMatchObject({
      state: 'failure',
      description: 'Head document is not parseable JSON',
    });
    expect(byPr[10002]).toMatchObject({
      state: 'failure',
      description: 'Head document declares no numeric-segment info.version',
    });
  });

  it('claims nothing for a PR that deletes the document', async () => {
    const { byPr } = await check([pr(10001, [touching('DELETED')])]);
    expect(byPr[10001]).toMatchObject({
      state: 'success',
      description: 'Removes the contract document, so no version claim',
    });
  });

  it("claims nothing when a PR's document is byte-identical to main's", async () => {
    // The changed-paths list names the document, but the head's copy read
    // back through the API is main's own: there is no version claim to
    // check, and the PR is not pestered when it carries no status.
    const { posts } = await check([
      pr(10001, [touching('MODIFIED')], { doc: MAIN_TEXT }),
    ]);
    expect(posts).toEqual([]);
  });

  it('clears the status when the PR no longer makes a claim', async () => {
    // Its claim landed on main, or a force-push took the document out of
    // the diff: the stale failure must not stay.
    const { byPr } = await check([
      pr(10001, [touching('MODIFIED')], {
        doc: MAIN_TEXT,
        current: { state: 'FAILURE', description: '1.38.0 stalled' },
      }),
      pr(10002, ['README.md'], {
        current: { state: 'FAILURE', description: '1.38.0 stalled' },
      }),
    ]);
    expect(byPr[10001]).toMatchObject({
      state: 'success',
      description: 'No claim on the contract version',
    });
    expect(byPr[10002].state).toBe('success');
  });

  it('leaves a head alone when its status already says the same', async () => {
    const description = '1.39.0 is unique against main';
    const { posts, lines } = await check([
      pr(10001, [touching()], {
        doc: document('1.39.0', 'pr'),
        current: { state: 'SUCCESS', description },
      }),
      // A status on a commit that is no longer the head says nothing.
      pr(10002, [touching()], {
        doc: document('1.40.0', 'pr'),
        current: { state: 'SUCCESS', description },
        currentOid: 'c'.repeat(40),
      }),
    ]);
    expect(lines).toContain(`- #10001 success: ${description} (unchanged)`);
    expect(posts.map((post) => post.path.slice(-40, -35))).toEqual(['10002']);
  });

  it('re-evaluates a head when another PR now claims its version', async () => {
    const { byPr, posts } = await check([
      pr(10001, [touching()], {
        doc: document('1.39.0', 'one'),
        current: {
          state: 'SUCCESS',
          description: '1.39.0 is unique against main',
        },
      }),
      pr(10002, [touching()], { doc: document('1.39.0', 'two') }),
    ]);
    expect(posts).toHaveLength(2);
    expect(byPr[10001].description).toContain('#10002');
    expect(byPr[10002].description).toContain('#10001');
  });

  it('reports a PR whose file list was cut short, unless the files read already answer', async () => {
    const { byPr } = await check([
      pr(10001, ['a.md'], { changedFiles: 3001 }),
      pr(10002, [touching()], {
        changedFiles: 3001,
        doc: document('1.38.0', 'pr'),
      }),
    ]);
    expect(byPr[10001]).toMatchObject({
      state: 'error',
      description:
        'Could not list every changed file, so not checked against main',
    });
    // The stall among the files it did list is already certain.
    expect(byPr[10002].state).toBe('failure');
  });

  it('reports a PR whose head document cannot be read instead of guessing', async () => {
    const { byPr } = await check([pr(10001, [touching()], { doc: null })]);
    expect(byPr[10001]).toMatchObject({
      state: 'error',
      description: 'Could not read the head document, so not checked',
    });
  });

  it('stops reading after the run-wide API budget and reports the rest as unread', async () => {
    const huge = Array.from({ length: 300 }, (_, index) => `docs/f${index}.md`);
    const { byPr, calls, lines } = await check([
      pr(10001, [...huge, touching()], { doc: document('1.39.0', 'one') }),
      pr(10002, ['a.md', touching()], { doc: document('1.39.0', 'two') }),
    ]);
    // One page of the PR list and the hundred-budget pages of files; the
    // second PR's claim never gets a read.
    expect(calls.filter((args) => args[1] === 'graphql')).toHaveLength(101);
    expect(lines).toContain(
      'Read 100 API pages, the budget; PRs past it are reported as not checked.',
    );
    expect(byPr[10001].state).toBe('error');
    expect(byPr[10002].state).toBe('error');
  });

  it('caps the status description at 140 characters', async () => {
    const { byPr } = await check(
      Array.from({ length: 15 }, (_, index) =>
        pr(20001 + index, [touching()], { doc: document('1.39.0', 'pr') }),
      ),
    );
    for (let index = 0; index < 15; index += 1) {
      const post = byPr[20001 + index];
      expect(post.description).toHaveLength(140);
      expect(post.description.endsWith('...')).toBe(true);
      expect(post.state).toBe('success');
    }
  });

  it('posts nothing on a dry run but still reports', async () => {
    const { posts, lines } = await check(
      [pr(13598, [touching()], { doc: document('1.38.0', 'pr') })],
      { dryRun: true },
    );
    expect(posts).toEqual([]);
    expect(lines).toContain(
      "- #13598 failure: 1.38.0 does not advance past main's 1.38.0",
    );
  });

  it('keeps posting after one status fails, and counts the failure', async () => {
    const first = pr(10001, [touching()], { doc: document('1.38.0', 'one') });
    const { posts, failed, lines } = await check(
      [first, pr(10002, [touching()], { doc: document('1.39.0', 'two') })],
      { failPost: [first.headRefOid] },
    );
    expect(failed).toBe(1);
    expect(posts.map((post) => post.state)).toEqual(['failure', 'success']);
    expect(lines).toContain(
      '  - could not set the status: HTTP 422: No commit found ;;error;;forged ##［group]x',
    );
  });

  it('posts nothing when the PR list cannot be read', async () => {
    const fake = fakeGh([pr(10001, [touching()], { doc: 'x' })], {
      graphqlError: 'timeout',
    });
    await expect(
      run({
        root,
        repo: 'QwenLM/qwen-code',
        mainSha: MAIN_SHA,
        gh: fake.gh,
      }),
    ).rejects.toThrow('timeout');
    expect(fake.posts()).toEqual([]);
  });

  it('never posts for a PR that neither touches the document nor carries the status', async () => {
    const { posts, lines } = await check([pr(10001, ['README.md'])]);
    expect(posts).toEqual([]);
    expect(lines).toContain(
      'No open pull request against main changes the contract document.',
    );
  });
});

describe('mainContract', () => {
  it('reads the version of a checkout of main', () => {
    expect(mainContract(root)).toEqual({
      text: MAIN_TEXT,
      version: '1.38.0',
    });
  });

  it('refuses a checkout whose document is missing or does not parse', () => {
    // Comparing against an empty stand-in would pass every claim, so the
    // run refuses instead.
    const empty = mkdtempSync(join(tmpdir(), 'main-contract-empty-'));
    try {
      expect(() => mainContract(empty)).toThrow('no contract document');
      writeFileSync(
        join(root, CONTRACT_DOCUMENT),
        '{"info":{"version":"v1.38.0"}}',
      );
      expect(() => mainContract(root)).toThrow('on main');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// The CLI against a `gh` stub on PATH, in a git checkout: argument handling,
// the step summary, the exit status and the retry around a failed call.
describe.skipIf(process.platform === 'win32')(
  'check-contract-open-prs CLI',
  () => {
    const HEAD = 'b'.repeat(40);
    const GH_STUB = `const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const failures = Number(process.env.GH_FAILURES || 0);
const marker = process.env.GH_LOG + '.failed';
const failed = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
if (failed < failures) {
  writeFileSync(marker, String(failed + 1));
  process.stderr.write('HTTP 502: Bad Gateway\\n::error::forged ##[group]x');
  process.exit(1);
}
const args = process.argv.slice(2);
if (args.includes('graphql')) {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequests: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [{ number: 13598, headRefOid: '${HEAD}', changedFiles: 1,
      commits: { nodes: [{ commit: { oid: '${HEAD}', status: null } }] },
      files: { pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ path: '${CONTRACT_DOCUMENT}', changeType: 'MODIFIED' }] } }],
  } } } }));
} else if (args[1] === '--method') {
  if (process.env.GH_POST_FAILS) { process.stderr.write('HTTP 422: No commit found'); process.exit(1); }
  process.stdout.write('{}');
} else {
  process.stdout.write(JSON.stringify({ type: 'file', encoding: 'base64',
    content: Buffer.from('{"info":{"version":"1.38.0","title":"t"},"openapi":"3.1.0"}').toString('base64') }));
}
`;
    let head;
    beforeEach(() => {
      const git = (...args) =>
        execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
      git('init', '-q');
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'main',
      );
      head = git('rev-parse', 'HEAD');
    });

    const cli = (argv, env = {}) => {
      const bin = join(root, 'bin');
      mkdirSync(bin, { recursive: true });
      // A .cjs body: an extensionless script under a "type": "module"
      // ancestor would load as ESM.
      writeFileSync(join(bin, 'gh.cjs'), GH_STUB);
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/gh.cjs" "$@"\n`,
      );
      chmodSync(join(bin, 'gh'), 0o755);
      const log = join(root, 'gh.log');
      const summary = join(root, 'summary.md');
      return promisify(execFile)(process.execPath, [script, ...argv], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_LOG: log,
          GITHUB_REPOSITORY: 'QwenLM/qwen-code',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_RUN_ID: '7',
          GITHUB_STEP_SUMMARY: summary,
          ...env,
        },
      })
        .then(
          ({ stdout }) => ({ code: 0, stdout }),
          (error) => ({
            code: error.code,
            stdout: error.stdout,
            stderr: error.stderr,
          }),
        )
        .then((result) => ({
          ...result,
          calls: readFileSync(log, { encoding: 'utf8', flag: 'a+' })
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
          summary: readFileSync(summary, { encoding: 'utf8', flag: 'a+' }),
        }));
    };

    it('posts one status per claiming PR and writes the step summary', async () => {
      const result = await cli([]);
      expect(result.code).toBe(0);
      expect(result.summary).toBe(
        [
          `### Contract versions of open PRs against main@${head.slice(0, 7)}`,
          '',
          "- #13598 failure: 1.38.0 does not advance past main's 1.38.0",
          '',
        ].join('\n'),
      );
      const contentRead = result.calls.find(
        (args) =>
          args[0] === 'api' &&
          args[1] ===
            `repos/QwenLM/qwen-code/contents/${CONTRACT_DOCUMENT}?ref=${HEAD}`,
      );
      expect(contentRead).toBeDefined();
      const post = result.calls.find(
        (args) => args[0] === 'api' && args[2] === 'POST',
      );
      expect(post).toEqual([
        'api',
        '--method',
        'POST',
        `repos/QwenLM/qwen-code/statuses/${HEAD}`,
        '-f',
        'state=failure',
        '-f',
        `context=${STATUS_CONTEXT}`,
        '-f',
        "description=1.38.0 does not advance past main's 1.38.0",
        '-f',
        'target_url=https://github.com/QwenLM/qwen-code/actions/runs/7',
      ]);
    });

    it('retries a failed call, and posts nothing on a dry run', async () => {
      const result = await cli(['--dry-run'], { GH_FAILURES: '1' });
      expect(result.code).toBe(0);
      expect(
        result.calls.filter((args) => args.includes('graphql')),
      ).toHaveLength(2);
      expect(result.calls.every((args) => args[1] !== '--method')).toBe(true);
      expect(result.stdout).toContain('- #13598 failure:');
    });

    it('exits non-zero after three failed attempts', async () => {
      const result = await cli([], { GH_FAILURES: '3' });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'HTTP 502: Bad Gateway ;;error;;forged ##［group]x',
      );
      expect(result.calls).toHaveLength(3);
    });

    it('exits non-zero when a status cannot be set', async () => {
      const result = await cli([], { GH_POST_FAILS: '1' });
      expect(result.code).toBe(1);
      expect(result.summary).toContain(
        '  - could not set the status: HTTP 422: No commit found',
      );
    });

    it('prints usage with arguments or without the repository', async () => {
      expect((await cli(['packages/sdk-java'])).code).toBe(2);
      expect((await cli([], { GITHUB_REPOSITORY: '' })).code).toBe(2);
    });
  },
);
