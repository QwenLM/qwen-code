# Preflight: Harness Compatibility, Leftover Workers and Online Mode

[English](2026-10-23-managed-agent-preflight-harness-workers-online.md) | [简体中文](2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

`bin/qwen-managed-agent-server --check` leaves gaps an operator meets on a first install or an upgrade.

- **Harness compatibility.** The `harness` row only checks that `/capabilities` answers 200 with the configured token. A Harness with another capability digest, an older protocol, or without the lifecycle that a Workspace profile needs passes. Its PASS even says "the digest is checked on the first Session". The control plane then refuses every Session, or every tool Session.
- **Leftover workers.** The control-plane unit uses `KillMode=process`, so `systemctl stop` leaves Runtime workers running. The guide asks the operator to reap them before the next start. Preflight is run exactly then, and says nothing.
- **A running service.** The port rows bind the configured addresses, so `--check` reports false failures while the service runs. Operators cannot run it on a live host at all.
- **A stopped service.** The port rows bind without `SO_REUSEADDR`. For about a minute after a stop, a port the server left in `TIME_WAIT` fails them, although Tomcat and the Broker's `HttpServer` bind it normally.

## Goals

- The `harness` row applies the same negotiation the first Session applies, and the lifecycle each configured Workspace profile needs.
- It reports a Harness that runs another Qwen Code version than the distribution's `manifest.json` names, or that does not say which version it runs.
- Preflight reports Runtime workers that an earlier run left alive.
- `--check --online` runs against a live service without false failures.
- The offline port rows agree with the server on a port in `TIME_WAIT`.

## Non-goals

- Starting a Session or a Turn from preflight.
- Killing workers. Preflight only reports them.
- Negotiating with each endpoint of a Harness pool. With `harness.pool.enabled`, the `harness` row skips a pool's endpoints once the Session Store is enabled with a binding key, and fails until then; pool readiness is verified after startup.
- Checking the Harness's optional features. The control plane turns most of them off when they are absent. The one it cannot turn off, `workspace-shell-mcp/1` for Shell Sessions that pin MCP servers, gets a WARN, because preflight cannot see which agents pin MCP servers.

## Design

### Harness compatibility

After the existing probe answers 200, the `harness` row builds a `HostedHarnessClient` with the configured base URL, token and digest, then closes it. Building the client negotiates as the first Session does: capabilities schema 1, the REST transport, the required features, Hosted Harness protocol 1, a well-formed boot ID, and an equal capability digest.

Failures are told apart:

- A different digest fails as "advertises another capability digest", without printing either value. With the credentials file, the fix names the file's `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST`, which both sides read. Without it, the fix names both variables: the Harness's `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` and the control plane's `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST`.
- A transport failure, client saturation, or an HTTP error on the negotiation's own request fails as "did not answer the compatibility request" or "answered the compatibility request with HTTP `<status>`", with a retry fix. A 401 or 403 names the token setting, as the probe does. Only the status is printed, never the response body.
- A base URL the client cannot use, such as one with credentials, fails naming `QWEN_MANAGED_AGENT_HARNESS_BASE_URL`.
- Any other negotiation failure is a protocol mismatch. It fails with the client's message, and the fix names the Qwen Code version to install.

Every detail shows the URL without its user information. Text that comes from the Harness, such as a client message, has control characters replaced and is cut to 200 characters.

Then each Workspace profile the deployment may admit needs its lifecycle, by the rule the connector applies, `WorkspaceToolProfiles.lifecycleProtocol`. The profiles are `hosted-workspace-files/1` and every `definition-tool-profiles` entry while Workspace files are enabled, plus `hosted-workspace-shell/1` while Shell is enabled.

- A protocol 1 profile fails unless the Harness offers lifecycle protocol 1, and the fix names the version to install.
- A protocol 2 profile fails unless `lifecycleV2Profiles` lists it.
  - The fix adds it to `QWEN_HOSTED_LIFECYCLE_V2_PROFILES`.
  - An explicit value replaces the whole list, so the fix names the complete list to set: the protocol 2 profiles the Harness already offers, then the ones the deployment needs.
- Profiles outside both protocols, such as `hosted-workspace-files/3`, are not checked.

A PASS reads "compatible: Hosted Harness protocol 1, capability digest matches, Qwen Code `<version>`". The row WARNs, with the version to install as the fix, in three cases:

- `qwenCodeVersion` in the capabilities response differs from `compatibility.qwenCodeVersion` in `manifest.json`;
- the response has no `qwenCodeVersion`, or one that is not a plain version (`[0-9A-Za-z.+-]{1,64}`), while the manifest names one;
- Shell is enabled and `hostedHarness.features` lacks `workspace-shell-mcp/1`.

Preflight finds the manifest with the locator the `database` row uses. That locator takes the first classpath jar with a `manifest.json` beside its `lib/` directory, then falls back to the server jar's own location. Without a manifest, the version is not compared.

### Leftover workers

A new `workers` row runs only when the local-process Runtime is enabled with a state directory, and only where `/proc` exists. Online and offline give the same reason when it does not run.

- **Matching.** A worker runs `node <entry> managed-runtime-worker`, with the state directory as its working directory. Preflight therefore matches a process only when both hold:
  - its executable's name starts with `node`, and its last argument is `managed-runtime-worker`, following an absolute path;
  - its `/proc/<pid>/cwd` is the state directory's real path.

  The kernel appends " (deleted)" to that path once the directory is removed. Preflight drops the suffix, so a worker that kept a deleted and recreated directory still matches. Its own process never matches. Other deployments' workers, and diagnostics that merely mention the marker, are not matched.

- **Results offline:**
  - `PASS` when none is alive.
  - `WARN` with the count and pids. Without a durable Broker, the fix is `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server` or killing those pids. With one, which adopts its workers at startup, the fix says so and keeps the reap for a clean start, as an upgrade does.
  - `SKIP` without a local-process Runtime, without `/proc`, or before the state directory exists.
  - `WARN` when the state directory exists but cannot be resolved, for example for lack of permission, since preflight then cannot tell.
  - `WARN` when a process whose argv names a worker cannot be inspected, for example because another account owns it: its `/proc` entries need the caller's ptrace access. A scan that also found leftovers names both the alive pids and the uninspected count, so a partial list is never presented as the whole one.

It is a WARN rather than a FAIL because a durable Broker can adopt its workers. The guide still asks for a clean start before an upgrade.

### Online mode

`--online`, or `--online=true`, marks a run against a live service; `--online=false` checks offline. Any other `--online=` value fails an `online` row, and the remaining rows still run offline, so the port and worker rows can report the live service's own state.

- The `server-port` and `broker-port` rows connect to the configured address, with a wildcard address mapped to `127.0.0.1`, instead of binding it. They pass when something listens. An unresolvable host fails as "cannot resolve", and a failed connect names its cause.
- The `workers` row depends on the Broker:
  - A durable Broker adopts surviving workers, so online it cannot tell them from leftovers and SKIPs with that reason.
  - For a non-durable Broker it reports matched workers whose parent is not a Java process. Those are the orphans `KillMode=process` reparents to init, not children of the running server.

Every other row runs as before. Offline, a port in use names `--check --online` in its fix.

### Port rows offline

The offline port rows bind with the JDK's default `SO_REUSEADDR`, as Tomcat and the JDK `HttpServer` do. A port left in `TIME_WAIT` by the stopped server passes, while Linux still refuses a bind over a live listener.

## Failure semantics

- The `harness` row fails, so `--check` exits 1, on:
  - a digest mismatch or another negotiation failure;
  - a compatibility request that was not answered;
  - an unusable base URL;
  - a missing lifecycle.
- The `harness` row warns on another Qwen Code version than the manifest's, on a version the Harness does not advertise readably, or, with Shell enabled, on a missing `workspace-shell-mcp/1`.
- The `workers` row warns on live workers in the state directory while offline, on orphaned workers online without a durable Broker, and on a state directory that cannot be resolved.
- `--online` with nothing listening on a port fails that port row. An `--online=` value other than `true` or `false` fails the `online` row.

## Compatibility and risks

- A `harness` row that passed before can now fail. The mismatch it reports would have failed every Session, or every Session of that profile, so this moves the failure earlier.
- The negotiation sends a second request to `/capabilities` and starts the client's thread pools for its duration.
- Process arguments and `/proc/<pid>/cwd` are readable for the operator's own processes and for root. Run as another account, preflight may miss workers it cannot inspect.
- Online mode takes a worker whose parent is a Java process for the running server's. Where a stopped server's workers are reparented to another Java process, such as a Java pid 1 in a container, online mode misses them; the offline row still reports them.

## Validation plan

- `ManagedAgentPreflightTest`, the `harness` row:
  - a fake `/capabilities` passes with a full envelope;
  - it fails on another digest without printing it, naming both variables without the credentials file;
  - it fails on a missing required feature with the version to install, or the manifest fallback without a version;
  - a dropped or failed second request reports the request, not an incompatible Harness, and keeps the response body out;
  - a base URL with credentials keeps them out of the report;
  - it warns on another version, on a missing or malformed version, and on a missing `workspace-shell-mcp/1`;
  - it fails on missing lifecycles, including a definition's MCP profile, and the fix keeps the profiles already offered;
  - the probe and the negotiation each send the configured token.
- `ManagedAgentPreflightTest`, the manifest: it is found from a classpath with several jars.
- `ManagedAgentPreflightTest`, the `workers` row, with real processes:
  - a worker in the state directory is reported; another directory's worker, a non-worker, an imitation without the entry, and a `tail` that names the marker are not;
  - the durable and non-durable fixes differ;
  - online, a durable Broker SKIPs, a worker with its parent passes, and an orphan is reported;
  - the preflight process never counts itself;
  - a symlinked state directory and a deleted then recreated one still match;
  - a missing directory SKIPs, and an unresolvable one WARNs.
- `ManagedAgentPreflightTest`, the port rows:
  - `listeningCheck` passes against a live socket and fails against a closed port or an unresolvable host;
  - `checks()` honours `--online=true`, fails another value, and checks the Broker port online;
  - offline, the busy port's fix names `--online`;
  - a port in `TIME_WAIT` passes while a live listener still fails.
- End to end against the packaged distribution and a real Harness:
  - the `harness` row passes;
  - it fails after the Harness digest changes;
  - `workers` warns about a worker left in the state directory;
  - `--online` passes while the server runs.

## Acceptance criteria

- An incompatible Harness fails `--check` with the reason, before any Session.
- Workers left alive by an earlier run appear in `--check`.
- `--check --online` reports no false failure against a running service.
- `--check` right after a stop reports no false port failure.

## Follow-up work

None for this change.
