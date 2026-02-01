# ADR 0001: Native Messaging Host Name + Protocol

**Date**: 2026-02-01
**Status**: Accepted

## Context

The extension and native host must agree on a stable Native Messaging host name and message model. Documents referenced two different host names and multiple message formats.

## Decision

- Use **Native Messaging** as the only extension ⇄ native host transport.
- Host name is **`com.chromemcp.nativehost`**.
- Message envelope follows `NativeMessageType` definitions in `app/native-server/src/shared/types.ts`.

## Consequences

- All guides and scripts must reference `com.chromemcp.nativehost`.
- Legacy message formats (e.g. `start_qwen`) are deprecated.

## Alternatives considered

- `com.qwen.mcp_chrome_bridge` (rejected: does not match current code).
