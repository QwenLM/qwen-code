package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.JSON;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.check;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.hash;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.parse;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.positive;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.text;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.JdbcTemplate;

/** Original authority reads without acquiring, renewing or quarantining anything. */
final class WorkspaceRecoveryReader {
    private final JdbcTemplate jdbc;
    private final ToolPublicationObjectStore objects;

    WorkspaceRecoveryReader(JdbcTemplate jdbc, ToolPublicationObjectStore objects) {
        this.jdbc = jdbc;
        this.objects = objects;
    }

    JsonNode transaction(JsonNode source, long revision) {
        JsonNode head = head(source);
        check(revision <= head.path("journalRevision").asLong(), "transaction_out_of_cut");
        var rows = jdbc.queryForList("SELECT * FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                text(head, "tenantId"), text(head, "sessionId"), revision);
        check(rows.size() == 1, "transaction_missing");
        var row = rows.getFirst();
        check(text(head, "workspaceId").equals(row.get("workspace_id"))
                && "identity".equals(row.get("record_encoding")), "transaction_scope_conflict");
        byte[] bytes = (byte[]) row.get("record_bytes");
        check(bytes != null && bytes.length <= ManagedSessionStoreModels.MAX_TRANSACTION_BYTES
                && bytes.length == ((Number) row.get("byte_length")).longValue()
                && hash(bytes).equals(row.get("record_digest")), "transaction_corrupt");
        var value = new ManagedSessionStoreModels.StoredTransaction(revision,
                (String) row.get("transaction_id"), (String) row.get("operation"), (String) row.get("command_id"),
                (String) row.get("content_digest"), number(row, "first_sequence"), number(row, "last_sequence"),
                ((Number) row.get("event_count")).intValue(), (String) row.get("events_digest"),
                (String) row.get("previous_commit_digest"), (String) row.get("commit_digest"),
                number(row, "writer_generation"), number(row, "activation_epoch"),
                (String) row.get("latest_checkpoint_resource_id"), "identity", Base64.getEncoder().encodeToString(bytes),
                bytes.length, (String) row.get("record_digest"));
        return JSON.valueToTree(value);
    }

    JsonNode resource(JsonNode source, JsonNode ref) {
        validateRef(ref);
        JsonNode head = head(source);
        var rows = jdbc.queryForList("SELECT * FROM qwen_managed_session_resource WHERE tenant_id = ?"
                + " AND workspace_id = ? AND session_id = ? AND resource_id = ?",
                text(head, "tenantId"), text(head, "workspaceId"), text(head, "sessionId"), text(ref, "resourceId"));
        byte[] bytes;
        if (!rows.isEmpty()) {
            check(rows.size() == 1, "resource_scope_conflict");
            var row = rows.getFirst();
            check(text(ref, "kind").equals(row.get("kind")) && ref.path("schemaVersion").asInt() == number(row, "schema_version")
                    && ref.path("byteLength").asLong() == number(row, "byte_length")
                    && text(ref, "digest").equals(row.get("sha256")), "resource_reference_conflict");
            if ("MYSQL_INLINE".equals(row.get("storage_kind"))) {
                boolean published = "PUBLISHED".equals(row.get("state"))
                        && Set.of("managed-tool-result-content", "managed-tool-result-manifest", "managed-tool-result-page").contains(text(ref, "kind"));
                check(("REFERENCED".equals(row.get("state")) || published) && row.get("object_key") == null
                        && row.get("object_version_id") == null && row.get("encryption_key_id") == null,
                        "resource_layout_unsupported");
                bytes = (byte[]) row.get("inline_bytes");
                Long references = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_ref"
                        + " WHERE tenant_id = ? AND workspace_id = ? AND session_id = ? AND resource_id = ?"
                        + " AND journal_revision <= ?", Long.class, text(head, "tenantId"), text(head, "workspaceId"),
                        text(head, "sessionId"), text(ref, "resourceId"), head.path("journalRevision").asLong());
                check(published || references != null && references > 0, "resource_out_of_cut");
            } else {
                check("TOOL_PUBLICATION".equals(row.get("storage_kind")) && "REFERENCED".equals(row.get("state"))
                        && row.get("inline_bytes") == null && row.get("object_version_id") == null
                        && row.get("encryption_key_id") == null, "resource_layout_unsupported");
                JsonNode object = publicationResource(source, ref);
                bytes = Base64.getDecoder().decode(object.path("bytesBase64").asText());
            }
        } else {
            JsonNode object = publicationResource(source, ref);
            bytes = Base64.getDecoder().decode(object.path("bytesBase64").asText());
        }
        verifyBytes(bytes, ref.path("byteLength").asLong(), text(ref, "digest"));
        ObjectNode response = JSON.createObjectNode();
        response.set("ref", ref);
        return response.put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
    }

