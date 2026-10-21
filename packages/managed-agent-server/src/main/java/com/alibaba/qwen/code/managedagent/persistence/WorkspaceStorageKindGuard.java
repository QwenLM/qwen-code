package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

final class WorkspaceStorageKindGuard {
    private WorkspaceStorageKindGuard() {
    }

    static void requireFreshTransaction() {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    static void lockDomain(JdbcTemplate jdbc, String tenantId) {
        jdbc.execute((ConnectionCallback<Void>) connection -> {
            JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenantId);
            return null;
        });
    }

    static void requireLocalAlias(JdbcTemplate jdbc, String tenantId, String storageId) {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE alias_key = ? AND storage_kind IN ('CSI', 'SSH_LOCAL')",
                Long.class, WorkspaceCsiRegistration.aliasKey(tenantId, storageId)) != 0) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    static void requireExecutionAlias(JdbcTemplate jdbc, String tenantId, String storageId) {
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE alias_key = ? AND storage_kind = 'CSI'",
                Long.class, WorkspaceCsiRegistration.aliasKey(tenantId, storageId)) != 0) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }
}
