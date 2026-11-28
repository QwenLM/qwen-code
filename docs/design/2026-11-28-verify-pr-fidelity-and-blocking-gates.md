# Verify-PR Fidelity-Transform Protocol, Container UID Visibility, and Mechanical Blocking-Review Coverage Gate

[English](2026-11-28-verify-pr-fidelity-and-blocking-gates.md) | [简体中文](2026-11-28-verify-pr-fidelity-and-blocking-gates.zh-CN.md)

- **Status**: Proposed
- **Date**: 2026-11-28

## Problem Statement

Across three `/verify-pr` rounds on PR #18581 (`ad5531c0`, `bfc396ee`, `253c0ae1`
plus mid-round delta `2490bb3f`), Round 3 certified `88/88` `merge-ready`
(`#issuecomment-7239662950`), yet a manual review 28 minutes later
(`#issuecomment-7239998370`) reproduced both a P1 and a P2 defect directly against
the certified head `2490bb3f` using real `e2fsprogs`:

1. **Silent fidelity loss on extract-repack transforms (P1)**: `debugfs rdump` +
   `mkfs.ext4 -d` silently dropped FIFOs, split hard links into independent
   inodes (`nlink=1`), and stripped extended attributes (`xattrs`). Even after
   `2490bb3f` added an ownership check, it iterated `extractTree` (the lossy
   extracted directory) instead of the source image, so omitted objects were
   invisible. Across all three verification rounds, the real-`e2fsprogs` harness
   only spot-checked one plain text file.
2. **Root-only container runs blinding non-root ownership code paths (P2)**:
   All three rounds ran their real-`e2fsprogs` harnesses as `uid=0` (`root`)
   inside Docker rather than `--user "$(id -u):$(id -g)"`. Because `debugfs rdump`
   never emits `Operation not permitted` ownership warnings as root, the rounds
   never exercised the non-root ownership path — missing both an earlier P1
   (`#issuecomment-7239376491`) and the P2 introduced by `2490bb3f` (where a
   symlink-only UID mismatch emits zero `rdump` warnings, skips
   `restoreOutputOwnership`, and leaves both the symlink and newly injected
   `/opt/poc/init` owned by the build user instead of `14001:14002` and `0:0`).
3. **Mid-round delta re-check re-running only prior probes**: Commit `2490bb3f`
   added 164 lines of new non-root ownership capture/restoration logic mid-round,
   yet the delta re-check only re-ran prior root-only probes, old 7-guard
   mutations, and fake-binary unit suites — zero new probes or mutations targeted
   the new delta logic or its proxy-signal gate (`hasOwnershipWarnings`).
4. **No mechanical check enforcing blocking review coverage**: Even though
   `#18549` extended `review-threads.json` to capture maintainer top-level
   comments (`OWNER`, `MEMBER`, `COLLABORATOR`), `verify-pr-check.mjs` did not
   mechanically verify that open blocking threads, blocking change-request bodies,
   or top-level `P0`/`P1`/`Critical`/`Blocker` comments were accounted for in
   `assertions.json` and `report.md` before `merge-ready`.

## Goals and Scope Boundaries

### Goals

- Record the container process `uid` in `boundary-gate.json` during
  `verify-pr-prepare.mjs --require-isolation`, reject malformed `uid` values in
  `verify-pr-check.mjs`, and emit an explicit warning whenever a `container`
  round ran as `uid=0` (`root`).
- Bind `review-threads.json` with a SHA-256 digest (`review-sha256` printed by
  `verify-pr-prepare.mjs`) and enforce open blocking review coverage mechanically
  in `verify-pr-check.mjs` via `--review-threads <snapshot>` and
  `--review-threads-sha256 <digest>` against `assertions.json` `reviewCoverage`
  and `report.md` citations.
- Extend `.qwen/skills/verify-pr/SKILL.md` with:
  - a diff-triggered five-axis adversarial protocol for extract-repack and
    fidelity-preserving transform diffs,
  - a fresh-round adversarial verification bar for new production logic introduced
    in follow-up or mid-round deltas,
  - proxy-signal gating false-negative counterexamples and real-binary coverage
    for newly fixed external-tool semantics,
  - container `uid=0` non-root coverage rules and `--review-threads` publish gate
    wiring.

