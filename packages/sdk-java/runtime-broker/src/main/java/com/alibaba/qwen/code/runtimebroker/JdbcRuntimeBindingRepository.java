package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;
import java.nio.charset.StandardCharsets;
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
            "provisioner_kind", "runtime_generation", "binding_state",
            "provision_request_id", "provision_seed_ciphertext",
            "credential_key_id", "resource_handle_version",
            "resource_handle_json", "runtime_instance_id",
            "runtime_endpoint", "runtime_lease_id", "runtime_epoch",
            "runtime_credential_ciphertext", "runtime_credential_key_id",
            "attestation_generation", "drain_requested", "operation_owner",
            "operation_lease_until", "operation_generation",
            "record_version", "last_health_at", "last_reconciled_at",
            "last_active_at", "storage_id");

    private final DataSource dataSource;
    private final SecretProtector secretProtector;
    private final Supplier<String> idSupplier;

    public JdbcRuntimeBindingRepository(DataSource dataSource,
            SecretProtector secretProtector) {
        this(dataSource, secretProtector, () -> UUID.randomUUID().toString());
    }

    public JdbcRuntimeBindingRepository(DataSource dataSource,
            SecretProtector secretProtector, Supplier<String> idSupplier) {
        this.dataSource = JdbcRepositorySupport.requireDataSource(dataSource);
        if (secretProtector == null) {
            throw new IllegalArgumentException("secretProtector is required");
        }
        this.secretProtector = secretProtector;
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
            RuntimeProvisionSeed seed = request.requiresDurableIdentity()
                    ? RuntimeProvisionSeed.create(bindingId, generation)
                    : null;
            RuntimeBindingRecord created = new RuntimeBindingRecord(
                    bindingId, request, seed, generation,
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
            RuntimeScope scope, String isolationKey) {
        if (scope == null) {
            throw new IllegalArgumentException("scope is required");
        }
        String key = BrokerValues.requireId(isolationKey, "isolationKey");
        return JdbcRepositorySupport.read(dataSource, connection -> {
            List<RuntimeBindingRecord> records = new ArrayList<>();
            String sql = "SELECT " + BINDING_COLUMNS
                    + " FROM qwen_runtime_binding WHERE scope_key = ? "
                    + "AND isolation_key = ? "
                    + "AND binding_state NOT IN ('FAILED', 'RELEASED')";
            try (PreparedStatement statement = connection.prepareStatement(
                    sql)) {
                statement.setString(1, JdbcRepositorySupport.scopeKey(scope));
                statement.setString(2, key);
                try (ResultSet result = statement.executeQuery()) {
                    while (result.next()) {
                        RuntimeBindingRecord record = mapBinding(result);
                        if (!scope.equals(record.getRequest().getScope())
                                || !key.equals(record.getRequest()
                                        .getIsolationKey())) {
                            throw new IllegalStateException(
                                    "Runtime binding scope hash collision");
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
            Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
            if (current == null || !current.sameIdentity(expected)
                    || current.getVersion() != expected.getVersion()
                    || !current.sameOperation(expected)
                    || !current.hasLiveOperationAt(now)) {
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
            Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
            if (ownerId.equals(current.getOperationOwner())
                    && current.getOperationLeaseUntil().isAfter(now)) {
                return current;
            }
            if (current.getOperationOwner() != null
                    && current.getOperationLeaseUntil().isAfter(now)) {
                return null;
            }
            RuntimeBindingRecord claimed = current.withOperation(ownerId,
                    JdbcRepositorySupport.leaseUntil(now, duration),
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
            Instant now = JdbcRepositorySupport.databaseNowPrecise(connection);
            if (!ownerId.equals(current.getOperationOwner())
                    || operationGeneration
                            != current.getOperationGeneration()
                    || !current.getOperationLeaseUntil().isAfter(now)) {
                return null;
            }
            RuntimeBindingRecord renewed = current.withOperation(ownerId,
                    JdbcRepositorySupport.leaseUntil(now, duration),
                    operationGeneration)
                    .withVersion(current.getVersion() + 1);
            updateBinding(connection, renewed);
            return renewed;
        });
    }

    @Override
    public RuntimeBindingRecord releaseOperation(String bindingId,
            String owner, long operationGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            RuntimeBindingRecord current = selectById(connection, id, true);
            if (current == null || !current.isActive()) {
                return null;
            }
            if (!ownerId.equals(current.getOperationOwner())
                    || operationGeneration
                            != current.getOperationGeneration()) {
                return null;
            }
            RuntimeBindingRecord released = current.withOperation(null,
                    null, operationGeneration)
                    .withVersion(current.getVersion() + 1);
            updateBinding(connection, released);
            return released;
        });
    }

    private static void ensureSlot(Connection connection, String requestKey,
            RuntimeProvisionRequest request) throws SQLException {
        RuntimeScope scope = request.getScope();
        String sql = "INSERT INTO qwen_runtime_binding_slot (request_key, "
                + "tenant_id, workspace_id, workspace_generation, "
                + "canonical_cwd, capability_digest, isolation_class, "
                + "isolation_key, provisioner_kind, last_generation, "
                + "active_binding_id, storage_id) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?) "
                + "ON DUPLICATE KEY UPDATE request_key = request_key";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, requestKey);
            setScope(statement, 2, scope);
            statement.setString(8, request.getIsolationKey());
            statement.setString(9, request.getProvisionerKind());
            statement.setString(10, request.getStorageId());
            statement.executeUpdate();
        }
    }

    private static Slot selectSlot(Connection connection, String requestKey,
            boolean forUpdate) throws SQLException {
        String sql = "SELECT tenant_id, workspace_id, "
                + "workspace_generation, canonical_cwd, capability_digest, "
                + "isolation_class, isolation_key, provisioner_kind, "
                + "last_generation, active_binding_id, storage_id "
                + "FROM qwen_runtime_binding_slot "
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
                        scope, result.getString("isolation_key"),
                        result.getString("provisioner_kind"),
                        result.getString("storage_id"));
                return new Slot(request,
                        result.getLong("last_generation"),
                        result.getString("active_binding_id"));
            }
        }
    }

    private RuntimeBindingRecord selectById(Connection connection,
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

    private void insertBinding(Connection connection,
            RuntimeBindingRecord record) throws SQLException {
        String sql = "INSERT INTO qwen_runtime_binding (" + BINDING_COLUMNS
                + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            setBinding(statement, record);
            statement.executeUpdate();
        }
    }

    private void updateBinding(Connection connection,
            RuntimeBindingRecord record) throws SQLException {
        // The provision seed is immutable after INSERT, so the update never
        // re-encrypts it; renewal ticks would otherwise pay an AES-GCM
        // encryption with a fresh IV for state that cannot change.
        String sql = "UPDATE qwen_runtime_binding SET binding_state = ?, "
                + "resource_handle_version = ?, resource_handle_json = ?, "
                + "runtime_instance_id = ?, runtime_endpoint = ?, "
                + "runtime_lease_id = ?, runtime_epoch = ?, "
                + "runtime_credential_ciphertext = ?, "
                + "runtime_credential_key_id = ?, "
                + "attestation_generation = ?, drain_requested = ?, "
                + "operation_owner = ?, operation_lease_until = ?, "
                + "operation_generation = ?, record_version = ?, "
                + "last_health_at = ?, last_reconciled_at = ?, "
                + "last_active_at = ? WHERE binding_id = ?";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, record.getState().name());
            setHandleColumns(statement, 2, record);
            RuntimeLease lease = record.getLease();
            statement.setString(4,
                    lease == null ? null : lease.getRuntimeInstanceId());
            statement.setString(5,
                    lease == null ? null : lease.getEndpoint().toString());
            statement.setString(6,
                    lease == null ? null : lease.getLeaseId());
            if (lease == null) {
                statement.setObject(7, null);
            } else {
                statement.setLong(7, lease.getEpoch());
            }
            ProtectedSecret credential = protectLeaseToken(record);
            statement.setString(8,
                    credential == null ? null : credential.getCiphertext());
            statement.setString(9,
                    credential == null ? null : credential.getKeyId());
            statement.setLong(10, record.getAttestationGeneration());
            statement.setBoolean(11, record.isDrainRequested());
            statement.setString(12, record.getOperationOwner());
            JdbcRepositorySupport.setInstant(statement, 13,
                    record.getOperationLeaseUntil());
            statement.setLong(14, record.getOperationGeneration());
            statement.setLong(15, record.getVersion());
            JdbcRepositorySupport.setInstant(statement, 16,
                    record.getLastHealthAt());
            JdbcRepositorySupport.setInstant(statement, 17,
                    record.getLastReconciledAt());
            JdbcRepositorySupport.setInstant(statement, 18,
                    record.getLastActiveAt());
            statement.setString(19, record.getBindingId());
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Runtime binding update failed");
            }
        }
    }

    private void setBinding(PreparedStatement statement,
            RuntimeBindingRecord record) throws SQLException {
        RuntimeProvisionRequest request = record.getRequest();
        RuntimeScope scope = request.getScope();
        statement.setString(1, record.getBindingId());
        statement.setString(2, JdbcRepositorySupport.requestKey(request));
        statement.setString(3, JdbcRepositorySupport.scopeKey(scope));
        setScope(statement, 4, scope);
        statement.setString(10, request.getIsolationKey());
        statement.setString(11, request.getProvisionerKind());
        statement.setLong(12, record.getGeneration());
        statement.setString(13, record.getState().name());
        setSeedColumns(statement, 14, record);
        setHandleColumns(statement, 17, record);
        RuntimeLease lease = record.getLease();
        statement.setString(19,
                lease == null ? null : lease.getRuntimeInstanceId());
        statement.setString(20,
                lease == null ? null : lease.getEndpoint().toString());
        statement.setString(21, lease == null ? null : lease.getLeaseId());
        if (lease == null) {
            statement.setObject(22, null);
        } else {
            statement.setLong(22, lease.getEpoch());
        }
        ProtectedSecret credential = protectLeaseToken(record);
        statement.setString(23,
                credential == null ? null : credential.getCiphertext());
        statement.setString(24,
                credential == null ? null : credential.getKeyId());
        statement.setLong(25, record.getAttestationGeneration());
        statement.setBoolean(26, record.isDrainRequested());
        statement.setString(27, record.getOperationOwner());
        JdbcRepositorySupport.setInstant(statement, 28,
                record.getOperationLeaseUntil());
        statement.setLong(29, record.getOperationGeneration());
        statement.setLong(30, record.getVersion());
        JdbcRepositorySupport.setInstant(statement, 31,
                record.getLastHealthAt());
        JdbcRepositorySupport.setInstant(statement, 32,
                record.getLastReconciledAt());
        JdbcRepositorySupport.setInstant(statement, 33,
                record.getLastActiveAt());
        statement.setString(34, request.getStorageId());
    }

    private void setSeedColumns(PreparedStatement statement, int start,
            RuntimeBindingRecord record) throws SQLException {
        RuntimeProvisionSeed seed = record.getProvisionSeed();
        ProtectedSecret protectedSeed = seed == null ? null
                : secretProtector.protect(seedContext(record.getBindingId()),
                        seed.encode());
        statement.setString(start,
                seed == null ? null : seed.getProvisionRequestId());
        statement.setString(start + 1, protectedSeed == null ? null
                : protectedSeed.getCiphertext());
        statement.setString(start + 2, protectedSeed == null ? null
                : protectedSeed.getKeyId());
    }

    private static void setHandleColumns(PreparedStatement statement,
            int start, RuntimeBindingRecord record) throws SQLException {
        RuntimeResourceHandle handle = record.getResourceHandle();
        if (handle == null) {
            statement.setObject(start, null);
            statement.setString(start + 1, null);
        } else {
            statement.setInt(start, handle.getVersion());
            statement.setString(start + 1, handle.toJson());
        }
    }

    private ProtectedSecret protectLeaseToken(RuntimeBindingRecord record) {
        RuntimeLease lease = record.getLease();
        if (lease == null || record.getProvisionSeed() != null) {
            return null;
        }
        return secretProtector.protect(
                leaseTokenContext(record.getBindingId()),
                lease.getToken().getBytes(StandardCharsets.UTF_8));
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

    private RuntimeBindingRecord mapBinding(ResultSet result)
            throws SQLException {
        RuntimeScope scope = mapScope(result);
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                result.getString("isolation_key"),
                result.getString("provisioner_kind"),
                result.getString("storage_id"));
        String storedRequestKey = result.getString("request_key");
        if (!JdbcRepositorySupport.requestKey(request).equals(
                storedRequestKey)) {
            throw new IllegalStateException(
                    "Runtime binding request hash is invalid");
        }
        String bindingId = result.getString("binding_id");
        RuntimeProvisionSeed seed = mapSeed(result, bindingId);
        RuntimeResourceHandle handle = mapHandle(result, request);
        RuntimeLease lease = mapLease(result, seed, bindingId);
        return new RuntimeBindingRecord(bindingId, request, seed,
                result.getLong("runtime_generation"),
                RuntimeBindingRecord.State.valueOf(
                        result.getString("binding_state")),
                lease, handle, result.getLong("attestation_generation"),
                result.getBoolean("drain_requested"),
                result.getString("operation_owner"),
                JdbcRepositorySupport.getInstant(result,
                        "operation_lease_until"),
                result.getLong("operation_generation"),
                result.getLong("record_version"),
                JdbcRepositorySupport.getInstant(result, "last_health_at"),
                JdbcRepositorySupport.getInstant(result,
                        "last_reconciled_at"),
                JdbcRepositorySupport.getInstant(result, "last_active_at"));
    }

    private RuntimeProvisionSeed mapSeed(ResultSet result, String bindingId)
            throws SQLException {
        String provisionRequestId = result.getString(
                "provision_request_id");
        String ciphertext = result.getString("provision_seed_ciphertext");
        String keyId = result.getString("credential_key_id");
        boolean absent = provisionRequestId == null && ciphertext == null
                && keyId == null;
        if (absent) {
            return null;
        }
        if (provisionRequestId == null || ciphertext == null
                || keyId == null) {
            throw new IllegalStateException(
                    "Runtime provision seed columns are incomplete");
        }
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.decode(
                secretProtector.unprotect(seedContext(bindingId),
                        new ProtectedSecret(keyId, ciphertext)));
        if (!provisionRequestId.equals(seed.getProvisionRequestId())) {
            throw new IllegalStateException(
                    "Runtime provision request identity changed");
        }
        return seed;
    }

    private static RuntimeResourceHandle mapHandle(ResultSet result,
            RuntimeProvisionRequest request) throws SQLException {
        Object version = result.getObject("resource_handle_version");
        String json = result.getString("resource_handle_json");
        if (version == null && json == null) {
            return null;
        }
        if (!(version instanceof Number) || json == null) {
            throw new IllegalStateException(
                    "Runtime resource handle columns are incomplete");
        }
        return RuntimeResourceHandle.fromJson(request.getProvisionerKind(),
                ((Number) version).intValue(), json);
    }

    private RuntimeLease mapLease(ResultSet result,
            RuntimeProvisionSeed seed, String bindingId)
            throws SQLException {
        String runtimeInstanceId = result.getString("runtime_instance_id");
        String endpoint = result.getString("runtime_endpoint");
        String leaseId = result.getString("runtime_lease_id");
        Object epoch = result.getObject("runtime_epoch");
        String ciphertext = result.getString(
                "runtime_credential_ciphertext");
        String keyId = result.getString("runtime_credential_key_id");
        boolean absent = runtimeInstanceId == null && endpoint == null
                && leaseId == null && epoch == null;
        if (absent) {
            if (ciphertext != null || keyId != null) {
                throw new IllegalStateException(
                        "Runtime credential columns are inconsistent");
            }
            return null;
        }
        if (runtimeInstanceId == null || endpoint == null
                || leaseId == null || epoch == null) {
            throw new IllegalStateException(
                    "Runtime lease columns are incomplete");
        }
        String token;
        if (seed != null) {
            if (ciphertext != null || keyId != null) {
                throw new IllegalStateException(
                        "Runtime credential columns are inconsistent");
            }
            token = seed.getToken();
        } else {
            if (ciphertext == null || keyId == null) {
                throw new IllegalStateException(
                        "Runtime credential columns are incomplete");
            }
            token = new String(secretProtector.unprotect(
                    leaseTokenContext(bindingId),
                    new ProtectedSecret(keyId, ciphertext)),
                    StandardCharsets.UTF_8);
        }
        return new RuntimeLease(runtimeInstanceId, URI.create(endpoint),
                token, leaseId, ((Number) epoch).longValue());
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

    private static String seedContext(String bindingId) {
        return "runtime-provision-seed:"
                + JdbcRepositorySupport.valueKey(bindingId);
    }

    private static String leaseTokenContext(String bindingId) {
        return "runtime-lease-token:"
                + JdbcRepositorySupport.valueKey(bindingId);
    }

    private static void requireRequest(RuntimeProvisionRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
    }

    private static void requireSlotIdentity(Slot slot,
            RuntimeProvisionRequest request) {
        if (!slot.request.equals(request)) {
            throw new IllegalStateException(
                    "Runtime binding request hash collision");
        }
    }

    private static void requireReplacement(RuntimeBindingRecord expected,
            RuntimeBindingRecord replacement) {
        if (expected == null || replacement == null
                || !expected.sameIdentity(replacement)
                || !expected.sameOperation(replacement)
                || replacement.getVersion() != expected.getVersion()) {
            throw new IllegalArgumentException(
                    "replacement must preserve binding identity, "
                            + "operation claim, and version");
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
