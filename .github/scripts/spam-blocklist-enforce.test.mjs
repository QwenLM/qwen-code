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

const jobs = ['enforce', 'sweep'].map((name) => [name, doc.jobs[name]]);
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
    // one comment and a gap would silently drop an event class.
    assert.match(
      String(doc.jobs.enforce.if),
      /github\.event_name != 'schedule' && github\.event_name != 'workflow_dispatch'/,
    );
    assert.match(
      String(doc.jobs.sweep.if),
      /github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/,
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
      assert.equal(
        checkout.with['sparse-checkout'],
        '.github/spam-blocklist.txt',
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
    // minimizeComment needs a PAT with the full `repo` scope; REST delete
    // needs nothing beyond the permissions block above. A PAT reappearing
    // here almost certainly means the workflow has gone back to minimizing,
    // and back to failing on an under-scoped token.
    assert.doesNotMatch(source, /secrets\.CI_BOT_PAT/);
  });
});

describe('spam-blocklist-enforce: event coverage', () => {
  it('listens on every surface a blocklisted user can post from', () => {
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

  it('keeps a scheduled backstop', () => {
    assert.ok(Array.isArray(doc.on.schedule) && doc.on.schedule.length > 0);
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
  const logs = { info: [], warning: [], failed: [] };
  const summary = {
    addHeading: () => summary,
    addList: () => summary,
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
    graphql: async (_query, variables) => {
      calls.push({ name: 'graphql.minimizeComment', params: variables });
      const error = fail('graphql.minimizeComment', variables);
      if (error) throw error;
      return {};
    },
    paginate: async (endpoint, params) => {
      calls.push({ name: `paginate:${endpoint}`, params });
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
    assert.ok(core.logs.info.some((m) => /No blocklisted author/.test(m)));
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

  it('does not re-close an already-closed thread', async () => {
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: { number: 42, user: { login: 'spamuser' }, state: 'closed' },
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

  it('minimizes a review body, which has no REST delete', async () => {
    const { calls } = await enforce('pull_request_review', {
      review: { id: 7, node_id: 'PRR_abc', user: { login: 'spamuser' } },
    });
    assert.deepEqual(names(calls), ['graphql.minimizeComment']);
    assert.equal(calls[0].params.id, 'PRR_abc');
  });

  it('ignores an issues event, which this workflow no longer subscribes to', async () => {
    // Belt and braces alongside the `on:` assertion above: if the trigger is
    // ever restored, the script must not silently do nothing.
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
  } = {}) => {
    const calls = [];
    const core = makeCore();
    await runLane('sweep', {
      eventName: 'schedule',
      payload: {},
      env: { BLOCKLIST_PATH: BLOCKLIST, LOOKBACK_HOURS: '2' },
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
        { number: 10, user: { login: 'legit' } },
        { number: 11, user: { login: 'spamuser' } },
        { number: 12, user: { login: 'other' }, pull_request: { url: 'x' } },
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
      assert.equal(mutations[2].params.pull_number, 12);
    }));

  it('scopes all three listings to the lookback window', async () => {
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
      'open',
    );
  });
});

describe('spam-blocklist-enforce: blocklist file', () => {
  it('embeds the same parser in both lanes', () => {
    assert.equal(source.split('const parseBlocklist =').length - 1, 2);
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
      assert.match(entry, /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/);
    }
  });
});
