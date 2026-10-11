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
  mainMigrations,
  run,
} from '../check-flyway-open-prs.js';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-flyway-open-prs.js',
);
const SERVER = 'packages/sdk-java/managed-agent-server';
const BROKER = 'packages/sdk-java/runtime-broker';
const MODULES = [SERVER, BROKER];
const sql = (name, module = SERVER) =>
  `${module}/src/main/resources/db/migration/${name}`;
const java = (name, module = SERVER) =>
  `${module}/src/main/java/db/migration/${name}`;
const MAIN_SHA = 'fbde5cf0'.padEnd(40, '0');

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-flyway-open-prs-'));
  onMain(sql('V1__core.sql'), sql('V53__workspace_roles.sql'));
  mkdirSync(join(root, BROKER), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function onMain(...files) {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
}

// An open PR as the API lists it: every path ADDED unless given as
// [path, changeType]. `current` is the status its last commit carries, and
// `currentOid` that commit when it is not the head.
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

// A fake `gh` serving the PR list two PRs per page and each PR's files two
// per page, so both cursors are exercised, and recording every call.
function fakeGh(prs, { failPost = [], graphqlError } = {}) {
  const calls = [];
  const flags = (args) => {
    const out = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '-f' || args[i] === '-F') {
        const [key, ...value] = args[i + 1].split('=');
        out[key] = { value: value.join('='), typed: args[i] === '-F' };
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
                nodes: prs.slice(start, end).map((p) => ({
                  number: p.number,
                  headRefOid: p.headRefOid,
                  changedFiles: p.changedFiles ?? p.files.length,
                  commits: {
                    nodes: [
                      {
                        commit: {
                          oid: p.currentOid ?? p.headRefOid,
                          status: p.current ? { context: p.current } : null,
                        },
                      },
                    ],
                  },
                  files: filePage(p.files),
                })),
              },
            },
          },
        });
      }
      // GraphQL rejects a string where the query declares Int!.
      expect(f.number.typed).toBe(true);
      const target = prs.find((p) => p.number === Number(f.number.value));
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: { files: filePage(target.files, f.cursor.value) },
          },
        },
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
      .filter((args) => args[1] !== 'graphql')
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
    modules: MODULES,
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

