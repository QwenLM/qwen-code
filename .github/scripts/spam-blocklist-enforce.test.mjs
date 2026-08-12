// Guards for the spam-blocklist-enforce workflow.
//
// Two halves. The first follows the pattern established by
// qwen-triage-workflow.test.mjs: static assertions on the YAML, so that a
// future edit removing the repository guard, widening permissions, un-pinning
// the checkout ref or dropping persist-credentials cannot ship unnoticed.
//
// The second executes the scripts embedded in the workflow the way
// actions/github-script does — an async function over (require, github,
// context, core) — against a fake Octokit. That half exists because this
// workflow's predecessor (auto-minimize-spam) shipped a mutation its token
// could not perform: every run failed with INSUFFICIENT_SCOPES for as long as
// the blocklist was non-empty, and no static assertion would ever have caught
// it. It has already earned its keep once: it caught an early-return that
// swallowed the setFailed when the only attempted action was the one that
// failed, which would have reported a permission failure as a green run.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(
  here,
  '..',
  'workflows',
  'spam-blocklist-enforce.yml',
);
const source = readFileSync(workflowPath, 'utf8');
const doc = parse(source);

// Every static guard below iterates all jobs, so a job added to the workflow
// later is caught by them instead of silently escaping.
const jobs = Object.entries(doc.jobs);
const scriptStepOf = (job) =>
  job.steps.find((step) => step.uses?.startsWith('actions/github-script'));
const checkoutStepOf = (job) =>
  job.steps.find((step) => step.uses?.startsWith('actions/checkout'));

describe('spam-blocklist-enforce: repository guard', () => {
  for (const [name, job] of jobs) {
    it(`gates ${name} on the canonical repository`, () => {
      assert.match(String(job.if), /github\.repository == 'QwenLM\/qwen-code'/);
    });
  }

  it('routes each event to exactly one lane', () => {
    // Both lanes sit under the same `on:`, so an overlap would double-act on
    // one comment and a gap would silently drop an event class. Pin the full
    // expressions — a substring match would still pass a mutation that
    // appends another clause or weakens the repository guard.
    assert.equal(
      doc.jobs.enforce.if,
      "${{ github.repository == 'QwenLM/qwen-code' && github.event_name != 'schedule' && github.event_name != 'workflow_dispatch' }}",
    );
    assert.equal(
      doc.jobs.sweep.if,
      "${{ github.repository == 'QwenLM/qwen-code' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}",
    );
  });
});

