# Rewind without directory exclusion

[English](2026-11-05-managed-rewind-concurrency.md) | [简体中文](2026-11-05-managed-rewind-concurrency.zh-CN.md)

## Problem and decision

Ordinary tools and uploads already share a Workspace. Managed rewind still requires its Runtime Session to be the only directory member and records an exclusive owner until the file operation returns. Another Session or upload prevents rewind, and a lost rewind response blocks the whole directory.

The user explicitly chose CLI-style cross-Session file concurrency for rewind too. This supersedes the rewind exclusion in [shared Workspace uploads](2026-11-03-managed-shared-workspace-uploads.md). Native file history restores files without a cross-Session directory lock; the daemon queues its own Session. Managed file-history digest/mode checks remain optimistic, not a filesystem transaction or a guarantee against external writers.

## Implementation

Keep durable pending-rewind state on the exact Runtime Session. `beginRewind` validates the existing owned-root and membership requirements and atomically changes that READY Session's pending flag from false to true. It no longer requires `member_count = 1` or installs a physical-directory exclusive owner. A repeated or unresolved rewind on that Runtime Session is refused.

The transport forwards an admitted rewind to the original worker instead of synthesizing a conflict solely because another directory member exists. A successful worker response clears pending state; an exception or unknown outcome retains it. Worker file-conflict results are returned unchanged. Another Session can execute, upload or rewind while the original remains pending.

Retain Runtime Session membership and its count throughout rewind. Pending rewind still prevents that Runtime Session's ordinary execution and mount handback. Move the handback pending check into the membership-release transaction so it cannot race rewind admission. Confirmed worker release or proven stopped/LOST cleanup can clear pending state and release only their original memberships.

Remove `ma_storage_owner.exclusive_member_key`, its hash helper, admission predicates and single-exclusive-member cleanup. Rename the Runtime Session flag to `is_rewind_pending` and its query to `hasPendingRewind`. `beginRewind` returns void: admission succeeds or throws. Update schema projections, boolean decoding, CSI inventory and affected tests together.

Short transactions retain the existing alias/physical-owner/Runtime Session lock order for membership bookkeeping. Mount state remains a current read, and pending admission uses a conditional update. SQL locks end before file I/O. No tenant guard, new table, lock service or configuration is introduced.

## Boundaries and compatibility

- Same-Session idle/history checks, exact binding/generation ownership and unknown-result recovery remain required. No automatic replay of uncertain rewind is added.
- Other writers may change the same file during rewind, as with CLI. No merge, atomic multi-file restore or conflict-free result is promised.
- Worktree maintenance, physical fencing, migration and collection still require an unused directory. Pending Session membership continues to prevent them even when it is the only member.
- Owned-root authorization and existing unsupported SSH/CSI/Resident control behavior remain unchanged. Only cross-Session directory exclusion is relaxed.
- Follow the pre-release schema policy: update V1 in place without a version bump or migration. Old development catalogs require recreation; this task does not modify or recreate user catalogs.

## Validation and acceptance

1. Reproduce old refusal before implementation with tests expecting rewind alongside an existing Session/upload and admission alongside pending rewind.
2. Existing and newly admitted neighboring Sessions/uploads stay usable during successful and uncertain rewind. Two neighboring Sessions can retain independent pending markers.
3. The originating Runtime Session cannot start another rewind, execute ordinary work or hand back its mount while pending. Successful settlement or proven physical release clears only its own state.
4. Membership counts stay exact across upload settlement, normal release, stopped cleanup and LOST recovery. Maintenance and fencing still refuse while any member remains.
5. Run focused H2 and real MySQL membership/upload/publication tests, schema/inventory regressions and Checkstyle within the shared ten-minute Java budget. Full Hosted/fault, MySQL and SpotBugs acceptance remains CI work.

## Open questions

None. The user explicitly expanded this increment to include rewind concurrency.
