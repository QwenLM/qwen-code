package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;

import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiFilesProtocol;
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

/** Shared native CSI journal semantics for live admission and read-only historical inspection. */
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
            JdbcCsiApplicationProgress.Continuation progress, NativeHead head) {
    }

    static ContinuationScope lockForContinuation(Connection connection, String bindingId,
            JdbcRuntimeBindingRepository bindings)
            throws SQLException {
        var original = lockOriginal(connection, bindingId);
        if (original != null) {
            original.requireContinuation();
            var progress = JdbcCsiApplicationProgress.lock(connection, original);
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
                if (!row.next() || !CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "capability_digest"))) {
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
            String previousDigest, String writerId, long now, JdbcCsiApplicationProgress.Continuation progress) throws SQLException {
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
            original.requireContinuation();
            String operation = metadata.path("operation").textValue();
            if (java.util.Set.of("submitInput", "toolIntent").contains(operation)) {
                original.requireAdmission();
            }
            require(!first && history.activation().expiresAt() > now
                    && writerId.equals(history.activation().workerId())
                    && metadata.path("writerGeneration").longValue() == history.activation().writerGeneration());
            var next = CsiNativeActivationProof.advance(parsed, metadata, original.request(), writerId,
                    history.genesis(), history.activation(), previousRevision, previousSequence, history.prefix(),
                    ref -> resource(connection, original, ref, previousRevision + 1));
            requireExistingContinuation(original, history.prefix(), next, operation);
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
        } else if ("installActivation".equals(metadata.path("operation").textValue())) {
            qualifyColdTail(connection, original, history);
            require(history.activation().expiresAt() <= now);
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
                            + " record_version = record_version + 1 WHERE binding_id = ? AND request_key = ?"
                            + " AND runtime_generation = 1 AND record_version = ?"
                            + " AND first_activation_journal_revision IS NULL")) {
                statement.setLong(1, previousRevision + 1);
                JdbcRepositorySupport.setIdentity(statement, 2, original.bindingId());
                statement.setString(3, original.request().requestKey());
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
        original.requireContinuation();
        if ("toolIntent".equals(operation)) {
            original.requireAdmission();
        }
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
        requireExistingContinuation(original, history.prefix(), next, operation);
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

    public static CsiNativeActivationProof.TerminalProof terminalPreflight(Connection connection,
            JdbcCsiApplicationRetirement.Authority authority, JsonNode metadata,
            JdbcRuntimeBindingRepository bindings) throws SQLException {
        authority.requirePreCut(connection);
        var original = authority.original();
        var head = lockNativeHead(connection, original);
        var binding = bindings.findByIdForUpdate(connection, original.bindingId());
        require(binding != null && original.request().equals(binding.getRequest())
                && binding.getGeneration() == original.generation() && binding.getVersion() == original.version()
                && binding.getResourceHandle() != null
                && binding.getResourceHandle().getVersion() == WorkspaceCsiRuntimeIdentity.FILES_FINALIZATION_VERSION);
        WorkspaceCsiRuntimeIdentity.boot(binding);
        requireHistoryIdentity(connection, original, head.prefix(), bindings);
        var history = history(connection, original, head.revision(), head.sequence(), head.digest(), head.activation().workerId());
        var proof = CsiNativeActivationProof.preparedTerminal(metadata, original.request(), history.genesis(),
                history.activation(), history.prefix(), head.revision(), head.sequence(), history.lastUuid(), head.digest());
        String resourceId = CsiNativeActivationProof.id(proof.boundaryRef(), "resourceId");
        try (var statement = statement(connection,
                "SELECT resource_id FROM ma_resource WHERE resource_key = ? OR (resource_id = ?"
                        + " AND ((tenant_id = ? AND session_id = ?) OR session_scope_key = ?)) FOR UPDATE")) {
            String scope = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.request().getScope().getTenantId(), original.request().getIsolationKey());
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(scope, resourceId));
            JdbcRepositorySupport.setIdentity(statement, 2, resourceId);
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 4, original.request().getIsolationKey());
            statement.setString(5, scope);
            try (var row = statement.executeQuery()) {
                require(!row.next());
            }
        }
        JdbcCsiExecutionAdmission.verifyReceipts(connection, original, head, history.prefix(), 0, 0);
        long now = authority.requireCurrentTime(connection);
        require(head.writerExpiresAt() > now && head.activationExpiresAt() > now);
        return proof;
    }

    public static void requireCheckpointContinuationRead(Connection connection,
            JdbcCsiFilesRetirementGuard.Original original, JdbcCsiApplicationProgress.Continuation progress,
            String resourceId) throws SQLException {
        require(original.state() == RuntimeBindingRecord.State.DRAINING && original.draining()
                && progress != null && progress.sealedBindingVersion() != null);
        var head = lockNativeHead(connection, original);
        require(head.prefix().input() != null && head.prefix().checkpoint() != null
                && resourceId.equals(head.prefix().checkpointResourceId())
                && head.activation().writerGeneration() == 1 && head.activation().epoch() == 1);
        long now = progress.requireCurrentTime(connection);
        require(head.writerExpiresAt() > now && head.activationExpiresAt() > now);
    }

    private static void requireExistingContinuation(JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix previous, CsiNativeActivationProof.Prefix next, String operation) {
        if (original.state() == RuntimeBindingRecord.State.READY) {
            original.requireAdmission();
            return;
        }
        original.requireContinuation();
        boolean existing = (previous.checkpoint() != null || previous.input() != null)
                && !java.util.Set.of("submitInput", "toolIntent").contains(operation)
                && (next.input() == null || previous.input() != null
                        && previous.input().inputId().equals(next.input().inputId())
                        && previous.input().text().equals(next.input().text()))
                && previous.batches().equals(next.batches()) && previous.intents().equals(next.intents());
        if (previous.fileHistory() == null) {
            existing = existing && next.fileHistory() == null;
        } else {
            existing = existing && next.fileHistory() != null
                    && previous.fileHistory().batches().equals(next.fileHistory().batches());
        }
        if (!existing) {
            original.requireAdmission();
        }
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

    public static void qualifyColdWriter(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcRuntimeBindingRepository bindings, long revision, long sequence, String digest, String writerId,
            long writerGeneration, long activationEpoch, long writerExpiresAt, String successorId) throws SQLException {
        original.requireAdmission();
        var history = history(connection, original, revision, sequence, digest, writerId);
        requireHistoryIdentity(connection, original, history.prefix(), bindings);
        require(history.activation() != null && activationEpoch == history.activation().epoch()
                && writerGeneration >= history.activation().writerGeneration()
                && !successorId.equals(history.activation().workerId())
                && (writerGeneration > history.activation().writerGeneration()
                        || writerId.equals(history.activation().workerId())));
        qualifyColdTail(connection, original, history);
        long now = JdbcRepositorySupport.databaseNowPrecise(connection).toEpochMilli();
        require(writerExpiresAt <= now && history.activation().expiresAt() <= now);
    }

    private static void qualifyColdTail(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            History history) throws SQLException {
        original.requireAdmission();
        var prefix = history.prefix();
        require(history.activation() != null);
        var head = new NativeHead(history.revision(), history.sequence(), history.digest(), prefix,
                0, history.activation().expiresAt(), history.activation());
        if (prefix.attempt() != null && prefix.attempt().finalMessageRef() != null) {
            JdbcCsiExecutionAdmission.verifyColdFinalOutput(connection, original, head);
        } else {
            requireRecoveryTail(connection, original, head);
        }
    }

    static void requireRecoveryTail(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            NativeHead head) throws SQLException {
        var prefix = head.prefix();
        require(prefix.input() != null && prefix.pendingBatch() != null
                && prefix.input().noDeadline()
                && prefix.batches().size() == 1 && prefix.checkpoint() != null && prefix.attempt() != null
                && "output_committed".equals(prefix.attempt().stage())
                && !prefix.assistantCommitted() && prefix.stream() == null
                && java.util.Set.of("await_runtime", "results_ready").contains(
                        prefix.checkpoint().state().path("continuation").path("phase").textValue()));
        JdbcCsiExecutionAdmission.verifyColdReceipts(connection, original, head);
    }

    public record NativeHead(long revision, long sequence, String digest, CsiNativeActivationProof.Prefix prefix,
            long writerExpiresAt, long activationExpiresAt, CsiNativeActivationProof.Activation activation) {
        public void requireCurrentTime(Connection connection) throws SQLException {
            long now = JdbcRepositorySupport.databaseNowPrecise(connection).toEpochMilli();
            require(writerExpiresAt > now && activationExpiresAt > now);
        }

        void requireRecoveryOwner(Map<String, Object> owner) {
            var value = JSON.valueToTree(owner);
            CsiNativeActivationProof.closed(value, java.util.Set.of("writerId", "writerGeneration", "activationId", "activationEpoch"));
            require(activation.workerId().equals(CsiNativeActivationProof.id(value, "writerId"))
                    && activation.writerGeneration() == CsiNativeActivationProof.number(value.get("writerGeneration"))
                    && activation.activationId().equals(CsiNativeActivationProof.id(value, "activationId"))
                    && activation.epoch() == CsiNativeActivationProof.number(value.get("activationEpoch")));
        }
    }

    public static NativeHead lockNativeHead(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        NativeHead result = activeNativeHead(connection, original);
        result.requireCurrentTime(connection);
        return result;
    }

    static void lockRetirementPredecessor(Connection connection, JdbcCsiApplicationRetirement.Authority authority)
            throws SQLException {
        authority.requireConnection(connection);
        require(authority.stage() == JdbcCsiApplicationRetirement.Stage.SETTLING
                || authority.stage() == JdbcCsiApplicationRetirement.Stage.FROZEN);
        activeNativeHead(connection, authority.original());
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
                require(head.next() && original.request().getIsolationKey().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(head, "harness_session_id"))
                        && original.request().getScope().getWorkspaceId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(head, "workspace_id"))
                        && "ACTIVE".equals(head.getString("state")) && head.getLong("writer_generation") > 0
                        && head.getInt("storage_version") == 1
                        && head.getLong("compacted_through_revision") == 0
                        && "READY".equals(head.getString("recovery_status")));
                require(ManagedSchemaTime.timestamp(head, "writer_lease_until") != null);
                var history = history(connection, original, head.getLong("journal_revision"),
                        head.getLong("committed_sequence"), head.getString("last_commit_digest"), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(head, "writer_id"));
                require(history.activation() != null && head.getLong("activation_epoch") == history.activation().epoch()
                        && history.activation().activationId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(head, "activation_id"))
                        && head.getLong("writer_generation") == history.activation().writerGeneration()
                        && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(head, "writer_id").equals(history.activation().workerId()));
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
        return activeHistoryThrough(connection, original, expectedRevision, expectedSequence, expectedDigest, writerId, JournalRead.LIVE);
    }

    private static History activeHistoryThrough(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long expectedRevision, long expectedSequence, String expectedDigest, String writerId, JournalRead read) throws SQLException {
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
            try (PreparedStatement statement = read.statement(connection,
                    "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + " FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                            + " AND journal_revision > ? AND journal_revision <= ? ORDER BY journal_revision LIMIT 100")) {
                JdbcRepositorySupport.setIdentity(statement, 1, original.request().getScope().getTenantId());
                JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
                statement.setLong(3, revision);
                statement.setLong(4, expectedRevision);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        require(revision < MAX_HISTORY && rows.getLong("journal_revision") == revision + 1
                                && original.request().getScope().getWorkspaceId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "workspace_id"))
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
                            CsiNativeActivationProof.uuid(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "writer_id"));
                            firstWriterId = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "writer_id");
                            genesis = CsiNativeActivationProof.genesis(parsed, original.request(),
                                    ref -> resource(connection, original, ref, rowRevision, read));
                            lastUuid = genesis.lastRecordUuid();
                        } else {
                            require(rows.getLong("first_sequence") == sequence + 1
                                    && Objects.equals(digest, rows.getString("previous_commit_digest")));
                            if (activation == null) {
                                require(firstWriterId.equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "writer_id"))
                                        && rows.getLong("writer_generation") == 1);
                            }
                            var transaction = CsiNativeActivationProof.transaction(parsed, metadata,
                                    original.request(), lastUuid);
                            if (CsiNativeActivationProof.hasActivation(transaction)) {
                                if (activation == null) {
                                    require(revision == 1 && Objects.equals(original.firstActivationJournalRevision(), 2L));
                                }
                                activation = CsiNativeActivationProof.activation(transaction, metadata, original.request(),
                                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "writer_id"), genesis.definitionDigest(), activation,
                                        ref -> resource(connection, original, ref, rowRevision, read));
                            } else {
                                prefix = CsiNativeActivationProof.advance(transaction, metadata,
                                        original.request(), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "writer_id"), genesis, activation, rowRevision - 1, sequence, prefix,
                                        ref -> resource(connection, original, ref, rowRevision, read));
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
        try (PreparedStatement statement = read.statement(connection,
                "SELECT latest_checkpoint_resource_id, harness_session_id FROM ma_session_head"
                        + " WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'")) {
            statement.setString(1, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getScope().getTenantId()));
            statement.setString(2, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getIsolationKey()));
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 4, original.request().getIsolationKey());
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && original.request().getIsolationKey().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "harness_session_id"))
                        && Objects.equals(prefix.checkpointResourceId(), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "latest_checkpoint_resource_id")));
            }
        }
        return new History(genesis, lastUuid, activation, prefix, revision, sequence, digest);
    }

    public static CsiNativeActivationProof.TerminalProof terminalHistory(Connection connection,
            JdbcCsiApplicationRetirement.Authority authority) throws SQLException {
        authority.requireConnection(connection);
        require(authority.stage() == JdbcCsiApplicationRetirement.Stage.CUT
                || authority.stage() == JdbcCsiApplicationRetirement.Stage.DRAINED);
        return terminalHistory(connection, authority.original(), authority.frozenBytes(), JournalRead.LIVE);
    }

    public static CsiNativeActivationProof.TerminalProof readHistoricalTerminal(Connection connection,
            RuntimeBindingRecord binding, byte[] frozenBytes) throws SQLException {
        var read = new JournalRead(System.nanoTime());
        read.requireHistorical(connection);
        var original = JdbcCsiFilesRetirementGuard.readHistoricalBinding(connection, binding);
        long ceiling = JdbcCsiRetirementSeal.readHistorical(connection, original, frozenBytes, read);
        var result = terminalHistory(connection, original, frozenBytes, read);
        JdbcCsiExecutionAdmission.verifyHistoricalReceipts(connection, original, result, ceiling, read);
        read.requireHistorical(connection);
        return result;
    }

    private static CsiNativeActivationProof.TerminalProof terminalHistory(Connection connection,
            JdbcCsiFilesRetirementGuard.Original original, byte[] frozenBytes, JournalRead read) throws SQLException {
        JsonNode frozen = JSON.valueToTree(ManagedCsiFilesProtocol.parse(frozenBytes, 32 * 1024 * 1024));
        require(frozen.path("commitBodyBase64").isTextual());
        byte[] body = java.util.Base64.getDecoder().decode(frozen.path("commitBodyBase64").textValue());
        require(java.util.Base64.getEncoder().encodeToString(body).equals(frozen.path("commitBodyBase64").textValue())
                && CsiNativeActivationProof.sha256(body).equals(frozen.path("preparedCommitSha256").textValue()));
        JsonNode metadata = CsiNativeActivationProof.readObject(body);
        long predecessorRevision = CsiNativeActivationProof.number(metadata.get("expectedJournalRevision"));
        long predecessorSequence = CsiNativeActivationProof.number(metadata.get("expectedCommittedSequence"));
        require(predecessorRevision > 1 && predecessorRevision < MAX_HISTORY);
        var predecessor = activeHistoryThrough(connection, original, predecessorRevision, predecessorSequence,
                CsiNativeActivationProof.text(metadata, "previousCommitDigest"), CsiNativeActivationProof.text(metadata, "writerId"), read);
        byte[] raw = java.util.Base64.getDecoder().decode(CsiNativeActivationProof.text(metadata, "recordBytesBase64"));
        CsiNativeActivationProof.TerminalProof proof;
        try (var statement = read.statement(connection,
                "SELECT * FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND journal_revision = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            statement.setLong(3, predecessorRevision + 1);
            try (var row = statement.executeQuery()) {
                require(row.next() && original.request().getScope().getWorkspaceId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_id"))
                        && "identity".equals(row.getString("record_encoding"))
                        && java.util.Arrays.equals(raw, row.getBytes("record_bytes"))
                        && row.getLong("byte_length") == raw.length
                        && CsiNativeActivationProof.sha256(raw).equals(row.getString("record_digest"))
                        && frozen.path("writerTokenSha256").textValue() != null
                        && frozen.path("writerTokenSha256").textValue().equals(row.getString("writer_token_hash")));
                JsonNode saved = metadata(row);
                for (var fields = saved.fieldNames(); fields.hasNext();) {
                    String field = fields.next();
                    require(CsiNativeActivationProof.canonical(saved.path(field))
                            .equals(CsiNativeActivationProof.canonical(metadata.path(field))));
                }
                proof = CsiNativeActivationProof.terminal(CsiNativeActivationProof.records(raw), metadata,
                        original.request(), predecessor.genesis(), predecessor.activation(), predecessor.prefix(),
                        predecessorSequence, predecessor.lastUuid(), predecessor.digest(),
                        ref -> resource(connection, original, ref, predecessorRevision + 1, read));
                require(!row.next());
            }
        }
        requireNoJournalTail(connection, original, predecessorRevision + 1, read);
        try (var statement = read.statement(connection,
                "SELECT * FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'")) {
            statement.setString(1, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getScope().getTenantId()));
            statement.setString(2, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getIsolationKey()));
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 4, original.request().getIsolationKey());
            try (var row = statement.executeQuery()) {
                require(row.next() && "SEALED".equals(row.getString("state"))
                        && row.getLong("journal_revision") == predecessorRevision + 1
                        && row.getLong("committed_sequence") == proof.terminalSequence()
                        && metadata.path("commitDigest").textValue().equals(row.getString("last_commit_digest"))
                        && "released".equals(row.getString("activation_phase"))
                        && row.getLong("activation_head_revision") == predecessorRevision + 1
                        && proof.predecessorActivation().activationId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "activation_id"))
                        && row.getLong("activation_epoch") == 1 && row.getLong("activation_event_epoch") == 1
                        && row.getLong("activation_expires_at") == proof.predecessorActivation().expiresAt()
                        && row.getLong("writer_generation") == 1
                        && proof.predecessorActivation().workerId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "writer_id"))
                        && frozen.path("writerTokenSha256").textValue().equals(row.getString("lease_token_hash")) && !row.next());
            }
        }
        return proof;
    }

    private static void requireNoJournalTail(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long revision) throws SQLException {
        requireNoJournalTail(connection, original, revision, JournalRead.LIVE);
    }

    private static void requireNoJournalTail(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long revision, JournalRead read) throws SQLException {
        try (var statement = read.statement(connection,
                "SELECT journal_revision FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND journal_revision > ? LIMIT 1")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.request().getScope().getTenantId());
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
                    "SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns() + " FROM ma_tool_execution WHERE (binding_id = ? OR harness_session_id = ?"
                            + " OR runtime_session_id = ?) AND execution_call_id_hash > ?"
                            + " ORDER BY execution_call_id_hash LIMIT 100 FOR UPDATE")) {
                JdbcRepositorySupport.setIdentity(statement, 1, original.bindingId());
                JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
                JdbcRepositorySupport.setIdentity(statement, 3, original.request().getIsolationKey());
                statement.setString(4, cursor);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        require(++total <= MAX_HISTORY && original.bindingId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "binding_id"))
                                && rows.getLong("runtime_generation") == 1
                                && original.request().getIsolationKey().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "harness_session_id"))
                                && original.request().getIsolationKey().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "runtime_session_id"))
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
        return resource(connection, original, ref, revision, JournalRead.LIVE);
    }

    static byte[] resource(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JsonNode ref, long revision, JournalRead read) {
        try (PreparedStatement statement = read.statement(connection,
                "SELECT " + ManagedSchemaProjection.RESOURCE.columns("r") + " FROM ma_resource r JOIN ma_resource_ref x"
                        + " ON x.resource_key = r.resource_key AND x.session_scope_key = r.session_scope_key"
                        + " WHERE r.resource_key = ? AND r.session_scope_key = ? AND r.tenant_id = ? AND r.workspace_id = ?"
                        + " AND r.session_id = ? AND r.resource_id = ? AND x.owner_kind = 'JOURNAL'"
                        + " AND x.owner_key = ? AND x.owner_revision = ? AND x.journal_revision = ?"
                        + " AND x.tenant_id = ? AND x.workspace_id = ? AND x.session_id = ? AND x.resource_id = ?"
                        + " AND r.deletion_operation_key IS NULL")) {
            String scope = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(original.request().getScope().getTenantId(), original.request().getIsolationKey());
            String resourceId = ref.path("resourceId").textValue();
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(scope, resourceId));
            statement.setString(2, scope);
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 4, original.request().getScope().getWorkspaceId());
            JdbcRepositorySupport.setIdentity(statement, 5, original.request().getIsolationKey());
            JdbcRepositorySupport.setIdentity(statement, 6, resourceId);
            statement.setString(7, scope);
            statement.setLong(8, revision);
            statement.setLong(9, revision);
            JdbcRepositorySupport.setIdentity(statement, 10, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 11, original.request().getScope().getWorkspaceId());
            JdbcRepositorySupport.setIdentity(statement, 12, original.request().getIsolationKey());
            JdbcRepositorySupport.setIdentity(statement, 13, resourceId);
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && original.request().getScope().getWorkspaceId().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_id"))
                        && "REFERENCED".equals(row.getString("state")) && "MYSQL_INLINE".equals(row.getString("storage_kind"))
                        && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "object_key") == null && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "object_version_id") == null
                        && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "encryption_key_id") == null
                        && ref.path("kind").textValue().equals(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "kind"))
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
        return frozenResource(connection, original, ref, intentSequence, JournalRead.LIVE);
    }

    static byte[] frozenResource(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JsonNode ref, long intentSequence, JournalRead read) throws SQLException {
        try (PreparedStatement statement = read.statement(connection,
                "SELECT journal_revision FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND workspace_id = ? AND first_sequence = ? AND last_sequence = ?"
                        + " AND event_count = 1 AND operation = 'commitFileHistory'")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getWorkspaceId());
            statement.setLong(4, intentSequence);
            statement.setLong(5, intentSequence);
            try (ResultSet row = statement.executeQuery()) {
                require(row.next());
                long revision = row.getLong(1);
                require(!row.next());
                return resource(connection, original, ref, revision, read);
            }
        }
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    record JournalRead(long started) {
        static final JournalRead LIVE = new JournalRead(0);

        void requireHistorical(Connection connection) throws SQLException {
            require(started != 0 && connection != null && !connection.getAutoCommit() && connection.isReadOnly()
                    && connection.getTransactionIsolation() == Connection.TRANSACTION_REPEATABLE_READ
                    && System.nanoTime() - started < java.util.concurrent.TimeUnit.SECONDS.toNanos(10));
        }

        PreparedStatement statement(Connection connection, String sql) throws SQLException {
            if (started == 0) {
                return JdbcCsiActivationAdmission.statement(connection, sql + " FOR UPDATE");
            }
            requireHistorical(connection);
            var result = connection.prepareStatement(sql);
            long remaining = java.util.concurrent.TimeUnit.SECONDS.toNanos(10) - (System.nanoTime() - started);
            if (remaining <= 0) {
                result.close();
                require(false);
            }
            result.setQueryTimeout(Math.toIntExact(Math.max(1, (remaining + 999999999L) / 1000000000L)));
            return result;
        }
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