describe('check-flyway-open-prs', () => {
  it('fails a PR whose version main took after its own check passed', async () => {
    const { posts, failed, lines } = await check([
      pr(13325, ['README.md', sql('V53__session_index.sql')]),
    ]);
    expect(failed).toBe(0);
    expect(posts).toEqual([
      {
        path: `repos/QwenLM/qwen-code/statuses/${pr(13325, []).headRefOid}`,
        state: 'failure',
        context: STATUS_CONTEXT,
        description:
          'Version collision when merged into main: V53 = V53__workspace_roles.sql + V53__session_index.sql',
        targetUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/1',
      },
    ]);
    expect(lines[0]).toBe(
      '### Flyway versions of open PRs against main@fbde5cf',
    );
  });

  it('passes a free version and names every other open PR claiming it', async () => {
    const { byPr } = await check([
      pr(13530, [sql('V55__agent_definition.sql')]),
      pr(13545, [java('V55__backfill.java')]),
      pr(13642, [sql('V0055__retention.sql')]),
      pr(13654, [sql('V56__async_verification.sql')]),
    ]);
    expect(byPr[13530]).toMatchObject({
      state: 'success',
      description:
        'No collision with main; also claimed by open PRs: V55 #13545 #13642',
    });
    expect(byPr[13642].description).toContain('V55 #13530 #13545');
    expect(byPr[13654]).toMatchObject({
      state: 'success',
      description: 'No collision with main',
    });
  });

  it('applies Flyway version rules: leading zeros, trailing .0, both suffixes in any case, subdirectories', async () => {
    const { byPr } = await check([
      pr(10001, [sql('V053__zero_padded.sql')]),
      pr(10002, [java('V1_0__trailing_zero.java')]),
      pr(10003, [sql('archive/V53__nested.SQL')]),
      pr(10004, [sql('V53__other_module.sql', BROKER)]),
      pr(10005, [java('V53__upper_case.JAVA')]),
    ]);
    for (const number of [10001, 10002, 10003, 10004, 10005]) {
      expect(byPr[number].state, String(number)).toBe('failure');
    }
    expect(byPr[10002].description).toContain(
      'V1 = V1__core.sql + V1_0__trailing_zero.java',
    );
  });

  it('ignores paths outside the scanned locations, and names that claim no version', async () => {
    const { posts } = await check([
      pr(10001, [
        'packages/sdk-java/managed-agent-server/src/test/resources/db/migration/V53__fixture.sql',
        sql('V53__client.sql', 'packages/sdk-java/client'),
        sql('R__repeatable_view.sql'),
        sql('V53__old.sql').replace('/migration/', '/migration_old/'),
        sql('V53__wrong_suffix.java'),
        java('V53__wrong_suffix.sql'),
        sql('README.md'),
      ]),
    ]);
    expect(posts).toEqual([]);
  });

  it('treats a path main or another PR already adds as the same file, not a collision', async () => {
    // A commit that already landed (cherry-picked) and a stacked PR carrying
    // its parent's migration: each is one file once both land.
    const { byPr, posts } = await check([
      pr(10001, [
        sql('V53__workspace_roles.sql'),
        [sql('V1__core.sql'), 'MODIFIED'],
      ]),
      pr(10002, [sql('V60__parent.sql')]),
      pr(10003, [sql('V60__parent.sql'), sql('V61__child.sql')]),
    ]);
    expect(posts.map((post) => post.path.split('/').pop().slice(0, 5))).toEqual(
      ['10002', '10003'],
    );
    expect(byPr[10002].description).toBe('No collision with main');
    expect(byPr[10003].description).toBe('No collision with main');
  });

  it('frees a version the PR deletes from main, and fails two claims inside one PR', async () => {
    const { byPr } = await check([
      pr(10001, [
        [sql('V53__workspace_roles.sql'), 'DELETED'],
        sql('V53__replacement.sql'),
      ]),
      pr(10002, [
        sql('V70__a.sql'),
        java('V70__b.java'),
        // A main file the PR edits is still one file in the merge result.
        [sql('V53__workspace_roles.sql'), 'MODIFIED'],
        sql('V53__c.sql'),
      ]),
    ]);
    expect(byPr[10001].state).toBe('success');
    expect(byPr[10002]).toMatchObject({
      state: 'failure',
      description:
        'Version collision when merged into main: V70 = V70__a.sql + V70__b.java; V53 = V53__workspace_roles.sql + V53__c.sql',
    });
  });

  it('counts a renamed migration at its new path, and its old path still on main', async () => {
    // The API names only the new path. Renumbering main's V53 to a free
    // version passes; renaming it within V53 over-reports a collision with
    // the old path, which is the safe direction.
    const { byPr } = await check([
      pr(10001, [[sql('V60__workspace_roles.sql'), 'RENAMED']]),
      pr(10002, [[sql('V53__workspace_roles_v2.sql'), 'RENAMED']]),
    ]);
    expect(byPr[10001]).toMatchObject({
      state: 'success',
      description: 'No collision with main',
    });
    expect(byPr[10002].state).toBe('failure');
  });

  it("reads a migration listed past the first page of a PR's files", async () => {
    const { byPr, calls } = await check([
      pr(10001, ['a.md', 'b.md', 'c.md', 'd.md', sql('V53__late.sql')]),
    ]);
    expect(byPr[10001].state).toBe('failure');
    expect(calls.filter((args) => args[1] === 'graphql')).toHaveLength(3);
  });

  it('reports a PR whose file list the API cut short instead of passing it', async () => {
    const { byPr } = await check([
      pr(10001, ['a.md'], { changedFiles: 3001 }),
      pr(10002, [sql('V53__listed.sql')], { changedFiles: 3001 }),
    ]);
    expect(byPr[10001]).toMatchObject({
      state: 'error',
      description:
        'Could not list every changed file, so not checked against main',
    });
    // A collision among the files it did list is already certain.
    expect(byPr[10002].state).toBe('failure');
  });

  it('stops reading file lists after a run-wide page budget and reports the rest as not checked', async () => {
    const huge = Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`);
    const { byPr, calls, lines } = await check([
      pr(10001, [...huge, sql('V53__last.sql')]),
      pr(10002, ['a.md', 'b.md', sql('V54__small.sql')]),
    ]);
    expect(calls.filter((args) => args[1] === 'graphql')).toHaveLength(101);
    expect(lines).toContain(
      'Read 100 extra file pages, the budget; PRs past it are reported as not checked.',
    );
    expect(byPr[10001].state).toBe('error');
    expect(byPr[10002].state).toBe('error');
  });

  it('writes only file-name characters a job log cannot parse as a command', async () => {
    const { byPr, lines } = await check([
      pr(10001, [sql(`V53__${'x'.repeat(150)}.sql`)]),
      pr(10002, [sql('V53__naïve\nname.sql')]),
      pr(10003, [sql('V53__##[add-matcher]x::error::y.sql')]),
    ]);
    expect(byPr[10001].description).toHaveLength(140);
    expect(byPr[10001].description.endsWith('...')).toBe(true);
    expect(byPr[10002].description).toBe(
      'Version collision when merged into main: V53 = V53__workspace_roles.sql + V53__na?ve?name.sql',
    );
    expect(byPr[10003].description).toBe(
      'Version collision when merged into main: V53 = V53__workspace_roles.sql + V53__???add-matcher?x??error??y.sql',
    );
    for (const line of lines) {
      expect(line).not.toMatch(/::|##\[|\n/);
    }
  });

  it('leaves a head alone when its status already says the same', async () => {
    const description = 'No collision with main';
    const { posts, lines } = await check([
      pr(10001, [sql('V54__a.sql')], {
        current: { state: 'SUCCESS', description },
      }),
      pr(10002, [sql('V53__b.sql')], {
        current: { state: 'SUCCESS', description },
      }),
      // Same state, but another open PR now claims its version.
      pr(10003, [sql('V60__c.sql')], {
        current: { state: 'SUCCESS', description },
      }),
      pr(10004, [sql('V60__d.sql')]),
      // A status on a commit that is no longer the head says nothing.
      pr(10005, [sql('V56__e.sql')], {
        current: { state: 'SUCCESS', description },
        currentOid: 'c'.repeat(40),
      }),
      // Its migration landed on main at the same path: clear the failure.
      pr(10006, [sql('V53__workspace_roles.sql')], {
        current: { state: 'FAILURE', description: 'Version collision' },
      }),
    ]);
    expect(lines).toContain(`- #10001 success: ${description} (unchanged)`);
    expect(
      posts.map((post) => [post.path.slice(-40, -35), post.state]),
    ).toEqual([
      ['10002', 'failure'],
      ['10003', 'success'],
      ['10004', 'success'],
      ['10005', 'success'],
      ['10006', 'success'],
    ]);
  });

  it('posts nothing on a dry run but still reports', async () => {
    const { posts, lines } = await check(
      [pr(13325, [sql('V53__session_index.sql')])],
      { dryRun: true },
    );
    expect(posts).toEqual([]);
    expect(lines).toContain(
      '- #13325 failure: Version collision when merged into main: V53 = V53__workspace_roles.sql + V53__session_index.sql',
    );
  });

  it('keeps posting after one status fails, and counts the failure', async () => {
    const first = pr(10001, [sql('V53__a.sql')]);
    const { posts, failed, lines } = await check(
      [first, pr(10002, [sql('V54__b.sql')])],
      { failPost: [first.headRefOid] },
    );
    expect(failed).toBe(1);
    expect(posts.map((post) => post.state)).toEqual(['failure', 'success']);
    expect(lines).toContain(
      '  - could not set the status: HTTP 422: No commit found ;;error;;forged ##［group]x',
    );
  });

  it('posts nothing when the PR list cannot be read', async () => {
    const fake = fakeGh([pr(10001, [sql('V53__a.sql')])], {
      graphqlError: 'timeout',
    });
    await expect(
      run({
        root,
        modules: MODULES,
        repo: 'QwenLM/qwen-code',
        mainSha: MAIN_SHA,
        gh: fake.gh,
      }),
    ).rejects.toThrow('timeout');
    expect(fake.posts()).toEqual([]);
  });

  it('refuses to compare against an empty or missing main tree', () => {
    expect(() => mainMigrations(root, [...MODULES, 'packages/gone'])).toThrow(
      'packages/gone: no such Maven module directory',
    );
    expect(() => mainMigrations(root, [BROKER])).toThrow(
      `found no migration under ${BROKER}`,
    );
    expect(mainMigrations(root, MODULES).sort()).toEqual([
      sql('V1__core.sql'),
      sql('V53__workspace_roles.sql'),
    ]);
  });
});

