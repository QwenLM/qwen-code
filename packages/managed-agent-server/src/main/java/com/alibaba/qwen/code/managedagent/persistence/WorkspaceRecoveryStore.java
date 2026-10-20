package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/** Offline derived metadata only; no Session writer or authority mutation. */
public final class WorkspaceRecoveryStore {
    static final ObjectMapper JSON = new ObjectMapper();
    private static final int PAGE = 32;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final WorkspaceStorageGuard guard;
    private final WorkspaceRecoveryReader reader;
    private final JsonNode request;
    private final String mode;
    private final String id;
    private final String tenant;
    private final String storage;
    private boolean lockSources;
    private WorkspaceOperations operations;
    private static final WorkspaceOperations.Kind KIND = WorkspaceOperations.Kind.WORKSPACE_RECOVERY;

    public WorkspaceRecoveryStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            WorkspaceStorageGuard guard, ToolPublicationObjectStore objects, String mode, byte[] requestBytes) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.guard = guard;
        this.reader = new WorkspaceRecoveryReader(jdbc, objects);
        this.request = parse(requestBytes);
        this.mode = mode;
        check(Set.of("capture", "verify", "inspect").contains(mode), "invalid_request");
        check(request.isObject() && request.path("version").isIntegralNumber()
                && request.path("version").canConvertToInt() && request.path("version").asInt() == 1, "invalid_request");
        id = uuid(request, "operationId");
        tenant = text(request, "tenantId");
        storage = text(request, "storageId");
        operations = new WorkspaceOperations(jdbc, tenant);
        check(tenant.length() <= 128 && storage.length() <= 256, "invalid_request");
        if ("inspect".equals(mode)) {
            return;
        }
        check(!id.equals(uuid(request, "fenceOperationId")) && request.path("mountRevision").isIntegralNumber()
                && request.path("mountRevision").canConvertToLong()
                && request.path("mountRevision").asLong() > 0
                && request.path("mountRevision").asLong() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER, "invalid_request");
        for (String field : List.of("sourceRoot", "bundleRoot", "fileHistoryRoot", "nodeExecutable", "cliEntry")) {
            Path path = Path.of(text(request, field));
            check(path.isAbsolute() && path.normalize().equals(path), "invalid_request");
        }
        String requestDigest = hash(requestBytes);
        // The stream-capture collector fences its byte drop with a locking read over this
        // table; a registration that meets it fails with a lock wait instead of racing
        // silently, and the collector defers and releases quickly, so retry transiently.
        int attempts = 0;
        while (true) {
            try {
                transactions.executeWithoutResult(status -> register(requestDigest));
                break;
            } catch (PessimisticLockingFailureException error) {
                if (++attempts >= 3) {
                    throw error;
                }
            }
        }
    }

    private void register(String requestDigest) {
        var existing = operation(id);
        if (existing != null) {
            check(tenant.equals(existing.get("tenant_id")) && storage.equals(existing.get("storage_id"))
                    && mode.equals(existing.get("mode")) && requestDigest.equals(existing.get("request_digest")),
                    "operation_conflict");
            return;
        }
        Map<String, Object> capture = null;
        JsonNode registration;
        if ("verify".equals(mode)) {
            capture = operation(uuid(request, "captureOperationId"));
            check(capture != null && "SEALED".equals(capture.get("state"))
                    && tenant.equals(capture.get("tenant_id")) && storage.equals(capture.get("storage_id")),
                    "capture_not_sealed");
            JsonNode original = parse((String) capture.get("request_json"));
            for (String field : List.of("fenceOperationId", "mountRevision", "sourceRoot", "bundleRoot", "fileHistoryRoot")) {
                check(original.path(field).equals(request.path(field)), "operation_conflict");
            }
            registration = parse((String) capture.get("registration_json"));
            try {
                guard.verifyCapturedRegistration(JSON.treeToValue(registration, WorkspaceStorageGuard.RecoveryRegistration.class));
            } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
                throw failure("source_drift");
            }
        } else {
            registration = currentRegistration();
        }
        operations.create(KIND, id, WorkspaceOperations.values("storage_id", storage, "mode", mode,
                "capture_operation_id", capture == null ? null : capture.get("operation_id"),
                "request_digest", requestDigest, "request_json", request.toString(),
                "registration_json", registration.toString(), "source_digest", hash(new byte[0]),
                "session_count", 0L, "state", "capture".equals(mode) ? "CAPTURING" : "VERIFYING"));
        if (capture != null) {
            String after = "";
            while (true) {
                List<Map<String, Object>> page = sessionRows((String) capture.get("operation_id"), after, PAGE);
                for (Map<String, Object> source : page) {
                    String session = (String) source.get("session_id");
                    check(currentSource(jdbc, tenant, storage, session, true).toString().equals(source.get("source_json")), "source_drift");
                    operations.insertWork(KIND, id, "SESSION", hash(session), session, session,
                            WorkspaceOperations.values("source_digest", source.get("source_digest"),
                                    "source_json", source.get("source_json")), "PENDING");
                    after = session;
                }
                if (page.size() < PAGE) {
                    break;
                }
            }
            operations.update(KIND, id, WorkspaceOperations.values("source_digest", capture.get("source_digest"),
                    "session_count", capture.get("session_count")));
        } else {
            lockSources = true;
            try {
                SourceCut cut = scanSources(true);
                operations.update(KIND, id, WorkspaceOperations.values("source_digest", cut.digest(), "session_count", cut.count()));
            } finally {
                lockSources = false;
            }
        }
    }

    public JsonNode call(String method, JsonNode params) {
        check(params != null && params.isObject(), "invalid_request");
        try {
            return switch (method) {
                case "context" -> context();
                case "sessions" -> sessions(params.path("afterSessionId").asText(""));
                case "transaction" -> {
                    requireCapture();
                    JsonNode source = pinned(text(params, "sessionId"));
                    yield reader.transaction(source, positive(params, "revision"));
                }
                case "resource" -> {
                    requireCapture();
                    yield reader.resource(pinned(text(params, "sessionId")), params.path("ref"));
                }
                case "publicationReceipt" -> {
                    requireCapture();
                    yield reader.publicationReceipt(pinned(text(params, "sessionId")), params);
                }
                case "publicationObject" -> {
                    requireCapture();
                    yield reader.publicationObject(pinned(text(params, "sessionId")),
                            text(params, "publicationId"), text(params, "slotKey"));
                }
                case "enqueueRef" -> enqueue(params);
                case "nextRef" -> nextRef(text(params, "sessionId"));
                case "completeRef" -> completeRef(params);
                case "asset" -> asset(params);
                case "assetLookup" -> assetLookup(text(params, "key"));
                case "assetPage" -> assetPage(params.path("afterKey").asText(""));
                case "sessionComplete" -> sessionComplete(params);
                case "finish" -> finish(params);
                case "failure" -> {
                    check(Set.of("CAPTURING", "VERIFYING", "INVALIDATED").contains(ownedOperation().get("state")),
                            "operation_not_writable");
                    recordFailure(text(params, "code"));
                    yield JSON.createObjectNode().put("recorded", true);
                }
                case "invalidate" -> {
                    check("capture".equals(mode), "source_read_not_allowed");
                    check(Set.of("CAPTURING", "INVALIDATED").contains(ownedOperation().get("state")), "operation_not_writable");
                    String code = text(params, "code");
                    check(Set.of("source_drift", "unsupported_source_entry").contains(code), "invalid_request");
                    invalidate(code);
                    yield JSON.createObjectNode().put("state", "INVALIDATED");
                }
                default -> throw failure("unknown_method");
            };
        } catch (RecoveryFailure error) {
            if ("source_drift".equals(error.code) || "resource_collected".equals(error.code)) {
                // The bytes have no other copy: no retry can succeed, so terminate instead
                // of wedging CAPTURING and pinning this cut's retired Sessions forever.
                invalidate(error.code);
            }
            recordFailure(error.code);
            throw error;
        }
    }

    private void invalidate(String code) {
        transactions.executeWithoutResult(status -> {
            Map<String, Object> current = operation(id);
            if (current != null && "CAPTURING".equals(current.get("state"))) {
                operations.update(KIND, id, WorkspaceOperations.values("state", "INVALIDATED", "last_error_code", code));
            }
        });
    }

    private void recordFailure(String code) {
        check(code.matches("[a-z0-9_]{1,64}"), "invalid_error_code");
        transactions.executeWithoutResult(status -> {
            Map<String, Object> current = operation(id);
            if (current != null && Set.of("CAPTURING", "VERIFYING").contains(current.get("state"))) {
                operations.update(KIND, id, WorkspaceOperations.values("last_error_code", code));
            }
        });
    }

    void workerFailed() {
        Map<String, Object> current = operation(id);
        if (current != null && current.get("last_error_code") == null) {
            recordFailure("worker_failed");
        }
    }

    public JsonNode inspect() {
        Map<String, Object> row = ownedOperation();
        ObjectNode result = JSON.createObjectNode().put("operationId", id).put("state", (String) row.get("state"));
        result.put("sourceDigest", (String) row.get("source_digest"))
                .put("sessionCount", ((Number) row.get("session_count")).longValue())
                .put("completedSessions", workCount(id, "SESSION", "state = 'COMPLETE'"))
                .put("pendingReferences", workCount(id, "RECOVERY_EVIDENCE", "state = 'PENDING'"))
                .put("assets", workCount(id, "RESOURCE", "1 = 1"));
        JsonNode page = sessions(request.path("afterSessionId").asText(""));
        result.set("sessions", page.path("sessions"));
        result.set("nextSessionId", page.path("nextSessionId"));
        result.set("registration", parse((String) row.get("registration_json")));
        result.set("lastErrorCode", JSON.valueToTree(row.get("last_error_code")));
        result.set("manifestDigest", JSON.valueToTree(row.get("manifest_digest")));
        result.set("result", row.get("result_json") == null ? JSON.nullNode() : parse((String) row.get("result_json")));
        return result;
    }

    private JsonNode context() {
        Map<String, Object> row = ownedOperation();
        check(!"INVALIDATED".equals(row.get("state")), "source_drift");
        ObjectNode result = JSON.createObjectNode().put("protocol", "workspace-recovery/1")
                .put("mode", mode).put("sourceDigest", (String) row.get("source_digest"))
                .put("sessionCount", ((Number) row.get("session_count")).longValue());
        result.set("request", request);
        result.set("registration", parse((String) row.get("registration_json")));
        Object capture = row.get("capture_operation_id");
        if (capture == null) {
            result.putNull("capture");
        } else {
            Map<String, Object> saved = operation((String) capture);
            ObjectNode original = result.putObject("capture").put("operationId", (String) capture)
                    .put("manifestDigest", (String) saved.get("manifest_digest"));
            original.set("result", parse((String) saved.get("result_json")));
        }
        return result;
    }

    private JsonNode sessions(String after) {
        var rows = sessionRows(id, after, PAGE + 1);
        ObjectNode page = JSON.createObjectNode();
        ArrayNode values = page.putArray("sessions");
        for (var row : rows.subList(0, Math.min(PAGE, rows.size()))) {
            ObjectNode value = values.addObject().put("sessionId", (String) row.get("session_id"))
                    .put("sourceDigest", (String) row.get("source_digest")).put("sourceJson", (String) row.get("source_json"));
            value.set("source", parse((String) row.get("source_json")));
        }
        if (rows.size() > PAGE) {
            page.put("nextSessionId", (String) rows.get(PAGE - 1).get("session_id"));
        } else {
            page.putNull("nextSessionId");
        }
        return page;
    }

    private JsonNode enqueue(JsonNode params) {
        String session = text(params, "sessionId");
        JsonNode ref = params.path("ref");
        WorkspaceRecoveryReader.validateRef(ref);
        return transactions.execute(status -> {
            mutable();
            recheckSession(session);
            String key = session + ":" + text(ref, "resourceId");
            JsonNode prior = work(id, "REF", key);
            if (prior != null) {
                check(prior.equals(ref), "reference_conflict");
            } else {
                insertWork("REF", key, session, ref, "PENDING");
            }
            String state = (String) operations.findWork(KIND, id, "RECOVERY_EVIDENCE", hash(key), false).get("state");
            return JSON.createObjectNode().put("complete", "COMPLETE".equals(state));
        });
    }

    private JsonNode nextRef(String session) {
        pinned(session);
        var rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION_WORK.columns() + " FROM ma_operation_work WHERE operation_key = ?"
                + " AND work_kind = 'RECOVERY_EVIDENCE' AND session_id = ? AND state = 'PENDING' ORDER BY target_key LIMIT 1",
                (row, index) -> WorkspaceOperations.work(row), operations.key(KIND, id), session);
        return rows.isEmpty() ? JSON.nullNode() : parse((String) rows.getFirst().get("metadata_json"));
    }

    private JsonNode completeRef(JsonNode params) {
        String session = text(params, "sessionId");
        JsonNode ref = params.path("ref");
        WorkspaceRecoveryReader.validateRef(ref);
        return transactions.execute(status -> {
            mutable();
            recheckSession(session);
            String key = session + ":" + text(ref, "resourceId");
            check(ref.equals(work(id, "REF", key)), "reference_conflict");
            operations.updateWork(KIND, id, "RECOVERY_EVIDENCE", hash(key), WorkspaceOperations.values("state", "COMPLETE"));
            return JSON.createObjectNode().put("complete", true);
        });
    }

    private JsonNode asset(JsonNode params) {
        String key = text(params, "key");
        check(key.matches("[0-9a-f]{64}"), "invalid_asset_key");
        JsonNode metadata = params.path("metadata");
        check(metadata.isObject() && metadata.toString().getBytes(StandardCharsets.UTF_8).length <= 256 * 1024,
                "invalid_asset_metadata");
        return transactions.execute(status -> {
            mutable();
            String session = metadata.path("sessionId").asText(null);
            if (session != null) {
                recheckSession(session);
            } else if ("capture".equals(mode)) {
                recheckBoundary();
            }
            if ("verify".equals(mode)) {
                check(metadata.equals(work(assetOperation(), "ASSET", key)), "asset_conflict");
            }
            JsonNode prior = work(id, "ASSET", key);
            if (prior == null) {
                insertWork("ASSET", key, session, metadata, "COMPLETE");
            } else {
                check(metadata.equals(prior), "asset_conflict");
            }
            return metadata;
        });
    }

    private JsonNode assetLookup(String key) {
        JsonNode value = work(assetOperation(), "ASSET", key);
        return value == null ? JSON.nullNode() : value;
    }

    private JsonNode assetPage(String after) {
        var rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION_WORK.columns() + " FROM ma_operation_work WHERE operation_key = ?"
                + " AND work_kind = 'RESOURCE' AND target_key > ? ORDER BY target_key LIMIT ?",
                (row, index) -> WorkspaceOperations.work(row), operations.key(KIND, assetOperation()), after, PAGE + 1);
        ObjectNode page = JSON.createObjectNode();
        ArrayNode assets = page.putArray("assets");
        for (var row : rows.subList(0, Math.min(PAGE, rows.size()))) {
            ObjectNode asset = assets.addObject().put("key", (String) row.get("work_key"));
            asset.set("metadata", parse((String) row.get("metadata_json")));
        }
        if (rows.size() > PAGE) {
            page.put("nextKey", (String) rows.get(PAGE - 1).get("work_key"));
        } else {
            page.putNull("nextKey");
        }
        return page;
    }

    private JsonNode sessionComplete(JsonNode params) {
        String session = text(params, "sessionId");
        JsonNode summary = params.path("summary");
        check(summary.isObject() && summary.toString().length() <= 256 * 1024, "invalid_summary");
        return transactions.execute(status -> {
            mutable();
            recheckSession(session);
            check(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation_work WHERE operation_key = ?"
                    + " AND work_kind = 'RECOVERY_EVIDENCE' AND session_id = ? AND state <> 'COMPLETE'",
                    Long.class, operations.key(KIND, id), session) == 0, "references_incomplete");
            var saved = operations.findWork(KIND, id, "SESSION", hash(session), true);
            if (saved.get("summary_json") != null) {
                check(summary.equals(parse((String) saved.get("summary_json"))), "summary_conflict");
            }
            operations.updateWork(KIND, id, "SESSION", hash(session),
                    WorkspaceOperations.values("state", "COMPLETE", "summary_json", summary.toString()));
            return JSON.createObjectNode().put("complete", true);
        });
    }

    private JsonNode finish(JsonNode params) {
        String digest = text(params, "manifestDigest");
        check(digest.matches("[0-9a-f]{64}"), "invalid_manifest_digest");
        JsonNode result = params.path("result");
        check(result.isObject() && result.path("contentVerified").asBoolean(false)
                && result.has("activation") && result.path("activation").isBoolean()
                && !result.path("activation").asBoolean(), "invalid_completion");
        try {
            Path manifest = Path.of(text(request, "bundleRoot"), ".w1-recovery", "manifest.json");
            check(manifest.toRealPath().equals(manifest) && Files.isRegularFile(manifest, LinkOption.NOFOLLOW_LINKS)
                    && Files.size(manifest) <= 1024 * 1024, "invalid_manifest");
            byte[] bytes = Files.readAllBytes(manifest);
            check(digest.equals(hash(bytes)), "manifest_digest_conflict");
            validateManifest(parse(bytes));
        } catch (java.io.IOException error) {
            throw failure("bundle_io_failed");
        }
        return transactions.execute(status -> {
            Map<String, Object> operation = operations.find(KIND, id, true);
            check(operation != null, "operation_not_writable");
            if (Set.of("SEALED", "VERIFIED").contains(operation.get("state"))) {
                check(digest.equals(operation.get("manifest_digest")), "manifest_digest_conflict");
                return inspect();
            }
            check(("capture".equals(mode) ? "CAPTURING" : "VERIFYING").equals(operation.get("state")), "operation_not_writable");
            check(workCount(id, "SESSION", "state <> 'COMPLETE'") == 0, "sessions_incomplete");
            check(workCount(id, "RECOVERY_EVIDENCE", "state <> 'COMPLETE'") == 0, "references_incomplete");
            if ("verify".equals(mode)) {
                check(digest.equals(operation((String) operation.get("capture_operation_id")).get("manifest_digest")),
                        "manifest_digest_conflict");
                check(workCount(id, "RESOURCE", "1 = 1")
                        == workCount(assetOperation(), "RESOURCE", "1 = 1"), "assets_incomplete");
            }
            boolean compatible;
            try {
                recheckBoundary();
                SourceCut current = scanSources(false);
                compatible = current.digest().equals(operation.get("source_digest"))
                        && current.count() == ((Number) operation.get("session_count")).longValue();
            } catch (RecoveryFailure error) {
                if (!"source_drift".equals(error.code)) {
                    throw error;
                }
                compatible = false;
            }
            if ("capture".equals(mode)) {
                check(compatible, "source_drift");
            }
            ObjectNode completed = result.deepCopy();
            completed.put("authorityCompatible", compatible).put("activation", false);
            operations.update(KIND, id, WorkspaceOperations.values("state", "capture".equals(mode) ? "SEALED" : "VERIFIED",
                    "manifest_digest", digest, "last_error_code", null, "result_json", completed.toString()));
            return inspect();
        });
    }

    private void validateManifest(JsonNode manifest) {
        Map<String, Object> operation = ownedOperation();
        check(manifest.isObject() && manifest.path("version").isIntegralNumber()
                && manifest.path("version").canConvertToInt() && manifest.path("version").asInt() == 1
                && "local-workspace-bundle/1".equals(manifest.path("provider").asText())
                && tenant.equals(manifest.path("tenantId").asText()) && storage.equals(manifest.path("storageId").asText())
                && ("capture".equals(mode) ? id : text(request, "captureOperationId"))
                        .equals(manifest.path("captureOperationId").asText())
                && request.path("fenceOperationId").equals(manifest.path("fenceOperationId"))
                && request.path("mountRevision").equals(manifest.path("mountRevision"))
                && parse((String) operation.get("registration_json")).equals(manifest.path("registration"))
                && operation.get("source_digest").equals(manifest.path("sourceDigest").asText())
                && manifest.path("sessionCount").isIntegralNumber()
                && ((Number) operation.get("session_count")).longValue() == manifest.path("sessionCount").asLong()
                && manifest.path("activation").isBoolean() && !manifest.path("activation").asBoolean(), "manifest_identity_conflict");
        for (String name : List.of("sessions", "assets")) {
            JsonNode index = manifest.path(name);
            check(index.isObject() && index.size() == 4 && (".w1-recovery/" + name + ".ndjson").equals(index.path("path").asText())
                    && index.path("count").isIntegralNumber() && index.path("count").canConvertToLong()
                    && index.path("count").asLong() >= 0 && index.path("byteLength").isIntegralNumber()
                    && index.path("byteLength").canConvertToLong() && index.path("byteLength").asLong() >= 0
                    && index.path("digest").asText().matches("[0-9a-f]{64}"), "invalid_manifest_index");
        }
        check(manifest.path("sessions").path("count").asLong() == ((Number) operation.get("session_count")).longValue(),
                "invalid_manifest_index");
        check(manifest.path("assets").path("count").asLong() == workCount(assetOperation(), "RESOURCE", "1 = 1"), "invalid_manifest_index");
    }

    private SourceCut scanSources(boolean save) {
        MessageDigest digest = digest();
        String after = "";
        long count = 0;
        while (true) {
            List<String> ids = jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ?"
                    + " AND workspace_storage_id = ? AND session_id > ? ORDER BY session_id LIMIT ?",
                    String.class, tenant, storage, after, PAGE);
            if (ids.isEmpty()) {
                break;
            }
            for (String session : ids) {
                JsonNode source = currentSource(session);
                String bytes = source.toString();
                digest.update(bytes.getBytes(StandardCharsets.UTF_8));
                digest.update((byte) '\n');
                if (save) {
                    operations.insertWork(KIND, id, "SESSION", hash(session), session, session,
                            WorkspaceOperations.values("source_digest", hash(bytes), "source_json", bytes), "PENDING");
                }
                count++;
            }
            after = ids.getLast();
        }
        return new SourceCut(HexFormat.of().formatHex(digest.digest()), count);
    }

    public void assertCompatible() {
        recheckBoundary();
        var row = ownedOperation();
        lockSources = true;
        try {
            SourceCut cut = scanSources(false);
            check(cut.digest().equals(row.get("source_digest"))
                    && cut.count() == ((Number) row.get("session_count")).longValue(), "source_drift");
        } finally {
            lockSources = false;
        }
    }

    private JsonNode currentSource(String session) {
        return currentSource(jdbc, tenant, storage, session, lockSources);
    }

    static JsonNode currentSource(JdbcTemplate jdbc, String tenant, String storage, String session, boolean lockSources) {
        var rows = WorkspaceOperations.rows(jdbc, "SELECT " + ManagedSchemaProjection.SESSION.columns("s") + ", e.last_sequence FROM ma_session s JOIN ma_event_stream e"
                + " ON e.tenant_id = s.tenant_id AND e.session_id = s.session_id AND e.stream_kind = 'SESSION' AND e.stream_id = ?"
                + " WHERE s.tenant_id = ? AND s.session_id = ? AND s.workspace_storage_id = ?" + (lockSources ? " FOR UPDATE" : ""), new byte[0], tenant, session, storage);
        check(rows.size() == 1, "source_drift");
        Map<String, Object> row = rows.getFirst();
        check(("qwen-code".equals(row.get("agent_id")) || row.get("agent_definition_digest") != null)
                && Set.of("ACTIVE", "CLOSED", "ARCHIVED", "DELETED")
                .contains(row.get("status")), "source_drift");
        var receipts = WorkspaceOperations.rows(jdbc, "SELECT actor_id, idempotency_key, request_digest, turn_id, gmt_create"
                + " FROM ma_request_receipt WHERE tenant_key = ? AND session_id = ? AND namespace = 'SESSION_CREATE_ACTOR' AND tenant_id = ?",
                WorkspaceOperations.hash(tenant), session, tenant);
        check(receipts.size() == 1, "source_drift");
        check(count(jdbc, "SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                + " AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING')", tenant, session) == 0, "source_drift");
        check(count(jdbc, "SELECT COUNT(*) FROM ma_operation WHERE session_scope_key = ?"
                + " AND operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'ACTION_RESPONSE', 'CWD_CHANGE', 'TASK_CANCEL')"
                + " AND state NOT IN ('COMPLETED', 'FAILED')", ManagedSessionStore.sessionScopeKey(tenant, session)) == 0, "source_drift");
        ObjectNode source = JSON.createObjectNode().put("sessionId", session);
        ObjectNode binding = source.putObject("binding").put("tenantId", tenant);
        fields(binding, row, "workspaceId", "workspace_id", "workspaceGeneration", "workspace_generation",
                "storageId", "workspace_storage_id", "cwdRelative", "cwd_relative", "contextConfigRef", "context_config_ref",
                "contextRevision", "context_revision");
        binding.put("workspaceGeneration", Objects.toString(row.get("workspace_generation"), null));
        binding.put("contextRevision", Objects.toString(row.get("context_revision"), null));
        for (String key : List.of("workspaceId", "storageId", "cwdRelative", "contextConfigRef")) {
            text(binding, key);
        }
        check(binding.path("workspaceGeneration").asLong() > 0 && binding.path("contextRevision").asLong() > 0, "source_drift");
        fields(source, row, "configRef", "workspace_config_ref", "policyRef", "workspace_policy_ref", "approvalMode", "approval_mode",
                "selectedApprovalMode", "selected_approval_mode", "approvalRevision", "approval_revision");
        // The pinned definition identity (D8c-1); null for qwen-code.
        fields(source, row, "agentRevision", "agent_revision",
                "agentDefinitionDigest", "agent_definition_digest");
        ObjectNode product = source.putObject("publicSession");
        fields(product, row, "version", "version", "status", "status", "lastSequence", "last_sequence",
                "harnessBootId", "harness_boot_id", "harnessEventEpoch", "harness_event_epoch",
                "harnessLastEventId", "harness_last_event_id", "deletedAt", "deleted_at");
        Map<String, Object> receipt = receipts.getFirst();
        ObjectNode creation = source.putObject("creation")
                .put("actorIdHex", HexFormat.of().formatHex((byte[]) receipt.get("actor_id")));
        fields(creation, receipt, "idempotencyKey", "idempotency_key", "requestDigest", "request_digest",
                "turnId", "turn_id", "createdAt", "gmt_create");
        // Missing keys gap-lock other tenants; the retention authority lock prevents new writers here.
        boolean lockHead = lockSources && count(jdbc,
                "SELECT COUNT(*) FROM ma_session_head WHERE tenant_key = ? AND harness_key = ?",
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.harnessDrainKey(session)) != 0;
        var heads = jdbc.query("SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND head_kind = 'MANAGED_SESSION'"
                + (lockHead ? " FOR UPDATE" : ""),
                (result, index) -> {
                    var value = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.read(result);
                    value.put("writer_lease_until", ManagedSchemaTime.timestamp(result, "writer_lease_until"));
                    Timestamp lease = ManagedSchemaTime.timestamp(result, "writer_lease_until");
                    value.put("writer_lease_fingerprint", lease == null ? null
                            : LocalDateTime.ofInstant(lease.toInstant(), java.time.ZoneOffset.UTC).toString());
                    return value;
                }, com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.harnessDrainKey(session));
        check(heads.size() <= 1, "source_drift");
        if (heads.isEmpty()) {
            source.putNull("head");
        } else {
            Map<String, Object> head = heads.getFirst();
            check(tenant.equals(head.get("tenant_id")) && session.equals(head.get("session_id")), "source_drift");
            Timestamp lease = (Timestamp) head.get("writer_lease_until");
            check(!"ACTIVE".equals(head.get("state")) || lease != null && !lease.after(now(jdbc)), "source_drift");
            check(Set.of("ACTIVE", "SEALED", "DELETED").contains(head.get("state"))
                    && List.of(1, 2).contains(((Number) head.get("storage_version")).intValue())
                    && ((Number) head.get("compacted_through_revision")).longValue() >= 0
                    && ((Number) head.get("compacted_through_revision")).longValue() <= ((Number) head.get("journal_revision")).longValue()
                    && "READY".equals(head.get("recovery_status")), "source_drift");
            ObjectNode value = source.putObject("head");
            fields(value, head, "tenantId", "tenant_id", "workspaceId", "workspace_id", "sessionId", "session_id",
                    "state", "state", "storageVersion", "storage_version", "writerId", "writer_id",
                    "writerGeneration", "writer_generation", "writerLeaseUntil", "writer_lease_fingerprint",
                    "journalRevision", "journal_revision", "committedSequence", "committed_sequence",
                    "lastCommitDigest", "last_commit_digest", "activationEpoch", "activation_epoch",
                    "latestCheckpointResourceId", "latest_checkpoint_resource_id", "compactedThroughRevision", "compacted_through_revision",
                    "recoveryStatus", "recovery_status", "recoveryDetailCode", "recovery_detail_code");
        }
        String privateScope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String currentRead = lockSources ? " FOR UPDATE" : "";
        check(jdbc.queryForList("SELECT r.resource_key FROM ma_resource r JOIN ma_resource_ref f"
                + " ON f.resource_key = r.resource_key AND f.session_scope_key = r.session_scope_key"
                + " WHERE r.session_scope_key = ? AND r.state = 'REFERENCED' AND r.deletion_operation_key IS NOT NULL"
                + " AND f.owner_kind IN ('JOURNAL','SESSION_RECORD') LIMIT 1" + currentRead, String.class, privateScope).isEmpty(), "source_drift");
        var captureScopes = new java.util.LinkedHashSet<String>();
        captureScopes.add(ToolPublicationDataStore.scope(tenant, (String) row.get("workspace_id"), session));
        if (!heads.isEmpty()) {
            captureScopes.add(ToolPublicationDataStore.scope(tenant, (String) heads.getFirst().get("workspace_id"), session));
        }
        for (String captureScope : captureScopes) {
            check(jdbc.queryForList("SELECT publication_id FROM ma_output_capture WHERE scope_key = ?"
                    + " AND retention_state = 'DELETING' LIMIT 1" + currentRead, String.class, captureScope).isEmpty(), "source_drift");
        }
        var retirements = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, retirement_operation_id AS operation_id,"
                + " retirement_generation AS generation, retired_at, recovery_protected FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? AND retirement_generation > 0", tenant, session);
        check(retirements.size() <= 1, "source_drift");
        source.putNull("retirement");
        if (!retirements.isEmpty()) {
            var retirement = retirements.getFirst();
            check(tenant.equals(retirement.get("tenant_id")) && session.equals(retirement.get("session_id"))
                    && "DELETED".equals(row.get("status")) && row.get("deleted_at") instanceof Number
                    && ((Number) row.get("deleted_at")).longValue() > 0
                    && ((Number) retirement.get("generation")).longValue() == 1
                    && ((Number) retirement.get("retired_at")).longValue() > 0
                    && !ToolPublicationRetentionStore.flag(retirement, "recovery_protected"), "source_drift");
            JsonNode retiredHead = source.path("head");
            check(retiredHead.isNull() || "DELETED".equals(retiredHead.path("state").asText())
                    && retiredHead.path("latestCheckpointResourceId").isNull()
                    && retiredHead.path("writerId").isNull() && retiredHead.path("writerLeaseUntil").isNull(), "source_drift");
            check(count(jdbc, "SELECT COUNT(*) FROM ma_operation WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                    + " AND operation_id = ? AND operation_kind = 'DELETE' AND state = 'COMPLETED'"
                    + " AND delivery_state = 'CONFIRMED' AND completed_at IS NOT NULL",
                    privateScope, tenant, session, retirement.get("operation_id")) == 1, "source_drift");
            ObjectNode value = source.putObject("retirement");
            fields(value, retirement, "tenantId", "tenant_id", "sessionId", "session_id", "operationId", "operation_id",
                    "generation", "generation", "retiredAt", "retired_at");
            value.put("recoveryProtected", false);
        }
        if (!heads.isEmpty()) {
            var head = heads.getFirst();
            long compacted = ((Number) head.get("compacted_through_revision")).longValue();
            long revision = ((Number) head.get("journal_revision")).longValue();
            if (compacted > 0 || revision == 0 && "DELETED".equals(head.get("state"))) {
                check(!retirements.isEmpty() && "DELETED".equals(head.get("state")) && compacted == revision, "source_drift");
                var completedGc = jdbc.queryForList("SELECT operation_id FROM ma_operation WHERE session_scope_key = ?"
                        + " AND scope_key = ? AND target_key = ? AND operation_kind = 'SESSION_RESOURCE_GC' AND state = 'SUCCEEDED'"
                        + " AND operation_id = ? LIMIT 1" + currentRead, String.class,
                        privateScope, privateScope, privateScope, "session-resources-" + privateScope);
                check(completedGc.size() == 1, "source_drift");
                source.set("retiredHead", source.path("head").deepCopy());
                source.putNull("head");
            }
        }
        return source;
    }

    private JsonNode pinned(String session) {
        var row = operations.findWork(KIND, id, "SESSION", hash(session), false);
        check(row != null && session.equals(row.get("session_id")), "session_out_of_scope");
        return parse((String) row.get("source_json"));
    }

    private void recheckSession(String session) {
        JsonNode saved = pinned(session);
        if ("capture".equals(mode)) {
            recheckBoundary();
            check(saved.toString().equals(currentSource(session).toString()), "source_drift");
        }
    }

    private JsonNode currentRegistration() {
        var saved = guard.recoveryRegistration(tenant, storage, request.path("mountRevision").asLong(),
                text(request, "fenceOperationId"));
        check(text(request, "sourceRoot").equals(saved.root()), "source_drift");
        return parse(JSON.valueToTree(saved).toString());
    }

    private void recheckBoundary() {
        try {
            check(currentRegistration().equals(parse((String) ownedOperation().get("registration_json"))), "source_drift");
        } catch (RuntimeBrokerException error) {
            throw failure("source_drift");
        }
    }

    private void requireCapture() {
        check("capture".equals(mode), "source_read_not_allowed");
        mutable();
    }

    private void mutable() {
        check(("capture".equals(mode) ? "CAPTURING" : "VERIFYING").equals(ownedOperation().get("state")), "operation_not_writable");
    }

    private String assetOperation() {
        return "verify".equals(mode) ? text(request, "captureOperationId") : id;
    }

    private JsonNode work(String operation, String kind, String key) {
        var row = operations.findWork(KIND, operation, workKind(kind), workTarget(kind, key), false);
        if (row == null) {
            return null;
        }
        check(key.equals(row.get("work_key")), "work_key_conflict");
        return parse((String) row.get("metadata_json"));
    }

    private void insertWork(String kind, String key, String session, JsonNode metadata, String state) {
        check(key.length() <= 640, "invalid_work_key");
        operations.insertWork(KIND, id, workKind(kind), workTarget(kind, key), key, session,
                WorkspaceOperations.values("metadata_json", metadata.toString()), state);
    }

    private static String workKind(String kind) {
        return switch (kind) {
            case "ASSET" -> "RESOURCE";
            case "REF" -> "RECOVERY_EVIDENCE";
            default -> throw failure("invalid_work_kind");
        };
    }

    private static String workTarget(String kind, String key) {
        return "ASSET".equals(kind) ? key : hash(key);
    }

    private long workCount(String operation, String kind, String condition) {
        return count("SELECT COUNT(*) FROM ma_operation_work WHERE operation_key = ? AND work_kind = ? AND " + condition,
                operations.key(KIND, operation), kind);
    }

    private List<Map<String, Object>> sessionRows(String operation, String after, int limit) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION_WORK.columns() + " FROM ma_operation_work WHERE operation_key = ? AND work_kind = 'SESSION'"
                + " AND session_id > ? ORDER BY session_id LIMIT ?", (row, index) -> WorkspaceOperations.work(row),
                operations.key(KIND, operation), after, limit);
    }

    private Map<String, Object> ownedOperation() {
        var row = operation(id);
        check(row != null && tenant.equals(row.get("tenant_id")) && storage.equals(row.get("storage_id")), "operation_not_found");
        return row;
    }

    private Map<String, Object> operation(String operation) {
        return operations.find(KIND, operation, lockSources);
    }

    private long count(String sql, Object... args) {
        return count(jdbc, sql, args);
    }

    private static long count(JdbcTemplate jdbc, String sql, Object... args) {
        return Objects.requireNonNull(jdbc.queryForObject(sql, Long.class, args));
    }

    private Timestamp now() {
        return now(jdbc);
    }

    private static Timestamp now(JdbcTemplate jdbc) {
        return Objects.requireNonNull(jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW + "", Timestamp.class));
    }

    private static void fields(ObjectNode target, Map<String, Object> row, String... mapping) {
        for (int i = 0; i < mapping.length; i += 2) {
            Object value = row.get(mapping[i + 1]);
            target.set(mapping[i], JSON.valueToTree(value instanceof Timestamp time ? time.getTime() : value));
        }
    }

    static JsonNode parse(String text) {
        return parse(text.getBytes(StandardCharsets.UTF_8));
    }

    static JsonNode parse(byte[] bytes) {
        check(bytes.length <= 16 * 1024 * 1024, "message_too_large");
        return ToolPublicationContract.readJson(bytes);
    }

    static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        check(value.isTextual() && !value.asText().isEmpty() && value.asText().length() <= 8192, "invalid_request");
        return value.asText();
    }

    static long positive(JsonNode node, String field) {
        JsonNode value = node.path(field);
        check(value.isIntegralNumber() && value.canConvertToLong() && value.asLong() > 0
                && value.asLong() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER, "invalid_request");
        return value.asLong();
    }

    static String uuid(JsonNode node, String field) {
        String value = text(node, field);
        try {
            check(UUID.fromString(value).toString().equals(value), "invalid_request");
        } catch (IllegalArgumentException error) {
            throw failure("invalid_request");
        }
        return value;
    }

    static String hash(String value) {
        return hash(value.getBytes(StandardCharsets.UTF_8));
    }

    static String hash(byte[] bytes) {
        return HexFormat.of().formatHex(digest().digest(bytes));
    }

    private static MessageDigest digest() {
        try {
            return DigestUtils.getSha256Digest();
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException(error);
        }
    }

    static void check(boolean condition, String code) {
        if (!condition) {
            throw failure(code);
        }
    }

    // The deepest cause is not the verdict: a structural refusal keeps its
    // service code even when the discarded I/O cause sits deeper in the chain.
    public static String errorCode(Throwable error) {
        for (Throwable current = error; current != null && current != current.getCause();
                current = current.getCause()) {
            if (current instanceof RecoveryFailure failure) {
                return failure.code;
            }
            if (current instanceof RuntimeBrokerException failure) {
                return failure.getCode();
            }
        }
        return "migration_failed";
    }

    static RecoveryFailure failure(String code) {
        return new RecoveryFailure(code);
    }

    static final class RecoveryFailure extends IllegalStateException {
        final String code;
        RecoveryFailure(String code) {
            super("Workspace recovery: " + code);
            this.code = code;
        }
    }

    private record SourceCut(String digest, long count) {
    }
}
