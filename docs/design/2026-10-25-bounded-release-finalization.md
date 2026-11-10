# Bounded release finalization

[English](2026-10-25-bounded-release-finalization.md) | [简体中文](2026-10-25-bounded-release-finalization.zh-CN.md)

## Problem and evidence

The v0.26.1 [finalize run](https://github.com/QwenLM/qwen-code/actions/runs/40108617400) processed 156 pull requests. Serial batches of eight exhausted the shared 30-minute model budget after repeated 180-second request timeouts. Successful requests took 126–172 seconds. The script wrote fallback notes and skipped highlights and themes; the 35-minute workflow timeout did not fire. Output token counts were not logged, so reducing output limits is not a demonstrated latency fix.

The resulting [release PR](https://github.com/QwenLM/qwen-code/pull/15468) also lacked a newer main commit defining the lint gate. Its head-only CI correctly rejected the stale gate. Synchronizing main into the branch resolved that missing ancestry.

## Scope and decisions

Run summary requests in waves of at most three. Settle each wave and validate its results in input order. Cap each wave by the remaining consecutive-failure allowance, so the third consecutive failed batch stops further requests without overshooting. Successful batches reset that counter. Preserve per-entry validation, bilingual fallback, digest ordering, the shared 30-minute deadline, retries, request timeouts, and output token limits. Require positive integer batch sizes and failure limits to prevent an empty scheduler wave.

After finding or creating the release PR, update its branch from main before recording that it should receive automated approvals. An already merged PR exits before this update. Conflicts or permission failures stop the job; there is no force push, automatic conflict resolution, or protection bypass. This reduces the interval in which the gate can become stale; it cannot prevent main changing again after the update.

The release tag and published artifacts stay immutable. This change neither dispatches a release nor rotates credentials. The second approval remains subject to the separate identity collision tracked in [#14341](https://github.com/QwenLM/qwen-code/issues/14341). Runner migration remains in [#15465](https://github.com/QwenLM/qwen-code/issues/15465).

## Risks and limits

Three concurrent requests can increase provider rate pressure; existing retry/backoff and the global budget remain active. Waves deliberately wait for their slowest request to retain deterministic validation and bounded failure behavior. This removes unnecessary serialization but does not guarantee a production duration or completion under provider outages.

Branch updates need the PR token's repository write permission. Main conflicts remain visible release-maintenance work. A later main change can still require another update, and GitHub decides whether prior reviews become stale.

## Validation and acceptance

Use deferred model responses to prove that summary requests overlap, at most three run at once, completion order cannot change output or failure handling, and digest requests wait for summaries. Verify that failures stop actual requests at the configured threshold and successful batches reset it. Existing validation, retry, rendering and deadline tests must continue to pass.

Execute the workflow's PR step against a stub GitHub CLI to cover new/open PR updates, merged reruns, and update failure. Verify the update precedes approval eligibility and failed updates never emit successful eligibility. Run all relevant workflow contract tests plus formatting and focused lint. These are release automation changes with no CLI/TUI/Web runtime behavior; live publishing and paid model calls are outside local verification.
