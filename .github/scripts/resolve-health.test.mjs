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
  ANSWERABLE_ASSOCIATIONS,
  DEFAULTS,
  HEALTH_MARKER,
  RESULT_MARKER,
  apply,
  assess,
  classifyResult,
  decide,
  fetchPrs,
  findOpenIssue,
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
// One job of the producer workflow, from its name to the next job.
function producerJob(name) {
  const start = producer.indexOf(`\n  ${name}:`);
  assert.ok(start > 0, `${name} job not found in the producer`);
  const rest = producer.slice(start + 1);
  const next = rest.search(/\n {2}[A-Za-z]/);
  return next === -1 ? rest : rest.slice(0, next);
}

const BOT = 'qwen-code-dev-bot';
let nextId = 1000;
function comment(
  user,
  created_at,
  body,
  pr = 1,
  updated_at = created_at,
  author_association = 'COLLABORATOR',
) {
  const id = (nextId += 1);
  return {
    id,
    user,
    author_association,
    created_at,
    updated_at,
    body,
    html_url: `https://github.com/QwenLM/qwen-code/pull/${pr}#issuecomment-${id}`,
  };
}
// Default COLLABORATOR: the association a maintainer's comment carries, and
// the only kind the producer would have served — see ANSWERABLE_ASSOCIATIONS.
const request = (
  at,
  pr,
  user = 'maintainer',
  updated_at = at,
  author_association = 'COLLABORATOR',
) =>
  comment(user, at, '@qwen-code /resolve', pr, updated_at, author_association);
const result = (at, sentence, pr) =>
  comment(BOT, at, `${RESULT_MARKER}\n${sentence}\n\nDetails.`, pr);

const PUSHED =
  'Qwen Code resolved the merge conflicts and pushed the branch update.';
const AGENT_FAILED =
  'Qwen Code attempted to resolve merge conflicts but the run did not complete successfully.';
const INFRA_FAILED =
  'Qwen Code could not run conflict resolution on this PR: the agent step ended with `outcome=cancelled` before producing a result.';
const SKIPPED = 'Qwen Code did not run conflict resolution for this request.';
const ARTIFACT_MISSING =
  "Qwen Code's conflict-resolution agent finished successfully, but its run artifact never reached the publish job — the upload failed or the artifact expired — so the result could not be verified or published.";
const MOVED =
  'Qwen Code resolved the merge conflicts, but the head branch changed while resolving, so the update was not pushed.';
const PERMISSION =
  'Qwen Code resolved the merge conflicts, but could not push to `owner/repo`. For a fork PR this needs **Allow edits by maintainers** enabled.';
const WORKFLOW_SCOPE =
  'Qwen Code resolved the merge conflicts, but could not push to `owner/repo`: resolving merges the base branch in, which includes its `.github/workflows/**` changes.';
const OTHER_PUSH =
  'Qwen Code resolved the merge conflicts, but pushing to `owner/repo` failed.';
const NOOP = 'Qwen Code checked this PR and did not push changes.';
const DRY_RUN = 'Qwen Code resolved the merge conflicts in dry-run mode.';
const UNKNOWN = 'Qwen Code did something this script has never heard of.';

