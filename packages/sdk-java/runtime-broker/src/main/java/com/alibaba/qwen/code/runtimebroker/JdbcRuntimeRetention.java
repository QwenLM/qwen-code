package com.alibaba.qwen.code.runtimebroker;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import javax.sql.DataSource;

/** Bounded cleanup of unreferenced retired Runtime generations. */
public final class JdbcRuntimeRetention {
    private static final DateTimeFormatter CURSOR_TIMESTAMP = DateTimeFormatter
            .ofPattern("uuuu-MM-dd HH:mm:ss.SSSSSS").withZone(ZoneOffset.UTC);

    public interface ReferenceGuard {
        boolean bindingReferenced(Connection connection, RuntimeBindingRecord binding) throws SQLException;

        boolean executionReferenced(Connection connection, String executionCallId) throws SQLException;
    }

    public enum Phase { BINDINGS, EXECUTIONS, SESSIONS }

    public record Cursor(String bindingState, Instant lastActiveAt, String bindingId,
            Phase phase, String childState, String childKey) { }

    public record BatchResult(Cursor cursor, int bindingsScanned, int childrenScanned, int skipped,
            int executionsDeleted, int sessionsDeleted, int bindingsDeleted) { }

    private final DataSource dataSource;
    private final JdbcRuntimeBindingRepository bindings;
    private final ReferenceGuard references;

