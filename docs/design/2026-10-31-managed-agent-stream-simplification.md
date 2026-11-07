# Managed Agent event stream simplification

[English](2026-10-31-managed-agent-stream-simplification.md) | [简体中文](2026-10-31-managed-agent-stream-simplification.zh-CN.md)

Status: implemented; focused local verification is recorded below. Acceptance on the updated PR revision remains pending CI.

## Problem and scope

Public and WebShell Session event streams duplicate the replay, live delivery, heartbeat, grant recheck and termination loop. Share that loop within the existing Maven boundaries while retaining both wire projections.

Session creation convergence has already landed upstream in [PR #15955](https://github.com/QwenLM/qwen-code/pull/15955). The current PR uses that existing `SessionCreationCommand`, its named builder and the inherited single-entry contract gate unchanged. Session creation, SQL, repository roles, provisioners, recovery state machines and digest helpers are outside the remaining diff.

## Design

Keep both entry points and their synchronous readable-Session admission. Delegate to one private loop with event and resynchronization payload conversion functions. Event identifiers, types and deletion detection come from the original event record. Retain the Public seconds and WebShell milliseconds projections and their distinct resynchronization records.

Keep subscription-before-replay ordering, pagination, overflow reconciliation, heartbeat scheduling, permission-recheck timing, interruption handling and completion callbacks at their existing positions. The resynchronization frame must have no SSE ID. Introduce no public streaming abstraction and make no change to the event hub, HTTP/OpenAPI contracts, SDK requests or persisted data.

## Validation and acceptance

Follow the module AGENTS.md verification policy and reuse applicable evidence. Select stream permission, replay, resynchronization, projection and API-contract checks. The parameterized replay/live and Public/WebShell test must assert SSE IDs and event names as well as payload classes, sequence order, timestamp units and deletion termination. A changed replay-frame ID or event name must fail those assertions.

Acceptance requires one shared loop, passing focused checks, unchanged wire behavior, and two clean self-audit passes. Full Java/SpotBugs and the required integration profiles remain CI responsibilities; skipped profiles are not acceptance evidence. No unresolved design decisions remain.

## Evidence

The original revision passed the selected stream checks as part of the recorded 808-case local verification and 52-case post-rebase run. A maintainer separately reported byte-identical base/head frames across fourteen cells covering replay, pagination, live delivery, overflow, expired cursors, revoked access and heartbeat, plus a surviving frame-ID mutation in the committed test. The new assertions close that coverage gap for both replay and live delivery on both surfaces.

On macOS with JDK 21.0.8 and Maven 3.9.14, 63 selected stream/replay/API and inherited creation-contract cases passed after rebasing onto `cca888dfcc`; reactor compilation and Checkstyle passed. Independently increasing the replay-frame ID and replacing its event name each failed 2 of the 4 Public/WebShell × replay/live cases as expected. After restoring the production source byte-for-byte, all 21 stream cases and Checkstyle passed again. The prior creation/MySQL evidence belongs to the superseded creation slice and is not claimed for this stream-only diff.
