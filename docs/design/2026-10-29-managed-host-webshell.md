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
without constructing the Java provider, and `baseUrl` is only required on the
Java path. With neither a provider nor a `baseUrl` the entry renders the
unavailable notice instead of constructing a client against `/undefined/...`.

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
reuse existing Web Shell style adoption and release adopted styles on unmount;
release is idempotent so a second disposal cannot strip a sibling mount's sheet.

Navigation slots may live outside the shell container. Compiled CSS only matches
the shell and portal scopes, so the entry wraps each portaled list in a
`data-web-shell-portal-root` container and copies the shell's custom properties,
theme class and language onto it. `onArchivedSessionsStatusChange` is routed
through a ref so an inline host callback cannot retrigger the status effect.

The empty-state rule centers with auto margins on the content wrapper rather
than `justify-content: center`, keeping the session header at the top and its
content reachable when the group is taller than the pane. The marker is only set
for an idle, non-failed conversation with an empty transcript, so loading and the
first send do not center and then snap back. Returning to a pending request's
owner routes through the shared open path and carries the owning workspace id.

## Build and constraints

Run `npm run build:managed-host` from `packages/web-shell` (it wraps
`vite build --config vite.lib.config.ts --mode managed-host`). Output is
`dist-managed-host/index.js` with relative chunks.
This separate mode bundles React, React DOM and runtime dependencies and reuses
the existing CSS scoping and injection plugin. Serve the complete output directory
with JavaScript MIME types; no import map or separate CSS import is required.
The normal default and transcript builds keep their previous entry/external rules.
The mode is deliberately NOT part of the package `build`: it externalizes
nothing, so riding that script charged every local build and every fresh-clone
`prepare` with a full bundle of React, xterm, mermaid, echarts, shiki and
codemirror for an artifact no in-repo consumer reads. Rot detection lives in the
dedicated `Web Shell Managed Host Build` workflow instead, which runs the mode on
pull requests and post-merge pushes that touch the entry, its build config or the
lockfile, asserts a non-empty entry with the mount symbol and scoped CSS, and
checks the output stays out of the published `exports`/`files`. Its output also
lives outside `dist/` so the app build's `emptyOutDir` cannot delete a bundle a
host is already serving. A workflow meta-test pins both halves of that split, so
neither the missing gate nor the returning build tax can pass unnoticed.

The full-page host entry (`--mode app-host`) was removed from this PR: it had
no build wiring, no test coverage, and hardcoded host-specific sidebar/footer
configuration. It can be reintroduced in a follow-up PR with proper packaging
and tests once a named consumer exists.

## Validation and acceptance

React integration tests cover existing-ID loading and sending, no catalog/create/
daemon access, no-ID waiting and removal, read-only capabilities, and scope reset.
Existing Java tests remain the compatibility regression. A regression that restores
the unconditional catalog effect fails the host-only request assertion; restoring
creation without an ID fails the no-ID composer assertion. Package typecheck and
both default and managed-host builds validate integration. Real browser acceptance
is delegated to the host agent; no browser or cloud operation is performed here.

The follow-up additionally pins: an injected provider without `baseUrl`, a stable
archived-status callback across host rerenders, scoped wrappers and theme
variables in host slots, a pending-owner redirect that keeps the owning workspace
after the catalog drops it, and a repeated style release leaving a sibling mount
styled.
