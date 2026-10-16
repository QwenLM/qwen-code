package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Consumes native CSI activation history only on the already-held original parent. */
public final class JdbcCsiActivationAdmission {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_HISTORY = 4096;
    private static final long MAX_HISTORY_BYTES = 64L * 1024 * 1024;

    private JdbcCsiActivationAdmission() {
    }

    record ReservationScope(JdbcCsiFilesRetirementGuard.Original original, NativeHead head) {
        CsiNativeActivationProof.Prefix prefix() {
            return head.prefix();
        }
    }

    static ReservationScope lockForReservation(Connection connection, RuntimeBindingRecord hint,
            JdbcRuntimeBindingRepository bindings) throws SQLException {
        require(hint != null && JdbcCsiFilesRetirementGuard.isProfile(hint.getRequest().getScope()));
        var original = lockOriginal(connection, hint.getBindingId());
        require(original != null && original.request().equals(hint.getRequest()) && original.generation() == hint.getGeneration());
        original.requireAdmission();
        var head = lockNativeHead(connection, original);
        requireHistoryIdentity(connection, original, head.prefix(), bindings);
        return new ReservationScope(original, head);
    }

    static JdbcCsiFilesRetirementGuard.Original lockForExecution(Connection connection, RuntimeBindingRecord hint,
            JdbcRuntimeBindingRepository bindings)
            throws SQLException {
        if (hint == null) {
            throw new IllegalArgumentException("Execution binding is unavailable");
        }
        var original = lockForExecution(connection, hint.getBindingId(), bindings);
        require(!JdbcCsiFilesRetirementGuard.isProfile(hint.getRequest().getScope()) || original != null);
        if (original != null) {
            require(original.request().equals(hint.getRequest()) && original.generation() == hint.getGeneration());
        }
        return original;
    }

    static JdbcCsiFilesRetirementGuard.Original lockForExecution(Connection connection, String bindingId,
            JdbcRuntimeBindingRepository bindings)
            throws SQLException {
        var original = lockOriginal(connection, bindingId);
        if (original != null) {
            original.requireAdmission();
            requireHistoryIdentity(connection, original, requireLive(connection, original), bindings);
            JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
        }
        return original;
    }

    record ContinuationScope(JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiReadyAdmission.Admission progress, NativeHead head) {
    }

    static ContinuationScope lockForContinuation(Connection connection, String bindingId,
            JdbcRuntimeBindingRepository bindings)
            throws SQLException {
        var original = lockOriginal(connection, bindingId);
        if (original != null) {
            original.requireAdmission();
            var progress = JdbcCsiReadyAdmission.lock(connection, original);
            var head = lockNativeHead(connection, original);
            requireHistoryIdentity(connection, original, head.prefix(), bindings);
            progress.requireLease(connection, head.writerExpiresAt(), head.writerExpiresAt());
            progress.requireLease(connection, head.activationExpiresAt(), head.activationExpiresAt());
            return new ContinuationScope(original, progress, head);
        }
        return null;
    }

    private static void requireHistoryIdentity(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, JdbcRuntimeBindingRepository bindings) throws SQLException {
        if (prefix.fileHistory() == null) {
            return;
        }
        require(bindings != null);
        var binding = bindings.findByIdForUpdate(connection, original.bindingId());
        require(binding != null && binding.getRequest().equals(original.request())
                && binding.getGeneration() == original.generation() && binding.getVersion() == original.version());
        WorkspaceCsiRuntimeIdentity.fileHistoryBoot(binding);
    }

    private static JdbcCsiFilesRetirementGuard.Original lockOriginal(Connection connection, String bindingId)
            throws SQLException {
        return JdbcCsiFilesRetirementGuard.lockBindingControl(connection, bindingId);
    }