describe('resolve-health: classification', () => {
  it('recognises every sentence the workflow emits', () => {
    const kind = (s) => classifyResult(`${RESULT_MARKER}\n${s}`);
    assert.equal(kind(PUSHED), 'pushed');
    assert.equal(kind(AGENT_FAILED), 'agent_failed');
    assert.equal(kind(INFRA_FAILED), 'infra_failed');
    assert.equal(kind(ARTIFACT_MISSING), 'infra_failed');
    assert.equal(kind(SKIPPED), 'skipped');
    assert.equal(kind(NOOP), 'noop');
    assert.equal(kind(DRY_RUN), 'dry_run');
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

  it('classifies on the first line only, never on the agent-authored appendix', () => {
    // `Report result` appends address-summary.md / no-action.md / failure.md
    // after its fixed sentence. That text is written by the agent (and
    // quotes conflicting-file content an attacker may have chosen), so a
    // success whose appendix mentions an earlier failure must stay a success
    // — classifying on the whole body would turn five such comments into a
    // false alarm.
    const appendix =
      '\n\n### address-summary.md\n\nThe previous run did not complete successfully; this one could not run conflict resolution at first, then did.';
    assert.equal(
      classifyResult(`${RESULT_MARKER}\n${PUSHED}${appendix}`),
      'pushed',
    );
    assert.equal(
      classifyResult(`${RESULT_MARKER}\n${NOOP}${appendix}`),
      'noop',
    );
    // The marker line itself is skipped; blank lines before the sentence are
    // tolerated; the verdict comes from the first real line.
    assert.equal(
      classifyResult(`${RESULT_MARKER}\n\n${AGENT_FAILED}\n${PUSHED}`),
      'agent_failed',
    );
  });

  it('classifies every result sentence the producer workflow actually emits', () => {
    // Read the sentences from `resolve-pr`'s report steps rather than from
    // hand-copied constants, so a wording change in the workflow fails here
    // instead of turning into `unknown` at runtime. The echoes escape
    // backticks (\`) inside double quotes; unescape them so each sentence
    // is seen whole, not cut at the first backslash (which would collapse
    // the four "resolved, but" sentences into one prefix).
    // The lane reports from two jobs: `resolve-pr` posts the skip report,
    // `publish-resolution` every outcome of a run it publishes.
    const lane = producerJob('resolve-pr') + producerJob('publish-resolution');
    const sentences = [...lane.matchAll(/echo "((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1].replace(/\\(.)/g, '$1'))
      .filter((s) => s.startsWith('Qwen Code'));
    // Exact, not a floor: the producer emits twelve report sentences today,
    // and a floor one below that let the dry-run sentence be dropped or
    // reworded into a "resolved, but" shape without any test noticing.
    assert.equal(
      sentences.length,
      12,
      `expected exactly the twelve report sentences, found ${sentences.length}: ${sentences.join(' | ')}`,
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
    // The four "resolved, but" producers land on the two sides they belong
    // to; the replayed push is a success and the lost artifact an infra
    // failure.
    for (const [sentence, kind] of kinds) {
      if (sentence.includes('head branch changed while resolving')) {
        assert.equal(kind, 'resolved_moved', sentence);
      } else if (
        sentence.includes('could not push') ||
        sentence.includes('but pushing to')
      ) {
        assert.equal(kind, 'push_failed', sentence);
      } else if (sentence.includes('replayed on top of it')) {
        assert.equal(kind, 'pushed', sentence);
      } else if (
        sentence.includes('run artifact never reached the publish job')
      ) {
        assert.equal(kind, 'infra_failed', sentence);
      }
    }
    assert.ok([...kinds.values()].includes('resolved_moved'));
    assert.ok([...kinds.values()].includes('dry_run'));
    assert.equal(
      [...kinds.values()].filter((k) => k === 'push_failed').length,
      3,
    );
    // And the constants this file uses are real producer sentences.
    for (const sentence of [
      PUSHED,
      AGENT_FAILED,
      SKIPPED,
      NOOP,
      ARTIFACT_MISSING,
    ]) {
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

  it('pins the producer gate that makes a refused request unanswerable', () => {
    // ANSWERABLE_ASSOCIATIONS exists because a refused request is silent:
    // `resolve-pr` runs only when `authorize` says yes, and
    // `publish-resolution` only publishes a run `resolve-pr` decided to
    // make — so both report steps (`Report skipped request`, `Report
    // result`) sit behind that gate. Should the producer ever answer a
    // refusal, this test fails and the association gate can be dropped
    // instead of quietly hiding requests the lane now does report on.
    const resolvePr = producerJob('resolve-pr');
    assert.match(
      resolvePr,
      /needs\.authorize\.outputs\.should_review == 'true'/,
    );
    assert.ok(resolvePr.includes("- name: 'Report skipped request'"));
    const publish = producerJob('publish-resolution');
    assert.match(publish, /needs\.resolve-pr\.outputs\.decision == 'run'/);
    assert.ok(publish.includes("- name: 'Report result'"));
    // ...and the permission set that gate applies. The watch's set is wider
    // on purpose (a read-only collaborator still counts), never narrower.
    const authorize = producer.slice(
      producer.indexOf('\n  authorize:'),
      producer.indexOf('\n  review-pr:'),
    );
    assert.match(authorize, /admin\|maintain\|write\)/);
    for (const association of ANSWERABLE_ASSOCIATIONS) {
      assert.ok(
        ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association),
        `${association} cannot imply write permission`,
      );
    }
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

  it('settles same-second ties on the comment id, not on input order', () => {
    // GitHub's `created_at` is second-granular, so two results in one second
    // tie and a stable sort keeps the order the input arrived in — for
    // `fetchPrs` that is search ranking, which moves between ticks. The
    // streak, the latest attempt, and the roster must not move with it.
    const at = '2026-08-26T00:00:00Z';
    const pushed = {
      number: 1,
      state: 'open',
      comments: [result(at, PUSHED, 1)],
    };
    const failed = {
      number: 2,
      state: 'open',
      comments: [result(at, AGENT_FAILED, 2)],
    };
    const forward = assess([pushed, failed], { now });
    const backward = assess([failed, pushed], { now });
    assert.equal(forward.streak, backward.streak);
    assert.equal(forward.latestAttempt.id, backward.latestAttempt.id);
    // The id settles it, so the later-posted failure is the latest attempt
    // and the streak counts it whichever way the two PRs arrived.
    assert.equal(forward.streak, 1);
    assert.equal(forward.latestAttempt.id, failed.comments[0].id);

    // The roster feeds sameState()'s order-sensitive comparison, so a tie
    // that reordered it would report a changed picture about an unchanged one.
    const first = {
      number: 3,
      state: 'open',
      comments: [request(at, 3, 'writer1')],
    };
    const second = {
      number: 4,
      state: 'open',
      comments: [request(at, 4, 'writer2')],
    };
    const one = assess([first, second], { now });
    const other = assess([second, first], { now });
    assert.deepEqual(
      one.unanswered.map((u) => u.id),
      [first.comments[0].id, second.comments[0].id],
    );
    assert.deepEqual(
      other.unanswered.map((u) => u.id),
      one.unanswered.map((u) => u.id),
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
        state: 'open',
        comments: [
          request('2026-07-01T00:00:00Z', 9),
          result('2026-07-02T00:00:00Z', AGENT_FAILED, 9),
          result('2026-08-26T00:00:00Z', PUSHED, 9),
        ],
      },
      {
        // The discriminator for the request path: an out-of-window request
        // with NO result after it. On PR 9 the in-window success answers the
        // old request whatever the filter does; here only the window bound
        // keeps it out of the unanswered list.
        number: 11,
        state: 'open',
        comments: [request('2026-07-05T00:00:00Z', 11)],
      },
    ];
    const a = assess(prs, { now, unansweredThreshold: 1 });
    assert.deepEqual(
      a.unanswered.map((u) => u.pr),
      [],
    );
    assert.equal(a.alarm, false);
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
        state: 'open',
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
        state: 'open',
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
        state: 'open',
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

  it('answers a request only with a result on the same PR', () => {
    // `fetchPrs` returns PRs in search order, so a cross-PR answer would
    // make a stale request count or not depending on array position. An
    // earlier-listed PR carrying a fresh success must not answer the stale
    // request on a later-listed PR.
    const prs = [
      {
        number: 2,
        state: 'open',
        comments: [result('2026-08-27T06:00:00Z', PUSHED, 2)],
      },
      {
        number: 1,
        state: 'open',
        comments: [request('2026-08-27T00:00:00Z', 1)],
      },
    ];
    const a = assess(prs, { now, staleHours: 3, unansweredThreshold: 1 });
    assert.deepEqual(
      a.unanswered.map((u) => u.pr),
      [1],
    );
    assert.equal(a.alarm, true);
    assert.deepEqual(
      assess([prs[1], prs[0]], { now, staleHours: 3 }).unanswered.map(
        (u) => u.pr,
      ),
      [1],
    );
  });

  it('only counts result comments the bot posted', () => {
    // Anyone can comment the marker plus a fixed sentence; a forged success
    // must not break a failure streak (masking an outage), and forged
    // failures must not build one (filing a spurious issue).
    const failures = [1, 2, 3, 4, 5].map((d) =>
      result(`2026-08-2${d}T00:00:00Z`, AGENT_FAILED, 14),
    );
    const forgedPush = comment(
      'stranger',
      '2026-08-26T00:00:00Z',
      `${RESULT_MARKER}\n${PUSHED}`,
      14,
    );
    const prs = [
      { number: 14, state: 'open', comments: [...failures, forgedPush] },
    ];
    const a = assess(prs, { now });
    assert.equal(a.streak, 5);
    assert.equal(a.alarm, true);
    // And nothing a stranger posts counts as an attempt at all.
    const forgedOnly = [
      {
        number: 15,
        state: 'open',
        comments: [1, 2, 3, 4, 5].map((d) =>
          comment(
            'stranger',
            `2026-08-2${d}T00:00:00Z`,
            `${RESULT_MARKER}\n${AGENT_FAILED}`,
            15,
          ),
        ),
      },
    ];
    const b = assess(forgedOnly, { now });
    assert.equal(b.attempts.length, 0);
    assert.equal(b.alarm, false);
  });

  it('never counts requests the lane could not have answered', () => {
    // The producer requires an open PR; a request on a closed or merged PR
    // gets no result comment ever and must not read as an unanswered one.
    const prs = ['closed', 'merged', 'closed'].map((state, i) => ({
      number: 16 + i,
      state,
      comments: [request('2026-08-27T00:00:00Z', 16 + i)],
    }));
    const a = assess(prs, { now });
    assert.equal(a.unanswered.length, 0);
    assert.equal(a.alarm, false);
    // Results on such PRs keep counting: attempts that finished before the
    // PR closed still feed the streak and the recovery evidence.
    prs[0].comments.unshift(result('2026-08-26T00:00:00Z', AGENT_FAILED, 16));
    const b = assess(prs, { now });
    assert.equal(b.attempts.length, 1);
    assert.equal(b.streak, 1);
  });

  it('does not count a request from someone the lane would refuse', () => {
    // `resolve-pr` runs only when `authorize` says yes, and that job demands
    // admin/maintain/write and fails closed; on denial the whole job is
    // skipped, including its own `Report skipped request` step, so a refused
    // request gets no result comment at all. Counting it would read a healthy
    // lane as a dead one — three fork-PR authors asking is the exact
    // population /resolve exists for, and this happened live on #8169.
    const denied = ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE'].map(
      (association, i) => ({
        number: 40 + i,
        state: 'open',
        comments: [
          request(
            '2026-08-27T00:00:00Z',
            40 + i,
            'fork-author',
            '2026-08-27T00:00:00Z',
            association,
          ),
        ],
      }),
    );
    const a = assess(denied, { now });
    assert.equal(a.unanswered.length, 0);
    assert.equal(a.alarm, false);
    // The discriminator: the identical requests from someone the lane would
    // have served still alarm, so the gate narrows the population without
    // silencing the signal.
    const served = denied.map((pr) => ({
      ...pr,
      comments: [request('2026-08-27T00:00:00Z', pr.number, 'maintainer')],
    }));
    const b = assess(served, { now });
    assert.equal(b.unanswered.length, 3);
    assert.equal(b.alarm, true);
  });

  it('counts every association that can hold write, and no other', () => {
    // Write access renders as exactly one of these three — the repository
    // owner as OWNER, an organisation member as MEMBER, anyone granted access
    // directly as COLLABORATOR — so the set is a superset of "has write" and
    // dropping the rest can never hide a request the lane would have served.
    // A missing field is dropped too: the producer denies when it cannot
    // establish permission, and the watch takes the same direction.
    const counted = ['OWNER', 'MEMBER', 'COLLABORATOR'];
    const dropped = [
      'CONTRIBUTOR',
      'FIRST_TIME_CONTRIBUTOR',
      'FIRST_TIMER',
      'MANNEQUIN',
      'NONE',
      '',
      // The field absent entirely, as an API that stopped returning it would
      // leave it — not the fixture default.
      null,
    ];
    assert.deepEqual([...ANSWERABLE_ASSOCIATIONS].sort(), [...counted].sort());
    for (const association of [...counted, ...dropped]) {
      const req = request(
        '2026-08-27T00:00:00Z',
        50,
        'someone',
        '2026-08-27T00:00:00Z',
        association ?? 'COLLABORATOR',
      );
      if (association === null) {
        delete req.author_association;
      }
      const a = assess([{ number: 50, state: 'open', comments: [req] }], {
        now,
        unansweredThreshold: 1,
      });
      assert.equal(
        a.unanswered.length,
        counted.includes(association) ? 1 : 0,
        `association ${association === null ? '(absent)' : association}`,
      );
    }
  });

  it('does not count a comment edited into a request', () => {
    // The producer fires on comment creation only; an edit never starts a
    // run, so an edited comment never receives a result and must not be
    // tallied as unanswered (a maintainer typo-fixing `/resolv` by editing
    // would otherwise alarm on a healthy lane).
    const prs = [
      {
        number: 19,
        state: 'open',
        comments: [1, 2, 3].map((h) =>
          request(
            `2026-08-27T0${h}:00:00Z`,
            19,
            'maintainer',
            `2026-08-27T09:0${h}:00Z`,
          ),
        ),
      },
    ];
    const a = assess(prs, { now });
    assert.equal(a.unanswered.length, 0);
    assert.equal(a.alarm, false);
  });

  it('counts a request aged exactly the stale window', () => {
    // The boundary is inclusive (`>=`): a request aged exactly staleHours
    // counts; one one second younger does not.
    const prs = [
      {
        number: 30,
        state: 'open',
        comments: [
          request('2026-08-27T09:00:00Z', 30),
          request('2026-08-27T09:00:01Z', 30),
        ],
      },
    ];
    const a = assess(prs, { now, staleHours: 3, unansweredThreshold: 1 });
    assert.deepEqual(
      a.unanswered.map((u) => u.at),
      ['2026-08-27T09:00:00Z'],
    );
  });

  it('does not count result comments edited after posting', () => {
    // The producer posts a fresh comment per run and never edits one; anyone
    // with triage-or-better on the repo can still edit one, so an edited
    // result must count as no result at all — a failure edited into a
    // success must not pose as recovery evidence, and a success edited into
    // a failure phrase must not build a streak.
    const failures = [1, 2, 3, 4, 5].map((d) =>
      result(`2026-08-2${d}T00:00:00Z`, AGENT_FAILED, 29),
    );
    const editedPushed = comment(
      BOT,
      '2026-08-26T00:00:00Z',
      `${RESULT_MARKER}\n${PUSHED}`,
      29,
      '2026-08-26T06:00:00Z',
    );
    const a = assess(
      [{ number: 29, state: 'open', comments: [...failures, editedPushed] }],
      { now },
    );
    assert.equal(a.streak, 5);
    assert.equal(a.alarm, true);
    assert.equal(a.latestAttempt.kind, 'agent_failed');
    // The other direction: a success edited into a failure phrase builds
    // no streak either.
    const editedFailure = comment(
      BOT,
      '2026-08-26T00:00:00Z',
      `${RESULT_MARKER}\n${AGENT_FAILED}`,
      29,
      '2026-08-26T06:00:00Z',
    );
    const b = assess(
      [
        {
          number: 29,
          state: 'open',
          comments: [result('2026-08-25T00:00:00Z', PUSHED, 29), editedFailure],
        },
      ],
      { now },
    );
    assert.equal(b.streak, 0);
    assert.deepEqual(
      b.attempts.map((r) => r.kind),
      ['pushed'],
    );
  });

  it('counts no-conflict and dry-run results neither way', () => {
    // Neither pushes anything: they must not break a push-failure streak
    // (masking a push outage) and cannot serve as recovery evidence.
    const alternating = [
      result('2026-08-21T00:00:00Z', PERMISSION, 20),
      result('2026-08-21T06:00:00Z', NOOP, 20),
      result('2026-08-22T00:00:00Z', PERMISSION, 20),
      result('2026-08-22T06:00:00Z', NOOP, 20),
      result('2026-08-23T00:00:00Z', PERMISSION, 20),
      result('2026-08-23T06:00:00Z', NOOP, 20),
      result('2026-08-24T00:00:00Z', PERMISSION, 20),
      result('2026-08-24T06:00:00Z', NOOP, 20),
      result('2026-08-25T00:00:00Z', PERMISSION, 20),
      result('2026-08-25T06:00:00Z', DRY_RUN, 20),
    ];
    const a = assess([{ number: 20, state: 'open', comments: alternating }], {
      now,
    });
    assert.deepEqual(
      a.attempts.map((r) => r.kind),
      Array(5).fill('push_failed'),
    );
    assert.equal(a.streak, 5);
    assert.equal(a.alarm, true);
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
      unanswered: [],
      newestUnanswered: null,
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
          state: 'open',
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
    // The state records WHICH requests are unanswered, not how many, and
    // the newest of them — the barrier decide() postdates recovery pushes by.
    assert.deepEqual(readState([actions[0].body]), {
      streak: 0,
      unanswered: stale.unanswered.map((u) => u.id),
      newestUnanswered: stale.unanswered.at(-1).at,
      latest: null,
    });
  });

  it('comments when the unanswered roster changes even if its size does not', () => {
    // During a never-ran outage a skip answers one request while another
    // ages past the stale window: count 3 → 3, streak 0, latest unchanged.
    // Keying change detection on the count would freeze the issue's roster
    // on week one while it describes week two.
    const tick1 = assess(
      [
        {
          number: 12,
          state: 'open',
          comments: [1, 2, 3].map((h) =>
            request(`2026-08-27T0${h}:00:00Z`, 12),
          ),
        },
      ],
      { now },
    );
    const existing = { number: 42, texts: [decide(tick1, null)[0].body] };
    assert.deepEqual(decide(tick1, existing), []);
    const later = new Date('2026-08-27T13:00:00Z');
    const tick2 = assess(
      [
        {
          number: 12,
          state: 'open',
          comments: [
            ...tick1.unanswered.map((u) =>
              comment('maintainer', u.at, '@qwen-code /resolve', 12),
            ),
            // A skip result answers the three earlier requests (any later
            // result answers a request)…
            result('2026-08-27T04:00:00Z', SKIPPED, 12),
            // …and three newer requests have aged past the stale window.
            ...[5, 6, 7].map((h) => request(`2026-08-27T0${h}:00:00Z`, 12)),
          ],
        },
      ],
      { now: later },
    );
    assert.equal(tick2.unanswered.length, 3);
    assert.equal(tick2.streak, 0);
    const actions = decide(tick2, existing);
    assert.deepEqual(
      actions.map((a) => a.type),
      ['comment'],
    );
    assert.deepEqual(
      readState([actions[0].body]).unanswered,
      tick2.unanswered.map((u) => u.id),
    );
  });

  it('attributes a push-rejected streak to the push, not to the agent', () => {
    // Five push_failed results are the push-outage incident class; the
    // headline must send the reader to credentials, not to the model.
    const outage = assess(
      [
        {
          number: 21,
          state: 'open',
          comments: [1, 2, 3, 4, 5].map((d) =>
            result(`2026-08-2${d}T00:00:00Z`, PERMISSION, 21),
          ),
        },
      ],
      { now },
    );
    const body = decide(outage, null)[0].body;
    assert.ok(
      body.includes(
        "5 in a row (0 never reached the agent's verdict, 5 resolved the conflict but the push was rejected, 0 were the agent giving up",
      ),
      body,
    );
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
    // If the close fails after the comment landed, the next tick retries
    // the close without repeating the recovery comment: the `recovered`
    // field the comment's state marker wrote dedupes the comment only,
    // never the close.
    const after = { number: 42, texts: [...existing.texts, actions[0].body] };
    assert.deepEqual(
      decide(healthy, after).map((a) => a.type),
      ['close'],
    );
  });

  it('does not treat loss of evidence as recovery', () => {
    // An open unanswered-driven issue whose requests fell out of the
    // discovery window, or a streak that merely dropped below the threshold
    // with no success: alarm is false, but nothing has been shown to work.
    const stale = assess(
      [
        {
          number: 12,
          state: 'open',
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
    // The shared `healthy` push (2026-08-26) PREDATES this issue's requests
    // (2026-08-27), so it is no evidence that anything ran after them.
    assert.deepEqual(decide(healthy, existing), []);
    // A success NEWER than the requests is what closes it.
    const recovered = assess(
      [
        {
          number: 3,
          comments: [result('2026-08-27T04:00:00Z', PUSHED, 3)],
        },
      ],
      { now },
    );
    assert.deepEqual(
      decide(recovered, existing).map((a) => a.type),
      ['comment', 'close'],
    );
  });

  it('does not close an open issue on attempts that pushed nothing', () => {
    // A push-failure streak opens the issue; a moved head, a no-conflict
    // run, or a dry run pushes nothing, so none of them is evidence the
    // push outage healed — even though a moved head resets the streak.
    // The same failure comments are reused across the assessments so only
    // the added attempt differs.
    const failures = [1, 2, 3, 4, 5].map((d) =>
      result(`2026-08-2${d}T00:00:00Z`, PERMISSION, 21),
    );
    const pushOutage = assess(
      [{ number: 21, state: 'open', comments: [...failures] }],
      { now },
    );
    assert.equal(pushOutage.alarm, true);
    const existing = { number: 43, texts: [decide(pushOutage, null)[0].body] };
    const afterMoved = assess(
      [
        {
          number: 21,
          state: 'open',
          comments: [...failures, result('2026-08-26T00:00:00Z', MOVED, 21)],
        },
      ],
      { now },
    );
    assert.equal(afterMoved.streak, 0); // the streak reset stays
    assert.deepEqual(decide(afterMoved, existing), []);
    const afterNoPush = assess(
      [
        {
          number: 21,
          state: 'open',
          comments: [
            ...failures,
            result('2026-08-26T00:00:00Z', NOOP, 21),
            result('2026-08-26T01:00:00Z', DRY_RUN, 21),
          ],
        },
      ],
      { now },
    );
    assert.equal(afterNoPush.alarm, true); // noop/dry_run break no streak
    assert.deepEqual(decide(afterNoPush, existing), []);
  });

  it('closes on a success that arrived while unanswered requests alarmed', () => {
    // A success landing on another PR while unanswered requests still hold
    // the alarm is recorded by the alarm update; once those requests age
    // out of the window the issue must still close on that success.
    const requests22 = [1, 2, 3].map((h) =>
      request(`2026-08-20T0${h}:00:00Z`, 22),
    );
    const withSuccess = [
      { number: 22, state: 'open', comments: requests22 },
      {
        number: 23,
        state: 'open',
        comments: [result('2026-08-26T00:00:00Z', PUSHED, 23)],
      },
    ];
    const texts = [
      decide(
        assess([{ number: 22, state: 'open', comments: requests22 }], {
          now: new Date('2026-08-20T12:00:00Z'),
        }),
        null,
      )[0].body,
    ];
    // The success arrives while the requests still alarm.
    const mid = assess(withSuccess, { now: new Date('2026-08-26T12:00:00Z') });
    assert.equal(mid.alarm, true);
    const update = decide(mid, { number: 44, texts })[0];
    assert.equal(update.type, 'comment');
    texts.push(update.body);
    // The requests age out of the window; the success remains.
    const cleared = assess(withSuccess, {
      now: new Date('2026-08-27T12:00:00Z'),
    });
    assert.equal(cleared.alarm, false);
    assert.deepEqual(
      decide(cleared, { number: 44, texts }).map((a) => a.type),
      ['comment', 'close'],
    );
  });

  it('never closes on a push older than the unanswered requests', () => {
    // A `pushed` attempt that landed BEFORE the requests the issue was
    // opened on cannot be evidence that anything ran after them — yet the
    // alarm clears as those requests stop counting while the stale push
    // stays in the window. Two entrances: their PRs close without ever
    // receiving a result (assess() drops closed-PR requests by design), or
    // enough of them get answered to fall below the threshold.
    const prsWith = (states) => [
      {
        number: 24,
        state: 'open',
        comments: [result('2026-08-24T00:00:00Z', PUSHED, 24)],
      },
      ...states.map((state, i) => ({
        number: 25 + i,
        state,
        comments: [request(`2026-08-2${5 + i}T01:00:00Z`, 25 + i)],
      })),
    ];
    const opened = assess(prsWith(['open', 'open', 'open']), { now });
    assert.equal(opened.unanswered.length, 3);
    const existing = { number: 45, texts: [decide(opened, null)[0].body] };

    // (a) all three PRs close unanswered; the stale push stays the latest.
    const closedPrs = assess(prsWith(['closed', 'closed', 'closed']), { now });
    assert.equal(closedPrs.alarm, false);
    assert.equal(closedPrs.latestAttempt.kind, 'pushed');
    assert.deepEqual(decide(closedPrs, existing), []);

    // (b) one request gets a skip, two stay unanswered: below the threshold
    // the alarm clears with the same stale push still the latest attempt.
    const partialPrs = prsWith(['open', 'open', 'open']);
    partialPrs[1].comments.push(result('2026-08-25T02:00:00Z', SKIPPED, 25));
    const partial = assess(partialPrs, { now });
    assert.equal(partial.alarm, false);
    assert.deepEqual(decide(partial, existing), []);

    // A push that postdates the requests still closes once the alarm clears.
    const healedPrs = prsWith(['closed', 'closed', 'closed']);
    healedPrs[0].comments.push(result('2026-08-27T02:00:00Z', PUSHED, 24));
    assert.deepEqual(
      decide(assess(healedPrs, { now }), existing).map((a) => a.type),
      ['comment', 'close'],
    );
  });

  it('keeps the newest unanswered request on record through alarm updates', () => {
    // The recovery barrier is the newest unanswered request seen since the
    // issue opened, so an alarm update whose roster SHRINKS must not lower
    // it: if the update's marker recorded only the current roster, a push
    // between that and a dropped request would close the issue although the
    // dropped request never got an attempt.
    const failures = [1, 2, 3, 4, 5].map((d) =>
      result(`2026-08-2${d}T00:00:00Z`, AGENT_FAILED, 30),
    );
    const tick1 = assess(
      [
        { number: 30, state: 'open', comments: [...failures] },
        {
          number: 31,
          state: 'open',
          comments: [request('2026-08-25T01:00:00Z', 31)],
        },
        {
          number: 32,
          state: 'open',
          comments: [request('2026-08-26T01:00:00Z', 32)],
        },
        {
          number: 33,
          state: 'open',
          comments: [request('2026-08-27T01:00:00Z', 33)],
        },
      ],
      { now },
    );
    const texts = [decide(tick1, null)[0].body];

    // The newest request's PR closes unanswered while the oldest gets a
    // skip; the streak still alarms, so the watch posts an update — which
    // must carry the dropped request's timestamp forward.
    const tick2 = assess(
      [
        { number: 30, state: 'open', comments: [...failures] },
        {
          number: 31,
          state: 'open',
          comments: [
            request('2026-08-25T01:00:00Z', 31),
            result('2026-08-25T02:00:00Z', SKIPPED, 31),
          ],
        },
        {
          number: 32,
          state: 'open',
          comments: [request('2026-08-26T01:00:00Z', 32)],
        },
        {
          number: 33,
          state: 'closed',
          comments: [request('2026-08-27T01:00:00Z', 33)],
        },
      ],
      { now },
    );
    assert.equal(tick2.alarm, true);
    const update = decide(tick2, { number: 46, texts })[0];
    assert.equal(update.type, 'comment');
    texts.push(update.body);

    // The last request is answered by a push that postdates it but PREDATES
    // the dropped one: the alarm clears, yet the issue must stay open.
    const tick3 = assess(
      [
        { number: 30, state: 'open', comments: [...failures] },
        {
          number: 31,
          state: 'open',
          comments: [
            request('2026-08-25T01:00:00Z', 31),
            result('2026-08-25T02:00:00Z', SKIPPED, 31),
          ],
        },
        {
          number: 32,
          state: 'open',
          comments: [
            request('2026-08-26T01:00:00Z', 32),
            result('2026-08-26T02:00:00Z', PUSHED, 32),
          ],
        },
        {
          number: 33,
          state: 'closed',
          comments: [request('2026-08-27T01:00:00Z', 33)],
        },
      ],
      { now },
    );
    assert.equal(tick3.alarm, false);
    assert.equal(tick3.latestAttempt.kind, 'pushed');
    assert.deepEqual(decide(tick3, { number: 46, texts }), []);
  });

  it('records a barrier that rose while the alarm stayed below threshold', () => {
    // The barrier only ever reached a marker on an alarm or a recovery tick,
    // so a request that went unanswered BELOW the threshold was never
    // recorded. Once its PR closes, assess() drops it by design, the barrier
    // falls back to the one the streak-only issue filed (null), and the
    // recovery gate closes on a push OLDER than that request — a false
    // recovery that needs no adversary and no tampered marker.
    const failures = [1, 2, 3, 4, 5].map((d) =>
      result(`2026-08-2${d}T00:00:00Z`, AGENT_FAILED, 30),
    );
    const opened = assess(
      [{ number: 30, state: 'open', comments: [...failures] }],
      { now },
    );
    const texts = [decide(opened, null)[0].body];
    assert.equal(readState(texts).newestUnanswered, null);

    // The lane pushes, then breaks never-ran: one request, unanswered, below
    // the threshold of three.
    const push = result('2026-08-26T19:00:00Z', PUSHED, 30);
    const unanswered = request('2026-08-26T19:30:00Z', 31);
    const withRequest = (state) => [
      { number: 30, state: 'open', comments: [...failures, push] },
      { number: 31, state, comments: [unanswered] },
    ];
    const tick2 = assess(withRequest('open'), { now });
    assert.equal(tick2.alarm, false);
    assert.equal(tick2.unanswered.length, 1);
    // The in-tick barrier already blocks the close; what was missing is the
    // write that keeps it once the request leaves the assessment.
    const refresh = decide(tick2, { number: 47, texts });
    assert.deepEqual(
      refresh.map((a) => a.type),
      ['comment'],
    );
    assert.equal(
      readState([...texts, refresh[0].body]).newestUnanswered,
      '2026-08-26T19:30:00Z',
    );
    texts.push(refresh[0].body);

    // The request's PR closes unanswered and the stale push stays in window.
    const tick3 = assess(withRequest('closed'), { now });
    assert.equal(tick3.alarm, false);
    assert.equal(tick3.unanswered.length, 0);
    assert.equal(tick3.latestAttempt.kind, 'pushed');
    // Not closed — and not refreshed again either: the barrier recorded above
    // now holds, so the write does not repeat every tick.
    assert.deepEqual(decide(tick3, { number: 47, texts }), []);
  });

  it('does not close on a state it could not read', () => {
    // A marker this tick cannot read is not evidence that no barrier was ever
    // recorded: the body or comment carrying it can be edited into junk. The
    // refresh is what keeps the refusal from wedging the issue open — it
    // re-records the state, and the next tick closes on that.
    const existing = {
      number: 49,
      texts: [
        `${HEALTH_MARKER}\n<!-- qwen-resolve-health-state {not json} -->`,
      ],
    };
    assert.equal(readState(existing.texts), null);
    const actions = decide(healthy, existing);
    assert.deepEqual(
      actions.map((a) => a.type),
      ['comment'],
    );
    assert.match(actions[0].body, /State refresh:/);
    const restored = {
      number: 49,
      texts: [...existing.texts, actions[0].body],
    };
    assert.deepEqual(
      decide(healthy, restored).map((a) => a.type),
      ['comment', 'close'],
    );
  });

  it('does nothing when healthy and no issue is open', () => {
    assert.deepEqual(decide(healthy, null), []);
  });
});

describe('resolve-health: reading the comment feed', () => {
  it('asks the API for the association assess() gates on', () => {
    // The gate is only as good as the field reaching it: if the jq stops
    // selecting author_association every request parses as unanswerable and
    // the signal goes silent, which no assess() test would notice.
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args[3] === 'search/issues') {
        return '7\topen\n';
      }
      return [
        [
          '1',
          'fork-author',
          'CONTRIBUTOR',
          '2026-08-27T00:00:00Z',
          '2026-08-27T00:00:00Z',
          'u1',
          Buffer.from('@qwen-code /resolve').toString('base64'),
        ].join('\t'),
        // An empty association column, as `(.author_association // "")`
        // emits when the API omits the field: the row must still parse
        // positionally rather than shifting every later field left.
        [
          '2',
          'ghost',
          '',
          '2026-08-27T00:10:00Z',
          '2026-08-27T00:10:00Z',
          'u2',
          Buffer.from('@qwen-code /resolve').toString('base64'),
        ].join('\t'),
        '',
      ].join('\n');
    };
    const prs = fetchPrs(gh, 'QwenLM/qwen-code', '2026-08-20');
    const jq = calls[1][calls[1].indexOf('--jq') + 1];
    assert.match(jq, /author_association/);
    assert.equal(prs[0].comments[0].author_association, 'CONTRIBUTOR');
    assert.deepEqual(
      prs[0].comments.map((c) => [c.author_association, c.created_at]),
      [
        ['CONTRIBUTOR', '2026-08-27T00:00:00Z'],
        ['', '2026-08-27T00:10:00Z'],
      ],
    );
    // ...and the fetched shape flows into assess() unchanged: neither
    // request is one the lane would have served, so neither is counted.
    assert.equal(
      assess(prs, {
        now: new Date('2026-08-27T12:00:00Z'),
        unansweredThreshold: 1,
      }).unanswered.length,
      0,
    );
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
    // The payload only reaches gh through `--input -`; without it gh ignores
    // stdin, the comment POST goes out empty (422) and the close PATCH is a
    // no-op that leaves a recovered issue open forever.
    for (const c of calls) {
      const i = c.args.indexOf('--input');
      assert.ok(
        i !== -1 && c.args[i + 1] === '-',
        `delivery mechanism lost: ${c.args.join(' ')}`,
      );
    }
  });
});

describe('resolve-health: the tracking issue feed', () => {
  const b64 = (s) => Buffer.from(s).toString('base64');

  it("trusts only the watch's own comments as state", () => {
    // Anyone can comment a state marker on the open tracking issue; only
    // markers the watch itself posted (github-actions[bot] today, the bot
    // login if it ever switches to the bot PAT) may feed readState — a
    // forged marker must neither suppress updates nor force a recovery. An
    // EDIT forgery just as surely: the watch posts a fresh comment per tick
    // and never edits one, so an edited marker is someone else's word.
    const botState =
      '<!-- qwen-resolve-health-state {"streak":1,"unanswered":0,"latest":7} -->';
    const forgedState =
      '<!-- qwen-resolve-health-state {"streak":0,"unanswered":0,"latest":null} -->';
    const filed = '2026-08-20T00:00:00Z';
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      const path = args[3];
      if (path === 'repos/QwenLM/qwen-code/issues' && args[2] === 'GET') {
        return [
          [
            '91',
            'github-actions[bot]',
            filed,
            filed,
            b64(`${HEALTH_MARKER}\n${botState}`),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (path === 'repos/QwenLM/qwen-code/issues/91/comments') {
        return [
          ['github-actions[bot]', filed, filed, b64(botState)].join('\t'),
          [BOT, filed, filed, b64(botState)].join('\t'),
          ['stranger', filed, filed, b64(forgedState)].join('\t'),
          // A watch comment a triage user edited into a forgery, last so that
          // dropping the edit filter lets it win readState's last-marker read.
          [
            'github-actions[bot]',
            filed,
            '2026-08-26T00:00:00Z',
            b64(forgedState),
          ].join('\t'),
          '',
        ].join('\n');
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const issue = findOpenIssue(gh, 'QwenLM/qwen-code', DEFAULTS.label);
    assert.equal(issue.number, 91);
    // Body plus the two unedited bot-authored comments; the stranger's marker
    // and the edited one are dropped, so the last readState sees is honest.
    assert.equal(issue.texts.length, 3);
    assert.equal(readState(issue.texts).streak, 1);
    // The gates are only as good as the fields reaching them.
    const jq = calls.at(-1)[calls.at(-1).indexOf('--jq') + 1];
    assert.match(jq, /\.created_at/);
    assert.match(jq, /\.updated_at/);
  });

  it('adopts only an issue the watch filed, and only its unedited body', () => {
    // The body is a state source, so it carries the same two gates: the issue
    // has to be the watch's own — a planted decoy needs the label, and
    // applying one needs triage, the adversary assess() models — and an
    // edited body is not the watch's word. Discovery must still match the
    // marker in an edited body: gate that too and a triage user deletes the
    // marker by editing, so every later tick files a duplicate.
    const forgedState =
      '<!-- qwen-resolve-health-state {"streak":0,"unanswered":[],"newestUnanswered":null,"latest":null} -->';
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      const path = args[3];
      if (path === 'repos/QwenLM/qwen-code/issues' && args[2] === 'GET') {
        return [
          // The issues API returns created-desc, so a planted decoy is the
          // newest candidate and is reached first.
          [
            '99',
            'stranger',
            '2026-08-26T00:00:00Z',
            '2026-08-26T00:00:00Z',
            b64(`${HEALTH_MARKER}\n${forgedState}`),
          ].join('\t'),
          // The genuine issue, whose body a triage user has since edited.
          [
            '91',
            'github-actions[bot]',
            '2026-08-20T00:00:00Z',
            '2026-08-25T00:00:00Z',
            b64(`${HEALTH_MARKER}\n${forgedState}`),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (path === 'repos/QwenLM/qwen-code/issues/91/comments') {
        return '';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const issue = findOpenIssue(gh, 'QwenLM/qwen-code', DEFAULTS.label);
    // The decoy is not the watch's, so the genuine issue is still tracked...
    assert.equal(issue.number, 91);
    // ...and its edited body fed no state, while still being what found it.
    assert.equal(readState(issue.texts), null);
    const jq = calls[0][calls[0].indexOf('--jq') + 1];
    assert.match(jq, /select\(\.pull_request == null\)/);
    assert.match(jq, /\.user\.login/);
    assert.match(jq, /\.created_at/);
    assert.match(jq, /\.updated_at/);
  });

  it('carries the body barrier forward when a benign comment blanks it', () => {
    // The Issues API bumps `updated_at` on ANY comment, so a stranger's reply
    // — needing no permission at all — makes an intact body look edited and
    // drops it from the state sources. Until the watch's own first comment the
    // body is the only record of the barrier, so losing it breaks the promise
    // `stateOf` makes (carried forward, never lowered) in both directions: a
    // quiet tick refreshes with `newestUnanswered: null` and the next tick's
    // gate has no barrier left to postdate, and an alarm tick read from a
    // roster whose newest request is older records that lower value.
    const now = new Date('2026-08-27T12:00:00Z');
    const filed = '2026-08-27T02:00:00Z';
    const replied = '2026-08-27T05:00:00Z';
    const barrier = '2026-08-27T01:00:00Z';
    const asked = (at, pr, state = 'open') => ({
      number: pr,
      state,
      comments: [request(at, pr)],
    });
    const lane = [
      {
        number: 40,
        state: 'open',
        comments: [result('2026-08-26T00:00:00Z', PUSHED, 40)],
      },
      asked('2026-08-26T01:00:00Z', 41),
      asked('2026-08-26T02:00:00Z', 42),
      asked(barrier, 43),
    ];
    const body = decide(assess(lane, { now }), null)[0].body;
    assert.equal(readState([body]).newestUnanswered, barrier);

    // The issue as the API returns it once someone has replied: `updated_at`
    // moved, the body is byte-identical, and no watch comment carries a marker
    // yet — so the blanked body leaves no readable state at all.
    const feed =
      (watchComments = []) =>
      (args) => {
        if (args[3] === 'repos/QwenLM/qwen-code/issues') {
          return [
            ['91', 'github-actions[bot]', filed, replied, b64(body)].join('\t'),
            '',
          ].join('\n');
        }
        return [
          ['stranger', replied, replied, b64('same here')].join('\t'),
          ...watchComments.map((text) =>
            ['github-actions[bot]', replied, replied, b64(text)].join('\t'),
          ),
          '',
        ].join('\n');
      };
    const issueWith = (watchComments) =>
      findOpenIssue(feed(watchComments), 'QwenLM/qwen-code', DEFAULTS.label);
    const blanked = issueWith();
    assert.equal(blanked.number, 91);
    assert.equal(readState(blanked.texts), null);

    // The unanswered PRs close, so the roster clears and the alarm goes quiet
    // with the pre-barrier push still the latest attempt. The refresh must
    // carry the discarded body's barrier forward, not drop it...
    const quiet = assess(
      lane.map((pr) => (pr.number === 40 ? pr : { ...pr, state: 'closed' })),
      { now },
    );
    assert.equal(quiet.alarm, false);
    assert.equal(quiet.latestAttempt.kind, 'pushed');
    const refresh = decide(quiet, blanked);
    assert.deepEqual(
      refresh.map((a) => a.type),
      ['comment'],
    );
    assert.match(refresh[0].body, /State refresh:/);
    assert.equal(readState([refresh[0].body]).newestUnanswered, barrier);

    // ...so the next tick, reading that refresh as its state, refuses the
    // close: the push predates a request that was never answered.
    const next = issueWith([refresh[0].body]);
    assert.equal(readState(next.texts).newestUnanswered, barrier);
    assert.deepEqual(decide(quiet, next), []);

    // The same body read on an alarm tick: the barrier's PR closed and three
    // older requests fire, so a state taken only from the roster would LOWER
    // the barrier, and a push landing between the two would then close.
    const still = assess(
      [
        ...lane.slice(0, 3),
        asked('2026-08-26T03:00:00Z', 44),
        asked(barrier, 43, 'closed'),
      ],
      { now },
    );
    assert.equal(still.alarm, true);
    assert.equal(still.unanswered.at(-1).at, '2026-08-26T03:00:00Z');
    const update = decide(still, blanked);
    assert.deepEqual(
      update.map((a) => a.type),
      ['comment'],
    );
    assert.match(update[0].body, /Still failing/);
    assert.equal(readState([update[0].body]).newestUnanswered, barrier);
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
        return '11\topen\n12\topen\n';
      }
      if (path === 'repos/QwenLM/qwen-code/issues/11/comments') {
        assert.ok(args.includes('--paginate') && args.includes('per_page=100'));
        return [
          [
            '1',
            'maintainer',
            'COLLABORATOR',
            '2026-08-25T00:00:00Z',
            '2026-08-25T00:00:00Z',
            'u1',
            b64('@qwen-code /resolve'),
          ].join('\t'),
          [
            '2',
            BOT,
            'COLLABORATOR',
            '2026-08-25T00:05:00Z',
            '2026-08-25T00:05:00Z',
            'u2',
            b64(`${RESULT_MARKER}\n${INFRA_FAILED}`),
          ].join('\t'),
          [
            '3',
            'maintainer',
            'COLLABORATOR',
            '2026-08-26T00:00:00Z',
            '2026-08-26T00:00:00Z',
            'u3',
            b64('@qwen-code /resolve'),
          ].join('\t'),
          [
            '4',
            BOT,
            'COLLABORATOR',
            '2026-08-26T00:05:00Z',
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
            'COLLABORATOR',
            '2026-08-26T01:00:00Z',
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
          [
            '90',
            'maintainer',
            '2026-08-19T00:00:00Z',
            '2026-08-19T00:00:00Z',
            b64('unrelated open issue'),
          ].join('\t'),
          [
            '91',
            'github-actions[bot]',
            '2026-08-20T00:00:00Z',
            '2026-08-20T00:00:00Z',
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

  // A recording gh with its own feed: `prs` is [{ number, state, comments }]
  // in the shape assess() reads, `issues` the rows the open-issue lookup
  // returns. Used where the shared fixture's streak (3, below the default
  // threshold) cannot tell a fallback from a bug.
  function feedGh(calls, prs, issues = []) {
    return (args, input) => {
      calls.push({ args, input });
      const path = args[3];
      if (path === 'search/issues') {
        return prs.map((p) => `${p.number}\t${p.state}\n`).join('');
      }
      const m = path.match(
        /^repos\/QwenLM\/qwen-code\/issues\/(\d+)\/comments$/,
      );
      if (m && args[2] === 'GET') {
        const pr = prs.find((p) => String(p.number) === m[1]);
        if (pr) {
          return pr.comments
            .map((c) =>
              [
                c.id,
                c.user,
                c.author_association ?? 'COLLABORATOR',
                c.created_at,
                c.updated_at ?? c.created_at,
                c.html_url,
                b64(c.body),
              ].join('\t'),
            )
            .map((l) => `${l}\n`)
            .join('');
        }
        return '';
      }
      if (path === 'repos/QwenLM/qwen-code/issues' && args[2] === 'GET') {
        // The issues jq emits number, author, created, updated, body; a row
        // defaults to the watch's own issue with an unedited body.
        return issues
          .map(
            ([
              n,
              body,
              author = 'github-actions[bot]',
              created = '2026-08-20T00:00:00Z',
              updated = created,
            ]) => `${n}\t${author}\t${created}\t${updated}\t${b64(body)}\n`,
          )
          .join('');
      }
      if (args[2] === 'POST' || args[2] === 'PATCH') {
        return '{}';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
  }
  const fiveFailures = () => [
    {
      number: 11,
      state: 'open',
      comments: [1, 2, 3, 4, 5].map((d) =>
        result(`2026-08-2${d}T00:00:00Z`, AGENT_FAILED, 11),
      ),
    },
  ];

  it('falls back to the default threshold on a non-numeric knob instead of NaN', () => {
    // A streak of exactly the default (5) is the discriminator: with the
    // fallback the alarm fires and an issue is filed; under the NaN bug every
    // `streak >= threshold` comparison is false and nothing is written.
    const calls = [];
    const { assessment, actions } = main({
      gh: feedGh(calls, fiveFailures()),
      env: { REPO: 'QwenLM/qwen-code', RESOLVE_HEALTH_THRESHOLD: 'abc' },
      now: new Date('2026-08-27T12:00:00Z'),
    });
    assert.equal(assessment.streak, 5);
    assert.equal(assessment.alarm, true);
    assert.deepEqual(
      actions.map((a) => a.type),
      ['create'],
    );
    const creates = calls.filter(
      (c) =>
        c.args[2] === 'POST' && c.args[3] === 'repos/QwenLM/qwen-code/issues',
    );
    assert.equal(creates.length, 1);
    // And a knob one above the streak keeps it quiet, so the number is read.
    const quiet = [];
    assert.equal(
      main({
        gh: feedGh(quiet, fiveFailures()),
        env: { REPO: 'QwenLM/qwen-code', RESOLVE_HEALTH_THRESHOLD: '6' },
        now: new Date('2026-08-27T12:00:00Z'),
      }).assessment.alarm,
      false,
    );
  });

  it('files the tracking issue with the same label the lookup filters by', () => {
    // If the create used another label, the lookup would never find the
    // issue again and every later tick would file a duplicate.
    const calls = [];
    main({
      gh: feedGh(calls, fiveFailures()),
      env: { REPO: 'QwenLM/qwen-code' },
      now: new Date('2026-08-27T12:00:00Z'),
    });
    const lookup = calls.find(
      (c) =>
        c.args[2] === 'GET' && c.args[3] === 'repos/QwenLM/qwen-code/issues',
    );
    assert.ok(lookup.args.includes(`labels=${DEFAULTS.label}`));
    const create = calls.find(
      (c) =>
        c.args[2] === 'POST' && c.args[3] === 'repos/QwenLM/qwen-code/issues',
    );
    assert.deepEqual(JSON.parse(create.input).labels, [DEFAULTS.label]);
  });

  it('honours the unanswered-request knob through main()', () => {
    // One stale request: alarms under `unanswered=1`, not under `4`, so a
    // dropped or misnamed env read would flip the first assertion.
    const stale = () => [
      {
        number: 12,
        state: 'open',
        comments: [request('2026-08-26T00:00:00Z', 12)],
      },
    ];
    const loud = [];
    const a = main({
      gh: feedGh(loud, stale()),
      env: { REPO: 'QwenLM/qwen-code', RESOLVE_HEALTH_UNANSWERED: '1' },
      now: new Date('2026-08-27T12:00:00Z'),
    });
    assert.equal(a.assessment.unanswered.length, 1);
    assert.equal(a.assessment.alarm, true);
    assert.deepEqual(
      a.actions.map((x) => x.type),
      ['create'],
    );
    const quiet = [];
    const b = main({
      gh: feedGh(quiet, stale()),
      env: { REPO: 'QwenLM/qwen-code', RESOLVE_HEALTH_UNANSWERED: '4' },
      now: new Date('2026-08-27T12:00:00Z'),
    });
    assert.equal(b.assessment.alarm, false);
    assert.deepEqual(b.actions, []);
  });

  it('recovers even when a stranger forged the state marker', () => {
    // Comment ids are public API data, so anyone can comment a marker
    // recording `recovered` on the open issue; state is read only from the
    // watch's own comments, so the forgery cannot suppress the recovery.
    const calls = [];
    const gh = (args, input) => {
      calls.push({ args, input });
      const path = args[3];
      if (path === 'search/issues') {
        return '13\topen\n';
      }
      if (path === 'repos/QwenLM/qwen-code/issues/13/comments') {
        return [
          [
            '6',
            'maintainer',
            'COLLABORATOR',
            '2026-08-26T00:00:00Z',
            '2026-08-26T00:00:00Z',
            'u6',
            b64('@qwen-code /resolve'),
          ].join('\t'),
          [
            '7',
            BOT,
            'COLLABORATOR',
            '2026-08-26T01:00:00Z',
            '2026-08-26T01:00:00Z',
            'u7',
            b64(`${RESULT_MARKER}\n${PUSHED}`),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (path === 'repos/QwenLM/qwen-code/issues' && args[2] === 'GET') {
        return [
          [
            '92',
            'github-actions[bot]',
            '2026-08-20T00:00:00Z',
            '2026-08-20T00:00:00Z',
            b64(
              `${HEALTH_MARKER}\n<!-- qwen-resolve-health-state {"streak":5,"unanswered":0,"latest":3} -->`,
            ),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (path === 'repos/QwenLM/qwen-code/issues/92/comments') {
        return [
          [
            'stranger',
            '2026-08-26T02:00:00Z',
            '2026-08-26T02:00:00Z',
            b64(
              '<!-- qwen-resolve-health-state {"streak":0,"unanswered":0,"latest":7,"recovered":7} -->',
            ),
          ].join('\t'),
          '',
        ].join('\n');
      }
      if (args[2] === 'POST' || args[2] === 'PATCH') {
        return '{}';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const { actions } = main({
      gh,
      env: { REPO: 'QwenLM/qwen-code' },
      now: new Date('2026-08-27T12:00:00Z'),
    });
    assert.deepEqual(
      actions.map((a) => a.type),
      ['comment', 'close'],
    );
    assert.match(
      actions[0].body,
      /Recovered: the latest attempt .* is `pushed`/,
    );
  });

  it('keeps reporting when the tracking issue body was edited into the current state', () => {
    // Until the first update comment the body is the ONLY state source, so a
    // triage user editing its marker to the state the next tick computes
    // makes sameState() true and the watch reports nothing through an
    // evolving outage — and re-editing each tick is cheap. The decoy is the
    // cheaper shape of the same attack: plant a labelled issue carrying the
    // marker and a forged state, and the created-desc lookup adopts it
    // instead of the genuine one, which is then never updated or closed.
    const calls = [];
    const now = new Date('2026-08-27T12:00:00Z');
    const prs = fiveFailures();
    // The body the watch filed on the previous tick: its marker is the state
    // this tick computes, which is exactly what an attacker edits it into.
    const filed = decide(assess(prs, { now }), null)[0].body;
    const { actions } = main({
      gh: feedGh(calls, prs, [
        [99, filed, 'stranger', '2026-08-26T00:00:00Z'],
        [
          91,
          filed,
          'github-actions[bot]',
          '2026-08-25T00:00:00Z',
          '2026-08-26T09:00:00Z',
        ],
      ]),
      env: { REPO: 'QwenLM/qwen-code' },
      now,
    });
    assert.deepEqual(
      actions.map((a) => a.type),
      ['comment'],
    );
    assert.equal(actions[0].number, 91);
    assert.deepEqual(
      calls.filter((c) => c.args[2] === 'POST').map((c) => c.args[3]),
      ['repos/QwenLM/qwen-code/issues/91/comments'],
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

  it('runs on a schedule and can be dispatched with both knobs', () => {
    assert.ok(
      Array.isArray(workflow.on.schedule) && workflow.on.schedule.length === 1,
    );
    // The inputs are the operator's knobs; the env expressions above fall
    // back to the same defaults, so the two spellings must agree.
    const inputs = workflow.on.workflow_dispatch.inputs;
    assert.deepEqual(inputs.threshold, {
      description: 'Consecutive failures that raise the alarm (default 5)',
      required: false,
      default: String(DEFAULTS.threshold),
      type: 'string',
    });
    assert.deepEqual(inputs.unanswered, {
      description:
        'Requests with no result comment after 3h that raise the alarm (default 3)',
      required: false,
      default: String(DEFAULTS.unansweredThreshold),
      type: 'string',
    });
  });

  it('has its test wired into the CI helper-test list', () => {
    // HELPER_TESTS is the single list both runner profiles expand; membership
    // there, not a mention anywhere in the file, is what runs the test.
    const helperTests = parse(ci).env.HELPER_TESTS.split(/\s+/);
    assert.ok(helperTests.includes('.github/scripts/resolve-health.test.mjs'));
  });
});
