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

describe('spam-blocklist-enforce: step layout', () => {
  for (const [name, job] of jobs) {
    it(`has exactly one checkout and one github-script step in ${name}`, () => {
      // A step inserted between the two would survive the one-per-kind
      // assertions below and could tamper with the checked-out blocklist
      // before the script reads it.
      assert.equal(
        job.steps.length,
        2,
        'an extra step between checkout and script can tamper with the blocklist',
      );
      // Every static guard and the behavioural extraction bind to find()'s
      // first match; a second checkout could shadow the blocklist with
      // fork-controlled content under the write token.
      assert.equal(
        job.steps.filter((s) => s.uses?.startsWith('actions/checkout')).length,
        1,
      );
      assert.equal(
        job.steps.filter((s) => s.uses?.startsWith('actions/github-script'))
          .length,
        1,
      );
    });

    it(`checks out the blocklist before the ${name} script runs`, () => {
      // Reordered, the script reads a file that does not exist yet; the
      // catch treats that as "no blocklist" and the lane silently no-ops.
      assert.ok(
        job.steps.indexOf(checkoutStepOf(job)) <
          job.steps.indexOf(scriptStepOf(job)),
      );
    });
  }
});

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
      assert.equal(
        checkout.with.path,
        undefined,
        'a path input relocates the blocklist away from BLOCKLIST_PATH',
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
      assert.equal(
        doc.env,
        undefined,
        'workflow-level env would expose secrets to every step',
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
    assert.equal(
      doc.on.workflow_dispatch?.inputs?.hours?.type,
      'number',
      'the LOOKBACK_HOURS consumer depends on this declared input',
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

describe('spam-blocklist-enforce: concurrency', () => {
  for (const [name, job] of jobs) {
    it(`never cancels an in-flight ${name} run`, () => {
      // A cancelled run leaves the spam standing until the hourly sweep.
      assert.equal(job.concurrency?.['cancel-in-progress'], false);
    });
  }

  it('keys the enforce group on the event subject', () => {
    // A comment plus its own edit must serialise on one group. Whitespace
    // is normalised because the folded YAML scalar keeps literal newlines
    // inside the ${{ }} expression.
    assert.equal(
      doc.jobs.enforce.concurrency.group.replace(/\s+/g, ' '),
      'spam-blocklist-enforce-${{ github.event.comment.id || github.event.review.id || github.event.issue.number || github.event.pull_request.number || github.run_id }}',
    );
    assert.equal(doc.jobs.sweep.concurrency.group, 'spam-blocklist-sweep');
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
  const logs = {
    info: [],
    warning: [],
    notice: [],
    failed: [],
    summaryLists: [],
  };
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
    notice: (m) => logs.notice.push(m),
    setFailed: (m) => logs.failed.push(m),
    summary,
  };
};

// The fake Octokit records every mutation and returns canned pages for the
// three repo-wide listings the sweep paginates over, plus canned `data`
// replies for the lock-race read-back (issues.get).
const makeGithub = ({ calls, fail = () => null, pages = {}, replies = {} }) => {
  const record = (name) => async (params) => {
    calls.push({ name, params });
    const error = fail(name, params);
    if (error) throw error;
    return { data: replies[name] ?? {} };
  };
  return {
    rest: {
      issues: {
        deleteComment: record('issues.deleteComment'),
        update: record('issues.update'),
        lock: record('issues.lock'),
        get: record('issues.get'),
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
  { blocklist = BLOCKLIST, fail, replies } = {},
) => {
  const calls = [];
  const core = makeCore();
  await runLane('enforce', {
    eventName,
    payload,
    env: { BLOCKLIST_PATH: blocklist },
    github: makeGithub({ calls, fail, replies }),
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
      // Mixed-case thread author: pins case-insensitivity on the close path.
      issue: { number: 42, user: { login: 'SpAmUsEr' }, state: 'open' },
    });
    assert.deepEqual(names(calls), [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ]);
    assert.equal(calls[1].params.issue_number, 42);
    assert.equal(calls[1].params.state, 'closed');
    assert.equal(calls[1].params.state_reason, 'not_planned');
    assert.equal(calls[2].params.issue_number, 42);
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
    assert.equal(calls[0].params.issue_number, 42);
    assert.equal(calls[1].params.issue_number, 42);
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
    assert.equal(calls[2].params.issue_number, 77);
  });

  it('closes a blocklisted PR via pulls.update when the comment is legitimate', async () => {
    // Closing keys on the thread author, and the same-repo head must pass
    // the fork guard: a clean reply on a spammer's PR still closes the PR.
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'legit' } },
      issue: {
        number: 77,
        user: { login: 'spamuser' },
        state: 'open',
        pull_request: { url: 'x' },
      },
      pull_request: {
        number: 77,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
    assert.equal(calls[0].params.pull_number, 77);
    assert.equal(calls[1].params.issue_number, 77);
  });

  it('skips a fork PR issue comment: the read-only token cannot delete it', async () => {
    // Issue comments on fork PRs run on a read-only GITHUB_TOKEN just like
    // review events; the write would 403 and red-run the lane. The sweep
    // lane holds the write token and repairs within the hour.
    const { calls, core } = await enforce('issue_comment', {
      comment: { id: 111, user: { login: 'spamuser' } },
      issue: { number: 5, user: { login: 'legit' }, state: 'open' },
      pull_request: {
        number: 5,
        user: { login: 'legit' },
        state: 'open',
        head: { repo: { full_name: 'forker/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), []);
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.notice.some((m) => /fork PR/.test(m)));
  });

  it('skips a deleted-fork PR issue comment: head.repo is null', async () => {
    // The deleted-fork twin: head.repo: null carries the same read-only
    // downgrade, so the guard must fire exactly as for a live fork.
    const { calls, core } = await enforce('issue_comment', {
      comment: { id: 111, user: { login: 'spamuser' } },
      issue: { number: 5, user: { login: 'spamuser' }, state: 'open' },
      pull_request: {
        number: 5,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: null },
      },
    });
    assert.deepEqual(names(calls), []);
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.notice.some((m) => /fork PR/.test(m)));
  });

  it('locks a closed thread whose lock failed before', async () => {
    // The retry half of the lock backstop: a thread an earlier run closed
    // but failed to lock still gets the lock; only the close is skipped.
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: { number: 42, user: { login: 'spamuser' }, state: 'closed' },
    });
    assert.deepEqual(names(calls), ['issues.deleteComment', 'issues.lock']);
    assert.equal(calls[1].params.issue_number, 42);
  });

  it('leaves a closed and locked thread alone', async () => {
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

  it('closes a locked thread whose close failed before', async () => {
    // The mirror half of the leftover repair: a thread an earlier run
    // locked but failed to close — or one its author reopened after the
    // lock — still gets the close instead of being skipped as locked.
    const { calls } = await enforce('issue_comment', {
      comment: { id: 9, user: { login: 'spamuser' } },
      issue: {
        number: 42,
        user: { login: 'spamuser' },
        state: 'open',
        locked: true,
      },
    });
    assert.deepEqual(names(calls), [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ]);
    assert.equal(calls[1].params.issue_number, 42);
    assert.equal(calls[1].params.state, 'closed');
    assert.equal(calls[2].params.issue_number, 42);
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

  it('does not close a legitimate PR that merely received a blocklisted review comment', async () => {
    // Closing keys on the PR author: a blocklisted reviewer must not close
    // a legitimate contributor's PR — only their comment goes.
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'spamuser' } },
      pull_request: {
        number: 60,
        user: { login: 'legit' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.deleteReviewComment']);
  });

  it('closes the PR of a blocklisted author on a legitimate review comment', async () => {
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'legit' } },
      pull_request: {
        number: 60,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
    assert.equal(calls[0].params.pull_number, 60);
    assert.equal(calls[1].params.issue_number, 60);
  });

  it('deletes the comment and closes the PR when both authors are blocklisted', async () => {
    // Both halves must fire together: an if/else restructuring must not
    // suppress the close when the comment author is the blocklisted one.
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'spamuser' } },
      pull_request: {
        number: 60,
        // Mixed-case PR author: pins case-insensitivity on the close path.
        user: { login: 'SpAmUsEr' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), [
      'pulls.deleteReviewComment',
      'pulls.update',
      'issues.lock',
    ]);
    assert.equal(calls[1].params.pull_number, 60);
    assert.equal(calls[2].params.issue_number, 60);
  });

  it('deletes a blocklisted review comment even on a closed and locked PR', async () => {
    // Content removal is independent of the thread-state skip guard: only
    // the close+lock half is skipped on a finished thread.
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'spamuser' } },
      pull_request: {
        number: 60,
        user: { login: 'spamuser' },
        state: 'closed',
        locked: true,
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.deleteReviewComment']);
  });

  it('closes a locked PR whose close failed before on a review comment event', async () => {
    // The mirror leftover: locked-but-open still gets its close.
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'spamuser' } },
      pull_request: {
        number: 60,
        user: { login: 'spamuser' },
        state: 'open',
        locked: true,
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), [
      'pulls.deleteReviewComment',
      'pulls.update',
      'issues.lock',
    ]);
  });

  it('skips a fork PR review comment: the read-only token cannot delete it', async () => {
    // Review events on fork PRs run on a read-only GITHUB_TOKEN; the write
    // would 403 and red-run the lane. The sweep lane holds the write token
    // and repairs within the hour.
    const { calls, core } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'spamuser' } },
      pull_request: {
        number: 60,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: { full_name: 'forker/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), []);
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.notice.some((m) => /fork PR/.test(m)));
  });

  it('still acts when the review comment head repo is the base repo', async () => {
    // The fork check compares repo names: a present head repo is not a fork
    // by itself.
    const { calls } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'spamuser' } },
      pull_request: {
        number: 60,
        user: { login: 'legit' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.deleteReviewComment']);
  });

  it('skips a deleted-fork PR review comment: head.repo is null', async () => {
    // GitHub represents a deleted fork as head.repo: null. The token is
    // still the fork-downgraded read-only one, so the guard must fire
    // exactly as for a live fork instead of red-running on a 403.
    const { calls, core } = await enforce('pull_request_review_comment', {
      comment: { id: 5, user: { login: 'spamuser' } },
      pull_request: {
        number: 60,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: null },
      },
    });
    assert.deepEqual(names(calls), []);
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.notice.some((m) => /fork PR/.test(m)));
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
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
    assert.equal(calls[0].params.pull_number, 61);
    assert.equal(calls[1].params.issue_number, 61);
  });

  it('minimizes the review and closes the PR when both authors are blocklisted', async () => {
    const { calls } = await enforce('pull_request_review', {
      review: { id: 7, node_id: 'PRR_spam', user: { login: 'spamuser' } },
      pull_request: {
        number: 61,
        // Mixed-case PR author: pins case-insensitivity on the close path.
        user: { login: 'SpAmUsEr' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), [
      'graphql.minimizeComment',
      'pulls.update',
      'issues.lock',
    ]);
    assert.equal(calls[1].params.pull_number, 61);
    assert.equal(calls[2].params.issue_number, 61);
  });

  it('does not close a legitimate PR that merely received a blocklisted review', async () => {
    // The R6-3 twin for this lane: only the review body is minimized, the
    // legitimate author's PR stays open.
    const { calls } = await enforce('pull_request_review', {
      review: { id: 7, node_id: 'PRR_spam', user: { login: 'spamuser' } },
      pull_request: {
        number: 61,
        user: { login: 'legit' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['graphql.minimizeComment']);
  });

  it('minimizes a blocklisted review even on a closed and locked PR', async () => {
    // Content removal is independent of the thread-state skip guard; a
    // later dismissal of this review must still reach the minimize even
    // though the thread is finished.
    const { calls } = await enforce('pull_request_review', {
      review: { id: 7, node_id: 'PRR_abc', user: { login: 'spamuser' } },
      pull_request: {
        number: 61,
        user: { login: 'spamuser' },
        state: 'closed',
        locked: true,
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['graphql.minimizeComment']);
  });

  it('closes a locked PR whose close failed before on a review event', async () => {
    // The mirror leftover: locked-but-open still gets its close.
    const { calls } = await enforce('pull_request_review', {
      review: { id: 6, node_id: 'PRR_ok', user: { login: 'legit' } },
      pull_request: {
        number: 61,
        user: { login: 'spamuser' },
        state: 'open',
        locked: true,
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
  });

  it('skips a fork PR review body: the read-only token cannot minimize it', async () => {
    // No sweep backstop exists for review bodies, so the notice is the
    // whole automated response: the body needs manual minimization.
    const { calls, core } = await enforce('pull_request_review', {
      review: { id: 7, node_id: 'PRR_spam', user: { login: 'spamuser' } },
      pull_request: {
        number: 61,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: { full_name: 'forker/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), []);
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.notice.some((m) => /manual minimization/.test(m)));
  });

  it('skips a deleted-fork PR review body: head.repo is null', async () => {
    // The deleted-fork twin: head.repo: null must fire the guard and leave
    // the manual-minimization notice behind, because no lane can minimize
    // a review body on a read-only token.
    const { calls, core } = await enforce('pull_request_review', {
      review: { id: 7, node_id: 'PRR_spam', user: { login: 'spamuser' } },
      pull_request: {
        number: 61,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: null },
      },
    });
    assert.deepEqual(names(calls), []);
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.notice.some((m) => /manual minimization/.test(m)));
  });

  it('ignores an issues event, which this workflow no longer subscribes to', async () => {
    // Pins the current behaviour: the script has no `issues` branch, so an
    // issues event is a no-op and spam issues wait for the sweep lane. The
    // `on:` assertion above is what keeps the trigger out; if someone
    // restores it, that assertion sends them here, to the pinned no-op — not
    // to a script that silently handles issue events some other way.
    const { calls, core } = await enforce('issues', {
      issue: { number: 100, user: { login: 'other' } },
    });
    assert.deepEqual(names(calls), []);
    assert.deepEqual(core.logs.failed, []);
  });

  it('closes a fork PR through pulls.update but locks through issues.lock', async () => {
    const { calls } = await enforce('pull_request_target', {
      // Mixed-case PR author: pins case-insensitivity on the close path.
      pull_request: { number: 101, user: { login: 'SpAmUsEr' } },
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

  it('treats a lock 422 as already-done once the thread reads back locked', async () => {
    // issues.lock answers 422 when the thread is already locked — a
    // concurrent run won the race — but GitHub also answers 422 for
    // validation and abuse-protection failures, so the lane reads the
    // lock state back before accepting it.
    const { calls, core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'spamuser' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.lock' ? new HttpError(422, 'Already locked') : null,
        replies: { 'issues.get': { locked: true } },
      },
    );
    assert.deepEqual(core.logs.failed, []);
    const readback = calls.find((call) => call.name === 'issues.get');
    assert.equal(readback.params.issue_number, 42);
  });

  it('fails the run when a lock 422 reads back unlocked', async () => {
    // The unverified half of the race: an unlocked readback means the 422
    // was a validation/abuse rejection, not a concurrent lock — the lock
    // never happened and the run must fail.
    const { core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'spamuser' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.lock'
            ? new HttpError(422, 'Validation Failed')
            : null,
        replies: { 'issues.get': { locked: false } },
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /lock .*422/);
  });

  it('fails the run when the lock-race readback itself fails', async () => {
    // Fail closed: if the lock state cannot be read back, the 422 stays
    // unverified and counts as the lock failure it may be.
    const { core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'spamuser' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.lock'
            ? new HttpError(422, 'Already locked')
            : name === 'issues.get'
              ? new HttpError(403, 'rate limited')
              : null,
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /lock .*422/);
  });

  it('fails the run when the issue-comment delete 422s', async () => {
    // A 422 cannot prove the comment is gone — GitHub also uses it for
    // validation and abuse-protection failures — so the run must fail.
    const { core } = await enforce(
      'issue_comment',
      {
        comment: { id: 111, user: { login: 'spamuser' } },
        issue: { number: 5, user: { login: 'legit' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.deleteComment'
            ? new HttpError(422, 'Validation Failed')
            : null,
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /delete issue comment .*422/);
  });

  it('fails the run when the review-comment delete 422s', async () => {
    const { core } = await enforce(
      'pull_request_review_comment',
      {
        comment: { id: 5, user: { login: 'spamuser' } },
        pull_request: {
          number: 60,
          user: { login: 'legit' },
          state: 'open',
          head: { repo: { full_name: 'QwenLM/qwen-code' } },
        },
      },
      {
        fail: (name) =>
          name === 'pulls.deleteReviewComment'
            ? new HttpError(422, 'Validation Failed')
            : null,
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /delete review comment .*422/);
  });

  it('fails the run when the issue close 422s', async () => {
    const { core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'legit' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.update'
            ? new HttpError(422, 'Validation Failed')
            : null,
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /close issue #42: 422/);
  });

  it('fails the run when the PR close 422s', async () => {
    const { core } = await enforce(
      'pull_request_target',
      {
        pull_request: { number: 101, user: { login: 'spamuser' } },
      },
      {
        fail: (name) =>
          name === 'pulls.update'
            ? new HttpError(422, 'Validation Failed')
            : null,
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /close pull request #101: 422/);
  });

  it('fails the run when the review-body minimize 422s', async () => {
    // A review body has no sweep backstop: a failed minimize must red-run
    // so the run failure itself flags the need for manual cleanup.
    const { core } = await enforce(
      'pull_request_review',
      {
        review: { id: 7, node_id: 'PRR_spam', user: { login: 'spamuser' } },
      },
      {
        fail: (name) =>
          name === 'graphql.minimizeComment'
            ? new HttpError(422, 'Validation Failed')
            : null,
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /minimize review 7: 422/);
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

  it('still closes the thread when the delete 403s', async () => {
    // The hard-failure twin: a non-404/422 delete error (a rate-limit 403
    // is realistic — the token's limit is shared with every enforce run of
    // the same hour) collects as a run failure but must not gate the close.
    const { calls, core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'spamuser' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.deleteComment'
            ? new HttpError(403, 'Forbidden')
            : null,
      },
    );
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /403/);
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

  it('still locks the thread when the close fails mid-sequence', async () => {
    // A rate-limit 403 on the close must not skip the lock that follows it;
    // the sweep backstop repairs leftovers, but the lane must attempt them.
    const { calls, core } = await enforce(
      'issue_comment',
      {
        comment: { id: 9, user: { login: 'spamuser' } },
        issue: { number: 42, user: { login: 'spamuser' }, state: 'open' },
      },
      {
        fail: (name) =>
          name === 'issues.update' ? new HttpError(403, 'Forbidden') : null,
      },
    );
    const mutations = mutationsOf(calls);
    assert.deepEqual(names(mutations), [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ]);
    assert.equal(mutations[1].params.issue_number, 42);
    assert.equal(mutations[2].params.issue_number, 42);
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
    assert.deepEqual(core.logs.failed, []);
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
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.info.some((m) => /No blocklist/.test(m)));
  });

  it('survives a ghost author on a deleted account', async () => {
    const issueComment = await enforce('issue_comment', {
      comment: { id: 1, user: null },
      issue: { number: 1, user: null, state: 'open' },
    });
    assert.deepEqual(names(issueComment.calls), []);
    assert.deepEqual(issueComment.core.logs.failed, []);

    const reviewComment = await enforce('pull_request_review_comment', {
      comment: { id: 1, user: null },
      pull_request: { number: 1, user: null, state: 'open' },
    });
    assert.deepEqual(names(reviewComment.calls), []);
    assert.deepEqual(reviewComment.core.logs.failed, []);

    const review = await enforce('pull_request_review', {
      review: { id: 1, node_id: 'PRR_ghost', user: null },
      pull_request: { number: 1, user: null, state: 'open' },
    });
    assert.deepEqual(names(review.calls), []);
    assert.deepEqual(review.core.logs.failed, []);

    const openedPr = await enforce('pull_request_target', {
      pull_request: { number: 1, user: null, state: 'open' },
    });
    assert.deepEqual(names(openedPr.calls), []);
    assert.deepEqual(openedPr.core.logs.failed, []);
  });

  it('still closes a blocklisted PR when the reviewer is a deleted account', async () => {
    // The reviewer check precedes closeThread: a ghost reviewer must not
    // let a blocklisted author's PR escape the close.
    const { calls } = await enforce('pull_request_review', {
      review: { id: 1, node_id: 'PRR_ghost', user: null },
      pull_request: {
        number: 2,
        user: { login: 'spamuser' },
        state: 'open',
        head: { repo: { full_name: 'QwenLM/qwen-code' } },
      },
    });
    assert.deepEqual(names(calls), ['pulls.update', 'issues.lock']);
    assert.equal(calls[0].params.pull_number, 2);
    assert.equal(calls[1].params.issue_number, 2);
  });
});

describe('spam-blocklist-enforce: sweep lane behaviour', () => {
  const sweep = async ({
    issueComments = [],
    reviewComments = [],
    threads = [],
    fail,
    replies,
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
        replies,
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

  it('does not close a legitimate thread that merely received a blocklisted comment', async () => {
    // The sweep's close predicate keys on thread authorship exactly like
    // the event lanes: a blocklisted commenter on a legitimate thread only
    // loses the comment.
    const { calls } = await sweep({
      issueComments: [{ id: 5, user: { login: 'spamuser' } }],
      threads: [{ number: 30, user: { login: 'legit' }, state: 'open' }],
    });
    assert.deepEqual(names(mutationsOf(calls)), ['issues.deleteComment']);
  });

  it('closes blocklisted-authored threads, routing PRs to pulls.update', () =>
    sweep({
      threads: [
        { number: 10, user: { login: 'legit' }, state: 'open' },
        // Mixed-case thread author: pins case-insensitivity on the close
        // path.
        { number: 11, user: { login: 'SpAmUsEr' }, state: 'open' },
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
      assert.equal(mutations[1].params.issue_number, 11);
      assert.equal(mutations[1].params.lock_reason, 'spam');
      assert.equal(mutations[2].params.pull_number, 12);
      assert.equal(mutations[2].params.state, 'closed');
      assert.equal(mutations[3].params.issue_number, 12);
      assert.equal(mutations[3].params.lock_reason, 'spam');
    }));

  it('locks closed-but-unlocked threads and closes locked-but-open ones', async () => {
    // `locked` guards only the lock call, never the close: a thread a
    // previous run closed but failed to lock must get its lock, and the
    // mirror leftover — a close that failed before the lock landed — must
    // still get its close on the next sweep.
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
        {
          number: 23,
          user: { login: 'spamuser' },
          state: 'open',
          locked: true,
        },
      ],
    });
    const mutations = mutationsOf(calls);
    assert.deepEqual(names(mutations), [
      'issues.lock',
      'issues.update',
      'issues.lock',
      'issues.update',
    ]);
    assert.equal(mutations[0].params.issue_number, 21);
    assert.equal(mutations[1].params.issue_number, 22);
    assert.equal(mutations[1].params.state, 'closed');
    assert.equal(mutations[2].params.issue_number, 22);
    assert.equal(mutations[3].params.issue_number, 23);
    assert.equal(mutations[3].params.state, 'closed');
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

  it('treats a sweep lock 422 as already-done once it reads back locked', async () => {
    // A concurrent run locking the thread between listForRepo and
    // issues.lock must not read as a sweep failure — but the lock state
    // is read back first, because 422 also signals validation failures.
    const { calls, core } = await sweep({
      threads: [{ number: 11, user: { login: 'spamuser' }, state: 'open' }],
      fail: (name) =>
        name === 'issues.lock' ? new HttpError(422, 'Already locked') : null,
      replies: { 'issues.get': { locked: true } },
    });
    assert.deepEqual(core.logs.failed, []);
    const readback = calls.find((call) => call.name === 'issues.get');
    assert.equal(readback.params.issue_number, 11);
  });

  it('fails the sweep when a lock 422 reads back unlocked', async () => {
    const { core } = await sweep({
      threads: [{ number: 11, user: { login: 'spamuser' }, state: 'open' }],
      fail: (name) =>
        name === 'issues.lock' ? new HttpError(422, 'Validation Failed') : null,
      replies: { 'issues.get': { locked: false } },
    });
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /lock .*422/);
  });

  it('fails the sweep when a delete 422s', async () => {
    // The sweep twin of the enforce pin: a 422 cannot prove the comment
    // is gone, so it must red-flag the run instead of logging it as
    // already gone.
    const { core } = await sweep({
      issueComments: [{ id: 2, user: { login: 'spamuser' } }],
      fail: (name) =>
        name === 'issues.deleteComment'
          ? new HttpError(422, 'Validation Failed')
          : null,
    });
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /delete issue comment .*422/);
  });

  it('still locks a sweep thread when the close fails mid-sequence', async () => {
    // Mirror of the enforce lane's pin: the close failure collects into the
    // run failure, but the lock must still be attempted — the leftover
    // state the sweep exists to repair.
    const { calls, core } = await sweep({
      threads: [{ number: 11, user: { login: 'spamuser' }, state: 'open' }],
      fail: (name) =>
        name === 'issues.update' ? new HttpError(403, 'Forbidden') : null,
    });
    assert.equal(core.logs.failed.length, 1);
    assert.match(core.logs.failed[0], /403/);
    assert.deepEqual(names(mutationsOf(calls)), [
      'issues.update',
      'issues.lock',
    ]);
  });

  // The listings run through run() like everything else: a rate-limit 403
  // on any one of them must collect as a failure while the rest of the
  // sweep still executes, never aborting the lane before its remaining
  // mutations. Survivors differ per case: whatever the other two listings
  // feed.
  const listingSurvivors = {
    'paginate:issues.listCommentsForRepo': ['issues.update', 'issues.lock'],
    'paginate:pulls.listReviewCommentsForRepo': [
      'issues.deleteComment',
      'issues.update',
      'issues.lock',
    ],
    'paginate:issues.listForRepo': ['issues.deleteComment'],
  };
  for (const [listing, survivors] of Object.entries(listingSurvivors)) {
    it(`keeps sweeping when ${listing.replace('paginate:', '')} fails`, async () => {
      const { calls, core } = await sweep({
        issueComments: [{ id: 2, user: { login: 'spamuser' } }],
        threads: [{ number: 11, user: { login: 'spamuser' }, state: 'open' }],
        fail: (name) =>
          name === listing ? new HttpError(403, 'rate limited') : null,
      });
      assert.equal(core.logs.failed.length, 1);
      assert.match(core.logs.failed[0], /403/);
      assert.deepEqual(names(mutationsOf(calls)), survivors);
      assert.ok(
        summaryItems(core).some((item) => item.startsWith('FAILED — ')),
      );
    });
  }

  // Neither a 404 nor a 422 can prove there was nothing to scan: any
  // non-success listing response fails the run — silently scanning zero
  // items is exactly how blocklisted content stays visible.
  for (const listing of [
    'paginate:issues.listCommentsForRepo',
    'paginate:pulls.listReviewCommentsForRepo',
    'paginate:issues.listForRepo',
  ]) {
    for (const status of [404, 422]) {
      it(`fails the run when ${listing.replace('paginate:', '')} answers ${status}`, async () => {
        const { calls, core } = await sweep({
          issueComments: [{ id: 2, user: { login: 'spamuser' } }],
          fail: (name) =>
            name === listing ? new HttpError(status, 'listing failed') : null,
        });
        assert.equal(core.logs.failed.length, 1);
        assert.match(core.logs.failed[0], new RegExp(String(status)));
        // The remaining listings still run: one failed listing must not
        // abort the sweep before the other two scans.
        const paginated = calls.filter((call) =>
          call.name.startsWith('paginate:'),
        );
        assert.equal(paginated.length, 3);
      });
    }
  }

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
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.info.some((m) => /empty/.test(m)));
  });

  it('is a no-op when the blocklist file is missing', async () => {
    const { calls, core } = await sweep({
      blocklist: join(tmpdir(), 'no-such-blocklist.txt'),
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(core.logs.failed, []);
    assert.ok(core.logs.info.some((m) => /No blocklist/.test(m)));
  });
});

describe('spam-blocklist-enforce: blocklist file', () => {
  it('embeds the same parser and helpers in both lanes', () => {
    // Compare the two definitions, not just their presence: one-sided drift
    // would make the lanes disagree about who is blocklisted, whether a 422
    // lock error was a race, or what a run() call returned.
    const helperOf = (job, name) => {
      const script = scriptStepOf(job).with.script;
      const start = script.indexOf(`const ${name} =`);
      // Slice to the blank line, not the first ';': once a helper gains a
      // multi-statement body, a ';' slice truncates the comparison and
      // hides one-sided drift in any later statement. `-1` (a helper that
      // ends the script) must fall back to the end, not slice backwards.
      const end = script.indexOf('\n\n', start);
      const helper = script.slice(start, end === -1 ? undefined : end);
      assert.ok(
        helper.endsWith(';'),
        `${name} helper looks truncated — the comparison would be one-sided`,
      );
      return helper;
    };
    assert.equal(
      helperOf(doc.jobs.enforce, 'parseBlocklist'),
      helperOf(doc.jobs.sweep, 'parseBlocklist'),
    );
    assert.equal(
      helperOf(doc.jobs.enforce, 'isBlocked'),
      helperOf(doc.jobs.sweep, 'isBlocked'),
    );
    assert.equal(
      helperOf(doc.jobs.enforce, 'run'),
      helperOf(doc.jobs.sweep, 'run'),
    );
    assert.equal(
      helperOf(doc.jobs.enforce, 'isLocked'),
      helperOf(doc.jobs.sweep, 'isLocked'),
    );
  });

  it('checks in a well-formed blocklist', () => {
    const entries = readFileSync(join(here, '..', 'spam-blocklist.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
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
