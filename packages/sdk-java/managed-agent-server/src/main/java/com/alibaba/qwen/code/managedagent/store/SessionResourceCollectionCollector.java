package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import java.time.Duration;
import java.util.UUID;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Collects {@code PUBLISHED} managed tool-result resources of permanently retired
 * Sessions; every page commits atomically because no object store is involved.
 */
public final class SessionResourceCollectionCollector {
    private static final Logger LOG = LoggerFactory.getLogger(SessionResourceCollectionCollector.class);
    private static final long CLAIM_MILLIS = 60_000;
    private static final long LEDGER_SCAN_NANOS = Duration.ofMinutes(1).toNanos();
    private static final long PROTECTED_RECHECK_MILLIS = Duration.ofHours(24).toMillis();
    private static final int PAGE_ROWS = 100;
    private static final long PAGE_BYTES = 32L * 1024 * 1024;
    private static final String ELIGIBLE = "SELECT resource_id, byte_length FROM qwen_managed_session_resource"
            + " WHERE session_scope_key = ? AND state = 'PUBLISHED' AND storage_kind = 'MYSQL_INLINE'"
            + " AND schema_version = 1 AND ("
            + " (kind = 'managed-tool-result-content' AND byte_length BETWEEN 1 AND "
            + ManagedSessionStore.toolResultLimit("managed-tool-result-content") + ")"
            + " OR (kind = 'managed-tool-result-page' AND byte_length BETWEEN 1 AND "
            + ManagedSessionStore.toolResultLimit("managed-tool-result-page") + ")"
            + " OR (kind = 'managed-tool-result-manifest' AND byte_length BETWEEN 1 AND "
            + ManagedSessionStore.toolResultLimit("managed-tool-result-manifest") + "))"
            + " AND object_key IS NULL AND object_version_id IS NULL AND encryption_key_id IS NULL"
            // The byte_length column is metadata that outlives the bytes: a row another writer
            // already freed has nothing left to collect and must not be counted a second time.
            + " AND inline_bytes IS NOT NULL"
            + " AND resource_id > ? AND NOT EXISTS (SELECT 1 FROM qwen_managed_session_resource_ref r"
            + " WHERE r.session_scope_key = qwen_managed_session_resource.session_scope_key"
            + " AND r.resource_id = qwen_managed_session_resource.resource_id)"
            + " ORDER BY resource_id LIMIT " + (PAGE_ROWS + 1);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ManagedAgentProperties properties;
    private final LongSupplier clock;
    private final String owner = UUID.randomUUID().toString();
    private long lastLedgerScanNanos;

    public SessionResourceCollectionCollector(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentProperties properties) {
        this(jdbc, manager, properties, System::nanoTime);
    }

    SessionResourceCollectionCollector(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedAgentProperties properties, LongSupplier clock) {
        Duration grace = properties.getToolPublication().getDeletionGrace();
        if (grace == null || grace.isNegative()) {
            throw new IllegalStateException("Tool output deletion grace must be nonnegative");
        }
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.properties = properties;
        this.clock = clock;
    }

