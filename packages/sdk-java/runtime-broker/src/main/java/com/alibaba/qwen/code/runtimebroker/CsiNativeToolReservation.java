package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.canonical;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.closed;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.id;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.number;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.reference;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.sha256;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.text;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.utf8;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.uuid;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRelativePath;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Original assistant allocation evidence; it does not authorize execution. */
final class CsiNativeToolReservation {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> FIELDS = Set.of("sessionId", "promptId", "callId", "argsDigest", "batchId",
            "functionCallId", "partIndex", "ordinal", "inputRef", "toolDefinitionRef", "dispatchMode");
    private static final String JS_WHITESPACE = "[\\x09-\\x0d\\x20\\x{a0}\\x{1680}\\x{2000}-\\x{200a}"
            + "\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    private static final Pattern JS_TRIM = Pattern.compile("^" + JS_WHITESPACE + "+|" + JS_WHITESPACE + "+$");
    private static final JsonNode DEFINITIONS = definitions();
    private static final int LIMIT = 4096;

    private CsiNativeToolReservation() {
    }

    static String trim(String value) {
        return JS_TRIM.matcher(value).replaceAll("");
    }

    static Map<String, Resource> inventory(Connection connection, JdbcCsiFilesRetirementGuard.Original original)
            throws SQLException {
        Map<String, Resource> result = new HashMap<>();
        String cursor = "";
        while (true) {
            int count = 0;
            try (PreparedStatement statement = statement(connection,
                    "SELECT * FROM qwen_managed_session_resource WHERE session_scope_key = ? AND resource_id > ?"
                            + " ORDER BY resource_id LIMIT 100 FOR UPDATE")) {
                statement.setString(1, scope(original));
                statement.setString(2, cursor);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        require(result.size() < LIMIT
                                && original.request().getScope().getTenantId().equals(rows.getString("tenant_id"))
                                && original.request().getScope().getWorkspaceId().equals(rows.getString("workspace_id"))
                                && original.request().getIsolationKey().equals(rows.getString("session_id")));
                        cursor = rows.getString("resource_id");
                        ObjectNode ref = JSON.createObjectNode().put("resourceId", cursor).put("kind", rows.getString("kind"))
                                .put("schemaVersion", rows.getLong("schema_version"))
                                .put("byteLength", rows.getLong("byte_length")).put("digest", rows.getString("sha256"));
                        require(result.put(cursor, new Resource(ref, rows.getBytes("inline_bytes"),
                                rows.getString("state"), rows.getString("storage_kind"), rows.getString("publish_command_id"),
                                rows.getString("object_key") == null && rows.getString("object_version_id") == null
                                        && rows.getString("encryption_key_id") == null)) == null);
                        count++;
                    }
                }
            }
            if (count < 100) {
                return result;
            }
        }
    }

    static List<ToolExecutionRecord> complete(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, Map<String, Resource> resources) throws SQLException {
        return complete(connection, original, prefix, resources, false);
    }

    static List<ToolExecutionRecord> complete(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, Map<String, Resource> resources, boolean recovery) throws SQLException {
        List<ToolExecutionRecord> result = new ArrayList<>();
        long recoveryByteCount = 0;
        Set<String> calls = new HashSet<>();
        Set<String> ordinals = new HashSet<>();
        Set<String> toolCalls = new HashSet<>();
        String cursor = "";
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
                        require(result.size() < LIMIT);
                        if (recovery) {
                            recoveryByteCount += recoveryBytes(rows.getString("result_json")).length
                                    + recoveryBytes(rows.getString("native_authorization_json")).length;
                            require(recoveryByteCount <= 8 * 1024 * 1024);
                        }
                        JsonNode stored = CsiNativeActivationProof.readObject(utf8(rows.getString("reference_json")));
                        ToolExecutionRecord execution = JdbcToolExecutionRepository.mapExecution(rows);
                        JsonNode ref = JSON.valueToTree(execution.getReference());
                        require(canonical(stored).equals(canonical(ref)));
                        String batchId = id(ref, "batchId");
                        byte[] input = bytesFor(connection, original, prefix, resources, execution.getExecutionCallId(), batchId, ref.path("inputRef"), "managed-tool-input");
                        byte[] definition = bytesFor(connection, original, prefix, resources, execution.getExecutionCallId(), batchId, ref.path("toolDefinitionRef"), "managed-tool-definition");
                        qualifyRelated(original, prefix, execution, input, definition);
                        var intent = prefix.intents().get(execution.getExecutionCallId());
                        if (intent != null) {
                            qualifyIntent(execution, intent);
                        }
                        var frozen = prefix.fileHistory() == null ? null : prefix.fileHistory().batches().get(batchId);
                        if (frozen != null) {
                            require(frozen.invocations().stream().anyMatch(invocation ->
                                    execution.getExecutionCallId().equals(id(invocation, "executionCallId"))
                                            && canonical(ref).equals(canonical(CsiNativeActivationProof.historyExecutionReference(
                                                    original.request(), JSON.createObjectNode().put("promptId", id(ref, "promptId"))
                                                            .put("batchId", batchId), invocation)))));
                        }
                        require(calls.add(batchId + "\u0000" + id(ref, "functionCallId"))
                                && ordinals.add(batchId + "\u0000" + number(ref.get("ordinal")))
                                && toolCalls.add(execution.getToolCallId()));
                        result.add(execution);
                        cursor = rows.getString("execution_call_id_hash");
                        count++;
                    }
                }
            }
            if (count < 100) {
                if (prefix.fileHistory() != null) {
                    for (var entry : prefix.fileHistory().batches().entrySet()) {
                        require(result.stream().filter(execution -> entry.getKey().equals(
                                id(JSON.valueToTree(execution.getReference()), "batchId"))).count() == entry.getValue().invocations().size());
                    }
                }
                for (String executionId : prefix.intents().keySet()) {
                    require(result.stream().anyMatch(execution -> executionId.equals(execution.getExecutionCallId())));
                }
                return List.copyOf(result);
            }
        }
    }

    static ToolExecutionRecord prepare(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, Map<String, Resource> resources,
            ToolExecutionRecord candidate, byte[] input, byte[] definition) throws SQLException {
        qualify(original, prefix, candidate, input, definition);
        List<ToolExecutionRecord> existing = complete(connection, original, prefix, resources);
        JsonNode ref = JSON.valueToTree(candidate.getReference());
        for (ToolExecutionRecord execution : existing) {
            if (execution.getIdempotencyKey().equals(candidate.getIdempotencyKey())) {
                require(execution.sameRequest(candidate)
                        && Arrays.equals(input, bytesFor(connection, original, prefix, resources, execution.getExecutionCallId(), id(ref, "batchId"), ref.path("inputRef"), "managed-tool-input"))
                        && Arrays.equals(definition, bytesFor(connection, original, prefix, resources, execution.getExecutionCallId(), id(ref, "batchId"), ref.path("toolDefinitionRef"), "managed-tool-definition")));
                return execution;
            }
            JsonNode saved = JSON.valueToTree(execution.getReference());
            boolean sameBatch = id(saved, "batchId").equals(id(ref, "batchId"));
            require((!sameBatch || !id(saved, "functionCallId").equals(id(ref, "functionCallId"))
                    && number(saved.get("ordinal")) != number(ref.get("ordinal")))
                    && !execution.getToolCallId().equals(candidate.getToolCallId())
                    && !execution.getExecutionCallId().equals(candidate.getExecutionCallId()));
        }
        require((prefix.fileHistory() == null || !prefix.fileHistory().batches().containsKey(id(ref, "batchId")))
                && prefix.intents().values().stream().noneMatch(intent -> id(ref, "batchId").equals(id(intent.payload(), "batchId"))));
        store(connection, original, resources, ref.path("inputRef"), input);
        store(connection, original, resources, ref.path("toolDefinitionRef"), definition);
        JdbcToolExecutionRepository.insertExecution(connection, candidate);
        return candidate;
    }

    static Map<String, Object> read(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, Map<String, Resource> resources, String promptId, String batchId)
            throws SQLException {
        return read(connection, original, prefix, resources, promptId, batchId, false);
    }

    static Map<String, Object> read(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, Map<String, Resource> resources, String promptId, String batchId,
            boolean recovery) throws SQLException {
        require(prefix.input() != null && promptId.equals(prefix.input().inputId()) && prefix.pendingBatch() != null
                && batchId.equals(prefix.pendingBatch().messageId()));
        List<Map<String, Object>> members = new ArrayList<>();
        long responseByteCount = 0;
        for (ToolExecutionRecord execution : complete(connection, original, prefix, resources, recovery)) {
            JsonNode ref = JSON.valueToTree(execution.getReference());
            if (!batchId.equals(id(ref, "batchId"))) {
                continue;
            }
            var member = new java.util.LinkedHashMap<String, Object>(Map.of("executionCallId", execution.getExecutionCallId(),
                    "state", execution.getState().name().toLowerCase(java.util.Locale.ROOT),
                    "reference", execution.getReference(),
                    "inputBytesBase64", Base64.getEncoder().encodeToString(bytesFor(connection, original, prefix, resources, execution.getExecutionCallId(), batchId, ref.path("inputRef"), "managed-tool-input")),
                    "toolDefinitionBytesBase64", Base64.getEncoder().encodeToString(bytesFor(connection, original, prefix, resources, execution.getExecutionCallId(), batchId, ref.path("toolDefinitionRef"), "managed-tool-definition"))));
            if (recovery) {
                try (PreparedStatement statement = statement(connection,
                        "SELECT execution_call_id, result_json, native_authorization_json FROM qwen_tool_execution WHERE execution_call_id_hash = ? FOR UPDATE")) {
                    statement.setString(1, JdbcRepositorySupport.valueKey(execution.getExecutionCallId()));
                    try (ResultSet row = statement.executeQuery()) {
                        require(row.next() && execution.getExecutionCallId().equals(row.getString(1)));
                        member.put("resultBytesBase64", Base64.getEncoder().encodeToString(recoveryBytes(row.getString(2))));
                        member.put("authorizationBytesBase64", Base64.getEncoder().encodeToString(recoveryBytes(row.getString(3))));
                        require(!row.next());
                    }
                }
            }
            if (recovery) {
                responseByteCount += JsonCodec.encode(member).length + 1;
                require(responseByteCount <= 8 * 1024 * 1024);
            }
            members.add(member);
        }
        members.sort(java.util.Comparator.comparingInt(member -> ((Number) ((Map<?, ?>) member.get("reference")).get("ordinal")).intValue()));
        String session = original.request().getIsolationKey();
        var result = Map.of("protocolVersion", 1, "harnessSessionId", session, "runtimeSessionId", session,
                "promptId", promptId, "batchId", batchId, "runtimeBindingId", original.bindingId(),
                "bindingGeneration", Long.toString(original.generation()), "members", List.copyOf(members));
        require(!recovery || JsonCodec.encode(result).length <= 8 * 1024 * 1024);
        return result;
    }

    static byte[] recoveryBytes(String saved) {
        require(saved != null);
        byte[] bytes = utf8(saved);
        require(bytes.length > 0 && bytes.length <= 64 * 1024);
        CsiNativeActivationProof.readObject(bytes);
        return bytes;
    }

    static void qualify(JdbcCsiFilesRetirementGuard.Original original, CsiNativeActivationProof.Prefix prefix,
            ToolExecutionRecord execution, byte[] inputBytes, byte[] definitionBytes) {
        require(original != null && prefix.input() != null && prefix.pendingBatch() != null);
        var batch = prefix.batches().get(prefix.pendingBatch().messageId());
        require(batch != null && batch.promptId().equals(prefix.input().inputId())
                && batch.batch().equals(prefix.pendingBatch()));
        qualify(original, batch, execution, inputBytes, definitionBytes);
    }

    static void qualifyRelated(JdbcCsiFilesRetirementGuard.Original original, CsiNativeActivationProof.Prefix prefix,
            ToolExecutionRecord execution, byte[] inputBytes, byte[] definitionBytes) {
        require(execution != null);
        JsonNode ref = JSON.valueToTree(execution.getReference());
        var batch = prefix.batches().get(id(ref, "batchId"));
        require(batch != null);
        qualify(original, batch, execution, inputBytes, definitionBytes);
    }

    private static void qualify(JdbcCsiFilesRetirementGuard.Original original, CsiNativeActivationProof.OriginalBatch batch,
            ToolExecutionRecord execution, byte[] inputBytes, byte[] definitionBytes) {
        JdbcCsiActivationAdmission.requireExecution(original, execution);
        require(original != null);
        JsonNode ref = JSON.valueToTree(execution.getReference());
        closed(ref, FIELDS);
        String session = original.request().getIsolationKey();
        String callId = id(ref, "callId");
        uuid(callId);
        uuid(id(ref, "batchId"));
        require(session.equals(id(ref, "sessionId")) && batch.promptId().equals(id(ref, "promptId"))
                && batch.batch().messageId().equals(id(ref, "batchId"))
                && execution.getTurnId().equals(id(ref, "promptId")) && execution.getToolCallId().equals(callId)
                && execution.getIdempotencyKey().equals(session + ":" + callId)
                && "deferred".equals(text(ref, "dispatchMode")));
        qualifyContent(original.request(), batch, ref, execution.getRequestDigest(), inputBytes, definitionBytes);
    }

    static ObjectNode qualifyContent(RuntimeProvisionRequest original, CsiNativeActivationProof.OriginalBatch batch,
            JsonNode ref, String requestDigest, byte[] inputBytes, byte[] definitionBytes) {
        closed(ref, FIELDS);
        String session = original.getIsolationKey();
        uuid(id(ref, "callId"));
        uuid(id(ref, "batchId"));
        require(session.equals(id(ref, "sessionId")) && batch.promptId().equals(id(ref, "promptId"))
                && batch.batch().messageId().equals(id(ref, "batchId")) && "deferred".equals(text(ref, "dispatchMode")));
        long ordinal = number(ref.get("ordinal"));
        require(ordinal < batch.batch().calls().size());
        var call = batch.batch().calls().get((int) ordinal);
        require(call.id().equals(id(ref, "functionCallId")) && call.partIndex() == number(ref.get("partIndex")));
        require(inputBytes != null && inputBytes.length <= 64 * 1024
                && definitionBytes != null && definitionBytes.length <= 64 * 1024);
        reference(ref.path("inputRef"), "managed-tool-input", ignored -> inputBytes);
        reference(ref.path("toolDefinitionRef"), "managed-tool-definition", ignored -> definitionBytes);
        require(!id(ref.path("inputRef"), "resourceId").equals(id(ref.path("toolDefinitionRef"), "resourceId")));
        var content = content(original, call, inputBytes, definitionBytes);
        String digest = "sha256:" + content.digest();
        require(digest.equals(text(ref, "argsDigest")) && digest.equals(requestDigest));
        return content.normalized();
    }

    record Content(ObjectNode normalized, String digest) {
    }

    static Content content(RuntimeProvisionRequest original, CsiNativeActivationProof.FunctionCall call,
            byte[] inputBytes, byte[] definitionBytes) {
        require(inputBytes != null && inputBytes.length <= 64 * 1024
                && definitionBytes != null && definitionBytes.length <= 64 * 1024);
        String session = original.getIsolationKey();
        JsonNode wrapper = CsiNativeActivationProof.readObject(inputBytes);
        closed(wrapper, Set.of("harnessSessionId", "runtimeSessionId", "payloadJson"));
        require(session.equals(id(wrapper, "harnessSessionId")) && session.equals(id(wrapper, "runtimeSessionId"))
                && wrapper.path("payloadJson").isTextual());
        byte[] payloadBytes = utf8(wrapper.path("payloadJson").textValue());
        JsonNode payload = CsiNativeActivationProof.readObject(payloadBytes);
        closed(payload, Set.of("toolName", "input"));
        require(call.name().equals(text(payload, "toolName")));
        ObjectNode normalized = normalizedInput(call.name(), call.args());
        require(canonical(normalized).equals(canonical(payload.path("input"))));
        JsonNode definition = CsiNativeActivationProof.readObject(definitionBytes);
        JsonNode expected = null;
        for (JsonNode item : DEFINITIONS) {
            if (call.name().equals(item.path("name").textValue())) {
                expected = item;
            }
        }
        require(expected != null && canonical(expected).equals(canonical(definition)));
        return new Content(normalized, sha256(payloadBytes));
    }

    private static ObjectNode normalizedInput(String name, JsonNode args) {
        Set<String> required = switch (name) {
            case "read_file" -> Set.of("file_path");
            case "write_file" -> Set.of("file_path", "content");
            case "edit" -> Set.of("file_path", "old_string", "new_string");
            default -> throw invalid();
        };
        Set<String> optional = "read_file".equals(name) ? Set.of("offset", "limit")
                : "edit".equals(name) ? Set.of("replace_all") : Set.of();
        require(args.isObject());
        args.fieldNames().forEachRemaining(field -> require(required.contains(field) || optional.contains(field)));
        for (String field : required) {
            require(args.path(field).isTextual());
            utf8(args.path(field).textValue());
        }
        for (String field : List.of("offset", "limit")) {
            if (args.has(field)) {
                require(number(args.get(field)) >= ("limit".equals(field) ? 1 : 0));
            }
        }
        require(!args.has("replace_all") || args.path("replace_all").isBoolean());
        ObjectNode result = args.deepCopy();
        result.put("file_path", WorkspaceRelativePath.normalize(trim(args.path("file_path").textValue())));
        return result;
    }

    private static byte[] bytes(Map<String, Resource> resources, JsonNode ref, String kind) {
        Resource resource = resources.get(id(ref, "resourceId"));
        require(resource != null && "PUBLISHED".equals(resource.state) && "MYSQL_INLINE".equals(resource.storage)
                && resource.inlineOnly && id(ref, "resourceId").equals(resource.commandId)
                && canonical(ref).equals(canonical(resource.ref)));
        return reference(ref, kind, ignored -> resource.bytes);
    }

    private static byte[] bytesFor(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, Map<String, Resource> resources, String executionId, String batchId, JsonNode ref, String kind)
            throws SQLException {
        var frozen = prefix.fileHistory() == null ? null : prefix.fileHistory().batches().get(batchId);
        if (frozen == null) {
            var intent = prefix.intents().get(executionId);
            if (intent == null) {
                return bytes(resources, ref, kind);
            }
            Resource resource = resources.get(id(ref, "resourceId"));
            require(resource != null && "REFERENCED".equals(resource.state) && "MYSQL_INLINE".equals(resource.storage)
                    && resource.inlineOnly && id(ref, "resourceId").equals(resource.commandId)
                    && canonical(ref).equals(canonical(resource.ref)));
            byte[] associated = JdbcCsiActivationAdmission.resource(connection, original, ref, intent.revision());
            require(Arrays.equals(resource.bytes, associated));
            return reference(ref, kind, ignored -> associated);
        }
        require(frozen.invocations().stream().anyMatch(invocation ->
                canonical(invocation.path("inputRef")).equals(canonical(ref))
                        || canonical(invocation.path("toolDefinitionRef")).equals(canonical(ref))));
        Resource resource = resources.get(id(ref, "resourceId"));
        require(resource != null && "REFERENCED".equals(resource.state) && "MYSQL_INLINE".equals(resource.storage)
                && resource.inlineOnly && id(ref, "resourceId").equals(resource.commandId)
                && canonical(ref).equals(canonical(resource.ref)));
        byte[] associated = JdbcCsiActivationAdmission.frozenResource(connection, original, ref, frozen.intentSequence());
        require(Arrays.equals(resource.bytes, associated));
        return reference(ref, kind, ignored -> associated);
    }

    static byte[] candidateBytes(Map<String, Resource> resources, JsonNode ref) {
        Resource resource = resources.get(id(ref, "resourceId"));
        require(resource != null && resource.inlineOnly && "MYSQL_INLINE".equals(resource.storage)
                && canonical(ref).equals(canonical(resource.ref)));
        return reference(ref, text(ref, "kind"), ignored -> resource.bytes);
    }

    private static void qualifyIntent(ToolExecutionRecord execution, CsiNativeActivationProof.ToolIntent intent) {
        JsonNode ref = JSON.valueToTree(execution.getReference());
        JsonNode payload = intent.payload();
        require(execution.getExecutionCallId().equals(id(payload, "executionCallId"))
                && id(ref, "batchId").equals(id(payload, "batchId"))
                && number(ref.get("ordinal")) == number(payload.get("ordinal"))
                && canonical(ref.path("inputRef")).equals(canonical(payload.path("argsRef")))
                && canonical(ref.path("toolDefinitionRef")).equals(canonical(payload.path("toolDefinitionRef")))
                && ("sha256:" + intent.inputDigest()).equals(execution.getRequestDigest()));
    }

    static void requireReady(Connection connection, JdbcCsiFilesRetirementGuard.Original original) throws SQLException {
        JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
        RuntimeSessionRecord session = JdbcRuntimeSessionRepository.selectSession(connection,
                original.request().getScope(), original.request().getIsolationKey(), true);
        original.requireSession(session);
        require(session.getState() == RuntimeSessionRecord.State.READY);
    }

    static void qualifyNativeBatch(CsiNativeActivationProof.Prefix prefix, List<ToolExecutionRecord> executions, boolean checkpoint) {
        require(prefix.pendingBatch() != null);
        String batchId = prefix.pendingBatch().messageId();
        List<ToolExecutionRecord> members = executions.stream().filter(execution ->
                batchId.equals(id(JSON.valueToTree(execution.getReference()), "batchId"))).toList();
        require(!members.isEmpty());
        var frozen = prefix.fileHistory() == null ? null : prefix.fileHistory().batches().get(batchId);
        Set<String> resourceIds = new HashSet<>();
        for (ToolExecutionRecord execution : members) {
            require(execution.getState() == ToolExecutionRecord.State.PREPARED && execution.getDispatchGeneration() == 0
                    && !execution.isCancelRequested() && execution.getDispatchOwner() == null && execution.getDispatchLeaseUntil() == null
                    && execution.getResult() == null && execution.getExecutionStatus() == null && execution.getLastSequence() == 0
                    && execution.getSettledAt() == null && execution.getAbandonedAt() == null && execution.getLossEvidenceId() == null
                    && execution.getAuthorizedBindingVersion() == null && execution.getAuthorizedDispatchGeneration() == null);
            JsonNode ref = JSON.valueToTree(execution.getReference());
            if (frozen == null) {
                var batch = prefix.batches().get(batchId);
                require("read_file".equals(batch.batch().calls().get((int) number(ref.get("ordinal"))).name())
                        && resourceIds.add(id(ref.path("inputRef"), "resourceId"))
                        && resourceIds.add(id(ref.path("toolDefinitionRef"), "resourceId")));
            }
            var intent = prefix.intents().get(execution.getExecutionCallId());
            if (checkpoint) {
                require(intent != null);
            }
            if (intent != null) {
                qualifyIntent(execution, intent);
            }
        }
        if (frozen != null) {
            require(frozen.preparedRef() != null && members.size() == frozen.invocations().size());
        }
        long entered = prefix.intents().values().stream().filter(intent -> batchId.equals(id(intent.payload(), "batchId"))).count();
        require(entered <= members.size() && (!checkpoint || entered == members.size()));
    }

    static void preflightNative(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix previous, CsiNativeActivationProof.Prefix next,
            Map<String, Resource> resources, String operation) throws SQLException {
        requireReady(connection, original);
        List<ToolExecutionRecord> executions = complete(connection, original, previous, resources);
        qualifyNativeBatch(next, executions, "commitCheckpoint".equals(operation));
        if ("toolIntent".equals(operation)) {
            var added = next.intents().entrySet().stream().filter(entry -> !previous.intents().containsKey(entry.getKey())).toList();
            require(added.size() == 1);
            var intent = added.getFirst().getValue();
            var execution = executions.stream().filter(member -> added.getFirst().getKey().equals(member.getExecutionCallId()))
                    .findFirst().orElseThrow(CsiNativeToolReservation::invalid);
            qualifyIntent(execution, intent);
            String batchId = id(intent.payload(), "batchId");
            if (previous.fileHistory() == null || !previous.fileHistory().batches().containsKey(batchId)) {
                for (String field : List.of("argsRef", "toolDefinitionRef")) {
                    JsonNode ref = intent.payload().path(field);
                    bytes(resources, ref, text(ref, "kind"));
                    promote(connection, original, ref);
                }
            }
        }
    }

    private static void promote(Connection connection, JdbcCsiFilesRetirementGuard.Original original, JsonNode ref) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "UPDATE qwen_managed_session_resource SET state = 'REFERENCED'"
                        + " WHERE session_scope_key = ? AND resource_id = ? AND state = 'PUBLISHED'")) {
            statement.setString(1, scope(original));
            statement.setString(2, id(ref, "resourceId"));
            require(statement.executeUpdate() == 1);
        }
    }

    static void preflightHistory(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix previous, CsiNativeActivationProof.Prefix next, Map<String, Resource> resources)
            throws SQLException {
        JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
        RuntimeSessionRecord session = JdbcRuntimeSessionRepository.selectSession(connection,
                original.request().getScope(), original.request().getIsolationKey(), true);
        original.requireSession(session);
        require(session.getState() == RuntimeSessionRecord.State.READY);
        List<ToolExecutionRecord> executions = complete(connection, original, previous, resources);
        JsonNode preparation = next.fileHistory().body().path("preparation");
        if (preparation.isNull()) {
            if (previous.fileHistory() == null) {
                require(executions.isEmpty());
            } else {
                String batchId = id(previous.fileHistory().body().path("preparation"), "batchId");
                var intended = previous.fileHistory().batches().get(batchId);
                require(intended != null && intended.preparedRef() != null);
                List<ToolExecutionRecord> members = executions.stream().filter(execution ->
                        batchId.equals(execution.getReference().get("batchId"))).toList();
                require(members.size() == intended.invocations().size());
                for (var member : members) {
                    require(member.getState() == ToolExecutionRecord.State.SETTLED && !member.isCancelRequested()
                            && member.getResult() != null && previous.receipts().containsKey(member.getExecutionCallId()));
                }
            }
            return;
        }
        String batchId = id(preparation, "batchId");
        var intended = next.fileHistory().batches().get(batchId);
        List<ToolExecutionRecord> members = executions.stream().filter(execution ->
                batchId.equals(id(JSON.valueToTree(execution.getReference()), "batchId"))).toList();
        require(members.size() == intended.invocations().size());
        for (JsonNode invocation : intended.invocations()) {
            var expected = CsiNativeActivationProof.historyExecutionReference(original.request(), preparation, invocation);
            ToolExecutionRecord execution = members.stream().filter(member ->
                    member.getExecutionCallId().equals(id(invocation, "executionCallId"))).findFirst().orElseThrow(CsiNativeToolReservation::invalid);
            require(execution.getState() == ToolExecutionRecord.State.PREPARED && execution.getDispatchGeneration() == 0
                    && execution.getAuthorizedBindingVersion() == null && execution.getAuthorizedDispatchGeneration() == null
                    && text(invocation, "requestDigest").equals(execution.getRequestDigest())
                    && canonical(expected).equals(canonical(JSON.valueToTree(execution.getReference()))));
        }
        if ("intent".equals(text(preparation, "stage"))) {
            var promoted = new HashSet<String>();
            for (JsonNode invocation : intended.invocations()) {
                for (String field : List.of("inputRef", "toolDefinitionRef")) {
                    JsonNode ref = invocation.path(field);
                    bytes(resources, ref, text(ref, "kind"));
                    if (!promoted.add(id(ref, "resourceId"))) {
                        continue;
                    }
                    try (PreparedStatement statement = statement(connection,
                            "UPDATE qwen_managed_session_resource SET state = 'REFERENCED'"
                                    + " WHERE session_scope_key = ? AND resource_id = ? AND state = 'PUBLISHED'")) {
                        statement.setString(1, scope(original));
                        statement.setString(2, id(ref, "resourceId"));
                        require(statement.executeUpdate() == 1);
                    }
                }
            }
        }
    }

    private static void store(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            Map<String, Resource> resources, JsonNode ref, byte[] bytes) throws SQLException {
        if (resources.containsKey(id(ref, "resourceId"))) {
            require(Arrays.equals(bytes, bytes(resources, ref, text(ref, "kind"))));
            return;
        }
        try (PreparedStatement statement = statement(connection,
                "INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, created_at, last_verified_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'PUBLISHED', ?, ?)")) {
            statement.setString(1, scope(original));
            statement.setString(2, original.request().getScope().getTenantId());
            statement.setString(3, original.request().getScope().getWorkspaceId());
            statement.setString(4, original.request().getIsolationKey());
            statement.setString(5, id(ref, "resourceId"));
            statement.setString(6, text(ref, "kind"));
            statement.setLong(7, bytes.length);
            statement.setString(8, text(ref, "digest"));
            statement.setBytes(9, bytes);
            statement.setString(10, id(ref, "resourceId"));
            var now = java.sql.Timestamp.from(JdbcRepositorySupport.databaseNowPrecise(connection));
            statement.setTimestamp(11, now);
            statement.setTimestamp(12, now);
            require(statement.executeUpdate() == 1);
        }
    }

    private static String scope(JdbcCsiFilesRetirementGuard.Original original) {
        return sha256(utf8(original.request().getScope().getTenantId() + "\u0000" + original.request().getIsolationKey()));
    }

    private static JsonNode definitions() {
        try (InputStream input = CsiNativeToolReservation.class.getResourceAsStream("/csi-native-file-declarations.json")) {
            require(input != null);
            JsonNode definitions = CsiNativeActivationProof.readJson(input.readNBytes(64 * 1024 + 1));
            require(definitions.isArray() && definitions.size() == 3);
            return definitions;
        } catch (IOException error) {
            throw new IllegalStateException("Private CSI declarations are unavailable", error);
        }
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw invalid();
        }
    }

    private static RuntimeBrokerException invalid() {
        return new RuntimeBrokerException(409, "csi_native_reservation_conflict",
                "The original CSI native allocation proof is unavailable.", false);
    }

    static final class Resource {
        private final JsonNode ref;
        private final byte[] bytes;
        private final String state;
        private final String storage;
        private final String commandId;
        private final boolean inlineOnly;

        private Resource(JsonNode ref, byte[] bytes, String state, String storage, String commandId, boolean inlineOnly) {
            this.ref = ref;
            this.bytes = bytes;
            this.state = state;
            this.storage = storage;
            this.commandId = commandId;
            this.inlineOnly = inlineOnly;
        }

        String kind() {
            return ref.path("kind").textValue();
        }
    }
}
