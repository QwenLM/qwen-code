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
const TRUSTED_ASSOC_LITERAL = `["${TRUSTED_ASSOC.join('", "')}"]`;

// The run-name formats are load-bearing cross-file contracts: the signal
// encodes the reviewed PR and reviewer for the bridge, and the bridge
// propagates the signal's title so the scan can verify fork-bridge
// provenance. Keep these in lockstep with the workflow files.
const SIGNAL_RUN_NAME = `fork-signal: PR \${{ github.event.pull_request.number }} reviewed by \${{ github.event.review.user.login }}`;
const BRIDGE_RUN_NAME =
  'fork-bridge: ${{ github.event.workflow_run.display_title }}';

// Does the file actually READ a secret, as opposed to naming one in prose?
// Both workflows explain themselves by referring to `secrets.CI_DEV_BOT_PAT`,
// so only an expression counts — and the expression scan must survive braces
// INSIDE the expression (`format('{0}', secrets.X)` or a fromJSON object
// literal), which a `[^}]*` body cannot cross. Scan each `${{ … }}`
// expression with a pass that skips single-quoted string literals (with `''`
// escapes) when locating the closing `}}`, then test the body.
const expressionsIn = (text) => {
  const expressions = [];
  let start = text.indexOf('${{');
  while (start !== -1) {
    let i = start + 3;
    let inString = false;
    let end = -1;
    while (i < text.length) {
      const ch = text[i];
      if (inString) {
        if (ch === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          inString = false;
        }
      } else if (ch === "'") {
        inString = true;
      } else if (ch === '}' && text[i + 1] === '}') {
        end = i;
        break;
      }
      i += 1;
    }
    if (end === -1) break;
    expressions.push(text.slice(start + 3, end));
    start = text.indexOf('${{', end + 2);
  }
  return expressions;
};
const readsASecret = (text) =>
  expressionsIn(text).some((expression) => /\bsecrets\./.test(expression));

