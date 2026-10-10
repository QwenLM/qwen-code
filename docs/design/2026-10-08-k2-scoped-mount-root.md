# K2: borrow the original mount root for a whole operation

[English](2026-10-08-k2-scoped-mount-root.md) | [简体中文](2026-10-08-k2-scoped-mount-root.zh-CN.md)

## Status and problem

2026-10-08. This is an implementation dependency of the
[native file execution design](2026-10-07-k2-native-file-execution.md), based on
`950950311f102a745556debc261009af677b125c`, for Draft PR #13526 and tracker
#13395. It does not qualify the private file worker or complete K2.

The original `ManagedCsiRootDirectory` already owns one directory descriptor,
checks its named and descriptor identities, registers callbacks synchronously,
and joins them before closing. Its callback cannot use the descriptor.
`ManagedCsiMount.observe()` owns only an observation; `resolve()` finishes that
observation, delegates to pathname resolution, and observes again. Neither the
middle resolution nor an eventual file backend borrows the original descriptor
over its whole operation. The inherited `rootDirectory()` also bypasses the CSI
mount observer.

## Scope and decisions

Extend the existing owner rather than reopen the root or introduce another
owner. `withVerifiedDirectory()` lends its original `FileHandle` only for the
returned callback promise. The caller must not close it, retain it beyond that
promise, or launch detached work. A read-only availability getter lets the
mount distinguish an owner identity failure from an ordinary callback failure.

Add `ManagedCsiMount.withVerifiedRoot(operation)`. Register its pending work
before the first mountinfo open, including first-time descriptor acquisition.
Check Linux support, bounded kernel mountinfo, trusted serial, original
mount/root identity and the existing pin before invoking the callback. Lend
the original descriptor and frozen receipt, and repeat kernel/serial/pin
checks after the callback, including failure paths. Original root checks
surround this entire callback. Mount or root uncertainty permanently fences
the mount and starts retained close without waiting on the active callback
itself. An ordinary callback error with unchanged authority propagates without
discarding the original mount. Close joins every callback and metadata handle.

`observe()` uses this same operation to return the receipt. `rootDirectory()`
uses it to return the verified logical root. `resolve()` accepts only the
existing normalized Workspace-relative directory syntax, including `.`.
It walks one component at a time below the borrowed root using
`/proc/self/fd/<parent fd>/<one component>`. Each child is opened with
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, checked with BigInt descriptor/named
stats on the original device, and retained until the walk ends. Check the
whole named chain again before releasing the child descriptors, and verify
read/search access on the final descriptor. All acquired child descriptors
are closed even if a different close fails. A close failure is observable and
fences the mount; no failed close is counted as joined.

This is Linux-specific directory resolution. Missing directories, symlinks,
non-directories, wrong devices and malformed paths refuse the requested
resolution. It does not pin every child directory for future operations or
make a returned pathname an I/O capability. All later file tools must use
their own original-root borrow and protected leaf operations. The implementation
does not use a multi-component procfd suffix, an independently opened root,
or a fallback to inherited pathname resolution.

The Linux mechanism follows the stable descriptor and final-component flag
semantics in [open(2)](https://man7.org/linux/man-pages/man2/open.2.html), the
process's own [proc fd entries](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html),
and [Node 22 FileHandle operations](https://nodejs.org/docs/latest-v22.x/api/fs.html#class-filehandle).
These API definitions establish the implementation basis; tests must still
establish behavior of the actual consumer on its target platform.

## Files and consumers

| Layer                    | Change and actual consumer                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Original directory owner | `managed-csi-root-directory.ts`: callback receives the original handle; availability is consumed by the mount.            |
| CSI mount owner          | `managed-csi-mount.ts`: one whole-operation scope, used by observation, context directory resolution and root resolution. |
| Existing worker          | Existing CSI attestation and context installation use these methods; no new route or configuration field.                 |
| Tests                    | Both collocated owner/mount tests cover borrowed identity, callback joins, failures and scoped directory resolution.      |

The ordinary `ManagedContextMount`, boot1/2/3, CSI1 envelope, private reserved
digest refusal, route ownership and public selectors keep their contracts.
No new generation, SQL authority, native history record, backup pin, or private
file mutation authority is created here.

## Validation and acceptance

Before editing, an independent test engineer runs the global `qwen` CLI in an
owned directory and exercises the baseline production owners with a script
fallback. Record the missing borrow and any lifetime gap, rather than treating
global ordinary CLI behavior as CSI qualification.

Verify original descriptor reuse, callbacks that succeed or fail, multiple
pending callbacks, synchronous close fencing, close during initial metadata
acquisition, post-callback root/mount/serial replacement, and exact child
descriptor cleanup. Verify `.` and nested normalized directories, symlinks
at each depth, wrong types/devices, directory replacement during a walk,
missing directories and malformed cwd without a pathname fallback. Repeat
existing context/CSI worker refusal and ordinary compatibility checks. Run
build, typecheck, bundle, focused tests and two clean full-diff self-audits.

Darwin tests may exercise real owned directory descriptors and explicitly
label substituted metadata/proc addressing as fixtures. They do not establish
Linux procfs, ext4/NVMe, actual CSI, private worker or complete K2 acceptance.
Real Linux and cloud qualification remain separate required evidence. Native
review uses the repository workflow; an unavailable workflow is reported,
never replaced by an approval claim.

## Remaining integration and risks

The next required connection is a concrete private Linux file/history backend
that borrows this original scope, protects the reserved backup subtree and
retained backup inodes, and supplies actual Read/Write/Edit plus every history
constructor. Native schema2 intent must be durably committed before preimage
I/O; the declared invocation has exactly the nine named fields in the parent
design. Prepared batch settlement, retained pins/orphans, helper lifetimes,
Hosted consumption and immutable retirement inventory still need their full
connections and tests. DRAINED, physical writer termination, NodeUnpublish,
RELEASED, safe reuse and public rollout remain gated.

Before/after identity checks cannot detect every replace-and-restore event
that occurred between observations. Directory descriptors prevent the walk
from following a replaced parent into another directory; they do not promise
an immutable filesystem snapshot or isolation from an actor controlling the
process or mount namespace. A caller that fails to return all borrowed work
violates the scope contract and cannot claim retirement qualification.