### Non-Goals

- Do not make `uid=0` a hard error in `verify-pr-check.mjs`; container rounds
  that legitimately install packages as root may still run, while the warning and
  skill rules prevent silently certifying non-root permission paths as
  `merge-ready`.
- Do not break existing `verify-pr-check.mjs` invocations that omit
  `--review-threads`, and keep `verify-pr-check.mjs` self-contained for CI
  sparse-checkout publish lanes.
- Do not auto-exclude PR authors from top-level blocking review detection:
  maintainers frequently post independent review comments under the same account
  that opened the PR (as occurred on `#18581` comments `7239376491` and
  `7239998370`).

## Proposed Solution

### 1. Container Execution UID Recording and Root Warning

- **`scripts/verify-pr-prepare.mjs` (`requireBoundary`)**: On POSIX platforms
  (or when `options.uid` is injected in tests), include non-negative integer
  `uid` in `boundary-gate.json`.
- **`scripts/verify-pr-check.mjs` (`gateRecordErrors`, `checkArtifacts`)**:
  - Fail closed if a non-`ci-lane` `boundary-gate.json` carries a malformed `uid`
    (non-integer, negative, or beyond `Number.MAX_SAFE_INTEGER`).
  - Emit a warning whenever `boundary.mode === 'container'` and the non-`ci-lane`
    gate record reports `uid === 0`, explaining that root bypasses non-root
    permission, `chown`, and ownership-warning code paths.

### 2. Mechanical Blocking-Review Coverage Gate

- **`scripts/verify-pr-prepare.mjs`**: Compute `reviewSha256` over the exact
  serialized `review-threads.json` bytes written by `prepare` and print
  `  review-sha256  <64-hex>` alongside the `review` line (omitted when the
  GraphQL fetch fails and no file is written).
- **`scripts/verify-pr-check.mjs`**:
  - Add `--review-threads <snapshot>` and `--review-threads-sha256 <64-hex>`,
    enforcing the same host-trust boundary as `--context` and `--guard` (refuse
    in-tree paths, filesystem-root trust roots, hardlinks, symlinks, non-regular
    files, digest mismatches, missing digest under `--require-guard`, and any
    `review-threads.json` planted inside the PR-writable artifact directory).
  - Export `hasBlockingSeverityTag(body)`,
    `extractBlockingReviewItems(reviewData, { coordinates })`, and
    `checkReviewThreads(text, { coordinates })`:
    - Fail closed on malformed payloads or any review/comment URL targeting a
      different repo/PR than trusted `--context` coordinates (blocking cross-PR
      replay).
    - Detect structured blocking tags (`[P0]`, `[P1]`, `【P0】`, `【P1】`,
      `[Critical]`, `[Blocker]`, line-leading bold/heading/list labels, and
      `Severity: P0|P1|Critical|Blocker`) outside Markdown fenced code blocks,
      ignoring zero/none headings (`**Blockers**: None`, `### Critical (0)`,
      `### Blockers\nNone`) and ordinary prose.
    - Collect open blocking inline threads (`resolved !== true` or parent review
      in standing `changeRequests`), blocking standing `changeRequests` bodies,
      and blocking top-level `OWNER`/`MEMBER`/`COLLABORATOR` `issueComments`
      while ignoring `/verify-pr` reports (first-paragraph `Verdict:` paired with
      the final-line `/verify-pr` footer) and leading bot lifecycle/status comment
      headers.
  - Validate optional `assertions.json` `reviewCoverage` entries of shape
    `{ url, status, evidence | reason }` where `status` is one of
    `reproduced | not-reproduced | not-measured | no-defect-claimed` (no
    duplicate URLs; non-empty `evidence` for `reproduced`/`not-reproduced`;
    non-empty `reason` for `not-measured`/`no-defect-claimed`):
    - Refuse `merge-ready` if any open blocking item is omitted, marked
      `reproduced` or `not-measured`, or marked `not-reproduced` without a
      matching URL/fragment/comment-ID citation in `report.md`.
    - Downgrade omissions on non-`merge-ready` verdicts (`inconclusive`,
      `findings`, `blocked`) to warnings so partial or failing rounds can still
      publish.

### 3. Skill Protocol Hardening (`.qwen/skills/verify-pr/SKILL.md`)

