# Managed Workspace execution on macOS

[English](2026-10-17-managed-macos-local-runtime.md) | [简体中文](2026-10-17-managed-macos-local-runtime.zh-CN.md)

## Problem and current behavior

The Java Managed Agent can serve text Sessions on macOS, but Workspace tools require a registered physical storage owner. The registration reader only accepts Linux and reads `/etc/machine-id`. Durable local workers also require Linux host, boot and namespace identities. Disabling these checks does not create the physical storage registration that execution requires.

The requested behavior is to use the existing local Node.js tool worker on this Mac, with model and approval selection and an actual registered Workspace. Keep the Java control plane, SQL authority, Hosted Harness and Runtime Broker boundaries intact.

## Proposed changes

Add a small macOS host identity reader shared by storage registration and durable worker identity. Read the hardware `IOPlatformUUID` through the fixed `/usr/sbin/ioreg` command and the current kernel boot-session UUID through `/usr/sbin/sysctl -n kern.bootsessionuuid`. Bound command duration and output, reject missing or malformed UUIDs, and cache only the immutable hardware identity. Do not log raw identity values or allow configurable probe commands.

The Workspace guard retains the JDK canonical-directory and device/inode checks. macOS additionally reads exact birth time and device/inode in one bounded `/usr/bin/stat` snapshot, cross-checking the two native identities. JDK 21 truncates macOS birth time to seconds, so it cannot supply that identity. Parse native seconds and nanoseconds as integers. A positive native macOS birth time remains independent when equal to mtime, matching the CLI's existing macOS storage reader. Skip the Linux-only creation workaround that sets mtime to 1 ms after epoch: Darwin also moves birth time backwards. macOS uses the existing marker v2 and application-specific HMAC identity, with its hardware UUID as the secret input. Linux registration bytes, fallback birth-time refusal and identity derivation remain unchanged. Missing registration or native birth time, replaced roots, altered markers, overlap and ownership checks continue to refuse admission.

Durable local workers select the native host identity. Linux keeps its current host, boot, PID namespace and time namespace values. macOS uses a normalized hardware UUID, kernel boot-session UUID and explicit `macos` namespace labels. Existing `ProcessHandle` start-instant matching supplies macOS worker process identity. The saved handle must still match the same host and boot before the original worker is re-attested; a dead worker does not authorize replay or replacement.

This change enables same-boot Broker restart adoption on macOS. Trusted whole-host reboot recovery remains Linux-only: macOS deployments must set `trusted-local-reboot-recovery=false`. Do not claim reboot, cloned-disk or cross-machine recovery from the local smoke test.

## Affected components

- Managed Agent storage guard and its native identity tests.
- Runtime Broker native macOS identity reader, local worker identity selection and tests.
- Managed Agent setup and operational README.
- Local development configuration, held outside the repository, to register and grant a Workspace and connect the Broker to the Hosted Harness.

No public route, SQL schema, marker version or TypeScript contract change is needed. There is no fake registration, bypass mode or fallback to ordinary daemon tools.

## Decisions and constraints

Use JDK process and filesystem APIs and existing Commons digest utilities; add no dependency. Keep Linux identity and recovery behavior compatible. Reject unsupported platforms and unreadable native identity instead of using a hostname, random identity or mutable path as authority. Keep private runtime state and the storage marker outside Git worktrees; the project remains a child working directory of its registered storage root.

The macOS handle's namespace labels intentionally make an old reader reject it. Deploy the updated Java reader before retaining macOS workers, and keep the same state directory, database and credential key across same-boot restarts. Shell and file operations retain the existing approval contract.

## Validation and acceptance

1. Record global CLI behavior and the existing Java registration refusal before implementation.
2. Unit tests cover native UUID parsing, unavailable probes, platform refusal, same-boot identity and existing Linux formats. Real macOS tests compare exact registered birth time with independent Node bigint lstat, register an empty root, validate it across guard instances, and reject a replaced root carrying the original marker.
3. Run affected Java tests, `mvn verify`, and the MySQL integration profile against a separate disposable database. Run applicable local worker tests; identify Linux-only Hosted/fault profiles as unavailable on this Mac rather than claiming their qualification.
4. Register local storage offline, grant the development actor access, then use the real WebShell and model to read and write a unique test file. Verify bytes on disk, approval handling, model selection and a subsequent Turn. Verify same-boot worker adoption with a controlled local test.
5. Complete two clean self-audit passes and independent code review. Leave the working local stack available for the user's debugging.

## Open questions

None for this scope. macOS whole-host reboot recovery and other operating systems require separate qualification.
