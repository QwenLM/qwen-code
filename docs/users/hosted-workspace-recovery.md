# Hosted Workspace operator recovery

[English](hosted-workspace-recovery.md) | [简体中文](hosted-workspace-recovery.zh-CN.md)

Use this procedure only for a Linux durable local-process worker on the same host boot whose incomplete Hosted Shell capture has retained a Workspace lease. Recovery makes the physical Workspace available to new Sessions. It does not finish, retry, or certify the original Shell call.

The maintenance command is shipped as `qwen-managed-agent-server-*-operator-recovery.jar`. Run it on the original worker host with the service's database settings, Runtime credential key, and `QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`. Set `QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=true`, `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=local-process`, and `QWEN_MANAGED_AGENT_RUNTIME_OPERATOR_RECOVERY_ENABLED=true` for this maintenance process. Keep the database and credential environment private. Apply the service database migration before running the command. The command does not start an HTTP listener, scheduler, or worker.

1. Run `java -jar qwen-managed-agent-server-*-operator-recovery.jar inspect <bindingId> <generation>`. Record the returned `holderKey`, Runtime Session, Shell call, `captureStatus`, and `captureReason`. Recovery requires a saved `producer_lost` Shell result and an exact, still-held Workspace lease. An unsupported legacy worker, missing registration identity, or missing holder cannot be repaired by creating replacement identity records.
2. Run `java -jar qwen-managed-agent-server-*-operator-recovery.jar prepare <bindingId> <generation> <holderKey> '<incident reason>'`. Save the returned `recoveryId`. A live or recovery-blocked binding is fenced as `OPERATOR_RECOVERY`; an already LOST binding remains LOST and is excluded from the background recovery scan. No Workspace lease is released. Repeating the same operator and reason is safe. A different operator, reason, generation, or holder is rejected.
3. Stop the original worker and inspect **all** possible writers to the Workspace, including detached children and external supervisors. Prevent the original worker and writers from being restarted. Confirm that they have stopped. Process-group death, pipe EOF, elapsed time, and loss of the parent PID alone are insufficient. If this cannot be established, stop here and leave the Workspace fenced.
4. Create a regular, non-symlink JSON file directly inside the private Runtime state directory, mode `0600`, with exactly these fields (replace the example values):

   ```json
   {
     "version": 1,
     "recoveryId": "<recoveryId>",
     "verifiedAt": "2026-09-29T03:00:00Z",
     "method": "host inspection",
     "actions": "Stopped worker and detached writers; disabled their external restart source; verified no writer remains",
     "restartPrevention": true
   }
   ```

   `verifiedAt` must be an actual UTC verification time. Record concrete steps and the source of restart prevention; never write the statement before completing those checks. Keep the file and the incident record private.

5. Run `java -jar qwen-managed-agent-server-*-operator-recovery.jar complete <recoveryId> <absoluteEvidenceFile>`. The command checks the exact saved worker identity and its absence, tombstones its registration, persists the immutable statement, and reclaims only the original holder. It may be retried with the **same file** after a crash or a temporary database failure. A changed statement is rejected. Successful output is `completed`.

After completion, start a **new** Session and verify it can use the Workspace. Inspect the original turn separately: its partial output and uncertain effects remain uncertain, and no Shell call is replayed. Do not clear SQL tables or registration files manually to bypass a refusal. If the original registration is absent or corrupt, or the worker is from an older ephemeral mode, this procedure is unsupported; escalate with the preserved evidence rather than fabricating it.

The software can check the registered worker identity and exact SQL holder, but it cannot prove that arbitrary escaped descendants have stopped. The operator's statement is the trust boundary for that fact.
