# K2 effective service identity

[English](2026-10-17-k2-effective-service-identity.md) | [简体中文](2026-10-17-k2-effective-service-identity.zh-CN.md)

Status: implementation candidate for #13395 and Draft PR #13526.

## Problem and scope

Matching the protected unit file does not show which unit systemd loaded or
which process it started. The source and gateway need a live consumer for their
own effective service identity before installation qualification can be built.

## Design

Each service opens exactly one direct connection to `/run/systemd/private`.
Require root peer credentials and PID 1, then retain the original systemd
process, executable, pidfd and user/mount namespaces using the existing host
peer verifier and the independently validated `systemd` target. Authenticate
only with EXTERNAL UID 0. Do not use the system bus, reconnect, invoke service
management methods or create a shell/subprocess.

Read only `org.freedesktop.DBus.Properties.GetAll` for the fixed own unit's
`Unit` and `Service` interfaces. Bound calls and authentication to five seconds.
Require the exact native unit name, fragment path and system slice; loaded,
active and running state; no aliases, drop-ins, transient unit, pending reload
or extra execution hooks. Require Type=simple, root user/group, no dynamic
user, Restart=no, the current process as MainPID and ExecMainPID, and the exact
single ExecStart path/argv with a live, successful command record. Require
NoNewPrivileges, only CAP_SYS_PTRACE in the capability bounding set, no ambient
capabilities, the dedicated mandatory AppArmor profile, and no root image or
root directory substitution. Missing or differently typed properties fail.

Retain the first nonzero 16-byte InvocationID and monotonic service/unit start
times by value. Bracket each Service read with Unit reads and require the same
identity on both sides and on subsequent checks. Verify the original systemd
peer before and after. A connection, peer or property error permanently
invalidates this instance. Attach this verifier to the existing retained role
files, so startup and existing control, CSI, birth and background observation
checks consume it. Close the one connection and all retained descriptors on
partial initialization or shutdown.

Extend only the source/gateway profiles with the fixed private socket, the
reviewed systemd executable read, and read observation of systemd.
No system bus access or service management method is added. The private socket
transport itself does not enforce D-Bus method names; the fixed client and
reviewed actor policies remain part of the trust boundary.

## Limits and verification

This is a sampled effective service identity and selected security-property
check. It does not verify every hardening property, loaded policy semantics,
runtime handler selection, admission actors, exclusive CSI wiring, provenance
or uninterrupted lifecycle. It does not create installation or release
authority, change source/7, or enable RELEASED/history/reuse paths.

Portable tests use inert property maps to check both roles, exact types,
missing/changed fields, command lifecycle and identity copying. Compile the
actual Linux source/shim/assembler for amd64/arm64 without executing outputs.
Perform static call-site, cleanup and profile review, root build/typecheck,
and two full increment self-audit passes. Real systemd property compatibility,
private-socket authentication, loaded AppArmor permissions and native lifecycle
behavior remain unverified; previously refused native groups are not rerouted.
