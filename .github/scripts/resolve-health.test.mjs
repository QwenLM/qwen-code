// Pins the /resolve health watch: how a result comment is classified, how a
// streak and an unanswered request are counted, and exactly which writes the
// watch makes against the open issue — none when nothing changed, one comment
// when the picture moved, a recovery comment plus close once the lane works.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import {
  DEFAULTS,
  HEALTH_MARKER,
  RESULT_MARKER,
  apply,
  assess,
  classifyResult,
  decide,
  isRequest,
  main,
  readState,
} from './resolve-health.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = parse(
  readFileSync(
    join(here, '..', 'workflows', 'qwen-resolve-health.yml'),
    'utf8',
  ),
);
const ci = readFileSync(join(here, '..', 'workflows', 'ci.yml'), 'utf8');
const producer = readFileSync(
  join(here, '..', 'workflows', 'qwen-code-pr-review.yml'),
  'utf8',
);

const BOT = 'qwen-code-dev-bot';
let nextId = 1000;
function comment(user, created_at, body, pr = 1) {
  const id = (nextId += 1);
  return {
    id,
    user,
    created_at,
    body,
    html_url: `https://github.com/QwenLM/qwen-code/pull/${pr}#issuecomment-${id}`,
  };
}
const request = (at, pr, user = 'maintainer') =>
  comment(user, at, '@qwen-code /resolve', pr);
const result = (at, sentence, pr) =>
  comment(BOT, at, `${RESULT_MARKER}\n${sentence}\n\nDetails.`, pr);

const PUSHED =
  'Qwen Code resolved the merge conflicts and pushed the branch update.';
const AGENT_FAILED =
  'Qwen Code attempted to resolve merge conflicts but the run did not complete successfully.';
const INFRA_FAILED =
  'Qwen Code could not run conflict resolution on this PR: the agent step ended with `outcome=cancelled` before producing a result.';
const SKIPPED = 'Qwen Code did not run conflict resolution for this request.';
const MOVED =
  'Qwen Code resolved the merge conflicts, but the head branch changed while resolving, so the update was not pushed.';
const PERMISSION =
  'Qwen Code resolved the merge conflicts, but could not push to `owner/repo`. For a fork PR this needs **Allow edits by maintainers** enabled.';
const WORKFLOW_SCOPE =
  'Qwen Code resolved the merge conflicts, but could not push to `owner/repo`: resolving merges the base branch in, which includes its `.github/workflows/**` changes.';
const OTHER_PUSH =
  'Qwen Code resolved the merge conflicts, but pushing to `owner/repo` failed.';
const NOOP = 'Qwen Code checked this PR and did not push changes.';
const UNKNOWN = 'Qwen Code did something this script has never heard of.';

