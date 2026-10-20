package com.alibaba.qwen.code.runtimebroker;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;

/** Same-connection authority for the sole original application retirement. */
public final class JdbcCsiApplicationRetirement {
    public enum Stage { SETTLING, FROZEN, CUT, DRAINED }

    private JdbcCsiApplicationRetirement() {
    }

    public static final class Authority {
        private final Connection connection;
        private final JdbcCsiFilesRetirementGuard.Original original;
        private final String retirementId;
        private final Stage stage;
        private final long deadline;
        private final long sealedBindingVersion;
        private final byte[] frozen;
        private final byte[] cut;
        private final byte[] receipt;

        private Authority(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
                String retirementId, Stage stage, long deadline, long sealedBindingVersion,
                byte[] frozen, byte[] cut, byte[] receipt) {
            this.connection = connection;
            this.original = original;
            this.retirementId = retirementId;
            this.stage = stage;
            this.deadline = deadline;
            this.sealedBindingVersion = sealedBindingVersion;
            this.frozen = copy(frozen);
            this.cut = copy(cut);
            this.receipt = copy(receipt);
        }

        public JdbcCsiFilesRetirementGuard.Original original() { return original; }
        public String retirementId() { return retirementId; }
        public Stage stage() { return stage; }
        public long sealedBindingVersion() { return sealedBindingVersion; }
        public byte[] frozenBytes() { return copy(frozen); }
        public byte[] cutBytes() { return copy(cut); }
        public byte[] receiptBytes() { return copy(receipt); }

        public void requireConnection(Connection target) throws SQLException {
            require(connection == target && !target.getAutoCommit());
        }

        public long requireCurrentTime(Connection target) throws SQLException {
            requireConnection(target);
            long now = JdbcRepositorySupport.databaseNowPrecise(target).toEpochMilli();
            require(now < deadline);
            return now;
        }

        public void requirePreCut(Connection target) throws SQLException {
            requireConnection(target);
            require(stage == Stage.SETTLING || stage == Stage.FROZEN);
            requireCurrentTime(target);
        }
    }

    public static Authority lock(Connection connection, String tenantId, String sessionId,
            String bindingId, String retirementId) throws SQLException {
        require(connection != null && !connection.getAutoCommit());
        var original = JdbcCsiFilesRetirementGuard.lockBindingControl(connection, bindingId);
        require(original != null && original.state() == RuntimeBindingRecord.State.DRAINING && original.draining()
                && original.generation() == 1 && tenantId.equals(original.request().getScope().getTenantId())
                && sessionId.equals(original.request().getIsolationKey()));
        JdbcCsiApplicationProgress.lockReservation(connection, original);
        Long ceiling = JdbcCsiRetirementSeal.lock(connection, original);
        require(ceiling != null);
        try (PreparedStatement statement = statement(connection,
                "SELECT * FROM ma_operation WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' FOR UPDATE")) {
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("CSI_RETIREMENT", tenantId, retirementId));
            try (var row = statement.executeQuery()) {
                require(row.next() && retirementId.equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "operation_id"))
                        && "qwen-csi-application-retirement/1".equals(row.getString("progress_format")));
                Stage stage;
                try {
                    stage = Stage.valueOf(row.getString("progress_stage"));
                } catch (IllegalArgumentException | NullPointerException malformed) {
                    throw unavailable();
                }
                require(row.getLong("progress_version") == stage.ordinal() + 1L && !row.wasNull());
                long deadline = row.getLong("settlement_deadline_ms");
                require(!row.wasNull() && deadline > 0);
                try {
                    var identity = CsiNativeActivationProof.readObject(JdbcCsiRetirementSeal.operationIdentity(row, original).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    require(deadline == Math.addExact(Instant.parse(identity.path("startedAt").textValue()).toEpochMilli(), 300_000));
                } catch (RuntimeException malformed) {
                    throw unavailable();
                }
                byte[] frozen = payload(row.getBytes("frozen_request_bytes"), row.getString("frozen_request_sha256"),
                        stage != Stage.SETTLING);
                byte[] cut = payload(row.getBytes("cut_bytes"), row.getString("cut_sha256"),
                        stage == Stage.CUT || stage == Stage.DRAINED);
                byte[] receipt = payload(row.getBytes("finalize_receipt_bytes"), row.getString("finalize_receipt_sha256"),
                        stage == Stage.DRAINED);
                require(!row.next());
                var authority = new Authority(connection, original, retirementId, stage, deadline, ceiling,
                        frozen, cut, receipt);
                requireStageRows(connection, authority);
                return authority;
            }
        }
    }

    private static void requireStageRows(Connection connection, Authority authority) throws SQLException {
        var original = authority.original();
        boolean terminal = authority.stage() == Stage.CUT || authority.stage() == Stage.DRAINED;
        if (terminal) {
            JdbcCsiActivationAdmission.terminalHistory(connection, authority);
        } else {
            JdbcCsiActivationAdmission.lockRetirementPredecessor(connection, authority);
        }
        try (var statement = statement(connection,
                "SELECT workspace_id, state, activation_phase FROM ma_session_head"
                        + " WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? FOR UPDATE")) {
            statement.setString(1, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getScope().getTenantId()));
            statement.setString(2, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getIsolationKey()));
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 4, original.request().getIsolationKey());
            try (var row = statement.executeQuery()) {
                require(row.next() && original.request().getScope().getWorkspaceId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_id"))
                        && (terminal ? "SEALED" : "ACTIVE").equals(row.getString("state"))
                        && (terminal ? "released" : "active").equals(row.getString("activation_phase")) && !row.next());
            }
        }
        try (var statement = statement(connection,
                "SELECT * FROM ma_runtime_session WHERE binding_id = ? OR"
                        + " (tenant_id = ? AND harness_session_id = ?) ORDER BY scope_key, runtime_session_id FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.bindingId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getIsolationKey());
            try (var row = statement.executeQuery()) {
                require(row.next() && original.bindingId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "binding_id"))
                        && row.getLong("runtime_generation") == 1
                        && JdbcRepositorySupport.scopeKey(original.request().getScope()).equals(row.getString("scope_key"))
                        && original.request().getScope().getTenantId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "tenant_id"))
                        && original.request().getScope().getWorkspaceId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_id"))
                        && original.request().getScope().getWorkspaceGeneration().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_generation"))
                        && original.request().getScope().getCanonicalCwd().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "canonical_cwd"))
                        && original.request().getScope().getCapabilityDigest().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "capability_digest"))
                        && "session".equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "isolation_class")) && row.getLong("record_version") > 0
                        && original.request().getIsolationKey().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "runtime_session_id"))
                        && original.request().getIsolationKey().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "harness_session_id"))
                        && "bootstrap".equals(row.getString("turn_kind"))
                        && (authority.stage() == Stage.DRAINED ? "RELEASED" : "READY").equals(row.getString("session_state"))
                        && !row.next());
            }
        }
    }

    private static byte[] payload(byte[] bytes, String digest, boolean present) {
        require(present ? bytes != null && bytes.length > 0 && bytes.length <= 32 * 1024 * 1024
                && digest != null && digest.matches("[0-9a-f]{64}") && digest.equals(CsiNativeActivationProof.sha256(bytes))
                : bytes == null && digest == null);
        return bytes;
    }

    private static byte[] copy(byte[] bytes) { return bytes == null ? null : bytes.clone(); }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        var statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw unavailable();
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_application_retirement_unavailable",
                "The original CSI application retirement authority is unavailable.", false);
    }
}
