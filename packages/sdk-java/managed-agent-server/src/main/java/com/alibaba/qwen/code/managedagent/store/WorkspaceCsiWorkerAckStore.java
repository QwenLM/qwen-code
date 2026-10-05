package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.require;

import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Confirms one original receipt; it cannot authorize physical retirement. */
public final class WorkspaceCsiWorkerAckStore {
    private static final int MAX_BYTES = 32 * 1024;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Set<String> ORIGINAL_KEYS = Set.of("retirementIdentityDigest", "bindingId",
            "bindingGeneration", "sessionKey", "publicationId", "publicationBindingDigest",
            "authorizedDispatchGeneration", "authorizedBindingVersion", "finishOperationId",
            "terminalRef", "outcomeRef", "receiptJournalRevision", "receiptSequence");
    private final DataSource source;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JdbcRuntimeBindingRepository bindings;
    private final JdbcRuntimeSessionRepository sessions;
    private final JdbcToolExecutionRepository executions;
    private final WorkspaceCsiReservationStore csi;
    private final ToolPublicationAdmissionStore admission;
    private final RuntimeTransport transport;
    private final Duration timeout;
    private final ObjectMapper json = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);

    public record Selector(String retirementId, String tenantId, String workspaceId,
            String sessionId, String publicationId) {
        public Selector {
            require(uuid(retirementId), "Invalid CSI retirement selector");
            id(tenantId, 128);
            id(workspaceId, 512);
            id(sessionId, 512);
            id(publicationId, 128);
        }
    }

    public record Evidence(JsonNode document, String digest, long recordedAtEpochMicros) {
    }

    public WorkspaceCsiWorkerAckStore(DataSource source, DataSourceTransactionManager manager,
            JdbcRuntimeBindingRepository bindings, JdbcRuntimeSessionRepository sessions,
            JdbcToolExecutionRepository executions, ToolPublicationAdmissionStore admission,
            RuntimeTransport transport, Duration timeout) {
        require(source != null && manager != null && manager.getDataSource() == source
                && bindings != null && bindings.usesDataSource(source)
                && sessions != null && sessions.usesDataSource(source)
                && executions != null && executions.usesDataSource(source)
                && admission != null && admission.usesDataSource(source) && transport != null,
                "CSI ACK requires native authorities on one DataSource");
        require(timeout != null && timeout.compareTo(Duration.ZERO) > 0
                && timeout.compareTo(Duration.ofSeconds(30)) <= 0, "Invalid CSI ACK deadline");
        this.source = source;
        this.jdbc = new JdbcTemplate(source);
        this.transactions = new TransactionTemplate(manager);
        this.transactions.setTimeout(10);
        this.bindings = bindings;
        this.sessions = sessions;
        this.executions = executions;
        this.admission = admission;
        this.transport = transport;
        this.timeout = timeout;
        this.csi = new WorkspaceCsiReservationStore(jdbc, manager, json);
    }

    public Evidence acknowledge(Selector selector) {
        requireNoTransaction();
        JsonNode publication = publication(selector);
        ToolExecutionRecord execution = executions.findByExecutionCallId(text(publication, "executionCallId"));
        require(execution != null, "Original CSI execution is missing");
        var bundle = admission.verifyOriginalAcknowledgement(execution);
        Plan plan = transactions.execute(status -> prepare(selector, publication, bundle));
        require(plan != null, "Original CSI ACK plan is unavailable");
        Map<String, Object> response;
        try {
            response = transport.acknowledgeCsi(plan.runtime().getLease(), plan.session().getSession(),
                    plan.boot(), plan.pod(), plan.request(), map(bundle.captureIdentity()))
                    .toCompletableFuture().get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Original CSI acknowledgement was interrupted");
        } catch (Exception error) {
            throw new IllegalStateException("Original CSI acknowledgement is unavailable");
        }
        Map<String, Object> confirmed = ManagedCsiProtocol.verifyAcknowledgement(response, plan.request(),
                plan.boot(), plan.pod(), map(bundle.captureIdentity()));
        return transactions.execute(status -> {
            Plan current = prepare(selector, publication, bundle);
            require(current != null && plan.original().equals(current.original())
                    && plan.request().equals(current.request())
                    && plan.runtime().getResourceHandle().equals(current.runtime().getResourceHandle())
                    && plan.runtime().hasSameLease(current.runtime().getLease())
                    && plan.runtime().getAttestationGeneration() == current.runtime().getAttestationGeneration(),
                    "Original CSI authority changed after acknowledgement");
            ObjectNode document = json.createObjectNode().put("schemaVersion", 1);
            document.set("original", current.original());
            document.set("confirmation", json.valueToTree(confirmed));
            byte[] bytes = encode(document);
            validateDocument(document, selector, execution.getExecutionCallId(), publication);
            Evidence prior = read(selector, execution.getExecutionCallId(), true, publication);
            if (prior != null) {
                require(prior.document().equals(document), "Original CSI ACK evidence conflicts");
                return prior;
            }
            long observed = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(),"
                    + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))", (row, index) ->
                            Math.addExact(Math.multiplyExact(row.getLong(1), 1_000_000), row.getLong(2)));
            require(observed > 0, "CSI ACK observation time is unavailable");
            jdbc.update("INSERT INTO managed_workspace_csi_worker_ack (retirement_id, execution_call_id_hash,"
                            + " execution_call_id, evidence_json, evidence_digest, recorded_at_epoch_micros)"
                            + " VALUES (?, ?, ?, ?, ?, ?)", selector.retirementId(), hash(execution.getExecutionCallId()),
                    execution.getExecutionCallId(), new String(bytes, StandardCharsets.UTF_8),
                    ToolPublicationContract.sha256(bytes), observed);
            Evidence saved = read(selector, execution.getExecutionCallId(), true, publication);
            require(saved != null && saved.document().equals(document), "CSI ACK insert could not be verified");
            return saved;
        });
    }

    /** Historical evidence only; no worker RPC and no claim of current liveness. */
    public Evidence inspect(Selector selector) {
        requireNoTransaction();
        JsonNode publication = publication(selector);
        return read(selector, text(publication, "executionCallId"), false, publication);
    }

    private Plan prepare(Selector selector, JsonNode expectedPublication,
            ToolPublicationAdmissionStore.AcknowledgementBundle bundle) {
        RuntimeBindingRecord candidate = bindings.findById(text(expectedPublication, "runtimeBindingId"));
        require(candidate != null, "Original CSI binding is missing");
        var locked = csi.lockPublication(bindings, candidate);
        RuntimeBindingRecord runtime = locked.binding();
        var retirement = locked.retirement();
        require(retirement != null && selector.retirementId().equals(retirement.operationId())
                && runtime.getState() == RuntimeBindingRecord.State.DRAINING && runtime.isDrainRequested(),
                "Original CSI retirement is unavailable");
        WorkspaceCsiRuntimeIdentity.verify(runtime);
        var scope = runtime.getRequest().getScope();
        require(selector.tenantId().equals(scope.getTenantId()) && selector.workspaceId().equals(scope.getWorkspaceId())
                && expectedPublication.equals(bundle.finished().path("binding")), "Original publication scope conflicts");
        RuntimeSessionRecord session = jdbc.execute((ConnectionCallback<RuntimeSessionRecord>) connection -> {
            var target = DataSourceUtils.getTargetConnection(connection);
            require(DataSourceUtils.isConnectionTransactional(target, source), "CSI ACK requires its own connection");
            return sessions.findByIdForUpdate(target, scope, text(expectedPublication.path("reference"), "sessionId"));
        });
        require(session != null && session.getState() == RuntimeSessionRecord.State.READY
                && runtime.getBindingId().equals(session.getBindingId())
                && runtime.getGeneration() == session.getRuntimeGeneration()
                && selector.sessionId().equals(session.getSession().getHarnessSessionId())
                && scope.equals(session.getSession().getScope()), "Original Runtime Session conflicts");
        ToolExecutionRecord execution = admission.lockOriginalAcknowledgement(bundle);
        require(execution.wasDispatchAuthorizedBefore(retirement.sealedBindingVersion())
                && execution.getState() == ToolExecutionRecord.State.SETTLED
                && runtime.getBindingId().equals(execution.getBindingId())
                && runtime.getGeneration() == execution.getRuntimeGeneration(), "Original CSI result conflicts");
        String identity = jdbc.queryForObject("SELECT identity_json FROM managed_workspace_csi_retirement"
                + " WHERE retirement_id = ? AND binding_id = ? AND runtime_generation = ? FOR UPDATE",
                String.class, selector.retirementId(), runtime.getBindingId(), runtime.getGeneration());
        require(identity != null, "Original CSI retirement identity is missing");
        JsonNode publication = publication(selector);
        require(publication.equals(expectedPublication), "Original publication binding changed");
        ObjectNode original = json.createObjectNode().put("retirementIdentityDigest", hash(identity))
                .put("bindingId", runtime.getBindingId()).put("bindingGeneration", Long.toString(runtime.getGeneration()))
                .put("publicationId", selector.publicationId())
                .put("publicationBindingDigest", ToolPublicationContract.bindingDigest(publication))
                .put("authorizedDispatchGeneration", Long.toString(execution.getAuthorizedDispatchGeneration()))
                .put("authorizedBindingVersion", Long.toString(execution.getAuthorizedBindingVersion()))
                .put("finishOperationId", text(bundle.finished(), "finishOperationId"))
                .put("receiptJournalRevision", Long.toString(bundle.receiptJournalRevision()))
                .put("receiptSequence", Long.toString(bundle.receiptSequence()));
        original.set("sessionKey", publication.path("sessionKey"));
        original.set("terminalRef", bundle.finished().path("terminal"));
        original.set("outcomeRef", bundle.outcomeRef());
        Map<String, Object> boot = WorkspaceCsiRuntimeIdentity.boot(runtime);
        Map<String, Object> pod = WorkspaceCsiRuntimeIdentity.expectedPod(runtime);
        var context = new LinkedHashMap<>(map(json.valueToTree(boot.get("context"))));
        Set.of("type", "version", "token").forEach(context::remove);
        context.put("protocolVersion", 3);
        Map<String, Object> request = Map.of("protocolVersion", 1, "managedCsi", ManagedCsiProtocol.PROTOCOL,
                "workerAck", ManagedCsiProtocol.WORKER_ACK, "retirementId", selector.retirementId(),
                "context", Map.copyOf(context), "storage", boot.get("storage"), "pod", pod,
                "reference", map(publication.path("reference")), "acknowledgement", map(bundle.receipt()));
        ManagedCsiProtocol.validateAcknowledgementRequest(request, boot, pod);
        ManagedCsiProtocol.validateAcknowledgementIdentity(runtime.getLease(), session.getSession(),
                boot, request, map(bundle.captureIdentity()));
        require(Long.toString(runtime.getGeneration()).equals(text(bundle.captureIdentity(), "bindingGeneration")),
                "Original capture generation conflicts");
        return new Plan(runtime, session, boot, pod, request, original);
    }

    private JsonNode publication(Selector selector) {
        ObjectNode key = json.createObjectNode().put("tenantId", selector.tenantId())
                .put("workspaceId", selector.workspaceId()).put("sessionId", selector.sessionId());
        var rows = jdbc.queryForList("SELECT tenant_id, workspace_id, session_id, publication_id, binding_json, binding_digest"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                ToolPublicationDataStore.scope(key), selector.publicationId());
        require(rows.size() == 1, "Original publication is missing or ambiguous");
        var row = rows.getFirst();
        JsonNode binding = ToolPublicationContract.parseBytes("binding",
                ((String) row.get("binding_json")).getBytes(StandardCharsets.UTF_8));
        require(key.equals(binding.path("sessionKey")) && selector.publicationId().equals(text(binding, "publicationId"))
                && selector.tenantId().equals(row.get("tenant_id"))
                && selector.publicationId().equals(row.get("publication_id"))
                && selector.workspaceId().equals(row.get("workspace_id")) && selector.sessionId().equals(row.get("session_id"))
                && ToolPublicationContract.bindingDigest(binding).equals(row.get("binding_digest")),
                "Original publication identity conflicts");
        return binding;
    }

    private Evidence read(Selector selector, String executionId, boolean lock, JsonNode publication) {
        var rows = jdbc.queryForList("SELECT execution_call_id, evidence_json, evidence_digest,"
                + " recorded_at_epoch_micros FROM managed_workspace_csi_worker_ack"
                + " WHERE retirement_id = ? AND execution_call_id_hash = ?" + (lock ? " FOR UPDATE" : ""),
                selector.retirementId(), hash(executionId));
        require(rows.size() <= 1, "Original CSI ACK is ambiguous");
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.getFirst();
        require(executionId.equals(row.get("execution_call_id")), "CSI ACK execution hash alias conflicts");
        String encoded = (String) row.get("evidence_json");
        require(encoded != null, "CSI ACK document is missing");
        byte[] bytes = encoded.getBytes(StandardCharsets.UTF_8);
        require(ToolPublicationContract.sha256(bytes).equals(row.get("evidence_digest")), "CSI ACK digest conflicts");
        JsonNode document = decode(bytes);
        validateDocument(document, selector, executionId, publication);
        long observed = ((Number) row.get("recorded_at_epoch_micros")).longValue();
        require(observed > 0, "CSI ACK observation time is invalid");
        return new Evidence(document, (String) row.get("evidence_digest"), observed);
    }

    private void validateDocument(JsonNode document, Selector selector, String executionId, JsonNode publication) {
        keys(document, Set.of("schemaVersion", "original", "confirmation"));
        require(document.path("schemaVersion").isIntegralNumber() && document.path("schemaVersion").longValue() == 1,
                "Unknown CSI ACK schema");
        JsonNode original = document.path("original");
        keys(original, ORIGINAL_KEYS);
        id(text(original, "bindingId"), 512);
        id(text(original, "finishOperationId"), 128);
        for (String field : List.of("retirementIdentityDigest", "publicationBindingDigest")) {
            require(text(original, field).matches("[0-9a-f]{64}"), "CSI ACK identity digest is invalid");
        }
        for (String field : List.of("bindingGeneration", "authorizedDispatchGeneration", "authorizedBindingVersion",
                "receiptJournalRevision", "receiptSequence")) {
            String value = text(original, field);
            require(value.matches("[1-9][0-9]{0,18}") && Long.parseLong(value) > 0,
                    "CSI ACK revision is invalid");
        }
        JsonNode key = original.path("sessionKey");
        keys(key, Set.of("tenantId", "workspaceId", "sessionId"));
        require(selector.tenantId().equals(text(key, "tenantId"))
                && selector.workspaceId().equals(text(key, "workspaceId")) && selector.sessionId().equals(text(key, "sessionId"))
                && selector.publicationId().equals(text(original, "publicationId")), "Historical CSI ACK scope conflicts");
        ref(original.path("terminalRef"), "managed-tool-terminal");
        ref(original.path("outcomeRef"), "managed-tool-outcome");
        Map<String, Object> confirmation = ManagedCsiProtocol.parseAcknowledgement(encode(document.path("confirmation")));
        var request = new LinkedHashMap<>(confirmation);
        request.remove("state");
        request.remove("captureIdentity");
        var context = new LinkedHashMap<>(map(document.path("confirmation").path("context")));
        context.remove("protocolVersion");
        context.put("type", "boot");
        context.put("version", 2);
        // Historical decoding validates shape only; this token is never used for networking.
        context.put("token", "historical-schema-validation");
        Map<String, Object> boot = Map.of("type", "boot", "version", 3, "managedCsi", ManagedCsiProtocol.PROTOCOL,
                "context", context, "storage", confirmation.get("storage"));
        ManagedCsiProtocol.verifyAcknowledgement(confirmation, request, boot,
                map(document.path("confirmation").path("pod")), map(document.path("confirmation").path("captureIdentity")));
        JsonNode capture = document.path("confirmation").path("captureIdentity");
        require(text(original, "publicationBindingDigest").equals(ToolPublicationContract.bindingDigest(publication))
                && text(original, "bindingId").equals(text(publication, "runtimeBindingId"))
                && text(original, "bindingGeneration").equals(text(publication, "bindingGeneration"))
                && key.equals(publication.path("sessionKey"))
                && document.path("confirmation").path("reference").equals(publication.path("reference"))
                && text(capture, "turnId").equals(text(publication, "turnId"))
                && text(capture, "captureId").equals(text(publication, "captureId")),
                "Historical CSI ACK publication conflicts");
        require(selector.retirementId().equals(confirmation.get("retirementId"))
                && selector.tenantId().equals(context.get("tenantId")) && selector.workspaceId().equals(context.get("workspaceId"))
                && selector.sessionId().equals(text(capture, "sessionId"))
                && executionId.equals(text(capture, "executionCallId"))
                && text(original, "bindingGeneration").equals(text(capture, "bindingGeneration"))
                && Long.parseLong(text(original, "receiptSequence"))
                        == document.path("confirmation").path("acknowledgement").path("historyRevision").longValue(),
                "Historical CSI ACK identity conflicts");
    }

    private static void ref(JsonNode value, String kind) {
        keys(value, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        id(text(value, "resourceId"), 512);
        require(kind.equals(text(value, "kind")) && value.path("schemaVersion").isIntegralNumber()
                && value.path("schemaVersion").longValue() == 1 && value.path("byteLength").isIntegralNumber()
                && value.path("byteLength").longValue() > 0 && value.path("byteLength").longValue() <= 2 * 1024 * 1024
                && text(value, "digest").matches("[0-9a-f]{64}"), "CSI ACK resource reference is invalid");
    }

    private JsonNode decode(byte[] bytes) {
        require(bytes.length <= MAX_BYTES, "CSI ACK evidence exceeds its limit");
        try {
            String value = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
            try (var parser = json.createParser(value)) {
                for (JsonToken token = parser.nextToken(); token != null; token = parser.nextToken()) {
                    if (token.isNumeric()) {
                        require(token == JsonToken.VALUE_NUMBER_INT && parser.getText().matches("[1-9][0-9]*")
                                && parser.getBigIntegerValue().compareTo(java.math.BigInteger.valueOf(MAX_SAFE_INTEGER)) <= 0,
                                "CSI ACK numeric token is invalid");
                    }
                }
            }
            return json.readTree(value);
        } catch (Exception error) {
            throw new IllegalArgumentException("CSI ACK evidence document is invalid");
        }
    }

    private byte[] encode(JsonNode document) {
        try {
            byte[] bytes = json.writeValueAsBytes(document);
            require(bytes.length <= MAX_BYTES, "CSI ACK evidence exceeds its limit");
            return bytes;
        } catch (java.io.IOException error) {
            throw new IllegalArgumentException("CSI ACK evidence could not be encoded");
        }
    }

    private Map<String, Object> map(JsonNode value) {
        return json.convertValue(value, new TypeReference<Map<String, Object>>() { });
    }

    private static void keys(JsonNode value, Set<String> expected) {
        require(value.isObject() && value.size() == expected.size(), "CSI ACK fields are invalid");
        value.fieldNames().forEachRemaining(name -> require(expected.contains(name), "Unknown CSI ACK field"));
    }

    private static String text(JsonNode value, String field) {
        JsonNode node = value.path(field);
        require(node.isTextual(), "CSI ACK text field is invalid");
        return node.textValue();
    }

    private static String hash(String value) {
        return ToolPublicationContract.sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void id(String value, int limit) {
        require(value != null && !value.isEmpty() && value.getBytes(StandardCharsets.UTF_8).length <= limit
                && Normalizer.isNormalized(value, Normalizer.Form.NFC)
                && value.codePoints().noneMatch(point -> point <= 31 || point >= 127 && point <= 159
                        || point >= 0xd800 && point <= 0xdfff), "Invalid CSI ACK selector");
    }

    private static boolean uuid(String value) {
        try {
            return value != null && UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private void requireNoTransaction() {
        require(!TransactionSynchronizationManager.isActualTransactionActive()
                && !TransactionSynchronizationManager.isSynchronizationActive()
                && !TransactionSynchronizationManager.hasResource(source), "CSI ACK refuses an ambient transaction");
        try (var connection = source.getConnection()) {
            require(connection.getAutoCommit(), "CSI ACK requires an independent connection");
        } catch (java.sql.SQLException error) {
            throw new IllegalStateException("CSI ACK connection is unavailable");
        }
    }

    private record Plan(RuntimeBindingRecord runtime, RuntimeSessionRecord session,
            Map<String, Object> boot, Map<String, Object> pod, Map<String, Object> request, ObjectNode original) {
    }
}