describe('spam-blocklist-enforce: permissions', () => {
  it('has a minimal top-level permissions block', () => {
    assert.deepEqual(doc.permissions, {
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
  });

  for (const [name, job] of jobs) {
    it(`does not set job-level permissions on ${name}`, () => {
      assert.equal(
        job.permissions,
        undefined,
        'job-level permissions override the top-level block',
      );
    });
  }
});

describe('spam-blocklist-enforce: credential scoping', () => {
  for (const [name, job] of jobs) {
    it(`disables persist-credentials on the ${name} checkout`, () => {
      const checkout = checkoutStepOf(job);
      assert.ok(checkout, 'checkout step must exist');
      assert.equal(checkout.with['persist-credentials'], false);
    });

    it(`pins the ${name} checkout to the default branch`, () => {
      // pull_request_target runs with a write token. Reading the blocklist
      // from anything but the default branch would let a pull request decide
      // who counts as spam.
      const checkout = checkoutStepOf(job);
      assert.equal(
        checkout.with.ref,
        '${{ github.event.repository.default_branch }}',
      );
      // The ref pin alone is not enough: a `repository:` input pointing at a
      // fork fetches the fork's default branch — almost always named the same
      // as the base's — and the fork owner decides who counts as spam.
      assert.equal(
        checkout.with.repository,
        undefined,
        'checkout must not take a repository input',
      );
      assert.equal(
        checkout.with['sparse-checkout'],
        '.github/spam-blocklist.txt',
      );
    });

    it(`pins the ${name} action versions by full SHA`, () => {
      // The step finders match by action-name prefix, so this is the only
      // guard against a SHA downgraded to a mutable tag — one the upstream
      // owner can repoint, in jobs that run on the write-scope token.
      assert.equal(
        checkoutStepOf(job).uses,
        'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
      );
      assert.equal(
        scriptStepOf(job).uses,
        'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
      );
    });

    it(`scopes the token to the ${name} script step, not job-level env`, () => {
      assert.equal(
        job.env,
        undefined,
        'job-level env would expose the token to every step',
      );
      const step = scriptStepOf(job);
      assert.ok(step, 'github-script step must exist');
      assert.equal(step.with['github-token'], '${{ secrets.GITHUB_TOKEN }}');
    });
  }

  it('never reaches for a PAT', () => {
    // Deletion and review-body minimization both run on GITHUB_TOKEN under
    // the permissions block above. CI_BOT_PAT must not reappear: the
    // predecessor's PAT was scoped to `public_repo` only, which is exactly
    // why its minimizeComment calls failed with INSUFFICIENT_SCOPES.
    assert.doesNotMatch(source, /secrets\.CI_BOT_PAT/);
  });
});

describe('spam-blocklist-enforce: script wiring', () => {
  it('wires the blocklist path into both script steps', () => {
    // The step-level env is the only production connection between the YAML
    // and the scripts' BLOCKLIST_PATH reads. A rename here turns the whole
    // workflow into a silent no-op: readFileSync(undefined) throws, and the
    // catch treats that as a missing blocklist.
    for (const [name, job] of jobs) {
      assert.equal(
        scriptStepOf(job).env.BLOCKLIST_PATH,
        '.github/spam-blocklist.txt',
        `the ${name} step env must point at the checked-in blocklist`,
      );
    }
  });

  it('wires the dispatch hours input into the sweep lookback', () => {
    assert.equal(
      scriptStepOf(doc.jobs.sweep).env.LOOKBACK_HOURS,
      "${{ inputs.hours || '2' }}",
    );
  });
});

describe('spam-blocklist-enforce: event coverage', () => {
  it('listens on the comment, review, and pull request surfaces', () => {
    // Known gap: commit comments are covered by neither lane — there is no
    // commit_comment trigger here and the sweep does not list them. The
    // predecessor did not cover them either; this pins the surfaces the
    // lanes actually handle.
    assert.deepEqual(Object.keys(doc.on).sort(), [
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'pull_request_target',
      'schedule',
      'workflow_dispatch',
    ]);
  });

  it('leaves the issues event to qwen-triage', () => {
    // scripts/tests/issue-triage-ownership-workflow.test.js holds qwen-triage
    // to being the single immediate owner of issue opened/reopened/edited.
    // Adding `issues:` here would break that invariant, and would do it from a
    // test file that gives no hint as to which workflow moved. Spam issues are
    // closed by the sweep lane instead, within the hour.
    assert.equal(doc.on.issues, undefined);
  });

  it('uses pull_request_target so fork PRs are closable', () => {
    // `pull_request` hands a read-only token to fork PRs, which is exactly
    // the case that needs closing.
    assert.equal(doc.on.pull_request, undefined);
    assert.deepEqual(doc.on.pull_request_target.types, ['opened', 'reopened']);
  });

  it('fires on edits and dismissals, not just new content', () => {
    // `edited` reaches spam posted before its author was blocklisted; for
    // review bodies it is the only automated path, since the sweep cannot
    // list reviews. `dismissed` adds the maintainer-initiated path for the
    // same class of pre-blocklist review bodies.
    assert.deepEqual(doc.on.issue_comment.types, ['created', 'edited']);
    assert.deepEqual(doc.on.pull_request_review_comment.types, [
      'created',
      'edited',
    ]);
    assert.deepEqual(doc.on.pull_request_review.types, [
      'submitted',
      'edited',
      'dismissed',
    ]);
  });

  it('keeps an hourly scheduled backstop', () => {
    // The "within the hour" promise depends on this exact cadence; any
    // period longer than the 2h default lookback would make the sweep's
    // blind spot permanent, not merely slower.
    assert.deepEqual(doc.on.schedule, [{ cron: '30 * * * *' }]);
  });
});

// ── Behavioural half ──────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const nodeRequire = createRequire(import.meta.url);

const writeBlocklist = (contents) => {
  const path = join(mkdtempSync(join(tmpdir(), 'blocklist-')), 'list.txt');
  writeFileSync(path, contents);
  return path;
};

const BLOCKLIST = writeBlocklist('# header\n\n  SpamUser  \n#x\nother\n');
const EMPTY_BLOCKLIST = writeBlocklist('# only comments\n\n');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const makeCore = () => {
  const logs = { info: [], warning: [], failed: [], summaryLists: [] };
  const summary = {
    addHeading: () => summary,
    addList: (items) => {
      logs.summaryLists.push([...items]);
      return summary;
    },
    addTable: () => summary,
    write: async () => summary,
  };
  return {
    logs,
    info: (m) => logs.info.push(m),
    warning: (m) => logs.warning.push(m),
    setFailed: (m) => logs.failed.push(m),
    summary,
  };
};

// The fake Octokit records every mutation and returns canned pages for the
// three repo-wide listings the sweep paginates over.
const makeGithub = ({ calls, fail = () => null, pages = {} }) => {
  const record = (name) => async (params) => {
    calls.push({ name, params });
    const error = fail(name, params);
    if (error) throw error;
    return { data: {} };
  };
  return {
    rest: {
      issues: {
        deleteComment: record('issues.deleteComment'),
        update: record('issues.update'),
        lock: record('issues.lock'),
        // github.paginate is handed the endpoint function itself; using the
        // name as a token keeps the fake's dispatch trivial.
        listCommentsForRepo: 'issues.listCommentsForRepo',
        listForRepo: 'issues.listForRepo',
      },
      pulls: {
        deleteReviewComment: record('pulls.deleteReviewComment'),
        update: record('pulls.update'),
        listReviewCommentsForRepo: 'pulls.listReviewCommentsForRepo',
      },
    },
    graphql: async (query, variables) => {
      calls.push({
        name: 'graphql.minimizeComment',
        params: variables,
        query,
      });
      const error = fail('graphql.minimizeComment', variables);
      if (error) throw error;
      return {};
    },
    paginate: async (endpoint, params) => {
      const name = `paginate:${endpoint}`;
      calls.push({ name, params });
      const error = fail(name, params);
      if (error) throw error;
      return pages[endpoint] ?? [];
    },
  };
};

const runLane = async (lane, { eventName, payload, env, github, core }) => {
  const script = scriptStepOf(doc.jobs[lane]).with.script;
  const fn = new AsyncFunction(
    'require',
    'github',
    'context',
    'core',
    'process',
    script,
  );
  await fn(
    nodeRequire,
    github,
    { eventName, payload, repo: { owner: 'QwenLM', repo: 'qwen-code' } },
    core,
    { env: { ...process.env, ...env } },
  );
};

const names = (calls) => calls.map((call) => call.name);
const mutationsOf = (calls) =>
  calls.filter((call) => !call.name.startsWith('paginate:'));
const summaryItems = (core) => core.logs.summaryLists.flat();

const enforce = async (
  eventName,
  payload,
  { blocklist = BLOCKLIST, fail } = {},
) => {
  const calls = [];
  const core = makeCore();
  await runLane('enforce', {
    eventName,
    payload,
    env: { BLOCKLIST_PATH: blocklist },
    github: makeGithub({ calls, fail }),
    core,
  });
  return { calls, core };
};

describe('spam-blocklist-enforce: enforce lane behaviour', () => {
  it('deletes an issue comment from a blocklisted user, case-insensitively', async () => {
    const { calls } = await enforce('issue_comment', {
      comment: { id: 111, user: { login: 'SPAMUSER' } },
      issue: { number: 5, user: { login: 'legit' }, state: 'open' },
    });
    assert.deepEqual(names(calls), ['issues.deleteComment']);
    assert.equal(calls[0].params.comment_id, 111);
  });

  it('leaves a legitimate commenter alone', async () => {
    const { calls, core } = await enforce('issue_comment', {
      comment: { id: 111, user: { login: 'legit' } },
      issue: { number: 5, user: { login: 'legit' }, state: 'open' },
    });
    assert.deepEqual(names(calls), []);
    assert.ok(core.logs.info.some((m) => /No actions taken/.test(m)));
  });

  it('does not close an innocent PR that merely received spam', async () => {
    // The whole reason closing keys on thread authorship: one spam comment
    // must not close an unrelated contributor's pull request.
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: {
        number: 8626,
        user: { login: 'legit' },
        state: 'open',
        pull_request: {},
      },
    });
    assert.deepEqual(names(calls), ['issues.deleteComment']);
  });

  it('closes and locks the thread when the blocklisted user authored it', async () => {
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
    });
    assert.deepEqual(names(calls), [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ]);
    assert.equal(calls[1].params.state, 'closed');
    assert.equal(calls[1].params.state_reason, 'not_planned');
    assert.equal(calls[2].params.lock_reason, 'spam');
  });

  it('closes a blocklisted thread even for a legitimate comment', async () => {
    // Closing keys on the thread author, not the commenter: a clean reply
    // on a spam thread still closes the thread. The reply itself is not
    // deleted — its author is not blocklisted.
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'legit' } },
      issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
    });
    assert.deepEqual(names(calls), ['issues.update', 'issues.lock']);
  });

  it('routes a blocklisted author bumping their own PR through pulls.update', async () => {
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: {
        number: 77,
        user: { login: 'spamuser' },
        state: 'open',
        pull_request: { url: 'x' },
      },
    });
    assert.deepEqual(names(calls), [
      'issues.deleteComment',
      'pulls.update',
      'issues.lock',
    ]);
    assert.equal(calls[1].params.pull_number, 77);
    assert.equal(calls[1].params.state, 'closed');
  });

  it('locks a closed thread whose lock failed before', async () => {
    // The retry half of the lock backstop: a thread an earlier run closed
    // but failed to lock still gets the lock; only the close is skipped.
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: { number: 42, user: { login: 'spamuser' }, state: 'closed' },
    });
    assert.deepEqual(names(calls), ['issues.deleteComment', 'issues.lock']);
  });

  it('leaves an already-locked thread alone', async () => {
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: {
        number: 42,
        user: { login: 'spamuser' },
        state: 'closed',
        locked: true,
      },
    });
    assert.deepEqual(names(calls), ['issues.deleteComment']);
  });

  it('deletes an inline review comment', async () => {
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 3734123582, user: { login: 'spamuser' } },
    });
    assert.deepEqual(names(calls), ['pulls.deleteReviewComment']);
    assert.equal(calls[0].params.comment_id, 3734123582);
  });

  it('leaves a legitimate review comment author alone', async () => {
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'legit' } },
      pull_request: { number: 60, user: { login: 'legit' }, state: 'open' },
    });
    assert.deepEqual(names(calls), []);
  });

  it('closes the PR of a blocklisted author on a legitimate review comment', async () => {
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'legit' } },
      pull_request: {
        number: 60,
        user: { login: 'spamuser' },
        state: 'open',
      },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
    assert.equal(calls[0].params.pull_number, 60);
  });

  it('minimizes a review body, which has no REST delete', async () => {
    const { calls } = await enforce('pull_request_review', {
      review: { id: 7, node_id: 'PRR_abc', user: { login: 'spamuser' } },
    });
    assert.deepEqual(names(calls), ['graphql.minimizeComment']);
    assert.equal(calls[0].params.id, 'PRR_abc');
    assert.match(calls[0].query, /minimizeComment/);
    assert.match(calls[0].query, /classifier: SPAM/);
  });

  it('leaves a legitimate review author alone', async () => {
    const { calls } = await enforce('pull_request_review', {
      review: { id: 6, node_id: 'PRR_ok', user: { login: 'legit' } },
      pull_request: { number: 61, user: { login: 'legit' }, state: 'open' },
    });
    assert.deepEqual(names(calls), []);
  });

  it('closes the PR of a blocklisted author on a legitimate review', async () => {
    const { calls } = await enforce('pull_request_review', {
      review: { id: 6, node_id: 'PRR_ok', user: { login: 'legit' } },
      pull_request: {
        number: 61,
        user: { login: 'spamuser' },
        state: 'open',
      },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
    assert.equal(calls[0].params.pull_number, 61);
  });

  it('ignores an issues event, which this workflow no longer subscribes to', async () => {
    // Pins the current behaviour: the script has no `issues` branch, so an
    // issues event is a no-op and spam issues wait for the sweep lane. The
    // `on:` assertion above is what keeps the trigger out; if someone
    // restores it, that assertion sends them here, to the pinned no-op — not
    // to a script that silently handles issue events some other way.
    const { calls } = await enforce('issues', {
      issue: { number: 100, user: { login: 'other' } },
    });
    assert.deepEqual(names(calls), []);
  });

  it('closes a fork PR through pulls.update but locks through issues.lock', async () => {
    const { calls } = await enforce('pull_request_target', {
      pull_request: { number: 101, user: { login: 'spamuser' } },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
    assert.equal(calls[0].params.pull_number, 101);
    assert.equal(calls[0].params.state, 'closed');
    assert.equal(calls[1].params.issue_number, 101);
  });

  it('leaves a legitimate PR author alone', async () => {
    const { calls } = await enforce('pull_request_target', {
      pull_request: { number: 102, user: { login: 'legit' }, state: 'open' },
    });
    assert.deepEqual(names(calls), []);
  });

  it('treats a 404 as already-done rather than a failure', async () => {
    const { core } = await enforce(
      'issue_comment',
      {
        comment: { id: 111, user: { login: 'spamuser' } },
        issue: { number: 5, user: { login: 'legit' }, state: 'open' },
      },
      { fail: () => new HttpError(404, 'Not Found') },
    );
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.info.some((m) => /already gone/.test(m)));
  });

  it('treats a 422 on issues.lock as already-done', async () => {
    // issues.lock answers 422 when the thread is already locked — a
    // concurrent run won the race, and the desired end state is reached.
    const { core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'spamuser' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.lock' ? new HttpError(422, 'Already locked') : null,
      },
    );
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.info.some((m) => /already gone/.test(m)));
  });

  it('keeps closing the thread after a delete 404s', async () => {
    // A 404 means the comment is already gone — the lane must still close
    // and lock the spammer's thread, not treat the event as all-done.
    const { calls, core } = await enforce(
      'issue_comment',
      {
        comment: { id: 111, user: { login: 'spamuser' } },
        issue: { number: 5, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.deleteComment'
            ? new HttpError(404, 'Not Found')
            : null,
      },
    );
    assert.deepEqual(core.logs.failed, []);
    assert.deepEqual(names(mutationsOf(calls)), [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ]);
  });

  it('fails the run when the only attempted action errors', async () => {
    // The regression this half was written for: with `actions` empty the
    // early return used to fire before setFailed, turning a 403 into a green
    // run — the exact way the predecessor's broken token went unnoticed.
    const { core } = await enforce(
      'issue_comment',
      {
        comment: { id: 111, user: { login: 'spamuser' } },
        issue: { number: 5, user: { login: 'legit' }, state: 'open' },
      },
      { fail: () => new HttpError(403, 'Forbidden') },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /403/);
    assert.ok(summaryItems(core).some((item) => item.startsWith('FAILED — ')));
  });

  it('fails the run when some actions succeed and others do not', async () => {
    const { calls, core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'spamuser' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.lock' ? new HttpError(403, 'Forbidden') : null,
      },
    );
    assert.deepEqual(names(mutationsOf(calls)), [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ]);
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /403/);
    assert.ok(summaryItems(core).some((item) => item.startsWith('FAILED — ')));
  });

  it('is a no-op on an empty blocklist', async () => {
    const { calls, core } = await enforce(
      'issue_comment',
      {
        comment: { id: 1, user: { login: 'spamuser' } },
        issue: { number: 1, user: { login: 'x' }, state: 'open' },
      },
      { blocklist: EMPTY_BLOCKLIST },
    );
    assert.deepEqual(names(calls), []);
    assert.ok(core.logs.info.some((m) => /empty/.test(m)));
  });

  it('is a no-op when the blocklist file is missing', async () => {
    const { calls, core } = await enforce(
      'issue_comment',
      {
        comment: { id: 1, user: { login: 'spamuser' } },
        issue: { number: 1, user: { login: 'x' }, state: 'open' },
      },
      { blocklist: join(tmpdir(), 'no-such-blocklist.txt') },
    );
    assert.deepEqual(names(calls), []);
    assert.ok(core.logs.info.some((m) => /No blocklist/.test(m)));
  });

  it('survives a ghost author on a deleted account', async () => {
    const { calls } = await enforce('issue_comment', {
      comment: { id: 1, user: null },
      issue: { number: 1, user: null, state: 'open' },
    });
    assert.deepEqual(names(calls), []);
  });
});

