package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.text;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import javax.sql.DataSource;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Joins one frozen publication root and its original receipt in the Session transaction. */
public final class ToolPublicationAdmissionStore {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ManagedSessionStore sessions;
    private final ToolPublicationDataStore data;
    private final DataSource transactionSource;

    public ToolPublicationAdmissionStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedSessionStore sessions, ToolPublicationDataStore data) {
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

    static final class AcknowledgementBundle {
        private final ToolPublicationAdmissionStore owner;
        private final ToolPublicationDataStore.VerifiedAcknowledgement resources;
        private final String receipt;
        private final String catalog;
        private final long receiptJournalRevision;
        private final long receiptSequence;

        private AcknowledgementBundle(ToolPublicationAdmissionStore owner,
                ToolPublicationDataStore.VerifiedAcknowledgement resources, JsonNode receipt,
                JsonNode catalog, long revision, long sequence) {
            this.owner = owner;
            this.resources = resources;
            this.receipt = receipt.toString();
            this.catalog = catalog.toString();
            this.receiptJournalRevision = revision;
            this.receiptSequence = sequence;
        }

        JsonNode finished() { return resources.finished(); }
        JsonNode outcomeRef() { return resources.outcomeRef(); }
        JsonNode receipt() { return ToolPublicationDataStore.exactAcknowledgementJson(receipt.getBytes(StandardCharsets.UTF_8)); }
        JsonNode captureIdentity() { return resources.captureIdentity(); }
        long receiptJournalRevision() { return receiptJournalRevision; }
        long receiptSequence() { return receiptSequence; }
        JsonNode catalogSnapshot() {
            ObjectNode result = JSON.createObjectNode();
            result.set("publication", resources.catalog());
            result.set("receipt", ToolPublicationDataStore.exactAcknowledgementJson(catalog.getBytes(StandardCharsets.UTF_8)));
            return result;
        }
    }

    AcknowledgementBundle verifyOriginalAcknowledgement(ToolExecutionRecord execution) {
        require(!TransactionSynchronizationManager.isActualTransactionActive()
                && !TransactionSynchronizationManager.isSynchronizationActive()
                && !TransactionSynchronizationManager.hasResource(jdbc.getDataSource())
                && usesDataSource(jdbc.getDataSource()),
                "Acknowledgement verification requires native stores outside a transaction");
        var verified = data.verifyOriginalAcknowledgementResources(execution);
        JsonNode catalog = acknowledgementReceiptCatalog(verified, false);
        long revision = catalog.path("publication").path("receipt_revision").longValue();
        long sequence = catalog.path("publication").path("receipt_sequence").longValue();
        ObjectNode receipt = JSON.createObjectNode().put("executionCallId", execution.getExecutionCallId())
                .put("deliveryStatus", "committed").put("historyRevision", sequence);
        receipt.set("manifest", verified.outcome().path("manifestRef"));
        return new AcknowledgementBundle(this, verified, receipt, catalog, revision, sequence);
    }

    ToolExecutionRecord lockOriginalAcknowledgement(AcknowledgementBundle bundle) {
        require(bundle != null && bundle.owner == this && usesDataSource(jdbc.getDataSource())
                && TransactionSynchronizationManager.isActualTransactionActive(),
                "Acknowledgement settlement requires its native transaction");
        ToolExecutionRecord actual = data.lockOriginalAcknowledgementResources(bundle.resources);
        JsonNode current = acknowledgementReceiptCatalog(bundle.resources, true);
        require(ToolPublicationDataStore.sameNumericJson(ToolPublicationDataStore.exactAcknowledgementJson(
                bundle.catalog.getBytes(StandardCharsets.UTF_8)), current),
                "Original committed receipt authorities changed");
        data.lockOriginalAcknowledgementCatalog(bundle.resources);
        // The dependency locks may have waited beyond the original owner/activation lease.
        data.lockOriginalAcknowledgementResources(bundle.resources);
        return actual;
    }

    private JsonNode acknowledgementReceiptCatalog(ToolPublicationDataStore.VerifiedAcknowledgement verified,
            boolean locked) {
        JsonNode finished = verified.finished();
        JsonNode binding = finished.path("binding");
        JsonNode key = binding.path("sessionKey");
        String id = text(finished, "publicationId");
        String suffix = locked ? " FOR UPDATE" : "";
        var publication = jdbc.queryForMap("SELECT scope_key, publication_id, tenant_id, workspace_id, session_id, producer_phase,"
                + " admission_resource_id, receipt_sequence, receipt_revision,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?" + suffix, scope(key), id);
        require(scope(key).equals(publication.get("scope_key")) && id.equals(publication.get("publication_id"))
                && "REFERENCED".equals(publication.get("producer_phase"))
                && ((Number) publication.get("quarantined")).intValue() == 0
                && text(key, "tenantId").equals(publication.get("tenant_id"))
                && text(key, "workspaceId").equals(publication.get("workspace_id"))
                && text(key, "sessionId").equals(publication.get("session_id"))
                && text(verified.outcomeRef(), "resourceId").equals(publication.get("admission_resource_id")),
                "Original referenced publication conflicts");
        long revision = positiveCounter(publication.get("receipt_revision"));
        long sequence = positiveCounter(publication.get("receipt_sequence"));
        var head = jdbc.queryForMap("SELECT journal_revision, committed_sequence FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ?" + suffix, text(key, "tenantId"), text(key, "sessionId"));
        require(positiveCounter(head.get("journal_revision")) >= revision
                && positiveCounter(head.get("committed_sequence")) >= sequence,
                "Original receipt exceeds the committed Session head");
        var journal = jdbc.queryForMap("SELECT tenant_id, workspace_id, session_id, journal_revision, transaction_id,"
                + " operation, command_id, content_digest, first_sequence, last_sequence, event_count, events_digest,"
                + " previous_commit_digest, commit_digest, writer_id, writer_generation, activation_epoch,"
                + " latest_checkpoint_resource_id, record_encoding, record_bytes, byte_length, record_digest"
                + " FROM qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                + " AND journal_revision = ?" + suffix, text(key, "tenantId"), text(key, "sessionId"), revision);
        JsonNode outcomeRef = verified.outcomeRef();
        require(text(key, "tenantId").equals(journal.get("tenant_id"))
                && text(key, "workspaceId").equals(journal.get("workspace_id"))
                && text(key, "sessionId").equals(journal.get("session_id"))
                && positiveCounter(journal.get("journal_revision")) == revision
                && "recordToolResult".equals(journal.get("operation"))
                && text(binding, "executionCallId").equals(journal.get("command_id"))
                && text(outcomeRef, "digest").equals(journal.get("content_digest"))
                && positiveCounter(journal.get("first_sequence")) == sequence
                && positiveCounter(journal.get("last_sequence")) == sequence
                && ((Number) journal.get("event_count")).longValue() == 1
                && text(binding, "writerId").equals(journal.get("writer_id"))
                && positiveCounter(journal.get("writer_generation")) == binding.path("writerGeneration").longValue()
                && positiveCounter(journal.get("activation_epoch")) == binding.path("activationEpoch").longValue()
                && "identity".equals(journal.get("record_encoding")), "Original receipt transaction conflicts");
        Object raw = journal.remove("record_bytes");
        require(raw instanceof byte[], "Original receipt bytes are missing");
        byte[] bytes = (byte[]) raw;
        require(bytes.length > 0 && bytes.length <= ManagedSessionStoreModels.MAX_TRANSACTION_BYTES
                && bytes.length == positiveCounter(journal.get("byte_length"))
                && ToolPublicationContract.sha256(bytes).equals(journal.get("record_digest")),
                "Original receipt transaction digest conflicts");
        String records;
        try {
            records = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException("Original receipt bytes are not UTF-8");
        }
        JsonNode event = null;
        for (String line : records.split("\n")) {
            JsonNode record = ToolPublicationDataStore.exactAcknowledgementJson(line.getBytes(StandardCharsets.UTF_8));
            if ("managed_session_event_v1".equals(text(record, "subtype"))) {
                require(event == null, "Original receipt transaction has extra events");
                event = record.path("managedSession");
            }
        }
        JsonNode manifest = verified.outcome().path("manifestRef");
        require(event != null && event.path("v").isIntegralNumber() && event.path("v").canConvertToLong()
                && event.path("v").longValue() == 1
                && "tool.receipt".equals(text(event, "kind")) && event.path("sessionKey").equals(key)
                && event.path("sequence").isIntegralNumber() && event.path("sequence").canConvertToLong()
                && event.path("sequence").longValue() == sequence,
                "Original committed receipt event conflicts");
        JsonNode payload = event.path("payload");
        Set<String> fields = new java.util.HashSet<>();
        payload.fieldNames().forEachRemaining(fields::add);
        require(fields.equals(Set.of("executionCallId", "toolOutcomeRef", "resultRef", "resources", "historyRevision"))
                && text(binding, "executionCallId").equals(text(payload, "executionCallId"))
                && outcomeRef.equals(payload.path("toolOutcomeRef")) && manifest.equals(payload.path("resultRef"))
                && payload.path("historyRevision").isIntegralNumber()
                && payload.path("historyRevision").canConvertToLong()
                && payload.path("historyRevision").longValue() == sequence
                && payload.path("resources").isArray() && payload.path("resources").size() == 1
                && manifest.equals(payload.path("resources").get(0)), "Original receipt payload conflicts");
        ObjectNode result = JSON.createObjectNode();
        result.set("publication", JSON.valueToTree(publication));
        result.set("journal", JSON.valueToTree(journal));
        var resources = result.putArray("resources");
        for (JsonNode ref : List.of(outcomeRef, manifest)) {
            String resourceId = text(ref, "resourceId");
            String sessionScope = ManagedSessionStore.sessionScopeKey(text(key, "tenantId"), text(key, "sessionId"));
            var resource = jdbc.queryForMap("SELECT tenant_id, workspace_id, session_id, resource_id, kind, schema_version,"
                    + " byte_length, sha256, storage_kind, inline_bytes, object_key, object_version_id, encryption_key_id,"
                    + " publish_command_id, state FROM qwen_managed_session_resource"
                    + " WHERE session_scope_key = ? AND resource_id = ?" + suffix, sessionScope, resourceId);
            require(text(key, "tenantId").equals(resource.get("tenant_id"))
                    && text(key, "workspaceId").equals(resource.get("workspace_id"))
                    && text(key, "sessionId").equals(resource.get("session_id"))
                    && resourceId.equals(resource.get("resource_id")) && text(ref, "kind").equals(resource.get("kind"))
                    && positiveCounter(resource.get("schema_version")) == 1
                    && positiveCounter(resource.get("byte_length")) == ref.path("byteLength").longValue()
                    && text(ref, "digest").equals(resource.get("sha256")) && "REFERENCED".equals(resource.get("state"))
                    && resource.get("object_version_id") == null && resource.get("encryption_key_id") == null,
                    "Original referenced Session resource conflicts");
            Object inline = resource.remove("inline_bytes");
            if ("MYSQL_INLINE".equals(resource.get("storage_kind"))) {
                require(inline instanceof byte[] body && body.length == ref.path("byteLength").longValue()
                        && ToolPublicationContract.sha256(body).equals(text(ref, "digest"))
                        && resource.get("object_key") == null, "Original inline Session resource conflicts");
                resource.put("inlineDigest", text(ref, "digest"));
            } else {
                require("TOOL_PUBLICATION".equals(resource.get("storage_kind")) && inline == null
                        && "managed-tool-outcome".equals(text(ref, "kind"))
                        && resource.get("object_key") instanceof String, "Original Session resource storage conflicts");
                JsonNode admission = null;
                for (JsonNode object : verified.catalog().path("objects")) {
                    if ("admission".equals(object.path("slot_key").asText())) {
                        admission = object;
                    }
                }
                require(admission != null && admission.path("object_key").asText().equals(resource.get("object_key"))
                        && resourceId.equals(text(admission, "resource_id"))
                        && text(ref, "kind").equals(text(admission, "resource_kind"))
                        && ref.path("byteLength").longValue() == admission.path("byte_length").longValue()
                        && text(ref, "digest").equals(text(admission, "sha256")),
                        "Original external admission resource conflicts");
            }
            var reference = jdbc.queryForMap("SELECT tenant_id, workspace_id, session_id, resource_id, journal_revision"
                    + " FROM qwen_managed_session_resource_ref WHERE session_scope_key = ?"
                    + " AND resource_id = ? AND journal_revision = ?" + suffix, sessionScope, resourceId, revision);
            require(text(key, "tenantId").equals(reference.get("tenant_id"))
                    && text(key, "workspaceId").equals(reference.get("workspace_id"))
                    && text(key, "sessionId").equals(reference.get("session_id"))
                    && resourceId.equals(reference.get("resource_id"))
                    && positiveCounter(reference.get("journal_revision")) == revision,
                    "Original receipt resource reference conflicts");
            ObjectNode item = JSON.createObjectNode();
            item.set("resource", JSON.valueToTree(resource));
            item.set("reference", JSON.valueToTree(reference));
            resources.add(item);
        }
        return result;
    }

    private static long positiveCounter(Object value) {
        require(value instanceof Number, "Original receipt counter is missing");
        long count = ((Number) value).longValue();
        require(count > 0 && count <= ManagedSessionStoreModels.MAX_SAFE_COUNTER,
                "Original receipt counter is invalid");
        return count;
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
        data.requireStagedCall(key, publicationId);
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
            data.lockOriginalSettledResult(key, publicationId, finished);
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
