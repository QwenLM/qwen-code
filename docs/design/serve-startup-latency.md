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
- Preserve the health, authenticated runtime request, and fallback timer
  triggers for deferred startup.
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

## Benchmark method

Alternate launches of the baseline and candidate builds on the same host with
the same Node version, workspace fixtures, arguments, and probe intervals.
Warm each artifact's compile cache before collecting samples. Record time from
process launch to the listener, shallow health, deep health, and scoped stat
of the target workspace root. Start scoped stat after deep health succeeds.

## Acceptance

- Check `serve --help`, `serve --version`, unknown arguments, and graceful
  shutdown through the packaged and workspace entries.
- Verify shallow health can respond during bootstrap and that runtime startup
  can be triggered by health, an authenticated runtime request, or the fallback
  timer. Verify authentication and runtime startup failure responses.
- Compare the startup milestones using paired runs. Report the host, fixture
  and cache configuration, and the time distribution for each build.
