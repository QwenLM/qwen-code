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
        List<ToolExecutionRecord> result = new ArrayList<>();
        Set<String> calls = new HashSet<>();
        Set<Integer> ordinals = new HashSet<>();
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
                        JsonNode stored = CsiNativeActivationProof.readObject(utf8(rows.getString("reference_json")));
                        ToolExecutionRecord execution = JdbcToolExecutionRepository.mapExecution(rows);
                        JsonNode ref = JSON.valueToTree(execution.getReference());
                        require(canonical(stored).equals(canonical(ref)));
                        byte[] input = bytes(resources, ref.path("inputRef"), "managed-tool-input");
                        byte[] definition = bytes(resources, ref.path("toolDefinitionRef"), "managed-tool-definition");
                        qualify(original, prefix, execution, input, definition);
                        require(calls.add(id(ref, "functionCallId")) && ordinals.add((int) number(ref.get("ordinal"))));
                        result.add(execution);
                        cursor = rows.getString("execution_call_id_hash");
                        count++;
                    }
                }
            }
            if (count < 100) {
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
                        && Arrays.equals(input, bytes(resources, ref.path("inputRef"), "managed-tool-input"))
                        && Arrays.equals(definition, bytes(resources, ref.path("toolDefinitionRef"), "managed-tool-definition")));
                return execution;
            }
            JsonNode saved = JSON.valueToTree(execution.getReference());
            require(!id(saved, "functionCallId").equals(id(ref, "functionCallId"))
                    && number(saved.get("ordinal")) != number(ref.get("ordinal"))
                    && !execution.getToolCallId().equals(candidate.getToolCallId())
                    && !execution.getExecutionCallId().equals(candidate.getExecutionCallId()));
        }
        store(connection, original, resources, ref.path("inputRef"), input);
        store(connection, original, resources, ref.path("toolDefinitionRef"), definition);
        JdbcToolExecutionRepository.insertExecution(connection, candidate);
        return candidate;
    }

    static Map<String, Object> read(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.Prefix prefix, Map<String, Resource> resources, String promptId, String batchId)
            throws SQLException {
        require(prefix.input() != null && promptId.equals(prefix.input().inputId()) && prefix.pendingBatch() != null
                && batchId.equals(prefix.pendingBatch().messageId()));
        List<Map<String, Object>> members = new ArrayList<>();
        for (ToolExecutionRecord execution : complete(connection, original, prefix, resources)) {
            JsonNode ref = JSON.valueToTree(execution.getReference());
            members.add(Map.of("executionCallId", execution.getExecutionCallId(),
                    "state", execution.getState().name().toLowerCase(java.util.Locale.ROOT),
                    "reference", execution.getReference(),
                    "inputBytesBase64", Base64.getEncoder().encodeToString(bytes(resources, ref.path("inputRef"), "managed-tool-input")),
                    "toolDefinitionBytesBase64", Base64.getEncoder().encodeToString(bytes(resources, ref.path("toolDefinitionRef"), "managed-tool-definition"))));
        }
        String session = original.request().getIsolationKey();
        return Map.of("protocolVersion", 1, "harnessSessionId", session, "runtimeSessionId", session,
                "promptId", promptId, "batchId", batchId, "runtimeBindingId", original.bindingId(),
                "bindingGeneration", Long.toString(original.generation()), "members", List.copyOf(members));
    }

    static void qualify(JdbcCsiFilesRetirementGuard.Original original, CsiNativeActivationProof.Prefix prefix,
            ToolExecutionRecord execution, byte[] inputBytes, byte[] definitionBytes) {
        JdbcCsiActivationAdmission.requireExecution(original, execution);
        require(original != null && prefix.input() != null && prefix.pendingBatch() != null);
        JsonNode ref = JSON.valueToTree(execution.getReference());
        closed(ref, FIELDS);
        String session = original.request().getIsolationKey();
        String callId = id(ref, "callId");
        uuid(callId);
        uuid(id(ref, "batchId"));
        require(session.equals(id(ref, "sessionId")) && prefix.input().inputId().equals(id(ref, "promptId"))
                && prefix.pendingBatch().messageId().equals(id(ref, "batchId"))
                && execution.getTurnId().equals(id(ref, "promptId")) && execution.getToolCallId().equals(callId)
                && execution.getIdempotencyKey().equals(session + ":" + callId)
                && "deferred".equals(text(ref, "dispatchMode")));
        long ordinal = number(ref.get("ordinal"));
        require(ordinal < prefix.pendingBatch().calls().size());
        var call = prefix.pendingBatch().calls().get((int) ordinal);
        require(call.id().equals(id(ref, "functionCallId")) && call.partIndex() == number(ref.get("partIndex")));
        require(inputBytes != null && inputBytes.length <= 64 * 1024
                && definitionBytes != null && definitionBytes.length <= 64 * 1024);
        reference(ref.path("inputRef"), "managed-tool-input", ignored -> inputBytes);
        reference(ref.path("toolDefinitionRef"), "managed-tool-definition", ignored -> definitionBytes);
        require(!id(ref.path("inputRef"), "resourceId").equals(id(ref.path("toolDefinitionRef"), "resourceId")));
        JsonNode wrapper = CsiNativeActivationProof.readObject(inputBytes);
        closed(wrapper, Set.of("harnessSessionId", "runtimeSessionId", "payloadJson"));
        require(session.equals(id(wrapper, "harnessSessionId")) && session.equals(id(wrapper, "runtimeSessionId"))
                && wrapper.path("payloadJson").isTextual());
        byte[] payloadBytes = utf8(wrapper.path("payloadJson").textValue());
        String digest = "sha256:" + sha256(payloadBytes);
        require(digest.equals(text(ref, "argsDigest")) && digest.equals(execution.getRequestDigest()));
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
        result.put("file_path", WorkspaceRelativePath.normalize(JS_TRIM.matcher(args.path("file_path").textValue()).replaceAll("")));
        return result;
    }

    private static byte[] bytes(Map<String, Resource> resources, JsonNode ref, String kind) {
        Resource resource = resources.get(id(ref, "resourceId"));
        require(resource != null && "PUBLISHED".equals(resource.state) && "MYSQL_INLINE".equals(resource.storage)
                && resource.inlineOnly && id(ref, "resourceId").equals(resource.commandId)
                && canonical(ref).equals(canonical(resource.ref)));
        return reference(ref, kind, ignored -> resource.bytes);
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
    }
}