describe('qwen autofix fork bridge', () => {
  it('keeps the trigger name and dispatch target wired together', () => {
    // Cross-FILE contracts that no single file can be read to verify. Each
    // one, broken, leaves both files individually valid and the bridge
    // permanently silent — the exact failure this suite exists to catch.

    // `workflow_run` matches on the triggering workflow's `name:`, not its
    // path, so renaming the signal workflow decouples the two silently.
    expect(bridge.on.workflow_run.workflows).toEqual([signal.name]);
    expect(bridge.on.workflow_run.types).toEqual(['completed']);

    // The signal side of the trigger contract: `pull_request_review` with
    // type `submitted`. Flipping the type (say to `dismissed`) leaves both
    // files individually valid and silently kills real-time fork-PR pickup.
    expect(Object.keys(signal.on)).toEqual(['pull_request_review']);
    expect(signal.on.pull_request_review.types).toEqual(['submitted']);

    // The dispatch target must exist and accept the inputs the bridge
    // passes — INCLUDING their types: the bridge sends `-f source=…` as a
    // string field, which GitHub rejects against a boolean input (every
    // dispatch failing after three retries), and shepherd/manual dispatches
    // omit both inputs, so neither may become required.
    expect(bridgeScript).toContain('gh workflow run qwen-autofix.yml');
    expect(bridgeScript).toContain('-f pr_number=');
    expect(bridgeScript).toContain('-f source=fork-bridge');
    expect(Object.keys(autofix.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(['pr_number', 'source']),
    );
    expect(autofix.on.workflow_dispatch.inputs.source.type).toBe('string');
    expect(autofix.on.workflow_dispatch.inputs.source.required).toBe(false);
    expect(autofix.on.workflow_dispatch.inputs.pr_number.type).toBe('string');
    expect(autofix.on.workflow_dispatch.inputs.pr_number.required).toBe(false);

    // The PR binding rides the signal's run-name (surfaced on the
    // workflow_run event as display_title) — there is NO artifact channel.
    // A resurrected one would reintroduce a binding that read a benign
    // concurrent push as a forgery.
    expect(signalText).not.toContain('upload-artifact');
    expect(signalText).not.toContain('pr-number.txt');
    expect(bridgeScript).not.toContain('gh run download');
    expect(signal['run-name']).toBe(SIGNAL_RUN_NAME);
    expect(bridge['run-name']).toBe(BRIDGE_RUN_NAME);
    expect(bridgeJob.env.SIGNAL_TITLE).toBe(
      '${{ github.event.workflow_run.display_title }}',
    );
    // The head SHA binding — the freshness gate the resolved PR is checked
    // against — and its parse format are pinned too: rebinding either to
    // `head_branch` silently resolves nothing forever (SHA-vs-branch
    // comparison), and a format change on either side breaks the parse.
    expect(bridgeJob.env.SIGNAL_HEAD_SHA).toBe(
      '${{ github.event.workflow_run.head_sha }}',
    );
    expect(bridgeScript).toContain(
      "TITLE_RE='^fork-signal: PR ([0-9]+) reviewed by (.+)$'",
    );
    // The bound PR is re-read live and re-checked against the reviewed
    // head — never enumerated-and-guessed.
    expect(bridgeScript).toContain('gh pr view "${SIGNAL_PR}"');
    expect(bridgeScript).toContain(
      '--json number,author,labels,headRefOid,isCrossRepository,maintainerCanModify,state,baseRefName',
    );
    expect(bridgeScript).toContain('headRefOid == $sha');
    expect(bridgeScript).toContain(
      '.state == "OPEN" and .baseRefName == "main"',
    );
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
    // one run is what makes a pwn-request worth attempting. The exact scope
    // set is pinned so future creep trips the test that polices it:
    // `contents: read` is not decorative — the reviewer live-permission
    // re-check reads the collaborators API, exactly as route does under the
    // same scope.
    expect(bridge.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(readsASecret(bridgeText)).toBe(false);
    expect(bridgeText).not.toContain('actions/checkout');

    // The detector itself must not be defeated by braces inside the
    // expression — proven payloads that a `[^}]*`-shaped scan lets through.
    expect(
      readsASecret('LEAKED: "${{ format(\'{0}\', secrets.CI_DEV_BOT_PAT) }}"'),
    ).toBe(true);
    expect(
      readsASecret('${{ fromJSON(\'{"a":1}\').a == secrets.CI_DEV_BOT_PAT }}'),
    ).toBe(true);
    // Plain reads are still caught, and prose stays clean.
    expect(readsASecret('X: "${{ secrets.CI_DEV_BOT_PAT }}"')).toBe(true);
    expect(readsASecret('prose about secrets.CI_DEV_BOT_PAT here')).toBe(false);
  });

  it('signals only the PRs the direct lane cannot serve', () => {
    // The whole gate is pinned VERBATIM: its connectives and branch order
    // are load-bearing (a flipped `||`/`&&` silently degrades fork reviews
    // to the throttled cron backstop or lets arbitrary PRs through), and a
    // substring pin cannot see them. Built from the pinned constants so a
    // change in qwen-autofix.yml fails HERE.
    expect(signalJob.if).toBe(
      [
        "${{ github.repository == 'QwenLM/qwen-code'",
        '&& github.event.pull_request.head.repo.full_name != github.repository',
        "&& github.event.pull_request.base.ref == 'main'",
        "&& github.event.pull_request.state == 'open'",
        '&& github.event.pull_request.maintainer_can_modify == true',
        `&& (github.event.pull_request.user.login == (vars.AUTOFIX_BOT_LOGIN || '${BOT_FALLBACK}')`,
        `|| contains(toJSON(github.event.pull_request.labels.*.name), '"${TAKEOVER_LABEL}"'))`,
        `&& !contains(toJSON(github.event.pull_request.labels.*.name), '"${SKIP_LABEL}"')`,
        `&& (contains(fromJSON('${TRUSTED_ASSOC_LITERAL}'), github.event.review.author_association)`,
        `|| github.event.review.user.login == '${REVIEW_BOT}') }}`,
      ].join('\n'),
    );

    // The scope guard keeps the chain inside this repository — pinned for
    // the bridge job as well.
    expect(bridgeJob.if).toBe(
      [
        "${{ github.repository == 'QwenLM/qwen-code'",
        "&& github.event.workflow_run.conclusion == 'success' }}",
      ].join('\n'),
    );

    // The bridge re-checks admission against LIVE state — consent can move
    // between the review and the dispatch — and SKIP wins everywhere. The
    // reviewer identity is re-checked LIVE too: association alone does not
    // guarantee write permission.
    expect(bridge.env.TAKEOVER_LABEL).toBe(TAKEOVER_LABEL);
    expect(bridge.env.SKIP_LABEL).toBe(SKIP_LABEL);
    expect(bridge.env.AUTOFIX_BOT).toBe(autofix.env.AUTOFIX_BOT);
    expect(bridge.env.REVIEW_BOT).toBe(REVIEW_BOT);
    expect(bridgeScript).toContain('maintainerCanModify == true');
    expect(bridgeScript).toContain('index($take)');
    expect(bridgeScript).toContain('index($skip)');
    expect(bridgeScript).toContain(
      'gh api "repos/${REPO}/collaborators/${SIGNAL_REVIEWER}/permission"',
    );
    expect(bridgeScript).toContain(
      'if [[ "${SIGNAL_REVIEWER}" != "${REVIEW_BOT}" ]]; then',
    );
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

    // The takeover and skip labels in the gate are quoted as JSON-array
    // ELEMENTS so a longer label sharing the prefix cannot match.
    expect(signalJob.if).toContain(`'"${TAKEOVER_LABEL}"'`);
    expect(signalJob.if).toContain(`'"${SKIP_LABEL}"'`);
  });

  it('isolates gated-out runs so they cannot cancel the real ones', () => {
    // Signal: concurrency is evaluated BEFORE the job `if:`, so an untrusted
    // review would otherwise cancel a queued or in-flight trusted signal and
    // then skip its own job — silently dropping the maintainer's review.
    // Trusted reviews coalesce per PR; everything else gets a run-unique
    // group, mirroring route's pattern. Pinned VERBATIM: the `&&`/`||` glue
    // between the trust clause and the two formats is exactly what routes a
    // review to one group or the other, and substring pins cannot see a
    // flipped connective.
    expect(signal.concurrency.group).toBe(
      "${{ (contains(fromJSON('" +
        TRUSTED_ASSOC_LITERAL +
        "'), github.event.review.author_association) || github.event.review.user.login == '" +
        REVIEW_BOT +
        "') && format('qwen-autofix-fork-signal-pr-{0}', github.event.pull_request.number) || format('qwen-autofix-fork-signal-{0}', github.run_id) }}",
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

  it('keeps bridged dispatches run-unique and wires source for provenance', () => {
    // `source` is a public workflow_dispatch input, so no dispatch may earn
    // trusted per-PR coalescing by asserting an origin: route keeps EVERY
    // dispatch in a run-unique never-cancelled group, and fork-review bursts
    // coalesce upstream instead (the signal per PR, the bridge per
    // conclusion+head). The marker's one remaining effect — staying quiet at
    // the round cap — is honored by review-scan only after verifying
    // provenance (pinned behaviorally in qwen-autofix-workflow.test.js).
    expect(routeConcurrency.group).not.toContain('inputs.source');
    expect(routeConcurrency.group).not.toContain('forkbridge');
    expect(routeConcurrency['cancel-in-progress']).toBe(
      "${{ github.event_name != 'workflow_dispatch' }}",
    );

    // The wiring the scan's provenance check relies on: the marker reaches
    // review-scan as DISPATCH_SOURCE, and the bridge names the PR in its run
    // title so the scan has something GitHub-owned to match.
    expect(autofixText).toContain(
      "DISPATCH_SOURCE: \"${{ github.event_name == 'workflow_dispatch' && inputs.source || '' }}\"",
    );
  });

  it('keeps the shepherd attribution honest about foreign dispatches', () => {
    // The shepherd correlates its own liveness dispatch by polling for
    // dispatches created since T0. The bridge dispatches autonomously at
    // arbitrary times, and GitHub may expose a foreign dispatch before the
    // shepherd's own run appears — so an ambiguous window records run=none,
    // and a singleton is accepted only once it survives a second consecutive
    // poll (never on first sight). Behavioral proof lives in the shepherd
    // suite; this pins the mechanism's presence across the file boundary.
    expect(shepherdText).toContain('DISPATCH_T0=');
    expect(shepherdText).toContain('--event workflow_dispatch --limit 5');
    expect(shepherdText).toContain('[ .[] | select(.createdAt >= $t0) ]');
    expect(shepherdText).toContain('if [[ "${COUNT}" == "1" ]]; then');
    expect(shepherdText).toContain('attribution ambiguous');
    expect(shepherdText).toContain('two consecutive polls');
  });

  it('documents what #8671 actually changed', () => {
    // The signal header used to cite route's `secretless` output — a
    // mechanism #8671 never shipped (it declined fork reviews inline in
    // route and added the empty-PAT fail-fast instead, recording the
    // route-output design as the rejected alternative). The header must say
    // what actually happened, and nothing may pin the wrong word again.
    expect(signalText).not.toContain('secretless');
    expect(signalText).not.toContain('REQUIRES #8671');
    expect(signalText).toContain('63a99c2c11');
    expect(signalText).toContain(
      "route's decide script declines\n# fork `pull_request_review` events inline",
    );
    expect(signalText).toContain(
      'review-scan fails fast at the\n# top on an empty PAT',
    );
  });

  it('resolves the bound PR and dispatches it alone', () => {
    // The review's PR number and reviewer ride the signal's run-name — a
    // base-branch file the fork cannot edit — so a head SHA shared by two
    // open fork PRs dispatches only the reviewed one, and the reviewer's
    // LIVE permission is re-checked before the secret-bearing lane starts.
    // Replayed against a stub API.
    const managedForkPr = (over = {}) => ({
      number: 8436,
      author: { login: BOT_FALLBACK },
      labels: [],
      headRefOid: 'b8ac04ef',
      isCrossRepository: true,
      maintainerCanModify: true,
      state: 'OPEN',
      baseRefName: 'main',
      ...over,
    });
    const runBridge = ({
      signalTitle = 'fork-signal: PR 8436 reviewed by a-maintainer',
      signalHeadSha = 'b8ac04ef',
      viewed = managedForkPr(),
      viewFails = false,
      reviewerPermission = 'write',
      permissionLookupFails = false,
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
if [[ "$1" == 'api' ]]; then
  ${permissionLookupFails ? 'exit 1' : ''}
  printf '%s' '${reviewerPermission}'
  exit 0
fi
if [[ "$1" == 'pr' && "$2" == 'view' ]]; then
  ${viewFails ? 'exit 1' : ''}
  printf '%s' '${JSON.stringify(viewed).replace(/'/g, "'\\''")}'
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
              SIGNAL_TITLE: signalTitle,
              GITHUB_TOKEN: 'stub',
              GITHUB_SERVER_URL: 'https://github.com',
              GITHUB_STEP_SUMMARY: summaryFile,
              AUTOFIX_BOT: BOT_FALLBACK,
              REVIEW_BOT,
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

    // Happy path: a trusted reviewer, and the bound PR still carries the
    // reviewed head and is still managed.
    const ok = runBridge({});
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(ok.calls).toContain('collaborators/a-maintainer/permission');
    expect(ok.calls).toContain('pr_number=8436');
    expect(ok.calls).toContain('source=fork-bridge');
    expect(ok.calls.match(/workflow run/g) ?? []).toHaveLength(1);
    expect(ok.stdout).toContain('dispatched the autofix review lane');
    expect(ok.summary).toContain('#8436');

    // The review bot keeps its route-mirrored exception: dispatched without
    // any collaborator-permission lookup.
    const botReview = runBridge({
      signalTitle: `fork-signal: PR 8436 reviewed by ${REVIEW_BOT}`,
    });
    expect(botReview.status).toBe(0);
    expect(botReview.calls).toContain('pr_number=8436');
    expect(botReview.calls).not.toContain('collaborators/');

    // A bot-suffixed reviewer (org-member app) parses and dispatches too —
    // the capture must not choke on the brackets.
    const botSuffix = runBridge({
      signalTitle: 'fork-signal: PR 8436 reviewed by some-app[bot]',
    });
    expect(botSuffix.status).toBe(0);
    expect(botSuffix.calls).toContain('pr_number=8436');

    // A below-write reviewer is declined LIVE, exactly as the direct lane
    // declines the same review; a failed lookup fails the same way closed.
    for (const over of [
      { reviewerPermission: 'triage' },
      { reviewerPermission: 'read' },
      { reviewerPermission: '' },
      { permissionLookupFails: true },
    ]) {
      const declined = runBridge(over);
      expect(declined.status).toBe(0);
      expect(declined.stdout).toContain('below write');
      expect(declined.calls).not.toContain('workflow run');
    }

    // An unparseable run title is a broken signal/bridge contract — red,
    // never a silent no-op or a guessed dispatch.
    const unparseable = runBridge({ signalTitle: 'some unexpected title' });
    expect(unparseable.status).toBe(1);
    expect(unparseable.stdout).toContain('could not parse the PR binding');
    expect(unparseable.calls).not.toContain('workflow run');

    // A benign concurrent push: the head moved between the review and the
    // bridge. Green no-op — NOT a red run reading the race as a forgery —
    // and nothing is dispatched on a stale head.
    const moved = runBridge({ signalHeadSha: 'deadbeef' });
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain('no longer carries head');
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
      { state: 'CLOSED' }, // closed since the review
      { baseRefName: 'release' }, // retargeted away from main
    ]) {
      const withdrawn = runBridge({ viewed: managedForkPr(over) });
      expect(withdrawn.status).toBe(0);
      expect(withdrawn.calls).not.toContain('workflow run');
    }

    // A takeover-labeled human PR with edits on IS dispatched — to the
    // bound number only, even though the head could be shared.
    const takeover = runBridge({
      signalTitle: 'fork-signal: PR 900 reviewed by a-maintainer',
      viewed: managedForkPr({
        number: 900,
        author: { login: 'a-contributor' },
        labels: [{ name: TAKEOVER_LABEL }],
      }),
    });
    expect(takeover.status).toBe(0);
    expect(takeover.calls).toContain('pr_number=900');
    expect(takeover.calls.match(/pr_number=/g) ?? []).toHaveLength(1);

    // An unreadable bound PR is red: the bridge cannot tell a signal it
    // should have served from one it should not, and staying silent would
    // look exactly like a healthy bridge with nothing to do.
    expect(runBridge({ viewFails: true }).status).toBe(1);

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
