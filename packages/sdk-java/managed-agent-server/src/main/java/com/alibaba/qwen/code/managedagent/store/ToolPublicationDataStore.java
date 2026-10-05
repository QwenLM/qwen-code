package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.text;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Duration;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** O2b's publication catalog. Object I/O always runs outside SQL transactions. */
public final class ToolPublicationDataStore {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ObjectMapper ACK_JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);
    private static final int MAX_SEGMENT = 16 * 1024 * 1024;
    private static final int MAX_PAGE = 256 * 1024;
    private static final int MAX_MANIFEST = 64 * 1024;
    private static final int MAX_TERMINAL = 2 * 1024 * 1024;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ToolPublicationStore grants;
    private final ManagedSessionStore sessions;
    private final ToolPublicationObjectStore objects;
    private final Duration operationTimeout;
    private final Duration claimTimeout;
    private final VerificationBudget verificationBudget;
    private final ToolPublicationRetentionStore retention;
    private final DataSource transactionSource;

    public ToolPublicationDataStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ToolPublicationStore grants, ManagedSessionStore sessions, ToolPublicationObjectStore objects,
            Duration operationTimeout, Duration claimTimeout, VerificationBudget verificationBudget) {
        this.jdbc = Objects.requireNonNull(jdbc);
        this.transactions = new TransactionTemplate(Objects.requireNonNull(manager));
        this.grants = Objects.requireNonNull(grants);
        this.sessions = Objects.requireNonNull(sessions);
        this.objects = Objects.requireNonNull(objects);
        this.operationTimeout = Objects.requireNonNull(operationTimeout);
        this.claimTimeout = Objects.requireNonNull(claimTimeout);
        this.verificationBudget = Objects.requireNonNull(verificationBudget);
        this.retention = new ToolPublicationRetentionStore(jdbc, manager);
        this.transactionSource = manager instanceof DataSourceTransactionManager nativeManager
                ? nativeManager.getDataSource() : null;
        require(!operationTimeout.isNegative() && !operationTimeout.isZero()
                && !claimTimeout.isNegative() && !claimTimeout.isZero()
                && claimTimeout.compareTo(operationTimeout) < 0,
                "Invalid publication operation deadlines");
        verificationBudget.timeout(operationTimeout, 0);
    }

    boolean usesDataSource(DataSource source) {
        return source != null && jdbc.getDataSource() == source && transactionSource == source
                && sessions.usesDataSource(source)
                && grants.usesDataSource(source);
    }

    static final class VerifiedAcknowledgement {
        private final String finished;
        private final String outcome;
        private final String outcomeRef;
        private final String captureIdentity;
        private final String catalog;

        private VerifiedAcknowledgement(JsonNode finished, JsonNode outcome, JsonNode outcomeRef,
                JsonNode captureIdentity, JsonNode catalog) {
            this.finished = finished.toString();
            this.outcome = outcome.toString();
            this.outcomeRef = outcomeRef.toString();
            this.captureIdentity = captureIdentity.toString();
            this.catalog = catalog.toString();
        }

        JsonNode finished() { return exactAcknowledgementJson(finished.getBytes(StandardCharsets.UTF_8)); }
        JsonNode outcome() { return exactAcknowledgementJson(outcome.getBytes(StandardCharsets.UTF_8)); }
        JsonNode outcomeRef() { return exactAcknowledgementJson(outcomeRef.getBytes(StandardCharsets.UTF_8)); }
        JsonNode captureIdentity() { return exactAcknowledgementJson(captureIdentity.getBytes(StandardCharsets.UTF_8)); }
        JsonNode catalog() { return exactAcknowledgementJson(catalog.getBytes(StandardCharsets.UTF_8)); }
    }

    VerifiedAcknowledgement verifyOriginalAcknowledgementResources(ToolExecutionRecord execution) {
        require(!TransactionSynchronizationManager.isActualTransactionActive()
                && !TransactionSynchronizationManager.isSynchronizationActive()
                && !TransactionSynchronizationManager.hasResource(jdbc.getDataSource())
                && usesDataSource(jdbc.getDataSource())
                && Boolean.TRUE.equals(jdbc.execute((ConnectionCallback<Boolean>) connection -> connection.getAutoCommit())),
                "Acknowledgement verification requires native stores outside a transaction");
        require(execution != null && execution.getState() == ToolExecutionRecord.State.SETTLED
                && "deferred_v3".equals(execution.getReference().get("dispatchMode")),
                "Original settled execution is unavailable");
        JsonNode original = finishedForBroker(execution);
        require(original != null, "Original finished publication is unavailable");
        String publicationId = text(original, "publicationId");
        JsonNode binding = original.path("binding");
        JsonNode key = binding.path("sessionKey");
        JsonNode terminal = original.path("terminal");
        JsonNode catalog = acknowledgementCatalog(key, publicationId, false);
        byte[] terminalBytes = readResource(key, publicationId, text(terminal, "resourceId"));
        require(terminalBytes.length == terminal.path("byteLength").longValue()
                && ToolPublicationContract.sha256(terminalBytes).equals(text(terminal, "digest")),
                "Original terminal reference changed");
        ToolPublicationContract.parseToolResult("result", terminalBytes, MAX_TERMINAL);
        JsonNode result = exactAcknowledgementJson(terminalBytes);
        require(sameNumericJson(result, JSON.valueToTree(execution.getResult()))
                && result.path("executionStatus").asText().equals(execution.getExecutionStatus())
                && !"not_started".equals(text(result, "executionStatus"))
                && "complete".equals(text(result.path("capture"), "captureStatus"))
                && "pending".equals(text(result.path("capture"), "deliveryStatus")),
                "Original complete Broker result conflicts");
        ((ObjectNode) original).set("result", result);
        validateFinished(key, publicationId, binding, result, () -> {});
        JsonNode manifestRef = result.path("capture").path("manifest");
        byte[] manifestBytes = referencedResource(key, publicationId, manifestRef,
                "managed-tool-result-manifest", MAX_MANIFEST);
        JsonNode manifest = ToolPublicationContract.parseToolResult("manifest", manifestBytes, MAX_MANIFEST);
        ObjectNode capture = JSON.createObjectNode();
        for (String field : List.of("tenantId", "sessionId", "turnId", "executionCallId", "callId",
                "invocationDigest", "bindingGeneration", "captureId", "revision")) {
            capture.set(field, manifest.path(field));
        }
        var publication = jdbc.queryForMap("SELECT producer_phase, admission_resource_id,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ?", scope(key), publicationId);
        require("REFERENCED".equals(publication.get("producer_phase"))
                && ((Number) publication.get("quarantined")).intValue() == 0,
                "Original publication receipt is unavailable");
        String admissionId = (String) publication.get("admission_resource_id");
        byte[] bytes = readResource(key, publicationId, admissionId);
        JsonNode outcome = exactAcknowledgementJson(bytes);
        require(outcome.isObject() && outcome.size() == 5
                && outcome.path("schemaVersion").isIntegralNumber() && outcome.path("schemaVersion").canConvertToLong()
                && outcome.path("schemaVersion").longValue() == 1
                && "committed".equals(text(outcome, "decision"))
                && validAdmissionHistory(outcome.path("history")) && sameNumericJson(outcome.path("envelope"), result)
                && manifestRef.equals(outcome.path("manifestRef")), "Original committed admission conflicts");
        JsonNode outcomeRef = JSON.createObjectNode().put("resourceId", admissionId)
                .put("kind", "managed-tool-outcome").put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", ToolPublicationContract.sha256(bytes));
        require(sameNumericJson(catalog, acknowledgementCatalog(key, publicationId, false)),
                "Original publication resource authorities changed during verification");
        return new VerifiedAcknowledgement(original, outcome, outcomeRef, capture, catalog);
    }

    ToolExecutionRecord lockOriginalAcknowledgementResources(VerifiedAcknowledgement verified) {
        require(verified != null && usesDataSource(jdbc.getDataSource())
                && TransactionSynchronizationManager.isActualTransactionActive(),
                "Acknowledgement settlement requires the native transaction");
        JsonNode finished = verified.finished();
        JsonNode key = finished.path("binding").path("sessionKey");
        String publicationId = text(finished, "publicationId");
        return grants.lockOriginalAcknowledgementResult(key, publicationId, finished);
    }

    void lockOriginalAcknowledgementCatalog(VerifiedAcknowledgement verified) {
        require(verified != null && usesDataSource(jdbc.getDataSource())
                && TransactionSynchronizationManager.isActualTransactionActive(),
                "Acknowledgement settlement requires the native transaction");
        JsonNode finished = verified.finished();
        JsonNode key = finished.path("binding").path("sessionKey");
        require(sameNumericJson(verified.catalog(), acknowledgementCatalog(key, text(finished, "publicationId"), true)),
                "Original publication resource authorities changed");
    }

    private JsonNode acknowledgementCatalog(JsonNode key, String publicationId, boolean locked) {
        String suffix = locked ? " FOR UPDATE" : "";
        ObjectNode catalog = JSON.createObjectNode();
        var objects = jdbc.queryForList("SELECT scope_key, publication_id, slot_key, resource_id, resource_kind, byte_length, sha256,"
                + " object_key, state, operation_id, inline_bytes FROM qwen_tool_publication_object"
                + " WHERE scope_key = ? AND publication_id = ? ORDER BY slot_key LIMIT 4097" + suffix,
                scope(key), publicationId);
        require(objects.size() <= 4096, "Original publication catalog exceeds its bound");
        for (var object : objects) {
            Object bytes = object.remove("inline_bytes");
            object.put("inlineDigest", bytes instanceof byte[] inline ? ToolPublicationContract.sha256(inline) : null);
            require(scope(key).equals(object.get("scope_key")) && publicationId.equals(object.get("publication_id"))
                    && "VERIFIED".equals(object.get("state")), "Original publication has unresolved objects");
        }
        catalog.set("objects", JSON.valueToTree(objects));
        var seals = jdbc.queryForList("SELECT scope_key, publication_id, stream_id, segment_count, byte_length, sha256, operation_id"
                + " FROM qwen_tool_publication_seal WHERE scope_key = ? AND publication_id = ?"
                + " ORDER BY stream_id" + suffix, scope(key), publicationId);
        require(seals.size() <= 2, "Original publication seal catalog conflicts");
        for (var seal : seals) {
            require(scope(key).equals(seal.get("scope_key")) && publicationId.equals(seal.get("publication_id")),
                    "Original publication seal identity conflicts");
        }
        catalog.set("seals", JSON.valueToTree(seals));
        return catalog;
    }

    static JsonNode exactAcknowledgementJson(byte[] bytes) {
        try {
            ToolPublicationContract.readJson(bytes);
            return ACK_JSON.readTree(bytes);
        } catch (IOException error) {
            throw new IllegalArgumentException("Original acknowledgement JSON is unavailable");
        }
    }

    static boolean sameNumericJson(JsonNode left, JsonNode right) {
        return left.equals((a, b) -> a.isNumber() && b.isNumber()
                ? a.decimalValue().compareTo(b.decimalValue()) : a.equals(b) ? 0 : 1, right);
    }

    private static boolean validAdmissionHistory(JsonNode history) {
        return history.isObject() && history.size() == 4
                && text(history, "messageId").matches(
                        "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                && !text(history, "timestamp").isBlank() && !text(history, "model").isBlank()
                && history.path("parts").isArray()
                && history.toString().getBytes(StandardCharsets.UTF_8).length <= 64 * 1024;
    }

    public record VerificationBudget(long bytesPerSecond, Duration maximumTimeout) {
        public VerificationBudget {
            require(bytesPerSecond > 0 && maximumTimeout != null && !maximumTimeout.isNegative()
                    && !maximumTimeout.isZero() && maximumTimeout.compareTo(Duration.ofMinutes(25)) <= 0,
                    "Invalid publication verification budget");
        }

        public Duration timeout(Duration base, long bytes) {
            require(bytes >= 0, "Invalid publication verification size");
            long seconds = bytes / bytesPerSecond + (bytes % bytesPerSecond == 0 ? 0 : 1);
            Duration window = base.plusSeconds(seconds);
            require(window.compareTo(maximumTimeout) <= 0,
                    "Publication verification exceeds its configured budget");
            return window;
        }
    }

    public JsonNode publishSegment(JsonNode key, String publicationId, String token,
            String operationId, String streamId, int ordinal, byte[] input, String expectedDigest) {
        require("stdout".equals(streamId) || "stderr".equals(streamId), "Invalid stream ID");
        require(ordinal >= 0 && ordinal < 65536, "Invalid ordinal");
        return publish(key, publicationId, token, operationId, "segment:" + streamId + ":" + ordinal,
                null, input, expectedDigest, MAX_SEGMENT);
    }

    public JsonNode publishResource(JsonNode key, String publicationId, String token,
            String operationId, String slot, String kind, byte[] input) {
        require(kind != null && (("managed-tool-result-page".equals(kind)
                && slot.matches("page:(stdout|stderr):(?:0|[1-9][0-9]{0,4})"))
                || ("managed-tool-result-manifest".equals(kind) && "manifest:1".equals(slot))
                || ("managed-tool-result-content".equals(kind) && slot.matches("content:[a-z0-9_-]{1,128}"))),
                "Invalid publication resource slot");
        int maximum = "managed-tool-result-page".equals(kind) ? MAX_PAGE
                : "managed-tool-result-manifest".equals(kind) ? MAX_MANIFEST : MAX_SEGMENT;
        if ("managed-tool-result-page".equals(kind)) {
            JsonNode page = ToolPublicationContract.parseToolResult("page", input, MAX_PAGE);
            require(slot.equals("page:" + text(page, "streamId") + ":"
                    + page.path("firstOrdinal").asInt(-1)), "Publication page slot conflicts");
        } else if ("managed-tool-result-manifest".equals(kind)) {
            JsonNode manifest = ToolPublicationContract.parseToolResult("manifest", input, MAX_MANIFEST);
            require(manifest.path("revision").asInt(-1) == 1, "Publication manifest revision conflicts");
        }
        return publish(key, publicationId, token, operationId, slot, kind, input, null, maximum);
    }

    public JsonNode seal(JsonNode key, String publicationId, String token, String operationId,
            String streamId, int segmentCount, long byteLength, String digest) {
        requireStagedCall(key, publicationId);
        require("stdout".equals(streamId) || "stderr".equals(streamId), "Invalid stream ID");
        require(segmentCount >= 0 && segmentCount <= 65536 && byteLength >= 0
                && digest != null && digest.matches("[0-9a-f]{64}"), "Invalid seal");
        String scope = scope(key);
        String slot = "seal:" + streamId;
        String requestDigest = hash(JSON.createArrayNode().add(slot).add(segmentCount)
                .add(byteLength).add(digest).toString());
        ScanClaim claim = transactions.execute(status -> claimScan(key, scope, publicationId, token,
                operationId, slot, requestDigest));
        require(claim != null, "Seal operation unavailable");
        if (claim.receipt() != null) {
            return claim.receipt();
        }
        try {
            List<Map<String, Object>> existing = jdbc.queryForList("SELECT segment_count, byte_length, sha256"
                    + " FROM qwen_tool_publication_seal WHERE scope_key = ? AND publication_id = ?"
                    + " AND stream_id = ?", scope, publicationId, streamId);
            if (!existing.isEmpty()) {
                Map<String, Object> row = existing.get(0);
                requireContract(((Number) row.get("segment_count")).intValue() == segmentCount
                        && ((Number) row.get("byte_length")).longValue() == byteLength
                        && digest.equals(row.get("sha256")),
                        HttpStatus.CONFLICT, "managed_tool_result_conflict", "Seal conflicts");
            }
            StreamScan scan = scan(scope, publicationId, streamId, segmentCount,
                    heartbeat(key, scope, publicationId, token, operationId, claim.epoch()));
            requireContract(scan.segmentCount() == segmentCount,
                    HttpStatus.CONFLICT, "managed_tool_result_conflict", "Seal has missing or extra segments");
            requireContract(scan.byteLength() == byteLength && scan.digest().equals(digest),
                    HttpStatus.BAD_REQUEST, "managed_tool_result_digest_mismatch", "Seal digest mismatch");
            return transactions.execute(status -> {
                authorize(key, scope, publicationId, token);
                checkScanClaim(scope, publicationId, operationId, claim.epoch());
                List<Map<String, Object>> old = jdbc.queryForList("SELECT segment_count, byte_length, sha256"
                        + " FROM qwen_tool_publication_seal WHERE scope_key = ? AND publication_id = ?"
                        + " AND stream_id = ?", scope, publicationId, streamId);
                if (old.isEmpty()) {
                    jdbc.update("INSERT INTO qwen_tool_publication_seal (scope_key, publication_id, stream_id,"
                                    + " segment_count, byte_length, sha256, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            scope, publicationId, streamId, segmentCount, byteLength, digest, operationId);
                } else {
                    requireContract(((Number) old.get(0).get("segment_count")).intValue() == segmentCount
                            && ((Number) old.get(0).get("byte_length")).longValue() == byteLength
                            && digest.equals(old.get(0).get("sha256")),
                            HttpStatus.CONFLICT, "managed_tool_result_conflict", "Seal conflicts");
                }
                ObjectNode receipt = JSON.createObjectNode().put("segmentCount", segmentCount)
                        .put("byteLength", byteLength).put("digest", digest);
                finishScan(scope, publicationId, operationId, receipt);
                return receipt;
            });
        } catch (RuntimeException error) {
            try {
                abandonScan(scope, publicationId, operationId, claim.epoch());
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
    }

    public JsonNode prefix(JsonNode key, String publicationId, String token, String operationId,
            String streamId) {
        requireStagedCall(key, publicationId);
        require("stdout".equals(streamId) || "stderr".equals(streamId), "Invalid stream ID");
        String scope = scope(key);
        String slot = "prefix:" + streamId;
        String requestDigest = hash(slot);
        ScanClaim claim = transactions.execute(status -> claimScan(key, scope, publicationId, token,
                operationId, slot, requestDigest));
        require(claim != null, "Prefix operation unavailable");
        if (claim.receipt() != null) {
            return claim.receipt();
        }
        try {
            StreamScan scan = scan(scope, publicationId, streamId, -1,
                    heartbeat(key, scope, publicationId, token, operationId, claim.epoch()));
            return transactions.execute(status -> {
                authorize(key, scope, publicationId, token);
                checkScanClaim(scope, publicationId, operationId, claim.epoch());
                List<Map<String, Object>> seals = jdbc.queryForList("SELECT segment_count, byte_length, sha256"
                        + " FROM qwen_tool_publication_seal WHERE scope_key = ? AND publication_id = ?"
                        + " AND stream_id = ?", scope, publicationId, streamId);
                boolean sealed = !seals.isEmpty();
                if (sealed) {
                    Map<String, Object> row = seals.get(0);
                    require(((Number) row.get("segment_count")).intValue() == scan.segmentCount()
                            && ((Number) row.get("byte_length")).longValue() == scan.byteLength()
                            && scan.digest().equals(row.get("sha256")), "Sealed stream changed");
                }
                ObjectNode receipt = JSON.createObjectNode().put("segmentCount", scan.segmentCount())
                        .put("byteLength", scan.byteLength()).put("digest", scan.digest()).put("sealed", sealed);
                finishScan(scope, publicationId, operationId, receipt);
                return receipt;
            });
        } catch (RuntimeException error) {
            try {
                abandonScan(scope, publicationId, operationId, claim.epoch());
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
    }

    public JsonNode operationStatus(JsonNode key, String publicationId, String token, String operationId) {
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid publication operation ID");
        String scope = scope(key);
        var rows = jdbc.query("SELECT o.state, o.receipt_json,"
                        + " COALESCE(o.recovery_deadline, o.deadline) AS deadline,"
                        + " CASE WHEN o.claim_owner IS NULL OR o.claim_until < CURRENT_TIMESTAMP(6)"
                        + " THEN 1 ELSE 0 END AS retryable, p.tenant_id, p.token_hash,"
                        + " p.workspace_id, p.session_id FROM qwen_tool_publication_operation o"
                        + " JOIN qwen_tool_publication p ON p.scope_key = o.scope_key"
                        + " AND p.publication_id = o.publication_id WHERE o.scope_key = ?"
                        + " AND o.publication_id = ? AND o.operation_id = ?",
                (r, n) -> Map.<String, Object>of("state", r.getString("state"), "deadline", r.getTimestamp("deadline"),
                        "tenant", r.getString("tenant_id"), "workspace", r.getString("workspace_id"),
                        "session", r.getString("session_id"), "tokenHash", r.getString("token_hash"),
                        "retryable", r.getInt("retryable"), "receipt",
                        r.getString("receipt_json") == null ? "" : r.getString("receipt_json")),
                scope, publicationId, operationId);
        if (rows.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "managed_tool_publication_operation_unknown", "Publication operation is unknown");
        }
        Map<String, Object> row = rows.get(0);
        require(text(key, "tenantId").equals(row.get("tenant"))
                && text(key, "workspaceId").equals(row.get("workspace"))
                && text(key, "sessionId").equals(row.get("session"))
                && MessageDigest.isEqual(ToolPublicationContract.tokenHash(token)
                        .getBytes(StandardCharsets.US_ASCII),
                        ((String) row.get("tokenHash")).getBytes(StandardCharsets.US_ASCII)),
                "Publication scope conflicts");
        String state = (String) row.get("state");
        ObjectNode response = JSON.createObjectNode().put("state", state);
        if ("SUCCEEDED".equals(state)) {
            response.set("receipt", ToolPublicationContract.readJson(
                    ((String) row.get("receipt")).getBytes(StandardCharsets.UTF_8)));
        } else if (!((Timestamp) row.get("deadline")).after(now())) {
            response.put("state", "EXPIRED");
        } else if ("PENDING".equals(state) && ((Number) row.get("retryable")).intValue() == 1) {
            response.put("state", "RETRYABLE");
        }
        return response;
    }

    public JsonNode recoverOperation(JsonNode key, String publicationId, String token, String operationId) {
        requireStagedCall(key, publicationId);
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid publication operation ID");
        String scope = scope(key);
        transactions.executeWithoutResult(status -> {
            var authorization = authorizeClaim(key, scope, publicationId, token);
            var publication = jdbc.queryForMap("SELECT producer_phase, finish_operation_id,"
                    + " finish_predecessor_id, CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                    + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                    scope, publicationId);
            require(((Number) publication.get("quarantined")).intValue() == 0,
                    "Publication is quarantined");
            List<Operation> rows = operation(scope, publicationId, operationId, true);
            require(rows.size() == 1, "Publication operation is missing");
            Operation row = rows.get(0);
            if (authorization.execution().getState()
                    == ToolExecutionRecord.State.SETTLED) {
                exactSucceededReplay(scope, publicationId, operationId, row.slot(), row.digest());
                return;
            }
            require(!row.slot().startsWith("prefix:"), "Expired prefix cannot be recovered");
            if ("SUCCEEDED".equals(row.state())) {
                return;
            }
            require("OPEN".equals(publication.get("producer_phase"))
                    || "FINISHING".equals(publication.get("producer_phase"))
                    && (operationId.equals(publication.get("finish_operation_id"))
                    || operationId.equals(publication.get("finish_predecessor_id"))),
                    "Publication is finishing");
            if (!row.slot().startsWith("seal:")) {
                List<Stored> candidates = stored(scope, publicationId, row.slot());
                require(candidates.size() == 1 && "CANDIDATE".equals(candidates.get(0).state())
                        && operationId.equals(candidates.get(0).operationId()),
                        "Publication candidate cannot be recovered");
            }
            Timestamp current = now();
            if (row.deadline().after(current)) {
                return;
            }
            // A recovery starts a new bounded verification attempt. It does
            // not extend the original deadline, change bytes or release quota.
            String active = availableActive(scope, publicationId, operationId, current);
            requireContract(active == null || operationId.equals(active), HttpStatus.CONFLICT,
                    "managed_tool_publication_busy", "Publication is busy");
            jdbc.update("UPDATE qwen_tool_publication_operation SET recovery_deadline = ?,"
                            + " claim_epoch = claim_epoch + 1, claim_owner = NULL, claim_until = NULL"
                            + " WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                    new Timestamp(current.getTime() + verificationWindow(scope, publicationId,
                            row.slot()).toMillis()), scope, publicationId, operationId);
            if (!"terminal".equals(row.slot())) {
                jdbc.update("UPDATE qwen_tool_publication SET active_operation_id = ?"
                        + " WHERE scope_key = ? AND publication_id = ?", operationId, scope, publicationId);
            }
        });
        return operationStatus(key, publicationId, token, operationId);
    }

    public JsonNode finished(JsonNode key, String publicationId, String writerToken) {
        sessions.restore(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), writerToken);
        return finishedInternal(key, publicationId);
    }

    JsonNode verifyFinished(JsonNode key, String publicationId, String writerToken) {
        JsonNode finished = finished(key, publicationId, writerToken);
        validateFinished(key, publicationId, finished.path("binding"), finished.path("result"), () -> {});
        return finished;
    }

    /** Broker-only lookup of the immutable terminal envelope after FINISHED. */
    public JsonNode finishedForBroker(
            com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord execution) {
        String publicationId = (String) execution.getReference().get("publicationId");
        if (publicationId == null) {
            return null;
        }
        var rows = jdbc.queryForList("SELECT tenant_id, workspace_id, session_id, binding_json,"
                + " producer_phase FROM qwen_tool_publication WHERE publication_id = ?"
                + " AND execution_key = ?", publicationId,
                hash(execution.getExecutionCallId()));
        require(rows.size() <= 1, "Original publication is ambiguous");
        if (rows.isEmpty()) {
            return null;
        }
        var row = rows.get(0);
        JsonNode binding = ToolPublicationContract.parseBytes("binding",
                ((String) row.get("binding_json")).getBytes(StandardCharsets.UTF_8));
        require(execution.getHarnessSessionId().equals(row.get("session_id"))
                && execution.getExecutionCallId().equals(text(binding, "executionCallId"))
                && execution.getBindingId().equals(text(binding, "runtimeBindingId"))
                && Long.toString(execution.getRuntimeGeneration())
                        .equals(text(binding, "bindingGeneration"))
                && execution.getRequestDigest().equals(text(binding, "requestDigest"))
                && execution.getReference().get("argsDigest")
                        .equals(text(binding.path("reference"), "argsDigest")),
                "Finished publication belongs to another execution");
        if (!"FINISHED".equals(row.get("producer_phase"))
                && !"REFERENCED".equals(row.get("producer_phase"))) {
            return null;
        }
        JsonNode key = JSON.createObjectNode().put("tenantId", (String) row.get("tenant_id"))
                .put("workspaceId", (String) row.get("workspace_id"))
                .put("sessionId", (String) row.get("session_id"));
        return finishedInternal(key, publicationId);
    }

    public JsonNode receiptForBroker(
            com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord execution) {
        JsonNode finished = finishedForBroker(execution);
        if (finished == null) {
            return null;
        }
        JsonNode binding = finished.path("binding");
        JsonNode key = binding.path("sessionKey");
        String publicationId = text(binding, "publicationId");
        String scope = scope(key);
        var row = jdbc.queryForMap("SELECT producer_phase, admission_resource_id, receipt_sequence,"
                + " receipt_revision FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND publication_id = ?", scope, publicationId);
        if (!"REFERENCED".equals(row.get("producer_phase"))) {
            return null;
        }
        String resourceId = (String) row.get("admission_resource_id");
        long sequence = ((Number) row.get("receipt_sequence")).longValue();
        long revision = ((Number) row.get("receipt_revision")).longValue();
        require(sequence > 0 && revision > 0, "Original receipt pointer is invalid");
        JsonNode outcome = ToolPublicationContract.readJson(readResource(key,
                publicationId, resourceId));
        require(outcome.path("envelope").equals(finished.path("result")),
                "Original receipt result changed");
        byte[] records = jdbc.queryForObject("SELECT record_bytes FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                byte[].class, text(key, "tenantId"), text(key, "sessionId"), revision);
        require(records != null, "Original receipt journal is missing");
        boolean matched = false;
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = ToolPublicationContract.readJson(line.getBytes(StandardCharsets.UTF_8));
            JsonNode event = record.path("managedSession");
            if ("tool.receipt".equals(text(event, "kind"))
                    && event.path("sequence").asLong(-1) == sequence) {
                require(text(binding, "executionCallId").equals(
                        text(event.path("payload"), "executionCallId"))
                        && resourceId.equals(text(event.path("payload")
                                .path("toolOutcomeRef"), "resourceId")),
                        "Original receipt event conflicts");
                matched = true;
            }
        }
        require(matched, "Original receipt event is missing");
        ObjectNode receipt = JSON.createObjectNode()
                .put("executionCallId", execution.getExecutionCallId())
                .put("deliveryStatus", text(outcome, "decision"));
        receipt.set("manifest", outcome.path("manifestRef"));
        if ("committed".equals(text(outcome, "decision"))) {
            receipt.put("historyRevision", sequence);
        } else {
            receipt.putNull("historyRevision");
        }
        return receipt;
    }

    private JsonNode finishedInternal(JsonNode key, String publicationId) {
        String scope = scope(key);
        Map<String, Object> publication = jdbc.queryForMap("SELECT producer_phase,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined, binding_json,"
                + " terminal_resource_id, finish_operation_id FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ? AND tenant_id = ?"
                + " AND workspace_id = ? AND session_id = ?", scope, publicationId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require("FINISHED".equals(publication.get("producer_phase"))
                || "REFERENCED".equals(publication.get("producer_phase")),
                "Publication has no finished result");
        require(((Number) publication.get("quarantined")).intValue() == 0,
                "Finished publication is quarantined");
        String resourceId = (String) publication.get("terminal_resource_id");
        Resource terminal = catalogResource(key, publicationId, resourceId);
        require("managed-tool-terminal".equals(terminal.kind())
                && terminal.length() <= MAX_TERMINAL, "Finished terminal is invalid");
        JsonNode result = ToolPublicationContract.parseToolResult("result",
                readResource(key, publicationId, resourceId), MAX_TERMINAL);
        ObjectNode response = JSON.createObjectNode()
                .put("publicationId", publicationId)
                .put("finishOperationId", (String) publication.get("finish_operation_id"));
        response.set("binding", ToolPublicationContract.readJson(
                ((String) publication.get("binding_json")).getBytes(StandardCharsets.UTF_8)));
        response.set("result", result);
        response.set("terminal", JSON.createObjectNode().put("resourceId", resourceId)
                .put("kind", terminal.kind()).put("schemaVersion", 1)
                .put("byteLength", terminal.length()).put("digest", terminal.digest()));
        return response;
    }

    public JsonNode prepareAdmission(JsonNode key, String publicationId,
            String writerId, long writerGeneration, String writerToken, JsonNode outcome) {
        requireStagedCall(key, publicationId);
        require(outcome != null && outcome.isObject()
                && outcome.path("schemaVersion").asInt(-1) == 1,
                "Invalid admission outcome");
        byte[] bytes = outcome.toString().getBytes(StandardCharsets.UTF_8);
        require(bytes.length <= MAX_TERMINAL, "Admission outcome is too large");
        JsonNode original = finished(key, publicationId, writerToken);
        JsonNode envelope = original.path("result");
        String decision = "complete".equals(text(envelope.path("capture"), "captureStatus"))
                ? "committed" : "blocked";
        JsonNode history = outcome.path("history");
        require(decision.equals(text(outcome, "decision"))
                && envelope.equals(outcome.path("envelope"))
                && envelope.path("capture").path("manifest").equals(outcome.path("manifestRef"))
                && validAdmissionHistory(history),
                "Admission decision or original result conflicts");
        String digest = ToolPublicationContract.sha256(bytes);
        String scope = scope(key);
        AdmissionCandidate candidate = transactions.execute(status -> {
            lockOriginalSettledResult(key, publicationId, original);
            lockTenant(key);
            sessions.lockPublicationWriter(text(key, "tenantId"), text(key, "workspaceId"),
                    text(key, "sessionId"), writerId, writerGeneration, writerToken);
            var publication = jdbc.queryForMap("SELECT producer_phase,"
                    + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined,"
                    + " admission_bytes, admission_used_bytes,"
                    + " admission_resource_id, terminal_resource_id FROM qwen_tool_publication"
                    + " WHERE scope_key = ? AND publication_id = ? AND tenant_id = ?"
                    + " AND workspace_id = ? AND session_id = ? FOR UPDATE",
                    scope, publicationId, text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
            require("FINISHED".equals(publication.get("producer_phase"))
                    || "REFERENCED".equals(publication.get("producer_phase")),
                    "Publication is not finished");
            require(((Number) publication.get("quarantined")).intValue() == 0,
                    "Publication is quarantined");
            require(original.path("terminal").path("resourceId").asText()
                    .equals(publication.get("terminal_resource_id")),
                    "Finished root changed");
            String resourceId = "result-" + hash(scope + ":" + publicationId + ":admission").substring(0, 32);
            String objectKey = bytes.length <= 64 * 1024 ? null
                    : "managed-tool-results/" + scope + "/" + publicationId + "/" + hash("admission");
            List<Stored> stored = stored(scope, publicationId, "admission");
            if (stored.isEmpty()) {
                long used = ((Number) publication.get("admission_used_bytes")).longValue();
                long allocated = ((Number) publication.get("admission_bytes")).longValue();
                requireCapacity(bytes.length, allocated - used);
                jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key,"
                                + " resource_id, resource_kind, byte_length, sha256, object_key, state,"
                                + " operation_id, created_at) VALUES (?, ?, 'admission', ?, 'managed-tool-outcome',"
                                + " ?, ?, ?, 'CANDIDATE', 'admission', ?)",
                        scope, publicationId, resourceId, bytes.length, digest, objectKey, now());
                jdbc.update("UPDATE qwen_tool_publication SET admission_used_bytes = ?"
                        + " WHERE scope_key = ? AND publication_id = ?", used + bytes.length, scope, publicationId);
            } else {
                require(stored.get(0).length() == bytes.length && digest.equals(stored.get(0).digest())
                        && resourceId.equals(stored.get(0).resourceId()), "Admission candidate conflicts");
                require(!"QUARANTINED".equals(stored.get(0).state()),
                        "Admission candidate is quarantined");
            }
            return new AdmissionCandidate(resourceId, objectKey,
                    !stored.isEmpty() && "VERIFIED".equals(stored.get(0).state()));
        });
        require(candidate != null, "Admission candidate is unavailable");
        if (candidate.objectKey() != null) {
            retention.put(key, scope, publicationId, candidate.objectKey(), bytes, objects);
            try {
                verify(scope, publicationId, candidate.objectKey(), bytes.length, digest);
            } catch (IllegalArgumentException error) {
                try {
                    if (candidate.verified()) {
                        quarantine(scope, publicationId, "admission");
                    } else {
                        quarantineCandidate(scope, publicationId, "admission", "admission");
                    }
                } catch (RuntimeException cleanup) {
                    error.addSuppressed(cleanup);
                }
                throw error;
            }
        }
        if (!candidate.verified()) {
            transactions.executeWithoutResult(status -> {
                lockOriginalSettledResult(key, publicationId, original);
                lockTenant(key);
                sessions.lockPublicationWriter(text(key, "tenantId"), text(key, "workspaceId"),
                        text(key, "sessionId"), writerId, writerGeneration, writerToken);
                var publication = jdbc.queryForMap("SELECT producer_phase, terminal_resource_id,"
                        + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                        + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                        scope, publicationId);
                require("FINISHED".equals(publication.get("producer_phase"))
                        && ((Number) publication.get("quarantined")).intValue() == 0
                        && original.path("terminal").path("resourceId").asText()
                        .equals(publication.get("terminal_resource_id")), "Admission publication changed");
                Stored row = stored(scope, publicationId, "admission", true).get(0);
                require("CANDIDATE".equals(row.state()) && digest.equals(row.digest())
                        && row.length() == bytes.length, "Admission candidate changed");
                if (candidate.objectKey() == null) {
                    jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ?"
                            + " WHERE scope_key = ? AND publication_id = ? AND slot_key = 'admission'",
                            bytes, scope, publicationId);
                }
                jdbc.update("UPDATE qwen_tool_publication_object SET state = 'VERIFIED'"
                        + " WHERE scope_key = ? AND publication_id = ? AND slot_key = 'admission'",
                        scope, publicationId);
                jdbc.update("UPDATE qwen_tool_publication SET admission_resource_id = ?"
                        + " WHERE scope_key = ? AND publication_id = ?",
                        candidate.resourceId(), scope, publicationId);
            });
        }
        return JSON.createObjectNode().put("resourceId", candidate.resourceId())
                .put("kind", "managed-tool-outcome").put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", digest);
    }

    public JsonNode finish(JsonNode key, String publicationId, String token,
            String operationId, byte[] bytes) {
        requireStagedCall(key, publicationId);
        require(bytes != null, "Missing terminal result");
        JsonNode result = ToolPublicationContract.parseToolResult("result", bytes, MAX_TERMINAL);
        require(!"not_started".equals(text(result, "executionStatus"))
                && result.path("capture").isObject()
                && "pending".equals(text(result.path("capture"), "deliveryStatus")),
                "Only a started pending capture can finish");
        String digest = ToolPublicationContract.sha256(bytes);
        String scope = scope(key);
        FinishClaim claim = transactions.execute(status -> beginFinish(key, scope,
                publicationId, token, operationId, bytes.length, digest));
        require(claim != null, "Finish operation unavailable");
        if (claim.receipt() != null) {
            finishedInternal(key, publicationId);
            return claim.receipt();
        }
        try {
            if (claim.predecessor() != null) {
                List<Operation> previous = operation(scope, publicationId, claim.predecessor(), false);
                requireContract(previous.size() == 1 && "SUCCEEDED".equals(previous.get(0).state()),
                        HttpStatus.CONFLICT, "managed_tool_publication_busy", "Finish predecessor has not completed");
            }
            validateFinished(key, publicationId, claim.binding(), result,
                    heartbeat(key, scope, publicationId, token, operationId, claim.epoch()));
            if (claim.objectKey() != null) {
                retention.put(key, scope, publicationId, claim.objectKey(), bytes, objects);
                try {
                    verify(scope, publicationId, claim.objectKey(), bytes.length, digest);
                } catch (IllegalArgumentException error) {
                    quarantineCandidate(scope, publicationId, "terminal", operationId);
                    throw error;
                }
            }
            return transactions.execute(status -> installFinish(key, scope, publicationId,
                    token, operationId, claim, bytes, digest));
        } catch (RuntimeException error) {
            try {
                abandonScan(scope, publicationId, operationId, claim.epoch());
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
    }

    private FinishClaim beginFinish(JsonNode key, String scope, String publicationId,
            String token, String operationId, int length, String digest) {
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid finish operation ID");
        var authorization = authorizeClaim(key, scope, publicationId, token);
        JsonNode binding = authorization.binding();
        if (authorization.execution().getState()
                == ToolExecutionRecord.State.SETTLED) {
            JsonNode receipt = exactSucceededReplay(scope, publicationId, operationId,
                    "terminal", requestDigest("terminal", length, digest));
            Stored terminal = stored(scope, publicationId, "terminal").get(0);
            return new FinishClaim(0, null, terminal.objectKey(), terminal.resourceId(), binding, receipt);
        }
        Map<String, Object> row = jdbc.queryForMap("SELECT producer_phase, active_operation_id,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined,"
                + " finish_operation_id, finish_predecessor_id, finish_digest, producer_bytes,"
                + " producer_used_bytes FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND publication_id = ?", scope, publicationId);
        require(((Number) row.get("quarantined")).intValue() == 0,
                "Publication is quarantined");
        String phase = (String) row.get("producer_phase");
        require("OPEN".equals(phase) || "FINISHING".equals(phase) || "FINISHED".equals(phase),
                "Publication cannot finish");
        String resourceId = "result-" + hash(scope + ":" + publicationId + ":terminal").substring(0, 32);
        String objectKey = length <= 64 * 1024 ? null
                : "managed-tool-results/" + scope + "/" + publicationId + "/" + hash("terminal");
        String requestDigest = requestDigest("terminal", length, digest);
        List<Operation> prior = operation(scope, publicationId, operationId, true);
        if ("FINISHED".equals(phase)) {
            require(operationId.equals(row.get("finish_operation_id"))
                    && digest.equals(row.get("finish_digest")) && prior.size() == 1
                    && "SUCCEEDED".equals(prior.get(0).state()), "Finished publication conflicts");
            String saved = jdbc.queryForObject("SELECT receipt_json FROM qwen_tool_publication_operation"
                    + " WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                    String.class, scope, publicationId, operationId);
            return new FinishClaim(0, null, objectKey, resourceId, binding,
                    ToolPublicationContract.readJson(saved.getBytes(StandardCharsets.UTF_8)));
        }
        Timestamp now = now();
        if ("FINISHING".equals(phase)) {
            require(!"QUARANTINED".equals(stored(scope, publicationId, "terminal").get(0).state()),
                    "Terminal candidate is quarantined");
            require(operationId.equals(row.get("finish_operation_id"))
                    && digest.equals(row.get("finish_digest")) && prior.size() == 1
                    && requestDigest.equals(prior.get(0).digest()), "Finish replay conflicts");
            requireUnexpired(prior.get(0).deadline(), now);
            requireContract(prior.get(0).claimUntil() == null || !prior.get(0).claimUntil().after(now),
                    HttpStatus.CONFLICT, "managed_tool_publication_busy", "Finish operation is busy");
        } else {
            require(prior.isEmpty(), "Finish operation ID conflicts");
            long used = ((Number) row.get("producer_used_bytes")).longValue();
            long allocated = ((Number) row.get("producer_bytes")).longValue();
            requireCapacity(length, allocated - used);
            jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key,"
                            + " resource_id, resource_kind, byte_length, sha256, object_key, state, operation_id,"
                            + " created_at) VALUES (?, ?, 'terminal', ?, 'managed-tool-terminal', ?, ?, ?,"
                            + " 'CANDIDATE', ?, ?)",
                    scope, publicationId, resourceId, length, digest, objectKey, operationId, now);
            jdbc.update("UPDATE qwen_tool_publication SET producer_phase = 'FINISHING',"
                            + " finish_operation_id = ?, finish_predecessor_id = active_operation_id,"
                            + " finish_digest = ?, producer_used_bytes = ? WHERE scope_key = ?"
                            + " AND publication_id = ?",
                    operationId, digest, used + length, scope, publicationId);
        }
        long epoch = prior.isEmpty() ? 1 : prior.get(0).epoch() + 1;
        Timestamp until = new Timestamp(now.getTime() + claimTimeout.toMillis());
        if (prior.isEmpty()) {
            jdbc.update("INSERT INTO qwen_tool_publication_operation (scope_key, publication_id,"
                            + " operation_id, request_digest, slot_key, state, claim_owner, claim_epoch,"
                            + " claim_until, deadline, created_at) VALUES (?, ?, ?, ?, 'terminal', 'PENDING',"
                            + " ?, ?, ?, ?, ?)", scope, publicationId, operationId, requestDigest,
                    UUID.randomUUID().toString(), epoch, until,
                    new Timestamp(now.getTime() + verificationWindow(scope, publicationId, "terminal").toMillis()), now);
        } else {
            jdbc.update("UPDATE qwen_tool_publication_operation SET claim_owner = ?, claim_epoch = ?,"
                            + " claim_until = ? WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                    UUID.randomUUID().toString(), epoch, until, scope, publicationId, operationId);
        }
        String predecessor = jdbc.queryForObject("SELECT finish_predecessor_id FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ?", String.class, scope, publicationId);
        return new FinishClaim(epoch, predecessor, objectKey, resourceId, binding, null);
    }

    private JsonNode installFinish(JsonNode key, String scope, String publicationId, String token,
            String operationId, FinishClaim claim, byte[] bytes, String digest) {
        authorize(key, scope, publicationId, token);
        List<Operation> current = operation(scope, publicationId, operationId, true);
        requireOperationClaim(current, claim.epoch(), now());
        Map<String, Object> publication = jdbc.queryForMap("SELECT producer_phase,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined, finish_operation_id,"
                + " finish_predecessor_id, finish_digest, active_operation_id, capture_used_bytes,"
                + " producer_used_bytes FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND publication_id = ?", scope, publicationId);
        require("FINISHING".equals(publication.get("producer_phase"))
                && operationId.equals(publication.get("finish_operation_id"))
                && digest.equals(publication.get("finish_digest"))
                && publication.get("active_operation_id") == null
                && ((Number) publication.get("quarantined")).intValue() == 0,
                "Finish barrier changed");
        if (claim.predecessor() != null) {
            List<Operation> previous = operation(scope, publicationId, claim.predecessor(), true);
            requireContract(previous.size() == 1 && "SUCCEEDED".equals(previous.get(0).state()),
                    HttpStatus.CONFLICT, "managed_tool_publication_busy", "Finish predecessor has not completed");
        }
        Stored terminal = stored(scope, publicationId, "terminal", true).get(0);
        require("CANDIDATE".equals(terminal.state()) && terminal.length() == bytes.length
                && digest.equals(terminal.digest()), "Terminal candidate changed");
        if (claim.objectKey() == null) {
            jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ?"
                    + " WHERE scope_key = ? AND publication_id = ? AND slot_key = 'terminal'",
                    bytes, scope, publicationId);
        }
        jdbc.update("UPDATE qwen_tool_publication_object SET state = 'VERIFIED'"
                + " WHERE scope_key = ? AND publication_id = ? AND slot_key = 'terminal'",
                scope, publicationId);
        ObjectNode ref = JSON.createObjectNode().put("resourceId", claim.resourceId())
                .put("kind", "managed-tool-terminal").put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", digest);
        ObjectNode receipt = JSON.createObjectNode().put("producerPhase", "FINISHED");
        receipt.set("terminal", ref);
        jdbc.update("UPDATE qwen_tool_publication SET producer_phase = 'FINISHED',"
                        + " terminal_resource_id = ?, capture_held_bytes = capture_used_bytes,"
                        + " producer_held_bytes = producer_used_bytes WHERE scope_key = ?"
                        + " AND publication_id = ?", claim.resourceId(), scope, publicationId);
        jdbc.update("UPDATE qwen_tool_publication_operation SET state = 'SUCCEEDED', receipt_json = ?,"
                        + " claim_owner = NULL, claim_until = NULL WHERE scope_key = ?"
                        + " AND publication_id = ? AND operation_id = ?",
                receipt.toString(), scope, publicationId, operationId);
        return receipt;
    }

    private void validateFinished(JsonNode key, String publicationId, JsonNode binding,
            JsonNode result, Runnable heartbeat) {
        JsonNode capture = result.path("capture");
        JsonNode manifestRef = capture.path("manifest");
        if (manifestRef.isNull()) {
            require("unavailable".equals(text(capture, "captureStatus")),
                    "A capture without a manifest must be unavailable");
            return;
        }
        require(manifestRef.isObject(), "Missing capture manifest");
        JsonNode manifest = ToolPublicationContract.parseToolResult("manifest",
                referencedResource(key, publicationId, manifestRef,
                        "managed-tool-result-manifest", MAX_MANIFEST), MAX_MANIFEST);
        ObjectNode identity = JSON.createObjectNode().put("tenantId", text(key, "tenantId"))
                .put("sessionId", text(key, "sessionId"))
                .put("turnId", text(binding, "turnId"))
                .put("executionCallId", text(binding, "executionCallId"))
                .put("callId", text(binding.path("reference"), "callId"))
                .put("invocationDigest", text(binding.path("reference"), "argsDigest"))
                .put("bindingGeneration", text(binding, "bindingGeneration"))
                .put("captureId", text(binding, "captureId"))
                .put("revision", binding.path("revision").asInt());
        for (String field : List.of("tenantId", "sessionId", "turnId", "executionCallId", "callId",
                "invocationDigest", "bindingGeneration", "captureId", "revision")) {
            require(identity.path(field).equals(manifest.path(field)),
                    "Finished manifest identity conflicts");
        }
        require(text(result, "executionStatus").equals(text(manifest, "executionStatus"))
                && text(capture, "captureStatus").equals(text(manifest, "captureStatus"))
                && capture.path("captureReason").equals(manifest.path("captureReason"))
                && "process_pipes".equals(text(manifest, "captureScope"))
                && "complete_required".equals(text(manifest, "capturePolicy"))
                && !manifest.path("upstreamTruncated").asBoolean(true),
                "Finished capture conflicts with its manifest");
        String scope = scope(key);
        int streams = 0;
        boolean complete = true;
        boolean emptyIncomplete = true;
        for (JsonNode content : manifest.path("contents")) {
            String stream = text(content, "streamId");
            require(("stdout".equals(stream) || "stderr".equals(stream))
                    && stream.equals(text(content, "role")), "Finished Shell stream is invalid");
            streams++;
            require(streams <= 2, "Finished Shell has too many streams");
            long size = content.path("byteLength").asLong(-1);
            require(size >= 0, "Finished stream length is invalid");
            if (content.path("body").has("pages")) {
                readRangeInternal(key, publicationId, manifestRef, identity, stream, 0, 0, false, heartbeat);
                StreamScan verified = scan(scope, publicationId, stream, -1, heartbeat);
                require(verified.byteLength() == size
                        && verified.digest().equals(text(content, "digest")),
                        "Finished stream digest conflicts");
            } else {
                MessageDigest hash = sha256();
                if (size == 0) {
                    readRangeInternal(key, publicationId, manifestRef, identity, stream, 0, 0, false, heartbeat);
                }
                for (long offset = 0; offset < size; ) {
                    int count = (int) Math.min(MAX_SEGMENT, size - offset);
                    hash.update(readRangeInternal(key, publicationId, manifestRef,
                            identity, stream, offset, count, false, heartbeat));
                    offset += count;
                }
                require(HexFormat.of().formatHex(hash.digest()).equals(text(content, "digest")),
                        "Finished stream digest conflicts");
            }
            String state = text(content, "state");
            complete &= "sealed".equals(state);
            emptyIncomplete &= "incomplete".equals(state) && size == 0;
            if ("sealed".equals(state) && content.path("body").has("pages")) {
                List<Map<String, Object>> seals = jdbc.queryForList("SELECT segment_count, byte_length, sha256"
                        + " FROM qwen_tool_publication_seal WHERE scope_key = ? AND publication_id = ?"
                        + " AND stream_id = ?", scope, publicationId, stream);
                require(seals.size() == 1 && ((Number) seals.get(0).get("byte_length")).longValue() == size
                        && text(content, "digest").equals(seals.get(0).get("sha256")),
                        "Finished stream is not sealed");
                int counted = 0;
                for (JsonNode page : content.path("body").path("pages")) {
                    counted += page.path("segmentCount").asInt();
                }
                require(((Number) seals.get(0).get("segment_count")).intValue() == counted,
                        "Finished stream seal count conflicts");
            }
        }
        String implied = streams == 0 || emptyIncomplete ? "unavailable" : complete ? "complete" : "partial";
        require(implied.equals(text(manifest, "captureStatus"))
                && (!"complete".equals(implied) || streams == 2),
                "Finished capture status conflicts with its streams");
    }

    private ScanClaim claimScan(JsonNode key, String scope, String publicationId, String token,
            String operationId, String slot, String requestDigest) {
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid publication operation ID");
        var authorization = authorizeClaim(key, scope, publicationId, token);
        if (authorization.execution().getState()
                == ToolExecutionRecord.State.SETTLED) {
            return new ScanClaim(0, exactSucceededReplay(scope, publicationId, operationId, slot, requestDigest));
        }
        var phase = jdbc.queryForMap("SELECT producer_phase, finish_predecessor_id,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                scope, publicationId);
        require(((Number) phase.get("quarantined")).intValue() == 0,
                "Publication is quarantined");
        require("OPEN".equals(phase.get("producer_phase"))
                || "FINISHING".equals(phase.get("producer_phase"))
                && operationId.equals(phase.get("finish_predecessor_id")),
                "Publication is finishing");
        List<Operation> prior = operation(scope, publicationId, operationId, true);
        Timestamp now = now();
        if (!prior.isEmpty()) {
            Operation row = prior.get(0);
            require(slot.equals(row.slot()) && requestDigest.equals(row.digest()),
                    "Publication operation conflicts");
            if ("SUCCEEDED".equals(row.state())) {
                String saved = jdbc.queryForObject("SELECT receipt_json FROM qwen_tool_publication_operation"
                        + " WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                        String.class, scope, publicationId, operationId);
                return new ScanClaim(0, ToolPublicationContract.readJson(saved.getBytes(StandardCharsets.UTF_8)));
            }
            requireUnexpired(row.deadline(), now);
        }
        String active = availableActive(scope, publicationId, operationId, now);
        requireContract(active == null || active.equals(operationId), HttpStatus.CONFLICT,
                "managed_tool_publication_busy", "Publication is busy");
        if (active != null) {
            requireContract(!prior.isEmpty() && (prior.get(0).claimUntil() == null
                    || !prior.get(0).claimUntil().after(now)), HttpStatus.CONFLICT,
                    "managed_tool_publication_busy", "Publication operation is busy");
        }
        long epoch = prior.isEmpty() ? 1 : prior.get(0).epoch() + 1;
        Timestamp claimUntil = new Timestamp(now.getTime() + claimTimeout.toMillis());
        if (prior.isEmpty()) {
            jdbc.update("INSERT INTO qwen_tool_publication_operation (scope_key, publication_id, operation_id,"
                            + " request_digest, slot_key, state, claim_owner, claim_epoch, claim_until, deadline,"
                            + " created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)",
                    scope, publicationId, operationId, requestDigest, slot, UUID.randomUUID().toString(),
                    epoch, claimUntil,
                    new Timestamp(now.getTime() + verificationWindow(scope, publicationId, slot).toMillis()), now);
        } else {
            jdbc.update("UPDATE qwen_tool_publication_operation SET claim_owner = ?, claim_epoch = ?,"
                            + " claim_until = ? WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                    UUID.randomUUID().toString(), epoch, claimUntil, scope, publicationId, operationId);
        }
        jdbc.update("UPDATE qwen_tool_publication SET active_operation_id = ? WHERE scope_key = ?"
                + " AND publication_id = ?", operationId, scope, publicationId);
        return new ScanClaim(epoch, null);
    }

    private void checkScanClaim(String scope, String publicationId, String operationId, long epoch) {
        String active = jdbc.queryForObject("SELECT active_operation_id FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ?", String.class, scope, publicationId);
        List<Operation> rows = operation(scope, publicationId, operationId, true);
        requireOperationClaim(rows, epoch, now());
        requireContract(operationId.equals(active), HttpStatus.CONFLICT,
                "managed_tool_publication_claim_lost", "Publication operation lost its claim");
    }

    private String availableActive(String scope, String publicationId, String operationId, Timestamp current) {
        String active = jdbc.queryForObject("SELECT active_operation_id FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ?", String.class, scope, publicationId);
        if (active != null && !active.equals(operationId)) {
            List<Operation> previous = operation(scope, publicationId, active, true);
            require(previous.size() == 1, "Publication active operation is missing");
            if (!previous.get(0).deadline().after(current)) {
                jdbc.update("UPDATE qwen_tool_publication SET active_operation_id = NULL"
                        + " WHERE scope_key = ? AND publication_id = ?", scope, publicationId);
                active = null;
            }
        }
        return active;
    }

    private void finishScan(String scope, String publicationId, String operationId, JsonNode receipt) {
        jdbc.update("UPDATE qwen_tool_publication_operation SET state = 'SUCCEEDED', receipt_json = ?,"
                        + " claim_owner = NULL, claim_until = NULL WHERE scope_key = ?"
                        + " AND publication_id = ? AND operation_id = ?",
                receipt.toString(), scope, publicationId, operationId);
        jdbc.update("UPDATE qwen_tool_publication SET active_operation_id = NULL WHERE scope_key = ?"
                + " AND publication_id = ?", scope, publicationId);
    }

    private void abandonScan(String scope, String publicationId, String operationId, long epoch) {
        transactions.executeWithoutResult(status -> {
            retention.lockRetainedPublication(scope, publicationId);
            List<Operation> rows = operation(scope, publicationId, operationId, true);
            if (rows.size() == 1 && rows.get(0).epoch() == epoch) {
                jdbc.update("UPDATE qwen_tool_publication_operation SET claim_owner = NULL, claim_until = NULL"
                        + " WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                        scope, publicationId, operationId);
                jdbc.update("UPDATE qwen_tool_publication SET active_operation_id = NULL"
                        + " WHERE scope_key = ? AND publication_id = ? AND active_operation_id = ?",
                        scope, publicationId, operationId);
            }
        });
    }

    private StreamScan scan(String scope, String publicationId, String streamId,
            int expectedCount, Runnable heartbeat) {
        List<Stored> rows = jdbc.query("SELECT slot_key, resource_id, byte_length, sha256, object_key,"
                        + " state, operation_id FROM qwen_tool_publication_object WHERE scope_key = ?"
                        + " AND publication_id = ? AND slot_key LIKE ?",
                (r, n) -> new Stored(r.getString("slot_key"), r.getString("resource_id"),
                        r.getLong("byte_length"), r.getString("sha256"), r.getString("object_key"),
                        r.getString("state"), r.getString("operation_id")),
                scope, publicationId, "segment:" + streamId + ":%");
        Map<Integer, Stored> byOrdinal = new HashMap<>();
        for (Stored row : rows) {
            int ordinal = Integer.parseInt(row.slot().substring(("segment:" + streamId + ":").length()));
            byOrdinal.put(ordinal, row);
        }
        if (expectedCount >= 0) {
            requireContract(rows.size() == expectedCount,
                    HttpStatus.CONFLICT, "managed_tool_result_conflict", "Seal has missing or extra segments");
        }
        MessageDigest aggregate = sha256();
        int count = 0;
        long length = 0;
        while (count < 65536 && (expectedCount < 0 || count < expectedCount)) {
            heartbeat.run();
            Stored row = byOrdinal.get(count);
            if (row == null || !"VERIFIED".equals(row.state())) {
                break;
            }
            require(row.objectKey() != null, "Publication segment is missing its object");
            MessageDigest segment = sha256();
            long segmentLength = 0;
            try (InputStream stream = retention.open(scope, publicationId, row.objectKey(), objects)) {
                byte[] buffer = new byte[64 * 1024];
                for (int bytes; (bytes = stream.read(buffer)) != -1; ) {
                    heartbeat.run();
                    aggregate.update(buffer, 0, bytes);
                    segment.update(buffer, 0, bytes);
                    segmentLength += bytes;
                    if (segmentLength > row.length()) {
                        throw corruptPublication(scope, publicationId, row.slot(), "Publication segment length changed");
                    }
                }
            } catch (IOException error) {
                throw new IllegalStateException("Publication segment read failed", error);
            }
            if (segmentLength != row.length() || !HexFormat.of().formatHex(segment.digest()).equals(row.digest())) {
                throw corruptPublication(scope, publicationId, row.slot(), "Publication segment digest changed");
            }
            length += segmentLength;
            count++;
        }
        return new StreamScan(count, length, HexFormat.of().formatHex(aggregate.digest()));
    }

    private Runnable heartbeat(JsonNode key, String scope, String publicationId, String token,
            String operationId, long epoch) {
        long interval = Math.max(1, claimTimeout.toNanos() / 3);
        return new Runnable() {
            private long next = System.nanoTime() + interval;

            @Override
            public void run() {
                if (System.nanoTime() < next) {
                    return;
                }
                transactions.executeWithoutResult(status -> {
                    authorize(key, scope, publicationId, token);
                    List<Operation> rows = operation(scope, publicationId, operationId, true);
                    Timestamp current = now();
                    requireOperationClaim(rows, epoch, current);
                    long until = Math.min(rows.get(0).deadline().getTime(),
                            current.getTime() + claimTimeout.toMillis());
                    jdbc.update("UPDATE qwen_tool_publication_operation SET claim_until = ?"
                            + " WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                            new Timestamp(until), scope, publicationId, operationId);
                });
                next = System.nanoTime() + interval;
            }
        };
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private IllegalArgumentException corruptPublication(String scope, String publicationId, String slot, String message) {
        var error = new IllegalArgumentException(message);
        try {
            quarantine(scope, publicationId, slot);
        } catch (RuntimeException cleanup) {
            error.addSuppressed(cleanup);
        }
        return error;
    }

    private void quarantine(String scope, String publicationId, String slot) {
        transactions.executeWithoutResult(status -> {
            retention.lockRetainedPublication(scope, publicationId);
            jdbc.update("UPDATE qwen_tool_publication SET quarantined = TRUE"
                    + " WHERE scope_key = ? AND publication_id = ?", scope, publicationId);
            jdbc.update("UPDATE qwen_tool_publication_object SET state = 'QUARANTINED'"
                    + " WHERE scope_key = ? AND publication_id = ?"
                    + " AND slot_key = ? AND state = 'VERIFIED'", scope, publicationId, slot);
        });
    }

    private void quarantineCandidate(String scope, String publicationId,
            String slot, String operationId) {
        transactions.executeWithoutResult(status -> {
            retention.lockRetainedPublication(scope, publicationId);
            jdbc.update("UPDATE qwen_tool_publication_object"
                    + " SET state = 'QUARANTINED' WHERE scope_key = ? AND publication_id = ?"
                    + " AND slot_key = ? AND operation_id = ? AND state = 'CANDIDATE'",
                    scope, publicationId, slot, operationId);
        });
    }

    private JsonNode publish(JsonNode key, String publicationId, String token, String operationId,
            String slot, String kind, byte[] input, String expectedDigest, int maximum) {
        requireStagedCall(key, publicationId);
        require(input != null && input.length > 0 && input.length <= maximum, "Invalid publication size");
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid publication operation ID");
        byte[] bytes = input.clone();
        String digest = ToolPublicationContract.sha256(bytes);
        requireContract(expectedDigest == null || expectedDigest.equals(digest),
                HttpStatus.BAD_REQUEST, "managed_tool_result_digest_mismatch", "Publication digest mismatch");
        String scope = scope(key);
        Candidate candidate = transactions.execute(status -> claim(key, scope, publicationId, token,
                operationId, slot, kind, bytes.length, digest));
        require(candidate != null, "Publication operation unavailable");
        if (candidate.receipt() != null) {
            if (candidate.objectKey() != null) {
                try {
                    verify(scope, publicationId, candidate.objectKey(), bytes.length, digest);
                } catch (IllegalArgumentException error) {
                    try {
                        quarantine(scope, publicationId, slot);
                    } catch (RuntimeException cleanup) {
                        error.addSuppressed(cleanup);
                    }
                    throw error;
                }
            } else if (kind != null) {
                readResource(key, publicationId, candidate.resourceId());
            }
            return candidate.receipt();
        }
        try {
            if (candidate.objectKey() != null) {
                retention.put(key, scope, publicationId, candidate.objectKey(), bytes, objects);
                try {
                    verify(scope, publicationId, candidate.objectKey(), bytes.length, digest);
                } catch (IllegalArgumentException error) {
                    quarantineCandidate(scope, publicationId, slot, operationId);
                    throw error;
                }
            }
            return transactions.execute(status -> install(key, scope, publicationId, token,
                    operationId, candidate, kind, bytes, digest));
        } catch (RuntimeException error) {
            try {
                abandonScan(scope, publicationId, operationId, candidate.epoch());
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
    }

    private Candidate claim(JsonNode key, String scope, String publicationId, String token,
            String operationId, String slot, String kind, int length, String digest) {
        var authorization = authorizeClaim(key, scope, publicationId, token);
        JsonNode binding = authorization.binding();
        if (authorization.execution().getState()
                == ToolExecutionRecord.State.SETTLED) {
            JsonNode replay = exactSucceededReplay(scope, publicationId, operationId,
                    slot, requestDigest(slot, length, digest));
            Stored saved = stored(scope, publicationId, slot).get(0);
            require(replay.equals(receipt(binding, slot, saved.resourceId(), kind, length, digest)),
                    "Original publication receipt conflicts");
            return new Candidate(saved.objectKey(), saved.resourceId(), 0, replay);
        }
        var phase = jdbc.queryForMap("SELECT producer_phase, finish_predecessor_id,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                scope, publicationId);
        require(((Number) phase.get("quarantined")).intValue() == 0,
                "Publication is quarantined");
        require("OPEN".equals(phase.get("producer_phase"))
                || "FINISHING".equals(phase.get("producer_phase"))
                && operationId.equals(phase.get("finish_predecessor_id")),
                "Publication is finishing");
        String requestDigest = requestDigest(slot, length, digest);
        List<Operation> prior = operation(scope, publicationId, operationId, true);
        if (!prior.isEmpty()) {
            require(requestDigest.equals(prior.get(0).digest()) && slot.equals(prior.get(0).slot()),
                    "Publication operation conflicts");
        }
        List<Stored> saved = stored(scope, publicationId, slot);
        if (slot.startsWith("segment:")) {
            String streamId = slot.split(":")[1];
            Long sealed = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_seal"
                    + " WHERE scope_key = ? AND publication_id = ? AND stream_id = ?",
                    Long.class, scope, publicationId, streamId);
            requireContract(sealed == 0 || !saved.isEmpty(),
                    HttpStatus.CONFLICT, "managed_tool_result_conflict", "Publication stream is sealed");
        }
        if (!saved.isEmpty()) {
            Stored row = saved.get(0);
            requireContract(row.length() == length && digest.equals(row.digest()),
                    HttpStatus.CONFLICT, "managed_tool_result_conflict", "Publication slot conflicts");
            if ("VERIFIED".equals(row.state())) {
                return new Candidate(row.objectKey(), row.resourceId(), 0,
                        receipt(binding, slot, row.resourceId(), kind, length, digest));
            }
            require(!"QUARANTINED".equals(row.state()), "Publication candidate is quarantined");
            require(operationId.equals(row.operationId()), "Publication candidate belongs to another operation");
        }
        Timestamp now = now();
        if (!prior.isEmpty()) {
            Operation row = prior.get(0);
            requireUnexpired(row.deadline(), now);
        }
        String active = availableActive(scope, publicationId, operationId, now);
        requireContract(active == null || active.equals(operationId), HttpStatus.CONFLICT,
                "managed_tool_publication_busy", "Publication is busy");
        String resourceId = kind == null ? null : "result-" + hash(scope + ":" + publicationId + ":" + slot).substring(0, 32);
        String objectKey = (kind != null && length <= 64 * 1024) ? null
                : "managed-tool-results/" + scope + "/" + publicationId + "/" + hash(slot);
        if (saved.isEmpty()) {
            String category = category(slot);
            long allocated = jdbc.queryForObject("SELECT " + category + "_bytes FROM qwen_tool_publication"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, publicationId);
            long used = jdbc.queryForObject("SELECT " + category + "_used_bytes FROM qwen_tool_publication"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, publicationId);
            requireCapacity(length, allocated - used);
            jdbc.update("INSERT INTO qwen_tool_publication_object (scope_key, publication_id, slot_key,"
                            + " resource_id, resource_kind, byte_length, sha256, object_key, state,"
                            + " operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', ?, ?)",
                    scope, publicationId, slot, resourceId, kind, length, digest, objectKey, operationId, now);
            jdbc.update("UPDATE qwen_tool_publication SET " + category + "_used_bytes = ?"
                    + " WHERE scope_key = ? AND publication_id = ?", used + length, scope, publicationId);
        }
        String owner = UUID.randomUUID().toString();
        long epoch = prior.isEmpty() ? 1 : prior.get(0).epoch() + 1;
        Timestamp claimUntil = new Timestamp(now.getTime() + claimTimeout.toMillis());
        if (prior.isEmpty()) {
            jdbc.update("INSERT INTO qwen_tool_publication_operation (scope_key, publication_id,"
                            + " operation_id, request_digest, slot_key, state, claim_owner, claim_epoch,"
                            + " claim_until, deadline, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)",
                    scope, publicationId, operationId, requestDigest, slot, owner, epoch,
                    claimUntil, new Timestamp(now.getTime() + operationTimeout.toMillis()), now);
        } else {
            requireContract(prior.get(0).claimUntil() == null || !prior.get(0).claimUntil().after(now),
                    HttpStatus.CONFLICT, "managed_tool_publication_busy", "Publication operation is busy");
            jdbc.update("UPDATE qwen_tool_publication_operation SET claim_owner = ?, claim_epoch = ?,"
                            + " claim_until = ? WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                    owner, epoch, claimUntil, scope, publicationId, operationId);
        }
        jdbc.update("UPDATE qwen_tool_publication SET active_operation_id = ?"
                + " WHERE scope_key = ? AND publication_id = ?", operationId, scope, publicationId);
        return new Candidate(objectKey, resourceId, epoch, null);
    }

    private JsonNode install(JsonNode key, String scope, String publicationId, String token,
            String operationId, Candidate candidate, String kind, byte[] bytes, String digest) {
        JsonNode binding = authorize(key, scope, publicationId, token);
        String active = jdbc.queryForObject("SELECT active_operation_id FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ?", String.class, scope, publicationId);
        List<Operation> rows = operation(scope, publicationId, operationId, true);
        requireOperationClaim(rows, candidate.epoch(), now());
        requireContract(operationId.equals(active), HttpStatus.CONFLICT,
                "managed_tool_publication_claim_lost", "Publication operation lost its claim");
        Stored row = stored(scope, publicationId, rows.get(0).slot(), true).get(0);
        require("CANDIDATE".equals(row.state()) && digest.equals(row.digest())
                && row.length() == bytes.length, "Publication candidate changed");
        if (candidate.objectKey() == null) {
            jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ?"
                    + " WHERE scope_key = ? AND publication_id = ? AND slot_key = ?",
                    bytes, scope, publicationId, row.slot());
        }
        JsonNode receipt = receipt(binding, row.slot(), candidate.resourceId(), kind, bytes.length, digest);
        jdbc.update("UPDATE qwen_tool_publication_object SET state = 'VERIFIED'"
                + " WHERE scope_key = ? AND publication_id = ? AND slot_key = ?",
                scope, publicationId, row.slot());
        jdbc.update("UPDATE qwen_tool_publication_operation SET state = 'SUCCEEDED', receipt_json = ?,"
                        + " claim_owner = NULL, claim_until = NULL WHERE scope_key = ?"
                        + " AND publication_id = ? AND operation_id = ?",
                receipt.toString(), scope, publicationId, operationId);
        jdbc.update("UPDATE qwen_tool_publication SET active_operation_id = NULL"
                + " WHERE scope_key = ? AND publication_id = ?", scope, publicationId);
        return receipt;
    }

    private static String category(String slot) {
        return slot.startsWith("segment:") ? "capture" : "producer";
    }

    private JsonNode receipt(JsonNode binding, String slot, String resourceId, String kind,
            int length, String digest) {
        ObjectNode result = JSON.createObjectNode();
        if (kind != null) {
            return result.put("resourceId", resourceId).put("kind", kind)
                    .put("schemaVersion", 1).put("byteLength", length).put("digest", digest);
        }
        String[] parts = slot.split(":");
        return result.put("captureId", text(binding, "captureId")).put("streamId", parts[1])
                .put("ordinal", Integer.parseInt(parts[2])).put("byteLength", length).put("digest", digest);
    }

    private JsonNode authorize(JsonNode key, String scope, String publicationId, String token) {
        JsonNode binding = grants.producerMutationBindingLocked(scope, publicationId, token);
        require(binding.path("sessionKey").equals(key), "Publication scope conflicts");
        return binding;
    }

    private ToolPublicationStore.ProducerBinding authorizeClaim(JsonNode key, String scope,
            String publicationId, String token) {
        var authorization = grants.producerClaimBindingLocked(scope, publicationId, token);
        require(authorization.binding().path("sessionKey").equals(key), "Publication scope conflicts");
        return authorization;
    }

    void requireStagedCall(JsonNode key, String publicationId) {
        grants.requireStagedCall(key, publicationId);
    }

    void lockOriginalSettledResult(JsonNode key, String publicationId, JsonNode finished) {
        grants.lockOriginalSettledResult(key, publicationId, finished);
    }

    private JsonNode exactSucceededReplay(String scope, String publicationId, String operationId,
            String slot, String requestDigest) {
        var publication = jdbc.queryForMap("SELECT producer_phase, finish_operation_id,"
                + " terminal_resource_id, CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                scope, publicationId);
        require(("FINISHED".equals(publication.get("producer_phase"))
                || "REFERENCED".equals(publication.get("producer_phase")))
                && ((Number) publication.get("quarantined")).intValue() == 0,
                "Original publication is not finished");
        List<Operation> prior = operation(scope, publicationId, operationId, true);
        require(prior.size() == 1 && "SUCCEEDED".equals(prior.get(0).state())
                && slot.equals(prior.get(0).slot()) && requestDigest.equals(prior.get(0).digest()),
                "Original succeeded operation conflicts");
        if (!slot.startsWith("prefix:") && !slot.startsWith("seal:")) {
            List<Stored> saved = stored(scope, publicationId, slot);
            require(saved.size() == 1 && "VERIFIED".equals(saved.get(0).state())
                    && operationId.equals(saved.get(0).operationId())
                    && requestDigest.equals(requestDigest(slot, saved.get(0).length(), saved.get(0).digest())),
                    "Original verified object conflicts");
            if ("terminal".equals(slot)) {
                require(operationId.equals(publication.get("finish_operation_id"))
                        && saved.get(0).resourceId().equals(publication.get("terminal_resource_id")),
                        "Original terminal conflicts");
            }
        } else if (slot.startsWith("seal:")) {
            var seals = jdbc.queryForList("SELECT operation_id FROM qwen_tool_publication_seal"
                    + " WHERE scope_key = ? AND publication_id = ? AND stream_id = ?",
                    scope, publicationId, slot.substring(5));
            require(seals.size() == 1 && operationId.equals(seals.get(0).get("operation_id")),
                    "Original seal conflicts");
        }
        String saved = jdbc.queryForObject("SELECT receipt_json FROM qwen_tool_publication_operation"
                + " WHERE scope_key = ? AND publication_id = ? AND operation_id = ?",
                String.class, scope, publicationId, operationId);
        require(saved != null, "Original receipt is missing");
        return ToolPublicationContract.readJson(saved.getBytes(StandardCharsets.UTF_8));
    }

    private void lockTenant(JsonNode key) {
        String tenant = text(key, "tenantId");
        String tenantKey = hash(tenant);
        jdbc.update("INSERT INTO qwen_tool_publication_tenant (tenant_key, tenant_id) VALUES (?, ?)"
                + " ON DUPLICATE KEY UPDATE tenant_key = tenant_key", tenantKey, tenant);
        String storedTenant = jdbc.queryForObject("SELECT tenant_id FROM qwen_tool_publication_tenant"
                + " WHERE tenant_key = ? FOR UPDATE", String.class, tenantKey);
        require(tenant.equals(storedTenant), "Publication tenant conflicts");
    }

    private List<Stored> stored(String scope, String publicationId, String slot) {
        return stored(scope, publicationId, slot, false);
    }

    private List<Stored> stored(String scope, String publicationId, String slot, boolean locked) {
        return jdbc.query("SELECT slot_key, resource_id, byte_length, sha256, object_key, state,"
                        + " operation_id FROM qwen_tool_publication_object WHERE scope_key = ?"
                        + " AND publication_id = ? AND slot_key = ?" + (locked ? " FOR UPDATE" : ""),
                (r, n) -> new Stored(r.getString("slot_key"), r.getString("resource_id"),
                        r.getLong("byte_length"), r.getString("sha256"), r.getString("object_key"),
                        r.getString("state"), r.getString("operation_id")), scope, publicationId, slot);
    }

    private List<Operation> operation(String scope, String publicationId, String operationId, boolean locked) {
        return jdbc.query("SELECT request_digest, slot_key, state, claim_epoch, claim_until,"
                        + " COALESCE(recovery_deadline, deadline) AS deadline"
                        + " FROM qwen_tool_publication_operation WHERE scope_key = ? AND publication_id = ?"
                        + " AND operation_id = ?" + (locked ? " FOR UPDATE" : ""),
                (r, n) -> new Operation(r.getString("request_digest"), r.getString("slot_key"),
                        r.getString("state"), r.getLong("claim_epoch"), r.getTimestamp("claim_until"),
                        r.getTimestamp("deadline")), scope, publicationId, operationId);
    }

    private void verify(String scope, String publicationId, String objectKey, long length, String digest) {
        objects.requireUnversioned();
        try (InputStream stream = retention.open(scope, publicationId, objectKey, objects)) {
            var hash = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            long read = 0;
            for (int count; (count = stream.read(buffer)) != -1; ) {
                hash.update(buffer, 0, count);
                read += count;
                require(read <= length, "Publication object length changed");
            }
            require(read == length && HexFormat.of().formatHex(hash.digest()).equals(digest),
                    "Publication object digest changed");
        } catch (IOException | java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException("Publication object verification failed", error);
        }
    }

    public ToolPublicationRetentionStore.ReadLease readLease(JsonNode key) { return retention.read(key); }

    public byte[] readResource(JsonNode key, String publicationId, String resourceId) {
        try (var lease = retention.read(key)) {
            return readResource(key, publicationId, resourceId, lease, () -> {});
        }
    }

    byte[] readResource(JsonNode key, String publicationId, String resourceId,
            ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        guard.run();
        byte[] bytes = readResourceInternal(key, publicationId, resourceId, lease, guard);
        lease.check();
        guard.run();
        return bytes;
    }

    private byte[] readResourceInternal(JsonNode key, String publicationId, String resourceId,
            ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        lease.requireScope(key);
        lease.check();
        String scope = scope(key);
        var rows = jdbc.query("SELECT o.slot_key, o.resource_kind, o.byte_length, o.sha256, o.object_key,"
                        + " o.inline_bytes, o.state FROM qwen_tool_publication_object o"
                        + " JOIN qwen_tool_publication p ON p.scope_key = o.scope_key"
                        + " AND p.publication_id = o.publication_id WHERE o.scope_key = ?"
                        + " AND o.publication_id = ? AND o.resource_id = ? AND p.tenant_id = ?"
                        + " AND p.workspace_id = ? AND p.session_id = ?",
                (r, n) -> new Resource(r.getString("slot_key"), r.getString("resource_kind"), r.getLong("byte_length"),
                        r.getString("sha256"), r.getString("object_key"), r.getBytes("inline_bytes"),
                        r.getString("state")), scope, publicationId, resourceId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require(rows.size() == 1 && "VERIFIED".equals(rows.get(0).state()),
                "Publication resource is unavailable");
        Resource row = rows.get(0);
        require(row.length() <= 2 * 1024 * 1024, "Publication metadata is too large");
        byte[] bytes;
        if (row.objectKey() == null) {
            bytes = row.inlineBytes();
        } else {
            try (InputStream stream = retention.open(row.objectKey(), objects, lease, guard)) {
                bytes = stream.readNBytes((int) row.length() + 1);
            } catch (IOException error) {
                throw new IllegalStateException("Publication resource read failed", error);
            }
        }
        if (bytes == null || bytes.length != row.length()
                || !ToolPublicationContract.sha256(bytes).equals(row.digest())) {
            throw corruptPublication(scope, publicationId, row.slot(), "Publication resource digest changed");
        }
        return bytes;
    }

    public byte[] readRange(JsonNode key, String publicationId, String writerToken,
            JsonNode manifestRef, JsonNode expectedIdentity, String streamId, long offset, int length) {
        sessions.restore(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), writerToken);
        try (var lease = retention.read(key)) {
            return readRangeInternal(key, publicationId, manifestRef, expectedIdentity,
                    streamId, offset, length, true, lease, () -> {});
        }
    }

    private byte[] readRangeInternal(JsonNode key, String publicationId,
            JsonNode manifestRef, JsonNode expectedIdentity, String streamId,
            long offset, int length, boolean requireFinished, Runnable heartbeat) {
        try (var lease = retention.read(key)) {
            return readRangeInternal(key, publicationId, manifestRef, expectedIdentity,
                    streamId, offset, length, requireFinished, lease, heartbeat);
        }
    }

    private byte[] readRangeInternal(JsonNode key, String publicationId,
            JsonNode manifestRef, JsonNode expectedIdentity, String streamId,
            long offset, int length, boolean requireFinished,
            ToolPublicationRetentionStore.ReadLease lease, Runnable heartbeat) {
        require(offset >= 0 && length >= 0 && length <= MAX_SEGMENT, "Invalid publication range");
        lease.requireScope(key);
        Runnable guard = () -> {
            lease.check();
            heartbeat.run();
        };
        return verifiedStream(key, publicationId, manifestRef, expectedIdentity,
                streamId, requireFinished, lease, guard).readRange(offset, length, guard);
    }

    VerifiedStream openReferencedStream(JsonNode key, String publicationId,
            JsonNode outcomeRef, JsonNode manifestRef, JsonNode expectedIdentity,
            String streamId, long revision, long sequence, ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        lease.requireScope(key);
        guard.run();
        requireReferenced(key, publicationId, outcomeRef, revision, sequence);
        JsonNode outcome = ToolPublicationContract.readJson(referencedResource(key,
                publicationId, outcomeRef, "managed-tool-outcome", MAX_TERMINAL, lease, guard));
        require("committed".equals(text(outcome, "decision"))
                && manifestRef.equals(outcome.path("manifestRef")),
                "Publication did not commit this representation");
        guard.run();
        return verifiedStream(key, publicationId, manifestRef, expectedIdentity, streamId, true, lease, guard);
    }

    void requireReferenced(JsonNode key, String publicationId, JsonNode outcomeRef,
            long revision, long sequence) {
        require(referenced(referencedPublications(key, List.of(publicationId)).get(publicationId),
                outcomeRef, revision, sequence), "Publication receipt is unavailable");
    }

    Map<String, Map<String, Object>> referencedPublications(JsonNode key, List<String> ids) {
        Map<String, Map<String, Object>> result = new java.util.HashMap<>();
        if (ids.isEmpty()) {
            return result;
        }
        List<Object> arguments = new ArrayList<>();
        arguments.add(scope(key));
        arguments.add(text(key, "tenantId"));
        arguments.add(text(key, "workspaceId"));
        arguments.add(text(key, "sessionId"));
        arguments.add(ToolPublicationRetentionStore.hash(text(key, "tenantId")));
        arguments.add(ToolPublicationRetentionStore.hash(text(key, "sessionId")));
        arguments.addAll(ids);
        var rows = jdbc.queryForList("SELECT publication_id, producer_phase, admission_resource_id,"
                + " receipt_revision, receipt_sequence, CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                + " FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND tenant_id = ? AND workspace_id = ? AND session_id = ?"
                + " AND NOT EXISTS (SELECT 1 FROM qwen_output_session_retirement r"
                + " WHERE r.tenant_key = ? AND r.session_key = ?) AND publication_id IN ("
                + String.join(",", java.util.Collections.nCopies(ids.size(), "?")) + ")", arguments.toArray());
        for (var row : rows) {
            result.put((String) row.get("publication_id"), row);
        }
        return result;
    }

    static boolean referenced(Map<String, Object> row, JsonNode outcomeRef, long revision, long sequence) {
        return row != null && "REFERENCED".equals(row.get("producer_phase"))
                && row.get("quarantined") instanceof Number mark && mark.intValue() == 0
                && outcomeRef != null && outcomeRef.path("resourceId").isTextual()
                && outcomeRef.path("resourceId").asText().equals(row.get("admission_resource_id"))
                && row.get("receipt_revision") instanceof Number r && r.longValue() == revision
                && row.get("receipt_sequence") instanceof Number q && q.longValue() == sequence;
    }

    private VerifiedStream verifiedStream(JsonNode key, String publicationId,
            JsonNode manifestRef, JsonNode expectedIdentity, String streamId, boolean requireFinished, ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        guard.run();
        String scope = scope(key);
        var publication = jdbc.queryForMap("SELECT binding_json, producer_phase,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ? AND tenant_id = ?"
                + " AND workspace_id = ? AND session_id = ?", scope, publicationId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require(!requireFinished || "FINISHED".equals(publication.get("producer_phase"))
                || "REFERENCED".equals(publication.get("producer_phase")),
                "Publication is not finished");
        require(((Number) publication.get("quarantined")).intValue() == 0,
                "Publication is quarantined");
        JsonNode binding = ToolPublicationContract.readJson(
                ((String) publication.get("binding_json")).getBytes(StandardCharsets.UTF_8));
        guard.run();
        JsonNode manifest = ToolPublicationContract.parseToolResult("manifest", referencedResource(key, publicationId,
                manifestRef, "managed-tool-result-manifest", MAX_MANIFEST, lease, guard), MAX_MANIFEST);
        guard.run();
        require("managed-tool-result/1".equals(text(manifest, "toolResult"))
                && "manifest".equals(text(manifest, "type"))
                && text(key, "tenantId").equals(text(manifest, "tenantId"))
                && text(key, "sessionId").equals(text(manifest, "sessionId")),
                "Publication manifest scope conflicts");
        for (String field : List.of("tenantId", "sessionId", "turnId", "executionCallId", "callId",
                "invocationDigest", "bindingGeneration", "captureId", "revision")) {
            require(expectedIdentity != null && manifest.path(field).equals(expectedIdentity.path(field)),
                    "Publication manifest identity conflicts");
        }
        require(text(binding, "turnId").equals(text(manifest, "turnId"))
                && text(binding, "executionCallId").equals(text(manifest, "executionCallId"))
                && text(binding.path("reference"), "callId").equals(text(manifest, "callId"))
                && text(binding.path("reference"), "argsDigest").equals(text(manifest, "invocationDigest"))
                && text(binding, "bindingGeneration").equals(text(manifest, "bindingGeneration"))
                && text(binding, "captureId").equals(text(manifest, "captureId"))
                && binding.path("revision").equals(manifest.path("revision")),
                "Publication binding identity conflicts");
        JsonNode selected = null;
        for (JsonNode content : manifest.path("contents")) {
            if (streamId.equals(text(content, "streamId"))) {
                require(selected == null, "Publication manifest repeats a stream");
                selected = content;
            }
        }
        require(selected != null && selected.path("byteLength").canConvertToLong(),
                "Publication stream is missing");
        long size = selected.path("byteLength").longValue();
        require(size >= 0, "Publication stream length is invalid");
        var parts = new ArrayList<StreamPart>();
        JsonNode body = selected.path("body");
        if (body.has("ref")) {
            JsonNode ref = body.path("ref");
            Resource content = catalogResource(key, publicationId, text(ref, "resourceId"));
            require(refMatches(content, ref, "managed-tool-result-content")
                    && content.length() == size && size <= MAX_SEGMENT,
                    "Publication content reference conflicts");
            parts.add(new StreamPart(0, content));
            return new VerifiedStream(scope, publicationId, size, parts, lease);
        }
        require(body.path("pages").isArray(), "Publication stream has no pages");
        long expectedOffset = 0;
        int expectedOrdinal = 0;
        for (JsonNode pageReference : body.path("pages")) {
            guard.run();
            JsonNode page = ToolPublicationContract.parseToolResult("page", referencedResource(key, publicationId,
                    pageReference.path("ref"), "managed-tool-result-page", MAX_PAGE, lease, guard), MAX_PAGE);
            require("managed-tool-result/1".equals(text(page, "toolResult"))
                    && "page".equals(text(page, "type"))
                    && text(manifest, "captureId").equals(text(page, "captureId"))
                    && streamId.equals(text(page, "streamId"))
                    && page.path("offset").asLong(-1) == expectedOffset
                    && page.path("firstOrdinal").asInt(-1) == expectedOrdinal
                    && page.path("segments").isArray(), "Publication page position conflicts");
            int segmentCount = 0;
            long pageLength = 0;
            for (JsonNode segment : page.path("segments")) {
                guard.run();
                long segmentLength = segment.path("byteLength").asLong(-1);
                require(segmentLength > 0 && segmentLength <= MAX_SEGMENT && expectedOrdinal < 65536,
                        "Publication page segment is invalid");
                List<Stored> rows = stored(scope, publicationId, "segment:" + streamId + ":" + expectedOrdinal);
                require(rows.size() == 1 && "VERIFIED".equals(rows.get(0).state())
                        && rows.get(0).length() == segmentLength
                        && rows.get(0).digest().equals(text(segment, "digest")),
                        "Publication page segment conflicts");
                long position = expectedOffset + pageLength;
                parts.add(new StreamPart(position, new Resource(rows.get(0).slot(), null,
                        segmentLength, rows.get(0).digest(), rows.get(0).objectKey(), null,
                        rows.get(0).state())));
                pageLength += segmentLength;
                segmentCount++;
                expectedOrdinal++;
            }
            require(segmentCount == pageReference.path("segmentCount").asInt(-1)
                    && pageLength == pageReference.path("byteLength").asLong(-1),
                    "Publication page reference conflicts");
            expectedOffset += pageLength;
        }
        guard.run();
        require(expectedOffset == size, "Publication stream page length conflicts");
        return new VerifiedStream(scope, publicationId, size, parts, lease);
    }

    private record StreamPart(long offset, Resource resource) {}

    final class VerifiedStream {
        private final String scope;
        private final String publicationId;
        private final long size;
        private final List<StreamPart> parts;
        private final ToolPublicationRetentionStore.ReadLease lease;

        private VerifiedStream(String scope, String publicationId, long size,
                List<StreamPart> parts, ToolPublicationRetentionStore.ReadLease lease) {
            this.scope = scope;
            this.publicationId = publicationId;
            this.size = size;
            this.parts = List.copyOf(parts);
            this.lease = lease;
        }

        long size() { return size; }

        long rangeVerificationBytes(long offset, int length) {
            return parts.stream().filter(part -> part.offset() < offset + length
                            && part.offset() + part.resource().length() > offset)
                    .mapToLong(part -> part.resource().length()).sum();
        }

        InputStream open(Runnable guard) {
            return new InputStream() {
                private int partIndex;
                private byte[] verified;
                private int position;
                private boolean closed;

                @Override
                public int read() throws IOException {
                    byte[] one = new byte[1];
                    return read(one, 0, 1) < 0 ? -1 : one[0] & 255;
                }

                @Override
                public int read(byte[] target, int offset, int length) throws IOException {
                    Objects.checkFromIndexSize(offset, length, target.length);
                    if (closed) {
                        throw new IOException("Artifact stream is closed");
                    }
                    if (length == 0) {
                        return 0;
                    }
                    guard.run();
                    while (verified == null || position == verified.length) {
                        if (partIndex == parts.size()) {
                            return -1;
                        }
                        var part = parts.get(partIndex);
                        byte[] candidate = new byte[Math.toIntExact(part.resource().length())];
                        copyVerified(part.resource(), scope, publicationId, 0,
                                candidate, 0, candidate.length, lease, guard);
                        verified = candidate;
                        position = 0;
                        partIndex++;
                    }
                    int count = Math.min(Math.min(length, 64 * 1024), verified.length - position);
                    guard.run();
                    System.arraycopy(verified, position, target, offset, count);
                    position += count;
                    return count;
                }

                @Override
                public void close() {
                    closed = true;
                    verified = null;
                }
            };
        }

        byte[] readRange(long offset, int length, Runnable guard) {
            require(offset >= 0 && length >= 0 && length <= MAX_SEGMENT
                    && offset <= size && length <= size - offset, "Invalid publication range");
            byte[] result = new byte[length];
            for (var part : parts) {
                long start = Math.max(offset, part.offset());
                long end = Math.min(offset + length, part.offset() + part.resource().length());
                if (end > start) {
                    copyVerified(part.resource(), scope, publicationId, start - part.offset(),
                            result, Math.toIntExact(start - offset), Math.toIntExact(end - start), lease, guard);
                }
            }
            guard.run();
            return result;
        }
    }

    private byte[] referencedResource(JsonNode key, String publicationId, JsonNode ref,
            String kind, int maximum) {
        try (var lease = retention.read(key)) {
            return referencedResource(key, publicationId, ref, kind, maximum, lease, lease::check);
        }
    }

    private byte[] referencedResource(JsonNode key, String publicationId, JsonNode ref,
            String kind, int maximum, ToolPublicationRetentionStore.ReadLease lease, Runnable guard) {
        guard.run();
        Resource resource = catalogResource(key, publicationId, text(ref, "resourceId"));
        require(refMatches(resource, ref, kind) && resource.length() <= maximum,
                "Publication resource reference conflicts");
        byte[] bytes = readResourceInternal(key, publicationId, text(ref, "resourceId"), lease, guard);
        lease.check();
        guard.run();
        return bytes;
    }

    private boolean refMatches(Resource resource, JsonNode ref, String kind) {
        return kind.equals(resource.kind()) && ref.path("schemaVersion").asInt(-1) == 1
                && ref.path("byteLength").asLong(-1) == resource.length()
                && resource.digest().equals(text(ref, "digest"));
    }

    private Resource catalogResource(JsonNode key, String publicationId, String resourceId) {
        String scope = scope(key);
        var rows = jdbc.query("SELECT o.slot_key, o.resource_kind, o.byte_length, o.sha256, o.object_key,"
                        + " o.inline_bytes, o.state FROM qwen_tool_publication_object o"
                        + " JOIN qwen_tool_publication p ON p.scope_key = o.scope_key"
                        + " AND p.publication_id = o.publication_id WHERE o.scope_key = ?"
                        + " AND o.publication_id = ? AND o.resource_id = ? AND p.tenant_id = ?"
                        + " AND p.workspace_id = ? AND p.session_id = ?",
                (r, n) -> new Resource(r.getString("slot_key"), r.getString("resource_kind"),
                        r.getLong("byte_length"), r.getString("sha256"), r.getString("object_key"),
                        r.getBytes("inline_bytes"), r.getString("state")), scope, publicationId, resourceId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require(rows.size() == 1 && "VERIFIED".equals(rows.get(0).state()),
                "Publication resource is unavailable");
        return rows.get(0);
    }

    private void copyVerified(Resource resource, String scope, String publicationId,
            long offset, byte[] target, int targetOffset, int length,
            ToolPublicationRetentionStore.ReadLease lease, Runnable heartbeat) {
        require(offset >= 0 && length >= 0 && offset <= resource.length()
                && length <= resource.length() - offset, "Publication copy range is invalid");
        MessageDigest hash = sha256();
        lease.check();
        try (InputStream input = resource.objectKey() == null
                ? new java.io.ByteArrayInputStream(resource.inlineBytes()) : objects.open(resource.objectKey(), () -> {
                    lease.check();
                    heartbeat.run();
                })) {
            byte[] buffer = new byte[1024 * 1024];
            long position = 0;
            for (;;) {
                lease.check();
                int count = input.readNBytes(buffer, 0, buffer.length);
                if (count == 0) {
                    break;
                }
                lease.check();
                heartbeat.run();
                hash.update(buffer, 0, count);
                long start = Math.max(position, offset);
                long end = Math.min(position + count, offset + length);
                if (end > start) {
                    System.arraycopy(buffer, Math.toIntExact(start - position), target,
                            targetOffset + Math.toIntExact(start - offset), Math.toIntExact(end - start));
                }
                position += count;
                if (position > resource.length()) {
                    throw corruptPublication(scope, publicationId, resource.slot(), "Publication object length changed");
                }
            }
            lease.check();
            if (position != resource.length()
                    || !HexFormat.of().formatHex(hash.digest()).equals(resource.digest())) {
                throw corruptPublication(scope, publicationId, resource.slot(), "Publication object digest changed");
            }
        } catch (IOException error) {
            throw new IllegalStateException("Publication object read failed", error);
        }
    }

    static String scope(JsonNode key) {
        require(key != null && key.isObject(), "Invalid publication scope");
        return scope(text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
    }

    static String scope(String tenant, String workspace, String session) {
        return hash(JSON.createArrayNode().add(tenant).add(workspace).add(session).toString());
    }

    private static String requestDigest(String slot, long length, String digest) {
        return hash(JSON.createArrayNode().add(slot).add(length).add(digest).toString());
    }

    private static String hash(String value) {
        return ToolPublicationContract.sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void requireCapacity(long requested, long available) {
        if (requested > available) {
            throw new ApiException(HttpStatus.INSUFFICIENT_STORAGE,
                    "managed_tool_publication_quota_exhausted",
                    "Tool publication capacity is exhausted");
        }
    }

    private static void requireUnexpired(Timestamp deadline, Timestamp current) {
        requireContract(deadline.after(current), HttpStatus.CONFLICT,
                "managed_tool_publication_operation_expired", "Publication operation expired");
    }

    private static void requireOperationClaim(List<Operation> rows, long epoch, Timestamp current) {
        requireContract(rows.size() == 1 && "PENDING".equals(rows.get(0).state())
                && rows.get(0).epoch() == epoch, HttpStatus.CONFLICT,
                "managed_tool_publication_claim_lost", "Publication operation lost its claim");
        Operation row = rows.get(0);
        requireUnexpired(row.deadline(), current);
        requireContract(row.claimUntil() != null && row.claimUntil().after(current), HttpStatus.CONFLICT,
                "managed_tool_publication_claim_expired", "Publication operation claim expired");
    }

    private Duration verificationWindow(String scope, String publicationId, String slot) {
        if (!"terminal".equals(slot) && !slot.startsWith("seal:") && !slot.startsWith("prefix:")) {
            return operationTimeout;
        }
        Long bytes;
        if ("terminal".equals(slot)) {
            bytes = jdbc.queryForObject("SELECT COALESCE(SUM(byte_length), 0) FROM qwen_tool_publication_object"
                    + " WHERE scope_key = ? AND publication_id = ? AND slot_key <> 'admission'",
                    Long.class, scope, publicationId);
        } else {
            String stream = slot.substring(slot.indexOf(':') + 1);
            bytes = jdbc.queryForObject("SELECT COALESCE(SUM(byte_length), 0) FROM qwen_tool_publication_object"
                    + " WHERE scope_key = ? AND publication_id = ? AND state = 'VERIFIED'"
                    + " AND slot_key LIKE ?", Long.class, scope, publicationId, "segment:" + stream + ":%");
        }
        return verificationBudget.timeout(operationTimeout, bytes);
    }

    private static void requireContract(boolean valid, HttpStatus status,
            String code, String message) {
        if (!valid) {
            throw new ApiException(status, code, message);
        }
    }

    private Timestamp now() {
        return jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class);
    }

    private record Candidate(String objectKey, String resourceId, long epoch, JsonNode receipt) {
    }

    private record ScanClaim(long epoch, JsonNode receipt) {
    }

    private record FinishClaim(long epoch, String predecessor, String objectKey,
            String resourceId, JsonNode binding, JsonNode receipt) {
    }

    private record AdmissionCandidate(String resourceId, String objectKey, boolean verified) {
    }

    private record StreamScan(int segmentCount, long byteLength, String digest) {
    }

    private record Stored(String slot, String resourceId, long length, String digest,
            String objectKey, String state, String operationId) {
    }

    private record Operation(String digest, String slot, String state, long epoch,
            Timestamp claimUntil, Timestamp deadline) {
    }

    private record Resource(String slot, String kind, long length, String digest, String objectKey,
            byte[] inlineBytes, String state) {
    }
}
