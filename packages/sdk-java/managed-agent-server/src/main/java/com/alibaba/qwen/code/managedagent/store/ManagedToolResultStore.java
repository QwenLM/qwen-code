package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

@Repository
public class ManagedToolResultStore {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final AgentStateStore sessions;

    public ManagedToolResultStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            AgentStateStore sessions) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.sessions = sessions;
    }

    public record Source(String id, String tenantId, String workspaceId, String sessionId,
            String executionCallId, long journalRevision, long receiptSequence,
            JsonNode outcomeRef, JsonNode resultRef, JsonNode resources, String sourceDigest) {
        public JsonNode sessionKey() {
            return JSON.createObjectNode().put("tenantId", tenantId).put("workspaceId", workspaceId)
                    .put("sessionId", sessionId);
        }
    }

    public record Claim(Source source, long generation) { }

    public record Artifact(JsonNode descriptor, Source source, String publicationId,
            JsonNode binding, JsonNode manifestRef, String streamId, long creationSequence) { }

    public record ArtifactPage(List<Artifact> artifacts, long watermark, boolean hasMore) { }

    public record Projection(JsonNode descriptor, String publicationId, JsonNode binding,
            JsonNode manifestRef, List<Artifact> artifacts, String policyVersion) { }

    // The caller holds the journal transaction. This hook performs no object I/O.
    void capture(String tenant, String workspace, String session, long revision, long firstSequence,
            int eventCount, byte[] records) {
        List<JsonNode> events = new ArrayList<>();
        int index = -1;
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            index++;
            JsonNode record = ToolPublicationContract.readJson(line.getBytes(StandardCharsets.UTF_8));
            JsonNode event = record.path("managedSession");
            if ("managed_session_event_v1".equals(record.path("subtype").asText())
                    && "tool.receipt".equals(event.path("kind").asText())) {
                require(
                        index < eventCount
                                && event.path("sequence").asLong(-1) == firstSequence + index,
                        "Tool receipt has an invalid journal position");
                events.add(event);
            }
        }
        captureEvents(tenant, workspace, session, revision, events);
    }

    void captureEvents(String tenant, String workspace, String session, long revision, List<JsonNode> events) {
        Map<String, Source> sources = new LinkedHashMap<>();
        for (JsonNode event : events) {
            Source source = source(tenant, workspace, session, revision, event);
            Source prior = sources.putIfAbsent(source.id(), source);
            require(
                    prior == null || prior.sourceDigest().equals(source.sourceDigest()),
                    "Tool receipt source changed");
        }
        if (sources.isEmpty()) {
            return;
        }
        if (ManagedLegacySessionGuard.isPrivate(jdbc, tenant, session)) {
            return;
        }
        var existing = jdbc.query("SELECT operation_id, request_digest FROM ma_operation"
                + " WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id IN (" + String.join(",", Collections.nCopies(sources.size(), "?")) + ")", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                sources.keySet().toArray());
        for (var row : existing) {
            Source source = sources.remove((String) row.get("operation_id"));
            require(
                    source.sourceDigest().equals(row.get("request_digest")),
                    "Tool receipt source changed");
        }
        if (!sources.isEmpty()) {
            long createdAt = now();
            String sourceScope = scope(tenant, session);
            List<Object[]> rows = new ArrayList<>();
            for (Source source : sources.values()) {
                String executionKey =
                        identity(
                                        "execution",
                                        source.executionCallId().isEmpty()
                                                ? "sequence:" + source.receiptSequence()
                                                : source.executionCallId())
                                .substring(10);
                rows.add(new Object[] {
                        ManagedSchemaKeys.operationKey(OperationKind.TOOL_RESULT_PROJECTION, sourceScope,
                                executionKey, source.id()), sourceScope, sourceScope, ManagedSchemaKeys.identity(source.id()),
                        ManagedSchemaKeys.identity(tenant), ManagedSchemaKeys.identity(workspace), ManagedSchemaKeys.identity(session),
                        executionKey, executionKey, JSON.valueToTree(source).toString(), source.sourceDigest(),
                        createdAt, createdAt});
            }
            jdbc.batchUpdate(
                    "INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id, tenant_id, workspace_id, session_id, target_kind, target_key, execution_key, request_json, request_digest, phase, state, gmt_create, gmt_modified) VALUES (?, ?, ?, 'TOOL_RESULT_PROJECTION', ?, ?, ?, ?, 'TOOL_EXECUTION', ?, ?, ?, ?, 'PROJECTING', 'PENDING', ?, ?)", rows);
        }
    }

    public void backfillOnePage() {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Backfill owns its scheduler transactions");
        }
        for (int index = 0; index < 50; index++) {
            if (!backfillOneTransaction()) {
                return;
            }
        }
    }

    private boolean backfillOneTransaction() {
        var selected = new ArrayList<Map<String, Object>>(1);
        try {
            return Boolean.TRUE.equals(transactions.execute(status -> {
                var heads = jdbc.query("SELECT h.tenant_id, h.workspace_id, h.session_id, h.journal_revision,"
                        + " o3_backfill_revision, o3_backfill_through FROM ma_session_head h"
                        + " WHERE head_kind = 'MANAGED_SESSION' AND state NOT IN ('DELETING', 'DELETED') AND o3_backfill_pending = TRUE AND o3_backfill_error IS NULL"
                        + " AND NOT EXISTS (SELECT 1 FROM ma_session s WHERE s.tenant_id = h.tenant_id AND s.session_id = h.session_id AND s.csi_guard = TRUE) ORDER BY tenant_key, harness_key LIMIT 1", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow));
                if (heads.isEmpty()) {
                    return false;
                }
                var candidate = heads.getFirst();
                String tenant = (String) candidate.get("tenant_id");
                String workspace = (String) candidate.get("workspace_id");
                String session = (String) candidate.get("session_id");
                ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
                if (ManagedLegacySessionGuard.isPrivate(jdbc, tenant, session)) {
                    return false;
                }
                var head = lockBackfillHead(tenant, workspace, session);
                if (head == null) {
                    return false;
                }
                selected.add(head);
                long after = ((Number) head.get("o3_backfill_revision")).longValue();
                long through = ((Number) (head.get("o3_backfill_through") == null
                        ? head.get("journal_revision") : head.get("o3_backfill_through"))).longValue();
                var rows = jdbc.query("SELECT journal_revision, first_sequence, event_count, record_bytes, record_digest FROM"
                        + " ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND workspace_id = ? AND journal_revision > ? AND journal_revision <= ?"
                        + " ORDER BY journal_revision LIMIT 1", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), tenant, session, workspace, after, through);
                if (!rows.isEmpty()) {
                    var row = rows.getFirst();
                    byte[] bytes = (byte[]) row.get("record_bytes");
                    require(ToolPublicationContract.sha256(bytes).equals(row.get("record_digest")),
                            "Backfill journal digest changed");
                    after = ((Number) row.get("journal_revision")).longValue();
                    capture(tenant, workspace, session, after, ((Number) row.get("first_sequence")).longValue(),
                            ((Number) row.get("event_count")).intValue(), bytes);
                } else {
                    require(after == through, "Backfill journal is incomplete");
                }
                jdbc.update("UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", o3_backfill_revision = ?,"
                                + " o3_backfill_through = ?, o3_backfill_pending = ? WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                        after, through, after < through, ManagedSchemaKeys.key(tenant), ManagedSchemaKeys.key(session), tenant, session);
                return true;
            }));
        } catch (IllegalArgumentException error) {
            if (!selected.isEmpty()) {
                var failed = selected.getFirst();
                transactions.executeWithoutResult(status -> {
                    String tenant = (String) failed.get("tenant_id");
                    String workspace = (String) failed.get("workspace_id");
                    String session = (String) failed.get("session_id");
                    ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
                    if (ManagedLegacySessionGuard.isPrivate(jdbc, tenant, session)) {
                        return;
                    }
                    var current = lockBackfillHead(tenant, workspace, session);
                    if (failed.equals(current)) {
                        jdbc.update("UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", o3_backfill_error = 'invalid_journal',"
                                + " o3_backfill_pending = FALSE WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?", ManagedSchemaKeys.key(tenant), ManagedSchemaKeys.key(session), tenant, session);
                    }
                });
            }
            throw error;
        }
    }

    private Map<String, Object> lockBackfillHead(String tenant, String workspace, String session) {
        ToolPublicationRetentionStore.lockSession(jdbc, tenant, session);
        var rows = jdbc.query("SELECT tenant_id, workspace_id, session_id, journal_revision,"
                + " o3_backfill_revision, o3_backfill_through FROM ma_session_head"
                + " WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND workspace_id = ? AND session_id = ?"
                + " AND state NOT IN ('DELETING', 'DELETED') AND o3_backfill_pending = TRUE"
                + " AND o3_backfill_error IS NULL FOR UPDATE", (result, index) -> ManagedSchemaRows.read(result),
                ManagedSchemaKeys.key(tenant), ManagedSchemaKeys.key(session), tenant, workspace, session);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public Optional<Claim> claim() {
        return Optional.ofNullable(transactions.execute(status -> {
            long now = now();
            List<Map<String, Object>> rows = new ArrayList<>();
            for (String state : List.of("PENDING", "RETRYABLE", "LEASED")) {
                String due = "LEASED".equals(state) ? "claim_until" : "available_at";
                String epoch = "r." + due;
                rows.addAll(jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns("r") + ", " + epoch + " AS due_at FROM ma_operation r"
                        + " WHERE r.operation_kind = 'TOOL_RESULT_PROJECTION' AND r.state = ? AND r." + due + " <= ?"
                        + " AND NOT EXISTS (SELECT 1 FROM ma_session s WHERE s.tenant_id = r.tenant_id"
                        + " AND s.session_id = r.session_id AND s.csi_guard = TRUE)"
                        + " ORDER BY r." + due + ", r.operation_key LIMIT 1",
                        (result, index) -> ManagedSchemaRows.read(result), state, now));
            }
            rows.sort(java.util.Comparator.<Map<String, Object>>comparingLong(
                    row -> ((Number) row.get("due_at")).longValue())
                    .thenComparing(row -> (String) row.get("operation_key")));
            for (var candidate : rows) {
                String tenant = (String) candidate.get("tenant_id");
                ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
                if (isPrivateResult(candidate)) {
                    status.setRollbackOnly();
                    return null;
                }
                ToolPublicationRetentionStore.lockSession(jdbc, tenant, (String) candidate.get("session_id"));
                var row = lockResultRow((String) candidate.get("operation_id"));
                if (row == null) {
                    continue;
                }
                requireSameSource(candidate, row);
                String state = (String) row.get("state");
                String due = "LEASED".equals(state) ? "claim_until_epoch" : "available_at";
                if (!List.of("PENDING", "RETRYABLE", "LEASED").contains(state)
                        || row.get(due) == null || ((Number) row.get(due)).longValue() > now) {
                    continue;
                }
                Source source = storedSource(row);
                long generation = Math.addExact(((Number) row.get("claim_generation")).longValue(), 1);
                jdbc.update("UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = 'LEASED', claim_generation = ?,"
                                + " claim_until = ?, attempt_count = attempt_count + 1"
                                + " WHERE operation_key = ? AND operation_kind = 'TOOL_RESULT_PROJECTION'",
                        generation, Math.addExact(now, 60_000), row.get("operation_key"));
                return new Claim(source, generation);
            }
            return null;
        }));
    }

    public void fail(Claim claim, String state, String code) {
        require(List.of("RETRYABLE", "QUARANTINED", "UNSUPPORTED", "SUPPRESSED").contains(state),
                "Invalid projection failure state");
        transactions.executeWithoutResult(status -> {
            var candidate = resultRow(claim.source().id());
            if (candidate == null) {
                return;
            }
            ToolPublicationRetentionStore.lockTenant(jdbc, (String) candidate.get("tenant_id"));
            if (isPrivateResult(candidate)) {
                status.setRollbackOnly();
                return;
            }
            ToolPublicationRetentionStore.lockSession(jdbc, (String) candidate.get("tenant_id"),
                    (String) candidate.get("session_id"));
            var row = lockResultRow(claim.source().id());
            if (row != null) {
                requireSameSource(candidate, row);
                settleFailure(claimSource(claim, row), claim.generation(), state, code);
            }
        });
    }

    private void settleFailure(Source source, long generation, String state, String code) {
        jdbc.update("UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = ?, failure_code = ?,"
                        + " claim_until = NULL, available_at = CAST(? AS DECIMAL(20, 0))"
                        + " + LEAST(300000, attempt_count * 5000) WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ?"
                        + " AND tenant_id = ? AND workspace_id = ? AND session_id = ? AND request_digest = ?"
                        + " AND state = 'LEASED' AND claim_generation = ?",
                state, code, now(), source.id(), source.tenantId(), source.workspaceId(), source.sessionId(),
                source.sourceDigest(), generation);
    }

    boolean admitsLegacyProjection(Claim claim) {
        return Boolean.TRUE.equals(transactions.execute(status -> {
            var candidate = resultRow(claim.source().id());
            if (candidate == null) {
                return false;
            }
            ToolPublicationRetentionStore.lockTenant(jdbc, (String) candidate.get("tenant_id"));
            if (isPrivateResult(candidate)) {
                status.setRollbackOnly();
                return false;
            }
            ToolPublicationRetentionStore.lockSession(jdbc, (String) candidate.get("tenant_id"),
                    (String) candidate.get("session_id"));
            var row = lockResultRow(claim.source().id());
            if (row == null) {
                return false;
            }
            requireSameSource(candidate, row);
            claimSource(claim, row);
            return "LEASED".equals(row.get("state"))
                    && ((Number) row.get("claim_generation")).longValue() == claim.generation();
        }));
    }

    private Map<String, Object> resultRow(String id) {
        var rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ?", (result, index) -> ManagedSchemaRows.read(result), id);
        require(rows.size() <= 1, "Projection identity is ambiguous");
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private Map<String, Object> lockResultRow(String id) {
        var rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ? FOR UPDATE", (result, index) -> ManagedSchemaRows.read(result), id);
        require(rows.size() <= 1, "Projection identity is ambiguous");
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private boolean isPrivateResult(Map<String, Object> row) {
        return ManagedLegacySessionGuard.isPrivate(jdbc, (String) row.get("tenant_id"), (String) row.get("session_id"));
    }

    private static void requireSameSource(Map<String, Object> before, Map<String, Object> current) {
        for (String column : List.of("tenant_id", "workspace_id", "session_id", "scope_key", "request_digest", "request_json")) {
            require(Objects.equals(before.get(column), current.get(column)), "Projection source changed");
        }
    }

    private static Source storedSource(Map<String, Object> row) {
        Source source = readSource((String) row.get("request_json"));
        require(Objects.equals(source.id(), row.get("operation_id"))
                        && Objects.equals(source.tenantId(), row.get("tenant_id"))
                        && Objects.equals(source.workspaceId(), row.get("workspace_id"))
                        && Objects.equals(source.sessionId(), row.get("session_id"))
                        && Objects.equals(source.sourceDigest(), row.get("request_digest"))
                        && scope(source.tenantId(), source.sessionId()).equals(row.get("scope_key")),
                "Stored projection source conflicts");
        return source;
    }

    private static Source claimSource(Claim claim, Map<String, Object> row) {
        Source source = storedSource(row);
        require(source.equals(claim.source()), "Claimed projection source conflicts");
        return source;
    }

    public void verifySource(Source source) {
        var rows =
                jdbc.query(
                        "SELECT record_bytes, record_digest FROM ma_session_journal_tx WHERE"
                                + " tenant_id = ? AND workspace_id = ? AND session_id = ? AND"
                                + " journal_revision = ?",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        source.tenantId(),
                        source.workspaceId(),
                        source.sessionId(),
                        source.journalRevision());
        require(rows.size() == 1, "Original receipt journal is missing");
        byte[] bytes = (byte[]) rows.getFirst().get("record_bytes");
        require(ToolPublicationContract.sha256(bytes).equals(rows.getFirst().get("record_digest")),
                "Original receipt journal changed");
        int matches = 0;
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = ToolPublicationContract.readJson(line.getBytes(StandardCharsets.UTF_8));
            JsonNode event = record.path("managedSession");
            if ("managed_session_event_v1".equals(record.path("subtype").asText())
                    && "tool.receipt".equals(event.path("kind").asText())
                    && event.path("sequence").asLong(-1) == source.receiptSequence()) {
                Source original = source(source.tenantId(), source.workspaceId(), source.sessionId(),
                        source.journalRevision(), event);
                require(
                        original.sourceDigest().equals(source.sourceDigest()),
                        "Original receipt source changed");
                matches++;
            }
        }
        require(matches == 1, "Original receipt is missing or ambiguous");
    }

    public boolean complete(Claim claim, Projection projection, String currentPolicyVersion) {
        return Boolean.TRUE.equals(transactions.execute(status -> {
            var candidate = resultRow(claim.source().id());
            if (candidate == null || !"LEASED".equals(candidate.get("state"))
                    || ((Number) candidate.get("claim_generation")).longValue() != claim.generation()) {
                return false;
            }
            ToolPublicationRetentionStore.lockTenant(jdbc, (String) candidate.get("tenant_id"));
            if (isPrivateResult(candidate)) {
                status.setRollbackOnly();
                return false;
            }
            Source source = claimSource(claim, candidate);
            ToolPublicationRetentionStore.lockSession(jdbc, source.tenantId(), source.sessionId());
            var retired = jdbc.query("SELECT retirement_generation FROM ma_session"
                    + " WHERE tenant_key = ? AND session_key = ? AND retired_at IS NOT NULL",
                    (result, index) -> ManagedSchemaRows.read(result),
                    ToolPublicationRetentionStore.hash(source.tenantId()), ToolPublicationRetentionStore.hash(source.sessionId()));
            jdbc.query("SELECT publication_id FROM ma_output_capture WHERE scope_key = ? AND tenant_id = ?"
                    + " AND session_id = ? AND publication_id = ? FOR UPDATE", (result, index) -> ManagedSchemaRows.read(result),
                    ToolPublicationDataStore.scope(source.sessionKey()), source.tenantId(), source.sessionId(), projection.publicationId());
            var publicSessions = jdbc.query("SELECT s.tenant_id, s.session_id, s.workspace_id, s.status, e.last_sequence FROM"
                            + " ma_session s JOIN ma_event_stream e ON e.tenant_id = s.tenant_id AND e.session_id = s.session_id"
                            + " AND e.stream_kind = 'SESSION' AND e.stream_id = X''"
                            + " WHERE s.tenant_id = ? AND s.session_id = ? FOR UPDATE", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                    source.tenantId(), source.sessionId());
            var row = lockResultRow(source.id());
            if (row == null) {
                return false;
            }
            requireSameSource(candidate, row);
            source = claimSource(claim, row);
            if (!"LEASED".equals(row.get("state"))
                    || ((Number) row.get("claim_generation")).longValue() != claim.generation()) {
                return false;
            }
            if (!retired.isEmpty()) {
                settleFailure(source, claim.generation(), "SUPPRESSED", "session_retired");
                return false;
            }
            if (((Number) row.get("claim_until_epoch")).longValue() <= now()) {
                settleFailure(source, claim.generation(), "RETRYABLE", "projection_claim_lapsed");
                return false;
            }
            if (publicSessions.isEmpty() || !source.tenantId().equals(publicSessions.getFirst().get("tenant_id"))
                    || !source.sessionId().equals(publicSessions.getFirst().get("session_id"))
                    || !source.workspaceId().equals(publicSessions.getFirst().get("workspace_id"))
                    || List.of("DELETING", "DELETED").contains(publicSessions.getFirst().get("status"))) {
                settleFailure(source, claim.generation(), "SUPPRESSED", "session_unavailable");
                return false;
            }
            if (!projection.policyVersion().equals(currentPolicyVersion)) {
                settleFailure(source, claim.generation(), "RETRYABLE", "publication_policy_changed");
                return false;
            }
            verifyCatalog(source, projection);
            long sequence = ((Number) publicSessions.getFirst().get("last_sequence")).longValue() + 1;
            for (Artifact artifact : projection.artifacts()) {
                jdbc.update("INSERT INTO ma_artifact (artifact_id, result_id, scope_key, descriptor_json,"
                                + " publication_id, binding_json, manifest_ref_json, stream_id, creation_sequence)"
                                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", artifact.descriptor().path("id").asText(),
                        source.id(), scope(source.tenantId(), source.sessionId()), artifact.descriptor().toString(),
                        artifact.publicationId(), artifact.binding().toString(), artifact.manifestRef().toString(),
                        artifact.streamId(), sequence);
                String sessionScope = scope(source.tenantId(), source.sessionId());
                jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision,"
                                + " resource_key, tenant_id, workspace_id, session_id, resource_id, gmt_create)"
                                + " SELECT session_scope_key, 'ARTIFACT', ?, 1, resource_key, tenant_id, workspace_id,"
                                + " session_id, resource_id, " + ManagedSchemaTime.SQL_NOW + " FROM ma_resource"
                                + " WHERE scope_key = ? AND publication_id = ? AND capture_state = 'VERIFIED'"
                                + " AND deletion_operation_key IS NULL",
                        ManagedSchemaKeys.key(sessionScope, artifact.descriptor().path("id").asText()),
                        ToolPublicationDataStore.scope(source.sessionKey()), artifact.publicationId());
            }
            JsonNode descriptor = projection.descriptor();
            String itemId = descriptor.path("item_id").asText();
            String execution = descriptor.path("execution_status").asText();
            String itemStatus = switch (execution) {
                case "success" -> "completed";
                case "cancelled" -> "cancelled";
                default -> "failed";
            };
            sessions.appendPublicEventIfAbsent(source.tenantId(), source.sessionId(),
                    descriptor.path("turn_id").asText(), "item.tool_result.updated", Map.of(
                            "itemId", itemId, "toolCallId", projection.binding().path("modelCallId").asText(),
                            "name", "run_shell_command", "status", itemStatus,
                            "result", JSON.convertValue(descriptor, Map.class)), false, "tool-result:" + source.id() + ":1");
            jdbc.update("UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = 'READY', claim_until = NULL,"
                            + " failure_code = NULL, item_id = ?, result_json = ?, policy_version = ? WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ?",
                    itemId, descriptor.toString(), projection.policyVersion(), source.id());
            return true;
        }));
    }

    private void verifyCatalog(Source source, Projection projection) {
        var rows =
                jdbc.query(
                        "SELECT state, producer_phase, binding_digest, admission_resource_id,"
                            + " receipt_sequence, receipt_revision, CASE WHEN quarantined THEN 1"
                            + " ELSE 0 END AS quarantine_mark FROM ma_output_capture WHERE"
                            + " scope_key = ? AND tenant_id = ? AND workspace_id = ? AND session_id"
                            + " = ? AND publication_id = ? FOR UPDATE",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        ToolPublicationDataStore.scope(source.sessionKey()),
                        source.tenantId(),
                        source.workspaceId(),
                        source.sessionId(),
                        projection.publicationId());
        require(rows.size() == 1, "Original publication disappeared");
        var row = rows.getFirst();
        require(
                ToolPublicationContract.bindingDigest(projection.binding())
                        .equals(row.get("binding_digest")),
                "Original publication binding changed");
        if (projection.descriptor().path("execution_status").asText().equals("not_started")) {
            require("NOT_STARTED".equals(row.get("state")), "Original not-started proof changed");
        } else {
            require(
                    "REFERENCED".equals(row.get("producer_phase"))
                            && source.outcomeRef()
                                    .path("resourceId")
                                    .asText()
                                    .equals(row.get("admission_resource_id"))
                            && ((Number) row.get("receipt_sequence")).longValue()
                                    == source.receiptSequence()
                            && ((Number) row.get("receipt_revision")).longValue()
                                    == source.journalRevision(),
                    "Original publication receipt changed");
            if (((Number) row.get("quarantine_mark")).intValue() != 0
                    && (!projection.artifacts().isEmpty()
                            || projection.descriptor().has("preview"))) {
                throw new IllegalStateException("Publication was quarantined during projection");
            }
        }
    }

    public Optional<JsonNode> findResult(String tenant, String session, String itemId) {
        return jdbc.query(
                        "SELECT result_json FROM ma_operation WHERE operation_kind ="
                            + " 'TOOL_RESULT_PROJECTION' AND scope_key = ? AND tenant_id = ? AND"
                            + " session_id = ? AND item_id = ? AND state = 'READY'",
                (r, n) -> parse(r.getString(1)), scope(tenant, session), tenant, session, itemId).stream().findFirst();
    }

    public Optional<Artifact> findArtifact(String tenant, String session, String artifactId) {
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.ARTIFACT.columns("a") + ", r.request_json FROM ma_artifact a JOIN ma_operation r ON r.operation_kind = 'TOOL_RESULT_PROJECTION' AND r.operation_id = a.result_id WHERE a.scope_key = ? AND r.tenant_id = ? AND r.session_id = ? AND a.artifact_id = ? AND r.state = 'READY'",
                        this::artifact,
                        scope(tenant, session),
                        tenant,
                        session,
                        artifactId)
                .stream()
                .findFirst();
    }

    public ArtifactPage listArtifacts(String tenant, String session, Long watermark, Long beforeSequence,
            String beforeId, int limit) {
        require(
                limit >= 1 && limit <= 100 && (beforeSequence == null) == (beforeId == null),
                "Invalid artifact page");
        long through =
                watermark == null
                        ? jdbc.queryForObject(
                                "SELECT COALESCE(MAX(creation_sequence), 0)"
                                        + " FROM ma_artifact WHERE scope_key = ?",
                                Long.class,
                                scope(tenant, session))
                        : watermark;
        require(through >= 0, "Invalid artifact watermark");
        List<Object> args = new ArrayList<>(List.of(scope(tenant, session), tenant, session, through));
        String cursor = "";
        if (beforeSequence != null) {
            cursor =
                    " AND (a.creation_sequence < ? OR (a.creation_sequence = ? AND a.artifact_id <"
                            + " ?))";
            args.add(beforeSequence);
            args.add(beforeSequence);
            args.add(beforeId);
        }
        args.add(limit + 1);
        List<Artifact> rows =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.ARTIFACT.columns("a") + ", r.request_json FROM ma_artifact a JOIN ma_operation r ON r.operation_kind = 'TOOL_RESULT_PROJECTION' AND r.operation_id = a.result_id WHERE a.scope_key = ? AND r.tenant_id = ? AND r.session_id = ? AND a.creation_sequence <= ? AND r.state = 'READY'"
                                + cursor
                                + " ORDER BY a.creation_sequence DESC, a.artifact_id DESC LIMIT ?",
                        this::artifact,
                        args.toArray());
        return new ArtifactPage(List.copyOf(rows.subList(0, Math.min(rows.size(), limit))), through, rows.size() > limit);
    }

    private Artifact artifact(ResultSet row, int index) throws SQLException {
        return new Artifact(
                parse(row.getString("descriptor_json")),
                readSource(row.getString("request_json")),
                row.getString("publication_id"),
                parse(row.getString("binding_json")),
                parse(row.getString("manifest_ref_json")),
                row.getString("stream_id"),
                row.getLong("creation_sequence"));
    }

    public static String identity(String prefix, String... values) {
        var digest = new java.io.ByteArrayOutputStream();
        for (String value : values) {
            byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
            digest.writeBytes(ByteBuffer.allocate(4).putInt(bytes.length).array());
            digest.writeBytes(bytes);
        }
        return prefix + "_" + ToolPublicationContract.sha256(digest.toByteArray());
    }

    static String scope(String tenant, String session) {
        return identity("s", tenant, session).substring(2);
    }

    private static Source source(String tenant, String workspace, String session, long revision, JsonNode event) {
        JsonNode key = event.path("sessionKey");
        require(
                tenant.equals(key.path("tenantId").asText())
                        && workspace.equals(key.path("workspaceId").asText())
                        && session.equals(key.path("sessionId").asText())
                        && event.path("sequence").asLong(-1) > 0,
                "Receipt scope or sequence conflicts");
        JsonNode payload = event.path("payload");
        String execution = payload.path("executionCallId").asText();
        JsonNode outcome = canonical(payload.path("toolOutcomeRef"));
        JsonNode result = canonical(payload.path("resultRef"));
        JsonNode resources = canonical(payload.path("resources"));
        String identityKey =
                execution.isEmpty() ? "sequence:" + event.path("sequence").asText() : execution;
        String id = identity("result", "1", tenant, workspace, session, identityKey);
        String digest =
                identity(
                                "source",
                                tenant,
                                workspace,
                                session,
                                execution,
                                Long.toString(revision),
                                event.path("sequence").asText(),
                                outcome.toString(),
                                result.toString(),
                                resources.toString())
                        .substring(7);
        return new Source(
                id,
                tenant,
                workspace,
                session,
                execution,
                revision,
                event.path("sequence").asLong(),
                outcome,
                result,
                resources,
                digest);
    }

    private static JsonNode canonical(JsonNode value) {
        if (value.isMissingNode() || value.isNull()) {
            return JSON.nullNode();
        }
        if (value.isObject()) {
            ObjectNode result = JSON.createObjectNode();
            List<String> fields = new ArrayList<>();
            value.fieldNames().forEachRemaining(fields::add);
            fields.stream().sorted().forEach(field -> result.set(field, canonical(value.get(field))));
            return result;
        }
        if (value.isArray()) {
            var result = JSON.createArrayNode();
            value.forEach(item -> result.add(canonical(item)));
            return result;
        }
        return value.deepCopy();
    }

    private static Source readSource(String json) {
        try {
            return JSON.treeToValue(parse(json), Source.class);
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Stored tool result source is invalid", error);
        }
    }

    static JsonNode parse(String json) {
        return ToolPublicationContract.readJson(json.getBytes(StandardCharsets.UTF_8));
    }

    private long now() {
        return ToolPublicationRetentionStore.now(jdbc);
    }

    static void require(boolean valid, String message) {
        if (!valid) {
            throw new IllegalArgumentException(message);
        }
    }
}
