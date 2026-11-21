# Capability-gated session-only model selection

[English](2026-11-04-session-only-model-selection.md) | [简体中文](2026-11-04-session-only-model-selection.zh-CN.md)

## Status

Repair prototype for issue #15702. The published 0.26.6 AWS baseline is recorded
in the local E2E report. The public parameter and capability names remain
proposals until maintainer review.

## Problem

The daemon SDK exposes only default-persisting model selection. The underlying
ACP agent already supports session-only selection through
`qwen.session.modelPersistDefault`, and records that selection for cold restore.
REST forwards the metadata, but the ACP dispatcher rebuilds model requests and
drops it. A successful ACP response can therefore conceal a default-setting
change. The bridge also broadcasts a workspace settings change for ordinary
session-only selections.

## Scope

Expose the existing mechanism through the typed daemon SDK and both daemon
transports. Preserve positional client identities, omitted-option behavior,
session ownership, model-change serialization, and existing recording semantics.
Do not change Core configuration, transcript formats, the Web Shell, MCP tool
schemas, or scheduled-task creation.

## Design

Add `session_set_model_transient` independently of `session_set_model`. The SDK
requires it before sending `persistDefault: false`; unsupported daemons fail
before receiving a model mutation. Omitted options and explicit `true` retain
existing persistence behavior and do not require the new capability.

`DaemonClient.setSessionModel` accepts the existing client-id string or an
options object containing `clientId` and `persistDefault`. The session wrapper
accepts `persistDefault` separately while retaining its own client identity.

REST exposes `persistDefault` as a first-class boolean. A shared CLI parser maps
it to the existing ACP metadata key and is used by the REST model route and both
ACP model setter entry points. Valid legacy metadata remains supported. Invalid
types and conflicting public/legacy values fail before the bridge is invoked;
neither source silently overrides the other. Unrelated metadata is preserved.
The daemon-only public field is removed before forwarding the ACP request.

Session-only selections emit `model_switched` but no workspace
`settings_changed`. Default-persisting selections retain both events. The
existing per-session queue remains responsible for ordering.

The new capability concerns legacy default-setting persistence. The Managed
parity entry documents that legacy concern without adding a Java API.

## Affected files

The SDK client and session wrapper; daemon capability registry and parity table;
shared model-option parser; REST model route; ACP dispatcher; bridge model
control; associated tests and protocol documentation.

## Risks and constraints

An old daemon may ignore unknown request fields, so no fallback mutation is
allowed after failed capability negotiation. REST and ACP must validate the same
values. The path/session owner and client lease remain authoritative. Recording
is already best-effort; this change does not promise crash durability at the
instant the switch response is returned. Existing standalone and scheduled-task
rules continue to apply.

## Validation and acceptance

- Legacy calls retain their request body and client identity without preflight.
- Unsupported transient requests perform no model mutation.
- Public fields and legacy metadata agree across REST, ACP HTTP, and ACP WS;
  conflicts and malformed values are rejected before mutation.
- Switching A to M1 keeps B, new C, and user/workspace defaults at M0.
- A real mock-provider request uses M1, and cold restore retains M1.
- The session event remains observable without a workspace default-change event.
- Focused unit tests, build, typecheck, and AWS E2E verification cover the patch.

## Open questions

Maintainer review must confirm the public parameter and capability names. The
existing MCP tool and UI retain default-persisting behavior; exposing controls
there is outside this change.
