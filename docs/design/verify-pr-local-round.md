# Local round helpers for /verify-pr

[English](verify-pr-local-round.md) | [简体中文](verify-pr-local-round.zh-CN.md)

Status: implementing with this change.

## Problem

`/verify-pr` has two entry paths. The sandboxed lane supplies the PR metadata
snapshot, a clone holding both OIDs, and a publication step that refuses a
verdict contradicting its own assertion counts. A maintainer's round on a
workstation supplies none of the three, and the skill answers with prose: a
hand-typed `gh pr view` field list, "do not assume `HEAD^1`/`HEAD^2`", a
directory name the collector globs, and "keep the counts honest yourself".
Each of those is a deterministic rule with no executable form, so every round
re-derives it and the mistakes fail silently: a snapshot from the wrong
repository, a parent commit mistaken for the base, a directory the publication
step never sees, or counts that contradict the verdict.

## Current state

- The local path asks the agent to fetch the snapshot and mount it as
  `$QWEN_VERIFY_CONTEXT`, resolve `baseRefOid`/`headRefOid`, and create
  `tmp/pr<n>-verify-<ts>/` before any verification work begins.
- The isolation requirement ("credential-free container or VM") and its
  fallback ("trigger the sandboxed lane") are prose. Nothing tells the agent
  which situation the current process is in.
- The publish job refuses `merge-ready` with a nonzero `fail` and rejects an
  inconsistent `assertions.json`, so the CI path is machine-checked end to end.
  A local round has no equivalent and can publish counts that contradict the
  verdict it states.

## Proposal

Two standalone scripts, plus the skill pointing at them where the flow needs
them rather than at the end of the document.

- `scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo>` resolves the
  coordinates: fetch the snapshot with the field list the lane uses, verify both
  OIDs exist in this clone, create the artifact directory with its `evidence/`
  subdirectory, and report the isolation signals the process can observe. It
  does not gate on them: resolving metadata needs `gh`, and `gh` and the
  boundary are mutually exclusive, so this path always runs on the host. The
  gate is `--require-isolation`, meant to run inside the boundary before the
  round executes anything.
- `scripts/verify-pr-check.mjs <dir>` applies the publisher's rules to a local
  artifact directory: required files, the four verdict words, a positive and
  self-consistent assertion triple, and no `merge-ready` carrying a failed
  assertion. Report shape and evidence naming are warnings, because a
  documentation-only round has no capture and a checker cannot know whether a
  harness ran.

## Design decisions

1. **`--repo` is mandatory.** A script cannot distinguish a maintainer's clone
   from a contributor's fork, and there `origin` resolves the same PR number to
   an unrelated PR. Failing closed costs one flag and removes exactly the
   failure the skill already warns about.
2. **The scripts never touch the round, and the coordinate path does not gate on
   isolation.** Prepare fetches metadata and creates directories; it does not
   checkout a worktree, build, or execute PR code. It also cannot decide whether
   this process may run that code: it must reach `gh`, which the boundary
   excludes by design, so it always runs on the host. A gate there would fire on
   every round and turn the override into the normal path, so the check is a
   separate mode intended to run inside the boundary.
3. **The local checker mirrors the publisher instead of replacing it.**
   Extracting the publish job's assertions into shared code would touch the
   workflow and its meta-tests; the rule set is four checks, stable, and stated
   in one place. Divergence is the cost, recorded below.
4. **Warnings, not errors, for report shape.** The publisher does not enforce
   report structure either. A checker stricter than the publisher would reject
   artifact the lane accepts, which teaches maintainers to ignore it.

## Constraints and risks

- The isolation detector counts only container-backed signals. The built-in
  macOS sandbox sets `SANDBOX=sandbox-exec` while its default profile still
  reads host files, so it is reported as a caveat rather than a boundary. A
  marker is not credential-free readiness either: the CLI's own Docker/Podman
  launcher mounts the gcloud config and ADC file and copies model keys, so the
  gate also requires an explicit attestation and refuses on a visible signal.
- Two implementations of the publish rules can drift. A workflow meta-test pins
  the checker verdict vocabulary to the publisher case labels, so a fifth word
  on one side fails the suite. The CI publisher remains authoritative.
- The PR title is untrusted input reaching a maintainer terminal, so control
  characters are dropped before it is printed.
- These are local helpers: the lane pins `.qwen` from the base branch, so the
  skill text that references them takes effect only after this change merges.

## Validation plan

- Unit tests for the pure helpers: repository slug, artifact directory name,
  isolation signals, snapshot shape, and argument parsing; and for the
  checker's rule set.
- End-to-end tests that drive both CLIs: a temporary clone with a `gh`
  stand-in, asserting exit codes, the written snapshot, and the artifact
  directory; and artifact fixtures for each checker outcome.
- A dry run of `prepare` against a real PR in a maintainer clone, and of
  `check` against a real artifact directory.

## Acceptance criteria

- `prepare` on a clone holding both OIDs writes a snapshot whose
  `baseRefOid`/`headRefOid` match the PR, creates the glob-matching directory,
  and exits 0 on the host. `--require-isolation` passes only when a container
  marker is present, `QWEN_VERIFY_CREDENTIAL_FREE=1` attests to a clean
  boundary, and no known credential signal is visible; otherwise it exits 4.
- A missing OID fails with a fetch naming the `--repo` repository, not `origin`.
- `check` rejects `merge-ready` with a failed assertion, an inconsistent
  triple, and an unknown verdict word; it accepts `findings` with the same
  counts.
- Neither script executes PR code.

## Open questions

None at this scope.
