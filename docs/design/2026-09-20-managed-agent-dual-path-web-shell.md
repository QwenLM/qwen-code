# Managed Agent Dual-Path WebShell

[English](./2026-09-20-managed-agent-dual-path-web-shell.md) |
[简体中文](./2026-09-20-managed-agent-dual-path-web-shell.zh-CN.md)

## Status

Implemented and locally verified on 2026-09-20. Production products opt in
through the existing public WebShell provider prop.

## Problem

The Java Managed Agent path previously had a daemon-free, Managed-only entry.
That entry proves the browser-to-Java contract, but it does not demonstrate how
Managed Sessions coexist with the complete WebShell used by `qwen serve`.

Java must not implement the daemon protocol merely to reuse the full UI. The
ordinary and Managed paths have different owners and must remain independently
deployable.

## Goals and scope

- Reuse the complete WebShell chrome for a deployment that has both an
  ordinary daemon and the Java Managed Agent service.
- Route each surface to its existing owner without translating one protocol
  into the other.
- Preserve the daemon-free Managed-only component for products that do not run
  an ordinary daemon.

This change does not merge Java and daemon Session state, add authentication to
the standalone Spring service, or expose private Harness and Runtime APIs.

## Decision

The complete WebShell keeps its existing daemon providers and receives an
explicit Java `ManagedAgentProvider` for the Managed panel:

```text
Full WebShell
├── ordinary chat, workspace, settings, terminal ──> Qwen daemon
└── Managed Sessions ──> Spring WebShell API ──> Hosted Harness
                                             └──> Runtime Broker ──> Tool Runtime
```

`App` already accepts `managedAgentProvider`; no daemon API is replaced. The
standard Vite entry adds a Java API proxy and creates the provider only when
`managedProvider=java` is explicitly present in development. `managed=1`
selects the existing Managed panel, and `managedSession` remains its deep-link
identifier.

The Managed-only `ManagedAgentWebShell` remains the preferred entry for a
product without an ordinary daemon. A production dual-path host creates the
Java provider itself and passes it to `WebShellWithProviders`; URL-based tenant
selection is not a production contract.

## Security and ownership

- The browser calls only the public Spring WebShell API. Harness, Runtime
  Broker, and Tool Runtime endpoints and credentials stay private.
- The development `tenant` query parameter is only a test convenience. A
  production upstream derives tenant identity and supplies the Java API header.
- Ordinary WebShell requests continue to use the daemon credential and daemon
  workspace ownership rules.
- Java Session ids and daemon Session ids remain separate namespaces. Opening a
  Managed deep link does not restore a daemon Session.
- The Java API proxy is registered on its exact route prefix before daemon
  routes, so Managed traffic cannot fall through to the daemon.

## Risks and mitigations

- A missing ordinary daemon leaves non-Managed panels unavailable. The
  Managed-only component remains the correct entry for that topology.
- A browser-provided tenant would be unsafe as production identity. The URL
  adapter is development-only; production hosts derive tenant identity.
- Two backends can make ownership ambiguous. The exact Java route prefix and
  explicit provider selection keep routing deterministic.

## Local activation

Run an ordinary daemon, the Spring/Hosted-Harness/Runtime chain, and the WebShell
development server:

```bash
QWEN_DAEMON_URL=http://127.0.0.1:4170 \
QWEN_MANAGED_AGENT_JAVA_URL=http://127.0.0.1:8080 \
  npm run dev:managed-agent-web
```

Open
`http://127.0.0.1:5174/?managed=1&managedProvider=java&tenant=local-java-demo`.

## Validation plan

- Unit-test explicit Java selection, tenant header propagation, and unchanged
  fallback behavior.
- Verify the exact Java proxy target alongside the existing daemon proxies.
- Run the real browser through Java, Hosted Harness, Runtime Broker, and Tool
  Runtime, then open a daemon-owned panel in the same page.

## Acceptance criteria

1. The page renders the standard WebShell chrome and opens the Managed panel.
2. Managed list, create, replay, submit, cancel, and event streaming call only
   `/api/agent/web-shell/v1/**` and carry the selected development tenant.
3. Existing daemon panels continue to use the ordinary daemon.
4. Without `managedProvider=java`, standalone WebShell behavior is unchanged.
5. The Managed-only exported component remains daemon-free.

## Verification result

The full page loaded an existing Java Managed Session, completed a new turn
with the exact response `FULL_SHELL_OK`, and then opened the daemon-owned Status
panel in the same browser page. The development proxy returned both the Java
Session list and daemon health successfully. Focused WebShell tests covered the
startup adapter, proxy registration, and Managed panel behavior when daemon
workspace context is not yet available.
