# Managed Web Shell host integration

[English](2026-10-29-managed-host-webshell.md) | [简体中文](2026-10-29-managed-host-webshell.zh-CN.md)

## Problem and scope

A non-React host owns an existing managed Session and exposes a limited BFF. It
needs the official conversation and composer without mounting daemon contexts or
using the Java Session catalog. This change stays inside Web Shell; the host
implements transport, authentication, authorization and actual browser acceptance.

## Contract and decisions

`ManagedAgentWebShell` accepts `managedAgentProvider?: ManagedAgentProvider` and
`hostSessionOnly?: boolean` (default `false`). An injected provider is used
without constructing the Java provider; omission preserves Java behavior.

Host-only mode opens only the explicit `sessionId`. Missing IDs render an empty
conversation region, without listing, choosing or creating Sessions. The internal
catalog, New button and catalog refresh are hidden. Existing Session loading uses
`getSession`, `getTranscript` and `subscribeEvents`; sending uses `submitPrompt`.
The official message list and composer retain the provider's capabilities, so
`canSend: false` disables submission and `canCancel: false` exposes no cancel
operation or Escape hint, including when an old cancellation intent is stored.
Without model-change capability the host view hides the model selector and fixed
model hint; Agent identity is never presented as a model. Unsupported optional
APIs must be omitted by the host provider. A
four-API provider supplies rejecting stubs for required catalog/create/cancel
methods; the host path never invokes these stubs. Generic `submitPrompt` admission
requires `sessionId` and `turnId`; `operationId` is optional because a host may
expose event streaming without a durable-operation API. Java still validates its
real operation identity; cancel and cancellation recovery retain their strict
operation identity contract.

The provider's `storageKey` must include tenant and actor identity. Replacing that
scope clears selection, pending requests, conversation and subscriptions; a
carried-over ID is dropped until the host supplies a new explicit selection.
Pending host sends are additionally isolated by Session ID. Short-lived token
refresh should keep provider identity stable. Brand, theme, language, portal
container and scoped CSS retain their existing implementation.

`renderManagedAgentWebShell(container, props)` creates a React root and returns
`{ update(nextProps), unmount() }`. Updates replace the complete props object.
The host owns the container and calls `unmount()` on disposal. No daemon provider,
service or alternate conversation page is introduced. Containers inside a ShadowRoot
reuse existing Web Shell style adoption and release adopted styles on unmount.

## Build and constraints

Run `npx vite build --config vite.lib.config.ts --mode managed-host` from
`packages/web-shell`. Output is `dist/managed-host/index.js` with relative chunks.
This separate mode bundles React, React DOM and runtime dependencies and reuses
the existing CSS scoping and injection plugin. Serve the complete output directory
with JavaScript MIME types; no import map or separate CSS import is required.
The normal default and transcript builds keep their previous entry/external rules.

## Validation and acceptance

React integration tests cover existing-ID loading and sending, no catalog/create/
daemon access, no-ID waiting and removal, read-only capabilities, and scope reset.
Existing Java tests remain the compatibility regression. A regression that restores
the unconditional catalog effect fails the host-only request assertion; restoring
creation without an ID fails the no-ID composer assertion. Package typecheck and
both default and managed-host builds validate integration. The local E2E plan in
`.qwen/e2e-tests/managed-host-webshell.md` delegates real browser acceptance to the
host agent; no browser or cloud operation is performed here.