describe('spam-blocklist-enforce: sweep lane behaviour', () => {
  const sweep = async ({
    issueComments = [],
    reviewComments = [],
    threads = [],
    fail,
    blocklist = BLOCKLIST,
    lookbackHours,
  } = {}) => {
    const calls = [];
    const core = makeCore();
    await runLane('sweep', {
      eventName: 'schedule',
      payload: {},
      env: { BLOCKLIST_PATH: blocklist, LOOKBACK_HOURS: lookbackHours },
      github: makeGithub({
        calls,
        fail,
        pages: {
          'issues.listCommentsForRepo': issueComments,
          'pulls.listReviewCommentsForRepo': reviewComments,
          'issues.listForRepo': threads,
        },
      }),
      core,
    });
    return { calls, core };
  };

  it('deletes blocklisted comments of both kinds and skips the rest', async () => {
    const { calls } = await sweep({
      issueComments: [
        { id: 1, user: { login: 'legit' } },
        { id: 2, user: { login: 'SpamUser' } },
      ],
      reviewComments: [
        { id: 3, user: { login: 'other' } },
        { id: 4, user: { login: 'legit' } },
      ],
    });
    assert.deepEqual(
      mutationsOf(calls).map((call) => [call.name, call.params.comment_id]),
      [
        ['issues.deleteComment', 2],
        ['pulls.deleteReviewComment', 3],
      ],
    );
  });

  it('closes blocklisted-authored threads, routing PRs to pulls.update', () =>
    sweep({
      threads: [
        { number: 10, user: { login: 'legit' }, state: 'open' },
        { number: 11, user: { login: 'spamuser' }, state: 'open' },
        {
          number: 12,
          user: { login: 'other' },
          pull_request: { url: 'x' },
          state: 'open',
        },
      ],
    }).then(({ calls }) => {
      const mutations = mutationsOf(calls);
      assert.deepEqual(names(mutations), [
        'issues.update',
        'issues.lock',
        'pulls.update',
        'issues.lock',
      ]);
      assert.equal(mutations[0].params.issue_number, 11);
      assert.equal(mutations[0].params.state, 'closed');
      assert.equal(mutations[0].params.state_reason, 'not_planned');
      assert.equal(mutations[1].params.lock_reason, 'spam');
      assert.equal(mutations[2].params.pull_number, 12);
      assert.equal(mutations[2].params.state, 'closed');
      assert.equal(mutations[3].params.lock_reason, 'spam');
    }));

  it('skips locked threads and locks closed-but-unlocked ones', async () => {
    // `locked`, not state, is the skip condition: a thread a previous run
    // closed but failed to lock must get its lock on the next sweep.
    const { calls } = await sweep({
      threads: [
        {
          number: 20,
          user: { login: 'spamuser' },
          state: 'closed',
          locked: true,
        },
        { number: 21, user: { login: 'spamuser' }, state: 'closed' },
        { number: 22, user: { login: 'spamuser' }, state: 'open' },
      ],
    });
    const mutations = mutationsOf(calls);
    assert.deepEqual(names(mutations), [
      'issues.lock',
      'issues.update',
      'issues.lock',
    ]);
    assert.equal(mutations[0].params.issue_number, 21);
    assert.equal(mutations[1].params.issue_number, 22);
    assert.equal(mutations[1].params.state, 'closed');
  });

  it('scopes all three listings to the lookback window', async () => {
    // No lookbackHours passed: this also pins the `|| 2` default.
    const { calls } = await sweep({});
    const paginated = calls.filter((call) => call.name.startsWith('paginate:'));
    assert.equal(paginated.length, 3);
    for (const call of paginated) {
      const age = Date.now() - Date.parse(call.params.since);
      assert.ok(
        age > 1.9 * 3600e3 && age < 2.1 * 3600e3,
        `since=${call.params.since} is not ~2h old`,
      );
    }
    assert.equal(
      calls.find((call) => call.name === 'paginate:issues.listForRepo').params
        .state,
      'all',
      "'all', not 'open': closed-but-unlocked threads are what the sweep repairs",
    );
  });

  it('honours a non-default LOOKBACK_HOURS', async () => {
    const { calls } = await sweep({ lookbackHours: '24' });
    const paginated = calls.filter((call) => call.name.startsWith('paginate:'));
    assert.equal(paginated.length, 3);
    for (const call of paginated) {
      const age = Date.now() - Date.parse(call.params.since);
      assert.ok(
        age > 23.9 * 3600e3 && age < 24.1 * 3600e3,
        `since=${call.params.since} is not ~24h old`,
      );
    }
  });

  it('fails the run on a failed mutation and still takes the rest', async () => {
    const { calls, core } = await sweep({
      issueComments: [{ id: 2, user: { login: 'spamuser' } }],
      threads: [{ number: 11, user: { login: 'spamuser' }, state: 'open' }],
      fail: (name) =>
        name === 'issues.deleteComment'
          ? new HttpError(403, 'Forbidden')
          : null,
    });
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /403/);
    assert.deepEqual(names(mutationsOf(calls)), [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ]);
    assert.ok(summaryItems(core).some((item) => item.startsWith('FAILED — ')));
  });

  it('treats a sweep 404 as already-done', async () => {
    const { core } = await sweep({
      issueComments: [{ id: 2, user: { login: 'spamuser' } }],
      fail: (name) =>
        name === 'issues.deleteComment'
          ? new HttpError(404, 'Not Found')
          : null,
    });
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.info.some((m) => /already gone/.test(m)));
  });

  it('treats a sweep 422 on lock as already-done', async () => {
    // A concurrent run locking the thread between listForRepo and
    // issues.lock must not read as a sweep failure.
    const { core } = await sweep({
      threads: [{ number: 11, user: { login: 'spamuser' }, state: 'open' }],
      fail: (name) =>
        name === 'issues.lock' ? new HttpError(422, 'Already locked') : null,
    });
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.info.some((m) => /already gone/.test(m)));
  });

  it('keeps sweeping when a listing fails', async () => {
    // The listings run through run() like everything else: a rate-limit 403
    // on one of them must not abort the lane before a single mutation.
    const { calls, core } = await sweep({
      threads: [{ number: 11, user: { login: 'spamuser' }, state: 'open' }],
      fail: (name) =>
        name === 'paginate:issues.listCommentsForRepo'
          ? new HttpError(403, 'rate limited')
          : null,
    });
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /403/);
    assert.deepEqual(names(mutationsOf(calls)), [
      'issues.update',
      'issues.lock',
    ]);
  });

  it('survives deleted accounts across all three listings', async () => {
    const { calls, core } = await sweep({
      issueComments: [{ id: 1, user: null }],
      reviewComments: [{ id: 2, user: null }],
      threads: [{ number: 3, user: null, state: 'open' }],
    });
    assert.deepEqual(mutationsOf(calls), []);
    assert.deepEqual(core.logs.failed, []);
  });

  it('is a no-op on an empty blocklist', async () => {
    const { calls, core } = await sweep({
      blocklist: EMPTY_BLOCKLIST,
      issueComments: [{ id: 1, user: { login: 'spamuser' } }],
    });
    assert.deepEqual(calls, []);
    assert.ok(core.logs.info.some((m) => /empty/.test(m)));
  });

  it('is a no-op when the blocklist file is missing', async () => {
    const { calls, core } = await sweep({
      blocklist: join(tmpdir(), 'no-such-blocklist.txt'),
    });
    assert.deepEqual(calls, []);
    assert.ok(core.logs.info.some((m) => /No blocklist/.test(m)));
  });
});

