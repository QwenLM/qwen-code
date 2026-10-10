package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Durable Session-root protection; elapsed time never closes a physical PUT. */
public final class ToolPublicationRetentionStore {
    static final long READ_BUDGET_MILLIS = 120_000;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public ToolPublicationRetentionStore(JdbcTemplate jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
    }

    static String hash(String value) {
        return ToolPublicationContract.sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    static long now(JdbcTemplate jdbc) {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(),"
                + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
    }

    static void lockTenant(JdbcTemplate jdbc, String tenant) {
        String key = hash(tenant);
        jdbc.update("INSERT INTO qwen_tool_publication_tenant (tenant_key, tenant_id) VALUES (?, ?)"
                + " ON DUPLICATE KEY UPDATE tenant_key = tenant_key", key, tenant);
        String stored = jdbc.queryForObject("SELECT tenant_id FROM qwen_tool_publication_tenant"
                + " WHERE tenant_key = ? FOR UPDATE", String.class, key);
        ToolPublicationContract.require(tenant.equals(stored), "Retention tenant conflicts");
    }

    static void lockSession(JdbcTemplate jdbc, String tenant, String session) {
        lockTenant(jdbc, tenant);
        jdbc.queryForList("SELECT state FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", tenant, session);
    }

    static void requireLive(JdbcTemplate jdbc, String tenant, String session) {
        if (!jdbc.queryForList("SELECT generation FROM qwen_output_session_retirement"
                + " WHERE tenant_key = ? AND session_key = ?", hash(tenant), hash(session)).isEmpty()) {
            throw retired();
        }
    }

    static void lockDeletion(JdbcTemplate jdbc, String tenant, String session) {
        lockSession(jdbc, tenant, session);
        jdbc.queryForList("SELECT publication_id FROM qwen_tool_publication"
                + " WHERE tenant_id = ? AND session_id = ? ORDER BY publication_id FOR UPDATE", tenant, session);
    }

    static void retire(JdbcTemplate jdbc, String tenant, String session, String operation) {
        var existing = jdbc.queryForList("SELECT operation_id FROM qwen_output_session_retirement"
                + " WHERE tenant_key = ? AND session_key = ?", hash(tenant), hash(session));
        if (!existing.isEmpty()) {
            ToolPublicationContract.require(operation.equals(existing.getFirst().get("operation_id")),
                    "Session was retired by another operation");
            return;
        }
        var heads = jdbc.queryForList("SELECT state, recovery_status, CASE WHEN"
                + " writer_lease_until > CURRENT_TIMESTAMP(6) THEN 1 ELSE 0 END AS writer_active FROM"
                + " qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                tenant, session);
        long time = now(jdbc);
        boolean protectedRecovery = false;
        if (!heads.isEmpty()) {
            var head = heads.getFirst();
            if ("ACTIVE".equals(head.get("state"))
                    && ((Number) head.get("writer_active")).intValue() != 0) {
                throw new ApiException(HttpStatus.CONFLICT, "managed_session_writer_active",
                        "Session deletion is waiting for its writer to stop.");
            }
            protectedRecovery = !"READY".equals(head.get("recovery_status"));
        }
        jdbc.update("INSERT INTO qwen_output_session_retirement (tenant_key, session_key, tenant_id, session_id,"
                        + " operation_id, generation, retired_at, recovery_protected) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                hash(tenant), hash(session), tenant, session, operation, time, protectedRecovery);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'DELETED', writer_id = NULL,"
                + " writer_lease_until = NULL, lease_token_hash = NULL, latest_checkpoint_resource_id = NULL, o3_backfill_pending = FALSE,"
                + " updated_at = CURRENT_TIMESTAMP(6) WHERE tenant_id = ? AND session_id = ?", tenant, session);
        jdbc.update("UPDATE qwen_tool_publication SET retention_state = 'RETIRING' WHERE tenant_id = ?"
                + " AND session_id = ? AND retention_state = 'PINNED'", tenant, session);
        jdbc.update("UPDATE managed_agent_tool_result SET work_state = 'SUPPRESSED', claim_until = NULL,"
                + " failure_code = 'session_retired' WHERE scope_key = ? AND tenant_id = ? AND session_id = ?"
                + " AND work_state <> 'READY'", ManagedToolResultStore.scope(tenant, session), tenant, session);
    }

    private static void lockGenericParent(JdbcTemplate jdbc, String tenant, String session) {
        lockTenant(jdbc, tenant);
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenant, session);
    }

    static void lockGenericSession(JdbcTemplate jdbc, String tenant, String session) {
        lockGenericParent(jdbc, tenant, session);
        jdbc.queryForList("SELECT state FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", tenant, session);
    }

    private record PublicationTarget(String scope, String publication, String tenant,
            String workspace, String session) {}

    private PublicationTarget publicationTarget(String scope, String publication) {
        return publicationTarget(jdbc.queryForMap("SELECT scope_key, publication_id, tenant_id, workspace_id, session_id"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ?", scope, publication));
    }

    private static PublicationTarget publicationTarget(Map<String, Object> row) {
        return new PublicationTarget((String) row.get("scope_key"), (String) row.get("publication_id"),
                (String) row.get("tenant_id"), (String) row.get("workspace_id"), (String) row.get("session_id"));
    }

    private Map<String, Object> lockPublication(PublicationTarget target) {
        lockGenericSession(jdbc, target.tenant(), target.session());
        var current = jdbc.queryForMap("SELECT scope_key, publication_id, tenant_id, workspace_id, session_id, retention_state"
                + " FROM qwen_tool_publication WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                target.scope(), target.publication());
        ToolPublicationContract.require(target.equals(publicationTarget(current)), "Publication scope conflicts");
        return current;
    }

    void lockRetainedPublication(String scope, String publication) {
        var current = lockPublication(publicationTarget(scope, publication));
        ToolPublicationContract.require(List.of("PINNED", "RETIRING").contains(current.get("retention_state")),
                "Publication is collected");
    }

    void quarantineResource(String scope, String resource, String objectKey) {
        transactions.executeWithoutResult(status -> {
            var row = jdbc.queryForMap("SELECT publication_id, slot_key FROM qwen_tool_publication_object"
                    + " WHERE scope_key = ? AND resource_id = ? AND object_key = ?", scope, resource, objectKey);
            String publication = (String) row.get("publication_id");
            String slot = (String) row.get("slot_key");
            lockRetainedPublication(scope, publication);
            var current = jdbc.queryForMap("SELECT resource_id, object_key FROM qwen_tool_publication_object"
                    + " WHERE scope_key = ? AND publication_id = ? AND slot_key = ? FOR UPDATE", scope, publication, slot);
            ToolPublicationContract.require(resource.equals(current.get("resource_id"))
                    && objectKey.equals(current.get("object_key")), "Publication object conflicts");
            jdbc.update("UPDATE qwen_tool_publication SET quarantined = TRUE WHERE scope_key = ? AND publication_id = ?",
                    scope, publication);
            jdbc.update("UPDATE qwen_tool_publication_object SET state = 'QUARANTINED' WHERE scope_key = ?"
                    + " AND publication_id = ? AND slot_key = ? AND state = 'VERIFIED'", scope, publication, slot);
        });
    }

    public ReadLease readPublication(String scope, String publication) {
        var target = publicationTarget(scope, publication);
        return transactions.execute(status -> {
            lockPublication(target);
            return admitRead(target.tenant(), target.session());
        });
    }

    public java.io.InputStream open(String scope, String publication, String objectKey,
            ToolPublicationObjectStore objects) {
        return open(scope, publication, objectKey, objects, () -> {});
    }

    public java.io.InputStream open(String scope, String publication, String objectKey,
            ToolPublicationObjectStore objects, Runnable guard) {
        var lease = readPublication(scope, publication);
        try {
            var input = open(objectKey, objects, lease, guard);
            return new java.io.FilterInputStream(input) {
                @Override
                public void close() throws java.io.IOException {
                    try (lease) {
                        super.close();
                    }
                }
            };
        } catch (RuntimeException error) {
            try {
                lease.close();
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
    }

    java.io.InputStream open(String objectKey, ToolPublicationObjectStore objects,
            ReadLease lease, Runnable guard) {
        lease.check();
        guard.run();
        var input = objects.open(objectKey, () -> {
            lease.check();
            guard.run();
        });
        return new java.io.FilterInputStream(input) {
            @Override
            public int read() throws java.io.IOException {
                byte[] one = new byte[1];
                return read(one, 0, 1) < 0 ? -1 : one[0] & 255;
            }
            @Override
            public int read(byte[] bytes, int offset, int length) throws java.io.IOException {
                lease.check();
                guard.run();
                int result = in.readNBytes(bytes, offset, Math.min(length, 1024 * 1024));
                lease.check();
                guard.run();
                return result == 0 && length > 0 ? -1 : result;
            }
        };
    }

    public ReadLease read(JsonNode key) {
        return read(key.path("tenantId").asText(), key.path("sessionId").asText());
    }

    public ReadLease read(String tenant, String session) {
        return transactions.execute(status -> {
            lockGenericSession(jdbc, tenant, session);
            return admitRead(tenant, session);
        });
    }

    private ReadLease admitRead(String tenant, String session) {
        requireLive(jdbc, tenant, session);
        String id = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO qwen_output_read_lease (lease_id, tenant_key, session_key,"
                        + " retirement_generation, expires_at) VALUES (?, ?, ?, 0, ?)",
                id, hash(tenant), hash(session), Math.addExact(now(jdbc), READ_BUDGET_MILLIS));
        return new ReadLease(id, tenant, session);
    }

    public final class ReadLease implements AutoCloseable {
        private final String id;
        private final String tenant;
        private final String session;
        private boolean closed;

        private ReadLease(String id, String tenant, String session) {
            this.id = id;
            this.tenant = tenant;
            this.session = session;
        }

        void requireScope(JsonNode key) {
            requireScope(key.path("tenantId").asText(), key.path("sessionId").asText());
        }

        void requireScope(String requestedTenant, String requestedSession) {
            ToolPublicationContract.require(tenant.equals(requestedTenant)
                    && session.equals(requestedSession), "Read lease scope conflicts");
        }

        public void check() {
            transactions.executeWithoutResult(status -> {
                lockGenericParent(jdbc, tenant, session);
                var rows = jdbc.queryForList("SELECT tenant_key, session_key, expires_at, retirement_generation"
                        + " FROM qwen_output_read_lease WHERE lease_id = ? FOR UPDATE", id);
                var current = jdbc.queryForMap("SELECT CAST(UNIX_TIMESTAMP() AS DECIMAL(20, 0)) * 1000"
                        + " + EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) / 1000 AS db_now,"
                        + " (SELECT generation FROM qwen_output_session_retirement"
                        + " WHERE tenant_key = ? AND session_key = ?) AS generation", hash(tenant), hash(session));
                if (closed || rows.size() != 1
                        || !hash(tenant).equals(rows.getFirst().get("tenant_key"))
                        || !hash(session).equals(rows.getFirst().get("session_key"))
                        || ((Number) rows.getFirst().get("expires_at")).longValue() <= ((Number) current.get("db_now")).longValue()
                        || ((Number) rows.getFirst().get("retirement_generation")).longValue() != 0
                        || current.get("generation") != null) {
                    throw new ApiException(HttpStatus.CONFLICT, "tool_output_read_expired",
                            "The output read lease expired or its Session was retired.");
                }
            });
        }

        @Override
        public void close() {
            if (closed) {
                return;
            }
            transactions.executeWithoutResult(status -> {
                lockGenericParent(jdbc, tenant, session);
                var rows = jdbc.queryForList("SELECT tenant_key, session_key FROM qwen_output_read_lease"
                        + " WHERE lease_id = ? FOR UPDATE", id);
                ToolPublicationContract.require(rows.isEmpty()
                        || hash(tenant).equals(rows.getFirst().get("tenant_key"))
                            && hash(session).equals(rows.getFirst().get("session_key")), "Read lease scope conflicts");
                jdbc.update("DELETE FROM qwen_output_read_lease WHERE lease_id = ? AND tenant_key = ? AND session_key = ?",
                        id, hash(tenant), hash(session));
                TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                    @Override public void afterCompletion(int completion) {
                        if (completion != STATUS_COMMITTED) {
                            closed = false;
                        }
                    }
                });
                closed = true;
            });
        }
    }

    private record PutAttempt(String id, PublicationTarget target, String objectKey) {}

    public void put(JsonNode key, String scope, String publication, String objectKey,
            byte[] bytes, ToolPublicationObjectStore objects) {
        PutAttempt attempt = transactions.execute(status -> {
            var target = publicationTarget(scope, publication);
            var current = lockPublication(target);
            ToolPublicationContract.require(target.tenant().equals(key.path("tenantId").asText())
                    && target.workspace().equals(key.path("workspaceId").asText())
                    && target.session().equals(key.path("sessionId").asText()), "Publication scope conflicts");
            requireLive(jdbc, target.tenant(), target.session());
            ToolPublicationContract.require("PINNED".equals(current.get("retention_state")), "Publication is retired");
            String id = UUID.randomUUID().toString();
            jdbc.update("INSERT INTO qwen_output_put_attempt (attempt_id, scope_key, publication_id, object_key,"
                            + " state, started_at) VALUES (?, ?, ?, ?, 'IN_FLIGHT', ?)",
                    id, scope, publication, objectKey, now(jdbc));
            return new PutAttempt(id, target, objectKey);
        });
        try {
            objects.putIfAbsent(objectKey, bytes);
        } catch (RuntimeException error) {
            try {
                completePut(attempt, false);
            } catch (RuntimeException cleanup) {
                error.addSuppressed(cleanup);
            }
            throw error;
        }
        completePut(attempt, true);
    }

    private void completePut(PutAttempt attempt, boolean returned) {
        transactions.executeWithoutResult(status -> {
            var discovered = jdbc.queryForMap("SELECT scope_key, publication_id, object_key FROM qwen_output_put_attempt"
                    + " WHERE attempt_id = ?", attempt.id());
            var target = publicationTarget((String) discovered.get("scope_key"), (String) discovered.get("publication_id"));
            lockPublication(target);
            var current = jdbc.queryForMap("SELECT scope_key, publication_id, object_key, state FROM qwen_output_put_attempt"
                    + " WHERE attempt_id = ? FOR UPDATE", attempt.id());
            ToolPublicationContract.require(attempt.target().equals(target)
                    && target.scope().equals(current.get("scope_key"))
                    && target.publication().equals(current.get("publication_id"))
                    && attempt.objectKey().equals(discovered.get("object_key"))
                    && attempt.objectKey().equals(current.get("object_key"))
                    && "IN_FLIGHT".equals(current.get("state")), "PUT attempt conflicts");
            int updated = jdbc.update("UPDATE qwen_output_put_attempt SET state = ?, completed_at = ?"
                            + " WHERE attempt_id = ? AND scope_key = ? AND publication_id = ? AND object_key = ? AND state = 'IN_FLIGHT'",
                    returned ? "RETURNED" : "UNKNOWN", returned ? now(jdbc) : null,
                    attempt.id(), target.scope(), target.publication(), attempt.objectKey());
            ToolPublicationContract.require(updated == 1, "PUT attempt did not complete");
        });
    }

    public record Candidate(String scope, String publication, String tenant, String session,
            long bytes, String blocker) {}

    public List<Candidate> observe(Duration grace) {
        if (grace.isNegative()) {
            throw new IllegalArgumentException("Negative deletion grace");
        }
        return jdbc.queryForList("SELECT scope_key, publication_id, tenant_id, session_id,"
                + " capture_used_bytes, producer_used_bytes, admission_used_bytes, write_evidence,"
                + " quarantined, accepted_complete, producer_phase FROM qwen_tool_publication"
                + " WHERE retention_state = 'RETIRING'"
                + " ORDER BY scope_key, publication_id LIMIT 100").stream()
                .map(row -> candidate(row, grace)).toList();
    }

    Candidate candidate(Map<String, Object> row, Duration grace) {
        String scope = (String) row.get("scope_key");
        String publication = (String) row.get("publication_id");
        String tenant = (String) row.get("tenant_id");
        String session = (String) row.get("session_id");
        long bytes = number(row, "capture_used_bytes") + number(row, "producer_used_bytes")
                + number(row, "admission_used_bytes");
        var roots = jdbc.queryForList("SELECT retired_at, recovery_protected FROM qwen_output_session_retirement"
                + " WHERE tenant_key = ? AND session_key = ?", hash(tenant), hash(session));
        String blocker;
        if (roots.isEmpty()) {
            blocker = "session_not_retired";
        } else if (flag(roots.getFirst(), "recovery_protected")) {
            blocker = "recovery_protected";
        } else if (number(roots.getFirst(), "retired_at") > now(jdbc) - grace.toMillis()) {
            blocker = "grace_period";
        } else if (!flag(row, "write_evidence")) {
            blocker = "legacy_write_evidence_missing";
        } else if (flag(row, "quarantined")) {
            blocker = "quarantined";
        } else if (!"REFERENCED".equals(row.get("producer_phase")) || !flag(row, "accepted_complete")) {
            blocker = "not_accepted_complete";
        } else if (count("SELECT COUNT(*) FROM qwen_output_read_lease WHERE tenant_key = ? AND session_key = ?"
                + " AND expires_at > ?", hash(tenant), hash(session), now(jdbc)) != 0) {
            blocker = "reader_active";
        } else if (count("SELECT COUNT(*) FROM qwen_output_put_attempt WHERE scope_key = ? AND publication_id = ?"
                + " AND state <> 'RETURNED'", scope, publication) != 0) {
            blocker = "put_unresolved";
        } else if (count("SELECT COUNT(*) FROM qwen_tool_publication_operation WHERE scope_key = ?"
                + " AND publication_id = ? AND state <> 'SUCCEEDED'", scope, publication) != 0) {
            blocker = "operation_unresolved";
        } else if (count("SELECT COUNT(*) FROM qwen_tool_publication_object WHERE scope_key = ?"
                + " AND publication_id = ? AND state <> 'VERIFIED'", scope, publication) != 0) {
            blocker = "object_unverified";
        } else {
            blocker = null;
        }
        return new Candidate(scope, publication, tenant, session, bytes, blocker);
    }

    private long count(String sql, Object... args) { return jdbc.queryForObject(sql, Long.class, args); }
    static long number(Map<String, Object> row, String field) { return ((Number) row.get(field)).longValue(); }
    static boolean flag(Map<String, Object> row, String field) {
        Object value = row.get(field);
        return Boolean.TRUE.equals(value) || value instanceof Number number && number.intValue() != 0;
    }
    private static ApiException retired() {
        return new ApiException(HttpStatus.CONFLICT, "tool_output_session_retired",
                "The Session output is permanently retired.");
    }
}
