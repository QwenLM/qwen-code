# E2E: managed automation gate

Design: `docs/design/2026-10-22-managed-automation-gate.md`. The automated
coverage is `HostedAutomationFaultGatesIT.fg11gGateProbesDecideEveryFireOnMySql`
(real MySQL, a real Harness and Runtime worker, five cells selectable with
`-Dqwen.fg11g.case=<case>`); this plan is the manual run of the same shape on
a deployment.

## Baseline

A `qwen serve --profile hosted-harness` behind a managed-agent server with
`qwen.managed-agent.automation.enabled=true`, the Runtime Broker on, and a
Workspace whose Session uses a Shell profile (`hosted-workspace-shell/1`).
Before this change `POST /v1/agent-automations` ignores a `gate` field (the
request model does not know it, and unknown request fields are dropped), so
the definition is created ungated and every slot of an every-minute
definition produces a model turn.

## Manual check

1. Put a probe in the Workspace directory the Session is bound to:

   ```sh
   cat > probe.sh <<'EOF'
   #!/bin/sh
   echo run >> probe.log
   if [ "$(wc -l < probe.log)" -eq 3 ]; then echo "event: comment"; fi
   EOF
   ```

2. Create a gated definition on the Session:

   ```json
   {"session_id":"<id>","goal":"watch","cron":"* * * * *","timezone":"UTC",
    "prompt":"Handle the events in the gate output.","gate":"sh ./probe.sh"}
   ```

   The answer carries `gate` and no `gate_status`.

3. Wait three minute boundaries. `GET /v1/agent-automations/<id>/runs` lists
   two `skipped` occurrences with reason `gate_quiet` and then one `fired`;
   `probe.log` holds three lines; the Session has exactly one new turn whose
   prompt ends with a `<gate-output>` block holding `event: comment`.
   `GET /v1/agent-automations/<id>` shows `gate_status.last_outcome:
   delivered` and `quiet_since_delivery: 0`.

4. Replace the probe body with `exit 1`. The next occurrence is
   `skipped/gate_failed`, `gate_status.consecutive_failures` grows and
   `last_error` reads `exited with code 1`; no turn runs.

5. `POST /v1/agent-automations/<id>` with `{"gate":null}` clears the gate
   (`definition_revision` advances, `gate` absent) and the next slot fires a
   plain turn.

6. On a Session whose profile has no Shell, the same create answers
   `409 automation_gate_unsupported`.

## Automated coverage

- `packages/core`: `managed-automation-record.test.ts`,
  `managed-automation-operations.test.ts`, `cron-gate.test.ts`.
- `packages/cli`: `hosted-automation-session.test.ts` (gate funnel),
  `hosted-automation-gate.test.ts` (runner against a scripted Broker:
  receipt first, acquire only without one),
  `hosted-workspace-broker.test.ts` (`prepareReplayable`),
  `managed-automation-gate-tool.test.ts` (worker tool, real shell).
- `packages/managed-agent-server`: `ManagedAutomationRecordContractTest`,
  `AutomationScannerTest` (gate outcomes, status, manual run),
  `ManagedAgentApiContractTest` (public shapes), `HostedAutomationFaultGatesIT`
  FG11g cells.