describe('resolve-health: classification', () => {
  it('recognises every sentence the workflow emits', () => {
    const kind = (s) => classifyResult(`${RESULT_MARKER}\n${s}`);
    assert.equal(kind(PUSHED), 'pushed');
    assert.equal(kind(AGENT_FAILED), 'agent_failed');
    assert.equal(kind(INFRA_FAILED), 'infra_failed');
    assert.equal(kind(SKIPPED), 'skipped');
    assert.equal(kind(NOOP), 'noop');
    assert.equal(
      kind('Qwen Code resolved the merge conflicts in dry-run mode.'),
      'dry_run',
    );
    // Of the four "resolved, but" sentences only the moved head is benign
    // (a retry helps); the other three mean the push itself is broken and a
    // retry repeats them, so they are failures.
    assert.equal(kind(MOVED), 'resolved_moved');
    assert.equal(kind(PERMISSION), 'push_failed');
    assert.equal(kind(WORKFLOW_SCOPE), 'push_failed');
    assert.equal(kind(OTHER_PUSH), 'push_failed');
    // A comment without the marker is not a result, whatever it says.
    assert.equal(classifyResult(PUSHED), null);
    // Drift is loud, not silent: an unrecognised sentence is a failure.
    assert.equal(kind(UNKNOWN), 'unknown');
  });

  it('classifies every result sentence the producer workflow actually emits', () => {
    // Read the sentences from `resolve-pr`'s report steps rather than from
    // hand-copied constants, so a wording change in the workflow fails here
    // instead of turning into `unknown` at runtime. The echoes escape
    // backticks (\`) inside double quotes; unescape them so each sentence
    // is seen whole, not cut at the first backslash (which would collapse
    // the four "resolved, but" sentences into one prefix).
    const start = producer.indexOf('\n  resolve-pr:');
    const rest = producer.slice(start + 1);
    const next = rest.search(/\n {2}[A-Za-z]/);
    const job = next === -1 ? rest : rest.slice(0, next);
    const sentences = [...job.matchAll(/echo "((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1].replace(/\\(.)/g, '$1'))
      .filter((s) => s.startsWith('Qwen Code '));
    assert.ok(
      sentences.length >= 8,
      `expected the report sentences, found ${sentences.length}`,
    );
    const kinds = new Map();
    for (const sentence of sentences) {
      const kind = classifyResult(`${RESULT_MARKER}\n${sentence}`);
      assert.ok(
        kind && kind !== 'unknown',
        `producer sentence is not classified: ${sentence}`,
      );
      kinds.set(sentence, kind);
    }
    // The four "resolved, but" producers land on the two sides they belong to.
    for (const [sentence, kind] of kinds) {
      if (sentence.includes('head branch changed while resolving')) {
        assert.equal(kind, 'resolved_moved', sentence);
      } else if (
        sentence.includes('could not push') ||
        sentence.includes('but pushing to')
      ) {
        assert.equal(kind, 'push_failed', sentence);
      }
    }
    assert.ok([...kinds.values()].includes('resolved_moved'));
    assert.ok(
      [...kinds.values()].filter((k) => k === 'push_failed').length >= 3,
    );
    // And the constants this file uses are real producer sentences.
    for (const sentence of [PUSHED, AGENT_FAILED, SKIPPED, NOOP]) {
      assert.ok(
        producer.includes(sentence),
        `stale test constant: ${sentence}`,
      );
    }
  });

  it('matches requests the way the workflow trigger does', () => {
    assert.ok(isRequest('@qwen-code /resolve'));
    assert.ok(isRequest('@qwen-code /resolve\nplease'));
    assert.ok(isRequest('@qwen-code /resolve\r\n'));
    assert.ok(isRequest('@qwen-code /resolve now'));
    assert.ok(!isRequest(' @qwen-code /resolve'));
    assert.ok(!isRequest('> @qwen-code /resolve'));
    assert.ok(!isRequest('@qwen-code /resolved'));
  });
});

describe('resolve-health: assessment', () => {
  const now = new Date('2026-08-27T12:00:00Z');

  it('counts the trailing failure streak across PRs and ignores skips', () => {
    const prs = [
      {
        number: 1,
        comments: [
          result('2026-08-20T00:00:00Z', PUSHED, 1),
          result('2026-08-21T00:00:00Z', AGENT_FAILED, 1),
          result('2026-08-23T00:00:00Z', SKIPPED, 1),
        ],
      },
      {
        number: 2,
        comments: [
          result('2026-08-22T00:00:00Z', INFRA_FAILED, 2),
          result('2026-08-24T00:00:00Z', INFRA_FAILED, 2),
        ],
      },
    ];
    const a = assess(prs, { now, threshold: 3 });
    assert.equal(a.streak, 3);
    assert.equal(a.infraInStreak, 2);
    assert.deepEqual(
      a.streakItems.map((r) => r.pr),
      [1, 2, 2],
    );
    assert.equal(a.alarm, true);
    // A moved-head resolution is a success: it resets the streak.
    prs[1].comments.push(result('2026-08-25T00:00:00Z', MOVED, 2));
    assert.equal(assess(prs, { now, threshold: 3 }).streak, 0);
    // A broken push and an unrecognised sentence both extend it.
    prs[1].comments.push(result('2026-08-25T01:00:00Z', PERMISSION, 2));
    prs[1].comments.push(result('2026-08-25T02:00:00Z', UNKNOWN, 2));
    const b = assess(prs, { now, threshold: 3 });
    assert.equal(b.streak, 2);
    assert.deepEqual(
      b.streakItems.map((r) => r.kind),
      ['push_failed', 'unknown'],
    );
  });

  it('does not depend on the order PRs or comments arrive in', () => {
    // `fetchPrs` returns search order (best match), not chronology; the
    // streak must come from timestamps alone.
    const chronological = [
      {
        number: 1,
        comments: [
          result('2026-08-20T00:00:00Z', PUSHED, 1),
          result('2026-08-24T00:00:00Z', AGENT_FAILED, 1),
        ],
      },
      {
        number: 2,
        comments: [
          result('2026-08-22T00:00:00Z', AGENT_FAILED, 2),
          result('2026-08-23T00:00:00Z', PUSHED, 2),
        ],
      },
      {
        number: 3,
        comments: [result('2026-08-25T00:00:00Z', INFRA_FAILED, 3)],
      },
    ];
    const shuffled = [chronological[2], chronological[0], chronological[1]].map(
      (pr) => ({
        ...pr,
        comments: [...pr.comments].reverse(),
      }),
    );
    const a = assess(chronological, { now });
    const b = assess(shuffled, { now });
    assert.equal(a.streak, 2);
    assert.equal(b.streak, 2);
    assert.deepEqual(
      b.attempts.map((r) => r.at),
      a.attempts.map((r) => r.at),
    );
  });

  it('alarms at the default threshold and not one below it', () => {
    const failures = (n) => [
      {
        number: 5,
        comments: Array.from({ length: n }, (_, i) =>
          result(`2026-08-2${i + 1}T00:00:00Z`, AGENT_FAILED, 5),
        ),
      },
    ];
    assert.equal(assess(failures(4), { now }).alarm, false);
    assert.equal(assess(failures(5), { now }).alarm, true);
  });

  it('ignores events older than the window, whatever PR carries them', () => {
    // The search window bounds PR discovery only; a PR touched yesterday can
    // carry a request or a failure from a month ago, which must neither
    // count as unanswered nor sit in the streak.
    const prs = [
      {
        number: 9,
        comments: [
          request('2026-07-01T00:00:00Z', 9),
          result('2026-07-02T00:00:00Z', AGENT_FAILED, 9),
          result('2026-08-26T00:00:00Z', PUSHED, 9),
        ],
      },
    ];
    const a = assess(prs, { now, unansweredThreshold: 1 });
    assert.equal(a.unanswered.length, 0);
    assert.deepEqual(
      a.attempts.map((r) => r.kind),
      ['pushed'],
    );
    assert.equal(a.windowStart.slice(0, 10), '2026-08-20');
  });

  it('flags a request with no result once it is older than the stale window', () => {
    const prs = [
      {
        number: 7,
        comments: [
          request('2026-08-27T00:00:00Z', 7),
          result('2026-08-27T00:10:00Z', PUSHED, 7),
          request('2026-08-27T02:00:00Z', 7),
          // Too young to count.
          request('2026-08-27T11:30:00Z', 7),
        ],
      },
      {
        number: 8,
        comments: [
          // The bot quoting the command is not a request.
          comment(BOT, '2026-08-26T00:00:00Z', '@qwen-code /resolve', 8),
        ],
      },
    ];
    const a = assess(prs, { now, staleHours: 3, unansweredThreshold: 1 });
    assert.deepEqual(
      a.unanswered.map((u) => u.at),
      ['2026-08-27T02:00:00Z'],
    );
    assert.equal(a.alarm, true);
    assert.equal(assess(prs, { now, staleHours: 3 }).alarm, false);
  });

  it('treats any later result as the answer, so a retry cannot orphan the first request', () => {
    // Two requests typed before the first run reports, then one result:
    // both are answered. Runs on a PR are serialised by the workflow, so a
    // later result implies the earlier run finished.
    const prs = [
      {
        number: 10,
        comments: [
          request('2026-08-27T00:00:00Z', 10),
          request('2026-08-27T00:05:00Z', 10),
          result('2026-08-27T00:20:00Z', AGENT_FAILED, 10),
        ],
      },
    ];
    const a = assess(prs, { now, staleHours: 3, unansweredThreshold: 1 });
    assert.equal(a.unanswered.length, 0);
    assert.equal(a.alarm, false);
  });
});

describe('resolve-health: decisions', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const failing = assess(
    [
      {
        number: 3,
        comments: [1, 2, 3, 4, 5].map((d) =>
          result(
            `2026-08-2${d}T00:00:00Z`,
            d < 4 ? INFRA_FAILED : AGENT_FAILED,
            3,
          ),
        ),
      },
    ],
    { now },
  );
  const healthy = assess(
    [{ number: 3, comments: [result('2026-08-26T00:00:00Z', PUSHED, 3)] }],
    { now },
  );

  it('opens one issue carrying the marker, the state, and the last attempts', () => {
    const actions = decide(failing, null);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'create');
    assert.match(actions[0].title, /5 consecutive failures/);
    assert.ok(actions[0].body.includes(HEALTH_MARKER));
    assert.deepEqual(readState([actions[0].body]), {
      streak: 5,
      unanswered: 0,
      latest: failing.latestAttempt.id,
    });
    assert.ok(
      actions[0].body.includes('| 2026-08-25 00:00Z | #3 | ❌ agent_failed |'),
    );
    assert.ok(actions[0].body.includes('3 never reached the agent'));
  });

  it('opens an issue on unanswered requests alone and lists them', () => {
    const stale = assess(
      [
        {
          number: 12,
          comments: [1, 2, 3].map((h) =>
            request(`2026-08-27T0${h}:00:00Z`, 12, `writer${h}`),
          ),
        },
      ],
      { now },
    );
    assert.equal(stale.streak, 0);
    assert.equal(stale.unanswered.length, 3);
    const actions = decide(stale, null);
    assert.equal(actions.length, 1);
    assert.match(actions[0].title, /0 consecutive failures, 3 unanswered/);
    assert.ok(actions[0].body.includes('Requests with no result comment:'));
    assert.ok(actions[0].body.includes('#12 by @writer2'));
    assert.deepEqual(readState([actions[0].body]), {
      streak: 0,
      unanswered: 3,
      latest: null,
    });
  });

  it('writes nothing while the picture is unchanged, one comment when it moves', () => {
    const created = decide(failing, null)[0];
    const existing = { number: 42, texts: [created.body] };
    assert.deepEqual(decide(failing, existing), []);
    const grown = assess(
      [
        {
          number: 3,
          comments: [
            ...[1, 2, 3, 4, 5].map((d) =>
              result(`2026-08-2${d}T00:00:00Z`, INFRA_FAILED, 3),
            ),
            result('2026-08-26T00:00:00Z', UNKNOWN, 3),
          ],
        },
      ],
      { now },
    );
    const actions = decide(grown, existing);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'comment');
    assert.equal(actions[0].number, 42);
    assert.equal(readState([...existing.texts, actions[0].body]).streak, 6);
    // The drifted sentence is visible in the update as what it is.
    assert.ok(actions[0].body.includes('❌ unknown'));
  });

  it('comments the recovery and closes the issue once an attempt succeeds', () => {
    const existing = { number: 42, texts: [decide(failing, null)[0].body] };
    const actions = decide(healthy, existing);
    assert.deepEqual(
      actions.map((a) => a.type),
      ['comment', 'close'],
    );
    assert.match(
      actions[0].body,
      /Recovered: the latest attempt .* is `pushed`/,
    );
    // Idempotent: the same success seen again does not re-close.
    const after = { number: 42, texts: [...existing.texts, actions[0].body] };
    assert.deepEqual(decide(healthy, after), []);
  });

  it('does not treat loss of evidence as recovery', () => {
    // An open unanswered-driven issue whose requests fell out of the
    // discovery window, or a streak that merely dropped below the threshold
    // with no success: alarm is false, but nothing has been shown to work.
    const stale = assess(
      [
        {
          number: 12,
          comments: [1, 2, 3].map((h) =>
            request(`2026-08-27T0${h}:00:00Z`, 12),
          ),
        },
      ],
      { now },
    );
    const existing = { number: 42, texts: [decide(stale, null)[0].body] };
    assert.deepEqual(decide(assess([], { now }), existing), []);
    const belowThreshold = assess(
      [
        {
          number: 3,
          comments: [
            result('2026-08-26T00:00:00Z', AGENT_FAILED, 3),
            result('2026-08-26T01:00:00Z', PERMISSION, 3),
          ],
        },
      ],
      { now },
    );
    assert.equal(belowThreshold.alarm, false);
    assert.deepEqual(decide(belowThreshold, existing), []);
    // A success after the issue was filed is what closes it.
    assert.deepEqual(
      decide(healthy, existing).map((a) => a.type),
      ['comment', 'close'],
    );
  });

  it('does nothing when healthy and no issue is open', () => {
    assert.deepEqual(decide(healthy, null), []);
  });
});

