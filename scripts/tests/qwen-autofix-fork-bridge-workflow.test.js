/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const signalPath = '.github/workflows/qwen-autofix-fork-signal.yml';
const bridgePath = '.github/workflows/qwen-autofix-fork-bridge.yml';
const autofixPath = '.github/workflows/qwen-autofix.yml';
const shepherdPath = '.github/workflows/qwen-fleet-shepherd.yml';
const signalText = readFileSync(signalPath, 'utf8');
const bridgeText = readFileSync(bridgePath, 'utf8');
const autofixText = readFileSync(autofixPath, 'utf8');
const shepherdText = readFileSync(shepherdPath, 'utf8');
const signal = parse(signalText);
const bridge = parse(bridgeText);
const autofix = parse(autofixText);

const signalJob = signal.jobs.signal;
const bridgeJob = bridge.jobs.dispatch;
const bridgeScript = bridgeJob.steps[0].run;
const routeConcurrency = autofix.jobs.route.concurrency;

// Identity literals live in qwen-autofix.yml's top-level env; the fork bridge
// must mirror them, not fork its own copies (see the pinning test below).
const REVIEW_BOT = autofix.env.REVIEW_BOT;
const TRUSTED_ASSOC = JSON.parse(autofix.env.TRUSTED_ASSOC);
const TAKEOVER_LABEL = autofix.env.TAKEOVER_LABEL;
const SKIP_LABEL = autofix.env.SKIP_LABEL;
const BOT_FALLBACK = autofix.env.AUTOFIX_BOT.match(
  /vars\.AUTOFIX_BOT_LOGIN \|\| '([^']+)'/,
)?.[1];

