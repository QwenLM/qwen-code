package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

/** One bounded page per tick; storage deletion never holds a database transaction. */
public final class ToolPublicationCollector {
    private static final Logger LOG = LoggerFactory.getLogger(ToolPublicationCollector.class);
    private static final long CLAIM_MILLIS = 60_000;
    private static final long PROTECTED_RECHECK_MILLIS = Duration.ofHours(24).toMillis();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ToolPublicationRetentionStore retention;
    private final ToolPublicationObjectStore objects;
    private final ManagedAgentProperties properties;
    private final String owner = UUID.randomUUID().toString();

    public ToolPublicationCollector(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ToolPublicationRetentionStore retention, ToolPublicationObjectStore objects,
            ManagedAgentProperties properties) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.transactions.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        this.retention = retention;
        this.objects = objects;
        this.properties = properties;
    }

    @Scheduled(fixedDelay = 1000, scheduler = "managedToolOutputScheduler")
    public synchronized void tick() {
        try {
            runOnce();
        } catch (RuntimeException error) {
            LOG.warn("Tool output collection will retry owner={}", owner, error);
        }
    }

    public synchronized boolean runOnce() {
        if (!properties.getToolPublication().isGcEnabled()) {
            return false;
        }
        ensureOperations();
        Claim claim = claim();
        if (claim == null) {
            return false;
        }
        try {
            var page =
                    jdbc.query(
                            "SELECT slot_key, capture_object_key AS object_key FROM ma_resource"
                                    + " WHERE scope_key = ? AND publication_id = ? AND slot_key > ?"
                                    + " ORDER BY slot_key LIMIT 100",
                            (row, index) ->
                                    new ObjectKey(
                                            row.getString("slot_key"), row.getString("object_key")),
                            claim.scope(),
                            claim.publication(),
                            claim.cursor());
            if (page.stream().anyMatch(object -> object.key() != null)) {
                objects.validateConfiguration();
            }
            for (var object : page) {
                if (!renew(claim)) {
                    defer(claim);
                    return false;
                }
                if (object.key() != null) {
                    objects.deleteIfPresent(object.key());
                }
            }
            boolean confirmed = Boolean.TRUE.equals(transactions.execute(status -> confirm(claim, page)));
            if (!confirmed) {
                defer(claim);
            }
            return confirmed;
        } catch (RuntimeException error) {
            try {
                defer(claim);
            } catch (RuntimeException later) {
                error.addSuppressed(later);
            }
            throw error;
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private static String operationId(String scope, String publication) {
        return "capture-gc-" + ManagedSchemaKeys.key(scope, publication);
    }

    private static String operationKey(String scope, String publication) {
        return ManagedSchemaKeys.operationKey(OperationKind.CAPTURE_GC, scope,
                ManagedSchemaKeys.key(publication), operationId(scope, publication));
    }

    private static JsonNode progress(java.util.Map<String, Object> row) {
        return row.get("result_json") == null ? JSON.createObjectNode()
                : ManagedToolResultStore.parse((String) row.get("result_json"));
    }

    private void ensureOperations() {
        // Keep each existence check on its capture identity as terminal operation history grows.
        var candidates = jdbc.query(
                        "SELECT c.scope_key, c.publication_id, c.tenant_id, c.workspace_id,"
                            + " c.session_id FROM ma_output_capture c WHERE c.retention_state ="
                            + " 'RETIRING' AND NOT EXISTS (SELECT 1 FROM ma_session s WHERE"
                            + " s.tenant_id = c.tenant_id AND s.session_id = c.session_id AND"
                            + " s.csi_guard = TRUE) AND NOT EXISTS (SELECT 1 FROM ma_operation o"
                            + " USE INDEX (ix_ma_operation_publication) WHERE o.scope_key ="
                            + " c.scope_key AND o.publication_id = c.publication_id AND"
                            + " o.operation_kind = 'CAPTURE_GC' LIMIT 1) LIMIT 32",
                (row, index) -> ManagedSchemaRows.read(row));
        long now = ToolPublicationRetentionStore.now(jdbc);
        for (var capture : candidates) {
            transactions.executeWithoutResult(
                    status -> {
                        ToolPublicationRetentionStore.lockGenericSession(
                                jdbc,
                                (String) capture.get("tenant_id"),
                                (String) capture.get("session_id"));
                        String scope = (String) capture.get("scope_key");
                        String publication = (String) capture.get("publication_id");
                        String request =
                                JSON.createObjectNode()
                                        .put("version", 1)
                                        .put("publicationId", publication)
                                        .toString();
                        jdbc.update(
                                "INSERT IGNORE INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id, publication_id, tenant_id, workspace_id, session_id, target_kind, target_key, request_digest, request_json, phase, state, gmt_create, gmt_modified) VALUES (?, ?, ?, 'CAPTURE_GC', ?, ?, ?, ?, ?, 'OUTPUT_CAPTURE', ?, ?, ?, 'COLLECTING', 'PENDING', ?, ?)",
                                operationKey(scope, publication),
                                ManagedSessionStore.sessionScopeKey(
                                        (String) capture.get("tenant_id"),
                                        (String) capture.get("session_id")),
                                scope,
                                operationId(scope, publication),
                                publication,
                                capture.get("tenant_id"),
                                capture.get("workspace_id"),
                                capture.get("session_id"),
                                ManagedSchemaKeys.key(publication),
                                ManagedSchemaKeys.key(request),
                                request,
                                now,
                                now);
                    });
        }
    }

    private boolean renew(Claim claim) {
        return transactions.execute(
                status -> {
                    ToolPublicationRetentionStore.lockGenericSession(
                            jdbc, claim.tenant(), claim.session());
                    long now = ToolPublicationRetentionStore.now(jdbc);
                    return jdbc.update(
                                    "UPDATE ma_operation SET claim_until = ?, gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'CAPTURE_GC' AND state = 'LEASED' AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                                    now + CLAIM_MILLIS,
                                    now,
                                    operationKey(claim.scope(), claim.publication()),
                                    owner,
                                    claim.generation(),
                                    now)
                            == 1;
                });
    }

    private void defer(Claim claim) {
        transactions.executeWithoutResult(
                status -> {
                    ToolPublicationRetentionStore.lockGenericSession(
                            jdbc, claim.tenant(), claim.session());
                    jdbc.update(
                            "UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", claim_owner = NULL, claim_until = NULL,"
                                + " available_at = ?, failure_code = 'collection_retry', state ="
                                + " 'PENDING' WHERE operation_key = ? AND operation_kind ="
                                + " 'CAPTURE_GC' AND claim_owner = ? AND claim_generation = ?",
                            ToolPublicationRetentionStore.now(jdbc) + CLAIM_MILLIS,
                            operationKey(claim.scope(), claim.publication()),
                            owner,
                            claim.generation());
                });
    }

    private Claim claim() {
        long time = ToolPublicationRetentionStore.now(jdbc);
        var candidates =
                jdbc.query(
                        "SELECT scope_key, publication_id, tenant_id, session_id FROM ma_operation WHERE operation_kind = 'CAPTURE_GC' AND NOT EXISTS (SELECT 1 FROM ma_session s WHERE s.tenant_id = ma_operation.tenant_id AND s.session_id = ma_operation.session_id AND s.csi_guard = TRUE) AND state <> 'SUCCEEDED' AND available_at >= 0 AND available_at <= ? AND (claim_owner = ? OR claim_until IS NULL OR claim_until <= ?) ORDER BY available_at, operation_key LIMIT 32",
                        (row, index) -> ManagedSchemaRows.read(row),
                        time,
                        owner,
                        time);
        for (var candidate : candidates) {
            Claim claim =
                    transactions.execute(
                            status -> {
                                String scope = (String) candidate.get("scope_key");
                                String publication = (String) candidate.get("publication_id");
                                String tenant = (String) candidate.get("tenant_id");
                                String session = (String) candidate.get("session_id");
                                ToolPublicationRetentionStore.lockGenericSession(
                                        jdbc, tenant, session);
                                var capture =
                                        jdbc.query(
                                                        "SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                                                        (row, index) -> ManagedSchemaRows.read(row),
                                                        scope,
                                                        publication)
                                                .getFirst();
                                var work =
                                        jdbc.query(
                                                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE operation_key = ? AND operation_kind = 'CAPTURE_GC' FOR UPDATE",
                                                        (row, index) -> ManagedSchemaRows.read(row),
                                                        operationKey(scope, publication))
                                                .getFirst();
                                long now = ToolPublicationRetentionStore.now(jdbc);
                                Number until = (Number) work.get("claim_until_epoch");
                                if ("SUCCEEDED".equals(work.get("state"))
                                        || ToolPublicationRetentionStore.number(
                                                        work, "available_at")
                                                > now
                                        || work.get("claim_owner") != null
                                                && !owner.equals(work.get("claim_owner"))
                                                && until != null
                                                && until.longValue() > now) {
                                    return null;
                                }
                                if ("RETIRING".equals(capture.get("retention_state"))) {
                                    Duration grace =
                                            properties.getToolPublication().getDeletionGrace();
                                    var observed = retention.candidate(capture, grace);
                                    if (observed.blocker() != null) {
                                        long next = now + switch (observed.blocker()) {
                                            case "legacy_write_evidence_missing", "quarantined",
                                                    "not_accepted_complete", "recovery_protected" -> PROTECTED_RECHECK_MILLIS;
                                            default -> CLAIM_MILLIS;
                                        };
                                        if ("grace_period".equals(observed.blocker())) {
                                            long retiredAt =
                                                    jdbc.queryForObject(
                                                            "SELECT retired_at FROM ma_session"
                                                                    + " WHERE tenant_id = ? AND"
                                                                    + " session_id = ?",
                                                            Long.class,
                                                            tenant,
                                                            session);
                                            next = Math.addExact(retiredAt, grace.toMillis());
                                        }
                                        jdbc.update(
                                                "UPDATE ma_operation SET failure_code = ?, available_at = ?, gmt_modified = ? WHERE operation_key = ?",
                                                observed.blocker(),
                                                next,
                                                now,
                                                operationKey(scope, publication));
                                        return null;
                                    }
                                    jdbc.update(
                                            "UPDATE ma_resource SET deletion_operation_key = ?"
                                                + " WHERE scope_key = ? AND publication_id = ? AND"
                                                + " deletion_operation_key IS NULL",
                                            operationKey(scope, publication),
                                            scope,
                                            publication);
                                    jdbc.update(
                                            "UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", retention_state ="
                                                    + " 'DELETING' WHERE scope_key = ? AND"
                                                    + " publication_id = ?",
                                            scope,
                                            publication);
                                } else if (!"DELETING".equals(capture.get("retention_state"))) {
                                    return null;
                                }
                                long generation =
                                        ToolPublicationRetentionStore.number(
                                                        work, "claim_generation")
                                                + 1;
                                jdbc.update(
                                        "UPDATE ma_operation SET state = 'LEASED', phase = 'DELETING', claim_generation = ?, claim_owner = ?, claim_until = ?, failure_code = NULL, gmt_modified = ? WHERE operation_key = ?",
                                        generation,
                                        owner,
                                        now + CLAIM_MILLIS,
                                        now,
                                        operationKey(scope, publication));
                                return new Claim(
                                        scope,
                                        publication,
                                        tenant,
                                        session,
                                        generation,
                                        progress(work).path("cursor").asText(""));
                            });
            if (claim != null) {
                return claim;
            }
        }
        return null;
    }

    private boolean confirm(Claim claim, List<ObjectKey> page) {
        ToolPublicationRetentionStore.lockGenericSession(jdbc, claim.tenant(), claim.session());
        var row = jdbc.query(
                                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE operation_key = ? AND operation_kind = 'CAPTURE_GC' FOR UPDATE",
                (result, index) -> ManagedSchemaRows.read(result), operationKey(claim.scope(), claim.publication())).getFirst();
        long now = ToolPublicationRetentionStore.now(jdbc);
        if (!"LEASED".equals(row.get("state"))
                || !owner.equals(row.get("claim_owner"))
                || ToolPublicationRetentionStore.number(row, "claim_generation")
                        != claim.generation()
                || row.get("claim_until") == null
                || ((Number) row.get("claim_until_epoch")).longValue() <= now
                || !claim.cursor().equals(progress(row).path("cursor").asText(""))) {
            return false;
        }
        String cursor = page.isEmpty() ? claim.cursor() : page.getLast().slot();
        var remaining =
                jdbc.query(
                        "SELECT 1 FROM ma_resource WHERE scope_key = ? AND publication_id = ? AND"
                                + " slot_key > ? LIMIT 1",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        claim.scope(),
                        claim.publication(),
                        cursor);
        if (!remaining.isEmpty()) {
            jdbc.update(
                    "UPDATE ma_operation SET result_json = ?, gmt_modified = ? WHERE operation_key = ? AND claim_generation = ?",
                    JSON.createObjectNode().put("version", 1).put("cursor", cursor).toString(), now,
                    operationKey(claim.scope(), claim.publication()), claim.generation());
            return true;
        }
        var capture = jdbc.query(
                                "SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                (result, index) -> ManagedSchemaRows.read(result), claim.scope(), claim.publication()).getFirst();
        long collected = ToolPublicationRetentionStore.number(capture, "capture_used_bytes")
                + ToolPublicationRetentionStore.number(capture, "producer_used_bytes")
                + ToolPublicationRetentionStore.number(capture, "admission_used_bytes");
        long released = ToolPublicationRetentionStore.number(capture, "capture_held_bytes")
                + ToolPublicationRetentionStore.number(capture, "producer_held_bytes")
                + ToolPublicationRetentionStore.number(capture, "admission_held_bytes");
        jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'CAPTURE' AND owner_key = ?",
                ManagedSchemaKeys.key("capture", claim.scope(), claim.publication()));
        jdbc.update(
                "UPDATE ma_resource SET inline_bytes = NULL, state = 'COLLECTED', capture_state ="
                        + " 'COLLECTED' WHERE scope_key = ? AND publication_id = ? AND"
                        + " deletion_operation_key = ?",
                claim.scope(), claim.publication(), operationKey(claim.scope(), claim.publication()));
        jdbc.update("UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", retention_state = 'COLLECTED', collected_at = ?,"
                        + " collected_bytes = ?, released_held_bytes = ?, capture_held_bytes = 0,"
                    + " producer_held_bytes = 0, admission_held_bytes = 0, capture_used_bytes = 0,"
                    + " producer_used_bytes = 0, admission_used_bytes = 0 WHERE scope_key = ? AND"
                    + " publication_id = ?",
                now, collected, released, claim.scope(), claim.publication());
        jdbc.update(
                "UPDATE ma_operation SET state = 'SUCCEEDED', claim_owner = NULL, claim_until = NULL, completed_at = ?, gmt_modified = ?, available_at = "
                        + ManagedSchemaTime.NEVER_DUE_MILLIS
                        + ", result_json = ? WHERE operation_key = ? AND claim_generation = ?",
                now,
                now,
                JSON.createObjectNode()
                        .put("version", 1)
                        .put("cursor", cursor)
                        .put("collectedBytes", collected)
                        .put("releasedHeldBytes", released)
                        .toString(),
                operationKey(claim.scope(), claim.publication()),
                claim.generation());
        jdbc.update(
                "DELETE FROM ma_read_lease WHERE tenant_key = ? AND session_key = ? AND expires_at"
                        + " <= ?",
                ToolPublicationRetentionStore.hash(claim.tenant()), ToolPublicationRetentionStore.hash(claim.session()),
                ToolPublicationRetentionStore.now(jdbc));
        return true;
    }

    private record Claim(String scope, String publication, String tenant, String session, long generation, String cursor) {}
    private record ObjectKey(String slot, String key) {}
}