describe('spam-blocklist-enforce: blocklist file', () => {
  it('embeds the same parser and isBlocked helper in both lanes', () => {
    // Compare the two definitions, not just their presence: one-sided drift
    // would make the lanes disagree about who is blocklisted.
    const helperOf = (job, name) => {
      const script = scriptStepOf(job).with.script;
      const start = script.indexOf(`const ${name} =`);
      return script.slice(start, script.indexOf(';', start) + 1);
    };
    assert.equal(
      helperOf(doc.jobs.enforce, 'parseBlocklist'),
      helperOf(doc.jobs.sweep, 'parseBlocklist'),
    );
    assert.equal(
      helperOf(doc.jobs.enforce, 'isBlocked'),
      helperOf(doc.jobs.sweep, 'isBlocked'),
    );
  });

  it('checks in a well-formed blocklist', () => {
    const entries = readFileSync(join(here, '..', 'spam-blocklist.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    assert.ok(entries.length > 0, 'blocklist should not be empty');
    for (const entry of entries) {
      assert.equal(
        entry,
        entry.toLowerCase(),
        'entries are matched lowercased',
      );
      // Underscores belong in the charset: legacy GitHub usernames keep
      // them, and the workflow parser matches any name it can read — the
      // validator must not reject entries the lanes would honour.
      assert.match(entry, /^[a-z\d_](?:[a-z\d_]|-(?=[a-z\d])){0,38}$/);
    }
  });
});
