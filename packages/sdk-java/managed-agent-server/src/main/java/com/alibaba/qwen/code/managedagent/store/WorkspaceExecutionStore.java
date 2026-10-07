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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Repository
public class WorkspaceExecutionStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard storageGuard;

    @Autowired
    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, WorkspaceStorageGuard storageGuard) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        this.storageGuard = storageGuard;
    }

    public WorkspaceExecutionStore(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        // Offline saved-owner cleanup must not require the current mount.
        this.storageGuard = null;
    }

    public boolean verifiedRecoveryEnabled() {
        return storageGuard != null && storageGuard.enabled();
    }

    public void authorize(SessionRecord session) {
        authorizePassiveAttachment(session);
        if (storageGuard != null) {
            storageGuard.verify(session.workspace());
        }
    }

    // The mount guard of an execution authority, without the Session-level
    // checks; the W2 settlement probe must not fail a Session it only
    // reads. It uses the guard's probe-only entry: momentary I/O failures
    // classify retryable-with-cause, structural refusals keep the terminal
    // verdict, and the shared acquire path (claim/assertHeld) is untouched.
    public void verifyMountForProbe(ContextBinding binding) {
        if (storageGuard != null) {
            storageGuard.verifyProbe(binding);
        }
    }

    public void authorizePassiveAttachment(SessionRecord session) {
        ContextBinding binding = session.workspace();
        if (binding == null || !"ACTIVE".equals(session.status())
                || session.deletedAt() != null || !"qwen-code".equals(session.agentId())
                || !session.tenantId().equals(binding.getTenantId())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw unavailable();
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
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
        WorkspaceStorageKindGuard.requireFreshTransaction();
        String key = storageKey(binding);
        String holder = holderKey(session);
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
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
                    + " (storage_key, storage_kind) VALUES (?, 'LOCAL') ON DUPLICATE KEY UPDATE"
                    + " storage_key = storage_key", key);
            String current = jdbc.queryForObject("SELECT holder_key FROM"
                    + " managed_workspace_execution_lease WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE",
                    String.class, key);
            if (storageGuard != null) {
                storageGuard.verifyLocked(binding);
            }
            if (current != null && !holder.equals(current)) {
                throw busy();
            }
            jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = ?,"
                    + " binding_id = ?, runtime_generation = ?, runtime_session_id = ?"
                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL'", holder, session.getBindingId(),
                    session.getRuntimeGeneration(), session.getRuntimeSessionId(), key);
        });
    }

    public void assertHeld(ContextBinding binding, RuntimeSessionRecord session) {
        if (storageGuard != null) {
            storageGuard.verify(binding);
        }
        if (!isHeld(binding, session)) {
            throw busy();
        }
    }

    public boolean isHeld(ContextBinding binding, RuntimeSessionRecord session) {
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
        List<String> holders = jdbc.queryForList("SELECT holder_key FROM"
                + " managed_workspace_execution_lease WHERE storage_key = ? AND storage_kind = 'LOCAL'",
                String.class, storageKey(binding));
        return holders.size() == 1 && holderKey(session).equals(holders.getFirst());
    }

    public void release(ContextBinding binding, RuntimeSessionRecord session) {
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getTenantId(), binding.getStorageId());
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
                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL' AND holder_key = ?",
                    storageKey(binding), holderKey(session));
        });
    }

    public boolean hasHolder(RuntimeBindingRecord saved) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease"
                + " WHERE binding_id = ? AND runtime_generation = ? AND holder_key IS NOT NULL",
                Integer.class, saved.getBindingId(), saved.getGeneration());
        return count != null && count > 0;
    }

    public void releaseLost(RuntimeBindingRecord saved) {
        if (!saved.getRequest().isManagedContext() || saved.getState() != RuntimeBindingRecord.State.LOST
                || !saved.hasStoppedWriters() || saved.getOperationOwner() == null) {
            throw unavailable();
        }
        transaction.executeWithoutResult(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, saved.getRequest().getScope().getTenantId());
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
                    + " FROM managed_workspace_execution_lease WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE", row -> {
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
                                    + " WHERE storage_key = ? AND storage_kind = 'LOCAL' AND holder_key = ? AND binding_id = ?"
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

    // A probe's momentary I/O failure is not the structural verdict the
    // terminal refusal promises: it retries through the delivery machine,
    // keeping the cause for the log. Structural refusals keep
    // unavailable().
    public static RuntimeBrokerException unavailableTransient(
            Throwable cause) {
        return new RuntimeBrokerException(409, "workspace_unavailable",
                "Workspace mount cannot be verified right now.", true,
                cause);
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
