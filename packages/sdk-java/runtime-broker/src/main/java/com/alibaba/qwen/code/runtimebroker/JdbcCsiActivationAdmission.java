package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Objects;

/** Consumes native CSI activation history only on the already-held original parent. */
public final class JdbcCsiActivationAdmission {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_HISTORY = 4096;
    private static final long MAX_HISTORY_BYTES = 64L * 1024 * 1024;

    private JdbcCsiActivationAdmission() {
    }

    static JdbcCsiFilesRetirementGuard.Original lockForExecution(Connection connection, RuntimeBindingRecord hint)
            throws SQLException {
        if (hint == null) {
            throw new IllegalArgumentException("Execution binding is unavailable");
        }
        var original = lockForExecution(connection, hint.getBindingId());
        require(!JdbcCsiFilesRetirementGuard.isProfile(hint.getRequest().getScope()) || original != null);
        if (original != null) {
            require(original.request().equals(hint.getRequest()) && original.generation() == hint.getGeneration());
        }
        return original;
    }

    static JdbcCsiFilesRetirementGuard.Original lockForExecution(Connection connection, String bindingId)
            throws SQLException {
        var original = lockOriginal(connection, bindingId);
        if (original != null) {
            original.requireAdmission();
            requireLive(connection, original);
            JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
        }
        return original;
    }

    static JdbcCsiFilesRetirementGuard.Original lockForContinuation(Connection connection, String bindingId)
            throws SQLException {
        var original = lockOriginal(connection, bindingId);
        if (original != null) {
            original.requireContinuation();
            requireLive(connection, original);
        }
        return original;
    }

