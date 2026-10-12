package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

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
                require(index < eventCount && event.path("sequence").asLong(-1) == firstSequence + index,
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
            require(prior == null || prior.sourceDigest().equals(source.sourceDigest()), "Tool receipt source changed");
        }
        if (sources.isEmpty()) {
            return;
        }
        var existing = jdbc.queryForList("SELECT result_id, source_digest FROM managed_agent_tool_result"
                + " WHERE result_id IN (" + String.join(",", Collections.nCopies(sources.size(), "?")) + ")",
                sources.keySet().toArray());
        for (var row : existing) {
            Source source = sources.remove((String) row.get("result_id"));
            require(source.sourceDigest().equals(row.get("source_digest")), "Tool receipt source changed");
        }
        if (!sources.isEmpty()) {
            jdbc.batchUpdate("INSERT INTO managed_agent_tool_result (result_id, scope_key, execution_key,"
                    + " tenant_id, workspace_id, session_id, source_json, source_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    sources.values().stream().map(source -> new Object[] {source.id(), scope(tenant, session),
                            identity("execution", source.executionCallId().isEmpty() ? "sequence:" + source.receiptSequence()
                                    : source.executionCallId()).substring(10), tenant, workspace, session,
                            JSON.valueToTree(source).toString(), source.sourceDigest()}).toList());
        }
    }

    public void backfillOnePage() {
        for (int index = 0; index < 50; index++) {
            if (!backfillOneTransaction()) {
                return;
            }
        }
    }

    private boolean backfillOneTransaction() {
        String[] selected = new String[2];
        try {
            return Boolean.TRUE.equals(transactions.execute(status -> {
                var heads = jdbc.queryForList("SELECT tenant_id, workspace_id, session_id, journal_revision,"
                        + " o3_backfill_revision, o3_backfill_through FROM qwen_managed_session_journal_head"
                        + " WHERE state NOT IN ('DELETING', 'DELETED') AND o3_backfill_pending = TRUE AND o3_backfill_error IS NULL"
                        + " ORDER BY tenant_id, session_id LIMIT 1 FOR UPDATE");
                if (heads.isEmpty()) {
                    return false;
                }
                var head = heads.getFirst();
                String tenant = (String) head.get("tenant_id");
                String workspace = (String) head.get("workspace_id");
                String session = (String) head.get("session_id");
                selected[0] = tenant;
                selected[1] = session;
                long after = ((Number) head.get("o3_backfill_revision")).longValue();
                long through = ((Number) (head.get("o3_backfill_through") == null
                        ? head.get("journal_revision") : head.get("o3_backfill_through"))).longValue();
                var rows = jdbc.queryForList("SELECT journal_revision, first_sequence, event_count, record_bytes, record_digest FROM"
                        + " qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                        + " AND workspace_id = ? AND journal_revision > ? AND journal_revision <= ?"
                        + " ORDER BY journal_revision LIMIT 1", tenant, session, workspace, after, through);
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
                jdbc.update("UPDATE qwen_managed_session_journal_head SET o3_backfill_revision = ?,"
                                + " o3_backfill_through = ?, o3_backfill_pending = ? WHERE tenant_id = ? AND session_id = ?",
                        after, through, after < through, tenant, session);
                return true;
            }));
        } catch (IllegalArgumentException error) {
            if (selected[0] != null) {
                jdbc.update("UPDATE qwen_managed_session_journal_head SET o3_backfill_error = 'invalid_journal', o3_backfill_pending = FALSE"
                        + " WHERE tenant_id = ? AND session_id = ?", selected[0], selected[1]);
            }
            throw error;
        }
    }

    public Optional<Claim> claim() {
        return Optional.ofNullable(transactions.execute(status -> {
            long now = now();
            List<Map<String, Object>> rows = new ArrayList<>();
            for (String state : List.of("PENDING", "RETRYABLE", "LEASED")) {
                String due = "LEASED".equals(state) ? "claim_until" : "next_attempt_at";
                rows.addAll(jdbc.queryForList("SELECT result_id, source_json, claim_generation, "
                        + due + " AS due_at FROM managed_agent_tool_result WHERE work_state = ? AND "
                        + due + " <= ? ORDER BY " + due + ", result_id LIMIT 1 FOR UPDATE", state, now));
            }
            rows.sort(java.util.Comparator.<Map<String, Object>>comparingLong(
                    row -> ((Number) row.get("due_at")).longValue())
                    .thenComparing(row -> (String) row.get("result_id")));
            if (rows.isEmpty()) {
                return null;
            }
            var row = rows.getFirst();
            long generation = ((Number) row.get("claim_generation")).longValue() + 1;
            jdbc.update("UPDATE managed_agent_tool_result SET work_state = 'LEASED', claim_generation = ?,"
                            + " claim_until = ?, attempts = attempts + 1 WHERE result_id = ?",
                    generation, now + 60_000, row.get("result_id"));
            return new Claim(readSource((String) row.get("source_json")), generation);
        }));
    }

    public void fail(Claim claim, String state, String code) {
        require(List.of("RETRYABLE", "QUARANTINED", "UNSUPPORTED", "SUPPRESSED").contains(state),
                "Invalid projection failure state");
        jdbc.update("UPDATE managed_agent_tool_result SET work_state = ?, failure_code = ?,"
                        + " claim_until = NULL, next_attempt_at = CAST(? AS DECIMAL(20, 0))"
                        + " + LEAST(300000, attempts * 5000) WHERE result_id = ?"
                        + " AND work_state = 'LEASED' AND claim_generation = ?",
                state, code, now(), claim.source().id(), claim.generation());
    }

    public void verifySource(Source source) {
        var rows = jdbc.queryForList("SELECT record_bytes, record_digest FROM qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND workspace_id = ? AND session_id = ? AND journal_revision = ?",
                source.tenantId(), source.workspaceId(), source.sessionId(), source.journalRevision());
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
                require(original.sourceDigest().equals(source.sourceDigest()), "Original receipt source changed");
                matches++;
            }
        }
        require(matches == 1, "Original receipt is missing or ambiguous");
    }

    public boolean complete(Claim claim, Projection projection, String currentPolicyVersion) {
        return Boolean.TRUE.equals(transactions.execute(status -> {
            Source source = claim.source();
            ToolPublicationRetentionStore.lockSession(jdbc, source.tenantId(), source.sessionId());
            var retired = jdbc.queryForList("SELECT generation FROM qwen_output_session_retirement"
                    + " WHERE tenant_key = ? AND session_key = ?",
                    ToolPublicationRetentionStore.hash(source.tenantId()), ToolPublicationRetentionStore.hash(source.sessionId()));
            if (!retired.isEmpty()) {
                fail(claim, "SUPPRESSED", "session_retired");
                return false;
            }
            jdbc.queryForList("SELECT publication_id FROM qwen_tool_publication WHERE scope_key = ? AND tenant_id = ?"
                    + " AND session_id = ? AND publication_id = ? FOR UPDATE",
                    ToolPublicationDataStore.scope(source.sessionKey()), source.tenantId(), source.sessionId(), projection.publicationId());
            var publicSessions = jdbc.queryForList("SELECT tenant_id, session_id, workspace_id, status, last_sequence FROM"
                            + " managed_agent_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                    source.tenantId(), source.sessionId());
            var rows = jdbc.queryForList("SELECT work_state, claim_generation, claim_until, source_digest FROM"
                    + " managed_agent_tool_result WHERE result_id = ? FOR UPDATE", source.id());
            if (rows.isEmpty() || !"LEASED".equals(rows.getFirst().get("work_state"))
                    || ((Number) rows.getFirst().get("claim_generation")).longValue() != claim.generation()) {
                return false;
            }
            if (((Number) rows.getFirst().get("claim_until")).longValue() <= now()) {
                fail(claim, "RETRYABLE", "projection_claim_lapsed");
                return false;
            }
            require(source.sourceDigest().equals(rows.getFirst().get("source_digest")), "Projection source changed");
            if (publicSessions.isEmpty() || !source.tenantId().equals(publicSessions.getFirst().get("tenant_id"))
                    || !source.sessionId().equals(publicSessions.getFirst().get("session_id"))
                    || !source.workspaceId().equals(publicSessions.getFirst().get("workspace_id"))
                    || List.of("DELETING", "DELETED").contains(publicSessions.getFirst().get("status"))) {
                fail(claim, "SUPPRESSED", "session_unavailable");
                return false;
            }
            if (!projection.policyVersion().equals(currentPolicyVersion)) {
                fail(claim, "RETRYABLE", "publication_policy_changed");
                return false;
            }
            verifyCatalog(source, projection);
            long sequence = ((Number) publicSessions.getFirst().get("last_sequence")).longValue() + 1;
            for (Artifact artifact : projection.artifacts()) {
                jdbc.update("INSERT INTO managed_agent_artifact (artifact_id, result_id, scope_key, descriptor_json,"
                                + " publication_id, binding_json, manifest_ref_json, stream_id, creation_sequence)"
                                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", artifact.descriptor().path("id").asText(),
                        source.id(), scope(source.tenantId(), source.sessionId()), artifact.descriptor().toString(),
                        artifact.publicationId(), artifact.binding().toString(), artifact.manifestRef().toString(),
                        artifact.streamId(), sequence);
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
            jdbc.update("UPDATE managed_agent_tool_result SET work_state = 'READY', claim_until = NULL,"
                            + " failure_code = NULL, item_id = ?, descriptor_json = ?, policy_version = ? WHERE result_id = ?",
                    itemId, descriptor.toString(), projection.policyVersion(), source.id());
            return true;
        }));
    }

    private void verifyCatalog(Source source, Projection projection) {
        var rows = jdbc.queryForList("SELECT state, producer_phase, binding_digest, admission_resource_id,"
                        + " receipt_sequence, receipt_revision, CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantine_mark FROM qwen_tool_publication"
                        + " WHERE scope_key = ? AND tenant_id = ? AND workspace_id = ? AND session_id = ? AND publication_id = ? FOR UPDATE",
                ToolPublicationDataStore.scope(source.sessionKey()), source.tenantId(), source.workspaceId(), source.sessionId(), projection.publicationId());
        require(rows.size() == 1, "Original publication disappeared");
        var row = rows.getFirst();
        require(ToolPublicationContract.bindingDigest(projection.binding()).equals(row.get("binding_digest")),
                "Original publication binding changed");
        if (projection.descriptor().path("execution_status").asText().equals("not_started")) {
            require("NOT_STARTED".equals(row.get("state")), "Original not-started proof changed");
        } else {
            require("REFERENCED".equals(row.get("producer_phase"))
                            && source.outcomeRef().path("resourceId").asText().equals(row.get("admission_resource_id"))
                            && ((Number) row.get("receipt_sequence")).longValue() == source.receiptSequence()
                            && ((Number) row.get("receipt_revision")).longValue() == source.journalRevision(),
                    "Original publication receipt changed");
            if (((Number) row.get("quarantine_mark")).intValue() != 0
                    && (!projection.artifacts().isEmpty() || projection.descriptor().has("preview"))) {
                throw new IllegalStateException("Publication was quarantined during projection");
            }
        }
    }

    public Optional<JsonNode> findResult(String tenant, String session, String itemId) {
        return jdbc.query("SELECT descriptor_json FROM managed_agent_tool_result WHERE scope_key = ?"
                        + " AND tenant_id = ? AND session_id = ? AND item_id = ? AND work_state = 'READY'",
                (r, n) -> parse(r.getString(1)), scope(tenant, session), tenant, session, itemId).stream().findFirst();
    }

    public Optional<Artifact> findArtifact(String tenant, String session, String artifactId) {
        return jdbc.query("SELECT a.*, r.source_json FROM managed_agent_artifact a JOIN managed_agent_tool_result r"
                        + " ON r.result_id = a.result_id WHERE a.scope_key = ? AND r.tenant_id = ? AND r.session_id = ?"
                        + " AND a.artifact_id = ? AND r.work_state = 'READY'", this::artifact,
                scope(tenant, session), tenant, session, artifactId).stream().findFirst();
    }

    public ArtifactPage listArtifacts(String tenant, String session, Long watermark, Long beforeSequence,
            String beforeId, int limit) {
        require(limit >= 1 && limit <= 100 && (beforeSequence == null) == (beforeId == null), "Invalid artifact page");
        long through = watermark == null ? jdbc.queryForObject("SELECT COALESCE(MAX(creation_sequence), 0)"
                + " FROM managed_agent_artifact WHERE scope_key = ?", Long.class, scope(tenant, session)) : watermark;
        require(through >= 0, "Invalid artifact watermark");
        List<Object> args = new ArrayList<>(List.of(scope(tenant, session), tenant, session, through));
        String cursor = "";
        if (beforeSequence != null) {
            cursor = " AND (a.creation_sequence < ? OR (a.creation_sequence = ? AND a.artifact_id < ?))";
            args.add(beforeSequence);
            args.add(beforeSequence);
            args.add(beforeId);
        }
        args.add(limit + 1);
        List<Artifact> rows = jdbc.query("SELECT a.*, r.source_json FROM managed_agent_artifact a"
                        + " JOIN managed_agent_tool_result r ON r.result_id = a.result_id WHERE a.scope_key = ?"
                        + " AND r.tenant_id = ? AND r.session_id = ? AND a.creation_sequence <= ?"
                        + " AND r.work_state = 'READY'" + cursor
                        + " ORDER BY a.creation_sequence DESC, a.artifact_id DESC LIMIT ?", this::artifact, args.toArray());
        return new ArtifactPage(List.copyOf(rows.subList(0, Math.min(rows.size(), limit))), through, rows.size() > limit);
    }

    private Artifact artifact(ResultSet row, int index) throws SQLException {
        return new Artifact(parse(row.getString("descriptor_json")), readSource(row.getString("source_json")),
                row.getString("publication_id"), parse(row.getString("binding_json")),
                parse(row.getString("manifest_ref_json")), row.getString("stream_id"), row.getLong("creation_sequence"));
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
        require(tenant.equals(key.path("tenantId").asText()) && workspace.equals(key.path("workspaceId").asText())
                        && session.equals(key.path("sessionId").asText()) && event.path("sequence").asLong(-1) > 0,
                "Receipt scope or sequence conflicts");
        JsonNode payload = event.path("payload");
        String execution = payload.path("executionCallId").asText();
        JsonNode outcome = canonical(payload.path("toolOutcomeRef"));
        JsonNode result = canonical(payload.path("resultRef"));
        JsonNode resources = canonical(payload.path("resources"));
        String identityKey = execution.isEmpty() ? "sequence:" + event.path("sequence").asText() : execution;
        String id = identity("result", "1", tenant, workspace, session, identityKey);
        String digest = identity("source", tenant, workspace, session, execution, Long.toString(revision),
                event.path("sequence").asText(), outcome.toString(), result.toString(), resources.toString()).substring(7);
        return new Source(id, tenant, workspace, session, execution, revision, event.path("sequence").asLong(),
                outcome, result, resources, digest);
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
        return jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class).getTime();
    }

    static void require(boolean valid, String message) {
        if (!valid) {
            throw new IllegalArgumentException(message);
        }
    }
}
