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
const condOf = (job) => String(ci.jobs[job].if ?? '');

describe('platform lanes — triggers', () => {
  it('gives the workflow a scheduled trigger', () => {
    // Without it the lanes have no path to `main` at all: `ci.yml` has no
    // push trigger by design, so a merge-queue-only gate on a repository with
    // no merge queue is an off switch.
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
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (LANES.includes(name)) continue;
      const cond = String(job.if ?? '');
      const excluded =
        cond.includes("github.event_name != 'schedule'") ||
        /github\.event_name == '(pull_request|merge_group|workflow_dispatch)'/.test(
          cond,
        );
      expect(excluded, `${name} would also run on the nightly schedule`).toBe(
        true,
      );
      // Mentioning an allowlisted event is not the same as excluding this
      // one: `event == 'pull_request' || event == 'schedule'` satisfies the
      // check above while running nightly. Require the impossibility.
      expect(
        cond,
        `${name} admits the schedule event explicitly`,
      ).not.toContain("github.event_name == 'schedule'");
      expect(cond, `${name} has no event gate at all`).not.toBe('');
    }
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

describe('GitHub helper tests', () => {
  it('runs every invocation serially', () => {
    const helperSteps = Object.values(ci.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.run ?? '').includes('env.HELPER_TESTS'));
    expect(helperSteps).not.toHaveLength(0);
    for (const step of helperSteps) {
      expect(String(step.run), step.name).toContain('--test-concurrency=1');
    }
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