    public JdbcRuntimeRetention(DataSource dataSource, JdbcRuntimeBindingRepository bindings,
            ReferenceGuard references) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
        if (bindings == null || !bindings.usesDataSource(dataSource) || references == null) {
            throw new IllegalArgumentException("Native bindings and a reference guard on the same DataSource are required");
        }
        this.bindings = bindings;
        this.references = references;
    }

    public BatchResult sweep(Duration maxAge, int batchSize, Cursor cursor) {
        if (maxAge == null || maxAge.isZero() || maxAge.isNegative() || batchSize < 1 || batchSize > 1000) {
            throw new IllegalArgumentException("Positive maxAge and batchSize in [1, 1000] are required");
        }
        int inspected = 0;
        int children = 0;
        int skipped = 0;
        int executions = 0;
        int sessions = 0;
        int retired = 0;
        Cursor next = cursor;
        while (inspected < batchSize && children < batchSize && executions + sessions + retired < batchSize) {
            Cursor position = next;
            int childBudget = batchSize - children;
            int deleteBudget = batchSize - executions - sessions - retired;
            BatchResult part = transaction(connection -> visit(connection, maxAge, position, childBudget, deleteBudget));
            next = part.cursor();
            inspected += part.bindingsScanned();
            children += part.childrenScanned();
            skipped += part.skipped();
            executions += part.executionsDeleted();
            sessions += part.sessionsDeleted();
            retired += part.bindingsDeleted();
            if (next == null) {
                break;
            }
        }
        return new BatchResult(next, inspected, children, skipped, executions, sessions, retired);
    }

    private BatchResult visit(Connection connection, Duration maxAge, Cursor cursor,
            int childBudget, int deleteBudget) throws SQLException {
        Candidate candidate = candidate(connection, cursor, JdbcRepositorySupport.databaseNowPrecise(connection).minus(maxAge));
        if (candidate == null) {
            return new BatchResult(null, 0, 0, 0, 0, 0, 0);
        }
        Cursor afterBinding = candidate.cursor(Phase.BINDINGS, "", "");
        JdbcRuntimeBindingRepository.lockPlacementDomain(connection, candidate.tenantId(), 10);
        if (!lockSlot(connection, candidate)) {
            return skipped(afterBinding);
        }
        RuntimeBindingRecord binding;
        try {
            binding = bindings.findByIdForUpdate(connection, candidate.bindingId());
        } catch (IllegalArgumentException | IllegalStateException invalidEvidence) {
            // Invalid historical evidence must neither be deleted nor hold up the sweep.
            return skipped(afterBinding);
        }
        Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
        Instant cutoff = now.minus(maxAge);
        if (binding == null || !eligible(binding, cutoff, now)
                || operatorReferenced(connection, binding)
                || references.bindingReferenced(connection, binding)
                || hasNonterminalChildren(connection, binding)) {
            return skipped(afterBinding);
        }
        boolean resume = cursor != null && candidate.bindingId().equals(cursor.bindingId()) && cursor.phase() != Phase.BINDINGS;
        Phase phase = resume ? cursor.phase() : Phase.EXECUTIONS;
        String childState = resume ? cursor.childState() : "";
        String childKey = resume ? cursor.childKey() : "";
        int children = 0;
        int skipped = 0;
        int executions = 0;
        int sessions = 0;
        if (phase == Phase.EXECUTIONS) {
            List<Execution> rows = executions(connection, binding, childState, childKey, childBudget);
            for (Execution row : rows) {
                children++;
                childState = row.state();
                childKey = row.key();
                boolean completeLease = (row.owner() == null) == (row.leaseUntil() == null);
                Instant completed = "SETTLED".equals(row.state()) ? row.settledAt() : row.abandonedAt();
                if (completed != null && completed.isBefore(cutoff) && completeLease
                        && (row.leaseUntil() == null || !row.leaseUntil().isAfter(now))
                        && JdbcRepositorySupport.valueKey(row.callId()).equals(row.key())
                        && !references.executionReferenced(connection, row.callId())) {
                    delete(connection, "DELETE FROM qwen_tool_execution WHERE execution_call_id_hash = ? AND record_version = ?",
                            row.key(), row.version());
                    executions++;
                } else {
                    skipped++;
                }
                if (executions == deleteBudget) {
                    return new BatchResult(candidate.cursor(phase, childState, childKey), 1, children, skipped, executions, 0, 0);
                }
            }
            if (rows.size() == childBudget) {
                return new BatchResult(candidate.cursor(phase, childState, childKey), 1, children, skipped, executions, 0, 0);
            }
            phase = Phase.SESSIONS;
            childState = "";
            childKey = "";
        }
        int sessionBudget = childBudget - children;
        List<Session> rows = sessions(connection, binding, childState, childKey, sessionBudget);
        for (Session row : rows) {
            children++;
            childState = row.scopeKey();
            childKey = row.id();
            if (row.activeAt().isBefore(cutoff)
                    && JdbcRepositorySupport.scopeKey(binding.getRequest().getScope()).equals(row.scopeKey())
                    && !sessionReferenced(connection, binding, row.id())) {
                try (PreparedStatement statement = statement(connection,
                        "DELETE FROM qwen_runtime_session WHERE scope_key = ? AND runtime_session_id = ? AND record_version = ?")) {
                    statement.setString(1, row.scopeKey());
                    statement.setString(2, row.id());
                    statement.setLong(3, row.version());
                    requireDeleted(statement);
                }
                sessions++;
            } else {
                skipped++;
            }
            if (executions + sessions == deleteBudget) {
                return new BatchResult(candidate.cursor(phase, childState, childKey), 1, children, skipped, executions, sessions, 0);
            }
        }
        if (rows.size() == sessionBudget) {
            return new BatchResult(candidate.cursor(phase, childState, childKey), 1, children, skipped, executions, sessions, 0);
        }
        int retired = 0;
        if (!hasChildren(connection, binding) && !operatorReferenced(connection, binding)
                && !references.bindingReferenced(connection, binding)) {
            delete(connection, "DELETE FROM qwen_runtime_binding WHERE binding_id = ? AND record_version = ?",
                    binding.getBindingId(), binding.getVersion());
            retired = 1;
        }
        return new BatchResult(afterBinding, 1, children, skipped, executions, sessions, retired);
    }

    private static BatchResult skipped(Cursor cursor) {
        return new BatchResult(cursor, 1, 0, 1, 0, 0, 0);
    }

    private static boolean eligible(RuntimeBindingRecord binding, Instant cutoff, Instant now) {
        if (!binding.getLastActiveAt().isBefore(cutoff) || binding.hasLiveOperationAt(now)) {
            return false;
        }
        if (binding.getState() == RuntimeBindingRecord.State.RELEASED) {
            return !binding.getRequest().isManagedContext() || binding.getDrainReceipt() != null || binding.hasStoppedWriters();
        }
        String kind = binding.getRequest().getProvisionerKind();
        return binding.getState() == RuntimeBindingRecord.State.FAILED && !binding.getRequest().isManagedContext()
                && ("legacy".equals(kind) || "static".equals(kind)) && binding.getProvisionSeed() == null;
    }

    private static Candidate candidate(Connection connection, Cursor cursor, Instant cutoff) throws SQLException {
        boolean resume = cursor != null && cursor.phase() != Phase.BINDINGS;
        String sql = "SELECT binding_id, binding_state, last_active_at, tenant_id, request_key FROM qwen_runtime_binding "
                + (resume ? "WHERE binding_id = ?" : "WHERE binding_state IN ('FAILED', 'RELEASED') AND last_active_at < ?"
                + (cursor == null ? "" : " AND (binding_state > ? OR (binding_state = ? AND last_active_at > ?)"
                        + " OR (binding_state = ? AND last_active_at = ? AND binding_id > ?))")
                + " ORDER BY binding_state, last_active_at, binding_id LIMIT 1");
        try (PreparedStatement statement = statement(connection, sql)) {
            if (resume) {
                statement.setString(1, cursor.bindingId());
            } else {
                JdbcRepositorySupport.setInstant(statement, 1, cutoff);
                if (cursor != null) {
                    // Connector/J can drop Timestamp fractions with MariaDB's MySQL 5.5 compatibility handshake.
                    String lastActiveAt = CURSOR_TIMESTAMP.format(cursor.lastActiveAt());
                    statement.setString(2, cursor.bindingState());
                    statement.setString(3, cursor.bindingState());
                    statement.setString(4, lastActiveAt);
                    statement.setString(5, cursor.bindingState());
                    statement.setString(6, lastActiveAt);
                    statement.setString(7, cursor.bindingId());
                }
            }
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    if (resume) {
                        return candidate(connection, new Cursor(cursor.bindingState(), cursor.lastActiveAt(), cursor.bindingId(),
                                Phase.BINDINGS, "", ""), cutoff);
                    }
                    return null;
                }
                return new Candidate(result.getString("binding_id"), result.getString("binding_state"),
                        JdbcRepositorySupport.getInstant(result, "last_active_at"), result.getString("tenant_id"),
                        result.getString("request_key"));
            }
        }
    }

    private static boolean lockSlot(Connection connection, Candidate candidate) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT active_binding_id FROM qwen_runtime_binding_slot WHERE request_key = ? FOR UPDATE")) {
            statement.setString(1, candidate.requestKey());
            try (ResultSet result = statement.executeQuery()) {
                return result.next() && !candidate.bindingId().equals(result.getString("active_binding_id"));
            }
        }
    }

    private static boolean operatorReferenced(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        return exists(connection, "SELECT 1 FROM managed_workspace_operator_recovery WHERE binding_id = ?"
                + " AND runtime_generation = ? LIMIT 1", binding);
    }

    private static boolean hasNonterminalChildren(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        return exists(connection, "SELECT 1 FROM qwen_runtime_session WHERE binding_id = ? AND runtime_generation = ?"
                + " AND session_state NOT IN ('RELEASED', 'FAILED') LIMIT 1", binding)
                || exists(connection, "SELECT 1 FROM qwen_tool_execution WHERE binding_id = ? AND runtime_generation = ?"
                        + " AND execution_state NOT IN ('SETTLED', 'ABANDONED') LIMIT 1", binding);
    }

    private static boolean hasChildren(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        for (String table : List.of("qwen_tool_execution", "qwen_runtime_session")) {
            try (PreparedStatement statement = statement(connection, "SELECT 1 FROM " + table + " WHERE binding_id = ? LIMIT 1")) {
                statement.setString(1, binding.getBindingId());
                try (ResultSet result = statement.executeQuery()) {
                    if (result.next()) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static boolean exists(Connection connection, String sql, RuntimeBindingRecord binding) throws SQLException {
        try (PreparedStatement statement = statement(connection, sql)) {
            statement.setString(1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            try (ResultSet result = statement.executeQuery()) {
                return result.next();
            }
        }
    }

    private static boolean sessionReferenced(Connection connection, RuntimeBindingRecord binding, String id) throws SQLException {
        try (PreparedStatement statement = statement(connection, "SELECT 1 FROM qwen_tool_execution WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_key = ? LIMIT 1")) {
            statement.setString(1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            statement.setString(3, JdbcRepositorySupport.valueKey(id));
            try (ResultSet result = statement.executeQuery()) {
                return result.next();
            }
        }
    }

    private static List<Execution> executions(Connection connection, RuntimeBindingRecord binding, String state,
            String key, int limit) throws SQLException {
        List<Execution> rows = new ArrayList<>();
        try (PreparedStatement statement = statement(connection, "SELECT execution_state, execution_call_id_hash, execution_call_id,"
                + " settled_at, abandoned_at, dispatch_owner, dispatch_lease_until, record_version FROM qwen_tool_execution"
                + " WHERE binding_id = ? AND runtime_generation = ? AND execution_state IN ('SETTLED', 'ABANDONED')"
                + " AND (execution_state > ? OR (execution_state = ? AND execution_call_id_hash > ?))"
                + " ORDER BY execution_state, execution_call_id_hash LIMIT ? FOR UPDATE")) {
            statement.setString(1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            statement.setString(3, state);
            statement.setString(4, state);
            statement.setString(5, key);
            statement.setInt(6, limit);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    rows.add(new Execution(result.getString("execution_state"), result.getString("execution_call_id_hash"),
                            result.getString("execution_call_id"), JdbcRepositorySupport.getInstant(result, "settled_at"),
                            JdbcRepositorySupport.getInstant(result, "abandoned_at"), result.getString("dispatch_owner"),
                            JdbcRepositorySupport.getInstant(result, "dispatch_lease_until"), result.getLong("record_version")));
                }
            }
        }
        return rows;
    }

    private static List<Session> sessions(Connection connection, RuntimeBindingRecord binding, String scope,
            String key, int limit) throws SQLException {
        List<Session> rows = new ArrayList<>();
        try (PreparedStatement statement = statement(connection, "SELECT scope_key, runtime_session_id, last_active_at, record_version"
                + " FROM qwen_runtime_session WHERE binding_id = ? AND runtime_generation = ?"
                + " AND session_state IN ('RELEASED', 'FAILED') AND (scope_key > ? OR (scope_key = ? AND runtime_session_id > ?))"
                + " ORDER BY scope_key, runtime_session_id LIMIT ? FOR UPDATE")) {
            statement.setString(1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            statement.setString(3, scope);
            statement.setString(4, scope);
            statement.setString(5, key);
            statement.setInt(6, limit);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    rows.add(new Session(result.getString("scope_key"), result.getString("runtime_session_id"),
                            JdbcRepositorySupport.getInstant(result, "last_active_at"), result.getLong("record_version")));
                }
            }
        }
        return rows;
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void delete(Connection connection, String sql, String id, long version) throws SQLException {
        try (PreparedStatement statement = statement(connection, sql)) {
            statement.setString(1, id);
            statement.setLong(2, version);
            requireDeleted(statement);
        }
    }

    private static void requireDeleted(PreparedStatement statement) throws SQLException {
        if (statement.executeUpdate() != 1) {
            throw new SQLException("Retention deletion lost its locked row");
        }
    }

    private BatchResult transaction(JdbcRepositorySupport.SqlWork<BatchResult> work) {
        try (Connection connection = dataSource.getConnection()) {
            int isolation = connection.getTransactionIsolation();
            boolean autoCommit = connection.getAutoCommit();
            connection.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);
            connection.setAutoCommit(false);
            try {
                BatchResult result = work.run(connection);
                connection.commit();
                return result;
            } catch (SQLException | RuntimeException | Error failure) {
                try {
                    connection.rollback();
                } catch (SQLException rollbackFailure) {
                    failure.addSuppressed(rollbackFailure);
                }
                throw failure;
            } finally {
                connection.setAutoCommit(autoCommit);
                connection.setTransactionIsolation(isolation);
            }
        } catch (SQLException failure) {
            throw JdbcRepositorySupport.failure(failure);
        }
    }

    private record Candidate(String bindingId, String state, Instant activeAt, String tenantId, String requestKey) {
        Cursor cursor(Phase phase, String childState, String childKey) {
            return new Cursor(state, activeAt, bindingId, phase, childState, childKey);
        }
    }

    private record Execution(String state, String key, String callId, Instant settledAt, Instant abandonedAt,
            String owner, Instant leaseUntil, long version) { }

    private record Session(String scopeKey, String id, Instant activeAt, long version) { }
}
