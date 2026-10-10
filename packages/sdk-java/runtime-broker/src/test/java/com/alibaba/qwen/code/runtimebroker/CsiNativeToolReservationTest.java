package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Instant;
import java.util.List;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/** Tuple-validation units only; the supplied prefix does not prove native SQL admission. */
class CsiNativeToolReservationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION = "550e8400-e29b-41d4-a716-446655440001";
    private static final String PROMPT = "550e8400-e29b-41d4-a716-446655440002";
    private static final String BATCH = "550e8400-e29b-41d4-a716-446655440003";
    private final RuntimeProvisionRequest request = CsiFilesRetirementProfile.request(new ContextBinding(
            "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", SESSION);
    private final JdbcCsiFilesRetirementGuard.Original original = new JdbcCsiFilesRetirementGuard.Original(request,
            "binding", 1, RuntimeBindingRecord.State.READY, false, 1, 2L);

    @Test
    void recoveryStoredBytesAreBoundedBeforeParsingAndRejectAmbiguousJson() {
        String exact = "{\"text\":\"" + "x".repeat(65525) + "\"}";
        assertEquals(65536, CsiNativeToolReservation.recoveryBytes(exact).length);
        for (String value : new String[] {exact + " ", "{} {}", "{\"x\":1,\"x\":1}", "", "{\"x\":\"\ud800\"}"}) {
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.recoveryBytes(value));
        }
        assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.recoveryBytes(null));
    }

    @Test
    void recoveryOwnerMatchesTheInstalledActivationRatherThanTheOldCheckpoint() {
        var activation = new CsiNativeActivationProof.Activation(SESSION, PROMPT, JSON.createObjectNode(), 60000,
                Long.MAX_VALUE, 0, 2, 3);
        var head = new JdbcCsiActivationAdmission.NativeHead(1, 1, "digest", CsiNativeActivationProof.Prefix.empty(),
                Long.MAX_VALUE, Long.MAX_VALUE, activation);
        Map<String, Object> owner = Map.of("writerId", PROMPT, "writerGeneration", 3, "activationId", SESSION, "activationEpoch", 2);
        assertDoesNotThrow(() -> head.requireRecoveryOwner(owner));
        for (String field : owner.keySet()) {
            var changed = new HashMap<>(owner);
            changed.put(field, field.endsWith("Id") ? BATCH : 1);
            assertThrows(RuntimeException.class, () -> head.requireRecoveryOwner(changed));
            changed.remove(field);
            assertThrows(RuntimeException.class, () -> head.requireRecoveryOwner(changed));
        }
        var extra = new HashMap<>(owner);
        extra.put("checkpointId", BATCH);
        assertThrows(RuntimeException.class, () -> head.requireRecoveryOwner(extra));
    }

    @Test
    void tupleValidationRetainsObservedNonUuidFunctionIdsAndFullPartPositions() throws Exception {
        JsonNode parts = capturedParts();
        var prefix = prefix(parts);
        assertEquals(5, parts.size());
        for (int index = 0; index < 3; index++) {
            var tuple = tuple(prefix, index);
            assertDoesNotThrow(() -> CsiNativeToolReservation.qualify(original, prefix, tuple.execution(), tuple.input(), tuple.definition()));
            assertEquals(index + 2, tuple.execution().getReference().get("partIndex"));
            assertEquals("owned-provider-nonuuid-" + index, tuple.execution().getReference().get("functionCallId"));
        }
    }

    @Test
    void refusesChangedPartFunctionOrdinalOwnerAndDefinitionWithMatchingMetadata() throws Exception {
        var prefix = prefix(capturedParts());
        var tuple = tuple(prefix, 0);
        for (String field : new String[] {"functionCallId", "batchId", "partIndex", "ordinal", "sessionId", "promptId"}) {
            Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
            ref.put(field, field.equals("partIndex") || field.equals("ordinal") ? 7 : UUID.randomUUID().toString());
            rejects(prefix, copy(tuple.execution(), ref), tuple.input(), tuple.definition());
        }
        ObjectNode definition = (ObjectNode) JSON.readTree(tuple.definition());
        ((ObjectNode) definition.path("parametersJsonSchema")).put("additionalProperties", true);
        byte[] changed = JSON.writeValueAsBytes(definition);
        Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
        ref.put("toolDefinitionRef", ref("managed-tool-definition", changed));
        rejects(prefix, copy(tuple.execution(), ref), tuple.input(), changed);
    }

    @Test
    void requiresRawPayloadDigestRatherThanReserializedJsonOrWrapperDigest() throws Exception {
        var prefix = prefix(capturedParts());
        var tuple = tuple(prefix, 0);
        ObjectNode wrapper = (ObjectNode) JSON.readTree(tuple.input());
        String payload = wrapper.path("payloadJson").textValue();
        wrapper.put("payloadJson", " \n" + payload);
        byte[] changed = JSON.writeValueAsBytes(wrapper);
        Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
        ref.put("inputRef", ref("managed-tool-input", changed));
        rejects(prefix, copy(tuple.execution(), ref), changed, tuple.definition());
        String digest = "sha256:" + CsiNativeActivationProof.sha256((" \n" + payload).getBytes(StandardCharsets.UTF_8));
        ref.put("argsDigest", digest);
        ToolExecutionRecord exact = copy(tuple.execution(), ref);
        assertDoesNotThrow(() -> CsiNativeToolReservation.qualify(original, prefix, exact, changed, tuple.definition()));
        ref.put("argsDigest", "sha256:" + CsiNativeActivationProof.sha256(changed));
        rejects(prefix, copy(tuple.execution(), ref), changed, tuple.definition());
    }

    @Test
    void normalizesOriginalEcmascriptWhitespaceAndLexicalPathButRejectsTraversalAndExtraArgs() throws Exception {
        JsonNode parts = capturedParts();
        ((ObjectNode) parts.get(2).path("functionCall").path("args")).put("file_path", "\ufeff ./dir//marker.txt \u00a0");
        var prefix = prefix(parts);
        var tuple = tuple(prefix, 0);
        ObjectNode wrapper = (ObjectNode) JSON.readTree(tuple.input());
        ObjectNode payload = (ObjectNode) JSON.readTree(wrapper.path("payloadJson").textValue());
        ((ObjectNode) payload.path("input")).put("file_path", "dir/marker.txt");
        wrapper.put("payloadJson", JSON.writeValueAsString(payload));
        byte[] bytes = JSON.writeValueAsBytes(wrapper);
        Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
        ref.put("inputRef", ref("managed-tool-input", bytes));
        ref.put("argsDigest", "sha256:" + CsiNativeActivationProof.sha256(wrapper.path("payloadJson").textValue().getBytes(StandardCharsets.UTF_8)));
        ToolExecutionRecord normalized = copy(tuple.execution(), ref);
        assertDoesNotThrow(() -> CsiNativeToolReservation.qualify(original, prefix, normalized, bytes, tuple.definition()));
        for (String path : new String[] {"../outside", "/outside", "./C:outside", "dir\\file"}) {
            ((ObjectNode) prefix.pendingBatch().calls().getFirst().args()).put("file_path", path);
            rejects(prefix, normalized, bytes, tuple.definition());
        }
        ((ObjectNode) prefix.pendingBatch().calls().getFirst().args()).put("file_path", "dir/marker.txt").put("foreign", true);
        rejects(prefix, normalized, bytes, tuple.definition());
    }

    @Test
    void refusesMissingPendingBatchDuplicateJsonTrailingBytesAndInlineHashMismatch() throws Exception {
        var prefix = prefix(capturedParts());
        var tuple = tuple(prefix, 0);
        rejects(CsiNativeActivationProof.Prefix.empty(), tuple.execution(), tuple.input(), tuple.definition());
        byte[] changed = tuple.input().clone();
        changed[0] = (byte) 0xff;
        rejects(prefix, tuple.execution(), changed, tuple.definition());
        for (String text : new String[] {"{} {}", "{\"input\":{},\"input\":{}}"}) {
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            Map<String, Object> ref = new HashMap<>(tuple.execution().getReference());
            ref.put("inputRef", ref("managed-tool-input", bytes));
            rejects(prefix, copy(tuple.execution(), ref), bytes, tuple.definition());
        }
    }

    @Test
    void qualifiesHistoricalRowsAgainstTheirOwnAssistantAndPrompt() throws Exception {
        var first = prefix(capturedParts());
        var prior = tuple(first, 0);
        var next = prefix(capturedParts(), UUID.randomUUID().toString(), UUID.randomUUID().toString());
        var batches = new HashMap<>(first.batches());
        batches.putAll(next.batches());
        var combined = new CsiNativeActivationProof.Prefix(next.input(), next.checkpoint(), next.lastMessageId(),
                next.attempt(), next.assistantCommitted(), next.stream(), next.usedIds(), next.pendingBatch(), batches, next.fileHistory(), Map.of(), Map.of(), next.nextDeltaOrdinal());
        var current = tuple(combined, 0);
        assertEquals(prior.execution().getReference().get("functionCallId"), current.execution().getReference().get("functionCallId"));
        assertDoesNotThrow(() -> CsiNativeToolReservation.qualifyRelated(original, combined,
                prior.execution(), prior.input(), prior.definition()));
        assertDoesNotThrow(() -> CsiNativeToolReservation.qualify(original, combined,
                current.execution(), current.input(), current.definition()));
        rejects(combined, prior.execution(), prior.input(), prior.definition());
        Map<String, Object> changed = new HashMap<>(prior.execution().getReference());
        changed.put("promptId", next.input().inputId());
        assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.qualifyRelated(original, combined,
                copy(prior.execution(), changed), prior.input(), prior.definition()));
        changed.put("batchId", UUID.randomUUID().toString());
        assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.qualifyRelated(original, combined,
                copy(prior.execution(), changed), prior.input(), prior.definition()));
    }

    @Test
    void unrelatedNativeAssistantCannotQualifyAStoredFunctionOrPart() throws Exception {
        var first = prefix(capturedParts());
        var tuple = tuple(first, 0);
        JsonNode changedParts = capturedParts();
        ((ObjectNode) changedParts.get(2).path("functionCall")).put("id", "another-native-function");
        var changed = prefix(changedParts);
        assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.qualifyRelated(original, changed,
                tuple.execution(), tuple.input(), tuple.definition()));
    }

    @Test
    void currentReadChecksHistoricalUnknownRowsBeforeReturningOnlyCurrentMembers() throws Exception {
        try (Connection connection = connection()) {
            var first = prefix(capturedParts());
            var prior = tuple(first, 0);
            prepare(connection, first, prior);
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("UPDATE qwen_tool_execution SET execution_state = 'UNKNOWN'");
            }
            var next = prefix(capturedParts(), UUID.randomUUID().toString(), UUID.randomUUID().toString());
            var batches = new HashMap<>(first.batches());
            batches.putAll(next.batches());
            var combined = new CsiNativeActivationProof.Prefix(next.input(), null, next.lastMessageId(), null,
                    false, null, Set.of(), next.pendingBatch(), batches, next.fileHistory(), Map.of(), Map.of(), next.nextDeltaOrdinal());
            for (int index = 0; index < 3; index++) {
                prepare(connection, combined, tuple(combined, index));
            }
            var inventory = CsiNativeToolReservation.inventory(connection, original);
            assertEquals(4, CsiNativeToolReservation.complete(connection, original, combined, inventory).size());
            var result = CsiNativeToolReservation.read(connection, original, combined, inventory,
                    combined.input().inputId(), combined.pendingBatch().messageId());
            var members = (List<?>) result.get("members");
            assertEquals(3, members.size());
            for (int index = 0; index < members.size(); index++) {
                var member = (Map<?, ?>) members.get(index);
                var ref = (Map<?, ?>) member.get("reference");
                assertEquals(combined.pendingBatch().messageId(), ref.get("batchId"));
                assertEquals(index, ((Number) ref.get("ordinal")).intValue());
            }
            try (var statement = connection.prepareStatement("UPDATE qwen_tool_execution SET runtime_session_id = ?, runtime_session_key = ?"
                    + " WHERE execution_call_id = ?")) {
                statement.setString(1, "foreign-session");
                statement.setString(2, JdbcRepositorySupport.valueKey("foreign-session"));
                statement.setString(3, prior.execution().getExecutionCallId());
                statement.executeUpdate();
            }
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.read(connection, original, combined,
                    inventory, combined.input().inputId(), combined.pendingBatch().messageId()));
        }
    }

    @Test
    void completeReadCrossesStableExecutionPagesWithoutDroppingMembers() throws Exception {
        var parts = JSON.createArrayNode();
        JsonNode originalRead = capturedParts().get(2);
        for (int index = 0; index < 101; index++) {
            ObjectNode part = originalRead.deepCopy();
            ((ObjectNode) part.path("functionCall")).put("id", "page-function-" + index);
            parts.add(part);
        }
        var prefix = prefix(parts);
        try (Connection connection = connection()) {
            for (int index = 0; index < 101; index++) {
                prepare(connection, prefix, tuple(prefix, index));
            }
            var inventory = CsiNativeToolReservation.inventory(connection, original);
            assertEquals(202, inventory.size());
            var result = CsiNativeToolReservation.read(connection, original, prefix, inventory, PROMPT, BATCH);
            assertEquals(101, ((List<?>) result.get("members")).size());
        }
    }

    @Test
    void historyPreflightRequiresEveryOriginalRowIncludingReadBeforePromoting() throws Exception {
        var prefix = prefix(capturedParts());
        var tuples = new ArrayList<Tuple>();
        try (Connection connection = connection()) {
            originalSession(connection);
            for (int index = 0; index < 3; index++) {
                var tuple = tuple(prefix, index);
                tuples.add(tuple);
                prepare(connection, prefix, tuple);
            }
            var inventory = CsiNativeToolReservation.inventory(connection, original);
            var omittedRead = frozen(prefix, tuples.subList(1, 3));
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.preflightHistory(
                    connection, original, prefix, omittedRead, inventory));
            assertEquals(6, published(connection));
            CsiNativeToolReservation.preflightHistory(connection, original, prefix, frozen(prefix, tuples), inventory);
            assertEquals(0, published(connection));
            try (var statement = connection.createStatement();
                    var rows = statement.executeQuery("SELECT resource_id, publish_command_id, state FROM qwen_managed_session_resource")) {
                while (rows.next()) {
                    assertEquals(rows.getString("resource_id"), rows.getString("publish_command_id"));
                    assertEquals("REFERENCED", rows.getString("state"));
                }
            }
        }
    }

    @Test
    void referencedMembersNeedTheUniqueOriginalIntentAssociationAndCannotDisappear() throws Exception {
        var prefix = prefix(capturedParts());
        var tuples = new ArrayList<Tuple>();
        try (Connection connection = connection()) {
            originalSession(connection);
            for (int index = 0; index < 3; index++) {
                var tuple = tuple(prefix, index);
                tuples.add(tuple);
                prepare(connection, prefix, tuple);
            }
            var frozen = frozen(prefix, tuples);
            CsiNativeToolReservation.preflightHistory(connection, original, prefix, frozen,
                    CsiNativeToolReservation.inventory(connection, original));
            associationTables(connection);
            var inventory = CsiNativeToolReservation.inventory(connection, original);
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original, frozen, inventory));
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("INSERT INTO qwen_managed_session_journal_tx VALUES ('tenant','workspace','" + SESSION
                        + "',99,15,15,1,'commitFileHistory')");
                statement.executeUpdate("INSERT INTO qwen_managed_session_resource_ref SELECT session_scope_key, tenant_id, workspace_id, session_id, resource_id, 99 FROM qwen_managed_session_resource");
            }
            assertEquals(3, CsiNativeToolReservation.complete(connection, original, frozen, inventory).size());
            var retry = tuples.getFirst();
            assertEquals(retry.execution().getExecutionCallId(), CsiNativeToolReservation.prepare(connection, original, frozen,
                    inventory, retry.execution(), retry.input(), retry.definition()).getExecutionCallId());
            assertThrows(RuntimeException.class, () -> prepare(connection, frozen, tuple(frozen, 0)));
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("UPDATE qwen_managed_session_resource_ref SET journal_revision = 100");
            }
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original, frozen, inventory));
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("UPDATE qwen_managed_session_resource_ref SET journal_revision = 99");
                statement.executeUpdate("INSERT INTO qwen_managed_session_journal_tx VALUES ('tenant','workspace','" + SESSION
                        + "',100,15,15,1,'commitFileHistory')");
            }
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original, frozen, inventory));
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("DELETE FROM qwen_managed_session_journal_tx WHERE journal_revision = 100");
                statement.executeUpdate("DELETE FROM qwen_tool_execution");
            }
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original, frozen, inventory));
        }
    }

    @Test
    void candidateHistoryMembersNeedTheirExactSameTransactionResourceAssociation() throws Exception {
        var prefix = prefix(capturedParts());
        var tuples = new ArrayList<Tuple>();
        try (Connection connection = connection()) {
            originalSession(connection);
            for (int index = 0; index < 3; index++) {
                var tuple = tuple(prefix, index);
                tuples.add(tuple);
                prepare(connection, prefix, tuple);
            }
            var frozen = frozen(prefix, tuples);
            CsiNativeToolReservation.preflightHistory(connection, original, prefix, frozen,
                    CsiNativeToolReservation.inventory(connection, original));
            associationTables(connection);
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("INSERT INTO qwen_managed_session_resource_ref SELECT session_scope_key, tenant_id, workspace_id, session_id, resource_id, 99 FROM qwen_managed_session_resource");
            }
            var inventory = CsiNativeToolReservation.inventory(connection, original);
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original, frozen, inventory));
            assertEquals(3, CsiNativeToolReservation.complete(connection, original, frozen, inventory, false, 15, 99).size());
            for (long[] candidate : new long[][] {{16, 99}, {15, 100}, {0, 99}, {15, 0}, {-1, 99}}) {
                assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original,
                        frozen, inventory, false, candidate[0], candidate[1]));
            }
            try (var statement = connection.createStatement();
                    var row = statement.executeQuery("SELECT COUNT(*) FROM qwen_managed_session_journal_tx")) {
                row.next();
                assertEquals(0, row.getInt(1));
            }
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("UPDATE qwen_managed_session_resource_ref SET workspace_id = 'foreign'");
            }
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original,
                    frozen, inventory, false, 15, 99));
        }
    }

    @Test
    void readonlyIntentPromotesOnlyEnteredResourcesAndKeepsExactRetryWithoutLateAllocation() throws Exception {
        var parts = capturedParts();
        ((ObjectNode) parts.get(3).path("functionCall")).put("name", "read_file")
                .set("args", parts.get(2).path("functionCall").path("args"));
        var prefix = prefix(parts);
        var first = tuple(prefix, 0);
        var second = tuple(prefix, 1);
        try (Connection connection = connection()) {
            originalSession(connection);
            prepare(connection, prefix, first);
            prepare(connection, prefix, second);
            var entered = entered(prefix, first, 99, 20);
            CsiNativeToolReservation.preflightNative(connection, original, prefix, entered,
                    CsiNativeToolReservation.inventory(connection, original), "toolIntent");
            assertEquals(2, published(connection));
            associationTables(connection);
            var inventory = CsiNativeToolReservation.inventory(connection, original);
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original, entered, inventory));
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("INSERT INTO qwen_managed_session_resource_ref SELECT session_scope_key, tenant_id, workspace_id, session_id, resource_id, 99 FROM qwen_managed_session_resource WHERE state = 'REFERENCED'");
            }
            assertEquals(2, CsiNativeToolReservation.complete(connection, original, entered, inventory).size());
            assertEquals(first.execution().getExecutionCallId(), CsiNativeToolReservation.prepare(connection, original,
                    entered, inventory, first.execution(), first.input(), first.definition()).getExecutionCallId());
            assertThrows(RuntimeException.class, () -> prepare(connection, entered, tuple(entered, 2)));
            var all = CsiNativeToolReservation.complete(connection, original, entered, inventory);
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.qualifyNativeBatch(entered, all, true));
            try (var statement = connection.createStatement()) {
                statement.executeUpdate("UPDATE qwen_managed_session_resource_ref SET journal_revision = 100");
            }
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.complete(connection, original, entered, inventory));
        }
    }

    @Test
    void readonlyFreezeRefusesSharedResourcesOrMixedMutationBeforeAnyPromotion() throws Exception {
        var parts = capturedParts();
        ((ObjectNode) parts.get(3).path("functionCall")).put("name", "read_file")
                .set("args", parts.get(2).path("functionCall").path("args"));
        var prefix = prefix(parts);
        var first = tuple(prefix, 0);
        var second = tuple(prefix, 1);
        Map<String, Object> shared = new HashMap<>(second.execution().getReference());
        for (String field : List.of("inputRef", "toolDefinitionRef", "argsDigest")) {
            shared.put(field, first.execution().getReference().get(field));
        }
        var reused = new Tuple(copy(second.execution(), shared), first.input(), first.definition());
        try (Connection connection = connection()) {
            originalSession(connection);
            prepare(connection, prefix, first);
            prepare(connection, prefix, reused);
            var entered = entered(prefix, first, 99, 20);
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.preflightNative(connection, original,
                    prefix, entered, CsiNativeToolReservation.inventory(connection, original), "toolIntent"));
            assertEquals(2, published(connection));
        }
        var mixed = prefix(capturedParts());
        var read = tuple(mixed, 0);
        var write = tuple(mixed, 1);
        try (Connection connection = connection()) {
            originalSession(connection);
            prepare(connection, mixed, read);
            prepare(connection, mixed, write);
            var entered = entered(mixed, read, 99, 20);
            assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.preflightNative(connection, original,
                    mixed, entered, CsiNativeToolReservation.inventory(connection, original), "toolIntent"));
            assertEquals(4, published(connection));
        }
    }

    private static CsiNativeActivationProof.Prefix entered(CsiNativeActivationProof.Prefix prefix, Tuple tuple,
            long revision, long sequence) {
        JsonNode ref = JSON.valueToTree(tuple.execution().getReference());
        ObjectNode payload = JSON.createObjectNode().put("executionCallId", tuple.execution().getExecutionCallId())
                .put("batchId", ref.path("batchId").textValue()).put("ordinal", ref.path("ordinal").longValue())
                .put("outcomeSource", "runtime");
        payload.set("argsRef", ref.path("inputRef"));
        payload.set("toolDefinitionRef", ref.path("toolDefinitionRef"));
        var intents = new HashMap<>(prefix.intents());
        intents.put(tuple.execution().getExecutionCallId(), new CsiNativeActivationProof.ToolIntent(payload, revision, sequence,
                tuple.execution().getRequestDigest().substring(7)));
        return new CsiNativeActivationProof.Prefix(prefix.input(), prefix.checkpoint(), prefix.lastMessageId(), prefix.attempt(),
                prefix.assistantCommitted(), prefix.stream(), prefix.usedIds(), prefix.pendingBatch(), prefix.batches(),
                prefix.fileHistory(), intents, prefix.receipts(), prefix.nextDeltaOrdinal());
    }

    private void originalSession(Connection connection) throws Exception {
        JdbcRuntimeSessionRepository.insertSession(connection, new RuntimeSessionRecord(
                new RuntimeSession(SESSION, SESSION, "bootstrap", request.getScope()), "binding", 1,
                RuntimeSessionRecord.State.READY, 1, Instant.now()));
    }

    private static int published(Connection connection) throws Exception {
        try (var statement = connection.createStatement();
                var row = statement.executeQuery("SELECT COUNT(*) FROM qwen_managed_session_resource WHERE state = 'PUBLISHED'")) {
            row.next();
            return row.getInt(1);
        }
    }

    private static CsiNativeActivationProof.Prefix frozen(CsiNativeActivationProof.Prefix prefix, List<Tuple> tuples) {
        var preparation = JSON.createObjectNode().put("stage", "intent").put("promptId", PROMPT).put("batchId", BATCH);
        var invocations = preparation.putArray("invocations");
        for (Tuple tuple : tuples) {
            var reference = JSON.valueToTree(tuple.execution().getReference());
            var invocation = invocations.addObject().put("executionCallId", tuple.execution().getExecutionCallId())
                    .put("requestDigest", tuple.execution().getRequestDigest());
            for (String field : List.of("callId", "functionCallId", "partIndex", "ordinal", "inputRef", "toolDefinitionRef"))
                invocation.set(field, reference.get(field));
        }
        JsonNode ref = JSON.valueToTree(ref("managed-file_history", "{}".getBytes(StandardCharsets.UTF_8)));
        var batch = new CsiNativeActivationProof.FrozenBatch(ref, null,
                new ArrayList<>(JSON.convertValue(invocations, new com.fasterxml.jackson.core.type.TypeReference<List<JsonNode>>() {})), 15, 0);
        return new CsiNativeActivationProof.Prefix(prefix.input(), prefix.checkpoint(), prefix.lastMessageId(), prefix.attempt(),
                prefix.assistantCommitted(), prefix.stream(), prefix.usedIds(), prefix.pendingBatch(), prefix.batches(),
                new CsiNativeActivationProof.FileHistory(ref, JSON.createObjectNode().set("preparation", preparation), Map.of(BATCH, batch)), Map.of(), Map.of(), prefix.nextDeltaOrdinal());
    }

    private static void associationTables(Connection connection) throws Exception {
        // Minimal association-query fixture only; not an original native journal or SQL admission proof.
        try (var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE qwen_managed_session_journal_tx (tenant_id VARCHAR, workspace_id VARCHAR, session_id VARCHAR, journal_revision BIGINT, first_sequence BIGINT, last_sequence BIGINT, event_count BIGINT, operation VARCHAR)");
            statement.execute("CREATE TABLE qwen_managed_session_resource_ref (session_scope_key VARCHAR, tenant_id VARCHAR, workspace_id VARCHAR, session_id VARCHAR, resource_id VARCHAR, journal_revision BIGINT)");
        }
    }

    private void prepare(Connection connection, CsiNativeActivationProof.Prefix prefix, Tuple tuple) throws Exception {
        CsiNativeToolReservation.prepare(connection, original, prefix,
                CsiNativeToolReservation.inventory(connection, original), tuple.execution(), tuple.input(), tuple.definition());
    }

    private static Connection connection() throws Exception {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:csi-members-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=0;DATABASE_TO_LOWER=TRUE");
        Connection connection = source.getConnection();
        JdbcRuntimeBrokerSchema.initialize(source);
        try (var input = CsiNativeToolReservationTest.class.getResourceAsStream("/csi-native-resource-schema-fixture.sql");
                var statement = connection.createStatement()) {
            statement.execute(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
        connection.setAutoCommit(false);
        return connection;
    }

    private static void rejects(CsiNativeActivationProof.Prefix prefix, ToolExecutionRecord execution, byte[] input, byte[] definition) {
        assertThrows(RuntimeException.class, () -> CsiNativeToolReservation.qualify(
                new JdbcCsiFilesRetirementGuard.Original(CsiFilesRetirementProfile.request(new ContextBinding(
                        "tenant", "workspace", 1, "storage", ".", CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", SESSION),
                        "binding", 1, RuntimeBindingRecord.State.READY, false, 1, 2L), prefix, execution, input, definition));
    }

    private static JsonNode capturedParts() throws Exception {
        try (var stream = CsiNativeToolReservationTest.class.getResourceAsStream("/csi-native-function-parts-baseline.json")) {
            return JSON.readTree(stream);
        }
    }

    private static CsiNativeActivationProof.Prefix prefix(JsonNode parts) {
        return prefix(parts, PROMPT, BATCH);
    }

    private static CsiNativeActivationProof.Prefix prefix(JsonNode parts, String prompt, String batchId) {
        var calls = new ArrayList<CsiNativeActivationProof.FunctionCall>();
        for (int index = 0; index < parts.size(); index++) {
            JsonNode call = parts.get(index).path("functionCall");
            if (!call.isMissingNode()) {
                calls.add(new CsiNativeActivationProof.FunctionCall(call.path("id").textValue(), call.path("name").textValue(),
                        call.path("args").deepCopy(), index, calls.size()));
            }
        }
        var batch = new CsiNativeActivationProof.PendingBatch(batchId, JSON.createObjectNode(), calls);
        return new CsiNativeActivationProof.Prefix(new CsiNativeActivationProof.Input(prompt, "unit", "user", true),
                null, batchId, null, false, null, Set.of(), batch,
                Map.of(batchId, new CsiNativeActivationProof.OriginalBatch(prompt, batch)), null, Map.of(), Map.of(), 0);
    }

    private static Tuple tuple(CsiNativeActivationProof.Prefix prefix, int ordinal) throws Exception {
        var call = prefix.pendingBatch().calls().get(ordinal);
        String payload = JSON.writeValueAsString(Map.of("toolName", call.name(), "input", call.args()));
        byte[] input = JSON.writeValueAsBytes(Map.of("harnessSessionId", SESSION, "runtimeSessionId", SESSION, "payloadJson", payload));
        byte[] definition;
        try (var stream = CsiNativeToolReservationTest.class.getResourceAsStream("/csi-native-file-declarations.json")) {
            JsonNode declared = null;
            for (JsonNode candidate : JSON.readTree(stream)) {
                if (call.name().equals(candidate.path("name").textValue())) {
                    declared = candidate;
                }
            }
            definition = JSON.writeValueAsBytes(declared);
        }
        String id = UUID.randomUUID().toString();
        Map<String, Object> reference = new HashMap<>(Map.of("sessionId", SESSION, "promptId", prefix.input().inputId(),
                "callId", id, "argsDigest", "sha256:" + CsiNativeActivationProof.sha256(payload.getBytes(StandardCharsets.UTF_8)),
                "batchId", prefix.pendingBatch().messageId(), "functionCallId", call.id(), "ordinal", ordinal, "partIndex", call.partIndex(),
                "inputRef", ref("managed-tool-input", input), "toolDefinitionRef", ref("managed-tool-definition", definition)));
        reference.put("dispatchMode", "deferred");
        return new Tuple(ToolExecutionRecord.prepared("unit-execution-" + id, SESSION + ":" + id, "binding", 1,
                SESSION, SESSION, prefix.input().inputId(), id, (String) reference.get("argsDigest"), reference), input, definition);
    }

    private static Map<String, Object> ref(String kind, byte[] bytes) {
        return Map.of("resourceId", UUID.randomUUID().toString(), "kind", kind, "schemaVersion", 1,
                "byteLength", bytes.length, "digest", CsiNativeActivationProof.sha256(bytes));
    }

    private static ToolExecutionRecord copy(ToolExecutionRecord original, Map<String, Object> ref) {
        return ToolExecutionRecord.prepared(original.getExecutionCallId(), original.getIdempotencyKey(), original.getBindingId(), 1,
                SESSION, (String) ref.get("sessionId"), (String) ref.get("promptId"), (String) ref.get("callId"),
                (String) ref.get("argsDigest"), ref);
    }

    private record Tuple(ToolExecutionRecord execution, byte[] input, byte[] definition) {
    }
}
