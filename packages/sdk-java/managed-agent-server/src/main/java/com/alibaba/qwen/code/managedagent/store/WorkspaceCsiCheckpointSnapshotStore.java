package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** A private component snapshot; it cannot authorize settlement or release. */
public final class WorkspaceCsiCheckpointSnapshotStore {
    public static final String FORMAT = "qwen-csi-receipt-checkpoint-snapshot/1";
    private static final long MAX_BYTES = 32L * 1024 * 1024;
    private static final int MAX_ROWS = 4096;
    private static final int MAX_JSON_BYTES = 48 * 1024 * 1024;
    private static final Set<String> TABLES = Set.of("managed_workspace_csi_retirement",
            "managed_workspace_csi_registration", "managed_workspace_execution_lease",
            "qwen_runtime_binding", "qwen_runtime_binding_slot", "qwen_runtime_session",
            "qwen_tool_execution", "qwen_tool_publication", "qwen_tool_publication_object",
            "qwen_managed_session_journal_head", "qwen_managed_session_journal_tx",
            "qwen_managed_session_resource", "qwen_managed_session_resource_ref");
    private final DataSource source;
    private final JdbcRuntimeBindingRepository bindings;
    private final ObjectMapper json;

    public WorkspaceCsiCheckpointSnapshotStore(DataSource source,
            JdbcRuntimeBindingRepository bindings, ObjectMapper json) {
        require(source != null && bindings != null && bindings.usesDataSource(source) && json != null);
        this.source = source;
        this.bindings = bindings;
        this.json = json.copy().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    }

    public ObjectNode exportOriginalPublication(String retirementId, String tenantId,
            String workspaceId, String sessionId, String publicationId) {
        require(!TransactionSynchronizationManager.isActualTransactionActive());
        require(uuid(retirementId) && id(tenantId, 128) && id(workspaceId, 512)
                && id(sessionId, 512) && id(publicationId, 128));
        ObjectNode key = json.createObjectNode().put("tenantId", tenantId)
                .put("workspaceId", workspaceId).put("sessionId", sessionId);
        try (Connection connection = source.getConnection()) {
            require(connection.getAutoCommit()
                    && "MySQL".equals(connection.getMetaData().getDatabaseProductName()));
            connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            connection.setReadOnly(true);
            connection.setAutoCommit(false);
            try {
                try (var statement = connection.createStatement()) {
                    statement.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
                }
                requireEngines(connection);
                return export(connection, retirementId, key, publicationId);
            } finally {
                connection.rollback();
            }
        } catch (SQLException | RuntimeException error) {
            throw unavailable();
        }
    }

