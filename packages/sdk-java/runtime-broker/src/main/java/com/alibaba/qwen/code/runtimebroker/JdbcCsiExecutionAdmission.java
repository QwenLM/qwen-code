package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.canonical;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.id;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.number;

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

/** Joins an immutable native grant to the original execution, never to a new head. */
public final class JdbcCsiExecutionAdmission {
    private static final ObjectMapper JSON = new ObjectMapper();

    private JdbcCsiExecutionAdmission() {
    }

    static boolean legacyReference(ToolExecutionRecord execution) {
        return execution.getReference().keySet().equals(java.util.Set.of(
                "dispatchMode", "sessionId", "promptId", "callId", "argsDigest"));
    }

    static void requireLegacyContinuation(Connection connection, JdbcCsiFilesRetirementGuard.Original original) throws SQLException {
        var head = JdbcCsiActivationAdmission.lockNativeHead(connection, original);
        var prefix = head.prefix();
        require(prefix.batches().isEmpty() && prefix.intents().isEmpty() && prefix.receipts().isEmpty()
                && prefix.fileHistory() == null);
        for (var resource : CsiNativeToolReservation.inventory(connection, original).values()) {
            require(!java.util.Set.of("managed-tool-input", "managed-tool-definition", "managed-tool-outcome", "managed-file_history")
                    .contains(resource.kind()));
        }
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT * FROM qwen_tool_execution WHERE binding_id = ? OR harness_session_id = ? OR runtime_session_id = ?"
                        + " ORDER BY execution_call_id_hash LIMIT 4097 FOR UPDATE")) {
            statement.setQueryTimeout(10);
            statement.setString(1, original.bindingId());
            statement.setString(2, original.request().getIsolationKey());
            statement.setString(3, original.request().getIsolationKey());
            try (ResultSet rows = statement.executeQuery()) {
                int count = 0;
                while (rows.next()) {
                    require(++count <= 4096 && rows.getString("native_authorization_json") == null);
                    var execution = JdbcToolExecutionRepository.mapExecution(rows);
                    JsonNode stored = CsiNativeActivationProof.readObject(CsiNativeActivationProof.utf8(rows.getString("reference_json")));
                    require(legacyReference(execution) && canonical(stored).equals(canonical(JSON.valueToTree(execution.getReference()))));
                    JdbcCsiActivationAdmission.requireExecution(original, execution);
                }
            }
        }
        head.requireCurrentTime(connection);
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
        receiptMembers(connection, original, head, prefix);
        head.requireCurrentTime(connection);
    }

    static List<ToolExecutionRecord> verifyColdReceipts(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head) throws SQLException {
        var members = receiptMembers(connection, original, head, head.prefix(), true);
        require(!members.isEmpty());
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
            CsiNativeActivationProof.Prefix prefix) throws SQLException {
        return receiptMembers(connection, original, head, prefix, false);
    }

    private static List<ToolExecutionRecord> receiptMembers(Connection connection,
            JdbcCsiFilesRetirementGuard.Original original, JdbcCsiActivationAdmission.NativeHead head,
            CsiNativeActivationProof.Prefix prefix, boolean recovery) throws SQLException {
        CsiNativeToolReservation.requireReady(connection, original);
        var members = CsiNativeToolReservation.complete(connection, original, prefix, CsiNativeToolReservation.inventory(connection, original), recovery);
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
                "UPDATE qwen_tool_execution SET native_authorization_json = ? WHERE execution_call_id_hash = ?"
                        + " AND execution_call_id = ? AND native_authorization_json IS NULL")) {
            statement.setString(1, canonical(JSON.valueToTree(grant)));
            statement.setString(2, JdbcRepositorySupport.valueKey(expected.getExecutionCallId()));
            statement.setString(3, expected.getExecutionCallId());
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
        String saved;
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT execution_call_id, native_authorization_json FROM qwen_tool_execution WHERE execution_call_id_hash = ? FOR UPDATE")) {
            statement.setQueryTimeout(10);
            statement.setString(1, JdbcRepositorySupport.valueKey(execution.getExecutionCallId()));
            try (ResultSet row = statement.executeQuery()) {
                require(row.next() && execution.getExecutionCallId().equals(row.getString(1)));
                saved = row.getString(2);
                require(!row.next());
            }
        }
        if (execution.getAuthorizedDispatchGeneration() == null) {
            require(saved == null && execution.getAuthorizedBindingVersion() == null
                    && execution.getState() != ToolExecutionRecord.State.EXECUTING
                    && execution.getState() != ToolExecutionRecord.State.CANCEL_REQUESTED
                    && execution.getState() != ToolExecutionRecord.State.UNKNOWN);
            return null;
        }
        require(saved != null && execution.getAuthorizedBindingVersion() != null
                && execution.getAuthorizedDispatchGeneration() == execution.getDispatchGeneration()
                && execution.getAuthorizedBindingVersion() > 0 && execution.getAuthorizedBindingVersion() <= original.version());
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
                && canonical(value.path("preparedRef")).equals(canonical(preparedRef(head.prefix(), execution))));
        var intent = head.prefix().intents().get(execution.getExecutionCallId());
        CsiNativeActivationProof.closed(value.path("intent"), java.util.Set.of("revision", "sequence"));
        require(intent != null && number(value.path("intent").get("revision")) == intent.revision()
                && number(value.path("intent").get("sequence")) == intent.sequence());
        var checkpoint = dispatchCheckpoint(connection, original, head, (String) execution.getReference().get("batchId"));
        require(number(value.get("authorizationRevision")) == checkpoint.revision()
                && number(value.get("authorizationSequence")) == checkpoint.sequence()
                && same(map(value.path("checkpointRef")), map(checkpoint.ref()))
                && intent.revision() < checkpoint.revision() && intent.sequence() < checkpoint.sequence());
        var pinned = context(connection, original, null);
        for (String field : List.of("identity", "context", "installedContext")) {
            require(same(value.path(field), JSON.valueToTree(pinned.get(field))));
        }
        return map(value);
    }

    private static JsonNode preparedRef(CsiNativeActivationProof.Prefix prefix, ToolExecutionRecord execution) {
        String batchId = (String) execution.getReference().get("batchId");
        var frozen = prefix.fileHistory() == null ? null : prefix.fileHistory().batches().get(batchId);
        if (frozen == null) {
            require("read_file".equals(prefix.batches().get(batchId).batch().calls()
                    .get(((Number) execution.getReference().get("ordinal")).intValue()).name()));
            return JSON.nullNode();
        }
        require(frozen.preparedRef() != null && frozen.preparedSequence() > frozen.intentSequence()
                && frozen.invocations().stream().anyMatch(invocation ->
                        execution.getExecutionCallId().equals(id(invocation, "executionCallId"))));
        return frozen.preparedRef();
    }

    private record DispatchCheckpoint(long revision, long sequence, JsonNode ref) {
    }

    private static DispatchCheckpoint dispatchCheckpoint(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiActivationAdmission.NativeHead head, String batchId) throws SQLException {
        DispatchCheckpoint result = null;
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT * FROM qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND workspace_id = ? AND operation = 'commitCheckpoint' ORDER BY journal_revision FOR UPDATE")) {
            statement.setQueryTimeout(10);
            statement.setString(1, original.request().getScope().getTenantId());
            statement.setString(2, original.request().getIsolationKey());
            statement.setString(3, original.request().getScope().getWorkspaceId());
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (!rows.getString("command_id").startsWith("harness:await_runtime:")) {
                        continue;
                    }
                    long revision = rows.getLong("journal_revision");
                    require(revision <= head.revision());
                    var record = CsiNativeActivationProof.records(rows.getBytes("record_bytes")).stream()
                            .filter(value -> "system".equals(value.path("type").textValue())
                                    && "managed_session_event_v1".equals(value.path("subtype").textValue())
                                    && "checkpoint.committed".equals(value.path("managedSession").path("kind").textValue()))
                            .findFirst().orElseThrow(JdbcCsiExecutionAdmission::unavailable);
                    JsonNode ref = record.path("managedSession").path("payload").path("stateRef");
                    JsonNode state = CsiNativeActivationProof.readObject(JdbcCsiActivationAdmission.resource(connection, original, ref, revision));
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
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT s.tenant_id, s.workspace_id, s.workspace_generation, s.workspace_storage_id, s.cwd_relative, s.context_config_ref, s.context_revision,"
                        + " b.resource_handle_version, b.resource_handle_json FROM managed_agent_session s JOIN qwen_runtime_binding b ON b.binding_id = ?"
                        + " WHERE s.tenant_id = ? AND s.session_id = ? FOR UPDATE")) {
            statement.setQueryTimeout(10);
            statement.setString(1, original.bindingId());
            statement.setString(2, original.request().getScope().getTenantId());
            statement.setString(3, original.request().getIsolationKey());
            try (ResultSet row = statement.executeQuery()) {
                require(row.next());
                var installed = new com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding(
                        row.getString("tenant_id"), row.getString("workspace_id"), row.getLong("workspace_generation"),
                        row.getString("workspace_storage_id"), row.getString("cwd_relative"), row.getString("context_config_ref"),
                        row.getLong("context_revision"));
                if (binding == null) {
                    require(row.getInt("resource_handle_version") == WorkspaceCsiRuntimeIdentity.FILES_AUTHORITY_VERSION);
                    var handle = CsiNativeActivationProof.readObject(CsiNativeActivationProof.utf8(row.getString("resource_handle_json")));
                    return Map.of("identity", map(handle.path("profileIdentity")), "context", map(handle.path("context")),
                            "installedContext", ManagedContextProtocol.installation(original.request(),
                                    java.util.UUID.nameUUIDFromBytes(original.request().getIsolationKey().getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString(),
                                    original.request().getIsolationKey(), installed));
                }
                return CsiNativeReadbackProtocol.bindRequest(WorkspaceCsiRuntimeIdentity.boot(binding), original.request(), installed,
                        java.util.UUID.randomUUID().toString());
            }
        }
    }

    private static Map<String, Object> map(JsonNode value) {
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
