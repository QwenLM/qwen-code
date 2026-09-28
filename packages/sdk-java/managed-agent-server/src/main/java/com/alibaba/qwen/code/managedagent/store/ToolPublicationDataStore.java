package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.require;
import static com.alibaba.qwen.code.managedagent.store.ToolPublicationContract.text;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** O2b's publication catalog. Object I/O always runs outside SQL transactions. */
public final class ToolPublicationDataStore {
    private static final ObjectMapper JSON = new ObjectMapper();
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

    public ToolPublicationDataStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ToolPublicationStore grants, ManagedSessionStore sessions, ToolPublicationObjectStore objects,
            Duration operationTimeout, Duration claimTimeout) {
        this.jdbc = Objects.requireNonNull(jdbc);
        this.transactions = new TransactionTemplate(Objects.requireNonNull(manager));
        this.grants = Objects.requireNonNull(grants);
        this.sessions = Objects.requireNonNull(sessions);
        this.objects = Objects.requireNonNull(objects);
        this.operationTimeout = Objects.requireNonNull(operationTimeout);
        this.claimTimeout = Objects.requireNonNull(claimTimeout);
        require(!operationTimeout.isNegative() && !operationTimeout.isZero()
                && !claimTimeout.isNegative() && !claimTimeout.isZero()
                && claimTimeout.compareTo(operationTimeout) < 0,
                "Invalid publication operation deadlines");
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
        return publish(key, publicationId, token, operationId, slot, kind, input, null, maximum);
    }

    public JsonNode seal(JsonNode key, String publicationId, String token, String operationId,
            String streamId, int segmentCount, long byteLength, String digest) {
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
            StreamScan scan = scan(scope, publicationId, streamId, segmentCount);
            require(scan.segmentCount() == segmentCount, "Seal has missing segments");
            require(scan.byteLength() == byteLength && scan.digest().equals(digest),
                    "Seal digest mismatch");
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
                    require(((Number) old.get(0).get("segment_count")).intValue() == segmentCount
                            && ((Number) old.get(0).get("byte_length")).longValue() == byteLength
                            && digest.equals(old.get(0).get("sha256")), "Seal conflicts");
                }
                ObjectNode receipt = JSON.createObjectNode().put("segmentCount", segmentCount)
                        .put("byteLength", byteLength).put("digest", digest);
                finishScan(scope, publicationId, operationId, receipt);
                return receipt;
            });
        } catch (RuntimeException error) {
            abandonScan(scope, publicationId, operationId, claim.epoch());
            throw error;
        }
    }

    public JsonNode prefix(JsonNode key, String publicationId, String token, String operationId,
            String streamId) {
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
            StreamScan scan = scan(scope, publicationId, streamId, -1);
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
            abandonScan(scope, publicationId, operationId, claim.epoch());
            throw error;
        }
    }

    public JsonNode operationStatus(JsonNode key, String publicationId, String token, String operationId) {
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid publication operation ID");
        String scope = scope(key);
        var rows = jdbc.query("SELECT o.state, o.receipt_json, o.deadline, p.tenant_id, p.token_hash,"
                        + " p.workspace_id, p.session_id FROM qwen_tool_publication_operation o"
                        + " JOIN qwen_tool_publication p ON p.scope_key = o.scope_key"
                        + " AND p.publication_id = o.publication_id WHERE o.scope_key = ?"
                        + " AND o.publication_id = ? AND o.operation_id = ?",
                (r, n) -> Map.<String, Object>of("state", r.getString("state"), "deadline", r.getTimestamp("deadline"),
                        "tenant", r.getString("tenant_id"), "workspace", r.getString("workspace_id"),
                        "session", r.getString("session_id"), "tokenHash", r.getString("token_hash"), "receipt",
                        r.getString("receipt_json") == null ? "" : r.getString("receipt_json")),
                scope, publicationId, operationId);
        require(rows.size() == 1, "Publication operation is unknown");
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
        } else if (((Timestamp) row.get("deadline")).before(now())) {
            response.put("state", "EXPIRED");
        }
        return response;
    }

    public JsonNode finished(JsonNode key, String publicationId, String writerToken) {
        sessions.restore(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), writerToken);
        String scope = scope(key);
        Map<String, Object> publication = jdbc.queryForMap("SELECT producer_phase, binding_json,"
                + " terminal_resource_id, finish_operation_id FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ? AND tenant_id = ?"
                + " AND workspace_id = ? AND session_id = ?", scope, publicationId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require("FINISHED".equals(publication.get("producer_phase"))
                || "REFERENCED".equals(publication.get("producer_phase")),
                "Publication has no finished result");
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
        require(outcome != null && outcome.isObject()
                && outcome.path("schemaVersion").asInt(-1) == 1,
                "Invalid admission outcome");
        byte[] bytes = outcome.toString().getBytes(StandardCharsets.UTF_8);
        require(bytes.length <= MAX_TERMINAL, "Admission outcome is too large");
        JsonNode original = finished(key, publicationId, writerToken);
        JsonNode envelope = original.path("result");
        String decision = "complete".equals(text(envelope.path("capture"), "captureStatus"))
                ? "committed" : "blocked";
        require(decision.equals(text(outcome, "decision"))
                && envelope.equals(outcome.path("envelope"))
                && envelope.path("capture").path("manifest").equals(outcome.path("manifestRef"))
                && outcome.path("history").toString().getBytes(StandardCharsets.UTF_8).length <= 64 * 1024,
                "Admission decision or original result conflicts");
        String digest = ToolPublicationContract.sha256(bytes);
        String scope = scope(key);
        AdmissionCandidate candidate = transactions.execute(status -> {
            lockTenant(key);
            sessions.lockPublicationWriter(text(key, "tenantId"), text(key, "workspaceId"),
                    text(key, "sessionId"), writerId, writerGeneration, writerToken);
            var publication = jdbc.queryForMap("SELECT producer_phase, admission_bytes, admission_used_bytes,"
                    + " admission_resource_id, terminal_resource_id FROM qwen_tool_publication"
                    + " WHERE scope_key = ? AND publication_id = ? AND tenant_id = ?"
                    + " AND workspace_id = ? AND session_id = ? FOR UPDATE",
                    scope, publicationId, text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
            require("FINISHED".equals(publication.get("producer_phase"))
                    || "REFERENCED".equals(publication.get("producer_phase")),
                    "Publication is not finished");
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
                require(bytes.length <= allocated - used, "Admission capacity exhausted");
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
            }
            return new AdmissionCandidate(resourceId, objectKey,
                    !stored.isEmpty() && "VERIFIED".equals(stored.get(0).state()));
        });
        require(candidate != null, "Admission candidate is unavailable");
        if (candidate.objectKey() != null) {
            objects.putIfAbsent(candidate.objectKey(), bytes);
            verify(candidate.objectKey(), bytes.length, digest);
        }
        if (!candidate.verified()) {
            transactions.executeWithoutResult(status -> {
                lockTenant(key);
                sessions.lockPublicationWriter(text(key, "tenantId"), text(key, "workspaceId"),
                        text(key, "sessionId"), writerId, writerGeneration, writerToken);
                var publication = jdbc.queryForMap("SELECT producer_phase, terminal_resource_id"
                        + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                        scope, publicationId);
                require("FINISHED".equals(publication.get("producer_phase"))
                        && original.path("terminal").path("resourceId").asText()
                        .equals(publication.get("terminal_resource_id")), "Admission publication changed");
                Stored row = stored(scope, publicationId, "admission").get(0);
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
            String operationId, JsonNode envelope) {
        require(envelope != null, "Missing terminal result");
        byte[] bytes = envelope.toString().getBytes(StandardCharsets.UTF_8);
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
            return claim.receipt();
        }
        try {
            if (claim.predecessor() != null) {
                List<Operation> previous = operation(scope, publicationId, claim.predecessor(), false);
                require(previous.size() == 1 && "SUCCEEDED".equals(previous.get(0).state()),
                        "Finish predecessor has not completed");
            }
            validateFinished(key, publicationId, claim.binding(), result);
            if (claim.objectKey() != null) {
                objects.putIfAbsent(claim.objectKey(), bytes);
                verify(claim.objectKey(), bytes.length, digest);
            }
            return transactions.execute(status -> installFinish(key, scope, publicationId,
                    token, operationId, claim, bytes, digest));
        } catch (RuntimeException error) {
            abandonScan(scope, publicationId, operationId, claim.epoch());
            throw error;
        }
    }

    private FinishClaim beginFinish(JsonNode key, String scope, String publicationId,
            String token, String operationId, int length, String digest) {
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid finish operation ID");
        JsonNode binding = authorize(key, scope, publicationId, token);
        Map<String, Object> row = jdbc.queryForMap("SELECT producer_phase, active_operation_id,"
                + " finish_operation_id, finish_predecessor_id, finish_digest, producer_bytes,"
                + " producer_used_bytes FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND publication_id = ?", scope, publicationId);
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
            require(operationId.equals(row.get("finish_operation_id"))
                    && digest.equals(row.get("finish_digest")) && prior.size() == 1
                    && requestDigest.equals(prior.get(0).digest())
                    && prior.get(0).deadline().after(now), "Finish replay conflicts");
            require(prior.get(0).claimUntil() == null || !prior.get(0).claimUntil().after(now),
                    "Finish operation is busy");
        } else {
            require(prior.isEmpty(), "Finish operation ID conflicts");
            long used = ((Number) row.get("producer_used_bytes")).longValue();
            long allocated = ((Number) row.get("producer_bytes")).longValue();
            require(length <= allocated - used, "Producer capacity exhausted");
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
                    new Timestamp(now.getTime() + operationTimeout.toMillis()), now);
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
        Map<String, Object> publication = jdbc.queryForMap("SELECT producer_phase, finish_operation_id,"
                + " finish_predecessor_id, finish_digest, active_operation_id, capture_used_bytes,"
                + " producer_used_bytes FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND publication_id = ?", scope, publicationId);
        require("FINISHING".equals(publication.get("producer_phase"))
                && operationId.equals(publication.get("finish_operation_id"))
                && digest.equals(publication.get("finish_digest"))
                && publication.get("active_operation_id") == null,
                "Finish barrier changed");
        if (claim.predecessor() != null) {
            List<Operation> previous = operation(scope, publicationId, claim.predecessor(), true);
            require(previous.size() == 1 && "SUCCEEDED".equals(previous.get(0).state()),
                    "Finish predecessor has not completed");
        }
        List<Operation> current = operation(scope, publicationId, operationId, true);
        require(current.size() == 1 && current.get(0).epoch() == claim.epoch()
                && current.get(0).claimUntil().after(now()) && current.get(0).deadline().after(now()),
                "Finish claim expired");
        Stored terminal = stored(scope, publicationId, "terminal").get(0);
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

    private void validateFinished(JsonNode key, String publicationId, JsonNode binding, JsonNode result) {
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
            MessageDigest hash = sha256();
            if (size == 0) {
                readRangeInternal(key, publicationId, manifestRef, identity, stream, 0, 0, false);
            }
            for (long offset = 0; offset < size; ) {
                int count = (int) Math.min(MAX_SEGMENT, size - offset);
                hash.update(readRangeInternal(key, publicationId, manifestRef,
                        identity, stream, offset, count, false));
                offset += count;
            }
            require(HexFormat.of().formatHex(hash.digest()).equals(text(content, "digest")),
                    "Finished stream digest conflicts");
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
        authorize(key, scope, publicationId, token);
        var phase = jdbc.queryForMap("SELECT producer_phase, finish_predecessor_id"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                scope, publicationId);
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
            require(row.deadline().after(now), "Publication operation expired");
        }
        String active = availableActive(scope, publicationId, operationId, now);
        require(active == null || active.equals(operationId), "Publication is busy");
        if (active != null) {
            require(!prior.isEmpty() && (prior.get(0).claimUntil() == null
                    || !prior.get(0).claimUntil().after(now)), "Publication operation is busy");
        }
        long epoch = prior.isEmpty() ? 1 : prior.get(0).epoch() + 1;
        Timestamp claimUntil = new Timestamp(now.getTime() + claimTimeout.toMillis());
        if (prior.isEmpty()) {
            jdbc.update("INSERT INTO qwen_tool_publication_operation (scope_key, publication_id, operation_id,"
                            + " request_digest, slot_key, state, claim_owner, claim_epoch, claim_until, deadline,"
                            + " created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)",
                    scope, publicationId, operationId, requestDigest, slot, UUID.randomUUID().toString(),
                    epoch, claimUntil, new Timestamp(now.getTime() + operationTimeout.toMillis()), now);
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
        require(operationId.equals(active) && rows.size() == 1 && rows.get(0).epoch() == epoch
                && "PENDING".equals(rows.get(0).state()) && rows.get(0).claimUntil().after(now())
                && rows.get(0).deadline().after(now()), "Publication operation claim expired");
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

    private StreamScan scan(String scope, String publicationId, String streamId, int expectedCount) {
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
            require(rows.size() == expectedCount, "Seal has missing or extra segments");
        }
        MessageDigest aggregate = sha256();
        int count = 0;
        long length = 0;
        while (count < 65536 && (expectedCount < 0 || count < expectedCount)) {
            Stored row = byOrdinal.get(count);
            if (row == null || !"VERIFIED".equals(row.state())) {
                break;
            }
            require(row.objectKey() != null, "Publication segment is missing its object");
            MessageDigest segment = sha256();
            long segmentLength = 0;
            try (InputStream stream = objects.open(row.objectKey())) {
                byte[] buffer = new byte[64 * 1024];
                for (int bytes; (bytes = stream.read(buffer)) != -1; ) {
                    aggregate.update(buffer, 0, bytes);
                    segment.update(buffer, 0, bytes);
                    segmentLength += bytes;
                    if (segmentLength > row.length()) {
                        quarantine(scope, publicationId, row.slot());
                        throw new IllegalArgumentException("Publication segment length changed");
                    }
                }
            } catch (IOException error) {
                throw new IllegalStateException("Publication segment read failed", error);
            }
            if (segmentLength != row.length() || !HexFormat.of().formatHex(segment.digest()).equals(row.digest())) {
                quarantine(scope, publicationId, row.slot());
                throw new IllegalArgumentException("Publication segment digest changed");
            }
            length += segmentLength;
            count++;
        }
        return new StreamScan(count, length, HexFormat.of().formatHex(aggregate.digest()));
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private void quarantine(String scope, String publicationId, String slot) {
        transactions.executeWithoutResult(status -> jdbc.update("UPDATE qwen_tool_publication_object"
                + " SET state = 'QUARANTINED' WHERE scope_key = ? AND publication_id = ?"
                + " AND slot_key = ? AND state = 'VERIFIED'", scope, publicationId, slot));
    }

    private JsonNode publish(JsonNode key, String publicationId, String token, String operationId,
            String slot, String kind, byte[] input, String expectedDigest, int maximum) {
        require(input != null && input.length > 0 && input.length <= maximum, "Invalid publication size");
        require(operationId != null && operationId.matches("[a-z0-9_-]{1,128}"),
                "Invalid publication operation ID");
        byte[] bytes = input.clone();
        String digest = ToolPublicationContract.sha256(bytes);
        require(expectedDigest == null || expectedDigest.equals(digest), "Publication digest mismatch");
        String scope = scope(key);
        Candidate candidate = transactions.execute(status -> claim(key, scope, publicationId, token,
                operationId, slot, kind, bytes.length, digest));
        require(candidate != null, "Publication operation unavailable");
        if (candidate.receipt() != null) {
            if (candidate.objectKey() != null) {
                try {
                    verify(candidate.objectKey(), bytes.length, digest);
                } catch (IllegalArgumentException error) {
                    quarantine(scope, publicationId, slot);
                    throw error;
                }
            } else if (kind != null) {
                readResource(key, publicationId, candidate.resourceId());
            }
            return candidate.receipt();
        }
        try {
            if (candidate.objectKey() != null) {
                objects.putIfAbsent(candidate.objectKey(), bytes);
                verify(candidate.objectKey(), bytes.length, digest);
            }
            return transactions.execute(status -> install(key, scope, publicationId, token,
                    operationId, candidate, kind, bytes, digest));
        } catch (RuntimeException error) {
            abandonScan(scope, publicationId, operationId, candidate.epoch());
            throw error;
        }
    }

    private Candidate claim(JsonNode key, String scope, String publicationId, String token,
            String operationId, String slot, String kind, int length, String digest) {
        JsonNode binding = authorize(key, scope, publicationId, token);
        var phase = jdbc.queryForMap("SELECT producer_phase, finish_predecessor_id"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?",
                scope, publicationId);
        require("OPEN".equals(phase.get("producer_phase"))
                || "FINISHING".equals(phase.get("producer_phase"))
                && operationId.equals(phase.get("finish_predecessor_id")),
                "Publication is finishing");
        List<Stored> saved = stored(scope, publicationId, slot);
        if (slot.startsWith("segment:")) {
            String streamId = slot.split(":")[1];
            Long sealed = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_seal"
                    + " WHERE scope_key = ? AND publication_id = ? AND stream_id = ?",
                    Long.class, scope, publicationId, streamId);
            require(sealed == 0 || !saved.isEmpty(), "Publication stream is sealed");
        }
        if (!saved.isEmpty()) {
            Stored row = saved.get(0);
            require(row.length() == length && digest.equals(row.digest()), "Publication slot conflicts");
            if ("VERIFIED".equals(row.state())) {
                return new Candidate(row.objectKey(), row.resourceId(), 0,
                        receipt(binding, slot, row.resourceId(), kind, length, digest));
            }
            require(operationId.equals(row.operationId()), "Publication candidate belongs to another operation");
        }
        Timestamp now = now();
        List<Operation> prior = operation(scope, publicationId, operationId, true);
        String requestDigest = requestDigest(slot, length, digest);
        if (!prior.isEmpty()) {
            Operation row = prior.get(0);
            require(requestDigest.equals(row.digest()) && slot.equals(row.slot()),
                    "Publication operation conflicts");
            require(row.deadline().after(now), "Publication operation expired");
        }
        String active = availableActive(scope, publicationId, operationId, now);
        require(active == null || active.equals(operationId), "Publication is busy");
        String resourceId = kind == null ? null : "result-" + hash(scope + ":" + publicationId + ":" + slot).substring(0, 32);
        String objectKey = (kind != null && length <= 64 * 1024) ? null
                : "managed-tool-results/" + scope + "/" + publicationId + "/" + hash(slot);
        if (saved.isEmpty()) {
            String category = category(slot, scope, publicationId);
            long allocated = jdbc.queryForObject("SELECT " + category + "_bytes FROM qwen_tool_publication"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, publicationId);
            long used = jdbc.queryForObject("SELECT " + category + "_used_bytes FROM qwen_tool_publication"
                    + " WHERE scope_key = ? AND publication_id = ?", Long.class, scope, publicationId);
            require(length <= allocated - used, "Publication capacity exhausted");
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
            require(prior.get(0).claimUntil() == null || !prior.get(0).claimUntil().after(now),
                    "Publication operation is busy");
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
        require(operationId.equals(active), "Publication operation lost its claim");
        List<Operation> rows = operation(scope, publicationId, operationId, true);
        require(rows.size() == 1 && rows.get(0).epoch() == candidate.epoch()
                && rows.get(0).claimUntil().after(now()) && rows.get(0).deadline().after(now())
                && "PENDING".equals(rows.get(0).state()), "Publication operation claim expired");
        Stored row = stored(scope, publicationId, rows.get(0).slot()).get(0);
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

    private String category(String slot, String scope, String publicationId) {
        if (slot.startsWith("segment:")) {
            return "capture";
        }
        if (slot.startsWith("page:")) {
            String stream = slot.split(":")[1];
            Long sealed = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_seal"
                    + " WHERE scope_key = ? AND publication_id = ? AND stream_id = ?",
                    Long.class, scope, publicationId, stream);
            return sealed != null && sealed > 0 ? "producer" : "capture";
        }
        return "producer";
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
        lockTenant(key);
        JsonNode binding = grants.producerBindingLocked(scope, publicationId, token);
        require(binding.path("sessionKey").equals(key), "Publication scope conflicts");
        return binding;
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
        return jdbc.query("SELECT slot_key, resource_id, byte_length, sha256, object_key, state,"
                        + " operation_id FROM qwen_tool_publication_object WHERE scope_key = ?"
                        + " AND publication_id = ? AND slot_key = ?",
                (r, n) -> new Stored(r.getString("slot_key"), r.getString("resource_id"),
                        r.getLong("byte_length"), r.getString("sha256"), r.getString("object_key"),
                        r.getString("state"), r.getString("operation_id")), scope, publicationId, slot);
    }

    private List<Operation> operation(String scope, String publicationId, String operationId, boolean locked) {
        return jdbc.query("SELECT request_digest, slot_key, state, claim_epoch, claim_until, deadline"
                        + " FROM qwen_tool_publication_operation WHERE scope_key = ? AND publication_id = ?"
                        + " AND operation_id = ?" + (locked ? " FOR UPDATE" : ""),
                (r, n) -> new Operation(r.getString("request_digest"), r.getString("slot_key"),
                        r.getString("state"), r.getLong("claim_epoch"), r.getTimestamp("claim_until"),
                        r.getTimestamp("deadline")), scope, publicationId, operationId);
    }

    private void verify(String objectKey, long length, String digest) {
        objects.requireUnversioned();
        try (InputStream stream = objects.open(objectKey)) {
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

    public byte[] readResource(JsonNode key, String publicationId, String resourceId) {
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
            try (InputStream stream = objects.open(row.objectKey())) {
                bytes = stream.readNBytes((int) row.length() + 1);
            } catch (IOException error) {
                throw new IllegalStateException("Publication resource read failed", error);
            }
        }
        if (bytes == null || bytes.length != row.length()
                || !ToolPublicationContract.sha256(bytes).equals(row.digest())) {
            quarantine(scope, publicationId, row.slot());
            throw new IllegalArgumentException("Publication resource digest changed");
        }
        return bytes;
    }

    public byte[] readRange(JsonNode key, String publicationId, String writerToken,
            JsonNode manifestRef, JsonNode expectedIdentity, String streamId, long offset, int length) {
        sessions.restore(text(key, "tenantId"), text(key, "workspaceId"),
                text(key, "sessionId"), writerToken);
        return readRangeInternal(key, publicationId, manifestRef, expectedIdentity,
                streamId, offset, length, true);
    }

    private byte[] readRangeInternal(JsonNode key, String publicationId,
            JsonNode manifestRef, JsonNode expectedIdentity, String streamId,
            long offset, int length, boolean requireFinished) {
        require(offset >= 0 && length >= 0 && length <= MAX_SEGMENT,
                "Invalid publication range");
        String scope = scope(key);
        var publication = jdbc.queryForMap("SELECT binding_json, producer_phase FROM qwen_tool_publication"
                + " WHERE scope_key = ? AND publication_id = ? AND tenant_id = ?"
                + " AND workspace_id = ? AND session_id = ?", scope, publicationId,
                text(key, "tenantId"), text(key, "workspaceId"), text(key, "sessionId"));
        require(!requireFinished || "FINISHED".equals(publication.get("producer_phase"))
                || "REFERENCED".equals(publication.get("producer_phase")),
                "Publication is not finished");
        JsonNode binding = ToolPublicationContract.readJson(
                ((String) publication.get("binding_json")).getBytes(StandardCharsets.UTF_8));
        JsonNode manifest = ToolPublicationContract.parseToolResult("manifest", referencedResource(key, publicationId,
                manifestRef, "managed-tool-result-manifest", MAX_MANIFEST), MAX_MANIFEST);
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
        require(size >= 0 && offset <= size && length <= size - offset,
                "Publication range exceeds stream");
        byte[] result = new byte[length];
        JsonNode body = selected.path("body");
        if (body.has("ref")) {
            JsonNode ref = body.path("ref");
            Resource content = catalogResource(key, publicationId, text(ref, "resourceId"));
            require(refMatches(content, ref, "managed-tool-result-content")
                    && content.length() == size, "Publication content reference conflicts");
            copyVerified(content, scope, publicationId, offset, result, 0, length);
            return result;
        }
        require(body.path("pages").isArray(), "Publication stream has no pages");
        long expectedOffset = 0;
        int expectedOrdinal = 0;
        for (JsonNode pageReference : body.path("pages")) {
            JsonNode page = ToolPublicationContract.parseToolResult("page", referencedResource(key, publicationId,
                    pageReference.path("ref"), "managed-tool-result-page", MAX_PAGE), MAX_PAGE);
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
                long segmentLength = segment.path("byteLength").asLong(-1);
                require(segmentLength > 0 && segmentLength <= MAX_SEGMENT && expectedOrdinal < 65536,
                        "Publication page segment is invalid");
                List<Stored> rows = stored(scope, publicationId, "segment:" + streamId + ":" + expectedOrdinal);
                require(rows.size() == 1 && "VERIFIED".equals(rows.get(0).state())
                        && rows.get(0).length() == segmentLength
                        && rows.get(0).digest().equals(text(segment, "digest")),
                        "Publication page segment conflicts");
                long position = expectedOffset + pageLength;
                long overlapStart = Math.max(position, offset);
                long overlapEnd = Math.min(position + segmentLength, offset + length);
                if (overlapEnd > overlapStart) {
                    Resource bytes = new Resource(rows.get(0).slot(), null, segmentLength,
                            rows.get(0).digest(), rows.get(0).objectKey(), null, rows.get(0).state());
                    copyVerified(bytes, scope, publicationId, overlapStart - position, result,
                            Math.toIntExact(overlapStart - offset), Math.toIntExact(overlapEnd - overlapStart));
                }
                pageLength += segmentLength;
                segmentCount++;
                expectedOrdinal++;
            }
            require(segmentCount == pageReference.path("segmentCount").asInt(-1)
                    && pageLength == pageReference.path("byteLength").asLong(-1),
                    "Publication page reference conflicts");
            expectedOffset += pageLength;
        }
        require(expectedOffset == size, "Publication stream page length conflicts");
        return result;
    }

    private byte[] referencedResource(JsonNode key, String publicationId, JsonNode ref,
            String kind, int maximum) {
        Resource resource = catalogResource(key, publicationId, text(ref, "resourceId"));
        require(refMatches(resource, ref, kind) && resource.length() <= maximum,
                "Publication resource reference conflicts");
        return readResource(key, publicationId, text(ref, "resourceId"));
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
            long offset, byte[] target, int targetOffset, int length) {
        require(offset >= 0 && length >= 0 && offset <= resource.length()
                && length <= resource.length() - offset, "Publication copy range is invalid");
        MessageDigest hash = sha256();
        try (InputStream input = resource.objectKey() == null
                ? new java.io.ByteArrayInputStream(resource.inlineBytes()) : objects.open(resource.objectKey())) {
            byte[] buffer = new byte[64 * 1024];
            long position = 0;
            for (int count; (count = input.read(buffer)) != -1; ) {
                hash.update(buffer, 0, count);
                long start = Math.max(position, offset);
                long end = Math.min(position + count, offset + length);
                if (end > start) {
                    System.arraycopy(buffer, Math.toIntExact(start - position), target,
                            targetOffset + Math.toIntExact(start - offset), Math.toIntExact(end - start));
                }
                position += count;
                if (position > resource.length()) {
                    quarantine(scope, publicationId, resource.slot());
                    throw new IllegalArgumentException("Publication object length changed");
                }
            }
            if (position != resource.length()
                    || !HexFormat.of().formatHex(hash.digest()).equals(resource.digest())) {
                quarantine(scope, publicationId, resource.slot());
                throw new IllegalArgumentException("Publication object digest changed");
            }
        } catch (IOException error) {
            throw new IllegalStateException("Publication object read failed", error);
        }
    }

    private static String scope(JsonNode key) {
        require(key != null && key.isObject(), "Invalid publication scope");
        return hash(JSON.createArrayNode().add(text(key, "tenantId"))
                .add(text(key, "workspaceId")).add(text(key, "sessionId")).toString());
    }

    private static String requestDigest(String slot, int length, String digest) {
        return hash(JSON.createArrayNode().add(slot).add(length).add(digest).toString());
    }

    private static String hash(String value) {
        return ToolPublicationContract.sha256(value.getBytes(StandardCharsets.UTF_8));
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
