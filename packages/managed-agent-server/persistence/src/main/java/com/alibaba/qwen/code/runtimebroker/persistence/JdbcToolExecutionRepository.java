package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.managedagent.persistence.JdbcJournalPacks;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeAdmission;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolHoldRow;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHoldFamily;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.fromJson;
import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.insertExecution;
import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.mapExecution;
import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.requireCandidate;
import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.requireReplacement;
import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.selectByExecutionId;
import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.updateExecution;

/** JDBC ledger for idempotent Tool executions. */
public final class JdbcToolExecutionRepository
        implements ToolExecutionRepository {
    static final String EXECUTION_COLUMNS = String.join(", ",
            "execution_call_id_hash", "execution_call_id",
            "idempotency_key_hash", "idempotency_key",
            "binding_id", "runtime_generation", "harness_session_id",
            "runtime_session_id", "runtime_session_key", "turn_id",
            "tool_call_id", "request_digest", "reference_json",
            "execution_state", "execution_status", "result_json",
            "last_sequence", "is_cancel_requested", "dispatch_owner",
            "dispatch_lease_until", "dispatch_generation", "record_version",
            "settled_at", "abandoned_at", "loss_evidence_id",
            "authorized_dispatch_generation", "authorized_binding_version");
    private final DataSource dataSource;
    private final JdbcRuntimeBindingRepository csiBindings;

    public JdbcToolExecutionRepository(DataSource dataSource) {
        this(dataSource, null);
    }

    public JdbcToolExecutionRepository(
            DataSource dataSource, JdbcRuntimeBindingRepository csiBindings) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
        if (csiBindings != null && !csiBindings.usesDataSource(this.dataSource)) {
            throw new IllegalArgumentException("CSI continuation requires the same DataSource");
        }
        this.csiBindings = csiBindings;
    }

    static void abandonByBinding(Connection connection, RuntimeBindingRecord binding)
            throws SQLException {
        List<ToolExecutionRecord> batch = new ArrayList<>();
        String sql = "SELECT " + EXECUTION_COLUMNS + " FROM ma_tool_execution "
                + "WHERE binding_id = ? AND runtime_generation = ? "
                + "AND execution_state NOT IN ('SETTLED', 'ABANDONED') "
                + "ORDER BY execution_call_id_hash LIMIT 100 FOR UPDATE";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            JdbcRepositorySupport.setIdentity(statement, 1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    ToolExecutionRecord record = mapExecution(result);
                    if (record.getBindingId().equals(binding.getBindingId())) {
                        batch.add(record);
                    }
                }
            }
        }
        Instant now = JdbcRepositorySupport.databaseNow(connection);
        for (ToolExecutionRecord record : batch) {
            updateExecution(connection, record.abandon(binding, now)
                    .withVersion(record.getVersion() + 1));
        }
    }

    static boolean hasActiveByBinding(Connection connection, String bindingId,
            long generation) throws SQLException {
        String sql = "SELECT binding_id FROM ma_tool_execution "
                + "WHERE binding_id = ? AND runtime_generation = ? "
                + "AND execution_state NOT IN ('SETTLED', 'ABANDONED')";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            JdbcRepositorySupport.setIdentity(statement, 1, bindingId);
            statement.setLong(2, generation);
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    if (bindingId.equals(result.getString("binding_id"))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    public static List<ToolExecutionRecord> findHarnessExecutions(Connection connection,
            String tenantId, String harnessSessionId) throws SQLException {
        List<ToolExecutionRecord> result = new ArrayList<>();
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns("e") + ", b.isolation_class, b.isolation_key, "
                                + JdbcRuntimeBindingRepository.REQUEST_COLUMNS_AS_B
                                + " FROM ma_tool_execution e JOIN ma_runtime_binding b ON b.binding_id = e.binding_id WHERE b.tenant_id = ? AND e.harness_session_id = ? ORDER BY e.execution_call_id_hash FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    ToolExecutionRecord record = mapExecution(rows);
                    if (!harnessSessionId.equals(record.getHarnessSessionId())
                            || !("session".equals(rows.getString("isolation_class"))
                                            && harnessSessionId.equals(rows.getString("isolation_key"))
                                    || JdbcRuntimeBindingRepository.sharesRuntimeSessions(rows, "b_"))) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_close_identity_unverified",
                                "Execution scope differs",
                                false);
                    }
                    result.add(record);
                }
            }
        }
        return List.copyOf(result);
    }

    @Override
    public ToolExecutionRecord findOrCreate(ToolExecutionRecord candidate) {
        requireCandidate(candidate);
        JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    JdbcCsiActivationAdmission.refuseUnqualifiedWriter(
                            connection, candidate.getBindingId());
                    return null;
                });
        ToolExecutionRecord existing = findByIdempotencyKey(
                candidate.getIdempotencyKey());
        if (existing != null) {
            return existing;
        }
        try {
            return JdbcRepositorySupport.transaction(dataSource,
                    connection -> {
                        JdbcCsiActivationAdmission.refuseUnqualifiedWriter(
                                connection, candidate.getBindingId());
                        insertExecution(connection, candidate);
                        return candidate;
                    });
        } catch (IllegalStateException failure) {
            if (!JdbcRepositorySupport.isConstraintViolation(failure)) {
                throw failure;
            }
            ToolExecutionRecord winner = findByIdempotencyKey(
                    candidate.getIdempotencyKey());
            if (winner != null) {
                return winner;
            }
            ToolExecutionRecord duplicateId = findByExecutionCallId(
                    candidate.getExecutionCallId());
            if (duplicateId != null) {
                throw new IllegalArgumentException(
                        "executionCallId already belongs to another request",
                        failure);
            }
            throw failure;
        }
    }

    @Override
    public ToolExecutionRecord findByExecutionCallId(String executionCallId) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return JdbcRepositorySupport.read(dataSource, connection ->
                selectByExecutionId(connection, id, false));
    }

    @Override
    public ToolExecutionRecord findByIdempotencyKey(String idempotencyKey) {
        String key = BrokerValues.requireId(idempotencyKey,
                "idempotencyKey");
        return JdbcRepositorySupport.read(dataSource,
                connection -> selectByIdempotencyKey(connection, key));
    }

    static ToolExecutionRecord selectByIdempotencyKey(Connection connection,
            String key) throws SQLException {
        return selectByIdempotencyKey(connection, key, false);
    }

    static ToolExecutionRecord selectByIdempotencyKey(
            Connection connection, String key, boolean lock) throws SQLException {
        String sql = "SELECT " + EXECUTION_COLUMNS
                + " FROM ma_tool_execution "
                + "WHERE idempotency_key_hash = ?"
                        + (lock ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(
                sql)) {
            statement.setString(1, JdbcRepositorySupport.valueKey(key));
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                ToolExecutionRecord record = mapExecution(result);
                if (!key.equals(record.getIdempotencyKey())) {
                    throw new IllegalStateException(
                            "Tool idempotency hash collision");
                }
                return record;
            }
        }
    }

    public boolean usesDataSource(DataSource source) {
        return dataSource == source;
    }

    public ToolExecutionRecord findByExecutionCallIdForUpdate(Connection connection,
            String executionCallId) throws SQLException {
        if (connection == null || connection.getAutoCommit()) {
            throw new IllegalArgumentException("An active transaction is required");
        }
        return selectByExecutionId(connection,
                BrokerValues.requireId(executionCallId, "executionCallId"), true);
    }

    @Override
    public ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner,
            long dispatchGeneration) {
        requireReplacement(expected, replacement);
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    ToolExecutionRecord hint =
                            selectByExecutionId(connection, expected.getExecutionCallId(), false);
                    if (hint == null) {
                        return null;
                    }
                    var continuation = lockCsiContinuation(connection, hint);
                    if (continuation != null) {
                        var current =
                                selectByExecutionId(
                                        connection, expected.getExecutionCallId(), true);
                        continuation.require(current);
                        if (!running(current)
                                || replacement.getState() != ToolExecutionRecord.State.SETTLED
                                        && replacement.getState()
                                                != ToolExecutionRecord.State.UNKNOWN
                                || current.isCancelRequested() != replacement.isCancelRequested()
                                || replacement.getLastSequence() < current.getLastSequence()) {
                            throw csiContinuationUnavailable();
                        }
                    }
                    return compareAndSet(
                            connection,
                            expected,
                            replacement,
                            owner,
                            dispatchGeneration,
                            false,
                            continuation);
                });
    }

    static ToolExecutionRecord authorizeDispatch(Connection connection, ToolExecutionRecord expected,
            String owner, long dispatchGeneration, long bindingVersion) throws SQLException {
        return compareAndSet(connection, expected, expected.authorizeDispatch(bindingVersion),
                owner, dispatchGeneration, true,
                null);
    }

    private static ToolExecutionRecord compareAndSet(Connection connection, ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner, long dispatchGeneration,
            boolean authorizing,
            CsiContinuation continuation) throws SQLException {
        requireReplacement(expected, replacement);
        if (!authorizing && !expected.sameAuthorization(replacement)) {
            throw new IllegalArgumentException("replacement must preserve dispatch authorization");
        }
        ToolExecutionRecord current = selectByExecutionId(connection,
                expected.getExecutionCallId(), true);
        if (current == null || !current.sameIdentity(expected)
                || !current.sameAuthorization(expected)
                || authorizing && (current.getState() != ToolExecutionRecord.State.DISPATCHING
                        || current.isCancelRequested()
                        || current.getAuthorizedDispatchGeneration() != null)
                || current.getVersion() != expected.getVersion()
                || current.isTerminal()
                || current.getState()
                        == ToolExecutionRecord.State.UNKNOWN
                || !current.sameDispatch(expected)
                || !current.hasLiveDispatchAt(
                        JdbcRepositorySupport.databaseNowPrecise(
                                connection))
                || !current.getDispatchOwner().equals(owner)
                || current.getDispatchGeneration()
                        != dispatchGeneration) {
            return null;
        }
        ToolExecutionRecord.State nextState = replacement.getState();
        if (nextState == ToolExecutionRecord.State.ABANDONED
                || nextState == ToolExecutionRecord.State.PREPARED
                || nextState == ToolExecutionRecord.State.DISPATCHING
                        && current.getState()
                                != ToolExecutionRecord.State.DISPATCHING) {
            throw new IllegalArgumentException(
                    "execution state must not move backwards");
        }
        if (current.isCancelRequested()
                && !replacement.isCancelRequested()) {
            throw new IllegalArgumentException(
                    "replacement must not drop a cancellation request");
        }
        ToolExecutionRecord updated = replacement.withVersion(
                expected.getVersion() + 1);
        requireCsiCurrentTime(connection, continuation);
        updateExecution(connection, updated);
        return updated;
    }

    @Override
    public ToolExecutionRecord claimDispatch(String executionCallId,
            String owner, Duration leaseDuration) {
        return claimValidatedDispatch(executionCallId, owner, leaseDuration, null);
    }

    @Override
    public ToolExecutionRecord claimValidatedDispatch(String executionCallId, String owner,
            Duration leaseDuration, com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload payload) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = JdbcRepositorySupport.requireDuration(
                leaseDuration);
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    ToolExecutionRecord hint = selectByExecutionId(connection, id, false);
                    if (hint == null) {
                        return null;
                    }
                    if (payload != null && !payload.digest().equals(hint.getRequestDigest())) {
                        throw new IllegalArgumentException("Tool execution digest changed");
                    }
                    // The shared-slot fence admits new dispatches only. A
                    // payload-less claim is lifecycle maintenance (takeover,
                    // renewal re-claim, cancel dispatch, non-shared profiles)
                    // of an already-admitted execution; judging it as a writer
                    // would strand it behind any in-flight shared read.
                    if (payload != null) {
                        boolean verifiedRead = payload.readOnly();
                        if (!claimSharedExternalSlot(connection, hint, verifiedRead)) {
                            return null;
                        }
                    }
                    var continuation = lockCsiContinuation(connection, hint);
                    ToolExecutionRecord current = selectByExecutionId(connection, id, true);
                    if (continuation != null) {
                        continuation.require(current);
                        if (!current.isTerminal()
                                && current.getState() != ToolExecutionRecord.State.UNKNOWN
                                && !running(current)) {
                            continuation.original().requireAdmission();
                        }
                    }
                    requireCsiCurrentTime(connection, continuation);
                    if (current == null
                            || current.isTerminal()
                            || current.getState() == ToolExecutionRecord.State.UNKNOWN) {
                        return null;
                    }
                    String storedClass = null;
                    if (payload != null) {
                        try (var classification = connection.prepareStatement(
                                "SELECT shared_dispatch_class"
                                        + " FROM ma_tool_execution"
                                        + " WHERE execution_call_id_hash = ? FOR UPDATE")) {
                            classification.setString(
                                    1, JdbcRepositorySupport.valueKey(id));
                            try (var row = classification.executeQuery()) {
                                if (!row.next()) {
                                    throw new IllegalStateException(
                                            "Tool execution disappeared");
                                }
                                storedClass = row.getString(1);
                                if (storedClass != null
                                        && (!"READ".equals(storedClass)
                                                || !payload.readOnly())) {
                                    throw new IllegalStateException(
                                            "Tool execution classification changed");
                                }
                            }
                        }
                    }
                    Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
                    if (ownerId.equals(current.getDispatchOwner())
                            && current.getDispatchLeaseUntil().isAfter(now)) {
                        return current;
                    }
                    if (current.getDispatchOwner() != null
                            && current.getDispatchLeaseUntil().isAfter(now)) {
                        return null;
                    }
                    if (current.getState() == ToolExecutionRecord.State.EXECUTING
                            || current.getState() == ToolExecutionRecord.State.CANCEL_REQUESTED) {
                        ToolExecutionRecord unknown =
                                current.withUnknown().withVersion(current.getVersion() + 1);
                        requireCsiCurrentTime(connection, continuation);
                        updateExecution(connection, unknown);
                        return null;
                    }
                    if (continuation != null) {
                        JdbcCsiExecutionAdmission.requireDispatch(
                                connection, continuation.original(), current, journalPacks());
                    }
                    if (payload != null
                            && !payload.digest().equals(current.getRequestDigest())) {
                        throw new IllegalStateException(
                                "Tool execution digest changed");
                    }
                    if (payload != null && payload.readOnly() && storedClass == null) {
                        try (var classify = connection.prepareStatement(
                                "UPDATE ma_tool_execution"
                                        + " SET shared_dispatch_class = 'READ'"
                                        + " WHERE execution_call_id_hash = ?"
                                        + " AND shared_dispatch_class IS NULL")) {
                            classify.setString(
                                    1, JdbcRepositorySupport.valueKey(id));
                            if (classify.executeUpdate() != 1) {
                                throw new SQLException(
                                        "Tool execution classification update failed");
                            }
                        }
                    }
                    ToolExecutionRecord claimed =
                            current.withDispatch(
                                            ownerId,
                                            JdbcRepositorySupport.leaseUntil(now, duration),
                                            current.getDispatchGeneration() + 1,
                                            ToolExecutionRecord.State.DISPATCHING)
                                    .withVersion(current.getVersion() + 1);
                    if (continuation != null) {
                        continuation
                                .progress()
                                .requireLease(
                                        connection,
                                        claimed.getDispatchLeaseUntil().toEpochMilli(),
                                        claimed.getDispatchLeaseUntil().toEpochMilli());
                    }
                    requireCsiCurrentTime(connection, continuation);
                    updateExecution(connection, claimed);
                    return claimed;
                });
    }

    private static boolean claimSharedExternalSlot(Connection connection,
            ToolExecutionRecord candidate, boolean sharedRead) throws SQLException {
        try (var binding = connection.prepareStatement(
                "SELECT provisioner_kind, isolation_class, runtime_generation"
                        + " FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(
                    binding, 1, candidate.getBindingId());
            try (var row = binding.executeQuery()) {
                if (!row.next()
                        || !"external-workspace".equals(
                                row.getString("provisioner_kind"))
                        || !"workspace".equals(
                                row.getString("isolation_class"))) {
                    return true;
                }
                if (row.getLong("runtime_generation")
                        != candidate.getRuntimeGeneration()) {
                    return false;
                }
            }
        }
        try (var active = connection.prepareStatement(
                "SELECT execution_call_id FROM ma_tool_execution"
                        + " WHERE binding_id = ? AND runtime_generation = ?"
                        + " AND execution_call_id_hash <> ?"
                        + " AND execution_state NOT IN"
                        + " ('PREPARED', 'SETTLED', 'ABANDONED')"
                        + (sharedRead
                                ? " AND (shared_dispatch_class IS NULL"
                                        + " OR shared_dispatch_class <> 'READ'"
                                        + " OR execution_state = 'UNKNOWN')"
                                : "")
                        + " LIMIT 1 FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(
                    active, 1, candidate.getBindingId());
            active.setLong(2, candidate.getRuntimeGeneration());
            active.setString(
                    3, JdbcRepositorySupport.valueKey(
                            candidate.getExecutionCallId()));
            try (var rows = active.executeQuery()) {
                return !rows.next();
            }
        }
    }

    @Override
    public ToolExecutionRecord renewDispatch(String executionCallId,
            String owner, long dispatchGeneration, Duration leaseDuration) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = JdbcRepositorySupport.requireDuration(
                leaseDuration);
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    ToolExecutionRecord hint = selectByExecutionId(connection, id, false);
                    if (hint == null) {
                        return null;
                    }
                    var continuation = lockCsiContinuation(connection, hint);
                    ToolExecutionRecord current = selectByExecutionId(connection, id, true);
                    if (continuation != null) {
                        continuation.require(current);
                        if (!current.isTerminal()
                                && current.getState() != ToolExecutionRecord.State.UNKNOWN
                                && !running(current)) {
                            continuation.original().requireAdmission();
                        }
                    }
                    requireCsiCurrentTime(connection, continuation);
                    if (current == null
                            || current.isTerminal()
                            || current.getState() == ToolExecutionRecord.State.UNKNOWN) {
                        return null;
                    }
                    Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
                    if (!ownerId.equals(current.getDispatchOwner())
                            || dispatchGeneration != current.getDispatchGeneration()
                            || !current.getDispatchLeaseUntil().isAfter(now)) {
                        return null;
                    }
                    ToolExecutionRecord renewed =
                            current.withDispatch(
                                            ownerId,
                                            JdbcRepositorySupport.leaseUntil(now, duration),
                                            dispatchGeneration,
                                            current.getState())
                                    .withVersion(current.getVersion() + 1);
                    if (continuation != null) {
                        continuation
                                .progress()
                                .requireLease(
                                        connection,
                                        current.getDispatchLeaseUntil().toEpochMilli(),
                                        renewed.getDispatchLeaseUntil().toEpochMilli());
                    }
                    requireCsiCurrentTime(connection, continuation);
                    updateExecution(connection, renewed);
                    return renewed;
                });
    }

    @Override
    public ToolExecutionRecord requestCancel(String executionCallId,
            long expectedVersion) {
        String id = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    ToolExecutionRecord hint = selectByExecutionId(connection, id, false);
                    if (hint == null) {
                        return null;
                    }
                    var continuation = lockCsiContinuation(connection, hint);
                    ToolExecutionRecord current = selectByExecutionId(connection, id, true);
                    if (continuation != null) {
                        continuation.require(current);
                    }
                    requireCsiCurrentTime(connection, continuation);
                    if (current == null
                            || current.isTerminal()
                            || current.getVersion() != expectedVersion) {
                        return null;
                    }
                    if (continuation != null && current.getAuthorizedDispatchGeneration() != null) {
                        throw new RuntimeBrokerException(
                                409,
                                "csi_execution_cancel_unavailable",
                                "An authorized private CSI execution does not support cancellation",
                                false);
                    }
                    if (current.isCancelRequested()) {
                        return current;
                    }
                    ToolExecutionRecord requested =
                            current.withState(
                                    current.getState() == ToolExecutionRecord.State.EXECUTING
                                            ? ToolExecutionRecord.State.CANCEL_REQUESTED
                                            : current.getState(),
                                    true);
                    if (continuation != null
                            && current.getAuthorizedDispatchGeneration() == null
                            && (current.getState() == ToolExecutionRecord.State.PREPARED
                                    || current.getState()
                                            == ToolExecutionRecord.State.DISPATCHING)) {
                        requested =
                                requested.withResult(
                                        Map.of(
                                                "executionStatus",
                                                "not_started",
                                                "responseParts",
                                                List.of()),
                                        current.getLastSequence(),
                                        JdbcRepositorySupport.databaseNow(connection));
                    } else if (current.getState() == ToolExecutionRecord.State.PREPARED) {
                        requested =
                                requested.withResult(
                                        current.cancellationBeforeDispatch(),
                                        current.getLastSequence(),
                                        JdbcRepositorySupport.databaseNow(connection));
                    }
                    ToolExecutionRecord updated = requested.withVersion(current.getVersion() + 1);
                    requireCsiCurrentTime(connection, continuation);
                    updateExecution(connection, updated);
                    return updated;
                });
    }

    @Override
    public ToolExecutionRecord settlePrepared(ToolExecutionRecord expected,
            Map<String, Object> result, Instant settlementTime) {
        if (expected == null || result == null || settlementTime == null) {
            throw new IllegalArgumentException(
                    "expected, result and time are required");
        }
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    JdbcCsiActivationAdmission.refuseUnqualifiedWriter(
                            connection, expected.getBindingId());
                    ToolExecutionRecord current =
                            selectByExecutionId(connection, expected.getExecutionCallId(), true);
                    if (current == null
                            || !current.sameIdentity(expected)
                            || current.getVersion() != expected.getVersion()
                            || current.isTerminal()
                            || current.getState() != ToolExecutionRecord.State.PREPARED) {
                        return null;
                    }
                    ToolExecutionRecord settled =
                            current.withResult(result, current.getLastSequence(), settlementTime)
                                    .withVersion(current.getVersion() + 1);
                    updateExecution(connection, settled);
                    return settled;
                });
    }

    @Override
    public ToolExecutionRecord resolveUnknown(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return JdbcToolExecutionObservations.resolve(dataSource, expected, resolutionResult, resolutionTime, true);
    }

    @Override
    public ToolExecutionRecord attachMeasurements(
            ToolExecutionRecord expected, Map<String, Object> metadata) {
        return JdbcToolExecutionObservations.attachMeasurements(dataSource, expected, metadata);
    }

    @Override
    public ToolExecutionRecord resolveUnsettled(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        return JdbcToolExecutionObservations.resolve(dataSource, expected, resolutionResult, resolutionTime, false);
    }

    private JdbcJournalPacks journalPacks() {
        return csiBindings == null ? null : csiBindings.journalPacks();
    }

    private CsiContinuation lockCsiContinuation(Connection connection, ToolExecutionRecord hint)
            throws SQLException {
        var scope =
                JdbcCsiActivationAdmission.lockForContinuation(
                        connection, hint.getBindingId(), csiBindings, journalPacks());
        if (scope == null) {
            return null;
        }
        var original = scope.original();
        JdbcCsiActivationAdmission.requireExecution(original, hint);
        JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
        var runtime =
                JdbcRuntimeSessionRepository.selectSession(
                        connection,
                        original.request().getScope(),
                        hint.getRuntimeSessionId(),
                        true);
        original.requireSession(runtime);
        var continuation = new CsiContinuation(original, scope.progress(), scope.head(), runtime);
        continuation.require(hint);
        if (JdbcCsiExecutionAdmission.legacyReference(hint)) {
            throw new RuntimeBrokerException(
                    409,
                    "csi_native_execution_unavailable",
                    "The private CSI profile requires original native execution evidence.",
                    false);
        } else {
            JdbcCsiExecutionAdmission.verifyRelated(connection, original, journalPacks());
        }
        requireCsiCurrentTime(connection, continuation);
        return continuation;
    }

    private static void requireCsiCurrentTime(Connection connection, CsiContinuation continuation)
            throws SQLException {
        if (continuation != null) {
            continuation.progress().requireCurrentTime(connection);
            continuation.head().requireCurrentTime(connection);
        }
    }

    private static boolean running(ToolExecutionRecord current) {
        return current.getState() == ToolExecutionRecord.State.EXECUTING
                || current.getState() == ToolExecutionRecord.State.CANCEL_REQUESTED;
    }

    private static RuntimeBrokerException csiContinuationUnavailable() {
        return new RuntimeBrokerException(
                409,
                "csi_execution_continuation_unavailable",
                "The original CSI execution continuation is unavailable.",
                false);
    }

    private record CsiContinuation(
            JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiApplicationProgress.Continuation progress,
            JdbcCsiActivationAdmission.NativeHead head,
            RuntimeSessionRecord runtime) {
        void require(ToolExecutionRecord execution) {
            JdbcCsiActivationAdmission.requireExecution(original, execution);
            RuntimeAdmission.requireSession(runtime, execution);
            if (!"deferred".equals(execution.getReference().get("dispatchMode"))
                    || !execution
                            .getReference()
                            .keySet()
                            .equals(
                                    Set.of(
                                            "dispatchMode",
                                            "sessionId",
                                            "promptId",
                                            "callId",
                                            "argsDigest",
                                            "batchId",
                                            "functionCallId",
                                            "partIndex",
                                            "ordinal",
                                            "inputRef",
                                            "toolDefinitionRef"))
                    || !execution.getRequestDigest().matches("sha256:[0-9a-f]{64}")) {
                throw csiContinuationUnavailable();
            }
            Long authorized = execution.getAuthorizedBindingVersion();
            if (authorized != null) {
                if (authorized <= 0 || authorized > original.version()) {
                    throw csiContinuationUnavailable();
                }
            } else if (running(execution)
                    || execution.getState() == ToolExecutionRecord.State.UNKNOWN) {
                throw csiContinuationUnavailable();
            }
        }
    }

    private static String scanCursor(RuntimeSessionRecord session, String afterExecutionCallId, int limit) {
        if (session == null || limit < 1 || limit > 100) {
            throw new IllegalArgumentException("session and limit in [1, 100] are required");
        }
        return afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireId(afterExecutionCallId, "cursor"));
    }

    @Override
    public List<ToolExecutionRecord> findUnsettled(RuntimeSessionRecord session,
            String afterExecutionCallId, int limit) {
        String after = scanCursor(session, afterExecutionCallId, limit);
        return JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    String sql =
                            "SELECT "
                                    + EXECUTION_COLUMNS
                                    + " FROM ma_tool_execution WHERE binding_id = ? AND"
                                    + " runtime_generation = ? AND runtime_session_key = ? AND"
                                    + " harness_session_id = ? AND execution_call_id_hash > ? AND"
                                    + " execution_state IN ('EXECUTING', 'CANCEL_REQUESTED',"
                                    + " 'UNKNOWN') ORDER BY execution_call_id_hash LIMIT ?";
                    try (PreparedStatement statement = connection.prepareStatement(sql)) {
                        JdbcRepositorySupport.setIdentity(statement, 1, session.getBindingId());
                        statement.setLong(2, session.getRuntimeGeneration());
                        statement.setString(
                                3, JdbcRepositorySupport.valueKey(session.getRuntimeSessionId()));
                        JdbcRepositorySupport.setIdentity(
                                statement, 4, session.getSession().getHarnessSessionId());
                        statement.setString(5, after);
                        statement.setInt(6, limit);
                        List<ToolExecutionRecord> records = new ArrayList<>();
                        try (ResultSet result = statement.executeQuery()) {
                            while (result.next()) {
                                ToolExecutionRecord record = mapExecution(result);
                                if (!record.belongsTo(session)) {
                                    throw new IllegalStateException(
                                            "Execution scan ownership differs");
                                }
                                records.add(record);
                            }
                        }
                        return List.copyOf(records);
                    }
                });
    }

    @Override
    public List<ToolExecutionRecord> findBackgroundProcesses(
            RuntimeSessionRecord session, String afterExecutionCallId, int limit) {
        String after = scanCursor(session, afterExecutionCallId, limit);
        return JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    List<ToolExecutionRecord> matches = new ArrayList<>();
                    String cursor = after;
                    // The dispatch mode lives in the reference payload, so SQL
                    // pages the ownership-and-state window and the filter runs row
                    // by row; the scan stops as soon as a page of matches is full
                    // or the window is exhausted, keeping "short page means done".
                    for (; ; ) {
                        String sql =
                                "SELECT "
                                        + EXECUTION_COLUMNS
                                        + " FROM ma_tool_execution WHERE binding_id = ? AND"
                                        + " runtime_generation = ? AND runtime_session_key = ? AND"
                                        + " harness_session_id = ? AND execution_call_id_hash > ?"
                                        + " AND execution_state NOT IN ('SETTLED', 'ABANDONED')"
                                        + " ORDER BY execution_call_id_hash LIMIT ?";
                        List<ToolExecutionRecord> batch = new ArrayList<>();
                        try (PreparedStatement statement = connection.prepareStatement(sql)) {
                            JdbcRepositorySupport.setIdentity(statement, 1, session.getBindingId());
                            statement.setLong(2, session.getRuntimeGeneration());
                            statement.setString(
                                    3,
                                    JdbcRepositorySupport.valueKey(session.getRuntimeSessionId()));
                            JdbcRepositorySupport.setIdentity(
                                    statement, 4, session.getSession().getHarnessSessionId());
                            statement.setString(5, cursor);
                            statement.setInt(6, limit);
                            try (ResultSet result = statement.executeQuery()) {
                                while (result.next()) {
                                    ToolExecutionRecord record = mapExecution(result);
                                    if (!record.belongsTo(session)) {
                                        throw new IllegalStateException(
                                                "Execution scan ownership differs");
                                    }
                                    batch.add(record);
                                }
                            }
                        }
                        if (batch.isEmpty()) {
                            return List.copyOf(matches);
                        }
                        for (ToolExecutionRecord record : batch) {
                            if (ManagedHoldFamily.of(record) != null) {
                                matches.add(record);
                                if (matches.size() == limit) {
                                    return List.copyOf(matches);
                                }
                            }
                        }
                        if (batch.size() < limit) {
                            return List.copyOf(matches);
                        }
                        cursor =
                                JdbcRepositorySupport.valueKey(
                                        batch.get(batch.size() - 1).getExecutionCallId());
                    }
                });
    }

    @Override
    public List<ToolHoldRow> findHoldRowsByHarnessSession(
            String harnessSessionId, String afterExecutionCallId, int limit) {
        if (harnessSessionId == null || limit < 1 || limit > 100) {
            throw new IllegalArgumentException(
                    "harnessSessionId and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireId(afterExecutionCallId, "cursor"));
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<ToolHoldRow> matches = new ArrayList<>();
            String cursor = after;
            // Same windowing as findBackgroundProcesses, but scoped by the
            // harness session instead of one Runtime Session, and WITHOUT the
            // terminal-state filter: a hold row's settle discharges nothing —
            // only the Runtime Session's recorded release does, and that
            // filter is the caller's (#13930 R1-2 review). The projection is
            // narrowed to the two fields the caller reads: full
            // mapExecution would parse the result payload and re-verify three
            // digests for every scanned row, almost all of them non-hold
            // (#13986 review R1-7).
            for (;;) {
                String sql = "SELECT execution_call_id, harness_session_id, "
                        + "runtime_session_id, reference_json FROM ma_tool_execution "
                        + "WHERE harness_session_id = ? AND execution_call_id_hash > ? "
                        + "ORDER BY execution_call_id_hash LIMIT ?";
                List<ToolHoldRow> batch = new ArrayList<>();
                int scanned = 0;
                String lastScanned = null;
                try (PreparedStatement statement = connection.prepareStatement(sql)) {
                    JdbcRepositorySupport.setIdentity(statement, 1, harnessSessionId);
                    statement.setString(2, cursor);
                    statement.setInt(3, limit);
                    try (ResultSet result = statement.executeQuery()) {
                        while (result.next()) {
                            scanned++;
                            lastScanned = result.getString("execution_call_id");
                            // The canonical schema stores identities in
                            // VARBINARY, so the SQL's `=` is already
                            // byte-exact; this fence keeps the exact Harness
                            // identity guarantee independent of the store's
                            // comparison semantics (#13986 review).
                            if (!harnessSessionId.equals(
                                    result.getString("harness_session_id"))) {
                                continue;
                            }
                            Map<String, Object> reference =
                                    fromJson(result.getString("reference_json"));
                            if (ManagedHoldFamily.ofDispatchMode(
                                    reference.get("dispatchMode")) == null) {
                                continue;
                            }
                            batch.add(new ToolHoldRow(
                                    result.getString("execution_call_id"),
                                    result.getString("runtime_session_id")));
                        }
                    }
                }
                if (scanned == 0) {
                    return List.copyOf(matches);
                }
                matches.addAll(batch);
                if (matches.size() >= limit) {
                    return List.copyOf(matches.subList(0, limit));
                }
                if (scanned < limit) {
                    return List.copyOf(matches);
                }
                cursor = JdbcRepositorySupport.valueKey(lastScanned);
            }
        });
    }

    @Override
    public List<ToolExecutionRecord> findByBinding(String bindingId,
            long runtimeGeneration, String afterExecutionCallId, int limit) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0 || limit < 1 || limit > 100) {
            throw new IllegalArgumentException(
                    "positive runtimeGeneration and limit in [1, 100] are required");
        }
        String after = afterExecutionCallId == null ? ""
                : JdbcRepositorySupport.valueKey(BrokerValues.requireWellFormed(
                        BrokerValues.requireId(afterExecutionCallId, "cursor"), "cursor"));
        return JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    String sql =
                            "SELECT "
                                    + EXECUTION_COLUMNS
                                    + " FROM ma_tool_execution "
                                    + "WHERE binding_id = ? AND runtime_generation = ? "
                                    + "AND execution_call_id_hash > ? "
                                    + "ORDER BY execution_call_id_hash LIMIT ?";
                    try (PreparedStatement statement = connection.prepareStatement(sql)) {
                        JdbcRepositorySupport.setIdentity(statement, 1, id);
                        statement.setLong(2, runtimeGeneration);
                        statement.setString(3, after);
                        statement.setInt(4, limit);
                        List<ToolExecutionRecord> records = new ArrayList<>();
                        try (ResultSet result = statement.executeQuery()) {
                            while (result.next()) {
                                ToolExecutionRecord record = mapExecution(result);
                                BrokerValues.requireWellFormed(
                                        record.getExecutionCallId(), "executionCallId");
                                if (!id.equals(record.getBindingId())
                                        || runtimeGeneration != record.getRuntimeGeneration()) {
                                    throw new IllegalStateException(
                                            "Execution inventory ownership differs");
                                }
                                records.add(record);
                            }
                        }
                        return List.copyOf(records);
                    }
                });
    }

    @Override
    public boolean hasActiveByBinding(String bindingId,
            long runtimeGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        return JdbcRepositorySupport.read(dataSource, connection ->
                hasActiveByBinding(connection, id, runtimeGeneration));
    }

    @Override
    public boolean hasActiveByRuntimeSession(String runtimeSessionId) {
        String id = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            String sql = "SELECT runtime_session_id "
                    + "FROM ma_tool_execution "
                    + "WHERE runtime_session_key = ? "
                    + "AND execution_state NOT IN ('SETTLED', 'ABANDONED')";
            try (PreparedStatement statement = connection.prepareStatement(
                    sql)) {
                statement.setString(1, JdbcRepositorySupport.valueKey(id));
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        if (id.equals(result.getString(
                                "runtime_session_id"))) {
                            return true;
                        }
                    }
                    return false;
                }
            }
        });
    }

    @Override
    public boolean hasActiveByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId) {
        return JdbcRepositorySupport.read(dataSource, connection ->
                hasActiveByRuntimeSession(connection, bindingId,
                        runtimeGeneration, runtimeSessionId,
                        java.util.Set.of()));
    }

    @Override
    public boolean hasActiveByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId,
            java.util.Set<String> excludingExecutionCallIds) {
        return JdbcRepositorySupport.read(dataSource, connection ->
                hasActiveByRuntimeSession(connection, bindingId,
                        runtimeGeneration, runtimeSessionId,
                        excludingExecutionCallIds));
    }

    @Override
    public boolean hasUnprovenCaptureByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId) {
        return JdbcRepositorySupport.read(dataSource, connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT binding_id, runtime_session_id, result_json FROM"
                            + " ma_tool_execution WHERE binding_id = ? AND runtime_generation = ?"
                            + " AND runtime_session_key = ? AND execution_state = 'SETTLED'")) {
                JdbcRepositorySupport.setIdentity(statement, 1, bindingId);
                statement.setLong(2, runtimeGeneration);
                statement.setString(3, JdbcRepositorySupport.valueKey(runtimeSessionId));
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        if (bindingId.equals(result.getString("binding_id"))
                                && runtimeSessionId.equals(result.getString("runtime_session_id"))
                                && ToolExecutionRepository.captureStopUnproven(
                                        fromJson(result.getString("result_json")))) {
                            return true;
                        }
                    }
                }
            }
            return false;
        });
    }

    static boolean hasActiveByRuntimeSession(Connection connection,
            String bindingId, long runtimeGeneration, String runtimeSessionId)
            throws SQLException {
        return hasActiveByRuntimeSession(connection, bindingId,
                runtimeGeneration, runtimeSessionId, java.util.Set.of());
    }

    static boolean hasActiveByRuntimeSession(Connection connection,
            String bindingId, long runtimeGeneration, String runtimeSessionId,
            java.util.Set<String> excludingExecutionCallIds)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT binding_id, runtime_session_id, execution_call_id FROM"
                            + " ma_tool_execution WHERE binding_id = ? AND runtime_generation = ?"
                            + " AND runtime_session_key = ? AND execution_state NOT IN ('SETTLED',"
                            + " 'ABANDONED')")) {
            JdbcRepositorySupport.setIdentity(statement, 1, bindingId);
            statement.setLong(2, runtimeGeneration);
            statement.setString(3, JdbcRepositorySupport.valueKey(runtimeSessionId));
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    if (bindingId.equals(result.getString("binding_id"))
                            && runtimeSessionId.equals(result.getString("runtime_session_id"))
                            && !excludingExecutionCallIds.contains(
                                    result.getString("execution_call_id"))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
}
