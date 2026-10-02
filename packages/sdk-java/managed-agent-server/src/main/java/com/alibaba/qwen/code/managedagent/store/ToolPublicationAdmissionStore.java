package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.text;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Joins one frozen publication root and its original receipt in the Session transaction. */
public final class ToolPublicationAdmissionStore {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ManagedSessionStore sessions;
    private final ToolPublicationDataStore data;

    public ToolPublicationAdmissionStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedSessionStore sessions, ToolPublicationDataStore data) {
        this.jdbc = Objects.requireNonNull(jdbc);
        this.transactions = new TransactionTemplate(Objects.requireNonNull(manager));
        this.sessions = Objects.requireNonNull(sessions);
        this.data = Objects.requireNonNull(data);
    }

    public JsonNode verifyReceipt(JsonNode key, String writerToken, JsonNode request) {
        sessions.restore(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), writerToken);
        JsonNode expected = request.path("toolOutcomeRef");
        var rows = jdbc.queryForList("SELECT publication_id, admission_resource_id,"
                + " receipt_sequence, receipt_revision FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND tenant_id = ? AND workspace_id = ? AND session_id = ?"
                + " AND admission_resource_id = ? AND producer_phase = 'REFERENCED'",
                scope(key), text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"),
                text(expected, "resourceId"));
        require(rows.size() == 1, "Original committed publication is missing or ambiguous");
        var publication = rows.get(0);
        String publicationId = (String) publication.get("publication_id");
        JsonNode finished = data.verifyFinished(key, publicationId, writerToken);
        byte[] bytes = data.readResource(key, publicationId, text(expected, "resourceId"));
        JsonNode ref = JSON.createObjectNode().put("resourceId", text(expected, "resourceId"))
                .put("kind", "managed-tool-outcome").put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", ToolPublicationContract.sha256(bytes));
        JsonNode outcome = ToolPublicationContract.readJson(bytes);
        JsonNode binding = finished.path("binding");
        require(ref.equals(expected)
                && text(binding, "executionCallId").equals(text(request, "executionCallId"))
                && outcome.path("envelope").equals(finished.path("result"))
                && outcome.path("manifestRef").equals(request.path("manifestRef")),
                "Original publication receipt conflicts");
        JsonNode receipt = replay(key, binding, outcome, ref, publication);
        JsonNode sequence = request.path("historyRevision");
        require(sequence.isIntegralNumber() && sequence.canConvertToLong()
                && receipt.path("historyRevision").longValue() == sequence.longValue(),
                "Original publication receipt sequence conflicts");
        return receipt;
    }

    public JsonNode commitReceipt(JsonNode key, String publicationId, String writerToken,
            CommitTransactionRequest request) {
        require(request != null && text(key, "workspaceId").equals(request.workspaceId()),
                "Receipt Workspace conflicts");
        String scope = scope(key);
        var candidates = jdbc.queryForList("SELECT o.resource_id, o.byte_length, o.sha256,"
                + " o.object_key, o.state, p.producer_phase, p.terminal_resource_id,"
                + " p.admission_resource_id, p.binding_json FROM qwen_tool_publication p"
                + " JOIN qwen_tool_publication_object o ON o.scope_key = p.scope_key"
                + " AND o.publication_id = p.publication_id AND o.slot_key = 'admission'"
                + " WHERE p.scope_key = ? AND p.publication_id = ? AND p.tenant_id = ?"
                + " AND p.workspace_id = ? AND p.session_id = ?", scope, publicationId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require(candidates.size() == 1, "Admission candidate is missing");
        Map<String, Object> candidate = candidates.get(0);
        require("VERIFIED".equals(candidate.get("state"))
                && candidate.get("resource_id").equals(candidate.get("admission_resource_id"))
                && ("FINISHED".equals(candidate.get("producer_phase"))
                || "REFERENCED".equals(candidate.get("producer_phase"))),
                "Admission root is not verified");
        String resourceId = (String) candidate.get("resource_id");
        byte[] admissionBytes = data.readResource(key, publicationId, resourceId);
        JsonNode outcome = ToolPublicationContract.readJson(admissionBytes);
        JsonNode finished = data.finished(key, publicationId, writerToken);
        require(finished.path("terminal").path("resourceId").asText()
                .equals(candidate.get("terminal_resource_id"))
                && finished.path("result").equals(outcome.path("envelope")),
                "Original finished result changed");
        JsonNode outcomeRef = JSON.createObjectNode().put("resourceId", resourceId)
                .put("kind", "managed-tool-outcome").put("schemaVersion", 1)
                .put("byteLength", admissionBytes.length)
                .put("digest", ToolPublicationContract.sha256(admissionBytes));
        require(outcomeRef.path("digest").asText().equals(candidate.get("sha256"))
                && admissionBytes.length == ((Number) candidate.get("byte_length")).longValue(),
                "Admission bytes changed");
        JsonNode binding = ToolPublicationContract.readJson(
                ((String) candidate.get("binding_json")).getBytes(StandardCharsets.UTF_8));
        validateReceipt(key, binding, outcome, outcomeRef, request, publicationId);
        JsonNode manifestRef = outcome.path("manifestRef");
        byte[] manifestBytes = manifestRef.isNull() ? null
                : data.readResource(key, publicationId, text(manifestRef, "resourceId"));
        if (manifestBytes != null) {
            require("managed-tool-result-manifest".equals(text(manifestRef, "kind"))
                    && manifestBytes.length == manifestRef.path("byteLength").asLong(-1)
                    && ToolPublicationContract.sha256(manifestBytes).equals(text(manifestRef, "digest"))
                    && manifestBytes.length <= ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES,
                    "Original manifest resource conflicts");
        }
        return transactions.execute(status -> {
            lockTenant(key);
            sessions.lockPublicationWriter(text(key, "tenantId"), text(key, "workspaceId"),
                    text(key, "sessionId"), request.writerId(), request.writerGeneration(), writerToken);
            Map<String, Object> publication = jdbc.queryForMap("SELECT producer_phase,"
                    + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined, admission_resource_id,"
                    + " receipt_sequence, receipt_revision, finish_digest, terminal_resource_id"
                    + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                    scope, publicationId);
            require(resourceId.equals(publication.get("admission_resource_id"))
                    && candidate.get("terminal_resource_id").equals(publication.get("terminal_resource_id"))
                    && ((Number) publication.get("quarantined")).intValue() == 0,
                    "Admission root changed");
            var object = jdbc.queryForMap("SELECT state, sha256, byte_length, object_key"
                    + " FROM qwen_tool_publication_object WHERE scope_key = ? AND publication_id = ?"
                    + " AND slot_key = 'admission'", scope, publicationId);
            require("VERIFIED".equals(object.get("state"))
                    && candidate.get("sha256").equals(object.get("sha256"))
                    && ((Number) candidate.get("byte_length")).longValue()
                    == ((Number) object.get("byte_length")).longValue()
                    && Objects.equals(candidate.get("object_key"), object.get("object_key")),
                    "Admission resource changed");
            if ("REFERENCED".equals(publication.get("producer_phase"))) {
                var committed = sessions.commit(text(key, "tenantId"), text(key, "sessionId"),
                        writerToken, request);
                require(committed.journalRevision() == ((Number) publication.get("receipt_revision")).longValue()
                        && committed.lastSequence() == ((Number) publication.get("receipt_sequence")).longValue(),
                        "Receipt replay conflicts with original transaction");
                return replay(key, binding, outcome, outcomeRef, publication);
            }
            require("FINISHED".equals(publication.get("producer_phase")),
                    "Publication is not ready for receipt");
            installSessionResource(key, request, outcomeRef, admissionBytes,
                    (String) object.get("object_key"));
            if (manifestBytes != null) {
                installManifestResource(key, request, manifestRef, manifestBytes);
            }
            var receipt = sessions.commit(text(key, "tenantId"), text(key, "sessionId"),
                    writerToken, request);
            jdbc.update("UPDATE qwen_tool_publication SET producer_phase = 'REFERENCED',"
                            + " admission_held_bytes = admission_used_bytes, receipt_sequence = ?,"
                            + " receipt_revision = ?, accepted_complete = ? WHERE scope_key = ? AND publication_id = ?",
                    request.lastSequence(), receipt.journalRevision(),
                    "committed".equals(outcome.path("decision").asText())
                            && "complete".equals(outcome.path("envelope").path("capture").path("captureStatus").asText()),
                    scope, publicationId);
            return response(outcome, outcomeRef, request.lastSequence(), receipt.journalRevision());
        });
    }

    private void validateReceipt(JsonNode key, JsonNode binding, JsonNode outcome,
            JsonNode outcomeRef, CommitTransactionRequest request, String publicationId) {
        require("recordToolResult".equals(request.operation())
                && text(binding, "executionCallId").equals(request.commandId())
                && request.eventCount() == 1 && request.firstSequence() == request.lastSequence()
                && request.contentDigest().equals(text(outcomeRef, "digest")),
                "Receipt command conflicts with original execution");
        List<CommitResource> refs = request.resources();
        require(refs != null && refs.stream().anyMatch(resource ->
                resource.resourceId().equals(text(outcomeRef, "resourceId"))
                        && resource.kind().equals("managed-tool-outcome")
                        && resource.byteLength() == outcomeRef.path("byteLength").asLong()
                        && resource.digest().equals(text(outcomeRef, "digest"))
                        && resource.bytesBase64() == null),
                "Receipt does not reference its original admission resource");
        byte[] records = Base64.getDecoder().decode(request.recordBytesBase64());
        JsonNode receiptEvent = null;
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = ToolPublicationContract.readJson(line.getBytes(StandardCharsets.UTF_8));
            if ("managed_session_event_v1".equals(text(record, "subtype"))
                    && "tool.receipt".equals(text(record.path("managedSession"), "kind"))) {
                require(receiptEvent == null, "Receipt transaction has duplicate events");
                receiptEvent = record.path("managedSession");
            }
        }
        require(receiptEvent != null && receiptEvent.path("sessionKey").equals(key)
                && receiptEvent.path("sequence").asLong(-1) == request.lastSequence(),
                "Original receipt event is missing");
        JsonNode payload = receiptEvent.path("payload");
        JsonNode manifest = outcome.path("manifestRef");
        require(text(binding, "executionCallId").equals(text(payload, "executionCallId"))
                && outcomeRef.equals(payload.path("toolOutcomeRef"))
                && payload.path("historyRevision").asLong(-1) == request.lastSequence()
                && ("committed".equals(text(outcome, "decision"))
                ? manifest.equals(payload.path("resultRef"))
                : payload.path("resultRef").isNull()),
                "Receipt payload conflicts with admission decision");
        JsonNode resources = payload.path("resources");
        require(resources.isArray() && (manifest.isNull()
                ? resources.isEmpty() : resources.size() == 1 && manifest.equals(resources.get(0))),
                "Receipt manifest resources conflict");
        require(outcome.path("envelope").path("capture").path("manifest").equals(manifest)
                && publicationId != null, "Receipt capture reference conflicts");
    }

    private void installSessionResource(JsonNode key, CommitTransactionRequest request,
            JsonNode ref, byte[] bytes, String objectKey) {
        String scopeKey = ToolPublicationContract.sha256((text(key, "tenantId") + "\u0000"
                + text(key, "sessionId")).getBytes(StandardCharsets.UTF_8));
        String resourceId = text(ref, "resourceId");
        Long existing = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource"
                + " WHERE session_scope_key = ? AND resource_id = ?", Long.class, scopeKey, resourceId);
        if (existing != null && existing > 0) {
            return;
        }
        boolean inline = bytes.length <= ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES;
        require(inline || objectKey != null, "Large admission has no object");
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                        + " inline_bytes, object_key, publish_command_id, state, created_at, last_verified_at)"
                        + " VALUES (?, ?, ?, ?, ?, 'managed-tool-outcome', 1, ?, ?, ?, ?, ?, ?, 'REFERENCED', ?, ?)",
                scopeKey, text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"),
                resourceId, bytes.length, text(ref, "digest"), inline ? "MYSQL_INLINE" : "TOOL_PUBLICATION",
                inline ? bytes : null, inline ? null : objectKey, request.commandId(),
                jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class),
                jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class));
    }

    private void installManifestResource(JsonNode key, CommitTransactionRequest request,
            JsonNode ref, byte[] bytes) {
        String resourceId = text(ref, "resourceId");
        String scopeKey = ToolPublicationContract.sha256((text(key, "tenantId") + "\u0000"
                + text(key, "sessionId")).getBytes(StandardCharsets.UTF_8));
        Long existing = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource"
                + " WHERE session_scope_key = ? AND resource_id = ?", Long.class, scopeKey, resourceId);
        if (existing != null && existing > 0) {
            return;
        }
        Timestamp now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class);
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256,"
                        + " storage_kind, inline_bytes, publish_command_id, state, created_at, last_verified_at)"
                        + " VALUES (?, ?, ?, ?, ?, 'managed-tool-result-manifest', 1, ?, ?, 'MYSQL_INLINE',"
                        + " ?, ?, 'REFERENCED', ?, ?)", scopeKey, text(key, "tenantId"),
                text(key, "workspaceId"), text(key, "sessionId"), resourceId,
                bytes.length, text(ref, "digest"), bytes, request.commandId(), now, now);
    }

    private JsonNode replay(JsonNode key, JsonNode binding, JsonNode outcome,
            JsonNode outcomeRef, Map<String, Object> publication) {
        long revision = ((Number) publication.get("receipt_revision")).longValue();
        long sequence = ((Number) publication.get("receipt_sequence")).longValue();
        require(revision > 0 && sequence > 0, "Original receipt pointer is invalid");
        byte[] records = jdbc.queryForObject("SELECT record_bytes FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                byte[].class, text(key, "tenantId"), text(key, "sessionId"), revision);
        require(records != null, "Original receipt is missing");
        JsonNode event = null;
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = ToolPublicationContract.readJson(line.getBytes(StandardCharsets.UTF_8));
            if ("managed_session_event_v1".equals(text(record, "subtype"))
                    && "tool.receipt".equals(text(record.path("managedSession"), "kind"))) {
                event = record.path("managedSession");
            }
        }
        require(event != null && event.path("sequence").asLong(-1) == sequence
                && event.path("sessionKey").equals(key)
                && text(binding, "executionCallId").equals(text(event.path("payload"), "executionCallId"))
                && outcomeRef.equals(event.path("payload").path("toolOutcomeRef")),
                "Original receipt changed");
        return response(outcome, outcomeRef, sequence, revision);
    }

    private static JsonNode response(JsonNode outcome, JsonNode outcomeRef,
            long sequence, long revision) {
        ObjectNode response = JSON.createObjectNode().put("decision", text(outcome, "decision"))
                .put("historyRevision", sequence).put("journalRevision", revision);
        response.set("toolOutcomeRef", outcomeRef);
        response.set("manifestRef", outcome.path("manifestRef"));
        return response;
    }

    private void lockTenant(JsonNode key) {
        String tenant = text(key, "tenantId");
        String tenantKey = ToolPublicationContract.sha256(tenant.getBytes(StandardCharsets.UTF_8));
        jdbc.update("INSERT INTO qwen_tool_publication_tenant (tenant_key, tenant_id) VALUES (?, ?)"
                + " ON DUPLICATE KEY UPDATE tenant_key = tenant_key", tenantKey, tenant);
        String saved = jdbc.queryForObject("SELECT tenant_id FROM qwen_tool_publication_tenant"
                + " WHERE tenant_key = ? FOR UPDATE", String.class, tenantKey);
        require(tenant.equals(saved), "Receipt tenant conflicts");
    }

    private static String scope(JsonNode key) {
        return ToolPublicationContract.sha256(JSON.createArrayNode().add(text(key, "tenantId"))
                .add(text(key, "workspaceId")).add(text(key, "sessionId"))
                .toString().getBytes(StandardCharsets.UTF_8));
    }
}