    private static JdbcCsiFilesRetirementGuard.Original lockOriginal(Connection connection, String bindingId)
            throws SQLException {
        String tenant;
        String session;
        try (PreparedStatement statement = statement(connection,
                "SELECT tenant_id, isolation_key, capability_digest FROM qwen_runtime_binding WHERE binding_id = ?")) {
            statement.setString(1, bindingId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) {
                    return null;
                }
                if (!CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(row.getString("capability_digest"))) {
                    return null;
                }
                tenant = row.getString("tenant_id");
                session = row.getString("isolation_key");
            }
        }
        if (session == null) {
            throw new RuntimeBrokerException(409, "csi_original_binding_unavailable",
                    "The original CSI Session binding is unavailable.", false);
        }
        JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant, 10);
        try (PreparedStatement statement = statement(connection,
                "SELECT tenant_id FROM qwen_tool_publication_tenant WHERE tenant_key = ? FOR UPDATE")) {
            statement.setString(1, CsiNativeActivationProof.sha256(tenant.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && tenant.equals(row.getString("tenant_id")));
            }
        }
        var original = JdbcCsiFilesRetirementGuard.lockManagedSession(connection, tenant, session);
        require(original != null && bindingId.equals(original.bindingId()));
        return original;
    }

    static void refuseUnqualifiedWriter(Connection connection, String bindingId) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT capability_digest FROM qwen_runtime_binding WHERE binding_id = ?")) {
            statement.setString(1, bindingId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next() || !CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(row.getString("capability_digest"))) {
                    return;
                }
            }
        }
        throw new RuntimeBrokerException(501, "csi_execution_writer_not_qualified",
                "This direct CSI execution mutation is not qualified.", false);
    }

    static void requireExecution(JdbcCsiFilesRetirementGuard.Original original, ToolExecutionRecord execution) {
        if (original == null) {
            return;
        }
        require(execution != null && original.bindingId().equals(execution.getBindingId())
                && original.generation() == execution.getRuntimeGeneration()
                && original.request().getIsolationKey().equals(execution.getHarnessSessionId())
                && original.request().getIsolationKey().equals(execution.getRuntimeSessionId()));
    }

    public static void acceptCommit(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JsonNode metadata, List<JsonNode> records, long previousRevision, long previousSequence,
            String previousDigest, String writerId, long now) throws SQLException {
        History history = history(connection, original, previousRevision, previousSequence, previousDigest, writerId);
        if ("session.create".equals(metadata.path("operation").textValue())) {
            original.requireAdmission();
            require(previousRevision == 0 && original.firstActivationJournalRevision() == null);
            genesisMetadata(metadata, original.request(), CsiNativeActivationProof.sha256(
                    java.util.Base64.getDecoder().decode(metadata.path("recordBytesBase64").textValue())));
            CsiNativeActivationProof.genesis(records, original.request(), ref -> resource(connection, original, ref, 1));
            return;
        }
        var parsed = CsiNativeActivationProof.transaction(records, metadata, original.request(), history.lastUuid());
        boolean first = history.activation() == null;
        require(CsiNativeActivationProof.hasActivation(parsed));
        if (first) {
            original.requireAdmission();
            require(previousRevision == 1 && previousSequence == 0
                    && original.firstActivationJournalRevision() == null);
            JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
            noEarlierAuthorization(connection, original);
        }
        var activation = CsiNativeActivationProof.activation(parsed, metadata, original.request(), writerId,
                history.definitionDigest(), history.activation(), ref -> resource(connection, original, ref, previousRevision + 1));
        require(activation.expiresAt() > now);
        if (first) {
            require(original.version() < 9_007_199_254_740_990L);
            try (PreparedStatement statement = statement(connection,
                    "UPDATE qwen_runtime_binding SET first_activation_journal_revision = ?,"
                            + " record_version = record_version + 1 WHERE binding_id = ? AND request_key = ?"
                            + " AND runtime_generation = 1 AND record_version = ?"
                            + " AND first_activation_journal_revision IS NULL")) {
                statement.setLong(1, previousRevision + 1);
                statement.setString(2, original.bindingId());
                statement.setString(3, original.request().requestKey());
                statement.setLong(4, original.version());
                require(statement.executeUpdate() == 1);
            }
        }
    }

    public static void requireReplay(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long revision, long sequence, String digest, String writerId) throws SQLException {
        history(connection, original, revision, sequence, digest, writerId);
    }

    static void requireLive(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT * FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ? FOR UPDATE")) {
            statement.setString(1, original.request().getScope().getTenantId());
            statement.setString(2, original.request().getIsolationKey());
            try (ResultSet head = statement.executeQuery()) {
                require(head.next() && original.request().getScope().getWorkspaceId().equals(head.getString("workspace_id"))
                        && "ACTIVE".equals(head.getString("state")) && head.getLong("writer_generation") == 1
                        && head.getInt("storage_version") == 1 && head.getString("latest_checkpoint_resource_id") == null
                        && head.getLong("compacted_through_revision") == 0
                        && "READY".equals(head.getString("recovery_status")));
                long now = JdbcRepositorySupport.databaseNowPrecise(connection).toEpochMilli();
                require(head.getTimestamp("writer_lease_until") != null
                        && head.getTimestamp("writer_lease_until").toInstant().toEpochMilli() > now);
                var history = history(connection, original, head.getLong("journal_revision"),
                        head.getLong("committed_sequence"), head.getString("last_commit_digest"), head.getString("writer_id"));
                require(history.activation() != null && history.activation().expiresAt() > now
                        && head.getLong("activation_epoch") == 1);
            }
        }
    }

    private static History history(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long expectedRevision, long expectedSequence, String expectedDigest, String writerId) throws SQLException {
        require(connection != null && !connection.getAutoCommit() && writerId != null && expectedRevision >= 0
                && expectedRevision <= MAX_HISTORY);
        long revision = 0;
        long sequence = 0;
        long byteCount = 0;
        String digest = null;
        String lastUuid = null;
        String definition = null;
        CsiNativeActivationProof.Activation activation = null;
        while (true) {
            int count = 0;
            try (PreparedStatement statement = statement(connection,
                    "SELECT * FROM qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                            + " AND journal_revision > ? ORDER BY journal_revision LIMIT 100 FOR UPDATE")) {
                statement.setString(1, original.request().getScope().getTenantId());
                statement.setString(2, original.request().getIsolationKey());
                statement.setLong(3, revision);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        require(revision < MAX_HISTORY && rows.getLong("journal_revision") == revision + 1
                                && original.request().getScope().getWorkspaceId().equals(rows.getString("workspace_id"))
                                && writerId.equals(rows.getString("writer_id")) && rows.getLong("writer_generation") == 1
                                && "identity".equals(rows.getString("record_encoding")));
                        byte[] bytes = rows.getBytes("record_bytes");
                        require(bytes != null && bytes.length == rows.getLong("byte_length")
                                && CsiNativeActivationProof.sha256(bytes).equals(rows.getString("record_digest")));
                        byteCount += bytes.length;
                        require(byteCount <= MAX_HISTORY_BYTES);
                        JsonNode metadata = metadata(rows);
                        long rowRevision = rows.getLong("journal_revision");
                        var parsed = CsiNativeActivationProof.records(bytes);
                        if (revision == 0) {
                            genesisMetadata(metadata, original.request(), CsiNativeActivationProof.sha256(bytes));
                            var genesis = CsiNativeActivationProof.genesis(parsed, original.request(),
                                    ref -> resource(connection, original, ref, rowRevision));
                            definition = genesis.definitionDigest();
                            lastUuid = genesis.lastRecordUuid();
                        } else {
                            require(rows.getLong("first_sequence") == sequence + 1
                                    && Objects.equals(digest, rows.getString("previous_commit_digest")));
                            var transaction = CsiNativeActivationProof.transaction(parsed, metadata,
                                    original.request(), lastUuid);
                            require(CsiNativeActivationProof.hasActivation(transaction));
                            if (activation == null) {
                                require(revision == 1 && Objects.equals(original.firstActivationJournalRevision(), 2L));
                            }
                            activation = CsiNativeActivationProof.activation(transaction, metadata, original.request(),
                                    writerId, definition, activation, ref -> resource(connection, original, ref, rowRevision));
                            lastUuid = transaction.lastRecordUuid();
                        }
                        sequence = rows.getLong("last_sequence");
                        digest = rows.getString("commit_digest");
                        revision++;
                        count++;
                    }
                }
            }
            if (count < 100) {
                break;
            }
        }
        require(revision == expectedRevision && sequence == expectedSequence && Objects.equals(digest, expectedDigest)
                && (activation == null ? original.firstActivationJournalRevision() == null
                        : Objects.equals(original.firstActivationJournalRevision(), 2L)));
        return new History(definition, lastUuid, activation);
    }

    private static void noEarlierAuthorization(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        String cursor = "";
        int total = 0;
        while (true) {
            int count = 0;
            try (PreparedStatement statement = statement(connection,
                    "SELECT * FROM qwen_tool_execution WHERE (binding_id = ? OR harness_session_id = ?"
                            + " OR runtime_session_id = ?) AND execution_call_id_hash > ?"
                            + " ORDER BY execution_call_id_hash LIMIT 100 FOR UPDATE")) {
                statement.setString(1, original.bindingId());
                statement.setString(2, original.request().getIsolationKey());
                statement.setString(3, original.request().getIsolationKey());
                statement.setString(4, cursor);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        require(++total <= MAX_HISTORY && original.bindingId().equals(rows.getString("binding_id"))
                                && rows.getLong("runtime_generation") == 1
                                && original.request().getIsolationKey().equals(rows.getString("harness_session_id"))
                                && original.request().getIsolationKey().equals(rows.getString("runtime_session_id"))
                                && rows.getObject("authorized_dispatch_generation") == null
                                && rows.getObject("authorized_binding_version") == null
                                && rows.getLong("dispatch_generation") == 0
                                && ("PREPARED".equals(rows.getString("execution_state"))
                                        || "SETTLED".equals(rows.getString("execution_state"))
                                                && "not_started".equals(rows.getString("execution_status"))));
                        cursor = rows.getString("execution_call_id_hash");
                        count++;
                    }
                }
            }
            if (count < 100) {
                return;
            }
        }
    }

    private static JsonNode metadata(ResultSet row) throws SQLException {
        ObjectNode result = JSON.createObjectNode();
        for (String field : List.of("transaction_id", "command_id", "operation", "content_digest", "events_digest",
                "previous_commit_digest", "commit_digest", "writer_id", "latest_checkpoint_resource_id")) {
            result.put(camel(field), row.getString(field));
        }
        for (String field : List.of("first_sequence", "last_sequence", "event_count", "writer_generation", "activation_epoch")) {
            result.put(camel(field), row.getLong(field));
        }
        return result;
    }

    private static String camel(String field) {
        StringBuilder result = new StringBuilder();
        boolean uppercase = false;
        for (char character : field.toCharArray()) {
            if (character == '_') {
                uppercase = true;
            } else {
                result.append(uppercase ? Character.toUpperCase(character) : character);
                uppercase = false;
            }
        }
        return result.toString();
    }

    private static void genesisMetadata(JsonNode metadata, RuntimeProvisionRequest original, String recordDigest) {
        String id = "session.create:" + original.getIsolationKey();
        require(id.equals(metadata.path("transactionId").textValue()) && id.equals(metadata.path("commandId").textValue())
                && "session.create".equals(metadata.path("operation").textValue())
                && recordDigest.equals(metadata.path("contentDigest").textValue())
                && metadata.path("firstSequence").longValue() == 0 && metadata.path("lastSequence").longValue() == 0
                && metadata.path("eventCount").longValue() == 0 && metadata.path("activationEpoch").longValue() == 0
                && metadata.path("writerGeneration").longValue() == 1
                && metadata.path("eventsDigest").isNull() && metadata.path("previousCommitDigest").isNull()
                && metadata.path("commitDigest").isNull() && metadata.path("latestCheckpointResourceId").isNull());
    }

    private static byte[] resource(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JsonNode ref, long revision) {
        try (PreparedStatement statement = statement(connection,
                "SELECT r.* FROM qwen_managed_session_resource r JOIN qwen_managed_session_resource_ref x"
                        + " ON r.session_scope_key = x.session_scope_key AND r.resource_id = x.resource_id"
                        + " WHERE r.tenant_id = ? AND r.session_id = ? AND r.resource_id = ?"
                        + " AND x.journal_revision = ? AND x.tenant_id = ? AND x.workspace_id = ?"
                        + " AND x.session_id = ? AND r.session_scope_key = ? FOR UPDATE")) {
            statement.setString(1, original.request().getScope().getTenantId());
            statement.setString(2, original.request().getIsolationKey());
            statement.setString(3, ref.path("resourceId").textValue());
            statement.setLong(4, revision);
            statement.setString(5, original.request().getScope().getTenantId());
            statement.setString(6, original.request().getScope().getWorkspaceId());
            statement.setString(7, original.request().getIsolationKey());
            statement.setString(8, CsiNativeActivationProof.sha256((original.request().getScope().getTenantId()
                    + "\u0000" + original.request().getIsolationKey()).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && original.request().getScope().getWorkspaceId().equals(row.getString("workspace_id"))
                        && "REFERENCED".equals(row.getString("state")) && "MYSQL_INLINE".equals(row.getString("storage_kind"))
                        && ref.path("kind").textValue().equals(row.getString("kind"))
                        && row.getLong("schema_version") == ref.path("schemaVersion").longValue()
                        && row.getLong("byte_length") == ref.path("byteLength").longValue()
                        && ref.path("digest").textValue().equals(row.getString("sha256")));
                byte[] bytes = row.getBytes("inline_bytes");
                require(!row.next());
                return bytes;
            }
        } catch (SQLException error) {
            throw JdbcRepositorySupport.failure(error);
        }
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw new RuntimeBrokerException(409, "csi_original_activation_unavailable",
                    "The original CSI native activation proof is unavailable.", false);
        }
    }

    private record History(String definitionDigest, String lastUuid, CsiNativeActivationProof.Activation activation) {
    }
}
