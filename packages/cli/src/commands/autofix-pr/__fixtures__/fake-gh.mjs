/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// A stand-in for the GitHub CLI, for chain.integration.test.ts. The helpers
// spawn `gh` themselves, so this file is what answers them: it reads the
// world the test describes (FAKE_GH_WORLD, a JSON file), answers one call,
// writes back what a write changed, and logs every call to FAKE_GH_LOG.
//
// The PR's head is read from the bare repository the clone pushes to, so a
// push moves the head GitHub reports, as it does on GitHub. A GraphQL answer
// holds exactly the fields its query selects, so a field a query drops is
// missing as it would be. Anything this file does not know — a command, a
// flag, a path, a jq expression, a `--json` field, a GraphQL field or
// alias, a host other than the world's — fails the call with exit 2 and is
// logged as unsupported, and so does a crash while answering. The test
// checks the log: some helpers take a failed call for "no answer" and go
// on, so the exit code alone would not show it.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import process from 'node:process';

const ACTIONS_APP = 15368;

const worldPath = process.env['FAKE_GH_WORLD'];
const world = JSON.parse(readFileSync(worldPath, 'utf8'));
const args = process.argv.slice(2);
const stdin = args.includes('--input') ? readFileSync(0, 'utf8') : '';
const log = (entry) =>
  appendFileSync(process.env['FAKE_GH_LOG'], `${JSON.stringify(entry)}\n`);
log({ args, ...(stdin ? { stdin } : {}) });

// Written synchronously: a pipe is asynchronous on macOS, and the exit would
// cut the message the helper matches on (`(HTTP 404)`).
function fail(message, code = 1) {
  writeSync(2, `${message}\n`);
  process.exit(code);
}

function unsupported(what) {
  log({ unsupported: what, args });
  fail(`fake gh: unsupported ${what}: gh ${args.join(' ')}`, 2);
}

function print(value) {
  process.stdout.write(
    typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`,
  );
}

function save() {
  writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`);
}

function git(...gitArgs) {
  return execFileSync('git', ['--git-dir', world.bare, ...gitArgs], {
    encoding: 'utf8',
  }).trim();
}

