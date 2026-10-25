# Preflight: Harness Compatibility, Leftover Workers and Online Mode

[English](2026-10-23-managed-agent-preflight-harness-workers-online.md) | [简体中文](2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md)

Status: proposed and implemented in the same change.

## Problem

`bin/qwen-managed-agent-server --check` leaves three gaps an operator meets on a first install or an upgrade.

- **Harness compatibility.** The `harness` row only checks that `/capabilities` answers 200 with the configured token. A Harness with another capability digest, an older protocol, or without the lifecycle that Workspace files or Shell need passes. Its PASS even says "the digest is checked on the first Session". The control plane then refuses every Session, or every tool Session.
- **Leftover workers.** The control-plane unit uses `KillMode=process`, so `systemctl stop` leaves Runtime workers running. The guide asks the operator to reap them before the next start. Preflight is run exactly then, and says nothing.
- **A running service.** The port rows bind the configured addresses, so `--check` reports false failures while the service runs. Operators cannot run it on a live host at all.

## Goals

- The `harness` row applies the same negotiation the first Session applies, and the configuration's Workspace requirements.
- It reports a Harness that runs another Qwen Code version than the distribution's `manifest.json` names.
- Preflight reports Runtime workers that an earlier run left alive.
- `--check --online` runs against a live service without false failures.

## Non-goals

- Starting a Session or a Turn from preflight.
- Killing workers. Preflight only reports them.
- Checking the Harness's optional features, which the control plane turns off when absent.

## Design

### Harness compatibility

After the existing probe answers 200, the `harness` row builds a `HostedHarnessClient` with the configured base URL, token and digest, then closes it. Building the client negotiates as the first Session does: capabilities schema 1, the REST transport, the required features, Hosted Harness protocol 1, a well-formed boot ID, and an equal capability digest.

- A different digest fails as "advertises another capability digest". The fix names the digest setting. The values are not printed.
- Any other negotiation failure fails with the client's message, and the fix names the Qwen Code version to install.
- With Workspace files enabled, a Harness without lifecycle protocol 1 fails.
- With Workspace Shell enabled, a Harness whose `lifecycleV2Profiles` lacks `hosted-workspace-shell/1` fails, and the fix names `QWEN_HOSTED_LIFECYCLE_V2_PROFILES`.

A PASS reads "compatible: Hosted Harness protocol 1, capability digest matches, Qwen Code `<version>`".

The version comes from `qwenCodeVersion` in the capabilities response. The expected version comes from `compatibility.qwenCodeVersion` in `manifest.json`. Preflight finds the manifest from `java.class.path`: the launcher runs `java -jar lib/<jar>`, and the manifest sits beside `lib/`. A different version is a WARN, since negotiation already passed. A development classpath, or a missing manifest, skips the comparison.

### Leftover workers

A new `workers` row runs only when the local-process Runtime is enabled with a state directory, and only where `/proc` exists. Workers start with the state directory as their working directory, so preflight lists every process whose arguments include `managed-runtime-worker` and whose `/proc/<pid>/cwd` is that directory. Other deployments' workers on the same host are not matched.

- `PASS` when none is alive.
- `WARN` with the count and pids, and the fix `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server` or killing those pids.
- `SKIP` without a local-process Runtime, without `/proc`, or before the state directory exists.

It is a WARN rather than a FAIL because a durable Broker can adopt its workers. The guide still asks for a clean start before an upgrade.

### Online mode

`--online` marks a run against a live service:

- The `server-port` and `broker-port` rows connect to the configured address, with a wildcard address mapped to `127.0.0.1`, instead of binding it. They pass when something listens, and fail otherwise.
- The `workers` row is skipped, since the running server owns its workers.

Every other row runs as before.

## Failure semantics

- A digest mismatch, a negotiation failure, or a missing lifecycle: the `harness` row fails, so `--check` exits 1.
- Another Qwen Code version than the manifest's: the `harness` row warns.
- Live workers in the state directory while offline: the `workers` row warns.
- `--online` with nothing listening on a port: that port row fails.

## Compatibility and risks

- A `harness` row that passed before can now fail. The mismatch it reports would have failed every Session, so this moves the failure earlier.
- The negotiation sends a second request to `/capabilities` and starts the client's thread pools for its duration.
- Process arguments and `/proc/<pid>/cwd` are readable for the operator's own processes and for root. Run as another account, preflight may miss workers it cannot inspect.

## Validation plan

- `ManagedAgentPreflightTest`:
  - a fake `/capabilities` passes with a full envelope;
  - it fails on another digest without printing it, and on a missing required feature with the version to install;
  - it warns on another Qwen Code version;
  - it fails on missing Workspace lifecycles, and passes once the Shell profile is advertised;
  - the manifest is read beside `lib/` and ignored for a development classpath;
  - real processes: one worker in the state directory, one in another directory, and a non-worker in the state directory, so only the first is reported;
  - `listeningCheck` passes against a live socket and fails against a closed port;
  - `checks(--online)` skips `workers`.
- End to end against the packaged distribution and a real Harness:
  - the `harness` row passes;
  - it fails after the Harness digest changes;
  - `workers` warns about a worker left in the state directory;
  - `--online` passes while the server runs.

## Acceptance criteria

- An incompatible Harness fails `--check` with the reason, before any Session.
- Workers left alive by an earlier run appear in `--check`.
- `--check --online` reports no false failure against a running service.

## Follow-up work

None planned within the deployment-ease series.
