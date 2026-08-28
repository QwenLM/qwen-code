/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The macOS and Windows lanes, and the gate that decides when they run.
//
// They were gated on `merge_group` alone while no merge queue was enabled, so
// they had not run since 2026-07-02: reported as "skipped" on every pull
// request — which reads as agreement — and never reached afterwards. The
// repository's only non-Linux, non-GNU signal was silently off, and a macOS
// failure shipped and sat in `main` (#9220). Nothing here can prove a lane
// ran; what these tests hold is the wiring that lets it: the triggers, the
// nightly's blast radius, and the alerting that makes a nightly failure
// visible.
//
// The pull-request trigger and its platform-sensitivity classifier are OFF
// while the standing Windows failures are being fixed (see the note above
// test_macos in ci.yml): on pull requests the Windows lane was reporting
// failures on every PR for defects no PR caused, and neither lane gates a
// merge. That leaves the nightly as the lanes' ONLY live trigger, so the
// assertions here are the wiring that keeps it alive — the schedule exists,
// both lanes accept it, nothing else rides it, and its failure files an
// issue. Restoring the pull-request path means reverting the commit that
// carried this change; the classifier script and its tests were left in
// place so that stays a revert.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const failureIssue = parse(
  readFileSync('.github/workflows/main-ci-failure-issue.yml', 'utf8'),
);
// `on:` parses as the boolean true in YAML 1.1.
const triggers = ci[true] ?? ci['on'];
const LANES = ['test_macos', 'test_windows'];
const PUSH_JOBS = ['classify_pr', 'test'];
const condOf = (job) => String(ci.jobs[job].if ?? '');

// One helper for both "an <event> run reaches exactly these jobs" invariants.
// They started as hand-copies and had already diverged: the push mirror's
// allowlist gained `schedule` while the nightly's never gained `push`, so a
// push-only job would have failed the nightly assertion with the factually
// wrong message `<job> would also run on the nightly schedule`, pointing the
// fixer at the wrong event. Parameterising makes that class of drift
// impossible — both call sites now share one allowlist shape.
const assertEventReachesOnly = (event, allowedJobs, allowlist) => {
  const allowRe = new RegExp(
    `github\\.event_name == '(${allowlist.join('|')})'`,
  );
  for (const [name, job] of Object.entries(ci.jobs)) {
    if (allowedJobs.includes(name)) continue;
    const cond = String(job.if ?? '');
    const excluded =
      cond.includes(`github.event_name != '${event}'`) || allowRe.test(cond);
    expect(excluded, `${name} would also run on ${event}`).toBe(true);
    // Mentioning an allowlisted event is not the same as excluding this one:
    // `event == 'pull_request' || event == '<event>'` satisfies the check
    // above while still running. Require the impossibility.
    expect(cond, `${name} admits ${event} explicitly`).not.toContain(
      `github.event_name == '${event}'`,
    );
    expect(cond, `${name} has no event gate at all`).not.toBe('');
  }
};

