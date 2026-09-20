package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;

/** JDBC Runtime binding repository coordinated through a shared database. */
public final class JdbcRuntimeBindingRepository
        implements RuntimeBindingRepository {
    private static final String BINDING_COLUMNS = String.join(", ",
            "binding_id", "request_key", "scope_key", "tenant_id",
            "workspace_id", "workspace_generation", "canonical_cwd",
            "capability_digest", "isolation_class", "isolation_key",
            "runtime_generation", "binding_state", "runtime_instance_id",
            "runtime_endpoint", "runtime_token", "runtime_lease_id",
            "runtime_epoch", "drain_requested", "operation_owner",
            "operation_lease_until", "operation_generation",
            "record_version", "last_health_at", "last_active_at");

    private final DataSource dataSource;
    private final Supplier<String> idSupplier;

    public JdbcRuntimeBindingRepository(DataSource dataSource) {
        this(dataSource, () -> UUID.randomUUID().toString());
    }

    public JdbcRuntimeBindingRepository(DataSource dataSource,
            Supplier<String> idSupplier) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
        if (idSupplier == null) {
            throw new IllegalArgumentException("idSupplier is required");
        }
        this.idSupplier = idSupplier;
    }

    @Override
    public RuntimeBindingRecord findOrCreate(
            RuntimeProvisionRequest request) {
        requireRequest(request);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            String key = JdbcRepositorySupport.requestKey(request);
            ensureSlot(connection, key, request);
            Slot slot = selectSlot(connection, key, true);
            requireSlotIdentity(slot, request);
            if (slot.activeBindingId != null) {
                RuntimeBindingRecord active = selectById(connection,
                        slot.activeBindingId, true);
                if (active == null || !active.isActive()
                        || !active.getRequest().equals(request)) {
                    throw new IllegalStateException(
                            "Runtime binding slot is inconsistent");
                }
                return active;
            }

            long generation = slot.lastGeneration + 1;
            String bindingId = BrokerValues.requireId(idSupplier.get(),
                    "bindingId");
            Instant now = JdbcRepositorySupport.databaseNow(connection);
            RuntimeBindingRecord created = new RuntimeBindingRecord(
                    bindingId, request, generation,
                    RuntimeBindingRecord.State.PROVISIONING, null, false,
                    null, null, 0, 0, null, now);
            insertBinding(connection, created);
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE qwen_runtime_binding_slot "
                            + "SET last_generation = ?, "
                            + "active_binding_id = ? WHERE request_key = ?")) {
                statement.setLong(1, generation);
                statement.setString(2, bindingId);
                statement.setString(3, key);
                if (statement.executeUpdate() != 1) {
                    throw new SQLException(
                            "Runtime binding slot update failed");
                }
            }
            return created;
        });
    }

    @Override
    public RuntimeBindingRecord findActive(
            RuntimeProvisionRequest request) {
        requireRequest(request);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            String key = JdbcRepositorySupport.requestKey(request);
            Slot slot = selectSlot(connection, key, true);
            if (slot == null) {
                return null;
            }
            requireSlotIdentity(slot, request);
            if (slot.activeBindingId == null) {
                return null;
            }
            RuntimeBindingRecord record = selectById(connection,
                    slot.activeBindingId, true);
            if (record == null || !record.isActive()
                    || !record.getRequest().equals(request)) {
                throw new IllegalStateException(
                        "Runtime binding slot is inconsistent");
            }
            return record;
        });
    }

    @Override
    public List<RuntimeBindingRecord> findActiveByIsolationKey(
            String isolationKey) {
        String key = BrokerValues.requireId(isolationKey, "isolationKey");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<RuntimeBindingRecord> records = new ArrayList<>();
            String sql = "SELECT " + BINDING_COLUMNS
                    + " FROM qwen_runtime_binding WHERE isolation_key = ? "
                    + "AND binding_state NOT IN ('FAILED', 'RELEASED')";
            try (PreparedStatement statement = connection.prepareStatement(
                    sql)) {
                statement.setString(1, key);
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        RuntimeBindingRecord record = mapBinding(result);
                        if (!key.equals(record.getRequest()
                                .getIsolationKey())) {
                            throw new IllegalStateException(
                                    "Runtime binding isolation collision");
                        }
                        records.add(record);
                    }
                }
            }
            return List.copyOf(records);
        });
    }

    @Override
    public RuntimeBindingRecord findById(String bindingId) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            RuntimeBindingRecord record = selectById(connection, id, false);
            if (record != null && !id.equals(record.getBindingId())) {
                throw new IllegalStateException(
                        "Runtime binding identifier collision");
            }
            return record;
        });
    }

    @Override
    public RuntimeBindingRecord compareAndSet(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement) {
        requireReplacement(expected, replacement);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            String key = JdbcRepositorySupport.requestKey(
                    expected.getRequest());
            Slot slot = selectSlot(connection, key, true);
            if (slot == null) {
                return null;
            }
            requireSlotIdentity(slot, expected.getRequest());
            RuntimeBindingRecord current = selectById(connection,
                    expected.getBindingId(), true);
            if (current == null || !current.sameIdentity(expected)
                    || current.getVersion() != expected.getVersion()) {
                return null;
            }
            if (!current.isActive() && replacement.isActive()) {
                throw new IllegalArgumentException(
                        "terminal binding cannot be reactivated");
            }
            if (current.isActive()
                    && !current.getBindingId().equals(
                            slot.activeBindingId)) {
                throw new IllegalStateException(
                        "Runtime binding slot is inconsistent");
            }
            RuntimeBindingRecord updated = replacement.withVersion(
                    expected.getVersion() + 1);
            updateBinding(connection, updated);
            if (current.isActive() && !updated.isActive()) {
                try (PreparedStatement statement = connection.prepareStatement(
                        "UPDATE qwen_runtime_binding_slot "
                                + "SET active_binding_id = NULL "
                                + "WHERE request_key = ? "
                                + "AND active_binding_id = ?")) {
                    statement.setString(1, key);
                    statement.setString(2, current.getBindingId());
                    if (statement.executeUpdate() != 1) {
                        throw new SQLException(
                                "Runtime binding slot release failed");
                    }
                }
            }
            return updated;
        });
    }

    @Override
    public RuntimeBindingRecord claimOperation(String bindingId,
            String owner, Duration leaseDuration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = JdbcRepositorySupport.requireDuration(
                leaseDuration);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            RuntimeBindingRecord current = selectById(connection, id, true);
            if (current == null || !current.isActive()) {
                return null;
            }
            Instant now = JdbcRepositorySupport.databaseNow(connection);
            if (ownerId.equals(current.getOperationOwner())
                    && current.getOperationLeaseUntil().isAfter(now)) {
                return current;
            }
            if (current.getOperationOwner() != null
                    && current.getOperationLeaseUntil().isAfter(now)) {
                return null;
            }
            RuntimeBindingRecord claimed = current.withOperation(ownerId,
                    now.plus(duration),
                    current.getOperationGeneration() + 1)
                    .withVersion(current.getVersion() + 1);
            updateBinding(connection, claimed);
            return claimed;
        });
    }

    @Override
    public RuntimeBindingRecord renewOperation(String bindingId,
            String owner, long operationGeneration, Duration leaseDuration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        Duration duration = JdbcRepositorySupport.requireDuration(
                leaseDuration);
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            RuntimeBindingRecord current = selectById(connection, id, true);
            if (current == null || !current.isActive()) {
                return null;
            }
            Instant now = JdbcRepositorySupport.databaseNow(connection);
            if (!ownerId.equals(current.getOperationOwner())
                    || operationGeneration
                            != current.getOperationGeneration()
                    || !current.getOperationLeaseUntil().isAfter(now)) {
                return null;
            }
            RuntimeBindingRecord renewed = current.withOperation(ownerId,
                    now.plus(duration), operationGeneration)
                    .withVersion(current.getVersion() + 1);
            updateBinding(connection, renewed);
            return renewed;
        });
    }

    private static void ensureSlot(Connection connection, String requestKey,
            RuntimeProvisionRequest request) throws SQLException {
        RuntimeScope scope = request.getScope();
        String sql = "INSERT INTO qwen_runtime_binding_slot (request_key, "
                + "tenant_id, workspace_id, workspace_generation, "
                + "canonical_cwd, capability_digest, isolation_class, "
                + "isolation_key, last_generation, active_binding_id) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL) "
                + "ON DUPLICATE KEY UPDATE request_key = request_key";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, requestKey);
            setScope(statement, 2, scope);
            statement.setString(8, request.getIsolationKey());
            statement.executeUpdate();
        }
    }

    private static Slot selectSlot(Connection connection, String requestKey,
            boolean forUpdate) throws SQLException {
        String sql = "SELECT tenant_id, workspace_id, "
                + "workspace_generation, canonical_cwd, capability_digest, "
                + "isolation_class, isolation_key, last_generation, "
                + "active_binding_id FROM qwen_runtime_binding_slot "
                + "WHERE request_key = ?" + (forUpdate
                        ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, requestKey);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                RuntimeScope scope = mapScope(result);
                RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                        scope, result.getString("isolation_key"));
                return new Slot(request,
                        result.getLong("last_generation"),
                        result.getString("active_binding_id"));
            }
        }
    }

    private static RuntimeBindingRecord selectById(Connection connection,
            String bindingId, boolean forUpdate) throws SQLException {
        String sql = "SELECT " + BINDING_COLUMNS
                + " FROM qwen_runtime_binding WHERE binding_id = ?"
                + (forUpdate ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, bindingId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return null;
                }
                RuntimeBindingRecord record = mapBinding(result);
                if (!bindingId.equals(record.getBindingId())) {
                    throw new IllegalStateException(
                            "Runtime binding identifier collision");
                }
                return record;
            }
        }
    }

    private static void insertBinding(Connection connection,
            RuntimeBindingRecord record) throws SQLException {
        String sql = "INSERT INTO qwen_runtime_binding (" + BINDING_COLUMNS
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                + "?, ?, ?, ?, ?, ?, ?, ?, ?)";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            setBinding(statement, record);
            statement.executeUpdate();
        }
    }

    private static void updateBinding(Connection connection,
            RuntimeBindingRecord record) throws SQLException {
        String sql = "UPDATE qwen_runtime_binding SET binding_state = ?, "
                + "runtime_instance_id = ?, runtime_endpoint = ?, "
                + "runtime_token = ?, runtime_lease_id = ?, "
                + "runtime_epoch = ?, drain_requested = ?, "
                + "operation_owner = ?, operation_lease_until = ?, "
                + "operation_generation = ?, record_version = ?, "
                + "last_health_at = ?, last_active_at = ? "
                + "WHERE binding_id = ?";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, record.getState().name());
            RuntimeLease lease = record.getLease();
            statement.setString(2,
                    lease == null ? null : lease.getRuntimeInstanceId());
            statement.setString(3,
                    lease == null ? null : lease.getEndpoint().toString());
            statement.setString(4,
                    lease == null ? null : lease.getToken());
            statement.setString(5,
                    lease == null ? null : lease.getLeaseId());
            if (lease == null) {
                statement.setObject(6, null);
            } else {
                statement.setLong(6, lease.getEpoch());
            }
            statement.setBoolean(7, record.isDrainRequested());
            statement.setString(8, record.getOperationOwner());
            JdbcRepositorySupport.setInstant(statement, 9,
                    record.getOperationLeaseUntil());
            statement.setLong(10, record.getOperationGeneration());
            statement.setLong(11, record.getVersion());
            JdbcRepositorySupport.setInstant(statement, 12,
                    record.getLastHealthAt());
            JdbcRepositorySupport.setInstant(statement, 13,
                    record.getLastActiveAt());
            statement.setString(14, record.getBindingId());
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Runtime binding update failed");
            }
        }
    }

    private static void setBinding(PreparedStatement statement,
            RuntimeBindingRecord record) throws SQLException {
        RuntimeProvisionRequest request = record.getRequest();
        RuntimeScope scope = request.getScope();
        statement.setString(1, record.getBindingId());
        statement.setString(2, JdbcRepositorySupport.requestKey(request));
        statement.setString(3, JdbcRepositorySupport.scopeKey(scope));
        setScope(statement, 4, scope);
        statement.setString(10, request.getIsolationKey());
        statement.setLong(11, record.getGeneration());
        statement.setString(12, record.getState().name());
        RuntimeLease lease = record.getLease();
        statement.setString(13,
                lease == null ? null : lease.getRuntimeInstanceId());
        statement.setString(14,
                lease == null ? null : lease.getEndpoint().toString());
        statement.setString(15, lease == null ? null : lease.getToken());
        statement.setString(16, lease == null ? null : lease.getLeaseId());
        if (lease == null) {
            statement.setObject(17, null);
        } else {
            statement.setLong(17, lease.getEpoch());
        }
        statement.setBoolean(18, record.isDrainRequested());
        statement.setString(19, record.getOperationOwner());
        JdbcRepositorySupport.setInstant(statement, 20,
                record.getOperationLeaseUntil());
        statement.setLong(21, record.getOperationGeneration());
        statement.setLong(22, record.getVersion());
        JdbcRepositorySupport.setInstant(statement, 23,
                record.getLastHealthAt());
        JdbcRepositorySupport.setInstant(statement, 24,
                record.getLastActiveAt());
    }

    private static void setScope(PreparedStatement statement, int start,
            RuntimeScope scope) throws SQLException {
        statement.setString(start, scope.getTenantId());
        statement.setString(start + 1, scope.getWorkspaceId());
        statement.setString(start + 2, scope.getWorkspaceGeneration());
        statement.setString(start + 3, scope.getCanonicalCwd());
        statement.setString(start + 4, scope.getCapabilityDigest());
        statement.setString(start + 5, scope.getIsolationClass());
    }

    private static RuntimeBindingRecord mapBinding(ResultSet result)
            throws SQLException {
        RuntimeScope scope = mapScope(result);
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                result.getString("isolation_key"));
        String storedRequestKey = result.getString("request_key");
        if (!JdbcRepositorySupport.requestKey(request).equals(
                storedRequestKey)) {
            throw new IllegalStateException(
                    "Runtime binding request hash is invalid");
        }
        RuntimeLease lease = mapLease(result);
        return new RuntimeBindingRecord(result.getString("binding_id"),
                request, result.getLong("runtime_generation"),
                RuntimeBindingRecord.State.valueOf(
                        result.getString("binding_state")),
                lease, result.getBoolean("drain_requested"),
                result.getString("operation_owner"),
                JdbcRepositorySupport.getInstant(result,
                        "operation_lease_until"),
                result.getLong("operation_generation"),
                result.getLong("record_version"),
                JdbcRepositorySupport.getInstant(result, "last_health_at"),
                JdbcRepositorySupport.getInstant(result, "last_active_at"));
    }

    private static RuntimeScope mapScope(ResultSet result)
            throws SQLException {
        return new RuntimeScope(result.getString("tenant_id"),
                result.getString("workspace_id"),
                result.getString("workspace_generation"),
                result.getString("canonical_cwd"),
                result.getString("capability_digest"),
                result.getString("isolation_class"));
    }

    private static RuntimeLease mapLease(ResultSet result)
            throws SQLException {
        String runtimeInstanceId = result.getString("runtime_instance_id");
        String endpoint = result.getString("runtime_endpoint");
        String token = result.getString("runtime_token");
        String leaseId = result.getString("runtime_lease_id");
        Object epoch = result.getObject("runtime_epoch");
        boolean absent = runtimeInstanceId == null && endpoint == null
                && token == null && leaseId == null && epoch == null;
        if (absent) {
            return null;
        }
        if (runtimeInstanceId == null || endpoint == null || token == null
                || leaseId == null || epoch == null) {
            throw new IllegalStateException(
                    "Runtime lease columns are incomplete");
        }
        return new RuntimeLease(runtimeInstanceId, URI.create(endpoint), token,
                leaseId, ((Number) epoch).longValue());
    }

    private static void requireRequest(RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
    }

    private static void requireSlotIdentity(Slot slot,
            RuntimeProvisionRequest request) {
        if (slot == null) {
            throw new IllegalArgumentException(
                    "isolationKey is bound to another Runtime scope");
        }
        if (!slot.request.equals(request)) {
            throw new IllegalStateException(
                    "Runtime binding request hash collision");
        }
    }

    private static void requireReplacement(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || replacement.getVersion() != expected.getVersion()) {
            throw new IllegalArgumentException(
                    "replacement must preserve binding identity and version");
        }
    }

    private static final class Slot {
        private final RuntimeProvisionRequest request;
        private final long lastGeneration;
        private final String activeBindingId;

        private Slot(RuntimeProvisionRequest request, long lastGeneration,
                String activeBindingId) {
            this.request = Objects.requireNonNull(request);
            this.lastGeneration = lastGeneration;
            this.activeBindingId = activeBindingId;
        }
    }
}
