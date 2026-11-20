# Reduce `qwen serve` startup latency

[English](serve-startup-latency.md) | [简体中文](serve-startup-latency.zh-CN.md)

## Current behavior

The packaged CLI loads the general command entry before dispatching `serve`.
The fast path listens before loading the runtime, then waits for an authenticated
health response plus 50 ms, an authenticated runtime request, or a 1,000 ms
fallback. Managed launchers poll for socket and workspace readiness separately.
The TCP listener, application routes, and a ready workspace are distinct startup
milestones.

## Design

- Dispatch a leading `serve` through the existing lightweight parser in both
  the workspace CLI and packaged bundle. Keep the general CLI as the fallback
  for help, version, unsupported arguments, and managed update dispatch. Share
  the entry lifecycle so both paths retain error handling and environment setup.
- Add `--eager-runtime` and support `QWEN_SERVE_EAGER_RUNTIME=1` for managed
  launchers that also spawn older builds. Start the same single-flight runtime
  initializer from the listen callback in eager mode. Keep the existing
  authenticated cold-request and health behavior, including startup failures
  and shutdown, with the current timing as the default.
- Prewarm Node's existing compile cache during the managed image build. Start
  the installed daemon with an isolated home and workspace and stop it after
  deep health confirms the runtime has loaded. The managed launcher passes
  the same `NODE_COMPILE_CACHE` directory to Node at launch. Reuse depends on
  the Node version and installed module paths. A cold cache or unavailable
  storage still permits ordinary startup.
- Load webhook configuration when a webhook first needs authentication. Keep
  webhook authentication ahead of any request-triggered runtime start.
- Release queued `GET` and `HEAD` requests to `/brand`, `/workspace/voice`,
  and `/workspaces/:workspace/stat` through the mounted app after required
  channel startup, before Live Host discovery completes. Keep their existing
  authorization and workspace resolution. `/capabilities` continues to use
  the bootstrap response for supported single-workspace launches and the full
  runtime snapshot where required.
- Load the remaining sub-session and related route handlers in parallel with
  telemetry initialization. Register daemon metrics after the SDK has set up
  its provider. ACP preheat stays asynchronous.

## Managed launcher

The companion change in opencode `release/FY27B22` starts the daemon in eager
mode when supported, configures a launcher-owned compile cache and reduces the
initial polling interval. HTTP health and the target workspace's scoped status
remain the readiness checks. The launcher retains the old-version fallback.

## Acceptance

- Check `serve --help`, `serve --version`, unknown arguments, and graceful
  shutdown through the packaged and workspace entries.
- Verify an eager daemon starts runtime initialization with zero HTTP requests,
  and an authenticated request during boot reaches its normal route. Verify
  default startup, authentication, and startup failure responses separately.
- Measure process to listening, first healthy response, and first successful
  scoped status against the same build setup. Report cool and warmed compile
  caches separately. Repeat on the deployment's Linux 2 CU environment before
  attributing the observed production estimates to this change.
