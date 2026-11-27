# Serve Runtime Broker on the Managed Agent HTTP listener

[English](2026-11-27-managed-runtime-broker-shared-listener.md) | [简体中文](2026-11-27-managed-runtime-broker-shared-listener.zh-CN.md)

Status: prelaunch proposal, 2026-11-27. Scope covers the standalone Managed Agent Server and its launchers in Qwen Code. Source baseline is Qwen Code `main` at `94b1d9dc0d42dabab71adc6f94a23eab80d95889`. Implementation and runtime acceptance are pending.

## Current behavior and objective

`EmbeddedRuntimeBroker` constructs the Java `RuntimeBrokerService` and starts a JDK `RuntimeBrokerHttpServer`, which defaults to port 4182. Hosted Harness uses a configured HTTP origin, appends `/internal/runtime-broker/v1`, and authenticates with the deployment's Broker Bearer token. The standalone Managed Agent server already has a Spring Web listener and an optional internal connector for `/internal/**`.

[Broker HTTP implementation](../../packages/managed-agent-server/server/src/main/java/com/alibaba/qwen/code/runtimebroker/http/RuntimeBrokerHttpServer.java) · [Hosted Harness client](../../packages/cli/src/serve/managed-runtime-broker-client.ts) · [MA internal routing](../../packages/managed-agent-server/server/src/main/java/com/alibaba/qwen/code/managedagent/config/InternalSurfaceConfiguration.java)

Hosted Harness reaches the Broker through the existing Managed Agent HTTP listener, alongside Session Store. This is the sole HTTP entry point for the Broker. `RuntimeBrokerService` owns runtime binding, dispatch, cancellation, receipts, and recovery.

Anthropic documents a comparable listener arrangement for its self-hosted Managed Agents server. Worker and application API calls share the server's API address. Its worker polling protocol is a separate design choice. [Anthropic self-hosted listener documentation](https://platform.claude.com/docs/en/managed-agents/self-hosted-data-and-access#where-the-server-listens)

## Shared listener and credentials

Register the Broker routes from `ManagedAgentWebConfiguration` when `qwen.managed-agent.runtime-broker.enabled=true`. Remove the Broker's JDK listener, listener-specific settings, and independent port reservation in the same delivery.

The standalone server uses its existing internal connector when configured. `qwen serve --managed` uses its existing Java loopback port. A standalone main connector bound beyond loopback requires a separate Managed Agent internal connector when the Broker is enabled. Remote Harness calls use the deployment's TLS-protected internal ingress.

Use Spring's routed path and the actual listener to enforce route ownership. Require the existing Broker Bearer token before parsing the request body, with the same constant-time check and Broker error envelope. Public API signatures, Session Store writer credentials, and Broker credentials have separate authorization scopes. Use the Broker's current path parsing and resource checks after route admission. The standalone public ingress and the local CLI front door exclude this prefix.

## Share the existing HTTP protocol implementation

In the server module, move the existing Broker request dispatch, bounded body decoding, and response encoding into the Spring entry point. It delegates to `RuntimeBrokerService`. Spring owns the HTTP listener, and `EmbeddedRuntimeBroker` owns the service lifecycle.

Preserve the raw path and protocol version checks, response status and JSON fields, the 8 MiB body limit even for streamed bodies, and execution acknowledgements and retry semantics. Keep response completion asynchronous and account for the existing client and operation deadlines when configuring the servlet async timeout. Carry the bounded Broker request admission into the Spring path, including reads of request bodies, so tool traffic does not exhaust the shared connector's request capacity. A disconnect or HTTP timeout detaches the response while the admitted operation continues under the service's existing rules.

## Deployment configuration

Set the internal MA origin once in the launcher or deployment template. Use it for the Session Store base URL and `QWEN_MANAGED_RUNTIME_BROKER_URL`. Hosted Harness appends the current path. Update `--check`, the systemd bootstrap, and the local launcher to use that origin. Remove `brokerPort` from local port allocation and state.

## Acceptance

1. Move existing Broker HTTP contract cases to Spring. Cover acquisition, tool start and status, cancellation, release, response-loss recovery, malformed inputs, and the 8 MiB limit. Verify status, response fields, retry flags, and durable outcomes against the current contract.
2. Use real HTTP to verify isolation on the standalone internal connector and the local CLI front door. Cover routed-path normalization and refusal of missing or wrong Broker credentials, including valid credentials intended for other surfaces. Check startup rejection for unsupported standalone bindings.
3. Run a packaged Hosted Harness against Spring. Verify tool execution, cancellation or readback after a lost response, and reopening the original session after restart. Confirm only the MA listener serves Broker and Session Store, with no independent Broker listener.
4. Apply Broker request pressure while exercising MA API and Session Store traffic. Verify bounded admission, that those calls continue to make progress, and that shutdown completes cleanly.
5. Verify preflight and local startup and reload with one fewer port. Record real process and MySQL results separately from protocol fixtures.
