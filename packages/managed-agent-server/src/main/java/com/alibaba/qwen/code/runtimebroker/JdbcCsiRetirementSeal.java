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
                        "SELECT operation_id FROM ma_operation WHERE operation_kind ="
                                + " 'CSI_RETIREMENT' AND target_key = ? AND target_revision = ? AND"
                                + " tenant_id = ? FOR UPDATE")) {
            statement.setQueryTimeout(10);
            JdbcRepositorySupport.setStringParameter(
                    statement,
                    1,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            original.bindingId()));
            statement.setLong(2, original.generation());
            JdbcRepositorySupport.setIdentity(
                    statement, 3, original.request().getScope().getTenantId());
            try (var rows = statement.executeQuery()) {
                if (rows.next()) {
                    throw new RuntimeBrokerException(409, "csi_retirement_identity_unavailable",
                            "The original CSI Runtime is sealed for retirement.", false);
                }
            }
        }
    }
}
