package com.alibaba.qwen.code.runtimebroker;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.HexFormat;

public final class JdbcCsiReadyAdmission {
    private JdbcCsiReadyAdmission() {
    }

    public static final class Admission {
        private final Connection connection;

        private Admission(Connection connection) {
            this.connection = connection;
        }

        public long requireCurrentTime(Connection target) throws SQLException {
            require(target == connection && !target.getAutoCommit());
            return JdbcRepositorySupport.databaseNowPrecise(target).toEpochMilli();
        }

        public void requireLease(Connection target, long existingExpiryMs, long targetExpiryMs) throws SQLException {
            long now = requireCurrentTime(target);
            require(existingExpiryMs > now && targetExpiryMs > now);
        }
    }

    public static Admission lock(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        require(connection != null && !connection.getAutoCommit() && original != null);
        require(JdbcCsiFilesRetirementGuard.isProfile(original.request().getScope()) && original.generation() == 1);
        original.requireAdmission();
        lockReservation(connection, original);
        JdbcCsiRetirementSeal.requireOpen(connection, original);
        return new Admission(connection);
    }

    static void lockReservation(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        String physicalKey;
        long registrationRevision;
        String alias = aliasKey(original.request().getScope().getTenantId(), original.request().getStorageId());
        try (PreparedStatement statement = statement(connection,
                        "SELECT tenant_id, storage_id, physical_key, registration_revision FROM"
                                + " ma_storage WHERE alias_key = ? AND storage_kind = 'CSI' AND"
                                + " registration_state = 'REGISTERED' FOR UPDATE")) {
            JdbcRepositorySupport.setStringParameter(statement, 1, alias);
            try (var row = statement.executeQuery()) {
                require(row.next()
                        && original.request().getScope().getTenantId().equals(
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        row, "tenant_id"))
                        && original.request().getStorageId().equals(
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        row, "storage_id")));
                physicalKey = row.getString("physical_key");
                registrationRevision = row.getLong("registration_revision");
                require(physicalKey != null && physicalKey.matches("[0-9a-f]{64}") && registrationRevision > 0 && !row.next());
            }
        }
        try (PreparedStatement statement = statement(connection,
                        "SELECT storage_kind, csi_phase, csi_revision, csi_registration_key,"
                                + " csi_registration_revision, binding_id, runtime_generation FROM"
                                + " ma_storage_owner WHERE storage_key = ? FOR UPDATE")) {
            JdbcRepositorySupport.setStringParameter(statement, 1, physicalKey);
            try (var row = statement.executeQuery()) {
                require(row.next() && "CSI".equals(row.getString("storage_kind"))
                        && "RESERVED".equals(row.getString("csi_phase"))
                        && row.getLong("csi_revision") == 1
                        && alias.equals(row.getString("csi_registration_key"))
                        && registrationRevision == row.getLong("csi_registration_revision")
                        && original.bindingId().equals(
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        row, "binding_id"))
                        && original.generation() == row.getLong("runtime_generation") && !row.next());
            }
        }
    }

    private static String aliasKey(String tenant, String storage) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (String field : new String[] {"qwen-csi-alias/1", tenant, storage}) {
                byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
                digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
                digest.update(bytes);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw unavailable();
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_ready_admission_unavailable",
                "The original CSI READY authority is unavailable.", false);
    }
}
