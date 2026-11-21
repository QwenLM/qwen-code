# Exact-file worktree sidecar polling

[English](2026-11-15-worktree-sidecar-polling.md) | [简体中文](2026-11-15-worktree-sidecar-polling.zh-CN.md)

## Bounded follow-up — 2026-11-16

The same-owner read-failure regression now first loads a valid worktree, observes a failing subscription-triggered read clearing it to null, then verifies recovery on the next notification. The linked [exit-policy follow-up](2026-11-15-cli-final-watcher-exit-chain.md) limits launcher precheck/catch recovery to known unusable paths and catchable JavaScript exceptions; native syscall/TOCTOU failures remain outside the guarantee. Scoped local verification is recorded in the linked exit-policy follow-up; earlier source-specific results below remain historical.

## Verified independent Common/POLL checkpoint — 2026-11-16

Pinned `main` at `88e3f19c01d5` plus this independent 12-path candidate has now passed seven normal stages and seven whole CLI files/181 tests, including all six real-filesystem cases under the original 2-second oracles. Build/type/full zero-warning lint/format/bundle passed. Tested source tree is `8ed483a558fa7b7d04d5cbce4b7d1791170d271b`; source-bundle entry `9aa3e3ef3544c47e007a2785894eb5b6f1180efa9ee8915ed116c3d715aac222` has 1,455 files.
The short-fit public route passed Node+Ink, Bun+Ink and strict Bun+OpenTUI, with 3 pre-helper natural exits 0 and 18 closed loopback model requests. Each run showed the complete 87-cell ASCII removal command in one physical row, default focused Yes and exactly one CR; both current-footer transitions met the original 2-second deadlines. This qualifies the declared sidecar route, not long-command wrapping, all signal paths or Trust restart behavior.
This documentation-only checkpoint preserves the eight tested code/test files and compiled bundle; publication records include formatting, reciprocal references and an exact source mapping. Below are preserved historical checkpoints, including older pending/Trust-composition statements; they do not describe this 12-path scope. Existing signal 5 passed / 1 failed / clean-main Native first-hint failure and separate Bun+Ink Trust restart failures remain open; old filesystem failures remain recorded alongside the new polling passes. Keep existing Draft #17334, with CI/Ready/maintainer review and platform/stability qualification separate.

## Logical Common/POLL candidate proposal — 2026-11-16

The proposed update to existing Draft #17334 is limited to Common exit/relaunch wiring plus exact-file worktree-sidecar polling on pinned `main` at `88e3f19c01d5`. It contains 12 paths, excludes native Trust/Stats/exec-confirmation changes and CI routing changes, and has no dedicated 12-path artifact acceptance yet. The prior `MAIN39` composition/status and results below are historical; references there to a Trust-containing composition or Trust CI do not describe this logical candidate. Preserve those records and the original failures; do not inherit 39-path results as 12-path qualification. A new owned candidate, normal checks and bounded sidecar acceptance remain required. The separate failed-exec terminal 42/manual-restart policy is unchanged.

## Status and reproduced problem

Implemented source checkpoint, verification pending on `main04bb` plus the frozen Trust/Common composition. Real-filesystem deletion failed under the original 2-second assertion in 67096; the separately completed creation case failed in 63675. The direct Node/Core watch control 77513 also observed no callback after deletion. Earlier traces show watch returned and the sidecar genuinely absent while no callback arrived inside the oracle; this does not identify a Darwin/Bun root cause. All old failures remain. No new source test, build or public product pass is claimed here.

## Minimal change and ownership

Replace only this hook's directory `fs.watch` with `fs.watchFile(exactSidecarPath, { persistent: false, interval: 500 }, listener)`. Subscribe before the initial real read; no parent mkdir, directory watcher, fallback mechanism or configurable timer. Existing repository consumers already use this public stat-polling pattern. Read only the captured Config/session sidecar using the existing validating reader; read failures remain null.

Capture the Config identity in the loaded value as well as session ID, so a different Config with the same session ID cannot display its predecessor's worktree while loading. Cleanup first marks the effect cancelled, then calls `unwatchFile(path, sameListener)`; retained callbacks cannot start reads and in-flight reads cannot publish after cancellation. Two subscribers to one file must remain independent. Sandbox mounts perform no reads or subscription. No generic ownership framework, Core change or new policy.

Both production consumers remain Ink AppContainer and native AppShell. Ordinary replacement/unmount and final exit all unsubscribe this stat listener. There is no directory FSWatcher to pass to `closeFileWatcher`; the separate public helper's Darwin final-exit policy is unchanged and remains independently tested. Signal/relaunch preparation from the common exit increment is unchanged. This does not establish a fix for Trust relaunch or native startup/exit behavior.

## Semantics and limits

A 500 ms nonpersistent poll is approximately two stat checks per second per active hook, not a wall-clock guarantee. Reads occur on notifications plus the initial load. Creation after an initially missing file, deletion and atomic replacement use the exact pathname rather than a captured parent inode. Metadata polling may coalesce rapid transitions and cannot promise observation of every intermediate or identical-metadata rewrite. Remote/slow filesystem latency and Bun implementation details are not qualified by choosing this interval.

## Validation

Keep all original five real-filesystem tests unchanged, especially creation/deletion at 2 seconds; add actual atomic replacement through the public writer with the same 2-second oracle. Adapt the existing ownership and final-exit suites to the public watchFile/unwatchFile contract rather than deleting their cancellation/owner/sandbox coverage. Add same-ID Config replacement, same-path independent listeners, retained callbacks, late reads, initial missing target and failure recovery. The obsolete async-mkdir test becomes subscription-before-initial-read coverage because the filesystem mutation is removed.

Root must run build/type, all three collocated whole files, affected AppContainer/AppShell consumers, lint/format/bundle and the real public worktree enter/exit route. Trust's two-r case is separate and does not prove live sidecar refresh. Public route: explicitly requested real enter_worktree/exit_worktree tools, actual durable tuple/absence and bounded current footer evidence, existing permissions, protected maps, natural quit; no private pending injection or global flag manipulation. See `.qwen/e2e-tests/worktree-sidecar-polling-20261115.md` for original RED sources and Root-only execution scope. No deadline/retry relaxation, default switch, platform or overall migration claim.
