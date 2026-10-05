package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
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
        if (jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_registration WHERE alias_key = ?",
                Long.class, WorkspaceCsiRegistration.aliasKey(tenantId, storageId)) != 0) {
            throw WorkspaceExecutionStore.unavailable();
        }
        var kinds = jdbc.queryForList("SELECT storage_kind FROM managed_workspace_execution_lease WHERE storage_key = ?",
                String.class, localKey(tenantId, storageId));
        if (kinds.size() > 1 || kinds.size() == 1 && !"LOCAL".equals(kinds.getFirst())) {
            throw WorkspaceExecutionStore.unavailable();
        }
    }

    static String localKey(String tenantId, String storageId) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest((tenantId + "\u0000" + storageId).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
