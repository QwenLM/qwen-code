package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
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
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw unavailable();
        }
        List<Boolean> grants = jdbc.query("SELECT s.tenant_id, s.session_id,"
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
        jdbc.update("UPDATE managed_workspace_execution_lease SET holder_key = NULL,"
                + " binding_id = NULL, runtime_generation = NULL, runtime_session_id = NULL"
                + " WHERE storage_key = ? AND holder_key = ?",
                storageKey(binding), holderKey(session));
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
