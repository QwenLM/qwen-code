# Preserve settings permissions during replacement

[English](2026-10-03-settings-write-permissions.md) | [简体中文](2026-10-03-settings-write-permissions.zh-CN.md)

## Problem

Replacing an existing settings file creates a new inode with default permissions. Under umask 022, a private 0600 or 0640 file becomes 0644 during ordinary startup migration or settings saves. Private staging protects intermediate bytes, but the final file can become readable to additional local users when its parent directories allow traversal. This predates the atomic-save fix in #13119.

## Decision and scope

Capture an existing regular file's ordinary POSIX permission bits (0777) before staging. Use a non-following regular-file check to exclude symlinks and other file types from mode inheritance, while retaining the following directory check that rejects both directories and symlinks to directories. Create the staged file with the captured bits and apply the exact mode after writing, before backup and publication. Creation alone is insufficient: umask 077 would otherwise remove the group-read bit from an existing 0640 file. If chmod reports ENOSYS, ENOTSUP or EPERM, publish only when the staged file's reported ordinary permission bits grant nothing beyond the captured mode. This permits saves on CIFS/SMB mounts that reject chmod despite allowing creation and replacement, while refusing broader staged permissions even for unsupported operations. Other mode-setting failures abort through the existing cleanup path, leaving the committed target intact. Exact POSIX mode preservation requires filesystem support. Preserve the single replacement rename, private backup, failure recovery and overlapping-writer behavior.

New files and files published in place of symlinks keep the existing policy: default 0666 filtered by the caller's umask. A target that disappears before the non-following check is published as a new file with those default permissions. Replacement still replaces the symlink itself without modifying its referent. Do not add a mode option or change settings schemas. The shared writer serves JSONC creation/updates (including startup migration and ordinary saves), transaction snapshot restoration, and its async wrapper. No sandbox authorization changes are needed.

## Constraints

Preservation is symmetric. A regular settings file that is already group- or world-writable is re-published with those bits; the previous writer's implicit narrowing to 0666 & ~umask no longer happens.

Preserve ordinary permission bits, not setuid, setgid or sticky bits. Replacement continues to create an inode owned by the writer; preserving owner/group identity, per-file ACLs, extended attributes and Windows ACLs is outside this change. Node's Windows chmod behavior is limited; POSIX modes are not a Windows access-control guarantee. Concurrent external permission changes and file replacement between inspection and publication remain outside the existing last-publication-wins contract. This does not add power-loss durability guarantees.

## Validation

Reproduce and verify offline startup migration with isolated User/Workspace files and fake tokens. Native POSIX tests cover 0600, 0640, 0644 and 0666 under umask 022 and 077, exact bytes and staged/final modes, and dropping setuid/setgid/sticky bits. Delete an existing target after staging-directory creation and require successful new-file publication with no leftover artifacts or chmod. New-file and symlink-replacement tests retain default umask behavior; cover links to /dev/null and regular 0644/0777 files, unchanged referents, and refusal of links to directories. Inject ENOSYS/ENOTSUP/EPERM with equal or narrower staged permissions and require complete publication and cleanup; inject each of those errors with broader staged permissions and require refusal. Inject EACCES, I/O, read-only or unclassified chmod errors and require unchanged target bytes/mode with no staging artifacts. Verify direct settings saves and startup version normalization under EPERM. Error injection is not native CIFS/SMB or FAT/exFAT verification. Re-run existing reader-policy, overlap, publication-refusal, JSONC and snapshot tests. Build, bundle, typecheck, two clean self-audits and independent review precede submission. Native Windows replacement tests remain platform-gated; do not count their local skips as verification.
