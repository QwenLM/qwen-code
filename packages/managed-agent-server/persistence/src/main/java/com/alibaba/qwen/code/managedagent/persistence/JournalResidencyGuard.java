package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.springframework.jdbc.core.JdbcTemplate;

/** A locked reader checks SQL only; hydration belongs to its transaction-free entry point. */
public final class JournalResidencyGuard {
    private JournalResidencyGuard() { }

    public static void requireHot(JdbcTemplate jdbc, String tenant, String session) {
        var states = jdbc.queryForList("SELECT journal_residency FROM ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                String.class, tenant, session);
        if (!states.isEmpty() && !"HOT".equals(states.getFirst())) {
            throw rehydrating();
        }
    }

    public static <T> T read(JdbcTemplate jdbc,
            com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess access,
            String tenant, String session, java.util.function.Supplier<T> action) {
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
            ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, tenant, session);
            requireHot(jdbc, tenant, session);
            return action.get();
        }
        if (access != null) {
            return access.read(tenant, session, action);
        }
        requireHot(jdbc, tenant, session);
        return action.get();
    }

    public static void requireHot(java.sql.Connection connection, String tenant, String session) throws java.sql.SQLException {
        try (var query = connection.prepareStatement("SELECT journal_residency FROM ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'")) {
            query.setBytes(1, com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.identity(tenant));
            query.setBytes(2, com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.identity(session));
            try (var result = query.executeQuery()) {
                if (result.next() && !"HOT".equals(result.getString(1))) {
                    throw new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(503,
                            "managed_session_journal_rehydrating", "The Session journal is being restored. Retry the request.", true);
                }
            }
        }
    }

    static ManagedAgentException rehydrating() {
        return new ManagedAgentException(503, "managed_session_journal_rehydrating", "The Session journal is being restored. Retry the request.");
    }
}
