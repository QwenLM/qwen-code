package com.alibaba.qwen.code.runtimebroker;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.util.HexFormat;

public final class JdbcCsiApplicationProgress {
    private JdbcCsiApplicationProgress() {
    }

    public static final class Continuation {
        private final Connection connection;
        private final Long settlementDeadlineMs;
        private final Long sealedBindingVersion;

        private Continuation(Connection connection, Long settlementDeadlineMs, Long sealedBindingVersion) {
            this.connection = connection;
            this.settlementDeadlineMs = settlementDeadlineMs;
            this.sealedBindingVersion = sealedBindingVersion;
        }

        public Long sealedBindingVersion() {
            return sealedBindingVersion;
        }

        public long requireCurrentTime(Connection target) throws SQLException {
            require(target == connection && !target.getAutoCommit());
            long now = JdbcRepositorySupport.databaseNowPrecise(target).toEpochMilli();
            require(settlementDeadlineMs == null || now < settlementDeadlineMs);
            return now;
        }

        public void requireLease(Connection connection, long existingExpiryMs, long targetExpiryMs) throws SQLException {
            long now = requireCurrentTime(connection);
            require(existingExpiryMs > now && targetExpiryMs > now);
            if (settlementDeadlineMs != null
                    && (existingExpiryMs > settlementDeadlineMs || targetExpiryMs > settlementDeadlineMs)) {
                throw unavailable();
            }
        }
    }

    public static Continuation lock(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        if (connection == null || connection.getAutoCommit() || original == null) {
            throw unavailable();
        }
        require(JdbcCsiFilesRetirementGuard.isProfile(original.request().getScope()) && original.generation() == 1);
        original.requireContinuation();
        lockReservation(connection, original);
        Long ceiling = JdbcCsiRetirementSeal.lock(connection, original);
        try (PreparedStatement statement = statement(connection,
                "SELECT * FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT'"
                        + " AND target_key = ? AND target_revision = ? AND tenant_id = ? FOR UPDATE")) {
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.bindingId()));
            statement.setLong(2, original.generation());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            try (var row = statement.executeQuery()) {
                if (!row.next()) {
                    require(ceiling == null);
                    return new Continuation(connection, null, null);
                }
                require(ceiling != null && "qwen-csi-application-retirement/1".equals(row.getString("progress_format"))
                        && row.getLong("progress_version") == 1 && !row.wasNull()
                        && "SETTLING".equals(row.getString("progress_stage")));
                long deadline = row.getLong("settlement_deadline_ms");
                require(!row.wasNull() && deadline > 0);
                var identity = CsiNativeActivationProof.readObject(JdbcCsiRetirementSeal.operationIdentity(row, original).getBytes(StandardCharsets.UTF_8));
                try {
                    require(deadline == Math.addExact(Instant.parse(identity.path("startedAt").textValue()).toEpochMilli(), 300_000));
                } catch (RuntimeException malformed) {
                    throw unavailable();
                }
                for (String field : new String[] {"frozen_request_bytes", "frozen_request_sha256", "cut_bytes", "cut_sha256",
                        "finalize_receipt_bytes", "finalize_receipt_sha256"}) {
                    require(row.getObject(field) == null);
                }
                require(!row.next());
                var progress = new Continuation(connection, deadline, ceiling);
                progress.requireCurrentTime(connection);
                return progress;
            }
        }
    }

    static void lockReservation(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        String physicalKey;
        long registrationRevision;
        String alias = aliasKey(original.request().getScope().getTenantId(), original.request().getStorageId());
        try (PreparedStatement statement = statement(connection,
                "SELECT tenant_id, storage_id, physical_key, registration_revision"
                        + " FROM ma_storage WHERE alias_key = ? AND storage_kind = 'CSI' AND registration_state = 'REGISTERED' FOR UPDATE")) {
            statement.setString(1, alias);
            try (var row = statement.executeQuery()) {
                require(row.next()
                        && original.request().getScope().getTenantId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "tenant_id"))
                        && original.request().getStorageId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "storage_id")));
                physicalKey = row.getString("physical_key");
                registrationRevision = row.getLong("registration_revision");
                require(physicalKey != null && physicalKey.matches("[0-9a-f]{64}") && registrationRevision > 0 && !row.next());
            }
        }
        try (PreparedStatement statement = statement(connection,
                "SELECT storage_kind, csi_phase, csi_revision, csi_registration_key, csi_registration_revision,"
                        + " binding_id, runtime_generation FROM ma_storage_owner"
                        + " WHERE storage_key = ? FOR UPDATE")) {
            statement.setString(1, physicalKey);
            try (var row = statement.executeQuery()) {
                boolean draining = original.state() == RuntimeBindingRecord.State.DRAINING;
                require(row.next() && "CSI".equals(row.getString("storage_kind"))
                        && (draining ? "DRAINING" : "RESERVED").equals(row.getString("csi_phase"))
                        && (draining ? CsiOwnershipRevision.draining(row.getLong("csi_revision"))
                                : CsiOwnershipRevision.reserved(row.getLong("csi_revision")))
                        && alias.equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "csi_registration_key"))
                        && registrationRevision == row.getLong("csi_registration_revision")
                        && original.bindingId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "binding_id"))
                        && original.generation() == row.getLong("runtime_generation") && !row.next());
            }
        }
    }

    private static String aliasKey(String tenant, String storage) {
        MessageDigest digest = org.apache.commons.codec.digest.DigestUtils.getSha256Digest();
        for (String field : new String[] {"qwen-csi-alias/1", tenant, storage}) {
            byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
            digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
            digest.update(bytes);
        }
        return HexFormat.of().formatHex(digest.digest());
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
        return new RuntimeBrokerException(409, "csi_application_continuation_unavailable",
                "The original CSI application does not admit this continuation.", false);
    }
}
