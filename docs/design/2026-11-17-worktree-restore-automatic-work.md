# Automatic work during worktree restore

[English](2026-11-17-worktree-restore-automatic-work.md) | [简体中文](2026-11-17-worktree-restore-automatic-work.zh-CN.md)

Status: implemented and verified locally on macOS; not deployed to the running daemons.

## Problem

A cold ACP restore starts durable cron before the daemon reconciles a persisted worktree. A due cron turn can then wait for a user question while directory relocation waits for that turn to finish. The Web Shell waits for load to finish before presenting the question. `hasActivePrompt` does not cover all internal automatic turns, so it cannot establish that relocation will drain.

## Scope

Fix Web Shell load/resume and scheduled-task cold restores of route-owned worktrees with a recorded `workspaceCwd`. Keep existing session IDs, transcript storage, worktree ownership locks, marker checks, containment, trust validation, and cleanup behavior. Do not restart shared daemons, alter other sessions, automatically answer questions, or broaden filesystem access. Initially legacy sidecars and restores without a worktree retain their existing compatibility behavior. The strict path and its automatic-work hold are armed only when the sidecar is still strict in the read taken under the ownership lock, so a sidecar that was already legacy at that point keeps the lock-free legacy path; once armed, the sidecar cannot disappear or downgrade during restoration.

## Design

The daemon already knows from the sidecar pre-read that it may have to reconcile cwd before returning a strict worktree restore. The pre-read only selects the ownership lock; the sidecar is read again under that lock, and only a still-strict record there activates the strict path and sends the private restore flag asking the child to hold automatic work until cwd restoration succeeds. A legacy record in that locked read keeps the existing lock-free legacy behavior. On the strict path, defer the restored question for every session source, rather than only Channel sessions. This is internal bridge metadata; public REST request bodies cannot select it.

The child accepts the flag only from its authenticated private parent and applies it only when constructing a cold Session. Install the hold immediately after construction and before asynchronous registration, replay producers, or cron startup. The hold blocks cron, Goal and notification queue admission and new foreground turn admission, and counts as a Session work hold for lifecycle protection. It is not an executing turn and must not enter the drain predicate, or relocation would wait for its own admission hold.

A successful `session/cd`, including a validated no-op, releases the cwd hold only after its close gate is released. Automatic queues and durable cron can then resume in the reconciled directory, unless a saved question still awaits reconstruction. Automatic admission also honors the existing question-restore predicate: otherwise a cron message can displace that question before the restore prompt rechecks history. Foreground question reconstruction remains admitted, and its active turn protects the queues until the answer completes. A failed validation or relocation retains the cwd hold; existing restore cleanup discards only that Session. A warm attach must not retroactively install a new cwd hold on existing work.

The daemon keeps the worktree ownership lock throughout its existing validation and relocation. It fires a deferred question only after this reconciliation. No missing, ambiguous, untrusted, removed, or invalid worktree state falls back to the primary workspace. The change does not alter manual directory-change drain semantics.

Boot rehydration and keepalive revival of bound scheduled sessions use the same restore core as user loads. Each callback stays bound to its selected workspace runtime and generation guard, including storage, bridge and admission. A removed or closed generation fails instead of using the primary runtime. The helper's direct bridge fallback remains available to existing embeddings that do not provide the daemon callback.

When directory reconciliation refreshes LLM context, insert the structural directory messages before a trailing restorable question. Preserve the question's call payload, provider metadata and completed call IDs, so it remains discoverable and its eventual answer stays adjacent. Recheck the history after asynchronous directory context generation; if the question has been answered, append context after that completed exchange.

## Risks and limits

An already wedged Session created by an older process still requires targeted cancellation and reload. This change prevents the cold-start ordering defect on the covered daemon entry points in new processes; it does not hot-patch installed processes or establish cross-daemon writer ownership. It does not add daemon worktree reconciliation for raw bridge consumers outside these entry points or change Live conversation relocation. Mixed versions that do not understand private metadata keep their earlier compatibility behavior. Other transport failures and frontend error presentation are outside this change.

## Validation and acceptance

- Reproduce the pre-fix cold-restore ordering with an isolated runtime and a deterministic local provider or a focused test-script fallback. Never use the user's live sessions as model fixtures.
- A due automatic task cannot execute or ask a question before cwd reconciliation. After successful reconciliation it resumes in the worktree and the transcript/question can load.
- A persisted question is deferred until strict worktree validation for both Channel and ordinary session sources.
- Boot rehydration and keepalive revival go through the same worktree validation and hold. A closed runtime generation is rejected.
- A pending question survives directory-context refresh with its call payload intact; an answer arriving during context generation is not moved or reopened.
- With both a saved question and a due cron, the original question is reconstructed before automatic messages can displace it; automatic work resumes after it is answered.
- A held Session remains protected from conditional lifecycle cleanup, but its turn-drain wait completes when it has no executing work.
- Failed cwd changes do not release automatic work; successful and validated no-op changes do. Normal sessions and warm attaches keep their behavior.
- Containment, ownership, missing-marker, superseded-session and failed-cleanup regressions stay covered.
- Run affected unit tests, build, typecheck, isolated post-fix verification and two clean self-audit passes before marking the source fix complete. Existing live recovery evidence is separate from source-fix evidence.

Local verification used Node 24.12.0 and a loopback mock provider in isolated config/runtime/workspace directories. Installed 0.27.4 reproduced the cron timeout after 30,458 ms; the final bundle loaded it in 1,827 ms with exact worktree cwd, `persisted-v1`, a pending question and a readable transcript. Its actual cold cron request included the worktree path. A persisted-question fixture loaded in 2,100 ms with the question restored, exact cwd and no extra model request. The combined fixture loaded in 1,769 ms and retained the original question throughout 15 probes over three seconds. After a fixture-only answer, due cron continued within 307 ms in the correct worktree; the transcript grew from 6 to 22 events and the distinct cron question appeared. Unit regressions cover automatic admission/drain, question ordering and admission priority, restore callback wiring, closed generations, and strict-sidecar disappearance/downgrade. Full build, bundle and typecheck passed. These results do not certify a release, Windows, Linux or an external model provider.
