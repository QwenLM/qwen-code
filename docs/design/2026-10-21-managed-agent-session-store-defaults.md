# Managed Agent Session Store Defaults

[English](2026-10-21-managed-agent-session-store-defaults.md) | [简体中文](2026-10-21-managed-agent-session-store-defaults.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

Every Hosted Harness deployment must also enable and wire the Managed Session Store, but the store's three settings repeat values the server already knows:

- `qwen.managed-agent.session-store.enabled` defaults to `false`, while startup refuses an enabled Harness without the store. Its value is always `true` when the Harness is enabled.
- `session-store.base-url` has no default, while the single-host reference topology always points it at this server's own loopback listener.
- `session-store.workspace-id` has no default, while it must equal the Runtime Broker's workspace ID when the Broker has one. The local-process Broker derives that ID from the canonical Workspace path and refuses any other explicit value.

The result is that the documented paths do not start as written:

- The reference deployment's "Start the Java control plane" step enables the Harness without the store, so startup fails with `Hosted Harness requires the Managed Session Store`.
- The `server.env` template, the credential bootstrap and the deployment tool-path example set `QWEN_MANAGED_AGENT_WORKSPACE_ID=reference-workspace`. That value is also the Broker's workspace ID, so enabling the documented local-process tool path fails with `Runtime Broker workspace ID must match the canonical workspace path hash`. The operator must compute a SHA-256 prefix by hand.
- The preflight check does not evaluate the store wiring, so it passes a configuration that startup then refuses.

## Goals

- An enabled Harness implies an enabled Session Store unless the operator explicitly disables it.
- In the single-host reference topology, the store base URL and workspace ID need no configuration.
- The Session Store and Runtime Broker resolve one workspace identity from the same inputs.
- Preflight reports store wiring that startup would refuse.
- The shipped templates, bootstrap and documentation start as written.

## Non-goals

- Changing any explicitly configured value. Every derived value applies only when the setting is blank.
- Deriving a store URL for a remote or containerized Harness. Those topologies keep configuring it explicitly.
- Changing the shared credential model (Harness token and capability digest), the CLI's broker arguments or port selection. Those are separate follow-ups.
- Migrating existing deployments to a derived workspace ID.

## Design

### Store enablement

The `session-store.enabled` default in `application.yml` becomes `${QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED:${qwen.managed-agent.harness.enabled:false}}`. The default is resolved in the Spring `Environment`, so the `@ConditionalOnProperty` beans gated by the store observe the same value as the bound properties. It follows the Harness setting from any source, including `config/application.yml`. An explicit `false` with an enabled Harness still fails at startup with the existing message.

### Store base URL

When the store is enabled and `session-store.base-url` is blank, `ManagedAgentProperties` derives it during startup validation from the listener that serves the internal store routes:

- the dedicated internal listener (`internal-server.address` and `internal-server.port`) when `internal-server.port` is positive;
- otherwise the public listener (`server.address`, and `server.port` with the Spring Boot default `8080`).

The URL is `http://127.0.0.1:<port>` when the address is blank, `0.0.0.0`, `::` or `127.0.0.1`, and `http://[::1]:<port>` for `::1`. Any other address, or a non-positive port (for example a random test port), derives nothing, and the existing startup refusal still asks for an explicit URL. A public listener that serves TLS also derives nothing: Spring Boot enables TLS when `server.ssl` is bound and enabled, the derived URL would be plaintext, and an HTTPS URL must name a host the certificate covers. The dedicated internal listener is always plaintext, so it still derives behind a TLS public listener. A loopback literal satisfies the existing plaintext-transport and internal-port checks, so no other validation changes.

Derivation needs the Spring `Environment` to read `server.*`. Preflight binds without a Spring context, so it now passes its environment to the bound properties. A plain `new ManagedAgentProperties()` without an environment derives no URL.

### Store workspace ID

When the store is enabled and `session-store.workspace-id` is blank:

1. If `runtime-broker.workspace-id` is set, the store uses it.
2. Otherwise, when `runtime-broker.workspace-cwd` is set and the provisioner is `local-process` or `kubernetes`, the store uses the ID the Broker would derive: the first 16 hexadecimal characters of the SHA-256 of the canonical Workspace path. The derivation calls the Broker's own resolution, so the two cannot diverge.
3. Otherwise, the ID stays blank and the existing startup refusal applies.

Both properties read `QWEN_MANAGED_AGENT_WORKSPACE_ID` and `QWEN_MANAGED_AGENT_WORKSPACE_CWD`, so the reference configuration names the Workspace by its path (`QWEN_MANAGED_AGENT_WORKSPACE_CWD=/srv/qwen-workspace`) and omits the ID. The same identity then holds for a text-only deployment and after the local-process tool path is enabled. The derivation also applies when the Broker is disabled. A text-only deployment can therefore enable the tool path later without changing the store scope of its existing unbound Sessions.

The local-process derivation resolves the real path, so the directory must exist. An unresolvable path fails startup with the Broker's existing `Runtime Broker workspace cwd could not be resolved` message before any traffic.

### Preflight

A new `session-store` row reports the effective wiring after derivation:

- `SKIP` when the Harness or the store is disabled (the existing `validation` row already fails an enabled Harness without the store);
- `FAIL` when the base URL or workspace ID is still blank, with a fix that names the variables to set;
- `PASS` with the effective URL and workspace ID otherwise.

The startup refusal for a blank URL or ID also names the variables to set.

### Templates, bootstrap and documentation

- `server.env.example` and the bootstrap's `server.env` drop `QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED`, `QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` and `QWEN_MANAGED_AGENT_WORKSPACE_ID`, and set `QWEN_MANAGED_AGENT_WORKSPACE_CWD=/srv/qwen-workspace`, the directory the systemd README already creates.
- The reference deployment guide (English and Chinese) adds the Workspace directory to the base start and removes the conflicting ID from the tool-path example.
- The server README and systemd README describe the derived defaults.
- The development launcher keeps writing explicit values, which still take precedence.

## Compatibility and risks

- Existing deployments set the store's values explicitly, and explicit values are unchanged. A deployment that kept the store disabled with an enabled Harness could not start before this change.
- A deployment that runs the store without a Harness keeps its explicit setting. Its default stays `false` because it follows the disabled Harness.
- Unbound Sessions resolve their store scope from the global workspace ID. An operator who replaces an existing explicit `QWEN_MANAGED_AGENT_WORKSPACE_ID` with the derived default changes that scope. The deployment guide says to keep an existing ID.
- The store's workspace ID is still compared only with the Broker's configured ID, not with its derived one. A split configuration that sets only `session-store.workspace-id` while the Broker derives its own keeps the current behavior. This change does not widen that gap.

## Validation plan

- Unit tests on `ManagedAgentProperties`: the `application.yml` default follows the Harness and an explicit `false` still wins; the URL derives for the public and internal listeners, each accepted address form and the IPv6 loopback; it stays blank for a specific non-loopback address, for port `0` and for a TLS public listener, while the internal listener behind a TLS public one still derives; explicit values are never replaced; the workspace ID follows the Broker ID, otherwise the canonical cwd hash, and matches the Broker's own resolution.
- Preflight tests: the `session-store` row reports `SKIP`, `FAIL` and `PASS`, and preflight derives the URL through its environment.
- Template tests: the bootstrap output and `server.env.example` no longer carry the removed variables and set the Workspace directory.
- Module verification: `mvn verify` in `packages/managed-agent-server`.
- End-to-end: build the reference archive, then follow the deployment guide literally against MySQL and a real `qwen serve --profile hosted-harness`. Run `--check`, start, and complete one text-only Turn. Repeat with the local-process tool path enabled as the guide lists it. Run the same steps on `main` as the baseline.

## Acceptance criteria

- The deployment guide's base start sets no `QWEN_MANAGED_AGENT_SESSION_STORE_*` variable and no workspace ID, and it starts and completes a Turn.
- Enabling the guide's tool-path variables on top of it starts without a workspace ID mismatch.
- Preflight fails exactly the store wiring that startup refuses.
- Explicit configuration behaves as before.

## Follow-up work

- Read the Harness token and capability digest from one shared secret file for both processes.
- Give the CLI's broker URL and token an environment or file source, and make the Hosted Harness profile fail on an occupied port instead of moving.
