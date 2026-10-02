package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** One bounded page per tick; storage deletion never holds a database transaction. */
public final class ToolPublicationCollector {
    private static final Logger LOG = LoggerFactory.getLogger(ToolPublicationCollector.class);
    private static final long CLAIM_MILLIS = 60_000;
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
        Claim claim = claim();
        if (claim == null) {
            return false;
        }
        try {
            var page = jdbc.query("SELECT slot_key, object_key FROM qwen_tool_publication_object"
                            + " WHERE scope_key = ? AND publication_id = ? AND slot_key > ? ORDER BY slot_key LIMIT 100",
                    (row, index) -> new ObjectKey(row.getString("slot_key"), row.getString("object_key")),
                    claim.scope(), claim.publication(), claim.cursor());
            if (page.stream().anyMatch(object -> object.key() != null)) {
                objects.requireUnversioned();
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

    private boolean renew(Claim claim) {
        long now = ToolPublicationRetentionStore.now(jdbc);
        return jdbc.update("UPDATE qwen_tool_publication SET gc_claim_until = ? WHERE scope_key = ?"
                        + " AND publication_id = ? AND retention_state = 'DELETING' AND gc_owner = ?"
                        + " AND gc_generation = ? AND gc_claim_until > ?",
                now + CLAIM_MILLIS, claim.scope(), claim.publication(), owner, claim.generation(), now) == 1;
    }

    private void defer(Claim claim) {
        jdbc.update("UPDATE qwen_tool_publication SET gc_owner = NULL, gc_claim_until = 0, gc_next_at = ?,"
                        + " gc_blocker = 'collection_retry' WHERE scope_key = ? AND publication_id = ?"
                        + " AND retention_state = 'DELETING' AND gc_owner = ? AND gc_generation = ?",
                ToolPublicationRetentionStore.now(jdbc) + CLAIM_MILLIS,
                claim.scope(), claim.publication(), owner, claim.generation());
    }

    private Claim claim() {
        long time = ToolPublicationRetentionStore.now(jdbc);
        var candidates = jdbc.queryForList("SELECT scope_key, publication_id, tenant_id, session_id FROM"
                        + " qwen_tool_publication WHERE (retention_state = 'RETIRING' AND gc_next_at <= ?)"
                        + " OR (retention_state = 'DELETING' AND gc_next_at <= ? AND (gc_owner = ? OR gc_claim_until <= ?))"
                        + " ORDER BY gc_next_at, scope_key, publication_id LIMIT 32", time, time, owner, time);
        for (var candidate : candidates) {
            Claim claim = transactions.execute(status -> {
                String tenant = (String) candidate.get("tenant_id");
                String session = (String) candidate.get("session_id");
                ToolPublicationRetentionStore.lockSession(jdbc, tenant, session);
                var row = jdbc.queryForMap("SELECT * FROM qwen_tool_publication WHERE scope_key = ?"
                        + " AND publication_id = ? FOR UPDATE", candidate.get("scope_key"), candidate.get("publication_id"));
                long now = ToolPublicationRetentionStore.now(jdbc);
                if ("RETIRING".equals(row.get("retention_state"))) {
                    if (ToolPublicationRetentionStore.number(row, "gc_next_at") > now) {
                        return null;
                    }
                    Duration grace = properties.getToolPublication().getDeletionGrace();
                    var observed = retention.candidate(row, grace);
                    if (observed.blocker() != null) {
                        long next = now + CLAIM_MILLIS;
                        if ("grace_period".equals(observed.blocker())) {
                            long retiredAt = jdbc.queryForObject("SELECT retired_at FROM qwen_output_session_retirement"
                                            + " WHERE tenant_key = ? AND session_key = ?", Long.class,
                                    ToolPublicationRetentionStore.hash(tenant), ToolPublicationRetentionStore.hash(session));
                            next = Math.addExact(retiredAt, grace.toMillis());
                        }
                        jdbc.update("UPDATE qwen_tool_publication SET gc_blocker = ?, gc_next_at = ?"
                                        + " WHERE scope_key = ? AND publication_id = ?",
                                observed.blocker(), next, observed.scope(), observed.publication());
                        return null;
                    }
                } else if (ToolPublicationRetentionStore.number(row, "gc_next_at") > now
                        || !"DELETING".equals(row.get("retention_state"))
                        || !owner.equals(row.get("gc_owner"))
                        && ToolPublicationRetentionStore.number(row, "gc_claim_until") > now) {
                    return null;
                }
                long generation = ToolPublicationRetentionStore.number(row, "gc_generation") + 1;
                jdbc.update("UPDATE qwen_tool_publication SET retention_state = 'DELETING', gc_generation = ?,"
                                + " gc_owner = ?, gc_claim_until = ?, gc_blocker = NULL WHERE scope_key = ? AND publication_id = ?",
                        generation, owner, now + CLAIM_MILLIS, row.get("scope_key"), row.get("publication_id"));
                return new Claim((String) row.get("scope_key"), (String) row.get("publication_id"), tenant, session,
                        generation, (String) row.get("gc_cursor"));
            });
            if (claim != null) {
                return claim;
            }
        }
        return null;
    }

    private boolean confirm(Claim claim, List<ObjectKey> page) {
        ToolPublicationRetentionStore.lockSession(jdbc, claim.tenant(), claim.session());
        var row = jdbc.queryForMap("SELECT * FROM qwen_tool_publication WHERE scope_key = ?"
                + " AND publication_id = ? FOR UPDATE", claim.scope(), claim.publication());
        if (!"DELETING".equals(row.get("retention_state")) || !owner.equals(row.get("gc_owner"))
                || ToolPublicationRetentionStore.number(row, "gc_generation") != claim.generation()
                || ToolPublicationRetentionStore.number(row, "gc_claim_until") <= ToolPublicationRetentionStore.now(jdbc)
                || !claim.cursor().equals(row.get("gc_cursor"))) {
            return false;
        }
        String cursor = page.isEmpty() ? claim.cursor() : page.getLast().slot();
        var remaining = jdbc.queryForList("SELECT 1 FROM qwen_tool_publication_object"
                        + " WHERE scope_key = ? AND publication_id = ? AND slot_key > ? LIMIT 1",
                claim.scope(), claim.publication(), cursor);
        if (!remaining.isEmpty()) {
            jdbc.update("UPDATE qwen_tool_publication SET gc_cursor = ? WHERE scope_key = ? AND publication_id = ?",
                    cursor, claim.scope(), claim.publication());
            return true;
        }
        long collected = ToolPublicationRetentionStore.number(row, "capture_used_bytes")
                + ToolPublicationRetentionStore.number(row, "producer_used_bytes")
                + ToolPublicationRetentionStore.number(row, "admission_used_bytes");
        long released = ToolPublicationRetentionStore.number(row, "capture_held_bytes")
                + ToolPublicationRetentionStore.number(row, "producer_held_bytes")
                + ToolPublicationRetentionStore.number(row, "admission_held_bytes");
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = NULL WHERE session_scope_key = ? AND tenant_id = ?"
                        + " AND session_id = ? AND resource_id IN (SELECT resource_id FROM qwen_tool_publication_object"
                        + " WHERE scope_key = ? AND publication_id = ?)",
                ManagedSessionStore.sessionScopeKey(claim.tenant(), claim.session()),
                claim.tenant(), claim.session(), claim.scope(), claim.publication());
        jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = NULL, state = 'COLLECTED'"
                + " WHERE scope_key = ? AND publication_id = ?", claim.scope(), claim.publication());
        jdbc.update("UPDATE qwen_tool_publication SET retention_state = 'COLLECTED', gc_cursor = ?, collected_at = ?,"
                        + " collected_bytes = ?, released_held_bytes = ?, gc_owner = NULL, gc_claim_until = NULL,"
                        + " capture_held_bytes = 0, producer_held_bytes = 0, admission_held_bytes = 0,"
                        + " capture_used_bytes = 0, producer_used_bytes = 0, admission_used_bytes = 0"
                        + " WHERE scope_key = ? AND publication_id = ?",
                cursor, ToolPublicationRetentionStore.now(jdbc), collected, released, claim.scope(), claim.publication());
        jdbc.update("DELETE FROM qwen_output_read_lease WHERE tenant_key = ? AND session_key = ? AND expires_at <= ?",
                ToolPublicationRetentionStore.hash(claim.tenant()), ToolPublicationRetentionStore.hash(claim.session()),
                ToolPublicationRetentionStore.now(jdbc));
        return true;
    }

    private record Claim(String scope, String publication, String tenant, String session, long generation, String cursor) {}
    private record ObjectKey(String slot, String key) {}
}
