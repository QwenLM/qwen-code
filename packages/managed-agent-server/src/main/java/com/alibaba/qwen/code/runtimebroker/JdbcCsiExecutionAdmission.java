package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.provisioning.ManagedContextProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.CsiNativeReadbackProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.canonical;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.id;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.number;

/** Joins an immutable native grant to the original execution, never to a new head. */
public final class JdbcCsiExecutionAdmission {
    private static final ObjectMapper JSON = new ObjectMapper();

    private JdbcCsiExecutionAdmission() {
    }

    static boolean legacyReference(ToolExecutionRecord execution) {
        return execution.getReference().keySet().equals(java.util.Set.of(
                "dispatchMode", "sessionId", "promptId", "callId", "argsDigest"));
    }

    static void verifyRelated(Connection connection, JdbcCsiFilesRetirementGuard.Original original) throws SQLException {
        var head = JdbcCsiActivationAdmission.lockNativeHead(connection, original);
        var members = CsiNativeToolReservation.complete(connection, original, head.prefix(), CsiNativeToolReservation.inventory(connection, original));
        for (var member : members) {
            grant(connection, original, member, head);
        }
        head.requireCurrentTime(connection);
    }

    static void verifyReceipts(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head, CsiNativeActivationProof.Prefix prefix) throws SQLException {
        verifyReceipts(connection, original, head, prefix, 0, 0);
    }

    static void verifyReceipts(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head, CsiNativeActivationProof.Prefix prefix,
            long candidateHistorySequence, long candidateHistoryRevision) throws SQLException {
        receiptMembers(connection, original, head, prefix, false, candidateHistorySequence, candidateHistoryRevision);
        head.requireCurrentTime(connection);
    }

