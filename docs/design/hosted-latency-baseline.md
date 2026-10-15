# Hosted latency baseline

[English](hosted-latency-baseline.md) | [简体中文](hosted-latency-baseline.zh-CN.md)

## Problem and scope

Issue #12941 requests measured evidence for the Stage A acceptance criterion:
delay Runtime provisioning by 15 seconds, start model output before readiness,
finish a no-tool Turn during provisioning, and continue a tool Turn in the same
model context after readiness. Existing Hosted fault tests exercise the real
Broker and SQL store but do not record these timings.

This change adds test infrastructure only. Reuse the packaged Hosted Harness,
Spring Session Store, Embedded Runtime Broker and Workspace worker. The driver
uses the private Harness protocol, since the public Managed REST entry currently
refuses Workspace Sessions. It boots with isolated fixture model configuration;
it does not benchmark deployment of a published configuration or the public API.

## Measurement design

Run two fresh Workspace Sessions, `no-tool` and `tool`, with a deterministic
local OpenAI fixture. A test-only worker entry waits for
`runtimeProvisioningDelayMs = 15000` before importing the packaged CLI. The real
Broker provisions and attests that worker. A proxy records readiness only after
its successful warm response, before
forwarding it to the Harness. Reject acquisition or execution before readiness.

All elapsed values use one Node monotonic clock, starting immediately before
prompt submission. Observe first model text as a nonempty `delta.content` in the
provider SSE stream at the proxy, excluding headers, role and reasoning chunks.
Separately observe first visible text and completion from the Harness SSE stream
after SQL commit. Tool-call text currently becomes a journal record, not a
visible message chunk; visible tool-Turn text may therefore follow readiness.

Record the tool-request finish, readiness wait (tool-request finish to warm
response), acquisition, execution start, resumed model request and completion
separately. The resumed request must retain the original messages, assistant
tool-call ID and matching successful tool result. Assert one prompt, exactly two
model requests for the tool Turn, and one physical Workspace write. Model stream
duration is recorded separately and is not computed as total minus Runtime wait.
Count store HTTP requests during each Turn to make persistence overhead visible;
history growth and cache selection remain separate work.

## Baseline and CI

Check in an actual local capture with base Git commit, dirty-tree status, fixture
source hashes, capture time, platform, Node and database versions, measurement
definitions and scope notes. Each run reads that artifact and compares the exact
scenario set, measurement version, delay and ordering invariants. Missing,
duplicate or invalid measurements fail. Absolute millisecond differences are
reported, never used as shared-runner performance thresholds.

The fixed local provider makes this an unconditional ordering gate; its timings
are infrastructure measurements, not real-model latency. No credential-dependent
probe is introduced, and the ordinary daemon baseline remains unchanged. Any
future real-provider probe must reuse `shouldSkipPromptLatency()`.

Reuse the existing `HostedWorkspaceToolTurnIT` fixture and Maven profiles. Save
the run report in `target/hosted-latency-baseline.json`; the Hosted MySQL CI job
uploads it and fails if it is absent. Include Hosted helpers and baselines in the
workflow path filters so driver-only changes run the gate.

## Affected files and validation

- New latency driver, measurement validator and focused validator tests under
  `integration-tests/`, plus the checked-in baseline.
- Extend `HostedWorkspaceToolTurnIT` to invoke the driver and check SQL outcomes.
- Update `.github/workflows/sdk-java.yml` to trigger and retain the measurements.

Build, typecheck and bundle the repository. Run focused validator tests, the
existing Workspace tool test, and the new latency test against Spring with SQL.
Run the same test in the existing MySQL CI profile. Negative validator cases
must reject missing scenarios, reversed ordering, absent or nonfinite timestamps
and invalid continuation evidence. Inspect the recorded artifact against the
raw run before checking it in.

## Acceptance criteria and open questions

Both scenarios produce model text before Runtime readiness. No-tool completion
precedes readiness with no tool acquisition. The tool request precedes readiness,
waits for it, performs one write and resumes with the same model context before
successful completion. The report contains actual measurements and the test
consumes the checked-in baseline. No unresolved design questions remain within
this fixture scope; real-provider and public-entry latency are separate probes.

## Reproduce and refresh

Use Node 22+, Java 21 and Maven, with the Java SDK and Runtime Broker installed
locally as described in the existing Hosted fixture. From the repository root:

```bash
npm run build && npm run bundle
mvn -f packages/sdk-java/managed-agent-server/pom.xml -Phosted-workspace-tools \
  '-Dit.test=HostedWorkspaceToolTurnIT#recordsLatencyWithDelayedRuntimeProvisioning' \
  -Dnode.executable="$(command -v node)" verify checkstyle:check
```

By default this uses H2 and compares against
[`hosted-latency.json`](../../integration-tests/baselines/hosted-latency.json).
Pass `-Dmysql.url`, `-Dmysql.user` and `-Dmysql.password` to measure a dedicated
MySQL-compatible database instead; its actual version is included in the report.
Set `QWEN_HOSTED_UPDATE_BASELINE=1` on the same command only when intentionally
refreshing the checked-in capture. Then run again without that variable to
exercise comparison, inspect the report and Git diff, and commit the artifact
together with the fixture changes. Different database engines and machines are
identified in the artifact; their absolute timing deltas are descriptive only.