describe('platform lanes — triggers', () => {
  it('gives the workflow a scheduled trigger', () => {
    // Without it the lanes have no path to `main` at all: `ci.yml`'s push
    // trigger is accepted only by `test` and the `classify_pr` it depends on,
    // so a merge-queue-only gate on a repository with no merge queue is an off
    // switch for these two.
    expect(triggers.schedule).toBeDefined();
    expect(Array.isArray(triggers.schedule)).toBe(true);
    expect(triggers.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
  });

  for (const lane of LANES) {
    it(`${lane} runs on the schedule, the queue, and a dispatch`, () => {
      const cond = condOf(lane);
      // Presence AND the disjunction between clauses: an `&&` where a `||`
      // belongs leaves the gate unsatisfiable for a trigger (event_name is
      // single-valued) while a presence-only check stays green.
      expect(cond).toMatch(/event_name == 'merge_group'\s*\|\|/);
      expect(cond).toMatch(/event_name == 'schedule'\s*\|\|/);
      expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    });

    it(`${lane} stays off the pull-request path while it is red there`, () => {
      // Half a restoration is worse than none: a pull_request arm put back
      // without its classifier (or the reverse) either runs the lanes on
      // every PR or consults an output no job produces. Restore the trigger
      // by reverting the commit that removed it, not by editing one side.
      const cond = condOf(lane);
      expect(cond).not.toContain("'pull_request'");
      expect(cond).not.toContain('platform_sensitive');
      expect(ci.jobs[lane].needs).not.toContain('classify_platform');
    });

    it(`${lane}'s triggers are alternatives, not requirements`, () => {
      // The clause-presence assertions above survive a connective mutation:
      // `||` → `&&` between two event clauses leaves every string in place
      // and makes the gate unsatisfiable for every trigger, silently turning
      // both lanes off again — the exact state this PR exists to end. Read
      // the event group and require it to be a disjunction.
      const cond = condOf(lane).replace(/\s+/g, ' ');
      // From the first event clause to the close of the group — not from the
      // first `(`, which belongs to `!cancelled()`.
      const group = cond.slice(
        cond.indexOf('github.event_name'),
        cond.lastIndexOf(')'),
      );
      expect(group).toContain("github.event_name == 'schedule'");
      expect(group.split('||').length).toBeGreaterThanOrEqual(3);
      for (const clause of group.split('||')) {
        expect(
          clause,
          `event clause is conjoined: ${clause.trim()}`,
        ).not.toContain('&&');
      }
    });

    it(`${lane} survives an upstream skip`, () => {
      // classify_pr is still a `needs` edge; without `!cancelled()` a skip
      // or failure there would skip the lane on the nightly too.
      expect(condOf(lane)).toContain('!cancelled()');
    });
  }

  for (const lane of LANES) {
    it(`${lane} is bounded so a hang cannot burn the 360-minute default`, () => {
      // The nightly's alert fires only when the run completes; a lane hung
      // on a host-specific prompt otherwise sits out GitHub's default
      // timeout before it fails and anyone is told.
      expect(ci.jobs[lane]['timeout-minutes'], lane).toBe(60);
    });
  }

  for (const lane of LANES) {
    it(`${lane}'s steps are gated for every trigger it now has`, () => {
      // The first thing the revived triggers hit was not a test failure but
      // the lane's own plumbing: a `verify-checkout-head` step written when
      // this lane ran in the merge queue alone, with `expected_sha` naming
      // only `github.event.merge_group.head_sha`. On a pull request that
      // input is empty and the step fails the lane before a single test
      // runs. A step whose inputs name one event must be gated to that
      // event — for every step in a job that now runs on four.
      for (const step of ci.jobs[lane].steps ?? []) {
        // Every place a step can read an event context, not just `with:` —
        // an interpolation in `run:` or `env:` is the same defect wearing a
        // different key.
        const inputs = JSON.stringify({
          with: step.with ?? {},
          env: step.env ?? {},
          run: step.run ?? '',
        });
        const gate = String(step.if ?? '');
        for (const [context, event] of [
          ['github.event.merge_group', "'merge_group'"],
          ['github.event.pull_request', "'pull_request'"],
        ]) {
          if (!inputs.includes(context)) continue;
          const guarded =
            inputs.includes(`github.event_name == ${event}`) ||
            gate.includes(`github.event_name == ${event}`);
          expect(
            guarded,
            `${lane} step "${step.name}" reads ${context} on every trigger`,
          ).toBe(true);
        }
      }
    });
  }

  it('keeps a nightly run to exactly the two lanes', () => {
    // A `schedule:` trigger fires the whole workflow. Every other job must
    // therefore either exclude `schedule` outright or gate on an event
    // allowlist that cannot contain it — otherwise the nightly quietly
    // becomes a full CI run every day.
    assertEventReachesOnly('schedule', LANES, [
      'pull_request',
      'merge_group',
      'workflow_dispatch',
      'push',
    ]);
  });
});

// The post-merge push lane on `main`.
//
// `ci.yml` carried no push trigger while no merge queue was enabled, so
// nothing validated the merged tree before it landed and the only check after
// it was the ~40-minute E2E — a regression could sit in `main` for hours. The
// trigger is back, taken by `test` and the `classify_pr` it depends on.
//
// The runner-routing tests in `.github/scripts/ci-runner-routing.test.mjs`
// cannot reach any of this: they drive `pick_runner`'s shell directly with
// EVENT_NAME=push, bypassing the trigger and both job gates, so they stay
// green if either loses its push arm. What is pinned here is the YAML half —
// the same class of invariant as `keeps a nightly run to exactly the two
// lanes` above, and for the same reason: every mutation below leaves the whole
// suite green while silently turning the lane off, widening it, or pointing it
// at the wrong tree.
describe('post-merge push lane', () => {
  const stepOf = (job, name) =>
    (ci.jobs[job].steps ?? []).find((s) => s.name === name);

  it('is triggered on main and nowhere else', () => {
    // Drop the trigger and the post-merge signal is gone with it; widen the
    // branch list and every dev branch push spends a pool runner.
    // The whole object, not just `branches`: a sibling `tags:` key would
    // widen the lane to every tag push while `branches` still read `['main']`.
    // That also breaks the size ratchet — on a tag-creation push
    // `github.event.before` is all zeros, so WORKFLOW_SIZE_BASE_SHA is
    // unresolvable and both enforcers take their strict arm — and
    // main-ci-failure-issue.yml's `head_branch == 'main'` filter means no
    // issue is filed for tag runs: a silent red on release day.
    expect(triggers.push).toEqual({ branches: ['main'] });
  });

  it('classify_pr admits push in its event allowlist', () => {
    // `test` reads `needs.classify_pr.outputs.ubuntu_runner`. If classify_pr
    // stops accepting push, `test` still runs but that output is empty and
    // `fromJSON(... || '["ubuntu-latest"]')` silently demotes every
    // post-merge run to a scarce hosted runner.
    expect(condOf('classify_pr')).toContain("github.event_name == 'push'");
  });

  it('test accepts push while still excluding the nightly', () => {
    // Both halves are load-bearing. The exclusion checks are not enough on
    // their own: rewriting `test.if` into allowlist form — `!cancelled() &&
    // event != 'schedule' && (event == 'pull_request' || event ==
    // 'merge_group' || event == 'workflow_dispatch')` — contains no
    // `!= 'push'`, so it passes them, is skipped by the exclusivity helper
    // (test is in PUSH_JOBS), and leaves the routing tests green because they
    // inject EVENT_NAME=push into pick_runner's shell directly. On a real
    // push, classify_pr would run, test would skip, the run would conclude
    // `success`, and the failure watcher — gated on `conclusion == 'failure'`
    // — would file nothing: the lane gone with zero red anywhere. Requiring
    // the gate to stay exclusion-shaped forecloses that.
    const cond = condOf('test');
    expect(cond).not.toContain("github.event_name != 'push'");
    expect(cond).not.toContain('github.event_name ==');
    expect(cond).toContain("github.event_name != 'schedule'");
  });

  it('keeps a post-merge run to exactly classify_pr and test', () => {
    // The mirror of the nightly assertion, through the same helper: a `push:`
    // trigger fires the whole workflow, so every other job must exclude push
    // outright or gate on an allowlist that cannot contain it. Otherwise a
    // merge quietly becomes a full CI run — desktop_shell's cargo build
    // included.
    assertEventReachesOnly('push', PUSH_JOBS, [
      'pull_request',
      'merge_group',
      'workflow_dispatch',
      'schedule',
    ]);
  });

  it('checks out the commit the push reported, not the branch tip', () => {
    // `github.ref` resolves `refs/heads/main` at fetch time — a moving tip —
    // while the check run attaches to `github.sha`. Without a push arm the
    // lane can validate a tree it does not report on, and nothing detects it:
    // `Verify checkout includes expected head commit` is gated to
    // pull_request / merge_group, and its `merge-base --is-ancestor` check
    // passes for a newer tip regardless. Order matters as much as presence —
    // the arm has to sit before the `github.ref` fallback to ever be reached.
    const checkout = (ci.jobs.test.steps ?? []).find((s) =>
      String(s.uses ?? '').startsWith('actions/checkout'),
    );
    expect(checkout).toBeDefined();
    const ref = String(checkout.with?.ref ?? '');
    const arm = "github.event_name == 'push' && github.sha";
    expect(ref).toContain(arm);
    expect(ref.indexOf(arm)).toBeLessThan(ref.lastIndexOf('github.ref '));
  });

  it('does not upload coverage from a post-merge run', () => {
    // The artifact's only consumer, post_coverage_comment, is gated to
    // pull_request; nothing else under .github/ reads coverage-reports-*.
    // Without this exclusion every merge spends pool egress and artifact
    // retention on a lane with no reader.
    const step = stepOf('test', 'Upload coverage reports');
    expect(step).toBeDefined();
    expect(String(step.if)).toContain("github.event_name != 'push'");
  });

  it('scopes the concurrency group and keeps main uncancellable', () => {
    // All three components, the way e2e-workflow.test.js pins its own.
    //
    // Event: unscoped, the group collapses onto `Qwen Code CI-refs/heads/main`
    // and the post-merge run shares it with the nightly (60-minute lanes, no
    // cancellation on main) and with any PR from a fork branch named literally
    // `refs/heads/main` — a legal ref name.
    //
    // Repo + ref: `head_ref` alone is not unique. Two PRs with the same head
    // branch name — including from different forks, which evaluate groups in
    // the base repo's namespace — share a group, and PR runs DO cancel in
    // progress, so they cancel each other. A fork's default branch is `main`,
    // the most common head_ref there is. Dropping the ref half entirely would
    // collapse every PR into one group and leave this suite green.
    //
    // cancel-in-progress: flipping it to `true` was measured to be invisible
    // to all 1854 test:scripts tests, while consecutive merges would cancel
    // each other — the history this repo already recorded once, when 67 of
    // 100 push runs were cancelled and only 25 ever reported.
    const group = String(ci.concurrency.group);
    expect(group).toContain('github.event_name');
    expect(group).toContain(
      'github.event.pull_request.head.repo.full_name || github.repository',
    );
    expect(group).toContain('github.head_ref || github.ref');
    expect(String(ci.concurrency['cancel-in-progress'])).toContain(
      "github.ref != 'refs/heads/main'",
    );
  });
});

describe('platform lanes — the retired sensitivity classifier', () => {
  it('is gone from the workflow, whole', () => {
    // Off with the pull-request trigger it fed: nothing consumes its output,
    // so a surviving job would spend a hosted runner per pull request on a
    // classification no gate reads — and a surviving reference would consult
    // a job that no longer exists. Deleted means deleted everywhere.
    expect(ci.jobs.classify_platform).toBeUndefined();
    expect(JSON.stringify(ci)).not.toContain('classify_platform');
  });

  it('keeps its classifier script tested for the restoration', () => {
    // The script layer stayed in place precisely so restoring the
    // pull-request trigger is a revert. A classifier that rotted untested in
    // the meantime would make that revert a regression instead.
    expect(ci.env.HELPER_TESTS).toContain(
      '.github/scripts/ci/classify-platform-sensitivity.test.mjs',
    );
    expect(ci.env.HELPER_TESTS).toContain(
      '.github/scripts/ci/classify-pr-profile.test.mjs',
    );
  });
});

describe('platform lanes — a failing nightly is visible', () => {
  it('files an issue when the scheduled CI run fails on main', () => {
    // A nightly nobody is told about is the same silence the merge-queue gate
    // produced: the run goes red on a branch nobody watches and the lane is
    // effectively off again.
    const wr = (failureIssue[true] ?? failureIssue['on']).workflow_run;
    expect(wr.workflows).toContain('Qwen Code CI');
    // Both sides of the binding: `workflow_run.workflows` matches the watched
    // workflow's `name:`, so renaming ci.yml silently unhooks the watcher and
    // the nightly goes back to failing where nobody is told.
    expect(ci.name).toBe('Qwen Code CI');
    // `workflow_run.workflows` matches the watched workflow's `name:` key:
    // pin the coupling itself, so renaming ci.yml's name fails here instead
    // of silently stopping the nightly's workflow_run events.
    expect(wr.workflows).toContain(ci.name);
    const cond = String(failureIssue.jobs.analyze.if);
    expect(cond).toContain("workflow_run.event == 'schedule'");
    expect(cond).toContain("workflow_run.head_branch == 'main'");
    expect(cond).toContain("workflow_run.conclusion == 'failure'");
  });
});
