package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class WorkspaceLifecycleStore {
    public static boolean legacyClose(JdbcTemplate jdbc, String tenant, String session) {
        long now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", java.sql.Timestamp.class).getTime();
        return !jdbc.queryForList("SELECT o.operation_id FROM managed_agent_operation o"
                + " JOIN managed_agent_session s ON s.tenant_id = o.tenant_id AND s.session_id = o.session_id"
                + " JOIN qwen_runtime_harness_drain f ON f.tenant_id = o.tenant_id AND f.harness_session_id = o.session_id"
                + " WHERE o.tenant_id = ? AND o.session_id = ? AND o.operation_kind = 'CLOSE'"
                + " AND o.lifecycle_protocol_version = 0 AND o.delivery_state = 'LEASED'"
                + " AND o.lease_until > ? AND s.status = 'CLOSING'"
                + " AND f.phase = 'DRAINING' AND f.operation_id IS NULL FOR UPDATE", tenant, session, now).isEmpty();
    }
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final ManagedExtensionRecordStore records;
    private final ObjectProvider<RuntimeBindingRepository> bindings;

    public WorkspaceLifecycleStore(JdbcTemplate jdbc, ObjectMapper json, ObjectProvider<RuntimeBindingRepository> bindings) {
        this.jdbc = jdbc;
        this.json = json;
        this.records = new ManagedExtensionRecordStore(jdbc);
        this.bindings = bindings;
    }

    public static void lockPlacement(JdbcTemplate jdbc, String tenant) {
        jdbc.execute((ConnectionCallback<Void>) connection -> {
            JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant);
            return null;
        });
    }

    public static void requireClaim(JdbcTemplate jdbc, String tenant, String session,
            RuntimeLifecycleAuthority authority, boolean drainingAllowed) {
        if (authority == null) {
            throw blocked("workspace_lifecycle_claim_fenced");
        }
        var rows = jdbc.queryForList("SELECT o.claim_generation, o.lease_until, o.delivery_state, o.lifecycle_protocol_version,"
                + " s.status, f.phase, f.operation_id FROM managed_agent_operation o"
                + " JOIN managed_agent_session s ON s.tenant_id = o.tenant_id AND s.session_id = o.session_id"
                + " JOIN qwen_runtime_harness_drain f ON f.tenant_id = s.tenant_id AND f.harness_session_id = s.session_id"
                + " WHERE o.tenant_id = ? AND o.session_id = ? AND o.operation_id = ? FOR UPDATE", tenant, session, authority.operationId());
        long now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
        if (rows.size() != 1) {
            throw blocked("workspace_lifecycle_claim_fenced");
        }
        var row = rows.getFirst();
        if (((Number) row.get("claim_generation")).longValue() != authority.claimGeneration()
                || !(row.get("lease_until") instanceof Number until) || until.longValue() <= now
                || !"LEASED".equals(row.get("delivery_state"))
                || ((Number) row.get("lifecycle_protocol_version")).intValue() != 1
                || !List.of("CLOSING", "DELETING").contains(row.get("status"))
                || !authority.operationId().equals(row.get("operation_id"))
                || !"LIFECYCLE_ONLY".equals(row.get("phase")) && !(drainingAllowed && "DRAINING".equals(row.get("phase")))) {
            throw blocked("workspace_lifecycle_claim_fenced");
        }
    }

    public static void requireIdleJournal(JdbcTemplate jdbc, ObjectMapper json, String tenant, String session) {
        var heads = jdbc.queryForList("SELECT compacted_through_revision FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", tenant, session);
        if (heads.isEmpty()) {
            return;
        }
        if (((Number) heads.getFirst().get("compacted_through_revision")).longValue() != 0) {
            throw blocked("workspace_lifecycle_journal_unverified");
        }
        var pending = new java.util.HashSet<String>();
        jdbc.query("SELECT record_bytes FROM qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY journal_revision FOR UPDATE", row -> {
                for (String line : new String(row.getBytes(1), StandardCharsets.UTF_8).split("\n")) {
                    try {
                        JsonNode event = json.readTree(line).path("managedSession");
                        String turn = event.path("payload").path("turnId").asText();
                        if ("input.accepted".equals(event.path("kind").asText())) {
                            pending.add(turn);
                        } else if ("turn.settled".equals(event.path("kind").asText())) {
                            pending.remove(turn);
                        }
                    } catch (java.io.IOException error) {
                        throw blocked("workspace_lifecycle_journal_unverified");
                    }
                }
            }, tenant, session);
        if (!pending.isEmpty()) {
            throw new ApiException(HttpStatus.CONFLICT, "turn_active", "The Session has an active Turn.");
        }
    }

    @Transactional
    public JsonNode recoverEffects(OperationRecord operation) {
        lock(operation);
        requireClaim(jdbc, operation.tenantId(), operation.sessionId(), authority(operation), true);
        String saved = jdbc.queryForObject("SELECT lifecycle_effects_receipt_json FROM managed_agent_operation"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ? FOR UPDATE", String.class,
                operation.tenantId(), operation.sessionId(), operation.operationId());
        if (saved != null) {
            return parse(saved);
        }
        JsonNode header = header(operation.tenantId(), operation.sessionId());
        var receipt = envelope(operation);
        var effects = receipt.putArray("effects");
        if (header == null) {
            if (!neverInitialized(operation)) {
                return null;
            }
            receipt.put("neverInitialized", true);
        } else {
            JsonNode definitionRef = header.path("definitionRef");
            JsonNode definition = records.readRecordResource(operation.tenantId(), operation.sessionId(), definitionRef);
            receipt.set("definitionRef", definitionRef);
            if (definition.has("hookCatalog")) {
                var executions = records.listRecords(operation.tenantId(), operation.sessionId(), "hook_execution");
                for (String event : events(operation)) {
                    String id = occurrence(event, operation.operationId());
                    var refs = jdbc.queryForList("SELECT record_resource_id FROM qwen_managed_session_extension_record"
                            + " WHERE tenant_id = ? AND session_id = ? AND domain = 'hook_execution' ORDER BY first_sequence",
                            String.class, operation.tenantId(), operation.sessionId());
                    JsonNode marker = executions.stream().filter(record -> id.equals(record.path("hookExecutionId").asText()))
                            .findFirst().orElse(null);
                    if (marker == null || marker.path("resultRef").isNull() || !marker.has("resultRef")) {
                        return null;
                    }
                    JsonNode ref = null;
                    for (String resourceId : refs) {
                        JsonNode candidate = resourceRef(operation, resourceId);
                        if (id.equals(records.readRecordResource(operation.tenantId(), operation.sessionId(), candidate)
                                .path("hookExecutionId").asText())) {
                            ref = candidate;
                            break;
                        }
                    }
                    if (ref == null) {
                        return null;
                    }
                    effects.addObject().put("event", event).set("recordRef", ref);
                }
            }
        }
        saveLocked(operation, receipt);
        return receipt;
    }

    @Transactional
    public void saveEffects(OperationRecord operation, JsonNode receipt) {
        lock(operation);
        requireClaim(jdbc, operation.tenantId(), operation.sessionId(), authority(operation), false);
        saveLocked(operation, receipt);
    }

    private void saveLocked(OperationRecord operation, JsonNode receipt) {
        verifyEffects(operation, receipt);
        jdbc.update("UPDATE managed_agent_operation SET lifecycle_effects_receipt_json = ?"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ? AND claim_generation = ?",
                receipt.toString(), operation.tenantId(), operation.sessionId(), operation.operationId(), operation.claimGeneration());
        jdbc.update("UPDATE qwen_runtime_harness_drain SET phase = 'DRAINING', claim_lease_until = NULL"
                + " WHERE tenant_id = ? AND harness_session_id = ? AND operation_id = ?",
                operation.tenantId(), operation.sessionId(), operation.operationId());
    }

    public void verifyCompletion(OperationRecord operation) {
        String saved = jdbc.queryForObject("SELECT lifecycle_effects_receipt_json FROM managed_agent_operation"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ? FOR UPDATE", String.class,
                operation.tenantId(), operation.sessionId(), operation.operationId());
        if (saved == null) {
            throw blocked("workspace_lifecycle_hooks_unsettled");
        }
        verifyEffects(operation, parse(saved));
        var writers = jdbc.queryForList("SELECT state, CASE WHEN writer_lease_until > CURRENT_TIMESTAMP(6) THEN 1 ELSE 0 END AS live_writer"
                + " FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                operation.tenantId(), operation.sessionId());
        if (!writers.isEmpty() && "ACTIVE".equals(writers.getFirst().get("state"))
                && ((Number) writers.getFirst().get("live_writer")).intValue() != 0) {
            throw blocked("workspace_lifecycle_writer_active");
        }
        RuntimeBindingRepository repository = bindings.getIfAvailable();
        if (repository == null) {
            throw blocked("workspace_close_identity_unverified");
        }
        jdbc.execute((ConnectionCallback<Void>) connection -> {
            repository.verifyHarnessStopped(connection, operation.tenantId(), operation.sessionId());
            return null;
        });
    }

    private void lock(OperationRecord operation) {
        lockPlacement(jdbc, operation.tenantId());
        ToolPublicationRetentionStore.lockTenant(jdbc, operation.tenantId());
        jdbc.queryForList("SELECT session_id FROM managed_agent_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                operation.tenantId(), operation.sessionId());
    }

    private void verifyEffects(OperationRecord operation, JsonNode receipt) {
        if (receipt.path("protocolVersion").asInt() != 1 || !receipt.path("sessionKey").equals(sessionKey(operation))
                || !operation.operationId().equals(receipt.path("operationId").asText())
                || !operation.kind().name().toLowerCase(java.util.Locale.ROOT).equals(receipt.path("kind").asText())
                || !receipt.path("effects").isArray()) {
            throw blocked("workspace_lifecycle_receipt_invalid");
        }
        JsonNode header = header(operation.tenantId(), operation.sessionId());
        if (receipt.path("neverInitialized").asBoolean()) {
            if (header != null || !receipt.path("effects").isEmpty() || !neverInitialized(operation)) {
                throw blocked("workspace_lifecycle_receipt_invalid");
            }
            return;
        }
        if (header == null || !header.path("definitionRef").equals(receipt.path("definitionRef"))) {
            throw blocked("workspace_lifecycle_receipt_invalid");
        }
        JsonNode definition = records.readRecordResource(operation.tenantId(), operation.sessionId(), receipt.path("definitionRef"));
        if (!"hosted-workspace-files/1".equals(definition.path("toolProfile").asText())) {
            throw blocked("workspace_lifecycle_profile_unavailable");
        }
        for (JsonNode execution : records.listRecords(operation.tenantId(), operation.sessionId(), "hook_execution")) {
            if (execution.path("resultRef").isNull()
                    && !"not_started_proven".equals(execution.path("run").path("execution").asText())
                    || "recovery_blocked".equals(execution.path("run").path("state").asText())) {
                throw blocked("workspace_lifecycle_hooks_unsettled");
            }
        }
        if (!definition.has("hookCatalog")) {
            if (!receipt.path("effects").isEmpty()) {
                throw blocked("workspace_lifecycle_receipt_invalid");
            }
            return;
        }
        List<String> events = events(operation);
        if (receipt.path("effects").size() != events.size()) {
            throw blocked("workspace_lifecycle_hooks_unsettled");
        }
        for (int index = 0; index < events.size(); index++) {
            String event = events.get(index);
            JsonNode effect = receipt.path("effects").get(index);
            String latest = jdbc.queryForList("SELECT record_resource_id FROM qwen_managed_session_extension_record WHERE"
                    + " tenant_id = ? AND session_id = ? AND domain = 'hook_execution' AND record_id = ? FOR UPDATE",
                    String.class, operation.tenantId(), operation.sessionId(), occurrence(event, operation.operationId()))
                    .stream().findFirst().orElse(null);
            if (latest == null || !latest.equals(effect.path("recordRef").path("resourceId").asText())) {
                throw blocked("workspace_lifecycle_receipt_invalid");
            }
            JsonNode record = records.readRecordResource(operation.tenantId(), operation.sessionId(), effect.path("recordRef"));
            ManagedHookRecords.requireExecution(record);
            if (!event.equals(effect.path("event").asText()) || !event.equals(record.path("eventName").asText())
                    || !occurrence(event, operation.operationId()).equals(record.path("hookExecutionId").asText())
                    || !"__plan__".equals(record.path("hookId").asText()) || record.path("resultRef").isNull()
                    || "recovery_blocked".equals(record.path("run").path("state").asText())) {
                throw blocked("workspace_lifecycle_hooks_unsettled");
            }
            records.readRecordResource(operation.tenantId(), operation.sessionId(), record.path("resultRef"));
            JsonNode plan = records.readRecordResource(operation.tenantId(), operation.sessionId(), record.path("planRef"));
            if (!event.equals(plan.path("input").path("hook_event_name").asText())
                    || !operation.sessionId().equals(plan.path("input").path("session_id").asText())) {
                throw blocked("workspace_lifecycle_receipt_invalid");
            }
        }
    }

    private boolean neverInitialized(OperationRecord operation) {
        var heads = jdbc.queryForList("SELECT journal_revision, CASE WHEN state = 'ACTIVE' AND"
                + " writer_lease_until > CURRENT_TIMESTAMP(6) THEN 1 ELSE 0 END AS live_writer"
                + " FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                operation.tenantId(), operation.sessionId());
        if (!heads.isEmpty() && (((Number) heads.getFirst().get("journal_revision")).longValue() != 0
                || ((Number) heads.getFirst().get("live_writer")).intValue() != 0)) {
            return false;
        }
        return jdbc.queryForObject("SELECT harness_boot_id FROM managed_agent_session WHERE tenant_id = ? AND session_id = ?",
                String.class, operation.tenantId(), operation.sessionId()) == null
                && jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ?",
                        Integer.class, operation.tenantId(), operation.sessionId()) == 0
                && records.listRecords(operation.tenantId(), operation.sessionId(), "hook_execution").isEmpty()
                && records.listRecords(operation.tenantId(), operation.sessionId(), "hook_registration").isEmpty();
    }

    private JsonNode resourceRef(OperationRecord operation, String resource) {
        return jdbc.query("SELECT * FROM qwen_managed_session_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                (row, index) -> json.createObjectNode().put("resourceId", resource).put("kind", row.getString("kind"))
                        .put("schemaVersion", row.getInt("schema_version")).put("byteLength", row.getLong("byte_length"))
                        .put("digest", row.getString("sha256")), operation.tenantId(), operation.sessionId(), resource).stream()
                .findFirst().orElseThrow(() -> blocked("workspace_lifecycle_receipt_invalid"));
    }

    private JsonNode header(String tenant, String session) {
        var rows = jdbc.queryForList("SELECT record_bytes FROM qwen_managed_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY journal_revision LIMIT 1", byte[].class, tenant, session);
        if (rows.isEmpty()) {
            return null;
        }
        for (String line : new String(rows.getFirst(), StandardCharsets.UTF_8).split("\\n")) {
            JsonNode record = parse(line);
            if ("managed_session_header_v1".equals(record.path("subtype").asText())) {
                return record.path("managedSession");
            }
        }
        throw blocked("workspace_lifecycle_receipt_invalid");
    }

    private com.fasterxml.jackson.databind.node.ObjectNode envelope(OperationRecord operation) {
        var node = json.createObjectNode().put("protocolVersion", 1).put("operationId", operation.operationId())
                .put("kind", operation.kind().name().toLowerCase(java.util.Locale.ROOT));
        node.set("sessionKey", sessionKey(operation));
        return node;
    }

    private JsonNode sessionKey(OperationRecord operation) {
        String workspace = jdbc.queryForObject("SELECT workspace_id FROM managed_agent_session WHERE tenant_id = ? AND session_id = ?",
                String.class, operation.tenantId(), operation.sessionId());
        return json.createObjectNode().put("tenantId", operation.tenantId()).put("workspaceId", workspace).put("sessionId", operation.sessionId());
    }

    private List<String> events(OperationRecord operation) {
        return operation.kind() == StoreModels.OperationKind.CLOSE ? List.of("SessionEnd") : List.of("SessionEnd", "SessionDelete");
    }

    private String occurrence(String event, String operationId) {
        try {
            return "hook-plan-" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                    json.writeValueAsBytes(List.of(event, operationId))));
        } catch (java.io.IOException | NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private JsonNode parse(String value) {
        try {
            return json.readTree(value);
        } catch (java.io.IOException error) {
            throw blocked("workspace_lifecycle_receipt_invalid");
        }
    }

    public static RuntimeLifecycleAuthority authority(OperationRecord operation) {
        return new RuntimeLifecycleAuthority(operation.operationId(), operation.claimGeneration());
    }

    public static ApiException blocked(String code) {
        return new ApiException(HttpStatus.CONFLICT, code, "Workspace lifecycle recovery is blocked.");
    }
}