    static void refuseUnqualifiedWriter(Connection connection, String bindingId) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                        "SELECT capability_digest FROM ma_runtime_binding WHERE binding_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, bindingId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next() || !CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(
                                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows
                                        .identity(row, "capability_digest"))) {
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
            String previousDigest, String writerId, long now, JdbcCsiReadyAdmission.Admission progress) throws SQLException {
        require(progress != null);
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
        if (!CsiNativeActivationProof.hasActivation(parsed)) {
            original.requireAdmission();
            String operation = metadata.path("operation").textValue();
            require(!first && history.activation().expiresAt() > now
                    && writerId.equals(history.activation().workerId())
                    && metadata.path("writerGeneration").longValue() == history.activation().writerGeneration());
            var next = CsiNativeActivationProof.advance(parsed, metadata, original.request(), writerId,
                    history.genesis(), history.activation(), previousRevision, previousSequence, history.prefix(),
                    ref -> resource(connection, original, ref, previousRevision + 1));
            boolean dispatchCheckpoint = "commitCheckpoint".equals(operation)
                    && history.prefix().checkpoint() != null && next.checkpoint().state().path("tools").path("items").size()
                            > history.prefix().checkpoint().state().path("tools").path("items").size();
            if ("toolIntent".equals(operation) || dispatchCheckpoint) {
                var inventory = CsiNativeToolReservation.inventory(connection, original);
                CsiNativeToolReservation.requireReady(connection, original);
                CsiNativeToolReservation.qualifyNativeBatch(next,
                        CsiNativeToolReservation.complete(connection, original, next, inventory), dispatchCheckpoint);
            }
            if (!next.receipts().isEmpty()) {
                JdbcCsiExecutionAdmission.verifyReceipts(connection, original,
                        lockNativeHead(connection, original), next,
                        "commitFileHistory".equals(operation) ? previousSequence + 1 : 0,
                        "commitFileHistory".equals(operation) ? previousRevision + 1 : 0);
            }
            progress.requireLease(connection, history.activation().expiresAt(), history.activation().expiresAt());
            return;
        }
        if (first) {
            original.requireAdmission();
            require(previousRevision == 1 && previousSequence == 0
                    && original.firstActivationJournalRevision() == null);
            JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
            noEarlierAuthorization(connection, original);
        } else {
            require(!"installActivation".equals(metadata.path("operation").textValue()));
        }
        var activation = CsiNativeActivationProof.activation(parsed, metadata, original.request(), writerId,
                history.genesis().definitionDigest(), history.activation(),
                ref -> resource(connection, original, ref, previousRevision + 1));
        progress.requireLease(connection,
                first || "installActivation".equals(metadata.path("operation").textValue())
                        ? activation.expiresAt() : history.activation().expiresAt(), activation.expiresAt());
        if (first) {
            require(original.version() < 9_007_199_254_740_990L);
            try (PreparedStatement statement = statement(connection,
                            "UPDATE ma_runtime_binding SET first_activation_journal_revision = ?,"
                                + " record_version = record_version + 1 WHERE binding_id = ? AND"
                                + " request_key = ? AND runtime_generation = 1 AND record_version ="
                                + " ? AND first_activation_journal_revision IS NULL")) {
                statement.setLong(1, previousRevision + 1);
                JdbcRepositorySupport.setIdentity(statement, 2, original.bindingId());
                JdbcRepositorySupport.setStringParameter(
                        statement, 3, original.request().requestKey());
                statement.setLong(4, original.version());
                progress.requireCurrentTime(connection);
                require(statement.executeUpdate() == 1);
            }
        }
    }

    public static void preflightCommit(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JsonNode metadata, List<JsonNode> records, long previousRevision, long previousSequence,
            String previousDigest, String writerId) throws SQLException {
        String operation = CsiNativeActivationProof.text(metadata, "operation");
        require(java.util.Set.of("commitFileHistory", "toolIntent", "commitCheckpoint").contains(operation));
        original.requireAdmission();
        History history = history(connection, original, previousRevision, previousSequence, previousDigest, writerId);
        require(history.activation() != null);
        var inventory = CsiNativeToolReservation.inventory(connection, original);
        var candidates = new java.util.LinkedHashMap<String, JsonNode>();
        require(metadata.path("resources").isArray());
        for (JsonNode candidate : metadata.path("resources")) {
            CsiNativeActivationProof.closed(candidate,
                    java.util.Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest", "bytesBase64"));
            require(candidates.put(CsiNativeActivationProof.id(candidate, "resourceId"), candidate) == null);
        }
        var needed = new java.util.HashSet<String>();
        java.util.function.Function<JsonNode, byte[]> reader = ref -> {
            String resourceId = CsiNativeActivationProof.id(ref, "resourceId");
            JsonNode candidate = candidates.get(resourceId);
            require(candidate != null);
            for (String field : List.of("resourceId", "kind", "schemaVersion", "byteLength", "digest")) {
                require(CsiNativeActivationProof.canonical(ref.get(field)).equals(CsiNativeActivationProof.canonical(candidate.get(field))));
            }
            needed.add(resourceId);
            byte[] bytes = candidate.path("bytesBase64").isNull() ? null
                    : java.util.Base64.getDecoder().decode(candidate.path("bytesBase64").textValue());
            if (inventory.containsKey(resourceId)) {
                byte[] originalBytes = CsiNativeToolReservation.candidateBytes(inventory, ref);
                require(bytes == null || java.util.Arrays.equals(originalBytes, bytes));
                return originalBytes;
            }
            require(bytes != null);
            return bytes;
        };
        var parsed = CsiNativeActivationProof.transaction(records, metadata, original.request(), history.lastUuid());
        var next = CsiNativeActivationProof.advance(parsed, metadata, original.request(), writerId,
                history.genesis(), history.activation(), previousRevision, previousSequence, history.prefix(), reader);
        require(needed.equals(candidates.keySet()));
        if ("commitFileHistory".equals(operation)) {
            CsiNativeToolReservation.preflightHistory(connection, original, history.prefix(), next, inventory);
        } else if ("toolIntent".equals(operation) || history.prefix().checkpoint() != null
                && next.checkpoint().state().path("tools").path("items").size()
                        > history.prefix().checkpoint().state().path("tools").path("items").size()) {
            CsiNativeToolReservation.preflightNative(connection, original, history.prefix(), next, inventory, operation);
        }
        require(history.activation().expiresAt() > JdbcRepositorySupport.databaseNowPrecise(connection).toEpochMilli());
    }

    public static Map<String, Object> readPreparation(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            NativeHead head, JsonNode subject, Runnable retirementFence) throws SQLException {
        original.requireAdmission();
        var prefix = head.prefix();
        require(prefix.fileHistory() != null && prefix.pendingBatch() != null && prefix.input() != null);
        var fileHistory = prefix.fileHistory();
        JsonNode preparation = fileHistory.body().path("preparation");
        require("intent".equals(preparation.path("stage").textValue())
                && CsiNativeActivationProof.canonical(subject).equals(CsiNativeActivationProof.canonical(fileHistory.ref())));
        var resources = CsiNativeToolReservation.inventory(connection, original);
        retirementFence.run();
        JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
        var session = JdbcRuntimeSessionRepository.selectSession(connection, original.request().getScope(),
                original.request().getIsolationKey(), true);
        original.requireSession(session);
        require(session.getState() == RuntimeSessionRecord.State.READY);
        var batch = CsiNativeToolReservation.read(connection, original, prefix, resources,
                prefix.input().inputId(), prefix.pendingBatch().messageId());
        @SuppressWarnings("unchecked")
        var members = (List<Map<String, Object>>) batch.get("members");
        require(members.stream().allMatch(member -> "prepared".equals(member.get("state"))));
        var evidenceResources = new java.util.LinkedHashMap<String, Map<String, Object>>();
        var frozen = fileHistory.batches().get(prefix.pendingBatch().messageId());
        require(frozen != null && frozen.preparedRef() == null);
        for (JsonNode ref : java.util.stream.Stream.concat(java.util.stream.Stream.of(fileHistory.ref()),
                frozen.invocations().stream().flatMap(invocation -> java.util.stream.Stream.of(
                        invocation.path("inputRef"), invocation.path("toolDefinitionRef")))).toList()) {
            byte[] bytes = frozenResource(connection, original, ref, frozen.intentSequence());
            CsiNativeActivationProof.reference(ref, CsiNativeActivationProof.text(ref, "kind"), ignored -> bytes);
            evidenceResources.put(CsiNativeActivationProof.id(ref, "resourceId"), Map.of(
                    "reference", JSON.convertValue(ref, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {}),
                    "bytesBase64", java.util.Base64.getEncoder().encodeToString(bytes)));
        }
        head.requireCurrentTime(connection);
        return Map.of("kind", "intent", "intentRef", JSON.convertValue(fileHistory.ref(),
                new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {}),
                "resources", List.copyOf(evidenceResources.values()), "members", members.stream().map(member -> member.get("reference")).toList());
    }

    public static void requireReplay(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long revision, long sequence, String digest, String writerId) throws SQLException {
        var history = history(connection, original, revision, sequence, digest, writerId);
        if (history.activation() != null) {
            lockNativeHead(connection, original);
        }
        if (!history.prefix().intents().isEmpty()) {
            var inventory = CsiNativeToolReservation.inventory(connection, original);
            CsiNativeToolReservation.requireReady(connection, original);
            var executions = CsiNativeToolReservation.complete(connection, original, history.prefix(), inventory);
            if (history.prefix().receipts().isEmpty() && history.prefix().pendingBatch() != null
                    && executions.stream().allMatch(execution -> execution.getState() == ToolExecutionRecord.State.PREPARED
                            && execution.getDispatchGeneration() == 0)) {
                CsiNativeToolReservation.qualifyNativeBatch(history.prefix(), executions,
                        "await_runtime".equals(history.prefix().checkpoint().state().path("continuation").path("phase").textValue()));
            }
            JdbcCsiExecutionAdmission.verifyReceipts(connection, original,
                    lockNativeHead(connection, original), history.prefix());
        }
    }

    static CsiNativeActivationProof.Prefix requireLive(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        return lockNativeHead(connection, original).prefix();
    }

    public record NativeHead(long revision, long sequence, String digest, CsiNativeActivationProof.Prefix prefix,
            long writerExpiresAt, long activationExpiresAt, CsiNativeActivationProof.Activation activation) {
        public void requireCurrentTime(Connection connection) throws SQLException {
            long now = JdbcRepositorySupport.databaseNowPrecise(connection).toEpochMilli();
            require(writerExpiresAt > now && activationExpiresAt > now);
        }
    }

    public static NativeHead lockNativeHead(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        NativeHead result = activeNativeHead(connection, original);
        result.requireCurrentTime(connection);
        return result;
    }

    private static NativeHead activeNativeHead(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        try (PreparedStatement statement = statement(connection,
                        "SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION' AND tenant_id = ? AND session_id = ? AND tenant_key = ? AND harness_key = ? AND harness_session_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(
                    statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            statement.setString(
                    3,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            original.request().getScope().getTenantId()));
            statement.setString(
                    4,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            original.request().getIsolationKey()));
            JdbcRepositorySupport.setIdentity(statement, 5, original.request().getIsolationKey());
            try (ResultSet head = statement.executeQuery()) {
                require(head.next() && original.request().getScope().getWorkspaceId().equals(
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        head, "workspace_id"))
                        && "ACTIVE".equals(head.getString("state")) && head.getLong("writer_generation") > 0
                        && head.getInt("storage_version") == 1
                        && head.getLong("compacted_through_revision") == 0
                        && "READY".equals(head.getString("recovery_status")));
                require(ManagedSchemaTime.timestamp(head, "writer_lease_until") != null);
                var history = history(connection, original, head.getLong("journal_revision"),
                        head.getLong("committed_sequence"), head.getString("last_commit_digest"),
                                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows
                                        .identity(head, "writer_id"));
                require(history.activation() != null && head.getLong("activation_epoch") == history.activation().epoch()
                        && history.activation().activationId().equals(
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        head, "activation_id"))
                        && head.getLong("writer_generation") == history.activation().writerGeneration()
                        && com.alibaba.qwen.code.runtimebroker.managedschema
                                        .ManagedSchemaRows.identity(head, "writer_id").equals(history.activation().workerId()));
                var result = new NativeHead(head.getLong("journal_revision"), head.getLong("committed_sequence"),
                        head.getString("last_commit_digest"), history.prefix(),
                        ManagedSchemaTime.timestamp(head, "writer_lease_until").toInstant().toEpochMilli(), history.activation().expiresAt(), history.activation());
                return result;
            }
        }
    }

    private static History history(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long expectedRevision, long expectedSequence, String expectedDigest, String writerId) throws SQLException {
        var history = activeHistoryThrough(connection, original, expectedRevision, expectedSequence, expectedDigest, writerId);
        requireNoJournalTail(connection, original, expectedRevision);
        return history;
    }

    private static History activeHistoryThrough(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long expectedRevision, long expectedSequence, String expectedDigest, String writerId) throws SQLException {
        require(connection != null && !connection.getAutoCommit() && writerId != null && expectedRevision >= 0
                && expectedRevision <= MAX_HISTORY);
        long revision = 0;
        long sequence = 0;
        long byteCount = 0;
        String digest = null;
        String lastUuid = null;
        String firstWriterId = null;
        CsiNativeActivationProof.Genesis genesis = null;
        var prefix = CsiNativeActivationProof.Prefix.empty();
        CsiNativeActivationProof.Activation activation = null;
        while (true) {
            int count = 0;
            try (PreparedStatement statement = statement(connection,
                            "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + " FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision > ? AND journal_revision <= ? ORDER BY journal_revision LIMIT 100 FOR UPDATE")) {
                JdbcRepositorySupport.setIdentity(
                        statement, 1, original.request().getScope().getTenantId());
                JdbcRepositorySupport.setIdentity(
                        statement, 2, original.request().getIsolationKey());
                statement.setLong(3, revision);
                statement.setLong(4, expectedRevision);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        require(revision < MAX_HISTORY && rows.getLong("journal_revision") == revision + 1
                                && original.request().getScope().getWorkspaceId().equals(
                                                        com.alibaba.qwen.code.runtimebroker
                                                                .managedschema.ManagedSchemaRows
                                                                .identity(rows, "workspace_id"))
                                && rows.getLong("writer_generation") > 0
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
                            CsiNativeActivationProof.uuid(
                                    com.alibaba.qwen.code.runtimebroker.managedschema
                                            .ManagedSchemaRows.identity(rows, "writer_id"));
                            firstWriterId =
                                    com.alibaba.qwen.code.runtimebroker.managedschema
                                            .ManagedSchemaRows.identity(rows, "writer_id");
                            genesis = CsiNativeActivationProof.genesis(parsed, original.request(),
                                    ref -> resource(connection, original, ref, rowRevision));
                            lastUuid = genesis.lastRecordUuid();
                        } else {
                            require(rows.getLong("first_sequence") == sequence + 1
                                    && Objects.equals(digest, rows.getString("previous_commit_digest")));
                            if (activation == null) {
                                require(firstWriterId.equals(
                                                        com.alibaba.qwen.code.runtimebroker
                                                                .managedschema.ManagedSchemaRows
                                                                .identity(rows, "writer_id"))
                                        && rows.getLong("writer_generation") == 1);
                            }
                            var transaction = CsiNativeActivationProof.transaction(parsed, metadata,
                                    original.request(), lastUuid);
                            if (CsiNativeActivationProof.hasActivation(transaction)) {
                                if (activation == null) {
                                    require(revision == 1 && Objects.equals(original.firstActivationJournalRevision(), 2L));
                                }
                                activation = CsiNativeActivationProof.activation(transaction, metadata, original.request(),
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        rows, "writer_id"), genesis.definitionDigest(), activation,
                                        ref -> resource(connection, original, ref, rowRevision));
                            } else {
                                prefix = CsiNativeActivationProof.advance(transaction, metadata,
                                        original.request(),
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        rows, "writer_id"), genesis, activation, rowRevision - 1, sequence, prefix,
                                        ref -> resource(connection, original, ref, rowRevision));
                            }
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
                && (activation != null || revision == 0 || writerId.equals(firstWriterId))
                && (activation == null ? original.firstActivationJournalRevision() == null
                        : Objects.equals(original.firstActivationJournalRevision(), 2L)));
        try (PreparedStatement statement = statement(connection,
                        "SELECT latest_checkpoint_resource_id FROM ma_session_head WHERE head_kind"
                            + " = 'MANAGED_SESSION' AND tenant_id = ? AND session_id = ? AND"
                            + " tenant_key = ? AND harness_key = ? AND harness_session_id = ? FOR"
                            + " UPDATE")) {
            JdbcRepositorySupport.setIdentity(
                    statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            statement.setString(
                    3,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            original.request().getScope().getTenantId()));
            statement.setString(
                    4,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            original.request().getIsolationKey()));
            JdbcRepositorySupport.setIdentity(statement, 5, original.request().getIsolationKey());
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && Objects.equals(prefix.checkpointResourceId(),
                                        com.alibaba.qwen.code.runtimebroker.managedschema
                                                .ManagedSchemaRows.identity(
                                                row, "latest_checkpoint_resource_id")));
            }
        }
        return new History(genesis, lastUuid, activation, prefix, revision, sequence, digest);
    }

    private static void requireNoJournalTail(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long revision) throws SQLException {
        try (var statement = statement(connection,
                        "SELECT journal_revision FROM ma_session_journal_tx WHERE tenant_id = ? AND"
                                + " session_id = ? AND journal_revision > ? LIMIT 1 FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(
                    statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            statement.setLong(3, revision);
            try (var row = statement.executeQuery()) {
                require(!row.next());
            }
        }
    }

    private static void noEarlierAuthorization(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        String cursor = "";
        int total = 0;
        while (true) {
            int count = 0;
            try (PreparedStatement statement = statement(connection,
                            "SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns() + " FROM ma_tool_execution WHERE (binding_id = ? OR harness_session_id = ? OR runtime_session_id = ?) AND execution_call_id_hash > ? ORDER BY execution_call_id_hash LIMIT 100 FOR UPDATE")) {
                JdbcRepositorySupport.setIdentity(statement, 1, original.bindingId());
                JdbcRepositorySupport.setIdentity(
                        statement, 2, original.request().getIsolationKey());
                JdbcRepositorySupport.setIdentity(
                        statement, 3, original.request().getIsolationKey());
                statement.setString(4, cursor);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        require(++total <= MAX_HISTORY && original.bindingId().equals(
                                                        com.alibaba.qwen.code.runtimebroker
                                                                .managedschema.ManagedSchemaRows
                                                                .identity(rows, "binding_id"))
                                && rows.getLong("runtime_generation") == 1
                                && original.request().getIsolationKey().equals(
                                                        com.alibaba.qwen.code.runtimebroker
                                                                .managedschema.ManagedSchemaRows
                                                                .identity(
                                                                        rows, "harness_session_id"))
                                && original.request().getIsolationKey().equals(
                                                        com.alibaba.qwen.code.runtimebroker
                                                                .managedschema.ManagedSchemaRows
                                                                .identity(
                                                                        rows, "runtime_session_id"))
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

    static byte[] resource(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JsonNode ref, long revision) {
        try (PreparedStatement statement = statement(connection,
                        "SELECT " + ManagedSchemaProjection.RESOURCE.columns("r") + " FROM ma_resource r JOIN ma_resource_ref x ON r.resource_key = x.resource_key AND r.session_scope_key = x.session_scope_key WHERE r.tenant_id = ? AND r.session_id = ? AND r.resource_id = ? AND x.owner_kind = 'JOURNAL' AND x.owner_key = r.session_scope_key AND x.journal_revision = ? AND x.owner_revision = x.journal_revision AND x.tenant_id = ? AND x.workspace_id = ? AND x.session_id = ? AND r.session_scope_key = ? AND r.resource_key = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(
                    statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            JdbcRepositorySupport.setIdentity(statement, 3, ref.path("resourceId").textValue());
            statement.setLong(4, revision);
            JdbcRepositorySupport.setIdentity(
                    statement, 5, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(
                    statement, 6, original.request().getScope().getWorkspaceId());
            JdbcRepositorySupport.setIdentity(statement, 7, original.request().getIsolationKey());
            JdbcRepositorySupport.setStringParameter(
                    statement,
                    8,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.request().getScope().getTenantId(),
                            original.request().getIsolationKey()));
            statement.setString(
                    9,
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                    original.request().getScope().getTenantId(),
                                    original.request().getIsolationKey()),
                            ref.path("resourceId").textValue()));
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && original.request().getScope().getWorkspaceId().equals(
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(
                                                        row, "workspace_id"))
                        && "REFERENCED".equals(row.getString("state")) && "MYSQL_INLINE".equals(row.getString("storage_kind"))
                        && ref.path("kind").textValue().equals(
                                                com.alibaba.qwen.code.runtimebroker.managedschema
                                                        .ManagedSchemaRows.identity(row, "kind"))
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

    static byte[] frozenResource(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JsonNode ref, long intentSequence) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                        "SELECT journal_revision FROM ma_session_journal_tx WHERE tenant_id = ? AND"
                                + " session_id = ? AND workspace_id = ? AND first_sequence = ? AND"
                                + " last_sequence = ? AND event_count = 1 AND operation ="
                                + " 'commitFileHistory' FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(
                    statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            JdbcRepositorySupport.setIdentity(
                    statement, 3, original.request().getScope().getWorkspaceId());
            statement.setLong(4, intentSequence);
            statement.setLong(5, intentSequence);
            try (ResultSet row = statement.executeQuery()) {
                require(row.next());
                long revision = row.getLong(1);
                require(!row.next());
                return resource(connection, original, ref, revision);
            }
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

    private record History(CsiNativeActivationProof.Genesis genesis, String lastUuid,
            CsiNativeActivationProof.Activation activation, CsiNativeActivationProof.Prefix prefix,
            long revision, long sequence, String digest) {
    }
}
