# Verify ambiguous Linux Workspace birth times

[English](managed-workspace-birth-time-verification.md) | [简体中文](managed-workspace-birth-time-verification.zh-CN.md)

## Problem and scope

Issue #14453 reports new native Workspace registration failing when publishing its storage marker changes directory mtime in the same kernel clock tick as directory creation. The second identity read sees a legitimate `creationTime == lastModifiedTime` and rejects it as a possible JDK birth-time fallback. The same sequence is used by production Workspace creation.

The change is limited to native Linux identity verification. Existing registration, recovery, migration and retirement callers receive the fix through the shared identity reader. Injected readers, macOS, SSH storage, persisted identity bytes and SQL ownership checks retain their existing contracts.

## Decision and security contract

Nonpositive creation times still fail. Positive creation times different from mtime keep the existing path. Only a positive equal pair invokes `/usr/bin/stat` directly, without a shell, against the same canonical root. GNU stat returns `%d|%i|%w` with `LC_ALL=C` and `TZ=UTC`.

The native device and inode must equal the captured JDK values. Its birth timestamp is parsed with the JDK's strict date-time parser and must match the captured creation time to the nanosecond. Unknown birth times, malformed output, differing identities or timestamps, unsuccessful commands, timeouts and interruption all fail closed. The process has a five-second limit and a 256-byte output limit; it is terminated and streams are closed on exit, and interruption is restored.

The stored birth value remains the original `FileTime.toInstant().toString()`. Comparing only epoch seconds would permit a substituted mtime or a recycled inode in the same second to masquerade as the recorded identity. Relaxing equality without native evidence would remove the guard against filesystems without birth time.

This avoids scratch-file probes, cross-mount capability caches and mutation during identity reads. It adds no retries or sleeps. The existing creation-time workaround does not need to change to fix the marker-publication race.

## Constraints and risks

An ambiguous Linux identity now requires GNU stat at `/usr/bin/stat`. If the executable is absent or the filesystem does not provide verifiable birth time, registration and recovery remain unavailable. The probe is performed only for ambiguous timestamps; its latency is bounded but not measured here. Existing filesystem ownership and trusted-host assumptions continue to apply.

## Verification and acceptance

The existing native registration regression explicitly restores mtime to the actual birth time before verification. A second guard instance must still accept the original root, tolerate later mtime changes and refuse marker tampering or a replacement root carrying a copied marker. The old equality check rejects the forced-equality state deterministically.

A focused evidence-parser test accepts a matching full identity and refuses device, inode, nanosecond, missing-birth, invalid-date and malformed-output cases. The Java module verification and native Linux/MySQL acceptance remain required; parser checks alone do not prove production registration.

No local build or runtime acceptance was run while writing this change. The reporter's Linux failures remain attributed to the issue; the new reproduction attempt was blocked by execution-environment prerequisites. Verification results must be reported separately from this design.
