# Hosted Harness Private Protocol

[English](2026-09-21-hosted-harness-private-protocol.md) | [简体中文](2026-09-21-hosted-harness-private-protocol.zh-CN.md)

## Status

This document defines the implemented protocol foundation. Activating it in a `qwen serve` deployment, advertising it through `/capabilities`, and connecting it to the Java Runtime Broker remain follow-up work.

## Problem

The Java control plane will call a long-running qwen Hosted Harness over private session routes. A normal bearer token authenticates the caller but does not prove that both sides agree on the private protocol, the deployment capability set, or the current Harness process generation. Without an explicit contract, a client can continue sending work to a restarted or incompatible Harness and mistake a different in-memory generation for the original owner.

## Goals

- Define one versioned private protocol for Java-to-Harness session traffic.
- Give every Harness process generation a fresh, non-persistent boot identifier.
- Represent the deployment capability set with a canonical SHA-256 digest.
- Fail closed with stable HTTP status and error codes when the version or process generation does not match.
- Keep the contract independent from Runtime Broker transport and server-profile wiring.

## Non-goals

- This change does not add a Hosted Harness CLI profile or environment variables.
- It does not mount the middleware in `qwen serve` or change ordinary session routes.
- It does not implement the Java client, Runtime Broker, session recovery, or public Agent API.
- It does not define dynamic per-session agent configuration. Protocol v1 describes one deployment-level capability set.

## Protocol envelope

The deployment system computes canonical JSON for the available agent configuration, model routing, tool allowlist, and policy revision, then supplies its SHA-256 digest to the future Hosted Harness profile. The qwen process validates only the representation `sha256:<64 lowercase hex characters>` and does not read the source configuration or include secrets in the digest.

At process startup, the Harness creates an RFC UUID v1-v5 `bootId`; the default generator produces UUID v4. The identifier is lowercase in the envelope, changes on every process start, and is never persisted. The capability envelope has this shape:

```json
{
  "protocolVersions": { "current": 1, "supported": [1] },
  "bootId": "c3ea0f85-7c21-43c0-9705-ce127416587a",
  "capabilityDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

## Request fencing

The future Hosted Harness profile mounts the contract middleware only on private `/session` routes. Every request sends `X-Qwen-Harness-Protocol-Version: 1` and the `X-Qwen-Harness-Boot-Id` returned during capability negotiation. Every protected response returns the current `X-Qwen-Harness-Boot-Id`, including failures and SSE responses.

Validation runs in this order:

| Condition                                     | HTTP status | Error code                           |
| --------------------------------------------- | ----------: | ------------------------------------ |
| Missing or unsupported protocol version       |         426 | `hosted_harness_protocol_required`   |
| Missing or malformed boot ID                  |         400 | `invalid_hosted_harness_boot_id`     |
| Valid boot ID from another process generation |         409 | `hosted_harness_generation_mismatch` |

A 426 response also returns `Upgrade: qwen-hosted-harness/1`. A matching version and boot ID passes control to the session route. The comparison is case-insensitive because UUID text is case-insensitive, while the advertised identifier remains lowercase.

## Ownership and security

The boot ID is a process-generation fence, not an authentication secret or public identifier. Bearer authentication remains mandatory in the future Hosted Harness profile and runs before private session operations. The capability digest is not a credential; it pins admission to the deployment capabilities selected by the control plane. Neither field may be accepted from a model request or exposed through the public Agent API.

## Integration boundary

This foundation exports contract creation, digest validation, and an Express request handler. It deliberately has no production caller in this change. The next Hosted Harness profile change must create the contract once before the listener accepts traffic, reuse the same object for bootstrap and steady-state capabilities, and mount the handler after bearer authentication only for private session routes. Ordinary `qwen serve` deployments must remain unchanged.

## Validation

Focused unit tests verify envelope creation, random boot IDs, strict digest formatting, version negotiation, malformed and stale boot IDs, successful matching requests, response headers, and isolation from routes outside the middleware mount point.

## Acceptance criteria

- Contract creation rejects malformed capability digests and boot IDs.
- One contract object has one stable lowercase boot ID and protocol version 1.
- Missing or incompatible request fences fail with the documented stable status and code.
- A matching request reaches the downstream route.
- Routes outside the future private mount point remain unchanged.
- No Hosted Harness mode is advertised or activated until the follow-up profile wiring is implemented.
