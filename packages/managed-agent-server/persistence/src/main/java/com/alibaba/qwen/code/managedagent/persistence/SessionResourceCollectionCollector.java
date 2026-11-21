package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.util.UUID;
import java.util.function.LongSupplier;

/**
 * Collects unreferenced immutable SQL resources of permanently retired Sessions; every page commits
 * atomically because no object store is involved.
 */
public final class SessionResourceCollectionCollector {
    private static final Logger LOG = LoggerFactory.getLogger(SessionResourceCollectionCollector.class);
    private static final long CLAIM_MILLIS = 60_000;
    private static final long LEDGER_SCAN_NANOS = Duration.ofMinutes(1).toNanos();
    private static final int SCAN_ROWS = 32;
    private static final long PROTECTED_RECHECK_MILLIS = Duration.ofHours(24).toMillis();
    private static final int PAGE_ROWS = 100;
    private static final long PAGE_BYTES = 32L * 1024 * 1024;
    private static final String RESOURCE_PAGE =
            "SELECT resource_id, byte_length, CASE WHEN state IN ('PUBLISHED', 'REFERENCED') AND"
                + " storage_kind = 'MYSQL_INLINE' AND publication_id IS NULL AND object_key IS NULL"
                + " AND object_version_id IS NULL AND encryption_key_id IS NULL AND"
                + " deletion_operation_ref IS NULL AND NOT EXISTS (SELECT 1 FROM ma_resource_ref f"
                + " WHERE f.resource_id = ma_resource.resource_id AND f.tenant_id = ma_resource.tenant_id"
                + " AND f.session_id = ma_resource.session_id) THEN 1 ELSE 0 END AS"
                + " collectible FROM ma_resource USE INDEX (idx_ma_resource_gc) WHERE"
                + " tenant_id = ? AND session_id = ? AND resource_id > ? ORDER BY resource_id LIMIT "
                    + (PAGE_ROWS + 1);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ManagedProjectionResourceCollector projections;
    private final ManagedAgentSettings properties;
    private final LongSupplier clock;
    private final String owner = UUID.randomUUID().toString();
    private long lastLedgerScanNanos;
    private long ledgerScanId;
    private long ledgerScanRoundEnd;

    public SessionResourceCollectionCollector(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentSettings properties) {
        this(jdbc, manager, properties, System::nanoTime);
    }

    SessionResourceCollectionCollector(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentSettings properties, LongSupplier clock) {
        Duration grace = properties.getToolPublication().getDeletionGrace();
        if (grace == null || grace.isNegative()) {
            throw new IllegalStateException("Tool output deletion grace must be nonnegative");
        }
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.projections = new ManagedProjectionResourceCollector(jdbc, manager);
        // The page-time recovery re-check fences a registration through InnoDB gap locks, which
        // exist
        // only under REPEATABLE READ; pin it rather than inherit the server default.
        this.transactions.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        this.properties = properties;
        this.clock = clock;
    }

    @Scheduled(fixedDelay = 1000, scheduler = "managedToolOutputScheduler")
    public void tick() {
        try {
            runOnce();
        } catch (RuntimeException error) {
            LOG.warn("Stream capture collection will retry owner={}", owner, error);
        }
    }

    public synchronized boolean runOnce() {
        if (!properties.getToolPublication().isGcEnabled()) {
            return false;
        }
        boolean projectionChanged = projections.runOnce();
        // Bounded reconciliation pages run at a coarse cadence; claim-time re-evaluation is authoritative.
        // The cadence reads a monotonic clock: a wall-clock step back (NTP, VM resume) would
        // otherwise keep the difference negative and silently stall ledger creation for the step.
        long scanNow = clock.getAsLong();
        if (scanNow - lastLedgerScanNanos >= LEDGER_SCAN_NANOS) {
            lastLedgerScanNanos = scanNow;
            ensureLedgers();
        }
        Claim claim = claim();
        if (claim == null) {
            return projectionChanged;
        }
        return collect(claim) || projectionChanged;
    }