// The CLI against a `gh` stub on PATH, in a git checkout: argument handling,
// the step summary, the exit status and the retry around a failed call.
describe.skipIf(process.platform === 'win32')(
  'check-flyway-open-prs CLI',
  () => {
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
if (process.argv[3] !== 'graphql') {
  if (process.env.GH_POST_FAILS) { process.stderr.write('HTTP 422: No commit found'); process.exit(1); }
  process.stdout.write('{}');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ data: { repository: { pullRequests: {
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: [{ number: 13654, headRefOid: '${'b'.repeat(40)}', changedFiles: 1,
    commits: { nodes: [{ commit: { oid: '${'b'.repeat(40)}', status: null } }] },
    files: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ path: '${sql('V53__async.sql')}', changeType: 'ADDED' }] } }],
} } } }));
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

    const cli = (args, env = {}) => {
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
      return promisify(execFile)(process.execPath, [script, ...args], {
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
      const result = await cli([`./${SERVER}/`, BROKER]);
      expect(result.code).toBe(0);
      expect(result.summary).toBe(
        [
          `### Flyway versions of open PRs against main@${head.slice(0, 7)}`,
          '',
          '- #13654 failure: Version collision when merged into main: V53 = V53__workspace_roles.sql + V53__async.sql',
          '',
        ].join('\n'),
      );
      const post = result.calls.find(
        (args) => args[0] === 'api' && args[2] === 'POST',
      );
      expect(post).toEqual([
        'api',
        '--method',
        'POST',
        `repos/QwenLM/qwen-code/statuses/${'b'.repeat(40)}`,
        '-f',
        'state=failure',
        '-f',
        `context=${STATUS_CONTEXT}`,
        '-f',
        'description=Version collision when merged into main: V53 = V53__workspace_roles.sql + V53__async.sql',
        '-f',
        'target_url=https://github.com/QwenLM/qwen-code/actions/runs/7',
      ]);
    });

    it('retries a failed call, and posts nothing on a dry run', async () => {
      const result = await cli(['--dry-run', SERVER, BROKER], {
        GH_FAILURES: '1',
      });
      expect(result.code).toBe(0);
      expect(result.calls).toHaveLength(2);
      expect(result.calls.every((args) => args[1] === 'graphql')).toBe(true);
      expect(result.stdout).toContain('- #13654 failure:');
    });

    it('exits non-zero after three failed attempts', async () => {
      const result = await cli([SERVER, BROKER], { GH_FAILURES: '3' });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'HTTP 502: Bad Gateway ;;error;;forged ##［group]x',
      );
      expect(result.calls).toHaveLength(3);
    });

    it('exits non-zero when a status cannot be set', async () => {
      const result = await cli([SERVER, BROKER], { GH_POST_FAILS: '1' });
      expect(result.code).toBe(1);
      expect(result.summary).toContain(
        '  - could not set the status: HTTP 422: No commit found',
      );
    });

    it('prints usage without modules or the repository', async () => {
      expect((await cli([])).code).toBe(2);
      expect((await cli([SERVER], { GITHUB_REPOSITORY: '' })).code).toBe(2);
    });
  },
);
