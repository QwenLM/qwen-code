package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Repository
public class WorkspaceExecutionStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;

    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    public void authorize(SessionRecord session) {
        ContextBinding binding = session.workspace();
        if (binding == null || !"ACTIVE".equals(session.status())
                || session.deletedAt() != null || !"qwen-code".equals(session.agentId())
                || !session.tenantId().equals(binding.getTenantId())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw unavailable();
        }
        List<Boolean> grants = jdbc.query("SELECT s.tenant_id, s.session_id,"
                + " s.agent_id AS session_agent, s.status AS session_status,"
                + " s.deleted_at AS session_deleted_at,"
                + " s.workspace_id AS session_workspace,"
                + " s.workspace_generation AS session_generation,"
                + " s.workspace_storage_id AS session_storage,"
                + " s.cwd_relative AS session_cwd,"
                + " s.context_config_ref AS session_context,"
                + " s.context_revision AS session_revision,"
                + " s.workspace_config_ref, s.workspace_policy_ref,"
                + " r.tenant_id AS registry_tenant, r.workspace_id,"
                + " r.workspace_generation, r.storage_id, r.state,"
                + " c.tenant_id AS command_tenant, c.session_id AS command_session,"
                + " a.tenant_id AS access_tenant, a.workspace_id AS access_workspace,"
                + " a.can_read, a.can_create FROM managed_agent_session s"
                + " JOIN managed_workspace_registry r ON r.tenant_id = s.tenant_id"
                + " AND r.workspace_id = s.workspace_id"
                + " JOIN managed_workspace_create_command c ON c.tenant_id = s.tenant_id"
                + " AND c.session_id = s.session_id"
                + " JOIN managed_workspace_access a ON a.tenant_id = r.tenant_id"
                + " AND a.workspace_id = r.workspace_id AND a.actor_id = c.actor_id"
                + " WHERE s.tenant_id = ? AND s.session_id = ?",
                (row, index) -> session.tenantId().equals(row.getString("tenant_id"))
                        && session.sessionId().equals(row.getString("session_id"))
                        && "qwen-code".equals(row.getString("session_agent"))
                        && "ACTIVE".equals(row.getString("session_status"))
                        && row.getObject("session_deleted_at") == null
                        && binding.getWorkspaceId().equals(row.getString("session_workspace"))
                        && binding.getWorkspaceGeneration() == row.getLong("session_generation")
                        && binding.getStorageId().equals(row.getString("session_storage"))
                        && binding.getCwdRelative().equals(row.getString("session_cwd"))
                        && binding.getContextConfigRef().equals(row.getString("session_context"))
                        && binding.getContextRevision() == row.getLong("session_revision")
                        && session.tenantId().equals(row.getString("registry_tenant"))
                        && session.tenantId().equals(row.getString("command_tenant"))
                        && session.sessionId().equals(row.getString("command_session"))
                        && session.tenantId().equals(row.getString("access_tenant"))
                        && binding.getWorkspaceId().equals(row.getString("workspace_id"))
                        && binding.getWorkspaceId().equals(row.getString("access_workspace"))
                        && binding.getWorkspaceGeneration() == row.getLong("workspace_generation")
                        && binding.getStorageId().equals(row.getString("storage_id"))
                        && "ACTIVE".equals(row.getString("state"))
                        && row.getBoolean("can_read") && row.getBoolean("can_create")
                        && WorkspaceExecutionProfile.CONFIG_REF.equals(
                                row.getString("workspace_config_ref"))
                        && WorkspaceExecutionProfile.POLICY_REF.equals(
                                row.getString("workspace_policy_ref")),
                session.tenantId(), session.sessionId());
        if (grants.size() != 1 || !grants.getFirst()) {
            throw unavailable();
        }
    }

    public void claim(ContextBinding binding, RuntimeSessionRecord session) {
        String key = storageKey(binding);
        String holder = holderKey(session);
        transaction.executeWithoutResult(status -> {
            List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state, drain_requested,"
                    + " tenant_id, workspace_id, workspace_generation, storage_id FROM qwen_runtime_binding"
                    + " WHERE binding_id = ? FOR UPDATE", (row, index) ->
                            session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && "READY".equals(row.getString("binding_state")) && !row.getBoolean("drain_requested")
                            && binding.getTenantId().equals(row.getString("tenant_id"))
                            && binding.getWorkspaceId().equals(row.getString("workspace_id"))
                            && Long.toString(binding.getWorkspaceGeneration()).equals(row.getString("workspace_generation"))
                            && binding.getStorageId().equals(row.getString("storage_id")), session.getBindingId());
            if (live.size() != 1 || !live.getFirst()) {
                throw unavailable();
            }
            List<Boolean> active = jdbc.query("SELECT binding_id, runtime_generation, runtime_session_id,"
                    + " harness_session_id, session_state FROM qwen_runtime_session"
                    + " WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_id = ? FOR UPDATE",
                    (row, index) -> session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && session.getRuntimeSessionId().equals(row.getString("runtime_session_id"))
                            && session.getSession().getHarnessSessionId().equals(row.getString("harness_session_id"))
                            && ("ACQUIRING".equals(row.getString("session_state"))
                                    || "READY".equals(row.getString("session_state"))),
                    session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId());
            if (active.size() != 1 || !active.getFirst()) {
                throw unavailable();
            }
            jdbc.update("INSERT INTO managed_workspace_execution_lease"
                    + " (storage_key) VALUES (?) ON DUPLICATE KEY UPDATE"
                    + " storage_key = storage_key", key);
            String current = jdbc.queryForObject("SELECT holder_key FROM"
                    + " managed_workspace_execution_lease WHERE storage_key = ? FOR UPDATE",
                    String.class, key);
            if (current != null && !holder.equals(current)) {
                throw busy();
            }
            jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = ?,"
                    + " binding_id = ?, runtime_generation = ?, runtime_session_id = ?"
                    + " WHERE storage_key = ?", holder, session.getBindingId(),
                    session.getRuntimeGeneration(), session.getRuntimeSessionId(), key);
        });
    }

    public void assertHeld(ContextBinding binding, RuntimeSessionRecord session) {
        List<String> holders = jdbc.queryForList("SELECT holder_key FROM"
                + " managed_workspace_execution_lease WHERE storage_key = ?",
                String.class, storageKey(binding));
        if (holders.size() != 1 || !holderKey(session).equals(holders.getFirst())) {
            throw busy();
        }
    }

    public void release(ContextBinding binding, RuntimeSessionRecord session) {
        transaction.executeWithoutResult(status -> {
            List<Boolean> live = jdbc.query("SELECT binding_id, runtime_generation, binding_state"
                    + " FROM qwen_runtime_binding WHERE binding_id = ? FOR UPDATE",
                    (row, index) -> session.getBindingId().equals(row.getString("binding_id"))
                            && session.getRuntimeGeneration() == row.getLong("runtime_generation")
                            && ("READY".equals(row.getString("binding_state"))
                                    || "DRAINING".equals(row.getString("binding_state"))),
                    session.getBindingId());
            if (live.size() != 1 || !live.getFirst()) {
                throw unavailable();
            }
            jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL,"
                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL"
                    + " WHERE storage_key = ? AND holder_key = ?",
                    storageKey(binding), holderKey(session));
        });
    }

    public void releaseLost(RuntimeBindingRecord saved) {
        if (!saved.getRequest().isManagedContext() || saved.getState() != RuntimeBindingRecord.State.LOST
                || !saved.hasStoppedWriters() || saved.getOperationOwner() == null) {
            throw unavailable();
        }
        transaction.executeWithoutResult(status -> {
            List<Boolean> exact = jdbc.query("SELECT binding_id, runtime_generation, binding_state, tenant_id,"
                    + " workspace_id, storage_id, record_version, operation_owner, operation_generation,"
                    + " operation_lease_until, loss_evidence_json, stop_evidence_json, UNIX_TIMESTAMP() AS db_seconds,"
                    + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) AS db_micros"
                    + " FROM qwen_runtime_binding WHERE binding_id = ? FOR UPDATE", (row, index) ->
                            saved.getBindingId().equals(row.getString("binding_id"))
                            && saved.getGeneration() == row.getLong("runtime_generation")
                            && "LOST".equals(row.getString("binding_state"))
                            && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                            && saved.getRequest().getScope().getWorkspaceId().equals(row.getString("workspace_id"))
                            && saved.getRequest().getStorageId().equals(row.getString("storage_id"))
                            && saved.getVersion() == row.getLong("record_version")
                            && saved.getOperationOwner().equals(row.getString("operation_owner"))
                            && saved.getOperationGeneration() == row.getLong("operation_generation")
                            && row.getTimestamp("operation_lease_until") != null
                            && row.getTimestamp("operation_lease_until", java.util.Calendar.getInstance(
                                    java.util.TimeZone.getTimeZone("UTC"))).toInstant().isAfter(java.time.Instant.ofEpochSecond(
                                            row.getLong("db_seconds"), row.getLong("db_micros") * 1000))
                            && row.getString("loss_evidence_json") != null && row.getString("stop_evidence_json") != null,
                    saved.getBindingId());
            if (exact.size() != 1 || !exact.getFirst()
                    || jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution WHERE binding_id = ?"
                            + " AND runtime_generation = ? AND execution_state NOT IN ('SETTLED', 'ABANDONED')",
                            Long.class, saved.getBindingId(), saved.getGeneration()) != 0) {
                throw unavailable();
            }
            String key = digest(saved.getRequest().getScope().getTenantId() + "\u0000" + saved.getRequest().getStorageId());
            jdbc.query("SELECT holder_key, binding_id, runtime_generation, runtime_session_id"
                    + " FROM managed_workspace_execution_lease WHERE storage_key = ? FOR UPDATE", row -> {
                        String holder = row.getString("holder_key");
                        String bindingId = row.getString("binding_id");
                        String sessionId = row.getString("runtime_session_id");
                        long generation = row.getLong("runtime_generation");
                        if (holder == null) {
                            if (bindingId != null || sessionId != null || row.getObject("runtime_generation") != null) {
                                throw unavailable();
                            }
                        } else if (bindingId == null || sessionId == null || generation <= 0
                                || !holder.equals(digest(bindingId + "\u0000" + generation + "\u0000" + sessionId))) {
                            throw unavailable();
                        } else if (saved.getBindingId().equals(bindingId) && saved.getGeneration() == generation) {
                            java.time.Instant now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(),"
                                    + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))", (clock, index) ->
                                            java.time.Instant.ofEpochSecond(clock.getLong(1), clock.getLong(2) * 1000));
                            if (now == null || !saved.getOperationLeaseUntil().isAfter(now)) {
                                throw unavailable();
                            }
                            int changed = jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL,"
                                    + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL"
                                    + " WHERE storage_key = ? AND holder_key = ? AND binding_id = ?"
                                    + " AND runtime_generation = ? AND runtime_session_id = ?",
                                    key, holder, bindingId, generation, sessionId);
                            if (changed != 1) {
                                throw unavailable();
                            }
                        }
                    }, key);
        });
    }

    public static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace execution authority is unavailable.", false);
    }

    private static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_busy",
                "Workspace storage is held by another tool turn.", true);
    }

    private static String storageKey(ContextBinding binding) {
        return digest(binding.getTenantId() + "\u0000" + binding.getStorageId());
    }

    private static String holderKey(RuntimeSessionRecord session) {
        return digest(session.getBindingId() + "\u0000" + session.getRuntimeGeneration()
                + "\u0000" + session.getRuntimeSessionId());
    }

    private static String digest(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