    static void verifyHistoricalReceipts(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.TerminalProof proof, long ceiling, JdbcCsiActivationAdmission.JournalRead read) throws SQLException {
        read.requireHistorical(connection);
        require(ceiling > 0 && ceiling <= original.version());
        var prefix = proof.predecessorPrefix();
        var members = CsiNativeToolReservation.complete(connection, original, prefix,
                CsiNativeToolReservation.inventory(connection, original, read), 0, 0, read);
        long revision;
        try (var statement = read.statement(connection,
                "SELECT journal_revision FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'")) {
            statement.setString(1, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getScope().getTenantId()));
            statement.setString(2, JdbcRuntimeBindingRepository.harnessDrainKey(original.request().getIsolationKey()));
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 4, original.request().getIsolationKey());
            try (var row = statement.executeQuery()) {
                require(row.next());
                revision = Math.subtractExact(row.getLong(1), 1L);
                require(revision > 1 && !row.next());
            }
        }
        for (var member : members) {
            grant(connection, original, member, prefix, revision, ceiling, read);
        }
        verifyReceiptMembers(prefix, members);
        read.requireHistorical(connection);
    }

    static List<ToolExecutionRecord> verifyColdReceipts(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head) throws SQLException {
        var members = receiptMembers(connection, original, head, head.prefix(), true, 0, 0);
        require(!members.isEmpty() && head.prefix().batches().size() == 1);
        var batch = head.prefix().batches().values().iterator().next().batch();
        require(members.stream().map(member -> member.getReference().get("functionCallId"))
                .collect(java.util.stream.Collectors.toSet()).equals(batch.calls().stream()
                        .map(CsiNativeActivationProof.FunctionCall::id)
                        .filter(id -> !batch.refusedFunctionIds().contains(id))
                        .collect(java.util.stream.Collectors.toSet())));
        for (var member : members) {
            require(member.getState() == ToolExecutionRecord.State.SETTLED && !member.isCancelRequested()
                    && member.getResult() != null && member.getAuthorizedDispatchGeneration() != null
                    && java.util.Set.of("success", "error").contains(member.getExecutionStatus()));
            var ref = JSON.valueToTree(member.getReference());
            var call = head.prefix().batches().get(id(ref, "batchId")).batch().calls()
                    .get((int) number(ref.get("ordinal")));
            CsiNativeActivationProof.convertedResult(JSON.valueToTree(member.getResult()), call);
        }
        return members;
    }

    static void verifyColdFinalOutput(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head) throws SQLException {
        var expected = CsiNativeActivationProof.completeOutputTail(head.prefix(), head.sequence());
        var members = verifyColdReceipts(connection, original, head);
        require(members.size() == expected.size()
                && members.stream().map(ToolExecutionRecord::getExecutionCallId)
                        .collect(java.util.stream.Collectors.toSet()).equals(expected));
    }

    private static List<ToolExecutionRecord> receiptMembers(Connection connection,
            JdbcCsiFilesRetirementGuard.Original original, JdbcCsiActivationAdmission.NativeHead head,
            CsiNativeActivationProof.Prefix prefix, boolean recovery,
            long candidateHistorySequence, long candidateHistoryRevision) throws SQLException {
        CsiNativeToolReservation.requireReady(connection, original);
        var members = CsiNativeToolReservation.complete(connection, original, prefix,
                CsiNativeToolReservation.inventory(connection, original), recovery, candidateHistorySequence, candidateHistoryRevision);
        for (var member : members) {
            grant(connection, original, member, head);
        }
        for (var entry : prefix.receipts().entrySet()) {
            var execution = members.stream().filter(member -> entry.getKey().equals(member.getExecutionCallId()))
                    .findFirst().orElseThrow(JdbcCsiExecutionAdmission::unavailable);
            require(execution.getState() == ToolExecutionRecord.State.SETTLED
                    && !execution.isCancelRequested() && execution.getResult() != null
                    && execution.getAuthorizedDispatchGeneration() != null
                    && same(execution.getResult(), map(entry.getValue().body().path("envelope")))
                    && execution.getExecutionStatus().equals(entry.getValue().body().path("envelope").path("executionStatus").textValue()));
        }
        return members;
    }

    private static void verifyReceiptMembers(CsiNativeActivationProof.Prefix prefix, List<ToolExecutionRecord> members) {
        for (var entry : prefix.receipts().entrySet()) {
            var execution = members.stream().filter(member -> entry.getKey().equals(member.getExecutionCallId()))
                    .findFirst().orElseThrow(JdbcCsiExecutionAdmission::unavailable);
            require(execution.getState() == ToolExecutionRecord.State.SETTLED
                    && !execution.isCancelRequested() && execution.getResult() != null
                    && execution.getAuthorizedDispatchGeneration() != null
                    && same(execution.getResult(), map(entry.getValue().body().path("envelope")))
                    && execution.getExecutionStatus().equals(entry.getValue().body().path("envelope").path("executionStatus").textValue()));
        }
    }

    static void requireDispatch(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            ToolExecutionRecord expected) throws SQLException {
        original.requireAdmission();
        var head = JdbcCsiActivationAdmission.lockNativeHead(connection, original);
        CsiNativeToolReservation.requireReady(connection, original);
        var members = CsiNativeToolReservation.complete(connection, original, head.prefix(), CsiNativeToolReservation.inventory(connection, original));
        require(head.prefix().pendingBatch() != null && head.prefix().checkpoint() != null
                && "await_runtime".equals(head.prefix().checkpoint().state().path("continuation").path("phase").textValue()));
        String batch = head.prefix().pendingBatch().messageId();
        require(batch.equals(expected.getReference().get("batchId")));
        var current = members.stream().filter(member -> expected.getExecutionCallId().equals(member.getExecutionCallId()))
                .findFirst().orElseThrow(JdbcCsiExecutionAdmission::unavailable);
        require(current.sameIdentity(expected) && current.sameAuthorization(expected)
                && !current.isCancelRequested() && current.getAuthorizedDispatchGeneration() == null
                && (current.getState() == ToolExecutionRecord.State.PREPARED
                        || current.getState() == ToolExecutionRecord.State.DISPATCHING));
        var batchMembers = members.stream().filter(member -> batch.equals(member.getReference().get("batchId"))).toList();
        require(!batchMembers.isEmpty() && head.prefix().intents().values().stream()
                .filter(intent -> batch.equals(id(intent.payload(), "batchId"))).count() == batchMembers.size());
        for (var member : batchMembers) {
            var intent = head.prefix().intents().get(member.getExecutionCallId());
            require(intent != null);
            preparedRef(head.prefix(), member);
            if (member.getAuthorizedDispatchGeneration() != null) {
                require(!member.isCancelRequested() && (member.getState() == ToolExecutionRecord.State.DISPATCHING
                        || member.getState() == ToolExecutionRecord.State.EXECUTING || member.getState() == ToolExecutionRecord.State.SETTLED));
                grant(connection, original, member, head);
            } else {
                require(!member.isCancelRequested() && (member.getState() == ToolExecutionRecord.State.PREPARED
                        || member.getState() == ToolExecutionRecord.State.DISPATCHING));
            }
        }
        dispatchCheckpoint(connection, original, head, batch);
        head.requireCurrentTime(connection);
    }

    static ToolExecutionRecord authorize(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            RuntimeBindingRecord binding, ToolExecutionRecord expected, String owner, long generation) throws SQLException {
        requireDispatch(connection, original, expected);
        require(binding != null && binding.getVersion() == original.version());
        var head = JdbcCsiActivationAdmission.lockNativeHead(connection, original);
        var checkpoint = dispatchCheckpoint(connection, original, head, (String) expected.getReference().get("batchId"));
        var intent = head.prefix().intents().get(expected.getExecutionCallId());
        var context = context(connection, original, binding);
        var grant = new LinkedHashMap<String, Object>();
        grant.put("protocolVersion", 1);
        grant.put("runtimeBindingId", original.bindingId());
        grant.put("bindingGeneration", Long.toString(original.generation()));
        grant.put("authorizedBindingVersion", Long.toString(original.version()));
        grant.put("executionCallId", expected.getExecutionCallId());
        grant.put("dispatchGeneration", Long.toString(generation));
        grant.put("authorizationRevision", checkpoint.revision());
        grant.put("authorizationSequence", checkpoint.sequence());
        grant.put("executionReference", expected.getReference());
        grant.put("intent", Map.of("revision", intent.revision(), "sequence", intent.sequence()));
        grant.put("checkpointRef", map(checkpoint.ref()));
        grant.put("preparedRef", map(preparedRef(head.prefix(), expected)));
        for (String field : List.of("identity", "context", "installedContext")) {
            grant.put(field, context.get(field));
        }
        head.requireCurrentTime(connection);
        var authorized = JdbcToolExecutionRepository.authorizeDispatch(connection, expected, owner, generation, original.version());
        if (authorized == null) {
            return null;
        }
        try (PreparedStatement statement = connection.prepareStatement(
                "UPDATE ma_tool_execution SET native_authorization_json = ? WHERE execution_call_id_hash = ?"
                        + " AND execution_call_id = ? AND native_authorization_json IS NULL")) {
            statement.setString(1, canonical(JSON.valueToTree(grant)));
            statement.setString(2, JdbcRepositorySupport.valueKey(expected.getExecutionCallId()));
            JdbcRepositorySupport.setIdentity(statement, 3, expected.getExecutionCallId());
            require(statement.executeUpdate() == 1);
        }
        return authorized;
    }

    public static Map<String, Object> readExecution(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head, String executionId, Map<String, Object> expectedContext) throws SQLException {
        CsiNativeToolReservation.requireReady(connection, original);
        var members = CsiNativeToolReservation.complete(connection, original, head.prefix(), CsiNativeToolReservation.inventory(connection, original));
        var execution = members.stream().filter(member -> executionId.equals(member.getExecutionCallId()))
                .findFirst().orElseThrow(JdbcCsiExecutionAdmission::unavailable);
        require(execution.getState() == ToolExecutionRecord.State.EXECUTING && !execution.isCancelRequested()
                && execution.hasLiveDispatchAt(JdbcRepositorySupport.databaseNowPrecise(connection)));
        var grant = grant(connection, original, execution, head);
        require(grant != null);
        for (String field : List.of("identity", "context", "installedContext")) {
            require(same(grant.get(field), expectedContext.get(field)));
        }
        var resources = new java.util.ArrayList<Map<String, Object>>();
        var intent = head.prefix().intents().get(executionId);
        for (String field : List.of("inputRef", "toolDefinitionRef")) {
            JsonNode ref = JSON.valueToTree(execution.getReference().get(field));
            byte[] bytes = JdbcCsiActivationAdmission.resource(connection, original, ref, intent.revision());
            CsiNativeActivationProof.reference(ref, ref.path("kind").textValue(), ignored -> bytes);
            resources.add(Map.of("reference", map(ref), "bytesBase64", Base64.getEncoder().encodeToString(bytes)));
        }
        JsonNode preparedRef = JSON.valueToTree(grant.get("preparedRef"));
        if (!preparedRef.isNull()) {
            var frozen = head.prefix().fileHistory().batches().get((String) execution.getReference().get("batchId"));
            byte[] bytes = JdbcCsiActivationAdmission.frozenResource(connection, original, preparedRef, frozen.preparedSequence());
            CsiNativeActivationProof.reference(preparedRef, "managed-file_history", ignored -> bytes);
            resources.add(Map.of("reference", map(preparedRef), "bytesBase64", Base64.getEncoder().encodeToString(bytes)));
        }
        var evidence = new LinkedHashMap<String, Object>();
        evidence.put("kind", "authorization");
        evidence.put("executionReference", execution.getReference());
        evidence.put("preparedRef", grant.get("preparedRef"));
        evidence.put("authorizationRevision", grant.get("authorizationRevision"));
        evidence.put("authorizationSequence", grant.get("authorizationSequence"));
        evidence.put("grant", grant);
        evidence.put("resources", List.copyOf(resources));
        head.requireCurrentTime(connection);
        return evidence;
    }

    private static Map<String, Object> grant(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            ToolExecutionRecord execution, JdbcCsiActivationAdmission.NativeHead head) throws SQLException {
        return grant(connection, original, execution, head.prefix(), head.revision(), null, JdbcCsiActivationAdmission.JournalRead.LIVE);
    }

    private static Map<String, Object> grant(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            ToolExecutionRecord execution, CsiNativeActivationProof.Prefix prefix, long revision, Long historicalCeiling,
            JdbcCsiActivationAdmission.JournalRead read) throws SQLException {
        String saved;
        try (PreparedStatement statement = read.statement(connection,
                "SELECT execution_call_id, native_authorization_json FROM ma_tool_execution WHERE execution_call_id_hash = ?")) {
            statement.setString(1, JdbcRepositorySupport.valueKey(execution.getExecutionCallId()));
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && execution.getExecutionCallId().equals(row.getString(1)));
                saved = row.getString(2);
                require(!row.next());
            }
        }
        if (execution.getAuthorizedDispatchGeneration() == null) {
            return map(grantHeader(original, execution, prefix, null, saved));
        }
        Long ceiling = read == JdbcCsiActivationAdmission.JournalRead.LIVE
                ? JdbcCsiRetirementSeal.lock(connection, original) : historicalCeiling;
        require(read == JdbcCsiActivationAdmission.JournalRead.LIVE || ceiling != null && ceiling > 0 && ceiling <= original.version());
        var value = grantHeader(original, execution, prefix, ceiling, saved);
        var checkpoint = dispatchCheckpoint(connection, original, revision, (String) execution.getReference().get("batchId"), read);
        var pinned = context(connection, original, null, read);
        return grantTail(execution, prefix, revision, value, checkpoint, pinned);
    }

    /** Validates retained data only; checkpoint uniqueness, member closure and owner reads belong to the caller. */
    public static Map<String, Object> verifyHistoricalGrant(JdbcCsiFilesRetirementGuard.Original original,
            ToolExecutionRecord execution, CsiNativeActivationProof.Prefix prefix, long maximumRevision, long ceiling,
            String saved, DispatchCheckpoint checkpoint, Map<String, Object> pinnedContext) {
        require(original != null && original.request() != null && maximumRevision > 0
                && JdbcCsiFilesRetirementGuard.isProfile(original.request().getScope())
                && ceiling > 0 && ceiling <= original.version());
        var value = grantHeader(original, execution, prefix, ceiling, saved);
        if (value.isNull()) {
            require(checkpoint == null && pinnedContext == null);
            return null;
        }
        return grantTail(execution, prefix, maximumRevision, value, checkpoint, pinnedContext);
    }

    /** Data membership only; complete scoped rows and resource associations must be established by the reader. */
    public static void verifyHistoricalMembers(JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, List<ToolExecutionRecord> members,
            java.util.function.Function<JsonNode, byte[]> resourceReader) {
        CsiNativeToolReservation.verifyHistoricalMembers(original, prefix, members, resourceReader);
        verifyReceiptMembers(prefix, members);
    }

    /** Decodes the caller's already bounded complete row; this method performs no SQL or admission. */
    public static ToolExecutionRecord readHistoricalMember(ResultSet row) throws SQLException {
        var member = JdbcToolExecutionRepository.mapExecution(row);
        JsonNode reference = CsiNativeActivationProof.readObject(CsiNativeActivationProof.utf8(row.getString("reference_json")));
        require(same(reference, member.getReference()));
        String result = row.getString("result_json");
        if (result != null) {
            require(same(CsiNativeActivationProof.readObject(CsiNativeActivationProof.utf8(result)), member.getResult()));
        }
        return member;
    }

    /** Reconstructs grant context data; the caller must separately validate the original handle and installed owner. */
    public static Map<String, Object> historicalGrantContext(RuntimeProvisionRequest original,
            com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding installed, JsonNode handle) {
        require(original != null && installed != null && handle != null && handle.isObject()
                && handle.path("profileIdentity").isObject() && handle.path("context").isObject());
        String session = original.getIsolationKey();
        return Map.of("identity", map(handle.path("profileIdentity")), "context", map(handle.path("context")),
                "installedContext", ManagedContextProtocol.installation(original,
                        java.util.UUID.nameUUIDFromBytes(session.getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString(), session, installed));
    }

    private static JsonNode grantHeader(JdbcCsiFilesRetirementGuard.Original original, ToolExecutionRecord execution,
            CsiNativeActivationProof.Prefix prefix, Long ceiling, String saved) {
        require(original != null && execution != null && prefix != null
                && original.bindingId().equals(execution.getBindingId())
                && original.generation() == execution.getRuntimeGeneration()
                && original.request().getIsolationKey().equals(execution.getHarnessSessionId())
                && original.request().getIsolationKey().equals(execution.getRuntimeSessionId()));
        if (execution.getAuthorizedDispatchGeneration() == null) {
            require(saved == null && execution.getAuthorizedBindingVersion() == null
                    && execution.getState() != ToolExecutionRecord.State.EXECUTING
                    && execution.getState() != ToolExecutionRecord.State.CANCEL_REQUESTED
                    && execution.getState() != ToolExecutionRecord.State.UNKNOWN);
            return JSON.nullNode();
        }
        require(saved != null && execution.getAuthorizedBindingVersion() != null
                && execution.getAuthorizedDispatchGeneration() == execution.getDispatchGeneration()
                && execution.getAuthorizedBindingVersion() > 0 && execution.getAuthorizedBindingVersion() <= original.version());
        require(ceiling == null || execution.wasDispatchAuthorizedBefore(ceiling));
        JsonNode value = CsiNativeActivationProof.readObject(CsiNativeActivationProof.utf8(saved));
        CsiNativeActivationProof.closed(value, java.util.Set.of("protocolVersion", "runtimeBindingId", "bindingGeneration", "authorizedBindingVersion",
                "executionCallId", "dispatchGeneration", "authorizationRevision", "authorizationSequence", "executionReference",
                "intent", "checkpointRef", "preparedRef", "identity", "context", "installedContext"));
        require(number(value.get("protocolVersion")) == 1 && original.bindingId().equals(value.path("runtimeBindingId").textValue())
                && Long.toString(original.generation()).equals(value.path("bindingGeneration").textValue())
                && Long.toString(execution.getAuthorizedBindingVersion()).equals(value.path("authorizedBindingVersion").textValue())
                && execution.getExecutionCallId().equals(value.path("executionCallId").textValue())
                && Long.toString(execution.getDispatchGeneration()).equals(value.path("dispatchGeneration").textValue())
                && same(map(value.path("executionReference")), execution.getReference())
                && canonical(value.path("preparedRef")).equals(canonical(preparedRef(prefix, execution))));
        var intent = prefix.intents().get(execution.getExecutionCallId());
        CsiNativeActivationProof.closed(value.path("intent"), java.util.Set.of("revision", "sequence"));
        require(intent != null && number(value.path("intent").get("revision")) == intent.revision()
                && number(value.path("intent").get("sequence")) == intent.sequence());
        return value;
    }

    private static Map<String, Object> grantTail(ToolExecutionRecord execution, CsiNativeActivationProof.Prefix prefix,
            long maximumRevision, JsonNode value, DispatchCheckpoint checkpoint, Map<String, Object> pinned) {
        require(checkpoint != null && checkpoint.ref() != null && !checkpoint.ref().isNull()
                && maximumRevision > 0 && checkpoint.revision() <= maximumRevision
                && pinned != null && pinned.keySet().equals(java.util.Set.of("identity", "context", "installedContext")));
        var intent = prefix.intents().get(execution.getExecutionCallId());
        require(number(value.get("authorizationRevision")) == checkpoint.revision()
                && number(value.get("authorizationSequence")) == checkpoint.sequence()
                && same(map(value.path("checkpointRef")), map(checkpoint.ref()))
                && intent.revision() < checkpoint.revision() && intent.sequence() < checkpoint.sequence());
        var frozen = prefix.fileHistory() == null ? null
                : prefix.fileHistory().batches().get((String) execution.getReference().get("batchId"));
        require(frozen == null || frozen.preparedSequence() < checkpoint.sequence());
        for (String field : List.of("identity", "context", "installedContext")) {
            require(pinned.get(field) != null && same(value.path(field), JSON.valueToTree(pinned.get(field))));
        }
        return map(value);
    }

    private static JsonNode preparedRef(CsiNativeActivationProof.Prefix prefix, ToolExecutionRecord execution) {
        String batchId = (String) execution.getReference().get("batchId");
        var frozen = prefix.fileHistory() == null ? null : prefix.fileHistory().batches().get(batchId);
        if (frozen == null) {
            var batch = prefix.batches().get(batchId);
            long ordinal = number(JSON.valueToTree(execution.getReference().get("ordinal")));
            require(batch != null && ordinal < batch.batch().calls().size()
                    && "read_file".equals(batch.batch().calls().get((int) ordinal).name()));
            return JSON.nullNode();
        }
        require(frozen.preparedRef() != null && frozen.preparedSequence() > frozen.intentSequence()
                && frozen.invocations().stream().anyMatch(invocation ->
                        execution.getExecutionCallId().equals(id(invocation, "executionCallId"))));
        return frozen.preparedRef();
    }

    /** Data extracted from the unique original dispatch checkpoint; not an admission capability. */
    public record DispatchCheckpoint(long revision, long sequence, JsonNode ref) {
    }

    private static DispatchCheckpoint dispatchCheckpoint(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head, String batchId) throws SQLException {
        return dispatchCheckpoint(connection, original, head.revision(), batchId, JdbcCsiActivationAdmission.JournalRead.LIVE);
    }

    private static DispatchCheckpoint dispatchCheckpoint(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            long maximumRevision, String batchId, JdbcCsiActivationAdmission.JournalRead read) throws SQLException {
        DispatchCheckpoint result = null;
        try (PreparedStatement statement = read.statement(connection,
                "SELECT " + ManagedSchemaProjection.SESSION_JOURNAL_TX.columns() + " FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND workspace_id = ? AND operation = 'commitCheckpoint' ORDER BY journal_revision")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getIsolationKey());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getScope().getWorkspaceId());
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (!com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(rows, "command_id").startsWith("harness:await_runtime:")) {
                        continue;
                    }
                    long revision = rows.getLong("journal_revision");
                    require(revision <= maximumRevision);
                    var record = CsiNativeActivationProof.records(rows.getBytes("record_bytes")).stream()
                            .filter(value -> "system".equals(value.path("type").textValue())
                                    && "managed_session_event_v1".equals(value.path("subtype").textValue())
                                    && "checkpoint.committed".equals(value.path("managedSession").path("kind").textValue()))
                            .findFirst().orElseThrow(JdbcCsiExecutionAdmission::unavailable);
                    JsonNode ref = record.path("managedSession").path("payload").path("stateRef");
                    JsonNode state = CsiNativeActivationProof.readObject(JdbcCsiActivationAdmission.resource(connection, original, ref, revision, read));
                    boolean contains = false;
                    boolean allInProgress = true;
                    for (JsonNode item : state.path("tools").path("items")) {
                        if (batchId.equals(item.path("modelMessageId").textValue())) {
                            contains = true;
                            allInProgress &= "in_progress".equals(item.path("state").textValue());
                        }
                    }
                    if (contains && allInProgress) {
                        require(result == null);
                        result = new DispatchCheckpoint(revision, rows.getLong("last_sequence"), ref);
                    }
                }
            }
        }
        require(result != null);
        return result;
    }

    private static Map<String, Object> context(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            RuntimeBindingRecord binding) throws SQLException {
        return context(connection, original, binding, JdbcCsiActivationAdmission.JournalRead.LIVE);
    }

    private static Map<String, Object> context(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            RuntimeBindingRecord binding, JdbcCsiActivationAdmission.JournalRead read) throws SQLException {
        try (PreparedStatement statement = read.statement(connection,
                "SELECT s.tenant_id, s.workspace_id, s.workspace_generation, s.workspace_storage_id, s.cwd_relative, s.context_config_ref, s.context_revision,"
                        + " b.resource_handle_version, b.resource_handle_json FROM ma_session s JOIN ma_runtime_binding b ON b.binding_id = ?"
                        + " WHERE s.tenant_id = ? AND s.session_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.bindingId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getIsolationKey());
            try (ResultSet row = statement.executeQuery()) {
                require(row.next());
                var installed = new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "tenant_id"), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_id"), row.getLong("workspace_generation"),
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "workspace_storage_id"), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "cwd_relative"), com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.identity(row, "context_config_ref"),
                        row.getLong("context_revision"));
                if (binding == null) {
                    require(row.getInt("resource_handle_version") == WorkspaceCsiRuntimeIdentity.FILES_AUTHORITY_VERSION
                            || row.getInt("resource_handle_version") == WorkspaceCsiRuntimeIdentity.FILES_FINALIZATION_VERSION);
                    var handle = CsiNativeActivationProof.readObject(CsiNativeActivationProof.utf8(row.getString("resource_handle_json")));
                    return historicalGrantContext(original.request(), installed, handle);
                }
                return CsiNativeReadbackProtocol.bindRequest(WorkspaceCsiRuntimeIdentity.boot(binding), original.request(), installed,
                        java.util.UUID.randomUUID().toString());
            }
        }
    }

    private static Map<String, Object> map(JsonNode value) {
        require(value != null && (value.isObject() || value.isNull()));
        if (value.isNull()) {
            return null;
        }
        return JSON.convertValue(value, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
    }

    private static boolean same(Object left, Object right) {
        return Objects.equals(canonical(JSON.valueToTree(left)), canonical(JSON.valueToTree(right)));
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw unavailable();
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_native_execution_unavailable", "Original CSI execution proof is unavailable.", false);
    }
}
