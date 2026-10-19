package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.List;

@Repository
public class WorkspaceLifecycleStore {
    private static final ObjectMapper OCCURRENCE_JSON = new ObjectMapper();

    public static boolean legacyClose(JdbcTemplate jdbc, String tenant, String session) {
        long now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
        return !WorkspaceOperations.rows(jdbc, "SELECT o.operation_id FROM ma_operation o JOIN ma_session s ON s.tenant_id = o.tenant_id AND s.session_id = o.session_id JOIN ma_session_head f ON f.tenant_id = o.tenant_id AND f.harness_session_id = o.session_id WHERE o.tenant_id = ? AND o.session_id = ? AND o.operation_kind = 'CLOSE' AND o.lifecycle_protocol_version = 0 AND o.delivery_state = 'LEASED' AND o.claim_until > ? AND s.status = 'CLOSING' AND f.tenant_key = ? AND f.harness_key = ? AND f.phase = 'DRAINING' AND f.operation_id IS NULL FOR UPDATE", tenant, session, now,
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session)).isEmpty();
    }
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final ManagedExtensionRecordStore records;
    private final ObjectProvider<RuntimeBindingRepository> bindings;
    private WorkspaceProfileLifecycleVerifier profiles;
    private ResidentWorkspaces residents = new ResidentWorkspaces(java.util.List.of());

    @org.springframework.beans.factory.annotation.Autowired
    void setResidentConfiguration(com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties properties) {
        residents = new ResidentWorkspaces(properties.getRuntimeBroker().getResidentWorkspaces());
    }

    @org.springframework.beans.factory.annotation.Autowired
    void setProfiles(WorkspaceProfileLifecycleVerifier profiles) { this.profiles = profiles; }

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

    /** Bounded variant for hot paths: fails instead of out-waiting the caller (#13800). */
    public static void lockPlacement(JdbcTemplate jdbc, String tenant, int timeoutSeconds) {
        jdbc.execute((ConnectionCallback<Void>) connection -> {
            JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant, timeoutSeconds);
            return null;
        });
    }

    public static void requireClaim(JdbcTemplate jdbc, String tenant, String session,
            RuntimeLifecycleAuthority authority, boolean drainingAllowed) {
        if (authority == null) {
            throw blocked("workspace_lifecycle_claim_fenced");
        }
        var rows = jdbc.query("SELECT o.claim_generation, o.claim_until AS lease_until, o.delivery_state, o.lifecycle_protocol_version, s.status, f.phase, f.operation_id FROM ma_operation o JOIN ma_session s ON s.tenant_id = o.tenant_id AND s.session_id = o.session_id JOIN ma_session_head f ON f.tenant_id = s.tenant_id AND f.harness_session_id = s.session_id WHERE o.operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE') AND o.tenant_id = ? AND o.session_id = ? AND o.operation_id = ? AND f.tenant_key = ? AND f.harness_key = ? FOR UPDATE", (row, index) -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.read(row), tenant, session, authority.operationId(),
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session));
        long now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
        if (rows.size() != 1) {
            throw blocked("workspace_lifecycle_claim_fenced");
        }
        var row = rows.getFirst();
        if (((Number) row.get("claim_generation")).longValue() != authority.claimGeneration()
                || !(row.get("lease_until") instanceof Number until) || until.longValue() <= now
                || !"LEASED".equals(row.get("delivery_state"))
                || !WorkspaceToolProfiles.lifecycleProtocol(((Number) row.get("lifecycle_protocol_version")).intValue())
                || !List.of("CLOSING", "DELETING").contains(row.get("status"))
                || !authority.operationId().equals(row.get("operation_id"))
                || !"LIFECYCLE_ONLY".equals(row.get("phase")) && !(drainingAllowed && "DRAINING".equals(row.get("phase")))) {
            throw blocked("workspace_lifecycle_claim_fenced");
        }
    }

    public static boolean resourceClaim(JdbcTemplate jdbc, String tenant, String session,
            RuntimeLifecycleAuthority authority) {
        requireClaim(jdbc, tenant, session, authority, true);
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT o.lifecycle_protocol_version = 2 AND f.phase = 'DRAINING'"
                + " FROM ma_operation o JOIN ma_session_head f"
                + " ON f.tenant_id = o.tenant_id AND f.harness_session_id = o.session_id AND f.operation_id = o.operation_id"
                + " WHERE o.operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE') AND o.tenant_id = ? AND o.session_id = ? AND o.operation_id = ?", Boolean.class,
                tenant, session, authority.operationId()));
    }

    public static void requireIdleJournal(JdbcTemplate jdbc, ObjectMapper json, String tenant, String session) {
        requireIdleJournal(jdbc, json, tenant, session, false);
    }

    public static void requireIdleJournal(JdbcTemplate jdbc, ObjectMapper json, String tenant, String session, boolean allowCleanup) {
        requireIdleJournal(jdbc, json, tenant, session, allowCleanup, false);
    }

    public static java.util.Set<String> requireIdleJournal(JdbcTemplate jdbc, ObjectMapper json, String tenant, String session, boolean allowCleanup, boolean v2) {
        var heads = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, compacted_through_revision, journal_revision"
                + " FROM ma_session_head"
                + " WHERE tenant_key = ? AND harness_key = ? AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                JdbcRuntimeBindingRepository.harnessDrainKey(tenant), JdbcRuntimeBindingRepository.harnessDrainKey(session));
        if (heads.isEmpty()) {
            return java.util.Set.of();
        }
        if (!tenant.equals(heads.getFirst().get("tenant_id")) || !session.equals(heads.getFirst().get("session_id"))
                || ((Number) heads.getFirst().get("compacted_through_revision")).longValue() != 0) {
            throw blocked("workspace_lifecycle_journal_unverified");
        }
        long headRevision = ((Number) heads.getFirst().get("journal_revision")).longValue();
        // The head row locked above is the per-Session fence: writers append
        // revisions only behind it, so the ordered scan first runs without a
        // lock of its own, and a lifecycle settle does not pin every revision
        // of the journal while it parses them in Java (#13800). That scan is
        // a snapshot read, though, and the enclosing lifecycle transaction
        // may have pinned its snapshot with plain reads before the head lock
        // was granted. A revision committed in that window is invisible to
        // it, so when the scan stops short of the locked head's revision it
        // is repeated as a locking read, which reads the journal as committed
        // now and decides on that (#13800 R2-3). Only a journal that still
        // falls short of its own head fails closed.
        var scan = scanJournal(jdbc, json, tenant, session, v2, false);
        if (scan.maxRevision() < headRevision) {
            scan = scanJournal(jdbc, json, tenant, session, v2, true);
            if (scan.maxRevision() < headRevision) {
                throw blocked("workspace_lifecycle_journal_unverified");
            }
        }
        var pending = scan.pending();
        var cleanup = scan.cleanup();
        if (!pending.isEmpty() || !allowCleanup && cleanup.values().stream().anyMatch(state -> !"confirmed".equals(state))) {
            throw new ManagedAgentException(HttpStatus.CONFLICT, "turn_active", "The Session has an active Turn.");
        }
        return java.util.Set.copyOf(scan.accepted());
    }

    private record JournalScan(long maxRevision, java.util.Set<String> pending, java.util.Map<String, String> cleanup,
            java.util.Set<String> accepted) {
    }

    private static JournalScan scanJournal(JdbcTemplate jdbc, ObjectMapper json, String tenant, String session,
            boolean v2, boolean locking) {
        final long[] maxScanned = {0};
        var pending = new java.util.HashSet<String>();
        var cleanup = new java.util.HashMap<String, String>();
        var settled = new java.util.HashSet<String>();
        var accepted = new java.util.HashSet<String>();
        jdbc.query("SELECT journal_revision, record_bytes FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY journal_revision" + (locking ? " FOR UPDATE" : ""), row -> {
                maxScanned[0] = Math.max(maxScanned[0], row.getLong("journal_revision"));
                for (String line : new String(row.getBytes("record_bytes"), StandardCharsets.UTF_8).split("\n")) {
                    try {
                        JsonNode event = json.readTree(line).path("managedSession");
                        String turn = event.path("payload").path("turnId").asText();
                        if ("hosted.cleanup".equals(event.path("kind").asText())) {
                            cleanup.put(event.path("payload").path("cleanupId").asText(), event.path("payload").path("state").asText());
                        }
                        if ("input.accepted".equals(event.path("kind").asText())) {
                            accepted.add(turn);
                            String source = event.path("payload").path("source").asText();
                            if (!v2 || !List.of("monitor", "child_agent", "automation", "session_message", "channel").contains(source)) {
                                pending.add(turn);
                            }
                        } else if (v2 && "activation.changed".equals(event.path("kind").asText())
                                && "turn".equals(event.path("payload").path("subject").path("type").asText())) {
                            String active = event.path("payload").path("subject").path("turnId").asText();
                            if (!settled.contains(active)) {
                                pending.add(active);
                            }
                        } else if ("turn.settled".equals(event.path("kind").asText())) {
                            pending.remove(turn);
                            settled.add(turn);
                        }
                    } catch (java.io.IOException error) {
                        throw blocked("workspace_lifecycle_journal_unverified");
                    }
                }
            }, tenant, session);
        return new JournalScan(maxScanned[0], pending, cleanup, accepted);
    }

    @Transactional
    public JsonNode recoverEffects(OperationRecord operation) {
        lock(operation);
        requireClaim(jdbc, operation.tenantId(), operation.sessionId(), authority(operation), true);
        String saved = jdbc.queryForObject("SELECT lifecycle_effects_receipt_json FROM ma_operation"
                + " WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE') AND tenant_id = ? AND session_id = ? AND operation_id = ? FOR UPDATE", String.class,
                operation.tenantId(), operation.sessionId(), operation.operationId());
        if (saved != null) {
            return parse(saved);
        }
        try {
            requireIdleJournal(jdbc, json, operation.tenantId(), operation.sessionId());
        } catch (ManagedAgentException blocked) {
            return null;
        }
        JsonNode header = header(operation.tenantId(), operation.sessionId());
        var receipt = envelope(operation);
        var effects = receipt.putArray("effects");
        if (header == null) {
            if (!neverInitialized(operation)) {
                return null;
            }
            receipt.put("neverInitialized", true);
            receipt.put("storeSynthesized", true);
        } else {
            // A receipt synthesized here is built from the journal and store
            // alone — the Harness was never asked to settle (review round 14,
            // R14-2).
            receipt.put("storeSynthesized", true);
            JsonNode definitionRef = header.path("definitionRef");
            JsonNode definition = records.readRecordResource(operation.tenantId(), operation.sessionId(), definitionRef);
            receipt.set("definitionRef", definitionRef);
            if (definition.has("hookCatalog")) {
                for (String event : events(operation)) {
                    String resource = latestHookExecutionResource(operation, occurrence(event, operation.operationId()));
                    if (resource == null) {
                        return null;
                    }
                    JsonNode ref = resourceRef(operation, resource);
                    JsonNode marker = records.readRecordResource(operation.tenantId(), operation.sessionId(), ref);
                    if (!marker.hasNonNull("resultRef")) {
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
        jdbc.update("UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", lifecycle_effects_receipt_json = ? WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE') AND tenant_id = ? AND session_id = ? AND operation_id = ? AND claim_generation = ?",
                receipt.toString(), operation.tenantId(), operation.sessionId(), operation.operationId(), operation.claimGeneration());
        jdbc.update("UPDATE ma_session_head SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", phase = 'DRAINING', claim_lease_until = CASE WHEN ? = 2 THEN claim_lease_until ELSE NULL END WHERE tenant_key = ? AND harness_key = ? AND tenant_id = ? AND harness_session_id = ? AND operation_id = ?",
                operation.lifecycleProtocolVersion(), JdbcRuntimeBindingRepository.harnessDrainKey(operation.tenantId()), JdbcRuntimeBindingRepository.harnessDrainKey(operation.sessionId()),
                operation.tenantId(), operation.sessionId(), operation.operationId());
    }

    public void verifyCompletion(OperationRecord operation) {
        String saved = jdbc.queryForObject("SELECT lifecycle_effects_receipt_json FROM ma_operation"
                + " WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE') AND tenant_id = ? AND session_id = ? AND operation_id = ? FOR UPDATE", String.class,
                operation.tenantId(), operation.sessionId(), operation.operationId());
        if (saved == null) {
            throw blocked("workspace_lifecycle_hooks_unsettled");
        }
        verifyEffects(operation, parse(saved));
        if (operation.lifecycleProtocolVersion() == 2) {
            verifyResources(operation);
        }
        var writers = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, state, CASE WHEN writer_lease_until > " + ManagedSchemaTime.SQL_NOW + " THEN 1 ELSE 0 END AS live_writer FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                JdbcRuntimeBindingRepository.harnessDrainKey(operation.tenantId()),
                JdbcRuntimeBindingRepository.harnessDrainKey(operation.sessionId()));
        if (!writers.isEmpty() && (!operation.tenantId().equals(writers.getFirst().get("tenant_id"))
                || !operation.sessionId().equals(writers.getFirst().get("session_id")))) {
            throw blocked("workspace_lifecycle_claim_fenced");
        }
        if (!writers.isEmpty() && "ACTIVE".equals(writers.getFirst().get("state"))
                && ((Number) writers.getFirst().get("live_writer")).intValue() != 0) {
            throw blocked("workspace_lifecycle_writer_active");
        }
        if (residents.verifyClosed(jdbc, operation.tenantId(), operation.sessionId())) {
            if (!writers.isEmpty() && !"SEALED".equals(writers.getFirst().get("state"))) {
                throw blocked("workspace_lifecycle_writer_active");
            }
            return;
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

    @Transactional
    public void requireSettledExecutions(OperationRecord operation) {
        lock(operation);
        requireClaim(jdbc, operation.tenantId(), operation.sessionId(), authority(operation), true);
        if (operation.lifecycleProtocolVersion() == 2) {
            if (profiles == null) {
                throw blocked("workspace_lifecycle_protocol_unavailable");
            }
            profiles.verifyExecutions(operation);
        }
    }

    public void verifyOutputContents(OperationRecord operation) {
        if (profiles == null) {
            throw blocked("workspace_lifecycle_protocol_unavailable");
        }
        try {
            profiles.verifyPublications(operation);
        } catch (IllegalArgumentException invalid) {
            throw blocked("workspace_lifecycle_resources_unsettled");
        }
    }

    @Transactional
    public void verifyResources(OperationRecord operation) {
        lock(operation);
        requireClaim(jdbc, operation.tenantId(), operation.sessionId(), authority(operation), true);
        if (!resourceClaim(jdbc, operation.tenantId(), operation.sessionId(), authority(operation)) || profiles == null) {
            throw blocked("workspace_lifecycle_resources_unsettled");
        }
        RuntimeBindingRepository repository = bindings.getIfAvailable();
        if (repository == null) {
            throw blocked("workspace_close_identity_unverified");
        }
        var originals = jdbc.execute((ConnectionCallback<List<com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord>>) connection ->
                repository.verifyHarnessResources(connection, operation.tenantId(), operation.sessionId()));
        String profile = jdbc.queryForObject("SELECT tool_profile FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, operation.tenantId(), operation.sessionId());
        try {
            profiles.verifyResources(operation, originals, profile);
        } catch (IllegalArgumentException invalid) {
            throw blocked("workspace_lifecycle_resources_unsettled");
        }
    }

    private void lock(OperationRecord operation) {
        lockPlacement(jdbc, operation.tenantId());
        ToolPublicationRetentionStore.lockTenant(jdbc, operation.tenantId());
        WorkspaceOperations.rows(jdbc, "SELECT session_id FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                operation.tenantId(), operation.sessionId());
    }

    private void verifyEffects(OperationRecord operation, JsonNode receipt) {
        requireIdleJournal(jdbc, json, operation.tenantId(), operation.sessionId(), false, operation.lifecycleProtocolVersion() == 2);
        // The receipt's own operation id is the hook-execution namespace:
        // the Hook executions it certifies were recorded under the operation
        // that ran them. A resumed operation carries the receipt its failed
        // predecessor validated — the store moves it at the fence rebind —
        // so the named operation may be a terminal-failed same-kind
        // operation on this Session instead of the completing one (review
        // round 13, R13-1).
        String receiptOperation = receipt.path("operationId").asText();
        if (receipt.path("protocolVersion").asInt() != operation.lifecycleProtocolVersion() || !receipt.path("sessionKey").equals(sessionKey(operation))
                || !receiptOperation.equals(operation.operationId()) && !failedLifecyclePredecessor(operation, receiptOperation)
                || !operation.kind().name().toLowerCase(java.util.Locale.ROOT).equals(receipt.path("kind").asText())
                || !receipt.path("effects").isArray()) {
            throw blocked("workspace_lifecycle_receipt_invalid");
        }
        if (operation.lifecycleProtocolVersion() == 2) {
            if (profiles == null) {
                throw blocked("workspace_lifecycle_protocol_unavailable");
            }
            profiles.verifyEffects(operation);
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
        if (WorkspaceToolProfiles.lifecycleProtocol(definition.path("toolProfile").asText()) != operation.lifecycleProtocolVersion()) {
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
            String latest = latestHookExecutionResource(operation, occurrence(event, receiptOperation));
            if (latest == null || !latest.equals(effect.path("recordRef").path("resourceId").asText())) {
                throw blocked("workspace_lifecycle_receipt_invalid");
            }
            JsonNode record = records.readRecordResource(operation.tenantId(), operation.sessionId(), effect.path("recordRef"));
            ManagedHookRecords.requireExecution(record);
            if (!event.equals(effect.path("event").asText()) || !event.equals(record.path("eventName").asText())
                    || !occurrence(event, receiptOperation).equals(record.path("hookExecutionId").asText())
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
        var heads = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, journal_revision, CASE WHEN state = 'ACTIVE' AND writer_lease_until > " + ManagedSchemaTime.SQL_NOW + " THEN 1 ELSE 0 END AS live_writer FROM ma_session_head WHERE tenant_key = ? AND harness_key = ? AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                JdbcRuntimeBindingRepository.harnessDrainKey(operation.tenantId()),
                JdbcRuntimeBindingRepository.harnessDrainKey(operation.sessionId()));
        if (!heads.isEmpty() && (!operation.tenantId().equals(heads.getFirst().get("tenant_id"))
                || !operation.sessionId().equals(heads.getFirst().get("session_id"))
                || ((Number) heads.getFirst().get("journal_revision")).longValue() != 0
                || ((Number) heads.getFirst().get("live_writer")).intValue() != 0)) {
            return false;
        }
        return jdbc.queryForObject("SELECT harness_boot_id FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, operation.tenantId(), operation.sessionId()) == null
                && jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?",
                        Integer.class, operation.tenantId(), operation.sessionId()) == 0
                && records.listRecords(operation.tenantId(), operation.sessionId(), "hook_execution").isEmpty()
                && records.listRecords(operation.tenantId(), operation.sessionId(), "hook_registration").isEmpty()
                && (operation.lifecycleProtocolVersion() != 2 || jdbc.queryForObject("SELECT COUNT(*) FROM ma_runtime_binding"
                        + " WHERE tenant_id = ? AND isolation_class = 'session' AND isolation_key = ?", Integer.class,
                        operation.tenantId(), operation.sessionId()) == 0
                        && !jdbc.execute((ConnectionCallback<Boolean>) connection -> JdbcRuntimeBindingRepository
                                .hasSharedRuntimeSessions(connection, operation.tenantId(), operation.sessionId()))
                        && jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record WHERE record_kind = 'DOMAIN' AND tenant_id = ? AND session_id = ?",
                                Integer.class, operation.tenantId(), operation.sessionId()) == 0);
    }

    private String latestHookExecutionResource(OperationRecord operation, String occurrence) {
        return jdbc.queryForList("SELECT record_resource_id FROM ma_session_record"
                + " WHERE session_scope_key = ? AND record_key = ? AND tenant_id = ? AND session_id = ?"
                + " AND domain = 'hook_execution' AND record_id = ? FOR UPDATE", String.class,
                ManagedSessionStore.sessionScopeKey(operation.tenantId(), operation.sessionId()),
                ManagedExtensionProjection.recordKey(operation.sessionId(), "hook_execution", occurrence),
                operation.tenantId(), operation.sessionId(), occurrence).stream().findFirst().orElse(null);
    }

    private JsonNode resourceRef(OperationRecord operation, String resource) {
        return jdbc.query("SELECT kind, schema_version, byte_length, sha256 FROM ma_resource"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ? AND resource_id = ?",
                (row, index) -> json.createObjectNode().put("resourceId", resource).put("kind", row.getString("kind"))
                        .put("schemaVersion", row.getInt("schema_version")).put("byteLength", row.getLong("byte_length"))
                        .put("digest", row.getString("sha256")), ManagedSessionStore.sessionScopeKey(operation.tenantId(), operation.sessionId()),
                operation.tenantId(), operation.sessionId(), resource).stream()
                .findFirst().orElseThrow(() -> blocked("workspace_lifecycle_receipt_invalid"));
    }

    private JsonNode header(String tenant, String session) {
        var rows = jdbc.queryForList("SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?"
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

    private boolean failedLifecyclePredecessor(OperationRecord operation,
            String receiptOperation) {
        Integer matches = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = ? AND"
                        + " operation_kind = ? AND state = 'FAILED'",
                Integer.class, operation.tenantId(), operation.sessionId(),
                receiptOperation, operation.kind().name());
        return matches != null && matches > 0;
    }

    private com.fasterxml.jackson.databind.node.ObjectNode envelope(OperationRecord operation) {
        var node = json.createObjectNode().put("protocolVersion", operation.lifecycleProtocolVersion()).put("operationId", operation.operationId())
                .put("kind", operation.kind().name().toLowerCase(java.util.Locale.ROOT));
        node.set("sessionKey", sessionKey(operation));
        return node;
    }

    private JsonNode sessionKey(OperationRecord operation) {
        String workspace = jdbc.queryForObject("SELECT workspace_id FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                String.class, operation.tenantId(), operation.sessionId());
        return json.createObjectNode().put("tenantId", operation.tenantId()).put("workspaceId", workspace).put("sessionId", operation.sessionId());
    }

    private List<String> events(OperationRecord operation) {
        return operation.kind() == StoreModels.OperationKind.CLOSE ? List.of("SessionEnd") : List.of("SessionEnd", "SessionDelete");
    }

    private String occurrence(String event, String operationId) {
        try {
            return "hook-plan-" + DigestUtils.sha256Hex(
                    OCCURRENCE_JSON.writeValueAsBytes(List.of(event, operationId)));
        } catch (java.io.IOException | IllegalArgumentException error) {
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

    public static ManagedAgentException blocked(String code) {
        return new ManagedAgentException(HttpStatus.CONFLICT, code, "Workspace lifecycle recovery is blocked.");
    }
}