    private JsonNode publicationResource(JsonNode source, JsonNode ref) {
        JsonNode head = head(source);
        var rows = jdbc.queryForList("SELECT publication_id, slot_key FROM qwen_tool_publication_object"
                + " WHERE scope_key = ? AND resource_id = ?", scope(head), text(ref, "resourceId"));
        check(rows.size() == 1, "resource_missing");
        var row = rows.getFirst();
        JsonNode object = publicationObject(source, (String) row.get("publication_id"), (String) row.get("slot_key"));
        check(ref.path("schemaVersion").asInt() == 1 && ref.path("resourceId").equals(object.path("resourceId"))
                && ref.path("kind").equals(object.path("kind")) && ref.path("byteLength").asLong() == object.path("byteLength").asLong()
                && ref.path("digest").equals(object.path("digest")), "resource_reference_conflict");
        return object;
    }

    JsonNode publicationObject(JsonNode source, String publicationId, String slot) {
        JsonNode head = head(source);
        publication(source, publicationId);
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_publication_object WHERE scope_key = ?"
                + " AND publication_id = ? AND slot_key = ?", scope(head), publicationId, slot);
        check(rows.size() == 1, "publication_object_missing");
        var row = rows.getFirst();
        check("VERIFIED".equals(row.get("state")), "publication_object_unverified");
        long length = number(row, "byte_length");
        int maximum = (slot.startsWith("segment:") || slot.startsWith("content:")) ? 16 * 1024 * 1024
                : slot.startsWith("page:") ? 256 * 1024 : slot.startsWith("manifest:") ? 64 * 1024 : 2 * 1024 * 1024;
        check(length >= 0 && length <= maximum, "publication_object_too_large");
        byte[] bytes = (byte[]) row.get("inline_bytes");
        String key = (String) row.get("object_key");
        check((bytes == null) != (key == null), "publication_object_layout");
        if (key != null) {
            check(objects != null, "publication_objects_unavailable");
            try (InputStream input = objects.open(key)) {
                bytes = input.readNBytes((int) length + 1);
            } catch (IOException error) {
                throw WorkspaceRecoveryStore.failure("publication_object_io_failed");
            }
        }
        verifyBytes(bytes, length, (String) row.get("sha256"));
        ObjectNode result = JSON.createObjectNode().put("slotKey", slot).put("byteLength", length)
                .put("digest", (String) row.get("sha256")).put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
        result.set("resourceId", JSON.valueToTree(row.get("resource_id")));
        result.set("kind", JSON.valueToTree(row.get("resource_kind")));
        return result;
    }

    JsonNode publicationReceipt(JsonNode source, JsonNode request) {
        JsonNode head = head(source);
        JsonNode expected = request.path("outcomeRef");
        validateRef(expected);
        var rows = jdbc.queryForList("SELECT publication_id FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND admission_resource_id = ?", scope(head), text(expected, "resourceId"));
        check(rows.size() == 1, "publication_receipt_missing");
        String publicationId = (String) rows.getFirst().get("publication_id");
        Map<String, Object> publication = publication(source, publicationId);
        JsonNode binding = ToolPublicationContract.parseBytes("binding",
                ((String) publication.get("binding_json")).getBytes(StandardCharsets.UTF_8));
        check(ToolPublicationContract.bindingDigest(binding).equals(publication.get("binding_digest"))
                && binding.path("sessionKey").equals(key(head)) && publicationId.equals(binding.path("publicationId").asText())
                && text(request, "executionCallId").equals(binding.path("executionCallId").asText()), "publication_owner_conflict");
        verifyExecution(binding);
        long sequence = positive(request, "sequence");
        long revision = number(publication, "receipt_revision");
        check(sequence == number(publication, "receipt_sequence"), "publication_receipt_conflict");
        JsonNode raw = resource(source, expected);
        JsonNode outcome = parse(Base64.getDecoder().decode(raw.path("bytesBase64").asText()));
        check("committed".equals(outcome.path("decision").asText())
                && outcome.path("manifestRef").equals(request.path("manifestRef")), "publication_outcome_conflict");
        JsonNode terminal = publicationObject(source, publicationId, "terminal");
        check("managed-tool-terminal".equals(terminal.path("kind").asText())
                && terminal.path("resourceId").asText().equals(publication.get("terminal_resource_id")), "publication_terminal_conflict");
        JsonNode envelope = ToolPublicationContract.parseToolResult("result",
                Base64.getDecoder().decode(terminal.path("bytesBase64").asText()), 2 * 1024 * 1024);
        check(envelope.equals(outcome.path("envelope"))
                && "complete".equals(envelope.path("capture").path("captureStatus").asText()), "publication_incomplete");
        JsonNode transaction = transaction(source, revision);
        byte[] records = Base64.getDecoder().decode(transaction.path("recordBytesBase64").asText());
        JsonNode event = null;
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = parse(line);
            if ("managed_session_event_v1".equals(record.path("subtype").asText())
                    && record.path("managedSession").path("sequence").asLong(-1) == sequence) {
                check(event == null, "publication_receipt_conflict");
                event = record.path("managedSession");
            }
        }
        check(event != null && "tool.receipt".equals(event.path("kind").asText())
                && event.path("sessionKey").equals(key(head))
                && event.path("payload").path("executionCallId").equals(request.path("executionCallId"))
                && expected.equals(event.path("payload").path("toolOutcomeRef")), "publication_receipt_conflict");
        ObjectNode result = JSON.createObjectNode().put("publicationId", publicationId)
                .put("receiptSequence", sequence).put("receiptRevision", revision);
        result.set("binding", binding);
        result.set("outcomeRef", expected);
        result.set("manifestRef", request.path("manifestRef"));
        ObjectNode terminalRef = result.putObject("terminalRef").put("schemaVersion", 1);
        for (String field : List.of("resourceId", "byteLength", "digest")) {
            terminalRef.set(field, terminal.path(field));
        }
        terminalRef.set("kind", terminal.path("kind"));
        var seals = result.putArray("seals");
        for (var seal : jdbc.queryForList("SELECT stream_id, segment_count, byte_length, sha256"
                + " FROM qwen_tool_publication_seal WHERE scope_key = ? AND publication_id = ? ORDER BY stream_id",
                scope(head), publicationId)) {
            seals.addObject().put("streamId", (String) seal.get("stream_id"))
                    .put("segmentCount", number(seal, "segment_count")).put("byteLength", number(seal, "byte_length"))
                    .put("digest", (String) seal.get("sha256"));
        }
        return result;
    }

    private void verifyExecution(JsonNode binding) {
        var executions = jdbc.queryForList("SELECT e.*, b.tenant_id AS original_tenant, b.workspace_id AS original_workspace,"
                + " b.runtime_generation AS original_generation FROM qwen_tool_execution e JOIN qwen_runtime_binding b"
                + " ON b.binding_id = e.binding_id WHERE e.execution_call_id = ? AND b.binding_id = ?",
                text(binding, "executionCallId"), text(binding, "runtimeBindingId"));
        check(executions.size() == 1, "publication_owner_conflict");
        var execution = executions.getFirst();
        JsonNode key = binding.path("sessionKey");
        JsonNode ref = binding.path("reference");
        JsonNode originalRef = parse((String) execution.get("reference_json"));
        check(text(key, "tenantId").equals(execution.get("original_tenant"))
                && text(key, "workspaceId").equals(execution.get("original_workspace"))
                && text(key, "sessionId").equals(execution.get("harness_session_id"))
                && Long.toString(number(execution, "original_generation")).equals(text(binding, "bindingGeneration"))
                && number(execution, "original_generation") == number(execution, "runtime_generation")
                && text(ref, "sessionId").equals(execution.get("runtime_session_id"))
                && text(ref, "promptId").equals(execution.get("turn_id"))
                && text(ref, "callId").equals(execution.get("tool_call_id"))
                && text(binding, "requestDigest").equals(execution.get("request_digest"))
                && "deferred_v3".equals(originalRef.path("dispatchMode").asText())
                && binding.path("publicationId").equals(originalRef.path("publicationId"))
                && ref.path("argsDigest").equals(originalRef.path("argsDigest")), "publication_owner_conflict");
    }

    private Map<String, Object> publication(JsonNode source, String publication) {
        JsonNode head = head(source);
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?"
                + " AND tenant_id = ? AND workspace_id = ? AND session_id = ?", scope(head), publication,
                text(head, "tenantId"), text(head, "workspaceId"), text(head, "sessionId"));
        check(rows.size() == 1, "publication_scope_conflict");
        var row = rows.getFirst();
        check("REFERENCED".equals(row.get("producer_phase")) && Boolean.FALSE.equals(row.get("quarantined"))
                && row.get("receipt_revision") instanceof Number && row.get("receipt_sequence") instanceof Number
                && number(row, "receipt_revision") > 0 && number(row, "receipt_revision") <= head.path("journalRevision").asLong()
                && number(row, "receipt_sequence") > 0 && number(row, "receipt_sequence") <= head.path("committedSequence").asLong(),
                "publication_out_of_cut");
        return row;
    }

    static void validateRef(JsonNode ref) {
        check(ref.isObject() && ref.size() == 5 && text(ref, "resourceId").length() <= 512
                && text(ref, "kind").length() <= 512 && ref.path("schemaVersion").isIntegralNumber()
                && ref.path("schemaVersion").canConvertToInt() && ref.path("schemaVersion").asInt() > 0
                && ref.path("byteLength").isIntegralNumber()
                && ref.path("byteLength").canConvertToLong() && ref.path("byteLength").asLong() >= 0
                && ref.path("byteLength").asLong() <= ("managed-tool-result-content".equals(ref.path("kind").asText())
                        ? 16 * 1024 * 1024 : 2 * 1024 * 1024)
                && text(ref, "digest").matches("[0-9a-f]{64}"),
                "invalid_resource_reference");
    }

    private static JsonNode head(JsonNode source) {
        JsonNode value = source.path("head");
        check(value.isObject(), "session_uninitialized");
        return value;
    }

    private static JsonNode key(JsonNode head) {
        return JSON.createObjectNode().put("tenantId", text(head, "tenantId"))
                .put("workspaceId", text(head, "workspaceId")).put("sessionId", text(head, "sessionId"));
    }

    private static String scope(JsonNode head) {
        return hash(JSON.createArrayNode().add(text(head, "tenantId")).add(text(head, "workspaceId"))
                .add(text(head, "sessionId")).toString());
    }

    private static long number(Map<String, Object> row, String key) {
        return ((Number) row.get(key)).longValue();
    }

    private static void verifyBytes(byte[] bytes, long length, String digest) {
        check(bytes != null && bytes.length == length && hash(bytes).equals(digest), "resource_corrupt");
    }
}