// Does the file actually READ a secret, as opposed to naming one in prose?
// Both workflows explain themselves by referring to `secrets.CI_DEV_BOT_PAT`,
// so only an expression counts.
const readsASecret = (text) => /\$\{\{[^}]*\bsecrets\./.test(text);

describe('qwen autofix fork bridge', () => {
  it('keeps the trigger name and dispatch target wired together', () => {
    // Cross-FILE contracts that no single file can be read to verify. Each
    // one, broken, leaves both files individually valid and the bridge
    // permanently silent — the exact failure this suite exists to catch.

    // `workflow_run` matches on the triggering workflow's `name:`, not its
    // path, so renaming the signal workflow decouples the two silently.
    expect(bridge.on.workflow_run.workflows).toEqual([signal.name]);
    expect(bridge.on.workflow_run.types).toEqual(['completed']);

    // The dispatch target must exist and accept the inputs the bridge passes.
    // `source` is load-bearing twice over: route's concurrency coalesces
    // fork-bridge dispatches per PR, and the cap-refusal guard stays quiet
    // for them (both pinned below).
    expect(bridgeScript).toContain('gh workflow run qwen-autofix.yml');
    expect(bridgeScript).toContain('-f pr_number=');
    expect(bridgeScript).toContain('-f source=fork-bridge');
    expect(Object.keys(autofix.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(['pr_number', 'source']),
    );

    // The PR number is resolved from the run head SHA — there is NO artifact
    // channel anymore. A resurrected one would reintroduce the binding that
    // read a benign concurrent push as a forgery.
    expect(signalText).not.toContain('upload-artifact');
    expect(signalText).not.toContain('pr-number.txt');
    expect(bridgeScript).not.toContain('gh run download');
    expect(bridgeScript).toContain('gh pr list');
    expect(bridgeScript).toContain('--state open --base main');
    expect(bridgeScript).toContain('headRefOid == $sha');
  });

  it('gives the fork-triggered half nothing worth stealing', () => {
    // The signal is the ONLY half a fork PR's event can reach. GitHub already
    // withholds secrets there, but the token is not withheld — so the
    // permissions are emptied explicitly, and nothing in it may read a secret
    // or run repository code.
    expect(signal.permissions).toEqual({});
    // Matched as an EXPRESSION, not as a substring: both files discuss
    // `secrets.CI_DEV_BOT_PAT` in prose to explain why they exist, and a
    // grep-shaped assertion would either fail on that prose or be deleted.
    expect(readsASecret(signalText)).toBe(false);
    expect(signalText).not.toContain('actions/checkout');
    // Never the persistent pool: a self-hosted workspace outlives the job,
    // and fork-triggered work must not land in one.
    // Pinned as the resolved value, not as the absence of the word
    // "self-hosted" — the comment above the field explains the rule and
    // would fail a substring check.
    expect(signalJob['runs-on']).toBe('ubuntu-latest');

    // The bridge holds real power (`actions: write` dispatches the lane that
    // pushes commits), so it must not ALSO hold the PAT — that combination in
    // one run is what makes a pwn-request worth attempting.
    expect(bridge.permissions.actions).toBe('write');
    expect(readsASecret(bridgeText)).toBe(false);
    expect(bridgeText).not.toContain('actions/checkout');
  });

  it('signals only the PRs the direct lane cannot serve', () => {
    const gate = signalJob.if;
    // Fork-only. In-repo PRs keep their secrets and are served by
    // qwen-autofix.yml directly; signalling them would dispatch a duplicate
    // scan for every review the repository receives.
    expect(gate).toContain(
      'github.event.pull_request.head.repo.full_name != github.repository',
    );
    expect(gate).toContain("github.event.pull_request.base.ref == 'main'");
    expect(gate).toContain("github.event.pull_request.state == 'open'");
    // Route's fork admission prefilter, mirrored: without these, every
    // collaborator review of ANY open fork PR would burn a signal + bridge +
    // dispatched run just so review-scan can reject it as unmanaged, and a
    // takeover PR whose author turned maintainer edits off would be pushed
    // into the credentialed lane to receive a ⛔ blocked comment where the
    // direct lane stayed silent.
    expect(gate).toContain(
      'github.event.pull_request.maintainer_can_modify == true',
    );
    expect(gate).toContain(`vars.AUTOFIX_BOT_LOGIN || '${BOT_FALLBACK}'`);
    expect(gate).toContain(`'"${TAKEOVER_LABEL}"'`);
    // The same trust rule route applies, so an untrusted review does not
    // spend a bridge run. Not the authorisation — the bridge re-reads live
    // state and review-scan re-derives admission.
    expect(gate).toContain('github.event.review.author_association');
    expect(gate).toContain(`github.event.review.user.login == '${REVIEW_BOT}'`);

    // A signal that gated itself out completes `skipped`; the bridge must not
    // treat that as something to act on.
    expect(bridgeJob.if).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );

    // The bridge re-checks admission against LIVE state — consent can move
    // between the review and the dispatch — and SKIP wins everywhere.
    expect(bridge.env.TAKEOVER_LABEL).toBe(TAKEOVER_LABEL);
    expect(bridge.env.SKIP_LABEL).toBe(SKIP_LABEL);
    expect(bridge.env.AUTOFIX_BOT).toBe(autofix.env.AUTOFIX_BOT);
    expect(bridgeScript).toContain('maintainerCanModify == true');
    expect(bridgeScript).toContain('index($take)');
    expect(bridgeScript).toContain('index($skip)');
  });

  it('keeps every identity literal pinned to qwen-autofix.yml', () => {
    // The fork bridge cannot import qwen-autofix.yml's env, so the copies it
    // must make are pinned HERE: if the review-bot identity, the trust list,
    // the labels, or the bot login ever change there, this test fails
    // instead of the signal silently stopping to fire.

    // The review-bot login appears in BOTH the job gate and the trust-keyed
    // concurrency group; every occurrence must equal REVIEW_BOT.
    const botComparisons =
      signalText.match(/github\.event\.review\.user\.login == '([^']+)'/g) ??
      [];
    expect(botComparisons.length).toBeGreaterThanOrEqual(2);
    for (const comparison of botComparisons) {
      expect(comparison).toBe(
        `github.event.review.user.login == '${REVIEW_BOT}'`,
      );
    }

    // Every fromJSON'd association list (job gate + concurrency group) must
    // equal TRUSTED_ASSOC.
    const assocLiterals = [
      ...signalText.matchAll(/fromJSON\('(\[[^\]]*\])'\)/g),
    ].map((m) => JSON.parse(m[1]));
    expect(assocLiterals.length).toBeGreaterThanOrEqual(2);
    for (const list of assocLiterals) {
      expect(list).toEqual(TRUSTED_ASSOC);
    }

    // The takeover label in the gate is quoted as a JSON-array ELEMENT so a
    // longer label sharing the prefix cannot match.
    expect(signalJob.if).toContain(`'"${TAKEOVER_LABEL}"'`);
  });

  it('isolates gated-out runs so they cannot cancel the real ones', () => {
    // Signal: concurrency is evaluated BEFORE the job `if:`, so an untrusted
    // review would otherwise cancel a queued or in-flight trusted signal and
    // then skip its own job — silently dropping the maintainer's review.
    // Trusted reviews coalesce per PR; everything else gets a run-unique
    // group, mirroring route's pattern.
    const signalGroup = signal.concurrency.group;
    expect(signalGroup).toContain(
      "format('qwen-autofix-fork-signal-pr-{0}', github.event.pull_request.number)",
    );
    expect(signalGroup).toContain(
      "format('qwen-autofix-fork-signal-{0}', github.run_id)",
    );
    expect(signal.concurrency['cancel-in-progress']).toBe(true);

    // Bridge: EVERY signal run fires `workflow_run: completed` — skipped and
    // cancelled ones included. Without the conclusion in the group key, a
    // skipped bridge run would cancel the in-flight real one and then skip
    // its own job; repeating the ungated review could hold the bridge off a
    // fork PR indefinitely.
    expect(bridge.concurrency.group).toBe(
      'qwen-autofix-fork-bridge-${{ github.event.workflow_run.conclusion }}-${{ github.event.workflow_run.head_sha }}',
    );
    expect(bridge.concurrency['cancel-in-progress']).toBe(true);
  });

  it('coalesces bridged dispatches per PR and keeps them quiet at the cap', () => {
    // Route maps plain dispatches to a run-unique never-cancelled group
    // (human/shepherd dispatches are one-shot intents), but fork-bridge
    // dispatches are reviews laundered into dispatch form: a review burst on
    // one fork PR must coalesce per PR with cancellation, exactly like
    // review events, instead of serializing N full autofix runs behind the
    // per-PR lock.
    expect(routeConcurrency.group).toContain("inputs.source == 'fork-bridge'");
    expect(routeConcurrency.group).toContain(
      "format('qwen-autofix-forkbridge-pr-{0}', inputs.pr_number)",
    );
    // Guarded by the pr_number conjunct: a source-only dispatch could not
    // funnel unrelated runs into one shared group.
    expect(routeConcurrency.group).toContain("inputs.pr_number != ''");
    expect(routeConcurrency['cancel-in-progress']).toBe(
      "${{ github.event_name != 'workflow_dispatch' || inputs.source == 'fork-bridge' }}",
    );

    // The loud cap-refusal comment exists for EXPLICIT dispatches (the
    // shepherd's conflict lever, a human). A fork-bridge dispatch is a review
    // submission in dispatch clothing: answering each one loudly would post
    // one refusal per review on a capped fork PR — the exact #7836 spam the
    // event-name conjunct was added to prevent. Replay the guard VERBATIM so
    // a dropped condition fails the test, not just a substring.
    expect(autofixText).toContain(
      "DISPATCH_SOURCE: \"${{ github.event_name == 'workflow_dispatch' && inputs.source || '' }}\"",
    );
    const refusedGuard = autofixText.match(
      /(if \[\[ -n "\$\{FORCED_PR\}" && "\$\{FORCED_PR\}" == "\$\{PR\}" && "\$\{EVENT_NAME\}" == 'workflow_dispatch' && "\$\{DISPATCH_SOURCE\}" != 'fork-bridge' \]\]; then)/,
    )?.[1];
    expect(refusedGuard).toBeTruthy();
    const refuses = (eventName, dispatchSource) =>
      spawnSync('bash', ['-c', `${refusedGuard}\necho REFUSED\nfi`], {
        env: {
          ...process.env,
          FORCED_PR: '7836',
          PR: '7836',
          EVENT_NAME: eventName,
          DISPATCH_SOURCE: dispatchSource,
        },
        encoding: 'utf8',
      }).stdout;
    expect(refuses('workflow_dispatch', '')).toContain('REFUSED');
    expect(refuses('workflow_dispatch', 'fork-bridge')).not.toContain(
      'REFUSED',
    );
    expect(refuses('pull_request_review', '')).not.toContain('REFUSED');
  });

  it('keeps the shepherd attribution honest about foreign dispatches', () => {
    // The shepherd correlates its own liveness dispatch by polling for
    // dispatches created since T0. The bridge dispatches autonomously at
    // arbitrary times, so the window can hold TWO dispatches — attributing
    // the wrong one would track a run the shepherd does not own. An
    // ambiguous window must record run=none (the documented fallback: a
    // duplicate scan, never starvation), never a guess.
    expect(shepherdText).toContain('DISPATCH_T0=');
    expect(shepherdText).toContain('--event workflow_dispatch --limit 5');
    expect(shepherdText).toContain('[ .[] | select(.createdAt >= $t0) ]');
    expect(shepherdText).toContain('if [[ "${COUNT}" == "1" ]]; then');
    expect(shepherdText).toContain('attribution ambiguous');
  });

  it('documents the #8671 dependency instead of assuming it', () => {
    // The signal header used to cite route's `secretless` output as if it
    // existed; it only arrives with #8671. Until then the direct lane still
    // fires and reds out on the empty PAT — the header must say so, and name
    // the merge ordering.
    expect(signalText).toContain('REQUIRES #8671');
    expect(signalText).toContain('secretless');
    expect(signalText).toContain('merge ordering');
  });

  it('resolves the PR from the reviewed head SHA', () => {
    // `workflow_run.pull_requests` is EMPTY for fork PRs and
    // `/commits/{sha}/pulls` does not resolve a fork head either, so the PR
    // is found by enumerating which open fork PR currently carries the
    // signal run's head SHA — and every admission gate is re-applied to that
    // live state. Replayed against a stub API.
    const managedForkPr = (over = {}) => ({
      number: 8436,
      author: { login: BOT_FALLBACK },
      labels: [],
      headRefOid: 'b8ac04ef',
      isCrossRepository: true,
      maintainerCanModify: true,
      ...over,
    });
    const runBridge = ({
      prList = [managedForkPr()],
      signalHeadSha = 'b8ac04ef',
      prListFails = false,
      dispatchFails = 0,
    }) => {
      const dir = mkdtempSync(join(tmpdir(), 'fork-bridge-'));
      try {
        const callsFile = join(dir, 'calls');
        const summaryFile = join(dir, 'summary');
        writeFileSync(callsFile, '');
        writeFileSync(summaryFile, '');
        writeFileSync(
          join(dir, 'gh'),
          `#!/bin/bash
printf '%q ' "$@" >> '${callsFile}'
printf '\\n' >> '${callsFile}'
if [[ "$1" == 'pr' && "$2" == 'list' ]]; then
  ${prListFails ? 'exit 1' : ''}
  printf '%s' '${JSON.stringify(prList).replace(/'/g, "'\\''")}'
  exit 0
fi
if [[ "$1" == 'workflow' && "$2" == 'run' ]]; then
  n="$(cat '${dir}/dispatches' 2>/dev/null || echo 0)"
  n=$(( n + 1 )); printf '%s' "$n" > '${dir}/dispatches'
  [[ "$n" -le ${dispatchFails} ]] && exit 1
  exit 0
fi
exit 1
`,
        );
        chmodSync(join(dir, 'gh'), 0o755);
        const result = spawnSync(
          'bash',
          [
            '-c',
            // Production shell for a `run:` step under `defaults.run.shell:
            // bash` — errexit and pipefail both live.
            ['set -eo pipefail', 'sleep() { :; }', bridgeScript].join('\n'),
          ],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              REPO: 'QwenLM/qwen-code',
              SIGNAL_HEAD_SHA: signalHeadSha,
              GITHUB_TOKEN: 'stub',
              GITHUB_SERVER_URL: 'https://github.com',
              GITHUB_STEP_SUMMARY: summaryFile,
              AUTOFIX_BOT: BOT_FALLBACK,
              TAKEOVER_LABEL,
              SKIP_LABEL,
            },
            encoding: 'utf8',
          },
        );
        return {
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          calls: readFileSync(callsFile, 'utf8'),
          summary: readFileSync(summaryFile, 'utf8'),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // Happy path: the reviewed head is still the PR's head and the PR is
    // still managed.
    const ok = runBridge({});
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(ok.calls).toContain('pr_number=8436');
    expect(ok.calls).toContain('source=fork-bridge');
    expect(ok.stdout).toContain('dispatched the autofix review lane');
    expect(ok.summary).toContain('#8436');

    // A benign concurrent push: the head moved between the review and the
    // bridge. Green no-op — NOT a red run reading the race as a forgery —
    // and nothing is dispatched on a stale head.
    const moved = runBridge({ signalHeadSha: 'deadbeef' });
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain('no eligible fork PR carries head');
    expect(moved.calls).not.toContain('workflow run');

    // Admission re-derived from live state: each withdrawn consent is a
    // green no-op, never a dispatched run.
    for (const over of [
      { maintainerCanModify: false }, // edits turned off since the review
      { isCrossRepository: false }, // retargeted/converted to in-repo
      {
        author: { login: 'a-contributor' },
      }, // neither bot-authored nor takeover-labeled
      { labels: [{ name: SKIP_LABEL }, { name: TAKEOVER_LABEL }] }, // skip wins
    ]) {
      const withdrawn = runBridge({ prList: [managedForkPr(over)] });
      expect(withdrawn.status).toBe(0);
      expect(withdrawn.calls).not.toContain('workflow run');
    }

    // A takeover-labeled human PR with edits on IS dispatched.
    const takeover = runBridge({
      prList: [
        managedForkPr({
          number: 900,
          author: { login: 'a-contributor' },
          labels: [{ name: TAKEOVER_LABEL }],
        }),
      ],
    });
    expect(takeover.status).toBe(0);
    expect(takeover.calls).toContain('pr_number=900');

    // Two open fork PRs sharing one head SHA is already ambiguous — the
    // review could have targeted either — so every match is dispatched.
    const shared = runBridge({
      prList: [
        managedForkPr({ number: 1 }),
        managedForkPr({
          number: 2,
          author: { login: 'a-contributor' },
          labels: [{ name: TAKEOVER_LABEL }],
        }),
      ],
    });
    expect(shared.status).toBe(0);
    expect(shared.calls).toContain('pr_number=1');
    expect(shared.calls).toContain('pr_number=2');

    // Closed/retargeted away entirely: the enumeration is empty or the
    // state no longer matches — green no-op.
    const gone = runBridge({ prList: [] });
    expect(gone.status).toBe(0);
    expect(gone.calls).not.toContain('workflow run');

    // An unreadable enumeration is red: the bridge cannot tell a signal it
    // should have served from one it should not, and staying silent would
    // look exactly like a healthy bridge with nothing to do.
    expect(runBridge({ prListFails: true }).status).toBe(1);

    // A transient dispatch failure retries; a persistent one reds the run
    // after three attempts instead of dropping the review on the floor.
    const flaky = runBridge({ dispatchFails: 1 });
    expect(flaky.status).toBe(0);
    expect(flaky.stdout).toContain('dispatched the autofix review lane');
    expect(flaky.calls.match(/workflow run/g) ?? []).toHaveLength(2);
    const dead = runBridge({ dispatchFails: 9 });
    expect(dead.status).toBe(1);
    expect(dead.stderr).toContain('(attempt 3/3)');
    expect(dead.calls.match(/workflow run/g) ?? []).toHaveLength(3);
  });
});