function isAncestor(a, b) {
  try {
    git('merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
}

const slug = `${world.owner}/${world.repo}`;
const repoUrl = `https://${world.host}/${slug}`;
const pr = world.pr;
const prUrl = `${repoUrl}/pull/${pr.number}`;

function headSha() {
  return git('rev-parse', `refs/heads/${pr.headRefName}`);
}

function nextId() {
  world.nextId += 1;
  return world.nextId;
}

// --- checks -----------------------------------------------------------------

// The latest attempt of each job of a run: a re-run appends new jobs to it.
function latestJobs(run) {
  const latest = new Map();
  for (const job of run.jobs) {
    const seen = latest.get(job.name);
    if (!seen || job.id > seen.id) latest.set(job.name, job);
  }
  return [...latest.values()];
}

function runStatus(run) {
  return latestJobs(run).every((job) => job.status === 'COMPLETED')
    ? 'COMPLETED'
    : 'IN_PROGRESS';
}

function runConclusion(run) {
  if (runStatus(run) !== 'COMPLETED') return null;
  return latestJobs(run).some((job) => job.conclusion === 'FAILURE')
    ? 'FAILURE'
    : 'SUCCESS';
}

// A run with no job is one GitHub could not start, which this file does
// not model.
function runsOn(sha) {
  const runs = world.runs.filter((run) => run.sha === sha);
  if (runs.some((run) => run.jobs.length === 0)) {
    unsupported('a run with no job');
  }
  return runs;
}

function contextNodes(sha) {
  return runsOn(sha).flatMap((run) =>
    run.jobs.map((job) => ({
      __typename: 'CheckRun',
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? null,
      detailsUrl: `${repoUrl}/actions/runs/${run.id}/job/${job.id}`,
      databaseId: job.id,
      checkSuite: {
        status: runStatus(run),
        app: { databaseId: ACTIONS_APP },
        workflowRun: {
          event: 'pull_request',
          workflow: { databaseId: run.workflowId },
        },
      },
    })),
  );
}

function rollup(sha) {
  const nodes = contextNodes(sha);
  return nodes.length === 0
    ? null
    : {
        contexts: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      };
}

function suiteNodes(sha) {
  return runsOn(sha).map((run) => ({
    databaseId: run.id + 1_000_000,
    conclusion: runConclusion(run),
    app: { databaseId: ACTIONS_APP },
    workflowRun: {
      databaseId: run.id,
      url: `${repoUrl}/actions/runs/${run.id}`,
      event: 'pull_request',
      workflow: { databaseId: run.workflowId, name: run.workflow },
    },
  }));
}

function findRun(id) {
  return (
    world.runs.find((run) => run.id === Number(id)) ?? unsupported('run id')
  );
}

// --- comments ---------------------------------------------------------------

function commentNode(comment, anchor) {
  return {
    id: comment.id,
    author: { __typename: 'User', login: comment.author },
    authorAssociation: comment.authorAssociation,
    body: comment.body,
    url: `${prUrl}#${anchor}${comment.databaseId}`,
  };
}

function reviewNode(review) {
  return { ...commentNode(review, 'pullrequestreview-'), state: review.state };
}

function threadNode(thread) {
  return {
    id: thread.id,
    isResolved: false,
    isOutdated: false,
    path: thread.path,
    line: thread.line,
    root: { nodes: [{ databaseId: thread.comments[0].databaseId }] },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: thread.comments.map((comment) => ({
        ...commentNode(comment, 'discussion_r'),
        databaseId: comment.databaseId,
        state: 'SUBMITTED',
        replyTo: comment.replyTo ? { id: comment.replyTo } : null,
      })),
    },
  };
}

function addComment(prefix, body) {
  const databaseId = nextId();
  return {
    id: `${prefix}_fake${databaseId}`,
    databaseId,
    author: world.viewer,
    authorAssociation: 'OWNER',
    body,
  };
}

// --- graphql ----------------------------------------------------------------

// A query's selection set: `{ key, alias, fields }` per field (`key` is its
// alias, or its name; `alias` the field and arguments behind an alias, as
// `comments(first:1)`; `fields` null for a leaf), `{ on, fields }` per inline
// fragment. Variable definitions are skipped, and so are the arguments of a
// field without an alias.
function selection(query) {
  const tokens = query.match(/\.\.\.|\$?\w+|[^\s\w]/g) ?? [];
  let at = tokens.indexOf('{');
  // `execFileSync` waits on this process with no timeout: a query this
  // parser cannot follow must fail, not loop.
  const syntax = () => unsupported('GraphQL syntax');
  if (at === -1) syntax();
  const skipArguments = () => {
    const from = at;
    let depth = 0;
    do {
      if (at >= tokens.length) syntax();
      if (tokens[at] === '(') depth += 1;
      else if (tokens[at] === ')') depth -= 1;
      at += 1;
    } while (depth > 0);
    return tokens.slice(from, at).join('');
  };
  const set = () => {
    at += 1;
    const fields = [];
    while (tokens[at] !== '}') {
      if (at >= tokens.length || !/^\w|^\.\.\.$/.test(tokens[at])) syntax();
      if (tokens[at] === '...') {
        if (tokens[at + 1] !== 'on') unsupported('a named fragment');
        const on = tokens[at + 2];
        at += 3;
        if (tokens[at] !== '{') syntax();
        fields.push({ on, fields: set() });
        continue;
      }
      const key = tokens[at];
      const aliased = tokens[at + 1] === ':';
      const name = aliased ? tokens[at + 2] : key;
      at += aliased ? 3 : 1;
      const argsText = tokens[at] === '(' ? skipArguments() : '';
      fields.push({
        key,
        ...(aliased ? { alias: `${name}${argsText}` } : {}),
        fields: tokens[at] === '{' ? set() : null,
      });
    }
    at += 1;
    return fields;
  };
  return set();
}

// The aliases rendered below, by what they stand for: a thread's root is its
// first comment.
const ALIASES = new Map([['root', 'comments(first:1)']]);

// What the query asked for, and nothing else.
function project(value, fields, path) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => project(v, fields, path));
  const out = {};
  for (const field of fields) {
    if (field.on) {
      // The commit `object` carries no __typename here.
      if (value.__typename === undefined || value.__typename === field.on) {
        Object.assign(out, project(value, field.fields, path));
      }
      continue;
    }
    if (!(field.key in value)) unsupported(`GraphQL field ${path}${field.key}`);
    // An alias is answered only as the field and arguments it renders, and
    // a key rendered for an alias only through that alias: GitHub has no
    // `root` field.
    if ((field.alias ?? null) !== (ALIASES.get(field.key) ?? null)) {
      unsupported(
        `GraphQL alias ${path}${field.key}: ${field.alias ?? 'none'}`,
      );
    }
    const v = value[field.key] ?? null;
    // GitHub refuses an object field without a selection, and a selection
    // on a scalar.
    if (v !== null && (typeof v === 'object') !== Boolean(field.fields)) {
      unsupported(`GraphQL selection of ${path}${field.key}`);
    }
    out[field.key] = field.fields
      ? project(v, field.fields, `${path}${field.key}.`)
      : v;
  }
  return out;
}