    @Scheduled(fixedDelay = 1000, scheduler = "managedToolOutputScheduler")
    public synchronized void tick() {
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
        // History-wide due scans run at a coarse cadence; claim-time re-evaluation is authoritative.
        // The cadence reads a monotonic clock: a wall-clock step back (NTP, VM resume) would
        // otherwise keep the difference negative and silently stall ledger creation for the step.
        long scanNow = clock.getAsLong();
        if (scanNow - lastLedgerScanNanos >= LEDGER_SCAN_NANOS) {
            lastLedgerScanNanos = scanNow;
            ensureLedgers();
        }
        Claim claim = claim();
        if (claim == null) {
            return false;
        }
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

    private void ensureLedgers() {
        long due = ToolPublicationRetentionStore.now(jdbc)
                - properties.getToolPublication().getDeletionGrace().toMillis();
        var rows = jdbc.queryForList("SELECT r.tenant_key, r.session_key, r.tenant_id, r.session_id FROM"
                + " qwen_output_session_retirement r LEFT JOIN qwen_managed_session_resource_collection c"
                + " ON c.tenant_key = r.tenant_key AND c.session_key = r.session_key"
                + " WHERE c.tenant_key IS NULL AND r.retired_at <= ? ORDER BY r.retired_at LIMIT 32", due);
        for (var row : rows) {
            String tenant = (String) row.get("tenant_id");
            String session = (String) row.get("session_id");
            jdbc.update("INSERT INTO qwen_managed_session_resource_collection"
                    + " (session_scope_key, tenant_key, session_key, tenant_id, session_id, created_at)"
                    + " VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))"
                    + " ON DUPLICATE KEY UPDATE session_scope_key = session_scope_key",
                    ManagedSessionStore.sessionScopeKey(tenant, session),
                    row.get("tenant_key"), row.get("session_key"), tenant, session);
        }
    }

    private Claim claim() {
        long time = ToolPublicationRetentionStore.now(jdbc);
        // Completed ledgers sit at gc_next_at = -1 forever; the >= 0 predicate keeps this
        // per-second scan proportional to unfinished work instead of total ledger history.
        var candidates = jdbc.queryForList("SELECT session_scope_key, tenant_id, session_id FROM"
                + " qwen_managed_session_resource_collection WHERE collected_at IS NULL"
                + " AND gc_next_at >= 0 AND gc_next_at <= ? AND (gc_owner = ? OR gc_claim_until <= ?)"
                + " ORDER BY gc_next_at, session_scope_key LIMIT 32",
                time, owner, time);
        for (var candidate : candidates) {
            Claim claim = transactions.execute(status -> {
                String tenant = (String) candidate.get("tenant_id");
                String session = (String) candidate.get("session_id");
                ToolPublicationRetentionStore.lockSession(jdbc, tenant, session);
                var row = jdbc.queryForMap("SELECT * FROM qwen_managed_session_resource_collection"
                        + " WHERE session_scope_key = ? FOR UPDATE", candidate.get("session_scope_key"));
                long now = ToolPublicationRetentionStore.now(jdbc);
                if (row.get("collected_at") != null || ToolPublicationRetentionStore.number(row, "gc_next_at") > now) {
                    return null;
                }
                String held = (String) row.get("gc_owner");
                if (held != null && !held.equals(owner)
                        && ToolPublicationRetentionStore.number(row, "gc_claim_until") > now) {
                    return null;
                }
                String blocker = blocker(tenant, session, now);
                if (blocker != null) {
                    long next = now + CLAIM_MILLIS;
                    if ("recovery_protected".equals(blocker)) {
                        next = now + PROTECTED_RECHECK_MILLIS;
                    } else if ("grace_period".equals(blocker)) {
                        long retiredAt = jdbc.queryForObject("SELECT retired_at FROM qwen_output_session_retirement"
                                        + " WHERE tenant_key = ? AND session_key = ?", Long.class,
                                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session));
                        next = Math.addExact(retiredAt,
                                properties.getToolPublication().getDeletionGrace().toMillis());
                    }
                    if (!java.util.Objects.equals(row.get("gc_blocker"), blocker)) {
                        LOG.info("Stream capture collection blocked scope={} blocker={} nextAt={}",
                                row.get("session_scope_key"), blocker, next);
                    }
                    jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_blocker = ?, gc_next_at = ?"
                            + " WHERE session_scope_key = ?", blocker, next, row.get("session_scope_key"));
                    return null;
                }
                long generation = ToolPublicationRetentionStore.number(row, "gc_generation") + 1;
                jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_generation = ?, gc_owner = ?,"
                        + " gc_claim_until = ?, gc_blocker = NULL WHERE session_scope_key = ?",
                        generation, owner, now + CLAIM_MILLIS, row.get("session_scope_key"));
                return new Claim((String) row.get("session_scope_key"), generation,
                        (String) row.get("gc_cursor"));
            });
            if (claim != null) {
                return claim;
            }
        }
        return null;
    }

    private String blocker(String tenant, String session, long now) {
        var roots = jdbc.queryForList("SELECT retired_at, recovery_protected FROM qwen_output_session_retirement"
                + " WHERE tenant_key = ? AND session_key = ?",
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session));
        if (roots.isEmpty()) {
            return "session_not_retired";
        }
        if (ToolPublicationRetentionStore.flag(roots.getFirst(), "recovery_protected")) {
            return "recovery_protected";
        }
        if (ToolPublicationRetentionStore.number(roots.getFirst(), "retired_at")
                > now - properties.getToolPublication().getDeletionGrace().toMillis()) {
            return "grace_period";
        }
        var heads = jdbc.queryForList("SELECT state FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ?", tenant, session);
        // A missing head is a closed writer: publishing requires one, and retirement fences creation.
        if (!heads.isEmpty() && !"DELETED".equals(heads.getFirst().get("state"))) {
            return "session_head_live";
        }
        long leases = jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_read_lease"
                        + " WHERE tenant_key = ? AND session_key = ? AND expires_at > ?", Long.class,
                ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session), now);
        return leases == 0 ? null : "reader_active";
    }

    private Boolean page(Claim claim) {
        var row = jdbc.queryForMap("SELECT * FROM qwen_managed_session_resource_collection"
                + " WHERE session_scope_key = ? FOR UPDATE", claim.scope());
        long now = ToolPublicationRetentionStore.now(jdbc);
        if (row.get("collected_at") != null || !owner.equals(row.get("gc_owner"))
                || ToolPublicationRetentionStore.number(row, "gc_generation") != claim.generation()
                || ToolPublicationRetentionStore.number(row, "gc_claim_until") <= now
                || !claim.cursor().equals(row.get("gc_cursor"))) {
            return false;
        }
        var rows = jdbc.queryForList(ELIGIBLE, claim.scope(), claim.cursor());
        long bytes = 0;
        var ids = new java.util.ArrayList<String>(PAGE_ROWS);
        String cursor = claim.cursor();
        boolean more = rows.size() > PAGE_ROWS;
        for (var candidate : rows.subList(0, Math.min(rows.size(), PAGE_ROWS))) {
            long length = ToolPublicationRetentionStore.number(candidate, "byte_length");
            if (!ids.isEmpty() && bytes + length > PAGE_BYTES) {
                // The row that did not fit stays eligible, so another page exists.
                more = true;
                break;
            }
            String resource = (String) candidate.get("resource_id");
            ids.add(resource);
            bytes += length;
            cursor = resource;
        }
        if (!ids.isEmpty()) {
            var args = new java.util.ArrayList<Object>(ids.size() + 1);
            args.add(claim.scope());
            args.addAll(ids);
            jdbc.update("UPDATE qwen_managed_session_resource SET state = 'COLLECTED', inline_bytes = NULL"
                    + " WHERE session_scope_key = ? AND resource_id IN ("
                    + String.join(", ", java.util.Collections.nCopies(ids.size(), "?")) + ")", args.toArray());
        }
        if (more) {
            jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_cursor = ?,"
                    + " collected_bytes = collected_bytes + ?, gc_claim_until = ? WHERE session_scope_key = ?",
                    cursor, bytes, now + CLAIM_MILLIS, claim.scope());
        } else {
            jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_cursor = ?,"
                    + " collected_bytes = collected_bytes + ?, collected_at = ?, gc_owner = NULL,"
                    + " gc_claim_until = 0, gc_next_at = -1, gc_blocker = NULL WHERE session_scope_key = ?",
                    cursor, bytes, now, claim.scope());
            jdbc.update("DELETE FROM qwen_output_read_lease WHERE tenant_key = ? AND session_key = ?"
                    + " AND expires_at <= ?", ToolPublicationRetentionStore.hash((String) row.get("tenant_id")),
                    ToolPublicationRetentionStore.hash((String) row.get("session_id")), now);
            LOG.info("Stream capture collection completed scope={} bytes={}", claim.scope(),
                    ToolPublicationRetentionStore.number(row, "collected_bytes") + bytes);
        }
        return true;
    }

    private void defer(Claim claim) {
        jdbc.update("UPDATE qwen_managed_session_resource_collection SET gc_owner = NULL, gc_claim_until = 0,"
                + " gc_next_at = ?, gc_blocker = 'collection_retry'"
                + " WHERE session_scope_key = ? AND gc_owner = ? AND gc_generation = ?",
                ToolPublicationRetentionStore.now(jdbc) + CLAIM_MILLIS, claim.scope(), owner, claim.generation());
    }

    private record Claim(String scope, long generation, String cursor) {}
}
