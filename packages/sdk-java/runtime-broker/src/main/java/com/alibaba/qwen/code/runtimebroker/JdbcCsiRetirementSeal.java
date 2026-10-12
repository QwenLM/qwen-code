package com.alibaba.qwen.code.runtimebroker;

import java.sql.Connection;
import java.sql.SQLException;

final class JdbcCsiRetirementSeal {
    private JdbcCsiRetirementSeal() {
    }

    static void requireOpen(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        original.requireAdmission();
        try (var statement = connection.prepareStatement(
                "SELECT retirement_id FROM managed_workspace_csi_retirement"
                        + " WHERE binding_id = ? AND runtime_generation = ? FOR UPDATE")) {
            statement.setQueryTimeout(10);
            statement.setString(1, original.bindingId());
            statement.setLong(2, original.generation());
            try (var rows = statement.executeQuery()) {
                if (rows.next()) {
                    throw new RuntimeBrokerException(409, "csi_retirement_identity_unavailable",
                            "The original CSI Runtime is sealed for retirement.", false);
                }
            }
        }
    }
}