// `-f` sends a string, `-F` a typed value: GitHub refuses a string for an
// `Int!` variable.
function graphql(fields, typed) {
  const query = fields.query ?? '';
  if (query.includes('$number: Int!') && !typed.has('number')) {
    fail('GraphQL: Variable $number of type Int! was provided invalid value');
  }
  const tree = selection(query);
  const commit = tree
    .find((field) => field.key === 'repository')
    ?.fields?.some((field) => field.key === 'object');
  // Every list the world holds fits on one page, so no paging query is
  // answered either.
  if (!commit && !tree.some((field) => field.key === 'viewer')) {
    unsupported('a query other than the PR query or the commit checks query');
  }
  if (fields.owner !== world.owner || fields.name !== world.repo) {
    unsupported('another repository');
  }
  if (commit) {
    if (fields.after) unsupported('a second page of commit checks');
    const data = {
      repository: { object: { statusCheckRollup: rollup(fields.oid) } },
    };
    return { data: project(data, tree, '') };
  }
  if (Number(fields.number) !== pr.number) unsupported('another PR');
  const head = headSha();
  const data = {
    viewer: { login: world.viewer },
    repository: {
      pullRequest: {
        state: pr.state,
        isDraft: false,
        title: pr.title,
        url: prUrl,
        headRefOid: head,
        mergeable: pr.mergeable,
        author: { login: pr.author },
        commits: {
          nodes: [
            {
              commit: {
                oid: head,
                statusCheckRollup: rollup(head),
                checkSuites: {
                  pageInfo: { hasPreviousPage: false, startCursor: null },
                  nodes: suiteNodes(head),
                },
              },
            },
          ],
        },
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: world.threads.map(threadNode),
        },
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: world.reviews.map(reviewNode),
        },
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: world.comments.map((c) => commentNode(c, 'issuecomment-')),
        },
      },
    },
  };
  return { data: project(data, tree, '') };
}

// --- jq ---------------------------------------------------------------------

// The expressions the helpers pass, and nothing else.
const JQ = {
  '.login': (v) => v.login,
  '.permission': (v) => v.permission,
  '.status': (v) => v.status,
  '.defaultBranchRef.name': (v) => v.defaultBranchRef.name,
  '.jobs[] | select(.status == "completed") | {id, name, conclusion}': (v) => ({
    stream: v.jobs
      .filter((job) => job.status === 'completed')
      .map(({ id, name, conclusion }) => ({ id, name, conclusion })),
  }),
};