    private ObjectNode export(Connection connection, String retirementId,
            ObjectNode key, String publicationId) throws SQLException {
        Map<String, Object> intentRow = one(connection,
                "SELECT * FROM managed_workspace_csi_retirement WHERE retirement_id = ?", retirementId);
        WorkspaceCsiReservationStore.Retirement intent;
        try {
            String encoded = text(intentRow, "identity_json");
            require(encoded.length() <= 256 * 1024);
            intent = json.readValue(encoded, WorkspaceCsiReservationStore.Retirement.class);
        } catch (java.io.IOException error) {
            throw unavailable();
        }
        RuntimeBindingRecord runtime = bindings.findByIdInReadOnlySnapshot(connection, text(intentRow, "binding_id"));
        require(runtime != null && runtime.getRequest().isManagedContext()
                && WorkspaceCsiReservationStore.PROVISIONER_KIND.equals(runtime.getRequest().getProvisionerKind())
                && runtime.getState() == RuntimeBindingRecord.State.DRAINING && runtime.isDrainRequested()
                && runtime.getProvisionSeed() != null && runtime.getLease() != null && runtime.getResourceHandle() != null);
        require(runtime.getRequest().getScope().getTenantId().equals(key.path("tenantId").asText())
                && runtime.getRequest().getScope().getWorkspaceId().equals(key.path("workspaceId").asText()));
        ObjectNode csi = originalCsi(connection, retirementId, intentRow, intent, runtime);
        String publicationScope = ToolPublicationDataStore.scope(key);
        Map<String, Object> publication = one(connection,
                "SELECT * FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                publicationScope, publicationId);
        scope(publication, key);
        require("REFERENCED".equals(publication.get("producer_phase")) && !flag(publication, "quarantined"));
        JsonNode binding = ToolPublicationContract.parseBytes("binding",
                text(publication, "binding_json").getBytes(StandardCharsets.UTF_8));
        require(binding.path("sessionKey").equals(key) && publicationId.equals(binding.path("publicationId").asText())
                && runtime.getBindingId().equals(binding.path("runtimeBindingId").asText())
                && Long.toString(runtime.getGeneration()).equals(binding.path("bindingGeneration").asText())
                && ToolPublicationContract.bindingDigest(binding).equals(text(publication, "binding_digest"))
                && binding.path("captureId").asText().equals(text(publication, "capture_id"))
                && hash(binding.path("executionCallId").asText()).equals(text(publication, "execution_key")));
        byte[] terminalBytes = publicationBytes(connection, publicationScope, publicationId,
                text(publication, "terminal_resource_id"), "terminal", "managed-tool-terminal");
        ToolPublicationContract.parseToolResult("result", terminalBytes, ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES);
        JsonNode terminal = readExact(terminalBytes);
        require("complete".equals(terminal.path("capture").path("captureStatus").asText())
                && "pending".equals(terminal.path("capture").path("deliveryStatus").asText()));
        originalExecution(connection, runtime, intent, binding, terminal);
        Map<String, Object> head = one(connection,
                "SELECT * FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?",
                key.path("tenantId").asText(), key.path("sessionId").asText());
        scope(head, key);
        require(number(head, "storage_version") == 1 && "READY".equals(head.get("recovery_status"))
                && Set.of("ACTIVE", "SEALED").contains(text(head, "state"))
                && number(head, "compacted_through_revision") == 0
                && number(head, "activation_epoch") == binding.path("activationEpoch").longValue());
        ArrayNode transactions = transactions(connection, key, head);
        String sessionScope = ManagedSessionStore.sessionScopeKey(key.path("tenantId").asText(), key.path("sessionId").asText());
        ArrayNode resources = resources(connection, key, sessionScope, number(head, "journal_revision"));
        long revision = number(publication, "receipt_revision");
        long sequence = number(publication, "receipt_sequence");
        require(revision > 0 && revision <= number(head, "journal_revision")
                && sequence > 0 && sequence <= number(head, "committed_sequence"));
        byte[] admission = publicationBytes(connection, publicationScope, publicationId,
                text(publication, "admission_resource_id"), "admission", "managed-tool-outcome");
        JsonNode outcome = readExact(admission);
        require(outcome.path("schemaVersion").isIntegralNumber() && outcome.path("schemaVersion").bigIntegerValue().equals(java.math.BigInteger.ONE)
                && "committed".equals(outcome.path("decision").asText()) && outcome.path("envelope").equals(terminal)
                && outcome.path("manifestRef").equals(terminal.path("capture").path("manifest")));
        JsonNode outcomeRef = resourceRef(resources, text(publication, "admission_resource_id"), revision, admission);
        require("managed-tool-outcome".equals(outcomeRef.path("kind").asText()));
        JsonNode manifest = outcome.path("manifestRef");
        require(manifest.isObject());
        byte[] manifestBytes = publicationBytes(connection, publicationScope, publicationId,
                manifest.path("resourceId").asText(), null, "managed-tool-result-manifest");
        require(resourceRef(resources, manifest.path("resourceId").asText(), revision, manifestBytes).equals(manifest));
        JsonNode captureManifest = ToolPublicationContract.parseToolResult("manifest", manifestBytes,
                ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES);
        require(key.path("tenantId").equals(captureManifest.path("tenantId"))
                && key.path("sessionId").equals(captureManifest.path("sessionId"))
                && binding.path("turnId").equals(captureManifest.path("turnId"))
                && binding.path("executionCallId").equals(captureManifest.path("executionCallId"))
                && binding.path("reference").path("callId").equals(captureManifest.path("callId"))
                && binding.path("reference").path("argsDigest").equals(captureManifest.path("invocationDigest"))
                && binding.path("bindingGeneration").equals(captureManifest.path("bindingGeneration"))
                && binding.path("captureId").equals(captureManifest.path("captureId"))
                && binding.path("revision").equals(captureManifest.path("revision"))
                && binding.path("captureScope").equals(captureManifest.path("captureScope"))
                && binding.path("capturePolicy").equals(captureManifest.path("capturePolicy"))
                && terminal.path("executionStatus").equals(captureManifest.path("executionStatus"))
                && "complete".equals(captureManifest.path("captureStatus").asText()));
        JsonNode receiptTransaction = transactions.get((int) revision - 1);
        require(receiptTransaction.path("firstSequence").longValue() == sequence
                && receiptTransaction.path("lastSequence").longValue() == sequence
                && receiptTransaction.path("eventCount").intValue() == 1
                && "recordToolResult".equals(receiptTransaction.path("operation").asText())
                && binding.path("executionCallId").equals(receiptTransaction.path("commandId"))
                && outcomeRef.path("digest").equals(receiptTransaction.path("contentDigest")));
        ObjectNode original = json.createObjectNode().put("publicationId", publicationId)
                .put("receiptSequence", sequence).put("receiptRevision", revision);
        original.set("binding", binding);
        original.set("outcomeRef", outcomeRef);
        original.set("manifestRef", manifest);
        ObjectNode result = json.createObjectNode().put("format", FORMAT);
        result.set("originalCSI", csi);
        result.set("sessionKey", key);
        result.set("head", json.valueToTree(new ManagedSessionStoreModels.RestoreHead(text(head, "state"),
                (int) number(head, "storage_version"), number(head, "writer_generation"), number(head, "journal_revision"),
                number(head, "committed_sequence"), nullable(head, "last_commit_digest"), number(head, "activation_epoch"),
                nullable(head, "latest_checkpoint_resource_id"), number(head, "compacted_through_revision"),
                text(head, "recovery_status"), nullable(head, "recovery_detail_code"))));
        result.set("transactions", transactions);
        result.set("resources", resources);
        result.set("original", original);
        long total = 0;
        for (JsonNode transaction : transactions) {
            total += transaction.path("byteLength").longValue();
        }
        for (JsonNode resource : resources) {
            total += resource.path("ref").path("byteLength").longValue();
        }
        require(total <= MAX_BYTES && result.toString().getBytes(StandardCharsets.UTF_8).length <= MAX_JSON_BYTES);
        return result;
    }

    private ObjectNode originalCsi(Connection connection, String retirementId, Map<String, Object> row,
            WorkspaceCsiReservationStore.Retirement intent, RuntimeBindingRecord runtime) throws SQLException {
        RuntimeProvisionRequest request = runtime.getRequest();
        Map<String, Object> registrationRow = one(connection,
                "SELECT * FROM managed_workspace_csi_registration WHERE alias_key = ?",
                WorkspaceCsiRegistration.aliasKey(request.getScope().getTenantId(), request.getStorageId()));
        WorkspaceCsiRegistration registration;
        try {
            String encoded = text(registrationRow, "registration_json");
            require(encoded.length() <= 16 * 1024);
            registration = json.readValue(encoded, WorkspaceCsiRegistration.class);
        } catch (java.io.IOException error) {
            throw unavailable();
        }
        require(registration.revision() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && registration.aliasKey().equals(text(registrationRow, "alias_key"))
                && registration.physicalKey().equals(text(registrationRow, "physical_key"))
                && registration.tenantId().equals(text(registrationRow, "tenant_id"))
                && registration.storageId().equals(text(registrationRow, "storage_id"))
                && registration.revision() == number(registrationRow, "registration_revision")
                && registration.mountRoot().equals(request.getScope().getCanonicalCwd()));
        var original = intent.reservation();
        require(original != null && "RESERVED".equals(original.phase()) && original.revision() == 1
                && uuid(original.reservationId()) && registration.aliasKey().equals(original.registrationKey())
                && Objects.equals(registration.revision(), original.registrationRevision())
                && runtime.getBindingId().equals(original.bindingId())
                && Objects.equals(runtime.getGeneration(), original.runtimeGeneration())
                && runtime.getProvisionSeed().getProvisionRequestId().equals(original.provisionRequestId()));
        Map<String, Object> holder = one(connection,
                "SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", registration.physicalKey());
        require("CSI".equals(holder.get("storage_kind")) && "DRAINING".equals(holder.get("csi_phase"))
                && number(holder, "csi_revision") == 2 && holder.get("holder_key") == null
                && holder.get("runtime_session_id") == null
                && original.reservationId().equals(holder.get("csi_reservation_id"))
                && original.registrationKey().equals(holder.get("csi_registration_key"))
                && original.registrationRevision().longValue() == number(holder, "csi_registration_revision")
                && runtime.getBindingId().equals(holder.get("binding_id"))
                && runtime.getGeneration() == rawNumber(holder, "runtime_generation")
                && original.provisionRequestId().equals(holder.get("csi_provision_request_id")));
        var lease = runtime.getLease();
        var handle = runtime.getResourceHandle();
        String digest;
        try {
            digest = hash(json.writeValueAsString(List.of("qwen-csi-retirement-lease/1", lease.getRuntimeInstanceId(),
                    lease.getEndpoint().toString(), lease.getToken(), lease.getLeaseId(), Long.toString(lease.getEpoch()))));
            require(intent.equals(new WorkspaceCsiReservationStore.Retirement(retirementId, registration.physicalKey(),
                    "DRAINING", original, intent.sealedBindingVersion(), handle.getKind(), handle.getVersion(),
                    json.writeValueAsString(handle.getValue()), lease.getRuntimeInstanceId(), lease.getLeaseId(),
                    lease.getEpoch(), digest, runtime.getAttestationGeneration(), intent.startedAt())));
            Instant.parse(intent.startedAt());
        } catch (java.io.IOException | java.time.DateTimeException error) {
            throw unavailable();
        }
        require(retirementId.equals(row.get("retirement_id")) && "DRAINING".equals(row.get("phase"))
                && registration.physicalKey().equals(row.get("physical_key"))
                && runtime.getGeneration() == rawNumber(row, "runtime_generation")
                && intent.sealedBindingVersion() > 0 && runtime.getVersion() >= intent.sealedBindingVersion());
        Map<String, Object> slot = one(connection,
                "SELECT s.* FROM qwen_runtime_binding_slot s JOIN qwen_runtime_binding b ON b.request_key = s.request_key"
                        + " WHERE b.binding_id = ?", runtime.getBindingId());
        require(runtime.getBindingId().equals(slot.get("active_binding_id"))
                && runtime.getGeneration() == rawNumber(slot, "last_generation")
                && request.equals(new RuntimeProvisionRequest(scope(slot), nullable(slot, "isolation_key"),
                        text(slot, "provisioner_kind"), nullable(slot, "storage_id"))));
        require(scopeHash(request.getScope()).equals(one(connection,
                "SELECT scope_key FROM qwen_runtime_binding WHERE binding_id = ?", runtime.getBindingId()).get("scope_key")));
        require(runtime.getVersion() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && intent.sealedBindingVersion() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && runtime.getAttestationGeneration() > 0 && runtime.getAttestationGeneration() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && lease.getEpoch() > 0 && lease.getEpoch() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER
                && intent.resourceHandleVersion() != null && intent.resourceHandleVersion() > 0);
        ObjectNode result = json.createObjectNode().put("retirementId", retirementId)
                .put("bindingId", runtime.getBindingId()).put("runtimeGeneration", Long.toString(runtime.getGeneration()))
                .put("bindingVersion", runtime.getVersion()).put("sealedBindingVersion", intent.sealedBindingVersion())
                .put("physicalKey", registration.physicalKey()).put("reservationId", original.reservationId())
                .put("reservationRevision", number(holder, "csi_revision")).put("registrationKey", original.registrationKey())
                .put("registrationRevision", original.registrationRevision()).put("provisionRequestId", original.provisionRequestId())
                .put("attestationGeneration", runtime.getAttestationGeneration()).put("resourceHandleKind", intent.resourceHandleKind())
                .put("resourceHandleVersion", intent.resourceHandleVersion()).put("resourceHandleDigest", hash(intent.resourceHandleJson()))
                .put("clusterDomain", registration.clusterDomain()).put("namespace", registration.namespace())
                .put("pvcName", registration.pvcName()).put("pvcUid", registration.pvcUid())
                .put("pvName", registration.pvName()).put("pvUid", registration.pvUid())
                .put("runtimeInstanceId", intent.runtimeInstanceId()).put("leaseId", intent.leaseId()).put("epoch", intent.epoch())
                .put("leaseDigest", digest).put("startedAt", intent.startedAt());
        return result;
    }

    private void originalExecution(Connection connection, RuntimeBindingRecord runtime,
            WorkspaceCsiReservationStore.Retirement intent, JsonNode binding, JsonNode terminal) throws SQLException {
        String executionId = binding.path("executionCallId").asText();
        Map<String, Object> execution = one(connection,
                "SELECT * FROM qwen_tool_execution WHERE execution_call_id_hash = ?", valueHash(executionId));
        JsonNode ref = binding.path("reference");
        JsonNode actualRef = parse(text(execution, "reference_json"));
        require(executionId.equals(execution.get("execution_call_id"))
                && runtime.getBindingId().equals(execution.get("binding_id"))
                && runtime.getGeneration() == rawNumber(execution, "runtime_generation")
                && valueHash(text(execution, "idempotency_key")).equals(execution.get("idempotency_key_hash"))
                && valueHash(text(execution, "runtime_session_id")).equals(execution.get("runtime_session_key"))
                && "SETTLED".equals(execution.get("execution_state"))
                && number(execution, "authorized_dispatch_generation") > 0
                && number(execution, "authorized_dispatch_generation") == number(execution, "dispatch_generation")
                && number(execution, "authorized_binding_version") > 0
                && number(execution, "authorized_binding_version") < intent.sealedBindingVersion()
                && binding.path("sessionKey").path("sessionId").asText().equals(execution.get("harness_session_id"))
                && ref.path("sessionId").asText().equals(execution.get("runtime_session_id"))
                && ref.path("promptId").asText().equals(execution.get("turn_id"))
                && ref.path("callId").asText().equals(execution.get("tool_call_id"))
                && binding.path("requestDigest").asText().equals(execution.get("request_digest"))
                && "deferred_v3".equals(actualRef.path("dispatchMode").asText())
                && binding.path("requestDigest").equals(actualRef.path("payloadDigest"))
                && binding.path("publicationId").equals(actualRef.path("publicationId"))
                && ref.path("sessionId").equals(actualRef.path("sessionId"))
                && ref.path("promptId").equals(actualRef.path("promptId"))
                && ref.path("callId").equals(actualRef.path("callId"))
                && ref.path("argsDigest").equals(actualRef.path("argsDigest")));
        JsonNode saved = parse(text(execution, "result_json"));
        require(terminal.equals((left, right) -> left.isNumber() && right.isNumber()
                ? left.decimalValue().compareTo(right.decimalValue()) : left.equals(right) ? 0 : 1, saved)
                && terminal.path("executionStatus").asText().equals(execution.get("execution_status")));
        Map<String, Object> session = one(connection,
                "SELECT * FROM qwen_runtime_session WHERE scope_key = ? AND runtime_session_id = ?",
                scopeHash(runtime.getRequest().getScope()), ref.path("sessionId").asText());
        require(runtime.getRequest().getScope().equals(scope(session))
                && runtime.getBindingId().equals(session.get("binding_id"))
                && runtime.getGeneration() == rawNumber(session, "runtime_generation")
                && binding.path("sessionKey").path("sessionId").asText().equals(session.get("harness_session_id")));
    }

    private ArrayNode transactions(Connection connection, JsonNode key, Map<String, Object> head) throws SQLException {
        var rows = rows(connection, "SELECT * FROM qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision LIMIT 4097",
                key.path("tenantId").asText(), key.path("sessionId").asText());
        require(rows.size() == number(head, "journal_revision"));
        ArrayNode result = json.createArrayNode();
        long bytes = 0;
        String previous = null;
        String checkpoint = null;
        for (int index = 0; index < rows.size(); index++) {
            Map<String, Object> row = rows.get(index);
            scope(row, key);
            byte[] records = bytes(row, "record_bytes", ManagedSessionStoreModels.MAX_TRANSACTION_BYTES);
            bytes += records.length;
            require(bytes <= MAX_BYTES && number(row, "journal_revision") == index + 1
                    && number(row, "event_count") <= ManagedSessionStoreModels.MAX_TRANSACTION_EVENTS
                    && "identity".equals(row.get("record_encoding"))
                    && records.length == number(row, "byte_length") && hash(records).equals(row.get("record_digest"))
                    && Objects.equals(previous, row.get("previous_commit_digest")));
            previous = nullable(row, "commit_digest");
            if (row.get("latest_checkpoint_resource_id") != null) {
                checkpoint = text(row, "latest_checkpoint_resource_id");
            }
            result.add(json.valueToTree(new ManagedSessionStoreModels.StoredTransaction(number(row, "journal_revision"),
                    text(row, "transaction_id"), text(row, "operation"), text(row, "command_id"), text(row, "content_digest"),
                    number(row, "first_sequence"), number(row, "last_sequence"), (int) number(row, "event_count"),
                    nullable(row, "events_digest"), nullable(row, "previous_commit_digest"), nullable(row, "commit_digest"),
                    number(row, "writer_generation"), number(row, "activation_epoch"), nullable(row, "latest_checkpoint_resource_id"),
                    text(row, "record_encoding"), Base64.getEncoder().encodeToString(records), records.length, text(row, "record_digest"))));
        }
        require(!rows.isEmpty() && number(rows.getLast(), "last_sequence") == number(head, "committed_sequence")
                && number(rows.getLast(), "activation_epoch") == number(head, "activation_epoch")
                && Objects.equals(previous, head.get("last_commit_digest"))
                && Objects.equals(checkpoint, head.get("latest_checkpoint_resource_id")));
        return result;
    }

    private ArrayNode resources(Connection connection, JsonNode key, String scope, long headRevision) throws SQLException {
        Map<String, ArrayNode> references = new HashMap<>();
        for (var row : rows(connection, "SELECT * FROM qwen_managed_session_resource_ref"
                + " WHERE session_scope_key = ? ORDER BY journal_revision, resource_id LIMIT 4097", scope)) {
            scope(row, key);
            long revision = number(row, "journal_revision");
            require(revision > 0 && revision <= headRevision);
            references.computeIfAbsent(text(row, "resource_id"), ignored -> json.createArrayNode()).add(revision);
        }
        ArrayNode result = json.createArrayNode();
        long total = 0;
        for (var row : rows(connection, "SELECT * FROM qwen_managed_session_resource"
                + " WHERE session_scope_key = ? AND state = 'REFERENCED' ORDER BY resource_id LIMIT 4097", scope)) {
            scope(row, key);
            require("MYSQL_INLINE".equals(row.get("storage_kind")) && number(row, "schema_version") == 1
                    && row.get("object_key") == null && row.get("object_version_id") == null && row.get("encryption_key_id") == null);
            byte[] bytes = bytes(row, "inline_bytes", ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES);
            total += bytes.length;
            require(total <= MAX_BYTES && bytes.length == number(row, "byte_length") && hash(bytes).equals(row.get("sha256")));
            ArrayNode revisions = references.remove(text(row, "resource_id"));
            require(revisions != null && !revisions.isEmpty());
            ObjectNode resource = json.createObjectNode().put("bytesBase64", Base64.getEncoder().encodeToString(bytes));
            resource.set("ref", json.createObjectNode().put("resourceId", text(row, "resource_id"))
                    .put("kind", text(row, "kind")).put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", text(row, "sha256")));
            resource.set("referencedRevisions", revisions);
            result.add(resource);
        }
        require(references.isEmpty());
        return result;
    }

    private byte[] publicationBytes(Connection connection, String scope, String publicationId,
            String resourceId, String slot, String kind) throws SQLException {
        var row = one(connection, "SELECT * FROM qwen_tool_publication_object"
                + " WHERE scope_key = ? AND publication_id = ? AND resource_id = ?", scope, publicationId, resourceId);
        require("VERIFIED".equals(row.get("state")) && kind.equals(row.get("resource_kind"))
                && (slot == null || slot.equals(row.get("slot_key"))) && row.get("object_key") == null);
        byte[] bytes = bytes(row, "inline_bytes", ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES);
        require(bytes.length == number(row, "byte_length") && hash(bytes).equals(row.get("sha256")));
        return bytes;
    }

    private JsonNode resourceRef(ArrayNode resources, String id, long revision, byte[] bytes) {
        for (JsonNode resource : resources) {
            if (id.equals(resource.path("ref").path("resourceId").asText())) {
                require(resource.path("ref").path("byteLength").longValue() == bytes.length
                        && hash(bytes).equals(resource.path("ref").path("digest").asText())
                        && java.util.Arrays.equals(bytes, Base64.getDecoder().decode(resource.path("bytesBase64").asText())));
                boolean referenced = false;
                for (JsonNode value : resource.path("referencedRevisions")) {
                    referenced |= value.longValue() == revision;
                }
                require(referenced);
                return resource.path("ref");
            }
        }
        throw unavailable();
    }

    private void requireEngines(Connection connection) throws SQLException {
        var found = rows(connection, "SELECT table_name, engine FROM information_schema.tables"
                + " WHERE table_schema = DATABASE() AND table_name IN ('managed_workspace_csi_retirement',"
                + " 'managed_workspace_csi_registration', 'managed_workspace_execution_lease', 'qwen_runtime_binding',"
                + " 'qwen_runtime_binding_slot', 'qwen_runtime_session', 'qwen_tool_execution', 'qwen_tool_publication',"
                + " 'qwen_tool_publication_object', 'qwen_managed_session_journal_head', 'qwen_managed_session_journal_tx',"
                + " 'qwen_managed_session_resource', 'qwen_managed_session_resource_ref')");
        require(found.size() == TABLES.size());
        for (var row : found) {
            require(TABLES.contains(text(row, "table_name")) && "InnoDB".equals(row.get("engine")));
        }
    }

    private Map<String, Object> one(Connection connection, String sql, Object... parameters) throws SQLException {
        var values = rows(connection, sql, parameters);
        require(values.size() == 1);
        return values.getFirst();
    }

    private List<Map<String, Object>> rows(Connection connection, String sql, Object... parameters) throws SQLException {
        try (var statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(10);
            statement.setMaxRows(MAX_ROWS + 1);
            for (int index = 0; index < parameters.length; index++) {
                statement.setObject(index + 1, parameters[index]);
            }
            try (var result = statement.executeQuery()) {
                var metadata = result.getMetaData();
                List<Map<String, Object>> rows = new ArrayList<>();
                long decodedBytes = 0;
                while (result.next()) {
                    require(rows.size() < MAX_ROWS);
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int index = 1; index <= metadata.getColumnCount(); index++) {
                        int type = metadata.getColumnType(index);
                        Object value = switch (type) {
                            case Types.BLOB, Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY -> boundedBytes(result, index);
                            case Types.CLOB, Types.LONGVARCHAR -> boundedText(result, index);
                            default -> result.getObject(index);
                        };
                        if (value instanceof byte[] bytes) {
                            decodedBytes += bytes.length;
                            require(decodedBytes <= MAX_BYTES);
                        }
                        row.put(metadata.getColumnLabel(index).toLowerCase(Locale.ROOT), value);
                    }
                    rows.add(row);
                }
                return rows;
            }
        }
    }

    private static byte[] boundedBytes(java.sql.ResultSet result, int index) throws SQLException {
        try (var stream = result.getBinaryStream(index)) {
            if (stream == null) {
                return null;
            }
            byte[] bytes = stream.readNBytes(ManagedSessionStoreModels.MAX_TRANSACTION_BYTES + 1);
            require(bytes.length <= ManagedSessionStoreModels.MAX_TRANSACTION_BYTES);
            return bytes;
        } catch (java.io.IOException error) {
            throw unavailable();
        }
    }

    private static String boundedText(java.sql.ResultSet result, int index) throws SQLException {
        try (var reader = result.getCharacterStream(index)) {
            if (reader == null) {
                return null;
            }
            var text = new StringBuilder();
            char[] buffer = new char[8192];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                require(text.length() <= ManagedSessionStoreModels.MAX_TRANSACTION_BYTES - count);
                text.append(buffer, 0, count);
            }
            require(text.toString().getBytes(StandardCharsets.UTF_8).length <= ManagedSessionStoreModels.MAX_TRANSACTION_BYTES);
            return text.toString();
        } catch (java.io.IOException error) {
            throw unavailable();
        }
    }

