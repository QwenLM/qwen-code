# Managed Runtime process adoption

[English](2026-09-23-managed-runtime-process-adoption.md) | [简体中文](2026-09-23-managed-runtime-process-adoption.zh-CN.md)

Status: implemented. Updated: 2026-09-23. Continues the [attestation client](2026-09-23-java-runtime-attestation-client.md).

## This slice

The Broker starts a worker process, attests it, and only then stores the lease as READY. A later use of that in-memory lease attests again. If the process is gone, the call fails instead of reusing the old endpoint.

The worker is the merged `managed-runtime-worker` command: one boot JSON document on stdin, one ready record on stdout. The preview `--boot-config` file launch is not used.

Tool HTTP (`POST /internal/managed-runtime/v2/execute`) is on the Java client. The merged worker still exposes only attestation, so execute against that process is a non-retryable 404. Mounting real tool handlers stays with the Hosted ordinary-tools slice.

## Not in this slice

Spring configuration and Flyway live with the Java control-plane module, which is not on `main`. Kubernetes provisioning stays out. This slice uses the existing in-memory and JDBC repositories; it does not add a server.