function answer(value, jq) {
  if (jq === undefined) return print(value);
  const filter = JQ[jq];
  if (!filter) unsupported(`jq expression ${JSON.stringify(jq)}`);
  const result = filter(value);
  if (result && typeof result === 'object' && 'stream' in result) {
    for (const item of result.stream) print(item);
    return;
  }
  print(result);
}

// --- commands ---------------------------------------------------------------

function pickFields(source, fields) {
  const picked = {};
  for (const field of fields.split(',')) {
    if (!(field in source)) unsupported(`--json field ${field}`);
    picked[field] = source[field];
  }
  return picked;
}

// `gh pr view <n> -R <slug> --json <fields>`
function prView() {
  const [, , number, r, repo, json, fields, ...rest] = args;
  if (r !== '-R' || json !== '--json' || rest.length > 0) {
    unsupported('pr view form');
  }
  if (repo !== slug || Number(number) !== pr.number) unsupported('another PR');
  const view = {
    number: pr.number,
    state: pr.state,
    url: prUrl,
    title: pr.title,
    isDraft: false,
    headRefName: pr.headRefName,
    headRefOid: headSha(),
    baseRefName: pr.baseRefName,
    isCrossRepository: false,
    maintainerCanModify: false,
    headRepository: { name: world.repo },
    headRepositoryOwner: { login: world.owner },
    author: { login: pr.author },
  };
  print(pickFields(view, fields));
}

// `gh repo view <slug> --json <fields> [--jq <expr>]`
function repoView() {
  const [, , repo, json, fields, jqFlag, jq, ...rest] = args;
  if (
    json !== '--json' ||
    (jqFlag !== undefined && jqFlag !== '--jq') ||
    rest.length > 0
  ) {
    unsupported('repo view form');
  }
  if (repo !== slug) unsupported('another repository');
  const view = {
    viewerPermission: 'ADMIN',
    defaultBranchRef: { name: world.defaultBranch },
  };
  answer(pickFields(view, fields), jq);
}