describe('resolve-health: writes', () => {
  it('creates with the dedup label, comments, and closes through the issues API', () => {
    const calls = [];
    const gh = (args, input) => {
      calls.push({ args, input: input ? JSON.parse(input) : null });
      return '{}';
    };
    apply(
      gh,
      'QwenLM/qwen-code',
      [
        { type: 'create', title: 'T', body: 'B' },
        { type: 'comment', number: 7, body: 'C' },
        { type: 'close', number: 7 },
      ],
      'scope/ci-cd',
    );
    assert.deepEqual(
      calls.map((c) => [c.args[2], c.args[3]]),
      [
        ['POST', 'repos/QwenLM/qwen-code/issues'],
        ['POST', 'repos/QwenLM/qwen-code/issues/7/comments'],
        ['PATCH', 'repos/QwenLM/qwen-code/issues/7'],
      ],
    );
    assert.deepEqual(calls[0].input, {
      title: 'T',
      body: 'B',
      labels: ['scope/ci-cd'],
    });
    assert.deepEqual(calls[1].input, { body: 'C' });
    assert.deepEqual(calls[2].input, {
      state: 'closed',
      state_reason: 'completed',
    });
  });
});

describe('resolve-health: end to end against a recording gh', () => {
  const b64 = (s) => Buffer.from(s).toString('base64');
  function recordingGh(calls) {
    return (args, input) => {
      calls.push({ args, input });
      const path = args[3];
      if (path === 'search/issues') {
        assert.match(
          args[5],
          /^q=repo:QwenLM\/qwen-code is:pr "@qwen-code \/resolve" in:comments updated:>=2026-08-20$/,
        );
        return '11\n12\n';
      }
      if (path === 'repos/QwenLM/qwen-code/issues/11/comments') {
        assert.ok(args.includes('--paginate') && args.includes('per_page=100'));
        return [
          [
            '1',
            'maintainer',
            '2026-08-25T00:00:00Z',
            'u1',
            b64('@qwen-code /resolve'),
          ].join('\t'),
          [
            '2',
            BOT,
            '2026-08-25T00:05:00Z',
            'u2',
            b64(`${RESULT_MARKER}\n${INFRA_FAILED}`),
          ].join('\t'),
          [
            '3',
            'maintainer',
            '2026-08-26T00:00:00Z',
            'u3',
            b64('@qwen-code /resolve'),
          ].join('\t'),
          [
            '4',
            BOT,
            '2026-08-26T00:05:00Z',
            'u4',
            b64(`${RESULT_MARKER}\n${INFRA_FAILED}`),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (path === 'repos/QwenLM/qwen-code/issues/12/comments') {
        return [
          [
            '5',
            BOT,
            '2026-08-26T01:00:00Z',
            'u5',
            b64(`${RESULT_MARKER}\n${AGENT_FAILED}`),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (path === 'repos/QwenLM/qwen-code/issues' && args[2] === 'GET') {
        // Only OPEN issues carrying the dedup label are candidates; without
        // `state=open` a closed, older tracking issue would be revived, and
        // without the label every open issue's body is fetched and scanned.
        assert.ok(
          args.includes('state=open'),
          'issue lookup must filter state=open',
        );
        assert.ok(
          args.includes(`labels=${DEFAULTS.label}`),
          'issue lookup must filter by the dedup label',
        );
        assert.ok(args.includes('--paginate'));
        return [
          ['90', b64('unrelated open issue')].join('\t'),
          [
            '91',
            b64(
              `${HEALTH_MARKER}\n<!-- qwen-resolve-health-state {"streak":2,"unanswered":0,"latest":4} -->`,
            ),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (path === 'repos/QwenLM/qwen-code/issues/91/comments') {
        return '';
      }
      if (args[2] === 'POST' || args[2] === 'PATCH') {
        return '{}';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }

  it('reads PRs and comments, finds the marked issue, and only then writes', () => {
    const calls = [];
    const { assessment, actions } = main({
      gh: recordingGh(calls),
      env: { REPO: 'QwenLM/qwen-code', RESOLVE_HEALTH_THRESHOLD: '3' },
      now: new Date('2026-08-27T12:00:00Z'),
    });
    assert.equal(assessment.streak, 3);
    assert.equal(assessment.unanswered.length, 0);
    assert.deepEqual(
      actions.map((a) => a.type),
      ['comment'],
    );
    const writes = calls.filter(
      (c) => c.args[2] === 'POST' || c.args[2] === 'PATCH',
    );
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0].args[3],
      'repos/QwenLM/qwen-code/issues/91/comments',
    );
    const body = JSON.parse(writes[0].input).body;
    assert.ok(body.includes(HEALTH_MARKER));
    assert.equal(readState([body]).streak, 3);
    // No write happens before every read has completed.
    const firstWrite = calls.findIndex((c) => c.args[2] === 'POST');
    assert.ok(calls.slice(firstWrite).every((c) => c.args[2] !== 'GET'));
  });

  it('falls back to the default threshold on a non-numeric knob instead of NaN', () => {
    // NaN would make every comparison false — alarm off — and, with an open
    // issue and no new success, still must not read as a recovery.
    const calls = [];
    const { assessment, actions } = main({
      gh: recordingGh(calls),
      env: { REPO: 'QwenLM/qwen-code', RESOLVE_HEALTH_THRESHOLD: 'abc' },
      now: new Date('2026-08-27T12:00:00Z'),
    });
    assert.equal(assessment.streak, 3);
    assert.equal(assessment.alarm, false);
    assert.deepEqual(actions, []);
    assert.ok(
      calls.every((c) => c.args[2] !== 'POST' && c.args[2] !== 'PATCH'),
    );
  });

  it('refuses to run without a repository', () => {
    assert.throws(() => main({ gh: () => '', env: {} }), /REPO is required/);
  });
});

describe('qwen-resolve-health.yml', () => {
  it('is guarded to the upstream repository with least-privilege permissions', () => {
    const job = workflow.jobs.check;
    assert.equal(job.if, "github.repository == 'QwenLM/qwen-code'");
    assert.deepEqual(workflow.permissions, {});
    assert.deepEqual(job.permissions, { contents: 'read', issues: 'write' });
    assert.equal(job['runs-on'], 'ubuntu-latest');
    const checkout = job.steps.find((s) =>
      s.uses?.startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with['persist-credentials'], false);
    const run = job.steps.find((s) => s.run);
    assert.equal(run.run, 'node .github/scripts/resolve-health.mjs');
    assert.equal(run.env.GH_TOKEN, '${{ github.token }}');
    // main() throws without REPO; the thresholds are the operator's knobs.
    assert.equal(run.env.REPO, '${{ github.repository }}');
    assert.equal(
      run.env.RESOLVE_HEALTH_THRESHOLD,
      '${{ github.event.inputs.threshold || 5 }}',
    );
    assert.equal(
      run.env.RESOLVE_HEALTH_UNANSWERED,
      '${{ github.event.inputs.unanswered || 3 }}',
    );
    assert.equal(workflow.concurrency.group, 'qwen-resolve-health');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });

  it('runs on a schedule and can be dispatched', () => {
    assert.ok(
      Array.isArray(workflow.on.schedule) && workflow.on.schedule.length === 1,
    );
    assert.ok('workflow_dispatch' in workflow.on);
  });

  it('has its test wired into the CI helper-test list', () => {
    // HELPER_TESTS is the single list both runner profiles expand; membership
    // there, not a mention anywhere in the file, is what runs the test.
    const helperTests = parse(ci).env.HELPER_TESTS.split(/\s+/);
    assert.ok(helperTests.includes('.github/scripts/resolve-health.test.mjs'));
  });
});