    // Package-private so a test can interleave a recovery registration in the claim→page gap.
    boolean collect(Claim claim) {
        try {
            boolean confirmed = Boolean.TRUE.equals(transactions.execute(status -> page(claim)));
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

    private static String operationId(String session) {
        return "session-resources-" + session;
    }

    private static String operationKey(String tenant, String session) {
        return ManagedIdentityRefs.operationRef(OperationKind.SESSION_RESOURCE_GC.name(), tenant,
                "SESSION", session, session, operationId(session));
    }

    private static JsonNode progress(java.util.Map<String, Object> row) {
        Object value = row.get("result_json");
        return value == null ? JSON.createObjectNode() : JdbcManagedToolResultStore.parse((String) value);
    }

    private void ensureLedgers() {
        if (ledgerScanId == 0) {
            Long roundEnd = jdbc.queryForObject("SELECT MAX(id) FROM ma_session", Long.class);
            ledgerScanRoundEnd = roundEnd == null ? 0 : roundEnd;
        }
        long current = ToolPublicationRetentionStore.now(jdbc);
        long due = current - properties.getToolPublication().getDeletionGrace().toMillis();
        // Keep every source id in the page so existing ledgers and live Sessions also advance it.
        var page = jdbc.query(
                "SELECT s.*, CASE WHEN s.retired_at <= ? AND NOT EXISTS"
                    + " (SELECT 1 FROM ma_operation o WHERE o.operation_kind = 'SESSION_RESOURCE_GC'"
                    + " AND o.scope_kind = 'SESSION' AND CAST(o.scope_id AS BINARY(512)) ="
                    + " CAST(s.session_id AS BINARY(512))"
                    + " AND CAST(o.target_id AS BINARY(512)) = CAST(s.session_id AS BINARY(512))"
                    + " LIMIT 1) THEN 1 ELSE 0 END AS needs_ledger FROM"
                    + " (SELECT id, tenant_id, session_id, retired_at"
                    + " FROM ma_session WHERE id > ? AND id <= ? ORDER BY id LIMIT " + SCAN_ROWS + ") s ORDER BY s.id",
                (row, index) -> ManagedSchemaRows.read(row), due, ledgerScanId, ledgerScanRoundEnd);
        for (var row : page) {
            if (!ToolPublicationRetentionStore.flag(row, "needs_ledger")) {
                continue;
            }
            transactions.executeWithoutResult(status -> {
                String tenant = (String) row.get("tenant_id");
                String session = (String) row.get("session_id");
                ToolPublicationRetentionStore.lockGenericSession(jdbc, tenant, session);
                enqueue(jdbc, tenant, session, current);
            });
        }
        long lastId = page.isEmpty() ? 0 : ToolPublicationRetentionStore.number(page.getLast(), "id");
        ledgerScanId = page.size() < SCAN_ROWS || lastId >= ledgerScanRoundEnd ? 0 : lastId;
    }

    // Caller owns the transaction and Session locks, including on retirement replay.
    static void enqueue(JdbcTemplate jdbc, String tenant, String session, long current) {
        String request = JSON.createObjectNode().put("version", 1).put("sessionId", session).toString();
        jdbc.update(
                "INSERT IGNORE INTO ma_operation (operation_ref, scope_kind, scope_id, operation_id, operation_kind, tenant_id, session_id, target_kind, target_id, request_digest, request_json, phase, state, gmt_create, gmt_modified) VALUES (?, 'SESSION', ?, ?, 'SESSION_RESOURCE_GC', ?, ?, 'SESSION', ?, ?, ?, 'COLLECTING', 'PENDING', ?, ?)",
                operationKey(tenant, session), session, operationId(session), tenant, session, session,
                ManagedSchemaKeys.key(request), request, current, current);
    }

    static void enqueueCollections(JdbcTemplate jdbc, String tenant, String session, long time) {
        enqueue(jdbc, tenant, session, time);
        var captures = jdbc.query(
                "SELECT scope_ref, publication_id, tenant_id, workspace_id, session_id"
                    + " FROM ma_output_capture WHERE tenant_id = ? AND session_id = ?"
                    + " AND retention_state = 'RETIRING' ORDER BY publication_id",
                (row, index) -> ManagedSchemaRows.read(row), tenant, session);
        ToolPublicationCollector.enqueue(jdbc, captures, time);
    }

    Claim claim() {
        long time = ToolPublicationRetentionStore.now(jdbc);
        var candidates = jdbc.query(
                        "SELECT scope_id, tenant_id, session_id FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC' AND state <> 'SUCCEEDED' AND available_at >= 0 AND available_at <= ? AND (claim_owner = ? OR claim_until IS NULL OR claim_until <= ?) ORDER BY available_at, operation_ref LIMIT 32",
                (row, index) -> ManagedSchemaRows.read(row), time, owner, time);
        for (var candidate : candidates) {
            Claim claim =
                    JdbcManagedSessionStore.skipContended(
                            transactions,
                            status -> {
                                String tenant = (String) candidate.get("tenant_id");
                                String session = (String) candidate.get("session_id");
                                String scope = (String) candidate.get("scope_id");
                                JdbcManagedSessionStore.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(
                                        jdbc, tenant, JdbcManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
                                var head =
                                        ToolPublicationRetentionStore.lockSessionHead(
                                                jdbc, tenant, session);
                                var row =
                                        jdbc.query(
                                                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE operation_ref = ? AND operation_kind = 'SESSION_RESOURCE_GC' FOR UPDATE",
                                                        (result, index) ->
                                                                ManagedSchemaRows.read(result),
                                                        operationKey(tenant, scope))
                                                .getFirst();
                                long now = ToolPublicationRetentionStore.now(jdbc);
                                if ("SUCCEEDED".equals(row.get("state"))
                                        || ToolPublicationRetentionStore.number(row, "available_at")
                                                > now) {
                                    return null;
                                }
                                Number until = (Number) row.get("claim_until_epoch");
                                if (row.get("claim_owner") != null
                                        && !owner.equals(row.get("claim_owner"))
                                        && until != null
                                        && until.longValue() > now) {
                                    return null;
                                }
                                String blocker = blocker(tenant, session, now, head);
                                JsonNode body = progress(row);
                                if (blocker != null) {
                                    long next = now + CLAIM_MILLIS;
                                    if ("recovery_protected".equals(blocker)) {
                                        next = now + PROTECTED_RECHECK_MILLIS;
                                    } else if ("grace_period".equals(blocker)) {
                                        long retiredAt =
                                                jdbc.queryForObject(
                                                        "SELECT retired_at FROM ma_session WHERE"
                                                            + " tenant_id = ? AND session_id = ?",
                                                        Long.class,
                                                        tenant,
                                                        session);
                                        next =
                                                Math.addExact(
                                                        retiredAt,
                                                        properties
                                                                .getToolPublication()
                                                                .getDeletionGrace()
                                                                .toMillis());
                                    } else if ("reader_active".equals(blocker)) {
                                        // A graceful close deletes the row without moving the
                                        // scheduled instant; the claim interval bounds that path.
                                        next = Math.min(next, ToolPublicationRetentionStore
                                                .earliestReadLeaseExpiry(jdbc, tenant, session));
                                    }
                                    if (!blocker.equals(row.get("failure_code"))) {
                                        LOG.info(
                                                "Stream capture collection held scope={}"
                                                        + " blocker={}",
                                                scope,
                                                blocker);
                                    }
                                    jdbc.update(
                                            "UPDATE ma_operation SET failure_code = ?, available_at = ?, gmt_modified = ? WHERE operation_ref = ?",
                                            blocker,
                                            next,
                                            now,
                                            operationKey(tenant, scope));
                                    return null;
                                }
                                long generation =
                                        ToolPublicationRetentionStore.number(
                                                        row, "claim_generation")
                                                + 1;
                                jdbc.update(
                                        "UPDATE ma_operation SET claim_generation = ?, claim_owner = ?, claim_until = ?, failure_code = NULL, state = 'LEASED', gmt_modified = ? WHERE operation_ref = ?",
                                        generation,
                                        owner,
                                        now + CLAIM_MILLIS,
                                        now,
                                        operationKey(tenant, scope));
                                return new Claim(
                                        scope,
                                        tenant,
                                        session,
                                        generation,
                                        body.path("cursor").asText(""));
                            });
            if (claim != null) {
                return claim;
            }
        }
        return null;
    }

    private String blocker(String tenant, String session, long now, java.util.Map<String, Object> head) {
        var roots =
                jdbc.query(
                        "SELECT retired_at, is_recovery_protected FROM ma_session WHERE tenant_id = ?"
                                + " AND session_id = ? AND retired_at IS NOT NULL",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        tenant,
                        session);
        if (roots.isEmpty()) {
            return "session_not_retired";
        }
        if (ToolPublicationRetentionStore.flag(roots.getFirst(), "is_recovery_protected")) {
            return "recovery_protected";
        }
        if (ToolPublicationRetentionStore.number(roots.getFirst(), "retired_at")
                > now - properties.getToolPublication().getDeletionGrace().toMillis()) {
            return "grace_period";
        }
        // A missing head is a closed writer: publishing requires one, and retirement fences
        // creation.
        if (head != null && !"DELETED".equals(head.get("state"))) {
            return "session_head_live";
        }
        long leases =
                jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_read_lease"
                                + " WHERE tenant_id = ? AND session_id = ? AND expires_at > ?",
                        Long.class,
                        tenant,
                        session,
                        now);
        if (leases > 0) {
            return "reader_active";
        }
        if (!jdbc.query(
                        "SELECT operation_ref FROM ma_operation WHERE tenant_id = ? AND session_id = ? AND"
                                + " operation_kind = 'OBJECT_PUT' AND state <> 'RETURNED' LIMIT 1",
                (row, index) -> row.getString(1), tenant, session).isEmpty()) {
            return "put_unresolved";
        }
        // The relay's classifications are all terminal (its discovery page and claim exclude
        // them): an `unknown` walk is never rewritten, so holding for it would hold forever. A
        // close still owed rides its own CHILD_SESSION_CLOSE row and reads no parent resource.
        if (!jdbc.query(
                        "SELECT operation_ref FROM ma_operation WHERE tenant_id = ? AND session_id = ? AND"
                            + " operation_kind = 'CHILD_SESSION_START' AND state NOT IN ('done',"
                            + " 'orphaned', 'unknown') LIMIT 1",
                (row, index) -> row.getString(1), tenant, session).isEmpty()) {
            return "child_start_unresolved";
        }
        // A recovery capture or verification reads a retired Session's bytes through
        // WorkspaceRecoveryReader without a read lease, so only a live operation state can
        // observe that reader; the session rows are never deleted and cannot key the check.
        return recoveryInFlight(tenant, session, false) ? "recovery_active" : null;
    }

    private boolean recoveryInFlight(String tenant, String session, boolean locking) {
        return !jdbc.query(
                        "SELECT w.operation_ref FROM ma_operation_work w JOIN ma_operation o ON"
                            + " o.operation_ref = w.operation_ref WHERE w.tenant_id = ? AND"
                            + " w.session_id = ? AND w.work_kind = 'SESSION' AND o.operation_kind ="
                            + " 'WORKSPACE_RECOVERY' AND o.state IN ('CAPTURING', 'VERIFYING')"
                            + " LIMIT 1" + (locking ? " FOR UPDATE" : ""),
                (row, index) -> row.getString(1), tenant, session).isEmpty();
    }

    private Boolean page(Claim claim) {
        // Session locks precede the ledger row lock, matching claim()'s order.
        JdbcManagedSessionStore.lockBounded(() -> ToolPublicationRetentionStore.lockTenant(
                jdbc, claim.tenant(), JdbcManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        var head = ToolPublicationRetentionStore.lockSessionHead(jdbc, claim.tenant(), claim.session());
        var row =
                jdbc.query(
                                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + ", claim_until AS claim_until_epoch FROM ma_operation WHERE operation_ref = ? AND operation_kind = 'SESSION_RESOURCE_GC' FOR UPDATE",
                                (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                                operationKey(claim.tenant(), claim.scope()))
                        .getFirst();
        long now = ToolPublicationRetentionStore.now(jdbc);
        if ("SUCCEEDED".equals(row.get("state"))
                || !owner.equals(row.get("claim_owner"))
                || ToolPublicationRetentionStore.number(row, "claim_generation")
                        != claim.generation()
                || (row.get("claim_until") == null
                        || ((Number) row.get("claim_until_epoch")).longValue() <= now)
                || !claim.cursor().equals(progress(row).path("cursor").asText(""))) {
            return false;
        }
        // blocker() ran in claim()'s already-committed transaction; a recovery registered in the
        // claim→page gap is invisible to a plain re-read under REPEATABLE READ, so re-check with a
        // locking read before dropping bytes that have no other copy.
        if (blocker(claim.tenant(), claim.session(), now, head) != null
                || recoveryInFlight(claim.tenant(), claim.session(), true)) {
            return false;
        }
        if (ManagedSessionRetirementStore.deleteOwnerBatch(jdbc, claim.tenant(), claim.session(), PAGE_ROWS)
                || deleteArtifactBatch(claim.tenant(), claim.session())) {
            jdbc.update(
                    "UPDATE ma_operation SET phase = 'RELEASING_OWNERS', claim_until = ?, gmt_modified = ? WHERE operation_ref = ? AND claim_generation = ?",
                    now + CLAIM_MILLIS, now, operationKey(claim.tenant(), claim.scope()), claim.generation());
            return true;
        }
        var rows = jdbc.query(RESOURCE_PAGE, (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), claim.tenant(),
                claim.session(), claim.cursor());
        long bytes = 0;
        var ids = new java.util.ArrayList<String>(PAGE_ROWS);
        String cursor = claim.cursor();
        boolean more = rows.size() > PAGE_ROWS;
        for (var candidate : rows.subList(0, Math.min(rows.size(), PAGE_ROWS))) {
            boolean collectible = ToolPublicationRetentionStore.flag(candidate, "collectible");
            long length =
                    collectible
                            ? ToolPublicationRetentionStore.number(candidate, "byte_length")
                            : 0;
            if (!ids.isEmpty() && bytes + length > PAGE_BYTES) {
                // The row that did not fit stays eligible, so another page exists.
                more = true;
                break;
            }
            String resource = (String) candidate.get("resource_id");
            if (collectible) {
                ids.add(resource);
                bytes += length;
            }
            cursor = resource;
        }
        long freed = 0;
        if (!ids.isEmpty()) {
            var args = new java.util.ArrayList<Object>(ids.size() + 2);
            args.add(claim.tenant());
            args.add(claim.session());
            args.addAll(ids);
            String in = String.join(", ", java.util.Collections.nCopies(ids.size(), "?"));
            // Retirement fences new references; only this operation can collect these SQL bodies.
            jdbc.update(
                    "UPDATE ma_resource SET state = 'COLLECTED', inline_bytes = NULL,"
                        + " retention_until = NULL WHERE tenant_id = ? AND session_id = ? AND inline_bytes IS"
                        + " NOT NULL AND resource_id IN ("
                            + in + ")",
                    args.toArray());
            freed = jdbc.queryForObject(
                            "SELECT COALESCE(SUM(byte_length), 0) FROM ma_resource WHERE"
                                + " tenant_id = ? AND session_id = ? AND state = 'COLLECTED' AND resource_id"
                                + " IN ("
                                    + in + ")",
                    Long.class, args.toArray());
        }
        long total = Math.addExact(progress(row).path("collectedBytes").asLong(), freed);
        String result = JSON.createObjectNode().put("version", 1).put("cursor", cursor)
                .put("collectedBytes", total).toString();
        if (more) {
            jdbc.update(
                    "UPDATE ma_operation SET result_json = ?, claim_until = ?, gmt_modified = ? WHERE operation_ref = ? AND claim_generation = ?",
                    result, now + CLAIM_MILLIS, now, operationKey(claim.tenant(), claim.scope()), claim.generation());
        } else if (ManagedSessionRetirementStore.hasJournalPacks(jdbc, claim.tenant(), claim.session())) {
            jdbc.update("UPDATE ma_operation SET result_json = ?, state = 'PENDING', phase = 'WAITING_JOURNAL_PACKS',"
                            + " claim_owner = NULL, claim_until = NULL, available_at = ?, failure_code = NULL, gmt_modified = ?"
                            + " WHERE operation_ref = ? AND claim_generation = ?",
                    result, now + CLAIM_MILLIS, now, operationKey(claim.tenant(), claim.scope()), claim.generation());
        } else {
            jdbc.update(
                    "UPDATE ma_operation SET result_json = ?, state = 'SUCCEEDED', completed_at = ?, claim_owner = NULL, claim_until = NULL, available_at = "
                            + ManagedSchemaTime.NEVER_DUE_MILLIS
                            + ", failure_code = NULL, gmt_modified = ? WHERE operation_ref = ? AND claim_generation = ?",
                    result, now, now, operationKey(claim.tenant(), claim.scope()), claim.generation());
            ManagedSessionRetirementStore.markCollectionCompleted(jdbc, claim.tenant(), claim.session(),
                    operationKey(claim.tenant(), claim.scope()));
            jdbc.update(
                    "DELETE FROM ma_read_lease WHERE tenant_id = ? AND session_id = ? AND"
                            + " expires_at <= ?",
                    claim.tenant(), claim.session(), now);
            LOG.info("Stream capture collection completed scope={} bytes={}", claim.scope(), total);
        }
        return true;
    }

    private boolean deleteArtifactBatch(String tenant, String session) {
        String scope = JdbcManagedToolResultStore.scope(tenant, session);
        var artifacts = jdbc.query("SELECT artifact_id FROM ma_artifact WHERE scope_ref = ?"
                        + " ORDER BY creation_sequence, artifact_id LIMIT ? FOR UPDATE",
                (row, index) -> row.getString(1), scope, PAGE_ROWS);
        for (String artifact : artifacts) {
            jdbc.update(
                    "DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ? AND owner_kind ="
                            + " 'ARTIFACT' AND owner_ref = ?",
                    tenant,
                    session,
                    ManagedIdentityRefs.ref(ManagedIdentityRefs.OWNER_REF_BYTES, tenant, session, artifact));
            jdbc.update(
                    "DELETE FROM ma_artifact WHERE scope_ref = ? AND artifact_id = ?",
                    scope,
                    artifact);
        }
        return !artifacts.isEmpty();
    }

    private void defer(Claim claim) {
        transactions.executeWithoutResult(
                status -> {
                    ToolPublicationRetentionStore.lockGenericSession(
                            jdbc, claim.tenant(), claim.session());
                    jdbc.update(
                            "UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", claim_owner = NULL, claim_until = NULL,"
                                + " available_at = ?, failure_code = 'collection_retry', state ="
                                + " 'PENDING' WHERE operation_ref = ? AND operation_kind ="
                                + " 'SESSION_RESOURCE_GC' AND claim_owner = ? AND claim_generation"
                                + " = ?",
                            ToolPublicationRetentionStore.now(jdbc) + CLAIM_MILLIS,
                            operationKey(claim.tenant(), claim.scope()),
                            owner,
                            claim.generation());
                });
    }

    record Claim(String scope, String tenant, String session, long generation, String cursor) {}
}