function api() {
  const rest = args.slice(1);
  const fields = {};
  const typed = new Set();
  let method = 'GET';
  let jq;
  let path;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '-f' || arg === '-F') {
      const pair = rest[(i += 1)];
      const eq = pair.indexOf('=');
      fields[pair.slice(0, eq)] = pair.slice(eq + 1);
      if (arg === '-F') typed.add(pair.slice(0, eq));
    } else if (arg === '--method') {
      method = rest[(i += 1)];
    } else if (arg === '--jq') {
      jq = rest[(i += 1)];
    } else if (arg === '--input') {
      if (rest[(i += 1)] !== '-') unsupported('--input from a file');
    } else if (arg === '--paginate' || arg === '--allow-escape-sequences') {
      // One page holds everything; escape sequences pass as they are.
    } else if (arg.startsWith('-')) {
      unsupported(`flag ${arg}`);
    } else if (path === undefined) {
      path = arg;
    } else {
      unsupported('a second path');
    }
  }
  if (path === 'graphql') return print(graphql(fields, typed));
  if (path === 'user') return answer({ login: world.viewer }, jq);

  const base = `repos/${slug}/`;
  if (!path?.startsWith(base)) unsupported('path');
  const route = path.slice(base.length);
  let m;
  if (method === 'POST') {
    const body = JSON.parse(stdin).body;
    // `loseNextAnswer`: the POST reaches GitHub and its answer is lost on
    // the way back.
    const answered = (response) => {
      const lost = world.loseNextAnswer;
      world.loseNextAnswer = false;
      save();
      if (lost) fail('gh: HTTP 502: Bad Gateway');
      print(response);
    };
    if ((m = /^issues\/(\d+)\/comments$/.exec(route))) {
      if (Number(m[1]) !== pr.number) unsupported('another PR');
      const comment = addComment('IC', body);
      world.comments.push(comment);
      return answered({
        id: comment.databaseId,
        node_id: comment.id,
        html_url: `${prUrl}#issuecomment-${comment.databaseId}`,
      });
    }
    if ((m = /^pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(route))) {
      const thread = world.threads.find(
        (t) => t.comments[0].databaseId === Number(m[2]),
      );
      if (Number(m[1]) !== pr.number || !thread) unsupported('another thread');
      const comment = {
        ...addComment('PRRC', body),
        replyTo: thread.comments[0].id,
      };
      thread.comments.push(comment);
      return answered({
        id: comment.databaseId,
        node_id: comment.id,
        html_url: `${prUrl}#discussion_r${comment.databaseId}`,
      });
    }
    unsupported('POST');
  }
  if (method !== 'GET') unsupported(`method ${method}`);
  // `gh api` sends fields as a POST unless told otherwise.
  if (Object.keys(fields).length > 0) unsupported('fields on a GET');
  if ((m = /^collaborators\/([^/]+)\/permission$/.exec(route))) {
    const permission = world.permissions[decodeURIComponent(m[1])];
    if (!permission) fail('gh: Not Found (HTTP 404)');
    return answer({ permission }, jq);
  }
  if ((m = /^compare\/(.+)\.\.\.([0-9a-f]{40})$/.exec(route))) {
    const baseSha = git('rev-parse', `refs/heads/${m[1]}`);
    const sha = m[2];
    const status =
      baseSha === sha
        ? 'identical'
        : isAncestor(baseSha, sha)
          ? 'ahead'
          : isAncestor(sha, baseSha)
            ? 'behind'
            : 'diverged';
    return answer({ status }, jq);
  }
  if ((m = /^actions\/runs\/(\d+)\/jobs(?:\?per_page=\d+)?$/.exec(route))) {
    const jobs = latestJobs(findRun(m[1])).map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status.toLowerCase(),
      conclusion: job.conclusion?.toLowerCase() ?? null,
    }));
    return answer({ jobs }, jq);
  }
  if ((m = /^actions\/jobs\/(\d+)\/logs$/.exec(route))) {
    const job =
      world.runs
        .flatMap((run) => run.jobs)
        .find((j) => j.id === Number(m[1])) ?? unsupported('job id');
    return process.stdout.write(job.log ?? '');
  }
  unsupported('path');
}

// `gh run rerun <id> --failed -R <slug>`: a new attempt of each failed job,
// queued.
function runRerun() {
  const [, , id, failed, r, repo, ...rest] = args;
  if (failed !== '--failed' || r !== '-R' || rest.length > 0) {
    unsupported('run rerun form');
  }
  if (repo !== slug) unsupported('another repository');
  const run = findRun(id);
  if (runStatus(run) !== 'COMPLETED') {
    fail(`run ${run.id} cannot be rerun; This workflow is already running`);
  }
  for (const job of latestJobs(run)) {
    if (job.conclusion !== 'FAILURE') continue;
    run.jobs.push({ id: nextId(), name: job.name, status: 'QUEUED' });
  }
  save();
}

// Every call goes to the host the watch was prepared for: one that drops it
// goes to gh's default host instead.
if (process.env['GH_HOST'] !== world.host) {
  unsupported(`GH_HOST ${process.env['GH_HOST']}`);
}
try {
  const command = args.slice(0, 2).join(' ');
  if (command === 'auth status' && args.length === 2) process.exit(0);
  else if (command === 'pr view') prView();
  else if (command === 'repo view') repoView();
  else if (command === 'run rerun') runRerun();
  else if (args[0] === 'api') api();
  else unsupported('command');
} catch (err) {
  unsupported(`crash: ${err instanceof Error ? err.message : String(err)}`);
}
