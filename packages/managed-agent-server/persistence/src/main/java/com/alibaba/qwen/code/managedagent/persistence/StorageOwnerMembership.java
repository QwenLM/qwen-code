package com.alibaba.qwen.code.managedagent.persistence;

import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;

public final class StorageOwnerMembership {
    private StorageOwnerMembership() {
    }

    static boolean membersAllowed(JdbcTemplate jdbc, String key) {
        return Boolean.TRUE.equals(jdbc.execute((ConnectionCallback<Boolean>) connection -> membersAllowed(connection, key,
                TransactionSynchronizationManager.isActualTransactionActive())));
    }

    public static boolean membersAllowed(Connection connection, String key, boolean lock) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT storage_kind, holder_key, maintenance_id, maintenance_generation"
                + " FROM ma_storage_owner WHERE storage_key = ?" + (lock ? " FOR UPDATE" : ""))) {
            statement.setString(1, key);
            try (var rows = statement.executeQuery()) {
                if (!rows.next() || !java.util.Set.of("LOCAL", "SSH_LOCAL").contains(rows.getString("storage_kind"))) {
                    return false;
                }
                String holder = rows.getString("holder_key");
                String maintenance = rows.getString("maintenance_id");
                if (holder == null && maintenance == null) {
                    return true;
                }
                long generation = rows.getLong("maintenance_generation");
                return "LOCAL".equals(rows.getString("storage_kind")) && maintenance != null && generation > 0
                        && maintenanceHolderKey(maintenance, generation).equals(holder)
                        && isWorktreePreparation(connection, key, maintenance, generation);
            }
        }
    }

    static boolean isWorktreePreparation(Connection connection, String physical, String maintenance, long generation)
            throws SQLException {
        // Identity survives BLOCKED/expired claims. Do not lock the operation after its owner row.
        try (var statement = connection.prepareStatement("SELECT 1 FROM ma_session_worktree w JOIN ma_operation o"
                + " ON o.tenant_id = w.tenant_id AND o.session_id = w.session_id AND o.operation_id = CAST(w.worktree_id AS BINARY(32))"
                + " AND o.physical_key = w.physical_key AND o.target_id = w.storage_id"
                + " WHERE o.operation_kind = 'SESSION_WORKTREE' AND o.target_kind = 'STORAGE'"
                + " AND w.worktree_id = ? AND w.physical_key = ? AND o.claim_generation = ?")) {
            statement.setString(1, maintenance);
            statement.setString(2, physical);
            statement.setLong(3, generation);
            try (var rows = statement.executeQuery()) {
                return rows.next() && !rows.next();
            }
        }
    }

    static String maintenanceHolderKey(String maintenanceId, long claimGeneration) {
        return digest("child-workspace\u0000" + maintenanceId + "\u0000" + claimGeneration);
    }

    private static String digest(String value) {
        try {
            return DigestUtils.sha256Hex(value.getBytes(StandardCharsets.UTF_8));
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
