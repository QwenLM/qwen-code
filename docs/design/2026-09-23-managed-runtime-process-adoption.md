# Managed Runtime process adoption

[English](2026-09-23-managed-runtime-process-adoption.md) | [简体中文](2026-09-23-managed-runtime-process-adoption.zh-CN.md)

Status: implemented. Updated: 2026-09-24. Continues the [attestation client](2026-09-23-java-runtime-attestation-client.md).

## This slice

The Broker starts a worker process, attests it, and only then stores the lease as READY. A later _binding_ use of that in-memory lease (`warm`, `acquire`) attests again through `RuntimeProvisioner.confirm`; if attestation fails, the binding is retired and its lease is released, so the next call provisions a fresh worker instead of retrying a dead record or leaving the rejected worker listening.

The session-scoped verbs that carry traffic (`dispatch`, `control`, `cancel`, `releaseSession`) do not re-attest per call. They consult a cheap local liveness check (`RuntimeProvisioner.isUsable`, the provisioner's owned-process/`isAlive()` lookup) before using the lease; a dead process retires the binding the same way, so a later call re-provisions. `release` of a session whose worker is already dead finishes locally: an unsettled execution still reports `runtime_session_busy`, and otherwise the session moves to `RELEASED` without calling the transport. Only the binding entrance proves identity over HTTP. The ready `url` must be `http` on `127.0.0.1`, the only address the worker binds; any other origin is an invalid ready record and is never sent the bearer token.

A provisioning call that loses its claim after adopting a process (`runtime_provision_fenced`) releases that lease through `RuntimeProvisioner.release`, so a fenced attempt never orphans a running worker. Closing the service closes the provisioner it was built with.

The worker is the merged `managed-runtime-worker` command: one boot JSON document on stdin, one ready record on stdout. The preview `--boot-config` file launch is not used. The ready record read is bounded (32 KiB) and the worker's stdout stays open and drained for the worker's lifetime, because the worker treats a closed stdout pipe as fatal.

Tool HTTP (`POST /internal/managed-runtime/v2/execute`) is on the Java client. The merged worker still exposes only attestation, so execute against that process is a non-retryable 404. Mounting real tool handlers stays with the Hosted ordinary-tools slice.

## Not in this slice

Per-call HTTP re-attestation on the session-scoped verbs; only the binding entrance attests, the verbs check local liveness. A Broker crash can still orphan the worker; that needs a worker-side parent watch. `stop` and `close` still send SIGTERM and do not escalate to SIGKILL. Spring configuration and Flyway live with the Java control-plane module, which is not on `main`. Kubernetes provisioning stays out. This slice uses the existing in-memory and JDBC repositories; it does not add a server.
