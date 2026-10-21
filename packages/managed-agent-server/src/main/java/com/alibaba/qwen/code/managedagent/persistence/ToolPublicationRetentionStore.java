package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.ArgumentPreparedStatementSetter;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Durable Session-root protection; elapsed time never closes a physical PUT. */
public final class ToolPublicationRetentionStore {
    private static final ObjectMapper JSON = new ObjectMapper();
    static final long READ_BUDGET_MILLIS = 120_000;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public ToolPublicationRetentionStore(JdbcTemplate jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
    }

    static String hash(String value) {
        return ManagedSchemaKeys.key(value);
    }

    static long now(JdbcTemplate jdbc) {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(),"
                + " EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
    }

    static void lockTenant(JdbcTemplate jdbc, String tenant) {
        // A zero statement timeout is unlimited, the historical shape.
        lockTenant(jdbc, tenant, 0);
    }

    /**
     * Bounded variant for hot paths: each acquisition statement gives up
     * after {@code timeoutSeconds} rather than out-waiting the caller
     * (#13800).
     */
    static void lockTenant(JdbcTemplate jdbc, String tenant, int timeoutSeconds) {
        String key = hash(tenant);
        jdbc.execute((ConnectionCallback<Void>) connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES (?, ?, 'output_publication')"
                            + " ON DUPLICATE KEY UPDATE tenant_key = tenant_key")) {
                insert.setQueryTimeout(timeoutSeconds);
                insert.setString(1, key);
                insert.setBytes(2, ManagedSchemaKeys.identity(tenant));
                insert.executeUpdate();
            }
            try (PreparedStatement lock = connection.prepareStatement(
                    "SELECT tenant_id FROM ma_tenant_guard"
                            + " WHERE guard_domain = 'output_publication' AND tenant_key = ? FOR UPDATE")) {
                lock.setQueryTimeout(timeoutSeconds);
                lock.setString(1, key);
                try (ResultSet result = lock.executeQuery()) {
                    ToolPublicationContract.require(result.next() && tenant.equals(result.getString("tenant_id")),
                            "Retention tenant conflicts");
                }
            }
            return null;
        });
    }

    static void lockSession(JdbcTemplate jdbc, String tenant, String session) {
        lockSessionHead(jdbc, tenant, session);
    }

    /**
     * Per-Session root row only; takes no tenant-wide guard (#13800). Returns
     * the root's {@code csi_guard} as committed now: the read is a locking one.
     */
    static boolean lockSessionRoot(JdbcTemplate jdbc, String tenant, String session) {
        return lockSessionRoot(jdbc, tenant, session, false, 0);
    }

    private static boolean lockSessionRoot(
            JdbcTemplate jdbc, String tenant, String session, boolean legacyMutation, int timeoutSeconds) {
        long time = now(jdbc);
        // Behind a tenant guard this root wait can close a cycle with a
        // pinned CSI Session's continuation, which holds its root while it
        // waits for that guard; a deadlock victim here answers
        // tenant_guard_contended like the guard side (#13800 R1-1).
        return ManagedSessionStore.namedRootDeadlock(() -> {
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id, session_id, session_kind, tenant_key, session_key, session_scope_key, gmt_create, gmt_modified) VALUES (?, ?, 'CONTROL', ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE tenant_key = VALUES(tenant_key), session_key = VALUES(session_key), session_scope_key = VALUES(session_scope_key)",
                    boundedParameters(jdbc, timeoutSeconds, tenant, session, hash(tenant), hash(session),
                            ManagedSessionStore.sessionScopeKey(tenant, session), time, time));
            return jdbc.query(
                    "SELECT tenant_id, session_id, csi_guard FROM ma_session WHERE tenant_id = ? AND"
                            + " session_id = ? FOR UPDATE",
                    boundedParameters(jdbc, timeoutSeconds, tenant, session),
                    (row, index) -> {
                        boolean guarded = row.getBoolean("csi_guard");
                        if (legacyMutation) {
                            ManagedLegacySessionGuard.requireLegacyMutation(guarded);
                        }
                        return guarded;
                    }).getFirst();
        });
    }

    private static PreparedStatementSetter boundedParameters(
            JdbcTemplate jdbc, int timeoutSeconds, Object... parameters) {
        PreparedStatementSetter arguments = jdbc instanceof ManagedSchemaJdbcTemplate managed
                ? managed.newArgPreparedStatementSetter(parameters)
                : new ArgumentPreparedStatementSetter(parameters);
        return statement -> {
            if (timeoutSeconds > 0) {
                int existingTimeout = statement.getQueryTimeout();
                if (existingTimeout == 0 || existingTimeout > timeoutSeconds) {
                    statement.setQueryTimeout(timeoutSeconds);
                }
            }
            arguments.setValues(statement);
        };
    }

    static Map<String, Object> lockSessionHead(JdbcTemplate jdbc, String tenant, String session) {
        return lockSessionHead(jdbc, tenant, session, false);
    }

    private static Map<String, Object> lockSessionHead(
            JdbcTemplate jdbc, String tenant, String session, boolean legacyMutation) {
        // Bound the root and head waits as well: holding the tenant guard
        // behind one Session's writer must not convoy unrelated Sessions
        // until the database's default lock timeout (#14393 A.2).
        return ManagedSessionStore.lockBoundedResult(() -> {
            int timeoutSeconds = ManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS;
            lockTenant(jdbc, tenant, timeoutSeconds);
            lockSessionRoot(jdbc, tenant, session, legacyMutation, timeoutSeconds);
            var heads = jdbc.query(
                    "SELECT state FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION' AND"
                            + " tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id"
                            + " = ? FOR UPDATE",
                    boundedParameters(jdbc, timeoutSeconds, ManagedSchemaKeys.key(tenant),
                            ManagedSchemaKeys.key(session), tenant, session),
                    (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow));
            return heads.isEmpty() ? null : heads.getFirst();
        });
    }

    static void requireLive(JdbcTemplate jdbc, String tenant, String session) {
        if (!jdbc.query(
                        "SELECT retirement_generation FROM ma_session WHERE tenant_key = ? AND"
                                + " session_key = ? AND retired_at IS NOT NULL",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        hash(tenant),
                        hash(session))
                .isEmpty()) {
            throw retired();
        }
    }

    static void lockDeletion(JdbcTemplate jdbc, String tenant, String session) {
        lockGenericSession(jdbc, tenant, session);
        jdbc.query(
                "SELECT publication_id FROM ma_output_capture WHERE tenant_id = ? AND session_id ="
                        + " ? ORDER BY publication_id FOR UPDATE",
                (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                tenant,
                session);
    }

    static void retire(JdbcTemplate jdbc, String tenant, String session, String operation) {
        var existing =
                jdbc.query(
                        "SELECT retirement_operation_id AS operation_id FROM ma_session WHERE"
                                + " tenant_key = ? AND session_key = ? AND retired_at IS NOT NULL",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        hash(tenant),
                        hash(session));
        if (!existing.isEmpty()) {
            ToolPublicationContract.require(
                    operation.equals(existing.getFirst().get("operation_id")),
                    "Session was retired by another operation");
            return;
        }
        var heads =
                jdbc.query(
                        "SELECT state, recovery_status, CASE WHEN writer_lease_until > " + ManagedSchemaTime.SQL_NOW + " THEN 1 ELSE 0 END AS writer_active FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ? FOR UPDATE",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        ManagedSchemaKeys.key(tenant),
                        ManagedSchemaKeys.key(session),
                        tenant,
                        session);
        long time = now(jdbc);
        boolean protectedRecovery = false;
        if (!heads.isEmpty()) {
            var head = heads.getFirst();
            if ("ACTIVE".equals(head.get("state"))
                    && ((Number) head.get("writer_active")).intValue() != 0) {
                throw new ManagedAgentException(HttpStatus.CONFLICT, "managed_session_writer_active",
                        "Session deletion is waiting for its writer to stop.");
            }
            protectedRecovery = !"READY".equals(head.get("recovery_status"));
        }
        jdbc.update(
                "UPDATE ma_session SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", retirement_operation_id = ?, retirement_generation ="
                        + " retirement_generation + 1, retired_at = ?, recovery_protected = ? WHERE"
                        + " tenant_key = ? AND session_key = ? AND retired_at IS NULL",
                operation,
                time,
                protectedRecovery,
                hash(tenant),
                hash(session));
        jdbc.update(
                "UPDATE ma_session_head SET state = 'DELETED', writer_id = NULL, writer_lease_until = NULL, lease_token_hash = NULL, latest_checkpoint_resource_id = NULL, o3_backfill_pending = FALSE, gmt_modified = " + ManagedSchemaTime.SQL_NOW + " WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?",
                ManagedSchemaKeys.key(tenant),
                ManagedSchemaKeys.key(session),
                tenant,
                session);
        jdbc.update("UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", retention_state = 'RETIRING' WHERE tenant_id = ?"
                + " AND session_id = ? AND retention_state = 'PINNED'", tenant, session);
        jdbc.update(
                "UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = 'SUPPRESSED', claim_until = NULL, failure_code ="
                    + " 'session_retired' WHERE scope_key = ? AND tenant_id = ? AND session_id = ?"
                    + " AND operation_kind = 'TOOL_RESULT_PROJECTION' AND state <> 'READY'",
                ManagedToolResultStore.scope(tenant, session),
                tenant,
                session);
    }

    static Map<String, Object> lockGenericSession(
            JdbcTemplate jdbc, String tenant, String session) {
        return lockSessionHead(jdbc, tenant, session, true);
    }

    void lockRetainedPublication(String scope, String publication) {
        var row =
                jdbc.query(
                                "SELECT tenant_id, session_id FROM ma_output_capture"
                                        + " WHERE scope_key = ? AND publication_id = ?",
                                (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                                scope,
                                publication)
                        .getFirst();
        lockGenericSession(jdbc, (String) row.get("tenant_id"), (String) row.get("session_id"));
        String state =
                jdbc.queryForObject(
                        "SELECT retention_state FROM ma_output_capture"
                                + " WHERE scope_key = ? AND publication_id = ? FOR UPDATE",
                        String.class,
                        scope,
                        publication);
        ToolPublicationContract.require(
                List.of("PINNED", "RETIRING").contains(state), "Publication is collected");
    }

    void quarantineResource(String scope, String resource, String objectKey) {
        transactions.executeWithoutResult(
                status -> {
                    var row =
                            jdbc.query(
                                            "SELECT scope_key, publication_id, slot_key FROM"
                                                + " ma_resource WHERE scope_key = ? AND resource_id"
                                                + " = ? AND capture_object_key = ?",
                                            (schemaRow, schemaIndex) ->
                                                    ManagedSchemaRows.read(schemaRow),
                                            scope,
                                            resource,
                                            objectKey)
                                    .getFirst();
                    String publication = (String) row.get("publication_id");
                    lockRetainedPublication(scope, publication);
                    jdbc.update(
                            "UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", quarantined = TRUE WHERE scope_key = ?"
                                    + " AND publication_id = ?",
                            scope,
                            publication);
                    jdbc.update(
                            "UPDATE ma_resource SET capture_state = 'QUARANTINED' WHERE scope_key ="
                                + " ? AND publication_id = ? AND slot_key = ? AND capture_state ="
                                + " 'VERIFIED'",
                            scope,
                            publication,
                            row.get("slot_key"));
                });
    }

    public ReadLease readPublication(String scope, String publication) {
        var row =
                jdbc.query(
                                "SELECT tenant_id, session_id FROM ma_output_capture"
                                        + " WHERE scope_key = ? AND publication_id = ?",
                                (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                                scope,
                                publication)
                        .getFirst();
        return read((String) row.get("tenant_id"), (String) row.get("session_id"));
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
        return transactions.execute(
                status -> {
                    lockGenericSession(jdbc, tenant, session);
                    requireLive(jdbc, tenant, session);
                    long generation =
                            jdbc.queryForObject(
                                    "SELECT retirement_generation FROM ma_session"
                                            + " WHERE tenant_id = ? AND session_id = ?",
                                    Long.class,
                                    tenant,
                                    session);
                    String id = UUID.randomUUID().toString();
                    jdbc.update(
                            "INSERT INTO ma_read_lease (lease_id, tenant_key, session_key,"
                                    + " retirement_generation, expires_at) VALUES (?, ?, ?, ?, ?)",
                            id,
                            hash(tenant),
                            hash(session),
                            generation,
                            Math.addExact(now(jdbc), READ_BUDGET_MILLIS));
                    return new ReadLease(id, tenant, session, generation);
                });
    }

    public final class ReadLease implements AutoCloseable {
        private final String id;
        private final String tenant;
        private final String session;
        private final long generation;
        private boolean closed;

        private ReadLease(String id, String tenant, String session, long generation) {
            this.id = id;
            this.tenant = tenant;
            this.session = session;
            this.generation = generation;
        }

        void requireScope(JsonNode key) {
            requireScope(key.path("tenantId").asText(), key.path("sessionId").asText());
        }

        void requireScope(String requestedTenant, String requestedSession) {
            ToolPublicationContract.require(tenant.equals(requestedTenant)
                    && session.equals(requestedSession), "Read lease scope conflicts");
        }

        public synchronized void check() {
            check(true);
        }

        synchronized void checkReadView() {
            check(false);
        }

        private void check(boolean renew) {
            var rows =
                    jdbc.query(
                            "SELECT l.expires_at, l.retirement_generation, r.retirement_generation"
                                + " AS generation, r.retired_at, CAST(UNIX_TIMESTAMP() AS"
                                + " DECIMAL(20, 0)) * 1000 + EXTRACT(MICROSECOND FROM"
                                + " CURRENT_TIMESTAMP(6)) / 1000 AS db_now FROM ma_read_lease l"
                                + " LEFT JOIN ma_session r ON r.tenant_key = l.tenant_key AND"
                                + " r.session_key = l.session_key AND r.tenant_id = ? AND"
                                + " r.session_id = ? WHERE l.lease_id = ? AND l.tenant_key = ? AND"
                                + " l.session_key = ?",
                            (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                            tenant,
                            session,
                            id,
                            hash(tenant),
                            hash(session));
            if (closed || rows.size() != 1 || rows.getFirst().get("retired_at") != null
                    || number(rows.getFirst(), "expires_at") <= number(rows.getFirst(), "db_now")
                    || rows.getFirst().get("generation") == null
                    || number(rows.getFirst(), "retirement_generation") != generation
                    || number(rows.getFirst(), "generation") != generation) {
                throw expired();
            }
            var row = rows.getFirst();
            if (renew
                    && number(row, "expires_at") - number(row, "db_now")
                            <= READ_BUDGET_MILLIS * 3 / 4) {
                Boolean renewed = transactions.execute(status -> {
                    lockTenant(jdbc, tenant);
                    var roots = jdbc.query(
                                                    "SELECT retirement_generation, retired_at FROM"
                                                            + " ma_session WHERE tenant_id = ? AND"
                                                            + " session_id = ? FOR UPDATE",
                            (result, index) -> ManagedSchemaRows.read(result), tenant, session);
                    if (roots.size() != 1 || roots.getFirst().get("retired_at") != null
                            || number(roots.getFirst(), "retirement_generation") != generation) {
                        return false;
                    }
                    long time = now(jdbc);
                    return jdbc.update(
                                                    "UPDATE ma_read_lease SET expires_at = ? WHERE"
                                                            + " lease_id = ? AND tenant_key = ? AND"
                                                            + " session_key = ? AND"
                                                            + " retirement_generation = ? AND"
                                                            + " expires_at > ?",
                            Math.addExact(time, READ_BUDGET_MILLIS), id, hash(tenant), hash(session), generation, time) == 1;
                });
                if (!Boolean.TRUE.equals(renewed)) {
                    throw expired();
                }
            }
        }

        private ManagedAgentException expired() {
            return new ManagedAgentException(HttpStatus.CONFLICT, "tool_output_read_expired",
                    "The output read lease expired or its Session was retired.");
        }

        @Override
        public synchronized void close() {
            if (closed) {
                return;
            }
            closed = true;
            jdbc.update("DELETE FROM ma_read_lease WHERE lease_id = ?", id);
        }
    }

    private record PutAttempt(String key, String id, long generation, boolean reconcile) {}

    public void put(JsonNode key, String scope, String publication, String objectKey,
            byte[] bytes, ToolPublicationObjectStore objects) {
        String bodyDigest = ToolPublicationContract.sha256(bytes);
        String request =
                JSON.createObjectNode()
                        .put("version", 1)
                        .put("objectKey", objectKey)
                        .put("byteLength", bytes.length)
                        .put("sha256", bodyDigest)
                        .toString();
        String digest = ToolPublicationContract.sha256(request.getBytes(StandardCharsets.UTF_8));
        String target = ManagedSchemaKeys.key(objectKey);
        PutAttempt attempt =
                transactions.execute(
                        status -> {
                            String tenant = key.path("tenantId").asText();
                            String session = key.path("sessionId").asText();
                            lockGenericSession(jdbc, tenant, session);
                            requireLive(jdbc, tenant, session);
                            var rows =
                                    jdbc.query(
                                            "SELECT retention_state FROM ma_output_capture WHERE"
                                                + " scope_key = ? AND publication_id = ? AND"
                                                + " tenant_id = ? AND session_id = ? FOR UPDATE",
                                            (row, index) -> row.getString(1),
                                            scope,
                                            publication,
                                            tenant,
                                            session);
                            ToolPublicationContract.require(
                                    rows.size() == 1 && "PINNED".equals(rows.getFirst()),
                                    "Publication is retired");
                            var previous =
                                    jdbc.query(
                                            "SELECT operation_key, operation_id, state,"
                                                + " claim_generation, request_digest, request_json"
                                                + " FROM ma_operation WHERE scope_key = ? AND"
                                                + " publication_id = ? AND operation_kind ="
                                                + " 'OBJECT_PUT' AND target_key = ? FOR UPDATE",
                                            (row, index) -> ManagedSchemaRows.read(row),
                                            scope,
                                            publication,
                                            target);
                            ToolPublicationContract.require(
                                    previous.size() <= 1, "Object write identity is ambiguous");
                            if (!previous.isEmpty()) {
                                var prior = previous.getFirst();
                                ToolPublicationContract.require(
                                        digest.equals(prior.get("request_digest"))
                                                && request.equals(prior.get("request_json")),
                                        "Object write content conflicts");
                                String id = (String) prior.get("operation_id");
                                String originalKey =
                                        ManagedSchemaKeys.operationKey(
                                                OperationKind.OBJECT_PUT, scope, target, id);
                                ToolPublicationContract.require(
                                        originalKey.equals(prior.get("operation_key")),
                                        "Object write identity conflicts");
                                if ("RETURNED".equals(prior.get("state"))) {
                                    return null;
                                }
                                if (List.of("UNKNOWN", "IN_FLIGHT").contains(prior.get("state"))) {
                                    return new PutAttempt(
                                            originalKey,
                                            id,
                                            number(prior, "claim_generation"),
                                            true);
                                }
                                throw unresolvedPut();
                            }
                            String id = UUID.randomUUID().toString();
                            String originalKey =
                                    ManagedSchemaKeys.operationKey(
                                            OperationKind.OBJECT_PUT, scope, target, id);
                            long time = now(jdbc);
                            jdbc.update(
                                    "INSERT INTO ma_operation (operation_key, session_scope_key, scope_key, operation_kind, operation_id, tenant_id, session_id, workspace_id, target_kind, target_key, publication_id, request_digest, request_json, state, phase, claim_generation, gmt_create, gmt_modified) VALUES (?, ?, ?, 'OBJECT_PUT', ?, ?, ?, ?, 'RESOURCE', ?, ?, ?, ?, 'IN_FLIGHT', 'PUT', 1, ?, ?)",
                                    originalKey,
                                    ManagedSessionStore.sessionScopeKey(tenant, session),
                                    scope,
                                    id,
                                    tenant,
                                    session,
                                    key.path("workspaceId").asText(),
                                    target,
                                    publication,
                                    digest,
                                    request,
                                    time,
                                    time);
                            return new PutAttempt(originalKey, id, 1, false);
                        });
        if (attempt == null) {
            return;
        }
        if (attempt.reconcile()) {
            // This operation exclusively owns one non-retried physical create. Its complete
            // immutable object proves that create committed, even if its SQL receipt was lost.
            try (var original = objects.open(objectKey)) {
                byte[] observed = original.readNBytes(bytes.length + 1);
                if (observed.length != bytes.length || !bodyDigest.equals(ToolPublicationContract.sha256(observed))) {
                    throw unresolvedPut();
                }
            } catch (java.io.IOException | RuntimeException error) {
                throw unresolvedPut();
            }
            String proof =
                    JSON.createObjectNode()
                            .put("version", 1)
                            .put("proof", "original_object")
                            .put("objectKey", objectKey)
                            .put("byteLength", bytes.length)
                            .put("sha256", bodyDigest)
                            .toString();
            Boolean settled = transactions.execute(status -> {
                lockRetainedPublication(scope, publication);
                int changed = jdbc.update(
                                                "UPDATE ma_operation SET state = 'RETURNED', result_json = ?, completed_at = ?, gmt_modified = ? WHERE operation_key = ? AND scope_key = ? AND publication_id = ? AND operation_kind = 'OBJECT_PUT' AND operation_id = ? AND target_key = ? AND request_digest = ? AND claim_generation = ? AND state IN ('UNKNOWN', 'IN_FLIGHT')",
                        proof, now(jdbc), now(jdbc), attempt.key(), scope, publication, attempt.id(), target,
                        digest, attempt.generation());
                return changed == 1 || !jdbc.query(
                                                        "SELECT 1 FROM ma_operation WHERE"
                                                            + " operation_key = ? AND"
                                                            + " operation_kind = 'OBJECT_PUT' AND"
                                                            + " operation_id = ? AND request_digest"
                                                            + " = ? AND claim_generation = ? AND"
                                                            + " state = 'RETURNED'",
                        (row, index) -> row.getInt(1), attempt.key(), attempt.id(), digest, attempt.generation()).isEmpty();
            });
            if (!Boolean.TRUE.equals(settled)) {
                throw unresolvedPut();
            }
            return;
        }
        try {
            objects.putIfAbsent(objectKey, bytes);
        } catch (RuntimeException error) {
            jdbc.update(
                    "UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = 'UNKNOWN' WHERE operation_key = ?"
                            + " AND claim_generation = ? AND state = 'IN_FLIGHT'",
                    attempt.key(),
                    attempt.generation());
            throw error;
        }
        jdbc.update(
                "UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = 'RETURNED', completed_at = ? WHERE operation_key ="
                        + " ? AND state = 'IN_FLIGHT' AND claim_generation = ?",
                now(jdbc),
                attempt.key(),
                attempt.generation());
    }

    private static ManagedAgentException unresolvedPut() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "tool_output_put_unresolved",
                "The original object write is unresolved; a new write is not admitted.");
    }

    public record Candidate(String scope, String publication, String tenant, String session,
            long bytes, String blocker) {}

    public List<Candidate> observe(Duration grace) {
        if (grace.isNegative()) {
            throw new IllegalArgumentException("Negative deletion grace");
        }
        return jdbc
                .query(
                        "SELECT scope_key, publication_id, tenant_id, session_id,"
                            + " capture_used_bytes, producer_used_bytes, admission_used_bytes,"
                            + " write_evidence, quarantined, accepted_complete, producer_phase FROM"
                            + " ma_output_capture WHERE retention_state = 'RETIRING' ORDER BY"
                            + " scope_key, publication_id LIMIT 100",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow))
                .stream()
                .map(row -> candidate(row, grace))
                .toList();
    }

    Candidate candidate(Map<String, Object> row, Duration grace) {
        String scope = (String) row.get("scope_key");
        String publication = (String) row.get("publication_id");
        String tenant = (String) row.get("tenant_id");
        String session = (String) row.get("session_id");
        long bytes = number(row, "capture_used_bytes") + number(row, "producer_used_bytes")
                + number(row, "admission_used_bytes");
        var roots =
                jdbc.query(
                        "SELECT retired_at, recovery_protected FROM ma_session WHERE tenant_key = ?"
                                + " AND session_key = ? AND retired_at IS NOT NULL",
                        (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                        hash(tenant),
                        hash(session));
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
        } else if (!"REFERENCED".equals(row.get("producer_phase"))
                || !flag(row, "accepted_complete")) {
            blocker = "not_accepted_complete";
        } else if (count(
                        "SELECT COUNT(*) FROM ma_read_lease WHERE tenant_key = ? AND session_key ="
                                + " ? AND expires_at > ?",
                        hash(tenant),
                        hash(session),
                        now(jdbc))
                != 0) {
            blocker = "reader_active";
        } else if (count(
                        "SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'OBJECT_PUT' AND"
                                + " scope_key = ? AND publication_id = ? AND state <> 'RETURNED'",
                        scope,
                        publication)
                != 0) {
            blocker = "put_unresolved";
        } else if (count(
                        "SELECT COUNT(*) FROM ma_operation WHERE operation_kind IN"
                            + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND scope_key ="
                            + " ? AND publication_id = ? AND state NOT IN ('SUCCEEDED', 'FAILED')",
                        scope,
                        publication)
                != 0) {
            blocker = "operation_unresolved";
        } else if (count(
                        "SELECT COUNT(*) FROM ma_resource WHERE scope_key = ?"
                                + " AND publication_id = ? AND capture_state <> 'VERIFIED'",
                        scope,
                        publication)
                != 0) {
            blocker = "object_unverified";
        } else if (recoveryActive(tenant, session)) {
            blocker = "recovery_active";
        } else if (count(
                        "SELECT COUNT(*) FROM ma_resource r JOIN ma_resource_ref f ON"
                                + " f.resource_key = r.resource_key WHERE r.scope_key = ? AND"
                                + " r.publication_id = ? AND f.owner_kind <> 'CAPTURE'",
                        scope,
                        publication)
                != 0) {
            blocker = "resource_referenced";
        } else {
            blocker = null;
        }
        return new Candidate(scope, publication, tenant, session, bytes, blocker);
    }

    private boolean recoveryActive(String tenant, String session) {
        boolean locking = org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive();
        return !jdbc.query(
                        "SELECT w.operation_key FROM ma_operation_work w JOIN ma_operation o ON"
                            + " o.operation_key = w.operation_key WHERE w.tenant_id = ? AND"
                            + " w.session_id = ? AND w.work_kind = 'SESSION' AND o.operation_kind ="
                            + " 'WORKSPACE_RECOVERY' AND o.state IN ('CAPTURING', 'VERIFYING')"
                            + " LIMIT 1"
                                + (locking ? " FOR UPDATE" : ""),
                (row, index) -> row.getString(1), tenant, session).isEmpty();
    }

    private long count(String sql, Object... args) { return jdbc.queryForObject(sql, Long.class, args); }
    static long number(Map<String, Object> row, String field) { return ((Number) row.get(field)).longValue(); }
    static boolean flag(Map<String, Object> row, String field) {
        Object value = row.get(field);
        return Boolean.TRUE.equals(value) || value instanceof Number number && number.intValue() != 0;
    }
    private static ManagedAgentException retired() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "tool_output_session_retired",
                "The Session output is permanently retired.");
    }
}