    private JsonNode parse(String encoded) {
        return readExact(encoded.getBytes(StandardCharsets.UTF_8));
    }

    private JsonNode readExact(byte[] bytes) {
        try {
            return json.readTree(bytes);
        } catch (java.io.IOException error) {
            throw unavailable();
        }
    }

    private static RuntimeScope scope(Map<String, Object> row) {
        return new RuntimeScope(text(row, "tenant_id"), text(row, "workspace_id"), text(row, "workspace_generation"),
                text(row, "canonical_cwd"), text(row, "capability_digest"), text(row, "isolation_class"));
    }

    private static void scope(Map<String, Object> row, JsonNode key) {
        require(key.path("tenantId").asText().equals(row.get("tenant_id"))
                && key.path("workspaceId").asText().equals(row.get("workspace_id"))
                && key.path("sessionId").asText().equals(row.get("session_id")));
    }

    private static String scopeHash(RuntimeScope scope) {
        return fieldHash(scope.getTenantId(), scope.getWorkspaceId(), scope.getWorkspaceGeneration(),
                scope.getCanonicalCwd(), scope.getCapabilityDigest(), scope.getIsolationClass());
    }

    private static String valueHash(String value) {
        return fieldHash(value);
    }

    private static String fieldHash(String... fields) {
        var bytes = new java.io.ByteArrayOutputStream();
        for (String field : fields) {
            byte[] value = field.getBytes(StandardCharsets.UTF_8);
            bytes.writeBytes(java.nio.ByteBuffer.allocate(4).putInt(value.length).array());
            bytes.writeBytes(value);
        }
        return hash(bytes.toByteArray());
    }

