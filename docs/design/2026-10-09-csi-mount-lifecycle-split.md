# CSI mount identity and joined shutdown

[English](2026-10-09-csi-mount-lifecycle-split.md) | [简体中文](2026-10-09-csi-mount-lifecycle-split.zh-CN.md)

## Status and scope

This extracts the root-directory and mount-lifetime component from Draft PR #13526 at `311b29ef5dec41f0a9da6d57885eade3ecd2e5fb` onto main. The extracted candidate has passed bounded local build, typecheck, bundle, focused tests and independent product verification. Real Linux/CSI acceptance remains open. It applies to the existing boot-v3 CSI worker, without enabling a new worker, execution profile or public selector.

## Problem and current behavior

The existing CSI mount checks kernel mount metadata, a trusted disk serial and root device/inode. Directory resolution then delegates to pathname traversal between two observations, while inherited root lookup does not run the CSI mount checks. Separate observations do not retain the original directory throughout a resolution. Adding a retained descriptor also requires an explicit shutdown owner: startup failures and worker close must release it after admitted operations finish.

## Design and consumers

An original root-directory owner opens one directory with `O_DIRECTORY | O_NOFOLLOW`, captures descriptor device/inode, and compares the canonical named directory with that descriptor before and after every callback. Identity uncertainty permanently fences the owner. It registers each operation before its first await; close fences admission synchronously, retains one close promise, joins all registered operations and closes its descriptor once.

If initial acquisition validation fails, cleanup still closes the acquired descriptor. A cleanup failure retains both errors and rejects mount close; an ordinary acquisition refusal whose cleanup succeeds does not become a false cleanup failure. Independent extraction review identified this distinction missing from the source implementation, so this slice also includes the narrow correction and its positive/negative regression controls.

The CSI mount wraps observation, root lookup and directory resolution in that original root scope. Kernel mount metadata and serial checks surround the complete callback, including failure paths. Ordinary callback failures propagate without invalidating an unchanged mount; root, mount or serial uncertainty fences it. New borrows cannot proceed after close begins.

Resolution accepts only normalized Workspace-relative directory syntax, including `.`. It walks one component at a time under `/proc/self/fd/<parent fd>` using no-follow directory opens, verifies descriptor/named identity on the original device, retains all parents until the walk finishes and joins every child close. Missing directories, symlinks, non-directory leaves, different devices and replaced children refuse resolution. A failed child close remains an observable permanent blocker. The existing CLI Workspace path validator is reused; moving it into core is unnecessary for this slice.

The existing CSI attestation route consumes observation. Existing context installation and runtime-provider directory selection consume resolution, while the existing sibling-directory ownership check consumes root lookup. Their route scopes remain the same live worker and installed Session scopes. Ordinary context mounts keep their implementation. Worker startup closes the CSI mount after route-registration or listener failures; worker shutdown closes the executor, listener and mount through joined cleanup even when earlier cleanup fails.

Sibling ownership grants the caller a private-directory exemption only when the mount root is known and differs from the caller's directory. A fenced or uncertain root must not turn an unresolved sibling into permission to read it, including when the fence occurs inside an already-admitted tool call. Startup and shutdown retain the original error message and preserve simultaneous cleanup failures in an `AggregateError`; shutdown attempts both listener and mount cleanup after executor shutdown settles. Mount close likewise retains both child and root descriptor failures.

## Files and extraction boundary

Production changes are limited to `managed-csi-root-directory.ts`, `managed-csi-mount.ts`, the sibling-ownership decision in `managed-context-worker.ts` and the cleanup portions of `managed-runtime-attestation-worker.ts`, with collocated tests and this design pair. Source boot-v4/v5 support, private file-profile checks and the relocated core path validator are excluded. Existing boot-v1/v2/v3 parsing, routes and selectors remain unchanged.

## Verification and acceptance

Begin with an installed global CLI dry-run and an independent baseline product-module probe, since the CLI does not expose a general CSI test command. Verify original descriptor reuse, normalized nested resolution, root/mount/serial replacement, symlinks, incorrect devices, malformed paths, concurrent callbacks, close during initial acquisition, immediate admission fencing and exactly-once cleanup. Check startup registration/listener failures and executor-close failure through the existing worker entry. Run build, typecheck, bundle, focused CLI tests, source lint/format checks, two clean full-diff self-audits and independent review on the extracted candidate.

Local validation on Darwin arm64 with Node v22.22.3 and pnpm 11.24.0 passed build, typecheck, bundle, scoped lint/format and six focused CLI test files (970 passed, one Linux-only procfd test skipped). Independent verification passed 16 compiled-product behavior cases plus one API capability check, two acquired-root cleanup controls and four packaged CLI child-process cases; the baseline and intermediate cleanup-failure evidence are retained separately. These results qualify this component within the stated fixture boundaries.

Tests on Darwin may use actual owned directories and descriptors with explicitly synthetic Linux mountinfo, serial and procfs addressing. Such results prove bounded component behavior, not Linux procfs, ext4/NVMe, Kubernetes CSI or cloud acceptance. Windows does not admit the CSI mount; its refusal path and ordinary worker compatibility remain testable.

## Risks and remaining work

Before/after checks cannot detect every replace-and-restore event between observations. Holding a directory descriptor prevents a changed parent pathname from redirecting the walk, but does not provide an immutable filesystem snapshot. A returned pathname is a verified directory selection, not a capability for future I/O. Callbacks must join all their work before returning and must neither retain nor close the borrowed descriptor.

The retained descriptor also keeps the volume busy while the healthy worker owns it. Retirement or NodeUnpublish consumers that unmount a live worker's volume must wait for descriptor release; normal Kubernetes unpublish after container exit is unaffected. This slice does not implement that retirement coordination.

This slice does not provide private Read/Write/Edit, file history, immutable native authorization, SQL migrations, receipt-tail recovery, aggregate DRAINED, descendant termination, CSI NodeUnpublish, atomic RELEASED or safe volume reuse. Those remain in #13526 with their separate acceptance gates. There is no wire-format or database migration.
