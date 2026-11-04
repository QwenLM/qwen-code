package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;

final class WorkspaceExecutionDrain {
    private WorkspaceExecutionDrain() {
    }

    static boolean canStopDrained(JdbcTemplate jdbc, RuntimeBindingRecord saved) {
        if ((saved.getState() != RuntimeBindingRecord.State.DRAINING && saved.getState() != RuntimeBindingRecord.State.LOST)
                || !saved.isDrainRequested() || !saved.getRequest().isManagedContext() || saved.getOperationOwner() == null
                || !java.util.Set.of(com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.LOCAL_PROCESS, com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.SSH_PROCESS, com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_FILES, com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE_TOOLS).contains(saved.getRequest().getProvisionerKind())
                || !(WorkspaceExecutionProfile.admitsIsolationClass(saved.getRequest().getScope().getIsolationClass())
                        || HarnessOwnership.sharesRuntimeSessions(saved.getRequest()))) {
            return false;
        }
        var claims = jdbc.query("SELECT binding_state, is_drain_requested, operation_owner, operation_generation,"
                + " operation_lease_until, tenant_id, storage_id, UNIX_TIMESTAMP() AS db_seconds,"
                + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) AS db_micros FROM ma_runtime_binding"
                + " WHERE binding_id = ? AND runtime_generation = ?", (row, index) ->
                        saved.getState().name().equals(row.getString("binding_state")) && row.getBoolean("is_drain_requested")
                        && saved.getOperationOwner().equals(row.getString("operation_owner"))
                        && saved.getOperationGeneration() == row.getLong("operation_generation")
                        && ManagedSchemaTime.timestamp(row, "operation_lease_until") != null
                        && ManagedSchemaTime.timestamp(row, "operation_lease_until").toInstant().isAfter(java.time.Instant.ofEpochMilli(
                                        row.getLong("db_seconds") * 1000 + row.getLong("db_micros") / 1000))
                        && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                        && saved.getRequest().getStorageId().equals(row.getString("storage_id")),
                saved.getBindingId(), saved.getGeneration());
        if (claims.size() != 1 || !claims.getFirst()
                || jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution WHERE binding_id = ?"
                        + " AND runtime_generation = ? AND execution_state NOT IN ('SETTLED', 'ABANDONED')",
                        Long.class, saved.getBindingId(), saved.getGeneration()) != 0) {
            return false;
        }
        String physical = WorkspaceExecutionStore.storageKey(jdbc, saved.getRequest().getScope().getTenantId(), saved.getRequest().getStorageId());
        var members = jdbc.query("SELECT execution_storage_key, harness_session_id, tenant_id FROM ma_runtime_session"
                + " WHERE binding_id = ? AND runtime_generation = ? AND execution_storage_key IS NOT NULL", (row, index) ->
                        physical.equals(row.getString("execution_storage_key"))
                                && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                                && (HarnessOwnership.sharesRuntimeSessions(saved.getRequest())
                                        || saved.getRequest().getIsolationKey().equals(row.getString("harness_session_id"))),
                saved.getBindingId(), saved.getGeneration());
        if (members.contains(false)) {
            return false;
        }
        var external = ExternalStorageRegistrationStore.executionStorage(jdbc,
                saved.getRequest().getScope().getTenantId(), saved.getRequest().getStorageId(), true);
        if (external != null) {
            return jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE storage_key = ?"
                    + " AND storage_kind = 'EXTERNAL' AND holder_key IS NULL AND maintenance_id IS NULL",
                    Long.class, physical) == 1;
        }
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE storage_key = ?"
                + " AND storage_kind IN ('LOCAL', 'SSH_LOCAL') AND (holder_key IS NOT NULL OR maintenance_id IS NOT NULL)",
                Long.class, physical) == 0;
    }
}