    private static String hash(String value) {
        return hash(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String hash(byte[] value) {
        return ToolPublicationContract.sha256(value);
    }

    private static String text(Map<String, Object> row, String field) {
        String value = nullable(row, field);
        require(value != null && !value.isEmpty());
        return value;
    }

    private static String nullable(Map<String, Object> row, String field) {
        Object value = row.get(field);
        require(value == null || value instanceof String);
        return (String) value;
    }

    private static long rawNumber(Map<String, Object> row, String field) {
        require(row.get(field) instanceof Number);
        return ((Number) row.get(field)).longValue();
    }

    private static long number(Map<String, Object> row, String field) {
        long value = rawNumber(row, field);
        require(value >= 0 && value <= ManagedSessionStoreModels.MAX_SAFE_COUNTER);
        return value;
    }

    private static boolean flag(Map<String, Object> row, String field) {
        Object value = row.get(field);
        require(value instanceof Boolean || value instanceof Number);
        return Boolean.TRUE.equals(value) || value instanceof Number && ((Number) value).intValue() != 0;
    }

    private static byte[] bytes(Map<String, Object> row, String field, int limit) {
        require(row.get(field) instanceof byte[]);
        byte[] value = (byte[]) row.get(field);
        require(value.length > 0 && value.length <= limit);
        return value;
    }

    private static boolean id(String value, int limit) {
        return value != null && !value.isBlank() && value.length() <= limit && value.indexOf('\0') < 0;
    }

    private static boolean uuid(String value) {
        try {
            return value != null && UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw unavailable();
        }
    }

    private static IllegalStateException unavailable() {
        return new IllegalStateException("Original CSI checkpoint snapshot is unavailable.");
    }
}
