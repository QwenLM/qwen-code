package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.text;

/** Joins one frozen publication root and its original receipt in the Session transaction. */
public final class ToolPublicationAdmissionStore {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JdbcManagedSessionStore sessions;
    private final ToolPublicationDataStore data;
    private final DataSource transactionSource;

    public ToolPublicationAdmissionStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            JdbcManagedSessionStore sessions, ToolPublicationDataStore data) {
        this.jdbc = Objects.requireNonNull(jdbc);
        this.transactions = new TransactionTemplate(Objects.requireNonNull(manager));
        this.sessions = Objects.requireNonNull(sessions);
        this.data = Objects.requireNonNull(data);
        this.transactionSource = manager instanceof DataSourceTransactionManager nativeManager
                ? nativeManager.getDataSource() : null;
    }

    boolean usesDataSource(DataSource source) {
        return source != null && jdbc.getDataSource() == source && transactionSource == source
                && sessions.usesDataSource(source)
                && data.usesDataSource(source);
    }

    public JsonNode verifyReceipt(JsonNode key, String writerToken, JsonNode request) {
        sessions.restore(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), writerToken);
        JsonNode expected = request.path("toolOutcomeRef");
        var rows = jdbc.query("SELECT publication_id, admission_resource_id,"
                + " receipt_sequence, receipt_revision FROM ma_output_capture"
                + " WHERE scope_ref = ? AND tenant_id = ? AND workspace_id = ? AND session_id = ?"
                + " AND admission_resource_id = ? AND producer_phase = 'REFERENCED'", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
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
        return commitReceipt(key, publicationId, writerToken, request, null);
    }

    public JsonNode commitReceipt(JsonNode key, String publicationId, String writerToken,
            CommitTransactionRequest request, com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority authority) {
        require(request != null && text(key, "workspaceId").equals(request.workspaceId()),
                "Receipt Workspace conflicts");
        String scope = scope(key);
        var candidates = jdbc.query("SELECT o.resource_id, o.byte_length, o.sha256,"
                + " o.capture_object_key AS object_key, o.capture_state AS state, p.producer_phase, p.terminal_resource_id,"
                + " p.admission_resource_id, p.binding_json FROM ma_output_capture p"
                + " JOIN ma_resource o ON o.scope_ref = p.scope_ref"
                + " AND o.publication_id = p.publication_id AND o.slot_key = 'admission'"
                + " WHERE p.scope_ref = ? AND p.publication_id = ? AND p.tenant_id = ?"
                + " AND p.workspace_id = ? AND p.session_id = ?", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), scope, publicationId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require(candidates.size() == 1, "Admission candidate is missing");
        Map<String, Object> candidate = candidates.get(0);
        require("VERIFIED".equals(candidate.get("state"))
                && candidate.get("resource_id").equals(candidate.get("admission_resource_id"))
                && ("FINISHED".equals(candidate.get("producer_phase"))
                || "REFERENCED".equals(candidate.get("producer_phase"))),
                "Admission root is not verified");
        // A lifecycle-authority commit takes placement in checkLifecycleWriter,
        // so its lane keeps placement first (design 2026-11-04-managed-publication-placement).
        data.lockStagedPlacement(key, publicationId, authority != null);
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
            boolean placement = data.lockPublicationPlacement(key, publicationId, authority != null);
            data.lockOriginalSettledResult(key, publicationId, finished);
            // An ordinary receipt without lifecycle authority skips the tenant
            // publication guard: the journal commit below takes none, and the
            // lane locks root, head, publication row, as collection does. A
            // lifecycle-authority commit (which takes the guard in
            // checkLifecycleWriter) keeps it (design
            // 2026-11-04-managed-publication-tenant-guards, C2).
            boolean guard = authority != null;
            if (guard) {
                lockTenant(key);
            }
            sessions.lockPublicationWriter(text(key, "tenantId"), text(key, "workspaceId"),
                    text(key, "sessionId"), request.writerId(), request.writerGeneration(), writerToken, placement, guard);
            Map<String, Object> publication = jdbc.query("SELECT producer_phase, binding_json, binding_digest,"
                    + " CASE WHEN is_quarantined THEN 1 ELSE 0 END AS is_quarantined, admission_resource_id,"
                    + " receipt_sequence, receipt_revision, finish_digest, terminal_resource_id"
                    + " FROM ma_output_capture WHERE scope_ref = ? AND publication_id = ? AND tenant_id = ?"
                    + " AND workspace_id = ? AND session_id = ? FOR UPDATE", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), scope, publicationId,
                    text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId")).getFirst();
            ToolPublicationStore.requireLockedBinding(publication, finished.path("binding"));
            require(resourceId.equals(publication.get("admission_resource_id"))
                    && candidate.get("terminal_resource_id").equals(publication.get("terminal_resource_id"))
                    && ((Number) publication.get("is_quarantined")).intValue() == 0,
                    "Admission root changed");
            var object = jdbc.query("SELECT capture_state AS state, sha256, byte_length, capture_object_key AS object_key"
                    + " FROM ma_resource WHERE scope_ref = ? AND publication_id = ?"
                    + " AND slot_key = 'admission'", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), scope, publicationId).getFirst();
            require("VERIFIED".equals(object.get("state"))
                    && candidate.get("sha256").equals(object.get("sha256"))
                    && ((Number) candidate.get("byte_length")).longValue()
                    == ((Number) object.get("byte_length")).longValue()
                    && Objects.equals(candidate.get("object_key"), object.get("object_key")),
                    "Admission resource changed");
            if ("REFERENCED".equals(publication.get("producer_phase"))) {
                var committed = sessions.commit(text(key, "tenantId"), text(key, "sessionId"),
                        writerToken, request, authority);
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
                    writerToken, request, authority);
            jdbc.update("UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", producer_phase = 'REFERENCED', admission_held_bytes = admission_used_bytes, receipt_sequence = ?, receipt_revision = ?, is_accepted_complete = ? WHERE scope_ref = ? AND publication_id = ?",
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
        // A cleanup commit takes placement in JournalCommit, after this lane's
        // Session root when the lane skips placement; a receipt never carries one.
        require(!HostedCleanupReferences.containsCleanup(records), "Receipt cannot carry hosted cleanup");
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
        referenceCapturedResource(key, request, ref, bytes, objectKey, "managed-tool-outcome");
    }

    private void installManifestResource(JsonNode key, CommitTransactionRequest request,
            JsonNode ref, byte[] bytes) {
        referenceCapturedResource(key, request, ref, bytes, null, "managed-tool-result-manifest");
    }

    private void referenceCapturedResource(JsonNode key, CommitTransactionRequest request,
            JsonNode ref, byte[] bytes, String objectKey, String kind) {
        String resourceId = text(ref, "resourceId");
        var rows = jdbc.query("SELECT state, kind, byte_length, sha256, capture_state, publish_command_id"
                        + " FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?"
                        + " AND workspace_id = ? FOR UPDATE",
                (row, index) -> ManagedSchemaRows.read(row), text(key, "tenantId"), text(key, "sessionId"), resourceId,
                text(key, "workspaceId"));
        require(rows.size() == 1, "Captured receipt resource is missing");
        var row = rows.getFirst();
        require(kind.equals(row.get("kind")) && kind.equals(text(ref, "kind"))
                        && "VERIFIED".equals(row.get("capture_state"))
                        && bytes.length == ((Number) row.get("byte_length")).longValue()
                        && bytes.length == ref.path("byteLength").asLong(-1)
                        && ToolPublicationContract.sha256(bytes).equals(row.get("sha256"))
                        && row.get("sha256").equals(text(ref, "digest")), "Captured receipt resource changed");
        if ("REFERENCED".equals(row.get("state"))) {
            require(request.commandId().equals(row.get("publish_command_id")), "Receipt resource owner changed");
            return;
        }
        require("PUBLISHED".equals(row.get("state")), "Receipt resource cannot be referenced");
        boolean inline = bytes.length <= ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES;
        require(inline || objectKey != null, "Large receipt resource has no object");
        int changed = jdbc.update("UPDATE ma_resource SET storage_kind = ?, inline_bytes = ?, object_key = ?, publish_command_id = ?, state = 'REFERENCED', last_verified_at = " + ManagedSchemaTime.SQL_NOW + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ? AND state = 'PUBLISHED' AND capture_state = 'VERIFIED'",
                inline ? "MYSQL_INLINE" : "TOOL_PUBLICATION", inline ? bytes : null,
                inline ? null : objectKey, request.commandId(), text(key, "tenantId"), text(key, "sessionId"), resourceId);
        require(changed == 1, "Receipt resource changed during publication");
    }

    private JsonNode replay(JsonNode key, JsonNode binding, JsonNode outcome,
            JsonNode outcomeRef, Map<String, Object> publication) {
        long revision = ((Number) publication.get("receipt_revision")).longValue();
        long sequence = ((Number) publication.get("receipt_sequence")).longValue();
        require(revision > 0 && sequence > 0, "Original receipt pointer is invalid");
        var journalRows = jdbc.query("SELECT record_bytes, record_digest, byte_length FROM"
                + " ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                (row, index) -> ManagedSchemaRows.read(row),
                text(key, "tenantId"), text(key, "sessionId"), revision);
        require(journalRows.size() == 1, "Original receipt is missing");
        byte[] records = (byte[]) journalRows.getFirst().get("record_bytes");
        if (records == null) {
            JdbcJournalPacks packs = sessions.journalPacks();
            records = packs == null ? null : packs.resolveBytes(text(key, "tenantId"),
                    text(key, "sessionId"), revision,
                    (String) journalRows.getFirst().get("record_digest"),
                    ((Number) journalRows.getFirst().get("byte_length")).longValue());
        }
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
        // This lane's publication-guard acquisition, bounded with the shared
        // named-failure mapping (#13800).
        JdbcManagedSessionStore.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(jdbc,
                text(key, "tenantId"), JdbcManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
    }

    private static String scope(JsonNode key) {
        return ManagedIdentityRefs.publicationScopeRef(text(key, "tenantId"),
                text(key, "workspaceId"), text(key, "sessionId"));
    }
}