- **Step 1 & local `--publish` gate**: Clear and capture
  `~/.cache/qwen-verify/pr<n>/review-threads.sha256` whenever `prepare` writes
  `pr<n>-review-threads.json`, and pass `--review-threads` +
  `--review-threads-sha256` in both container and runner-backed VM publish checks
  (updated in `scripts/tests/verify-pr-model-proxy.test.js` shell AST allowlist
  with hostile mutation coverage).
- **Step 3**: Document container `uid` capture and the rule prohibiting
  root-only `merge-ready` certification on permission/ownership diffs.
- **Follow-up classification**: Require fresh-round adversarial probes (including
  gate false-negative counterexamples) and new mutations whenever `P..H` or a
  mid-round delta adds new production logic.
- **Scope selection**: Add the diff-triggered five-axis **extract-repack and
  fidelity-preserving transform** protocol (source-anchored full differential
  oracle, file-type matrix including FIFOs, hard-link inode topology,
  metadata/ownership/xattrs including symlink-only mismatch and newly injected
  files, and unprivileged execution context).
- **Method & Report item 4**: Add proxy-signal gating false-negative attacks,
  real-binary verification of newly fixed external-tool semantics, and the
  `assertions.json` `reviewCoverage` schema contract.

## Design Decisions and Rationale

- **Explicit `no-defect-claimed` status with required `reason` rather than
  ignoring PR authors**: Because maintainers post independent reviews from the
  PR author's own GitHub account, filtering by `author !== pr.author` would
  re-introduce the exact `#18581` blind spot. Surfacing all maintainer `[P1]`
  comments and allowing `no-defect-claimed` with an explicit reason keeps author
  fix-summary replies (`7239531608`) non-blocking while making every blocking
  tag auditable.
- **Keep `reviewCoverage` inside `assertions.json`**: Avoids adding a new
  mandatory artifact file across CI and local workflows while remaining fully
  valid JSON and backwards compatible with existing consumers.
- **Keep `--review-threads` opt-in at the CLI level while pinning it in
  `SKILL.md` publish commands**: Preserves existing CI sparse-checkout and unit
  invocations while making local `--publish` checks mechanically fail-closed
  whenever `review-threads.json` is present.

## Constraints and Risks

- `review-threads.json` still captures the latest 100 top-level comments
  (`issueCommentCount` discloses truncation when `> 100`); comments beyond the
  100-comment window are outside the mechanical check.
- Prompt-level adherence to the five fidelity axes and mid-round delta probe bar
  still depends on agents following the explicit coverage / _Not covered_
  contract; the new `uid=0` warning and `--review-threads` gate mechanically
  catch the two silent bypasses that enabled `#18581`'s false `merge-ready`.
- `verify-pr-check.mjs` remains free of runtime imports from other repo scripts
  so sparse-checkout CI publish lanes continue to execute standalone.

## Validation Plan and Acceptance Criteria

1. `scripts/tests/verify-pr-prepare.test.js`: verifies `review-sha256` output
   matches `pr<n>-review-threads.json` bytes (and is omitted when fetch fails)
   and `requireBoundary()` records container `uid` (`0`, `1000`, and default
   POSIX `process.getuid()`).
2. `scripts/tests/verify-pr-check.test.js`: verifies `uid=0` warning vs non-root
   silence vs malformed `uid` error, blocking severity tag classification (tags,
   fences, zero/none headings), `#18581`-shaped `extractBlockingReviewItems()`
   cases, cross-PR URL refusal, `reviewCoverage` validation and `report.md`
   citation enforcement, and full CLI host-trust/digest/planted-file checks.
3. `scripts/tests/verify-pr-model-proxy.test.js`: shell AST allowlist passes for
   updated `SKILL.md` and rejects hostile mutations of `review-threads.sha256`
   and `--review-threads`.
4. `scripts/tests/qwen-triage-workflow.test.js`: pins the new fidelity protocol,
   mid-round delta bar, proxy-signal rule, container `uid` disclosure, and
   `--review-threads` / `reviewCoverage` wiring in `SKILL.md`.
5. ESLint and Prettier pass cleanly on all modified files, plus an isolated
   standalone run of `scripts/verify-pr-check.mjs` confirming zero extra
   dependencies.
