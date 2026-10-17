package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

import javax.sql.DataSource;

/** JDBC Runtime binding repository coordinated through a shared database. */
public final class JdbcRuntimeBindingRepository
        implements RuntimeBindingRepository {
    private static final String BINDING_COLUMNS =
            String.join(
                    ", ",
                    "binding_id",
                    "request_key",
                    "scope_key",
                    "tenant_id",
                    "workspace_id",
                    "workspace_generation",
                    "canonical_cwd",
                    "capability_digest",
                    "isolation_class",
                    "isolation_key",
                    "provisioner_kind",
                    "runtime_generation",
                    "binding_state",
                    "provision_request_id",
                    "provision_seed_ciphertext",
                    "credential_key_id",
                    "resource_handle_version",
                    "resource_handle_json",
                    "runtime_instance_id",
                    "runtime_endpoint",
                    "runtime_lease_id",
                    "runtime_epoch",
                    "runtime_credential_ciphertext",
                    "runtime_credential_key_id",
                    "attestation_generation",
                    "drain_requested",
                    "operation_owner",
                    "operation_lease_until",
                    "operation_generation",
                    "record_version",
                    "last_health_at",
                    "last_reconciled_at",
                    "last_active_at",
                    "storage_id",
                    "loss_evidence_json",
                    "stop_evidence_json",
                    "drain_receipt_json",
                    "storage_alias_key");

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
    public RuntimeSessionRecord completeSessionRelease(RuntimeSessionRepository sessions,
            RuntimeSessionRecord expected) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Release requires the same DataSource");
        }
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    if (JdbcCsiFilesRetirementGuard.lockRuntimeSession(connection, expected)
                            != null) {
                        throw JdbcCsiFilesRetirementGuard.releaseUnavailable();
                    }
                    RuntimeBindingRecord binding =
                            selectById(connection, expected.getBindingId(), true);
                    RuntimeAdmission.requireRelease(binding, expected);
                    return JdbcRuntimeSessionRepository.compareAndSet(
                            connection,
                            expected,
                            expected.withState(
                                    RuntimeSessionRecord.State.RELEASED,
                                    JdbcRepositorySupport.databaseNow(connection)));
                });
    }

    @Override
    public RuntimeSessionRecord completeStoppedSessionRelease(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeSessionRecord expected, RuntimeBindingRecord claim) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcExecutions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Release requires the same DataSource");
        }
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, claim.getRequest().getScope().getTenantId());
            var authority = claim.getRequest().getScope().getLifecycleAuthority();
            if (authority != null) {
                requireHarnessAdmission(connection, claim.getRequest().getScope(), claim.getRequest().getIsolationKey(),
                        authority, fence(false, HarnessFence.CLEANUP));
            }
            RuntimeBindingRecord binding = selectById(connection, expected.getBindingId(), true);
            RuntimeAdmission.requireStoppedRelease(binding, claim, expected, JdbcRepositorySupport.databaseNowPrecise(connection));
            if (JdbcToolExecutionRepository.hasActiveByBinding(connection, binding.getBindingId(), binding.getGeneration())) {
                throw new RuntimeBrokerException(409, "workspace_close_execution_unsettled",
                        "Original resources remain active", false);
            }
            RuntimeSessionRecord updated = JdbcRuntimeSessionRepository.compareAndSet(connection, expected,
                    expected.withState(RuntimeSessionRecord.State.RELEASED, JdbcRepositorySupport.databaseNow(connection)));
            if (updated != null) {
                clearStoppedHolder(connection, binding, expected);
                RuntimeAdmission.requireStoppedRelease(binding, claim, expected, JdbcRepositorySupport.databaseNowPrecise(connection));
            }
            return updated;
        });
    }

    private static void clearStoppedHolder(Connection connection, RuntimeBindingRecord binding,
            RuntimeSessionRecord session) throws SQLException {
        String key = localStorageOwnerKey(connection, binding.getRequest().getScope().getTenantId(),
                binding.getRequest().getStorageId());
        if (key == null) {
            return;
        }
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT holder_key, binding_id, runtime_generation, runtime_session_id,"
                                + " physical_key FROM ma_storage_owner WHERE storage_key = ? AND"
                                + " storage_kind = 'LOCAL' FOR UPDATE")) {
            statement.setString(1, key);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) {
                    throw unverifiedWorkspaceHolder();
                }
                if (!key.equals(row.getString("physical_key"))) {
                    throw unverifiedWorkspaceHolder();
                }
                String holder = row.getString("holder_key");
                String holderBinding = row.getString("binding_id");
                String holderSession = row.getString("runtime_session_id");
                long generation = row.getLong("runtime_generation");
                if (holder == null && holderBinding == null && holderSession == null
                        && row.getObject("runtime_generation") == null) {
                    return;
                }
                if (holder == null || !binding.getBindingId().equals(holderBinding)
                        || binding.getGeneration() != generation || holderSession == null
                        || !holder.equals(workspaceHolderKey(holderBinding + "\u0000"
                                + generation + "\u0000" + holderSession))) {
                    throw new RuntimeBrokerException(409, "workspace_close_identity_unverified",
                            "Original Workspace holder differs", false);
                }
                if (!session.getRuntimeSessionId().equals(holderSession)) {
                    return;
                }
                try (PreparedStatement clear = connection.prepareStatement(
                                "UPDATE ma_storage_owner SET holder_key = NULL, binding_id = NULL,"
                                    + " runtime_generation = NULL, runtime_session_id = NULL WHERE"
                                    + " storage_key = ? AND storage_kind = 'LOCAL' AND holder_key ="
                                    + " ? AND binding_id = ? AND runtime_generation = ? AND"
                                    + " runtime_session_id = ?")) {
                    clear.setString(1, key);
                    clear.setString(2, holder);
                    JdbcRepositorySupport.setIdentity(clear, 3, holderBinding);
                    clear.setLong(4, generation);
                    JdbcRepositorySupport.setIdentity(clear, 5, holderSession);
                    if (clear.executeUpdate() != 1) {
                        throw new SQLException("Original Workspace holder changed");
                    }
                }
            }
        }
    }

    private static String localStorageOwnerKey(Connection connection, String tenant, String storage) throws SQLException {
        if (storage == null) {
            return null;
        }
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT tenant_id, storage_id, storage_kind,"
                                + " physical_key FROM ma_storage WHERE alias_key = ? FOR UPDATE")) {
            statement.setString(1, storageAliasKey(tenant, storage));
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) {
                    return null;
                }
                if (!tenant.equals(row.getString("tenant_id"))
                        || !storage.equals(row.getString("storage_id"))) {
                    throw unverifiedWorkspaceHolder();
                }
                if (!"LOCAL".equals(row.getString("storage_kind"))) {
                    return null;
                }
                String physical = row.getString("physical_key");
                if (physical == null) {
                    throw unverifiedWorkspaceHolder();
                }
                return physical;
            }
        }
    }

    private static void requirePhysicalStorageAdmission(Connection connection, RuntimeProvisionRequest request) throws SQLException {
        String key = localStorageOwnerKey(connection, request.getScope().getTenantId(), request.getStorageId());
        if (key == null) {
            return;
        }
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT registration_state FROM ma_storage WHERE alias_key = ?")) {
            statement.setString(1, storageAliasKey(request.getScope().getTenantId(), request.getStorageId()));
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next() || !"REGISTERED".equals(row.getString("registration_state"))) {
                    throw new RuntimeBrokerException(
                            409, "workspace_migrating", "Storage is under maintenance.", false);
                }
            }
        }
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT physical_key, mount_state, storage_kind"
                                + " FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE")) {
            statement.setString(1, key);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()
                        || !key.equals(row.getString("physical_key"))
                        || !"LOCAL".equals(row.getString("storage_kind"))
                        || !"READY".equals(row.getString("mount_state"))) {
                    throw new RuntimeBrokerException(
                            409, "workspace_migrating", "Storage is under maintenance.", false);
                }
            }
        }
    }

    private static RuntimeBrokerException unverifiedWorkspaceHolder() {
        return new RuntimeBrokerException(
                409,
                "workspace_close_identity_unverified",
                "Original Workspace holder differs",
                false);
    }

    private static String workspaceHolderKey(String identity) {
        try {
            return java.util.HexFormat.of()
                    .formatHex(
                            java.security.MessageDigest.getInstance("SHA-256")
                                    .digest(identity.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    @Override
    public RuntimeSessionRecord beginSessionRelease(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeSessionRecord expected) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcExecutions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Release requires the same DataSource");
        }
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    if (JdbcCsiFilesRetirementGuard.lockRuntimeSession(connection, expected)
                            != null) {
                        throw JdbcCsiFilesRetirementGuard.releaseUnavailable();
                    }
                    // Statement order is load-bearing under InnoDB REPEATABLE READ:
                    // this locking read must stay first, and the plain execution read
                    // below must stay the transaction's first consistent read, so its
                    // read view is built after the row lock is held and therefore
                    // sees an admission that committed before it. A read moved ahead
                    // of the lock silently reopens the race, and H2 would not show it.
                    RuntimeSessionRecord current =
                            JdbcRuntimeSessionRepository.selectSession(
                                    connection,
                                    expected.getSession().getScope(),
                                    expected.getRuntimeSessionId(),
                                    true);
                    if (current == null
                            || !current.sameIdentity(expected)
                            || current.getVersion() != expected.getVersion()) {
                        return null;
                    }
                    if (current.getState() == RuntimeSessionRecord.State.RELEASING
                            || current.getState() == RuntimeSessionRecord.State.RELEASED) {
                        return current;
                    }
                    if (current.getState() != RuntimeSessionRecord.State.READY
                            && current.getState() != RuntimeSessionRecord.State.ACQUIRING) {
                        throw new RuntimeBrokerException(
                                409,
                                "runtime_session_not_ready",
                                "Runtime Session is not ready for release",
                                false);
                    }
                    if (JdbcToolExecutionRepository.hasActiveByRuntimeSession(
                            connection,
                            current.getBindingId(),
                            current.getRuntimeGeneration(),
                            current.getRuntimeSessionId())) {
                        throw new RuntimeBrokerException(
                                409,
                                "runtime_session_busy",
                                "Runtime Session has an active operation",
                                false);
                    }
                    return JdbcRuntimeSessionRepository.compareAndSet(
                            connection,
                            current,
                            current.withState(
                                    RuntimeSessionRecord.State.RELEASING,
                                    JdbcRepositorySupport.databaseNow(connection)));
                });
    }

    @Override
    public RuntimeBindingRecord recoverLost(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected) {
        return recoverLost(sessions, executions, expected, !expected.getRequest().isManagedContext());
    }

    @Override
    public RuntimeBindingRecord finishLostRecovery(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected) {
        return recoverLost(sessions, executions, expected, true);
    }

    private RuntimeBindingRecord recoverLost(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord expected, boolean holdersCleared) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcExecutions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Recovery requires the same DataSource");
        }
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    lockPlacementDomain(connection, expected.getRequest().getScope().getTenantId());
                    String key = JdbcRepositorySupport.requestKey(expected.getRequest());
                    Slot slot = selectSlot(connection, key, true);
                    if (slot == null) {
                        return null;
                    }
                    requireSlotIdentity(slot, expected.getRequest());
                    RuntimeBindingRecord current =
                            selectById(connection, expected.getBindingId(), true);
                    if (current == null
                            || !current.sameIdentity(expected)
                            || current.getVersion() != expected.getVersion()
                            || !current.sameOperation(expected)
                            || !current.hasLiveOperationAt(
                                    JdbcRepositorySupport.databaseNowPrecise(connection))
                            || current.getState() != RuntimeBindingRecord.State.LOST
                            || !current.getBindingId().equals(slot.activeBindingId)) {
                        return null;
                    }
                    if (JdbcCsiFilesRetirementGuard.isProfile(current.getRequest().getScope())) {
                        throw JdbcCsiFilesRetirementGuard.releaseUnavailable();
                    }
                    if (current.getLossEvidence() == null) {
                        return current;
                    }
                    if ("kubernetes-workspace".equals(current.getRequest().getProvisionerKind())
                            && current.isDrainRequested()) {
                        return current;
                    }
                    List<RuntimeSessionRecord> batch =
                            JdbcRuntimeSessionRepository.lockActiveSessions(connection, current);
                    JdbcToolExecutionRepository.abandonByBinding(connection, current);
                    if (!holdersCleared
                            || !current.hasStoppedWriters()
                            || JdbcToolExecutionRepository.hasActiveByBinding(
                                    connection, current.getBindingId(), current.getGeneration())) {
                        return current;
                    }
                    Instant now = JdbcRepositorySupport.databaseNow(connection);
                    JdbcRuntimeSessionRepository.releaseLost(connection, batch, now);
                    if (JdbcRuntimeSessionRepository.hasActiveByBinding(connection, current)) {
                        return current;
                    }
                    if (!current.hasLiveOperationAt(
                            JdbcRepositorySupport.databaseNowPrecise(connection))) {
                        throw new RuntimeBrokerException(
                                409,
                                "runtime_provision_fenced",
                                "Runtime recovery claim expired",
                                false);
                    }
                    RuntimeBindingRecord released =
                            current.withState(
                                            RuntimeBindingRecord.State.RELEASED,
                                            current.getLease(),
                                            now)
                                    .withVersion(current.getVersion() + 1);
                    updateBinding(connection, released);
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "UPDATE ma_runtime_slot SET active_binding_id = NULL "
                                            + "WHERE request_key = ? AND active_binding_id = ?")) {
                        statement.setString(1, key);
                        JdbcRepositorySupport.setIdentity(statement, 2, current.getBindingId());
                        if (statement.executeUpdate() != 1) {
                            throw new SQLException("Lost binding retirement failed");
                        }
                    }
                    return released;
                });
    }

    @Override
    public RuntimeSessionRecord admitSession(RuntimeSessionRepository sessions,
            RuntimeSessionRecord candidate) {
        JdbcRuntimeSessionRepository.requireCandidate(candidate);
        return admitSession(sessions, candidate, false);
    }

    @Override
    public RuntimeSessionRecord requireSessionAdmission(
            RuntimeSessionRepository sessions, RuntimeSessionRecord expected) {
        if (expected == null || expected.getState() != RuntimeSessionRecord.State.READY) {
            throw new IllegalArgumentException("Admission check requires a READY Session");
        }
        return admitSession(sessions, expected, true);
    }

    private RuntimeSessionRecord admitSession(
            RuntimeSessionRepository sessions,
            RuntimeSessionRecord candidate,
            boolean existingOnly) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Admission requires the same DataSource");
        }
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    JdbcCsiFilesRetirementGuard.Original original =
                            JdbcCsiFilesRetirementGuard.lockRuntimeSession(connection, candidate);
                    if (original != null) {
                        original.requireAdmission();
                        JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
                    }
                    lockPlacementDomain(
                            connection, candidate.getSession().getScope().getTenantId());
                    RuntimeBindingRecord binding =
                            selectById(connection, candidate.getBindingId(), true);
                    if (binding != null) {
                        if (binding.getRequest().getStorageId() != null
                                && storageFence(
                                                connection,
                                                binding.getRequest().getScope().getTenantId(),
                                                binding.getRequest().getStorageId())
                                        != null) {
                            throw new RuntimeBrokerException(
                                    409,
                                    "workspace_migrating",
                                    "Storage is under maintenance.",
                                    false);
                        }
                        requirePhysicalStorageAdmission(connection, binding.getRequest());
                        requireHarnessAdmission(
                                connection,
                                candidate.getSession().getScope(),
                                candidate.getSession().getHarnessSessionId(),
                                candidate.getSession().getScope().getLifecycleAuthority(),
                                fence(HarnessOwnership.sharesRuntimeSessions(binding.getRequest())));
                    }
                    RuntimeAdmission.requireReady(binding, candidate.getRuntimeGeneration());
                    RuntimeScope scope = candidate.getSession().getScope();
                    if (!binding.getRequest().getScope().equals(scope)) {
                        throw new IllegalArgumentException("Session scope differs from binding");
                    }
                    RuntimeSessionRecord existing =
                            JdbcRuntimeSessionRepository.selectSession(
                                    connection, scope, candidate.getRuntimeSessionId(), true);
                    if (existing != null) {
                        if (!existing.sameIdentity(candidate)) {
                            throw new IllegalArgumentException("Session identity differs");
                        }
                        if (existingOnly
                                && existing.getState() != RuntimeSessionRecord.State.READY) {
                            throw new RuntimeBrokerException(
                                    409,
                                    "runtime_session_not_ready",
                                    "Runtime Session is not ready",
                                    false);
                        }
                        return existing;
                    }
                    if (existingOnly) {
                        throw new RuntimeBrokerException(
                                409,
                                "runtime_session_not_ready",
                                "Runtime Session is not ready",
                                false);
                    }
                    if (ResidentWorkspaceProfile.selects(binding.getRequest())
                            && JdbcRuntimeSessionRepository.hasActiveByBinding(connection, binding)) {
                        throw new RuntimeBrokerException(409, "workspace_busy",
                                "The resident Workspace already has an active tool context", true);
                    }
                    JdbcRuntimeSessionRepository.insertSession(connection, candidate);
                    return candidate;
                });
    }

    @Override
    public RuntimeSessionRecord createSessionTombstone(RuntimeSessionRepository sessions,
            RuntimeSessionRecord candidate) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Retirement requires the same DataSource");
        }
        JdbcRuntimeSessionRepository.requireCandidate(candidate);
        if (candidate.getState() != RuntimeSessionRecord.State.RELEASED) {
            throw new IllegalArgumentException("Tombstone must be RELEASED");
        }
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            RuntimeScope scope = candidate.getSession().getScope();
            lockPlacementDomain(connection, scope.getTenantId());
            RuntimeBindingRecord binding = selectById(connection, candidate.getBindingId(), true);
            RuntimeAdmission.requireRelease(binding, candidate);
            requireHarnessAdmission(connection, scope, candidate.getSession().getHarnessSessionId(),
                    scope.getLifecycleAuthority(),
                    fence(HarnessOwnership.sharesRuntimeSessions(binding.getRequest()), HarnessFence.RETIREMENT));
            RuntimeSessionRecord existing = JdbcRuntimeSessionRepository.selectSession(
                    connection, scope, candidate.getRuntimeSessionId(), true);
            if (existing != null) {
                if (!existing.sameIdentity(candidate)) {
                    throw new IllegalArgumentException("Session identity differs");
                }
                return existing;
            }
            JdbcRuntimeSessionRepository.insertSession(connection, candidate);
            return candidate;
        });
    }

    @Override
    public ToolExecutionRecord admitExecution(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord candidate) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcExecutions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Admission requires the same DataSource");
        }
        JdbcToolExecutionRepository.requireCandidate(candidate);
        ToolExecutionRecord existing = executions.findByIdempotencyKey(
                candidate.getIdempotencyKey());
        RuntimeBindingRecord original = findById(candidate.getBindingId());
        if (original == null) {
            throw new IllegalArgumentException("Binding is unavailable");
        }
        boolean csi = JdbcCsiFilesRetirementGuard.isProfile(original.getRequest().getScope());
        if (existing != null && !csi) {
            return existing;
        }
        try {
            return JdbcRepositorySupport.transaction(
                    dataSource,
                    connection -> {
                        lockPlacementDomain(
                                connection, original.getRequest().getScope().getTenantId());
                        var csiOriginal =
                                JdbcCsiActivationAdmission.lockForExecution(
                                        connection, original, this);
                        JdbcCsiActivationAdmission.requireExecution(csiOriginal, candidate);
                        RuntimeBindingRecord binding =
                                selectById(connection, candidate.getBindingId(), true);
                        if (binding != null && HarnessOwnership.sharesRuntimeSessions(binding.getRequest())) {
                            requireStorageAdmission(connection, binding.getRequest());
                            requireHarnessAdmission(connection, binding.getRequest().getScope(),
                                    candidate.getHarnessSessionId(),
                                    binding.getRequest().getScope().getLifecycleAuthority(), fence(true));
                        } else if (binding != null) {
                            requireHarnessAdmission(connection, binding.getRequest());
                        }
                        RuntimeAdmission.requireReady(binding, candidate.getRuntimeGeneration());
                        RuntimeAdmission.requireSession(
                                JdbcRuntimeSessionRepository.selectSession(
                                        connection,
                                        binding.getRequest().getScope(),
                                        candidate.getRuntimeSessionId(),
                                        true),
                                candidate);
                        if (csiOriginal != null) {
                            throw new RuntimeBrokerException(
                                    501,
                                    "csi_native_resources_required",
                                    "CSI allocation requires original assistant and resource"
                                            + " bytes.",
                                    false);
                        }
                        ToolExecutionRecord receipt =
                                JdbcToolExecutionRepository.selectByIdempotencyKey(
                                        connection,
                                        candidate.getIdempotencyKey(),
                                        csiOriginal != null);
                        if (receipt != null) {
                            if (csiOriginal != null && !receipt.sameRequest(candidate)) {
                                throw new IllegalArgumentException("Execution identity differs");
                            }
                            return receipt;
                        }
                        JdbcToolExecutionRepository.insertExecution(connection, candidate);
                        return candidate;
                    });
        } catch (IllegalStateException failure) {
            if (!csi && JdbcRepositorySupport.isConstraintViolation(failure)) {
                ToolExecutionRecord winner = executions.findByIdempotencyKey(
                        candidate.getIdempotencyKey());
                if (winner != null) {
                    return winner;
                }
            }
            throw failure;
        }
    }

    ToolExecutionRecord prepareCsiExecution(
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions,
            RuntimeBindingRecord hint,
            ToolExecutionRecord candidate,
            byte[] input,
            byte[] definition) {
        requireCsiRepositories(sessions, executions);
        JdbcToolExecutionRepository.requireCandidate(candidate);
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    var admission =
                            JdbcCsiActivationAdmission.lockForReservation(connection, hint, this);
                    var original = admission.original();
                    var resources = CsiNativeToolReservation.inventory(connection, original);
                    JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
                    RuntimeAdmission.requireReady(
                            selectById(connection, original.bindingId(), true),
                            original.generation());
                    RuntimeAdmission.requireSession(
                            JdbcRuntimeSessionRepository.selectSession(
                                    connection,
                                    original.request().getScope(),
                                    original.request().getIsolationKey(),
                                    true),
                            candidate);
                    var result =
                            CsiNativeToolReservation.prepare(
                                    connection,
                                    original,
                                    admission.prefix(),
                                    resources,
                                    candidate,
                                    input,
                                    definition);
                    admission.head().requireCurrentTime(connection);
                    return result;
                });
    }

    Map<String, Object> readCsiBatch(
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions,
            RuntimeBindingRecord hint,
            String promptId,
            String batchId) {
        requireCsiRepositories(sessions, executions);
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    var admission =
                            JdbcCsiActivationAdmission.lockForReservation(connection, hint, this);
                    var original = admission.original();
                    var resources = CsiNativeToolReservation.inventory(connection, original);
                    JdbcCsiFilesRetirementGuard.requireSingleSession(connection, original);
                    RuntimeAdmission.requireReady(
                            selectById(connection, original.bindingId(), true),
                            original.generation());
                    RuntimeSessionRecord runtime =
                            JdbcRuntimeSessionRepository.selectSession(
                                    connection,
                                    original.request().getScope(),
                                    original.request().getIsolationKey(),
                                    true);
                    original.requireSession(runtime);
                    if (runtime.getState() != RuntimeSessionRecord.State.READY) {
                        throw new RuntimeBrokerException(
                                409,
                                "runtime_admission_closed",
                                "Original CSI Runtime Session is not ready",
                                false);
                    }
                    var result =
                            CsiNativeToolReservation.read(
                                    connection,
                                    original,
                                    admission.prefix(),
                                    resources,
                                    promptId,
                                    batchId);
                    admission.head().requireCurrentTime(connection);
                    return result;
                });
    }

    private void requireCsiRepositories(
            RuntimeSessionRepository sessions, ToolExecutionRepository executions) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcExecutions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("CSI allocation requires the same DataSource");
        }
    }

    @Override
    public void requestHarnessDrain(String tenantId, String harnessSessionId) {
        BrokerValues.requireId(tenantId, "tenantId");
        BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, tenantId);
            try (PreparedStatement statement = connection.prepareStatement(
                                    "INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, harness_session_id, session_id, head_kind, phase, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, 'HARNESS', 'DRAINING', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE gmt_modified = CASE WHEN phase IS NULL OR phase <> 'DRAINING' OR claim_lease_until IS NOT NULL THEN VALUES(gmt_modified) ELSE gmt_modified END, phase = 'DRAINING', claim_lease_until = NULL")) {
                statement.setString(1, harnessDrainKey(tenantId));
                statement.setString(2, harnessDrainKey(harnessSessionId));
                JdbcRepositorySupport.setIdentity(statement, 3, tenantId);
                JdbcRepositorySupport.setIdentity(statement, 4, harnessSessionId);
                JdbcRepositorySupport.setIdentity(statement, 5, harnessSessionId);
                statement.executeUpdate();
            }
            return null;
        });
    }

    public static String harnessDrainKey(String value) {
        return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(value);
    }

    @Override
    public boolean isHarnessDraining(String tenantId, String harnessSessionId) {
        return JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "SELECT phase FROM ma_session_head"
                                            + " WHERE tenant_key = ? AND harness_key = ?")) {
                        statement.setString(1, harnessDrainKey(tenantId));
                        statement.setString(2, harnessDrainKey(harnessSessionId));
                        try (ResultSet row = statement.executeQuery()) {
                            return row.next() && "DRAINING".equals(row.getString(1));
                        }
                    }
                });
    }

    @Override
    public boolean isHarnessAdmissionClosed(String tenantId, String harnessSessionId) {
        return JdbcRepositorySupport.read(dataSource, connection -> hasHarnessDrain(connection, tenantId, harnessSessionId));
    }

    private static boolean hasHarnessDrain(Connection connection, String tenantId, String harnessSessionId)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT tenant_id, harness_session_id, phase FROM ma_session_head WHERE"
                                + " tenant_key = ? AND harness_key = ?")) {
            statement.setString(1, harnessDrainKey(tenantId));
            statement.setString(2, harnessDrainKey(harnessSessionId));
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return false;
                }
                if (!tenantId.equals(result.getString("tenant_id"))
                        || !harnessSessionId.equals(result.getString("harness_session_id"))) {
                    throw new IllegalStateException("Harness drain hash collision");
                }
                return !"OPEN".equals(result.getString("phase"));
            }
        }
    }

    private static void requireHarnessAdmission(Connection connection, RuntimeProvisionRequest request)
            throws SQLException {
        requireStorageAdmission(connection, request);
        requireHarnessAdmission(connection, request.getScope(), request.getIsolationKey(),
                request.getScope().getLifecycleAuthority());
    }

    private static void requireStorageAdmission(Connection connection, RuntimeProvisionRequest request)
            throws SQLException {
        if (request.getStorageId() != null && storageFence(connection,
                request.getScope().getTenantId(), request.getStorageId()) != null) {
            throw new RuntimeBrokerException(
                    409, "workspace_migrating", "Storage is under maintenance.", false);
        }
        requirePhysicalStorageAdmission(connection, request);
    }

    @Override
    public void requireHarnessAdmission(RuntimeScope scope, String harnessSessionId, RuntimeLifecycleAuthority authority) {
        JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, scope.getTenantId());
            requireHarnessAdmission(connection, scope, harnessSessionId, authority);
            return null;
        });
    }

    @Override
    public void requireHarnessAdmission(RuntimeProvisionRequest bindingRequest, RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        if (!HarnessOwnership.sharesRuntimeSessions(bindingRequest)) {
            requireHarnessAdmission(scope, harnessSessionId, authority);
            return;
        }
        JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, scope.getTenantId());
            requireHarnessAdmission(connection, scope, harnessSessionId, authority, fence(true));
            return null;
        });
    }

    @Override
    public boolean requireHarnessRecovery(RuntimeScope scope, String harnessSessionId, RuntimeLifecycleAuthority authority) {
        return requireHarnessRecovery(scope, harnessSessionId, authority, false);
    }

    @Override
    public boolean requireHarnessRecovery(RuntimeProvisionRequest bindingRequest, RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        return requireHarnessRecovery(scope, harnessSessionId, authority, HarnessOwnership.sharesRuntimeSessions(bindingRequest));
    }

    private boolean requireHarnessRecovery(RuntimeScope scope, String harnessSessionId, RuntimeLifecycleAuthority authority,
            boolean runtimeSessionOwner) {
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    lockPlacementDomain(connection, scope.getTenantId());
                    try (PreparedStatement fence =
                            connection.prepareStatement(
                                    "SELECT operation_id FROM ma_session_head"
                                            + " WHERE tenant_key = ? AND harness_key = ?")) {
                        fence.setString(1, harnessDrainKey(scope.getTenantId()));
                        fence.setString(2, harnessDrainKey(harnessSessionId));
                        try (ResultSet row = fence.executeQuery()) {
                            if (!row.next() || row.getString(1) == null) {
                                return false;
                            }
                        }
                    }
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "SELECT o.lifecycle_protocol_version FROM ma_session_head f"
                                        + " JOIN ma_operation o ON o.operation_kind IN ('CLOSE',"
                                        + " 'ARCHIVE', 'DELETE') AND o.tenant_id = f.tenant_id AND"
                                        + " o.session_id = f.harness_session_id AND o.operation_id"
                                        + " = f.operation_id WHERE f.tenant_key = ? AND"
                                        + " f.harness_key = ?")) {
                        statement.setString(1, harnessDrainKey(scope.getTenantId()));
                        statement.setString(2, harnessDrainKey(harnessSessionId));
                        try (ResultSet row = statement.executeQuery()) {
                            if (!row.next()) {
                                throw admissionClosed();
                            }
                            int version = row.getInt(1);
                            if (version == 0 || version == 1) {
                                return false;
                            }
                            if (version != 2) {
                                throw admissionClosed();
                            }
                            requireHarnessAdmission(
                                    connection,
                                    scope,
                                    harnessSessionId,
                                    authority,
                                    fence(runtimeSessionOwner, HarnessFence.CLEANUP));
                            return true;
                        }
                    }
                });
    }

    @Override
    public void requireHarnessCleanup(RuntimeScope scope, String harnessSessionId, RuntimeLifecycleAuthority authority) {
        JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, scope.getTenantId());
            requireHarnessAdmission(connection, scope, harnessSessionId, authority, fence(false, HarnessFence.CLEANUP));
            return null;
        });
    }

    @Override
    public void requireHarnessCleanup(RuntimeProvisionRequest bindingRequest, RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        if (!HarnessOwnership.sharesRuntimeSessions(bindingRequest)) {
            requireHarnessCleanup(scope, harnessSessionId, authority);
            return;
        }
        JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, scope.getTenantId());
            requireHarnessAdmission(connection, scope, harnessSessionId, authority, fence(true, HarnessFence.CLEANUP));
            return null;
        });
    }

    @Override
    public void requireHookAdmission(RuntimeScope scope, String harnessSessionId, RuntimeLifecycleAuthority authority) {
        JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, scope.getTenantId());
            requireHarnessAdmission(connection, scope, harnessSessionId, authority, fence(false, HarnessFence.LEGACY_HOOK));
            return null;
        });
    }

    @Override
    public void requireHookAdmission(RuntimeProvisionRequest bindingRequest, RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        if (!HarnessOwnership.sharesRuntimeSessions(bindingRequest)) {
            requireHookAdmission(scope, harnessSessionId, authority);
            return;
        }
        JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, scope.getTenantId());
            requireHarnessAdmission(connection, scope, harnessSessionId, authority, fence(true, HarnessFence.LEGACY_HOOK));
            return null;
        });
    }

    public static void requireHarnessAdmission(Connection connection, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority) throws SQLException {
        requireHarnessAdmission(connection, scope, harnessSessionId, authority, fence(false));
    }

    /** What a Harness fence admits beyond ordinary new work. */
    private enum HarnessFence {
        LEGACY_HOOK,
        RETIREMENT,
        CLEANUP,
        /** Fences a shared binding by the admitted Runtime Session's own Harness Session. */
        RUNTIME_SESSION_OWNER
    }

    private static Set<HarnessFence> fence(boolean runtimeSessionOwner, HarnessFence... fences) {
        Set<HarnessFence> result = EnumSet.noneOf(HarnessFence.class);
        result.addAll(List.of(fences));
        if (runtimeSessionOwner) {
            result.add(HarnessFence.RUNTIME_SESSION_OWNER);
        }
        return result;
    }

    /**
     * Lifecycle authority over a shared binding is fenced by the Runtime
     * Session's own Harness Session lifecycle claim: Hook placement and
     * cleanup proceed only while that claim matches.
     */
    private static void requireHarnessAdmission(Connection connection, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority, Set<HarnessFence> fence) throws SQLException {
        boolean legacyHook = fence.contains(HarnessFence.LEGACY_HOOK);
        boolean retirement = fence.contains(HarnessFence.RETIREMENT);
        boolean cleanup = fence.contains(HarnessFence.CLEANUP);
        if (fence.contains(HarnessFence.RUNTIME_SESSION_OWNER)) {
            BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        } else if (!"session".equals(scope.getIsolationClass())
                && !(ResidentWorkspaceProfile.selects(scope) && harnessSessionId != null)
                && !(WorkspaceExecutionProfile.isBoundWorkspaceScope(scope) && harnessSessionId != null
                        && authority != null)) {
            if (authority != null) {
                throw admissionClosed();
            }
            return;
        }
        if (ResidentWorkspaceProfile.selects(scope)) {
            try (PreparedStatement session = connection.prepareStatement(
                    "SELECT status, workspace_id, workspace_generation, context_config_ref, tool_profile"
                            + " FROM ma_session WHERE tenant_id = ? AND session_id = ?")) {
                JdbcRepositorySupport.setIdentity(session, 1, scope.getTenantId());
                JdbcRepositorySupport.setIdentity(session, 2, harnessSessionId);
                try (ResultSet row = session.executeQuery()) {
                    if (!row.next() || !scope.getWorkspaceId().equals(row.getString("workspace_id"))
                            || !scope.getWorkspaceGeneration().equals(Long.toString(row.getLong("workspace_generation")))
                            || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(row.getString("context_config_ref"))
                            || !"hosted-workspace-files/1".equals(row.getString("tool_profile"))
                            || !(authority == null && !cleanup && !retirement && !legacyHook
                                    ? "ACTIVE".equals(row.getString("status"))
                                    : List.of("CLOSING", "DELETING").contains(row.getString("status")))) {
                        throw admissionClosed();
                    }
                }
            }
        }
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT tenant_id, harness_session_id, phase, operation_id,"
                                + " claim_generation, claim_lease_until FROM ma_session_head WHERE"
                                + " tenant_key = ? AND harness_key = ?")) {
            statement.setString(1, harnessDrainKey(scope.getTenantId()));
            statement.setString(2, harnessDrainKey(harnessSessionId));
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) {
                    if (authority != null) {
                        throw admissionClosed();
                    }
                    return;
                }
                if (!scope.getTenantId().equals(row.getString("tenant_id"))
                        || !harnessSessionId.equals(row.getString("harness_session_id"))) {
                    throw admissionClosed();
                }
                if ("OPEN".equals(row.getString("phase"))) {
                    if (authority != null) {
                        throw admissionClosed();
                    }
                    return;
                }
                if (retirement && authority == null && "DRAINING".equals(row.getString("phase"))) {
                    return;
                }
                if (legacyHook && authority == null && "DRAINING".equals(row.getString("phase"))
                        && row.getString("operation_id") == null) {
                    return;
                }
                if (authority == null
                        || !("LIFECYCLE_ONLY".equals(row.getString("phase"))
                                || cleanup && "DRAINING".equals(row.getString("phase")))
                        || !authority.operationId().equals(row.getString("operation_id"))
                        || authority.claimGeneration() != row.getLong("claim_generation")
                        || row.getLong("claim_lease_until")
                                <= JdbcRepositorySupport.databaseNowPrecise(connection)
                                        .toEpochMilli()) {
                    throw admissionClosed();
                }
            }
        }
    }

    public static void beginHarnessLifecycle(Connection connection, String tenantId, String sessionId, String operationId)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                        "INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, harness_session_id, session_id, head_kind, phase, operation_id, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, 'HARNESS', 'LIFECYCLE_ONLY', ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE gmt_modified = CASE WHEN phase IS NULL OR phase <> 'LIFECYCLE_ONLY' OR operation_id IS NULL OR operation_id <> VALUES(operation_id) THEN VALUES(gmt_modified) ELSE gmt_modified END, phase = 'LIFECYCLE_ONLY', operation_id = VALUES(operation_id)")) {
            statement.setString(1, harnessDrainKey(tenantId));
            statement.setString(2, harnessDrainKey(sessionId));
            JdbcRepositorySupport.setIdentity(statement, 3, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 4, sessionId);
            JdbcRepositorySupport.setIdentity(statement, 5, sessionId);
            JdbcRepositorySupport.setIdentity(statement, 6, operationId);
            statement.executeUpdate();
        }
    }

    private static RuntimeBrokerException admissionClosed() {
        return new RuntimeBrokerException(
                409, "runtime_admission_closed", "Session admission is closed", false);
    }

    @Override
    public void requestStorageFence(String tenantId, String storageId, String operationId) {
        BrokerValues.requireId(tenantId, "tenantId");
        BrokerValues.requireId(storageId, "storageId");
        BrokerValues.requireId(operationId, "operationId");
        JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    lockPlacementDomain(connection, tenantId);
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "INSERT INTO ma_storage (alias_key, tenant_key, storage_key,"
                                        + " tenant_id, storage_id, fence_operation_id, gmt_create, gmt_modified) VALUES (?,"
                                        + " ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE"
                                        + " gmt_modified = CASE WHEN fence_operation_id IS NULL THEN VALUES(gmt_modified) ELSE gmt_modified END,"
                                        + " fence_operation_id = COALESCE(fence_operation_id,"
                                        + " VALUES(fence_operation_id))")) {
                        statement.setString(1, storageAliasKey(tenantId, storageId));
                        statement.setString(2, storageFenceKey(tenantId));
                        statement.setString(3, storageFenceKey(storageId));
                        JdbcRepositorySupport.setIdentity(statement, 4, tenantId);
                        JdbcRepositorySupport.setIdentity(statement, 5, storageId);
                        JdbcRepositorySupport.setIdentity(statement, 6, operationId);
                        statement.executeUpdate();
                    }
                    if (!operationId.equals(storageFence(connection, tenantId, storageId))) {
                        throw new RuntimeBrokerException(
                                409,
                                "migration_conflict",
                                "Storage migration is already owned.",
                                false);
                    }
                    return null;
                });
    }

    @Override
    public boolean isStorageFenced(String tenantId, String storageId, String operationId) {
        return JdbcRepositorySupport.read(dataSource, connection -> {
            String owner = storageFence(connection, tenantId, storageId);
            return owner != null && (operationId == null || operationId.equals(owner));
        });
    }

    public static String storageFenceKey(String value) {
        return JdbcRepositorySupport.valueKey(value);
    }

    public static String storageAliasKey(String tenantId, String storageId) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            for (String field : List.of("qwen-csi-alias/1", tenantId, storageId)) {
                byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
                digest.update(java.nio.ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
                digest.update(bytes);
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static String storageFence(Connection connection, String tenantId, String storageId) throws SQLException {
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT tenant_id, storage_id, fence_operation_id"
                                + " FROM ma_storage WHERE tenant_key = ? AND storage_key = ?")) {
            statement.setString(1, storageFenceKey(tenantId));
            statement.setString(2, storageFenceKey(storageId));
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next()) {
                    return null;
                }
                if (!tenantId.equals(rows.getString("tenant_id"))
                        || !storageId.equals(rows.getString("storage_id"))) {
                    throw new IllegalStateException("Storage fence hash collision");
                }
                return rows.getString("fence_operation_id");
            }
        }
    }

    @Override
    public List<RuntimeBindingRecord> findByStorage(String tenantId, String storageId, String afterBindingId, int limit) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Storage batch must contain 1-100 bindings");
        }
        return JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    List<RuntimeBindingRecord> values = new ArrayList<>();
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "SELECT "
                                            + BINDING_COLUMNS
                                            + " FROM ma_runtime_binding WHERE tenant_id = ? AND"
                                            + " storage_id = ? AND CAST(tenant_id AS BINARY(2048))"
                                            + " = CAST(? AS BINARY(2048)) AND CAST(storage_id AS"
                                            + " BINARY(2048)) = CAST(? AS BINARY(2048)) AND"
                                            + " binding_id > ? ORDER BY binding_id LIMIT ?")) {
                        JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
                        JdbcRepositorySupport.setIdentity(statement, 2, storageId);
                        JdbcRepositorySupport.setIdentity(statement, 3, tenantId);
                        JdbcRepositorySupport.setIdentity(statement, 4, storageId);
                        JdbcRepositorySupport.setIdentity(
                                statement, 5, afterBindingId == null ? "" : afterBindingId);
                        statement.setInt(6, limit);
                        try (ResultSet rows = statement.executeQuery()) {
                            while (rows.next()) {
                                values.add(mapBinding(rows));
                            }
                        }
                    }
                    return List.copyOf(values);
                });
    }

    @Override
    public List<RuntimeBindingRecord> findByHarnessSession(String tenantId, String harnessSessionId,
            String afterBindingId, int limit) {
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Drain batch must contain 1-100 bindings");
        }
        return JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    List<RuntimeBindingRecord> result = new ArrayList<>();
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "SELECT "
                                            + BINDING_COLUMNS
                                            + " FROM ma_runtime_binding WHERE tenant_id = ? AND"
                                            + " isolation_class = 'session' AND isolation_key = ?"
                                            + " AND CAST(tenant_id AS BINARY(2048)) = CAST(? AS"
                                            + " BINARY(2048)) AND CAST(isolation_key AS"
                                            + " BINARY(2048)) = CAST(? AS BINARY(2048)) AND"
                                            + " binding_id > ? ORDER BY binding_id LIMIT ?")) {
                        JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
                        JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
                        JdbcRepositorySupport.setIdentity(statement, 3, tenantId);
                        JdbcRepositorySupport.setIdentity(statement, 4, harnessSessionId);
                        JdbcRepositorySupport.setIdentity(
                                statement, 5, afterBindingId == null ? "" : afterBindingId);
                        statement.setInt(6, limit);
                        try (ResultSet rows = statement.executeQuery()) {
                            while (rows.next()) {
                                result.add(mapBinding(rows));
                            }
                        }
                    }
                    return List.copyOf(result);
                });
    }

    /** A binding's request columns, aliased with the {@code b_} prefix, for a join on alias {@code b}. */
    static final String REQUEST_COLUMNS_AS_B = String.join(", ", List.of("tenant_id", "workspace_id",
                    "workspace_generation", "canonical_cwd", "capability_digest", "isolation_class", "isolation_key",
                    "provisioner_kind", "storage_id").stream().map(column -> "b." + column + " AS b_" + column).toList());

    /** Whether the prefixed binding columns describe a shared binding; a malformed request does not. */
    static boolean sharesRuntimeSessions(ResultSet rows, String prefix) throws SQLException {
        try {
            return HarnessOwnership.sharesRuntimeSessions(new RuntimeProvisionRequest(
                    new RuntimeScope(rows.getString(prefix + "tenant_id"), rows.getString(prefix + "workspace_id"),
                            rows.getString(prefix + "workspace_generation"), rows.getString(prefix + "canonical_cwd"),
                            rows.getString(prefix + "capability_digest"), rows.getString(prefix + "isolation_class")),
                    rows.getString(prefix + "isolation_key"), rows.getString(prefix + "provisioner_kind"),
                    rows.getString(prefix + "storage_id")));
        } catch (IllegalArgumentException malformed) {
            return false;
        }
    }

    /** Whether any Runtime Session of the Harness Session was placed on a shared binding. */
    public static boolean hasSharedRuntimeSessions(Connection connection, String tenantId, String harnessSessionId)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT " + REQUEST_COLUMNS_AS_B
                + " FROM ma_runtime_session s JOIN ma_runtime_binding b ON b.binding_id = s.binding_id"
                + " WHERE s.harness_session_id = ? AND s.tenant_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, harnessSessionId);
            JdbcRepositorySupport.setIdentity(statement, 2, tenantId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (sharesRuntimeSessions(rows, "b_")) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    @Override
    public List<RuntimeBindingRecord> verifyHarnessResources(Connection connection, String tenantId,
            String harnessSessionId) throws SQLException {
        List<RuntimeBindingRecord> bindings = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement("SELECT " + BINDING_COLUMNS
                + " FROM ma_runtime_binding WHERE tenant_id = ? AND isolation_class"
                                + " = 'session' AND isolation_key = ? ORDER BY binding_id FOR"
                                + " UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    RuntimeBindingRecord binding = mapBinding(rows);
                    if (!tenantId.equals(binding.getRequest().getScope().getTenantId())
                            || !harnessSessionId.equals(binding.getRequest().getIsolationKey())) {
                        throw admissionClosed();
                    }
                    if (JdbcRuntimeSessionRepository.hasActiveByBinding(connection, binding)) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_lifecycle_resources_unsettled",
                                "Original owners remain active",
                                false);
                    }
                    bindings.add(binding);
                }
            }
        }
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT binding_id, runtime_generation, session_state FROM"
                            + " ma_runtime_session WHERE tenant_id = ? AND harness_session_id = ?"
                            + " FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    String bindingId = rows.getString("binding_id");
                    RuntimeBindingRecord original = bindings.stream().filter(binding -> binding.getBindingId().equals(bindingId)).findFirst().orElse(null);
                    if (original == null) {
                        // A shared binding outlives this Session: its own Runtime
                        // Sessions must be released, never the binding drained.
                        RuntimeBindingRecord shared = selectById(connection, bindingId, true);
                        if (shared != null && HarnessOwnership.sharesRuntimeSessions(shared.getRequest())
                                && tenantId.equals(shared.getRequest().getScope().getTenantId())) {
                            original = shared;
                            bindings.add(shared);
                        }
                    }
                    if (original == null || rows.getLong("runtime_generation") < 1
                            || original.getGeneration() < rows.getLong("runtime_generation")) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_close_identity_unverified",
                                "Original owner identity differs",
                                false);
                    }
                    if (!"RELEASED".equals(rows.getString("session_state"))) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_lifecycle_resources_unsettled",
                                "Original owner remains active",
                                false);
                    }
                }
            }
        }
        for (ToolExecutionRecord execution : JdbcToolExecutionRepository.findHarnessExecutions(connection, tenantId, harnessSessionId)) {
            if (!execution.isSettled()) {
                throw new RuntimeBrokerException(
                        409,
                        "workspace_lifecycle_resources_unsettled",
                        "Original execution is not settled",
                        false);
            }
        }
        return List.copyOf(bindings);
    }

    @Override
    public void verifyHarnessStopped(Connection connection, String tenantId, String harnessSessionId) throws SQLException {
        lockPlacementDomain(connection, tenantId);
        try (PreparedStatement fence = connection.prepareStatement(
                        "SELECT tenant_id, harness_session_id, phase FROM ma_session_head WHERE"
                                + " tenant_key = ? AND harness_key = ? FOR UPDATE")) {
            fence.setString(1, harnessDrainKey(tenantId));
            fence.setString(2, harnessDrainKey(harnessSessionId));
            try (ResultSet row = fence.executeQuery()) {
                if (!row.next() || !tenantId.equals(row.getString(1)) || !harnessSessionId.equals(row.getString(2))
                        || !"DRAINING".equals(row.getString(3))) {
                    throw admissionClosed();
                }
            }
        }
        try (PreparedStatement statement = connection.prepareStatement("SELECT " + BINDING_COLUMNS
                + " FROM ma_runtime_binding WHERE tenant_id = ? AND isolation_class"
                                + " = 'session' AND isolation_key = ? ORDER BY binding_id FOR"
                                + " UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    RuntimeBindingRecord record = mapBinding(rows);
                    if (!tenantId.equals(record.getRequest().getScope().getTenantId())
                            || !harnessSessionId.equals(record.getRequest().getIsolationKey())) {
                        continue;
                    }
                    if (record.getState() != RuntimeBindingRecord.State.RELEASED
                            || record.getDrainReceipt() == null && !record.hasStoppedWriters()) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_close_identity_unverified",
                                "Original stop proof is missing",
                                false);
                    }
                    if (JdbcRuntimeSessionRepository.hasActiveByBinding(connection, record)
                            || JdbcToolExecutionRepository.hasActiveByBinding(connection, record.getBindingId(), record.getGeneration())) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_close_execution_unsettled",
                                "Original resources remain active",
                                false);
                    }
                }
            }
        }
        verifySharedSessionsStopped(connection, tenantId, harnessSessionId);
    }

    /**
     * A shared binding keeps serving other Sessions, so this Session's stop
     * proof is its own Runtime Sessions released, their executions settled
     * and no storage holder naming one of them.
     */
    private void verifySharedSessionsStopped(Connection connection, String tenantId, String harnessSessionId)
            throws SQLException {
        List<RuntimeSessionRecord> sessions = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement("SELECT " + JdbcRuntimeSessionRepository.SESSION_COLUMNS
                + " FROM ma_runtime_session WHERE harness_session_id = ? AND tenant_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, harnessSessionId);
            JdbcRepositorySupport.setIdentity(statement, 2, tenantId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    RuntimeSessionRecord session = JdbcRuntimeSessionRepository.mapSession(rows);
                    if (tenantId.equals(session.getSession().getScope().getTenantId())
                            && harnessSessionId.equals(session.getSession().getHarnessSessionId())) {
                        sessions.add(session);
                    }
                }
            }
        }
        Map<String, Boolean> shared = new HashMap<>();
        for (RuntimeSessionRecord session : sessions) {
            Boolean sharing = shared.get(session.getBindingId());
            if (sharing == null) {
                RuntimeBindingRecord binding = selectById(connection, session.getBindingId(), false);
                sharing = binding != null && HarnessOwnership.sharesRuntimeSessions(binding.getRequest());
                shared.put(session.getBindingId(), sharing);
            }
            if (sharing && (session.isActive()
                    || JdbcToolExecutionRepository.hasActiveByRuntimeSession(connection, session.getBindingId(),
                            session.getRuntimeGeneration(), session.getRuntimeSessionId())
                    || hasStorageHolder(connection, session))) {
                throw new RuntimeBrokerException(
                        409,
                        "workspace_close_execution_unsettled",
                        "Original resources remain active",
                        false);
            }
        }
    }

    private static boolean hasStorageHolder(Connection connection, RuntimeSessionRecord session) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT binding_id, runtime_session_id FROM ma_storage_owner"
                                + " WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, session.getBindingId());
            statement.setLong(2, session.getRuntimeGeneration());
            JdbcRepositorySupport.setIdentity(statement, 3, session.getRuntimeSessionId());
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (session.getBindingId().equals(rows.getString("binding_id"))
                            && session.getRuntimeSessionId().equals(rows.getString("runtime_session_id"))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    @Override
    public ToolExecutionRecord authorizeDispatch(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ToolExecutionRecord expected,
            String owner, long dispatchGeneration) {
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcExecutions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Dispatch admission requires the same DataSource");
        }
        if (expected == null || expected.getState() != ToolExecutionRecord.State.DISPATCHING
                || expected.isCancelRequested()) {
            throw new IllegalArgumentException("Dispatch admission requires an uncancelled claim");
        }
        RuntimeBindingRecord hint = findById(expected.getBindingId());
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    if (hint != null && ResidentWorkspaceProfile.selects(hint.getRequest())) {
                        lockPlacementDomain(connection, hint.getRequest().getScope().getTenantId());
                    }
                    var original =
                            JdbcCsiActivationAdmission.lockForExecution(connection, hint, this);
                    JdbcCsiActivationAdmission.requireExecution(original, expected);
                    RuntimeBindingRecord binding =
                            selectById(connection, expected.getBindingId(), true, 10);
                    RuntimeAdmission.requireReady(binding, expected.getRuntimeGeneration());
                    RuntimeAdmission.requireSession(
                            jdbcSessions.findByIdForUpdate(
                                    connection,
                                    binding.getRequest().getScope(),
                                    expected.getRuntimeSessionId()),
                            expected);
                    if (ResidentWorkspaceProfile.selects(binding.getRequest())) {
                        requireHarnessAdmission(connection, binding.getRequest().getScope(), expected.getHarnessSessionId(), null);
                    }
                    if (original != null) {
                        if (JdbcCsiExecutionAdmission.legacyReference(expected)) {
                            throw new RuntimeBrokerException(
                                    501,
                                    "csi_file_dispatch_unavailable",
                                    "Historical CSI continuation cannot mint a native grant.",
                                    false);
                        }
                        return JdbcCsiExecutionAdmission.authorize(
                                connection, original, binding, expected, owner, dispatchGeneration);
                    }
                    return JdbcToolExecutionRepository.authorizeDispatch(
                            connection, expected, owner, dispatchGeneration, binding.getVersion());
                });
    }

    @Override
    public RuntimeBindingRecord findOrCreate(
            RuntimeProvisionRequest request) {
        requireRequest(request);
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    lockPlacementDomain(connection, request.getScope().getTenantId());
                    boolean csiFiles =
                            JdbcCsiFilesRetirementGuard.requireProvisionPin(connection, request);
                    requireHarnessAdmission(connection, request);
                    String key = JdbcRepositorySupport.requestKey(request);
                    ensureSlot(connection, key, request);
                    Slot slot = selectSlot(connection, key, true);
                    requireSlotIdentity(slot, request);
                    if (slot.activeBindingId != null) {
                        RuntimeBindingRecord active =
                                selectById(connection, slot.activeBindingId, true);
                        if (active == null
                                || !active.isActive()
                                || !active.getRequest().equals(request)) {
                            throw new IllegalStateException("Runtime binding slot is inconsistent");
                        }
                        if (csiFiles) {
                            JdbcCsiFilesRetirementGuard.lockBinding(connection, active);
                        }
                        return active;
                    }

                    if ((csiFiles || ResidentWorkspaceProfile.selects(request)) && slot.lastGeneration != 0) {
                        throw new RuntimeBrokerException(
                                409,
                                "csi_original_binding_unavailable",
                                "The original CSI request cannot create a replacement generation.",
                                false);
                    }

                    if (request.getScope().getLifecycleAuthority() != null
                            && slot.lastGeneration != 0) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_close_identity_unverified",
                                "Lifecycle cannot replace an original Runtime",
                                false);
                    }
                    requireRecoverablePlacement(connection, request);
                    long generation = slot.lastGeneration + 1;
                    String bindingId = BrokerValues.requireId(idSupplier.get(), "bindingId");
                    Instant now = JdbcRepositorySupport.databaseNow(connection);
                    RuntimeProvisionSeed seed =
                            request.requiresDurableIdentity()
                                    ? RuntimeProvisionSeed.create(bindingId, generation)
                                    : null;
                    RuntimeBindingRecord created =
                            new RuntimeBindingRecord(
                                    bindingId,
                                    request,
                                    seed,
                                    generation,
                                    RuntimeBindingRecord.State.PROVISIONING,
                                    null,
                                    false,
                                    null,
                                    null,
                                    0,
                                    0,
                                    null,
                                    now);
                    insertBinding(connection, created);
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "UPDATE ma_runtime_slot "
                                            + "SET last_generation = ?, "
                                            + "active_binding_id = ? WHERE request_key = ?")) {
                        statement.setLong(1, generation);
                        JdbcRepositorySupport.setIdentity(statement, 2, bindingId);
                        statement.setString(3, key);
                        if (statement.executeUpdate() != 1) {
                            throw new SQLException("Runtime binding slot update failed");
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
                    + " FROM ma_runtime_binding WHERE scope_key = ? "
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
    public List<RuntimeBindingRecord> findRecoveryCandidates(String kind, String afterBindingId, int limit) {
        BrokerValues.requireId(kind, "provisionerKind");
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("Recovery batch must contain 1-100 bindings");
        }
        return JdbcRepositorySupport.read(
                dataSource,
                connection -> {
                    List<RuntimeBindingRecord> records = new ArrayList<>();
                    try (PreparedStatement statement =
                            connection.prepareStatement(
                                    "SELECT "
                                            + BINDING_COLUMNS
                                            + " FROM ma_runtime_binding WHERE provisioner_kind = ?"
                                            + " AND binding_id > ? AND resource_handle_version = 2"
                                            + " AND binding_state IN ('PROVISIONING', 'READY',"
                                            + " 'DRAINING', 'RECOVERY_BLOCKED', 'LOST') AND NOT"
                                            + " EXISTS (SELECT 1 FROM ma_operation recovery WHERE"
                                            + " recovery.operation_kind ="
                                            + " 'WORKSPACE_OPERATOR_RECOVERY' AND"
                                            + " recovery.target_id = ma_runtime_binding.binding_id"
                                            + " AND recovery.target_revision ="
                                            + " ma_runtime_binding.runtime_generation AND"
                                            + " recovery.state <> 'COMPLETED') ORDER BY binding_id"
                                            + " LIMIT ?")) {
                        statement.setString(1, kind);
                        JdbcRepositorySupport.setIdentity(
                                statement, 2, afterBindingId == null ? "" : afterBindingId);
                        statement.setInt(3, limit);
                        try (ResultSet result = statement.executeQuery()) {
                            while (result.next()) {
                                RuntimeBindingRecord record = mapBinding(result);
                                if (!kind.equals(record.getRequest().getProvisionerKind())) {
                                    throw new IllegalStateException(
                                            "Recovery provisioner identity differs");
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
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    BindingControl control =
                            lockBindingControl(connection, expected.getBindingId());
                    lockPlacementDomain(connection, expected.getRequest().getScope().getTenantId());
                    String key = JdbcRepositorySupport.requestKey(expected.getRequest());
                    Slot slot = selectSlot(connection, key, true);
                    if (slot == null) {
                        controlTime(connection, control);
                        return null;
                    }
                    requireSlotIdentity(slot, expected.getRequest());
                    RuntimeBindingRecord current =
                            selectById(connection, expected.getBindingId(), true);
                    requireControlBinding(control, current);
                    Instant now = controlTime(connection, control);
                    if (current == null
                            || !current.sameIdentity(expected)
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
                            && !current.getBindingId().equals(slot.activeBindingId)) {
                        throw new IllegalStateException("Runtime binding slot is inconsistent");
                    }
                    current.requireSafeReplacement(replacement);
                    var authority = replacement.getRequest().getScope().getLifecycleAuthority();
                    if (authority != null && replacement.getDrainReceipt() != null) {
                        requireHarnessAdmission(
                                connection,
                                current.getRequest().getScope(),
                                current.getRequest().getIsolationKey(),
                                authority,
                                fence(false, HarnessFence.CLEANUP));
                    }
                    if (current.getState() == RuntimeBindingRecord.State.LOST
                            && replacement.getState() == RuntimeBindingRecord.State.DRAINING
                            && JdbcToolExecutionRepository.hasActiveByBinding(
                                    connection, current.getBindingId(), current.getGeneration())) {
                        throw new RuntimeBrokerException(
                                409,
                                "workspace_close_execution_unsettled",
                                "Original resources remain active",
                                false);
                    }
                    RuntimeBindingRecord updated =
                            replacement.withVersion(expected.getVersion() + 1);
                    updateBinding(connection, updated, control, current.getOperationLeaseUntil());
                    if (current.isActive() && !updated.isActive()) {
                        try (PreparedStatement statement =
                                connection.prepareStatement(
                                        "UPDATE ma_runtime_slot "
                                                + "SET active_binding_id = NULL "
                                                + "WHERE request_key = ? "
                                                + "AND active_binding_id = ?")) {
                            statement.setString(1, key);
                            JdbcRepositorySupport.setIdentity(statement, 2, current.getBindingId());
                            requireControlWrite(
                                    connection, control, updated, current.getOperationLeaseUntil());
                            if (statement.executeUpdate() != 1) {
                                throw new SQLException("Runtime binding slot release failed");
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
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    BindingControl control = lockBindingControl(connection, id);
                    RuntimeBindingRecord current = selectById(connection, id, true);
                    requireControlBinding(control, current);
                    Instant now = controlTime(connection, control);
                    if (current == null || !current.isActive()) {
                        return null;
                    }
                    if (ownerId.equals(current.getOperationOwner())
                            && current.getOperationLeaseUntil().isAfter(now)) {
                        requireControlWrite(
                                connection, control, current, current.getOperationLeaseUntil());
                        return current;
                    }
                    if (current.getOperationOwner() != null
                            && current.getOperationLeaseUntil().isAfter(now)) {
                        return null;
                    }
                    RuntimeBindingRecord claimed =
                            current.withOperation(
                                            ownerId,
                                            JdbcRepositorySupport.leaseUntil(now, duration),
                                            current.getOperationGeneration() + 1)
                                    .withVersion(current.getVersion() + 1);
                    updateBinding(connection, claimed, control, null);
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
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    BindingControl control = lockBindingControl(connection, id);
                    RuntimeBindingRecord current = selectById(connection, id, true);
                    requireControlBinding(control, current);
                    Instant now = controlTime(connection, control);
                    if (current == null || !current.isActive()) {
                        return null;
                    }
                    if (!ownerId.equals(current.getOperationOwner())
                            || operationGeneration != current.getOperationGeneration()
                            || !current.getOperationLeaseUntil().isAfter(now)) {
                        return null;
                    }
                    RuntimeBindingRecord renewed =
                            current.withOperation(
                                            ownerId,
                                            JdbcRepositorySupport.leaseUntil(now, duration),
                                            operationGeneration)
                                    .withVersion(current.getVersion() + 1);
                    updateBinding(connection, renewed, control, current.getOperationLeaseUntil());
                    return renewed;
                });
    }

    @Override
    public RuntimeBindingRecord releaseOperation(String bindingId,
            String owner, long operationGeneration) {
        String id = BrokerValues.requireId(bindingId, "bindingId");
        String ownerId = BrokerValues.requireId(owner, "owner");
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    BindingControl control = lockBindingControl(connection, id);
                    RuntimeBindingRecord current = selectById(connection, id, true);
                    requireControlBinding(control, current);
                    controlTime(connection, control);
                    if (current == null || !current.isActive()) {
                        return null;
                    }
                    if (!ownerId.equals(current.getOperationOwner())
                            || operationGeneration != current.getOperationGeneration()) {
                        return null;
                    }
                    RuntimeBindingRecord released =
                            current.withOperation(null, null, operationGeneration)
                                    .withVersion(current.getVersion() + 1);
                    updateBinding(connection, released, control, current.getOperationLeaseUntil());
                    return released;
                });
    }

    private static BindingControl lockBindingControl(Connection connection, String bindingId)
            throws SQLException {
        var original = JdbcCsiFilesRetirementGuard.lockBindingControl(connection, bindingId);
        if (original == null) {
            return null;
        }
        if (original.state() == RuntimeBindingRecord.State.PROVISIONING
                && !original.draining()
                && original.firstActivationJournalRevision() == null) {
            try (PreparedStatement statement =
                    connection.prepareStatement(
                            "SELECT operation_id FROM ma_operation WHERE operation_kind ="
                                + " 'CSI_RETIREMENT' AND target_key = ? AND target_revision = ? AND"
                                + " tenant_id = ? FOR UPDATE")) {
                statement.setQueryTimeout(10);
                statement.setString(
                        1,
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                original.bindingId()));
                statement.setLong(2, original.generation());
                JdbcRepositorySupport.setIdentity(
                        statement, 3, original.request().getScope().getTenantId());
                try (ResultSet row = statement.executeQuery()) {
                    if (row.next()) {
                        throw controlUnavailable();
                    }
                }
            }
            return new BindingControl(connection, original, null);
        }
        return new BindingControl(
                connection, original, JdbcCsiReadyAdmission.lock(connection, original));
    }

    private static void requireControlBinding(
            BindingControl control, RuntimeBindingRecord current) {
        if (control == null) {
            if (current != null
                    && JdbcCsiFilesRetirementGuard.isProfile(current.getRequest().getScope())) {
                throw controlUnavailable();
            }
            return;
        }
        var original = control.original();
        if (current == null
                || !current.getRequest().equals(original.request())
                || !current.getBindingId().equals(original.bindingId())
                || current.getGeneration() != original.generation()
                || current.getState() != original.state()
                || current.isDrainRequested() != original.draining()
                || current.getVersion() != original.version()) {
            throw controlUnavailable();
        }
    }

    private static Instant controlTime(Connection connection, BindingControl control)
            throws SQLException {
        if (control == null) {
            return JdbcRepositorySupport.databaseNowPrecise(connection);
        }
        if (control.connection() != connection || connection.getAutoCommit()) {
            throw controlUnavailable();
        }
        return control.progress() == null
                ? JdbcRepositorySupport.databaseNowPrecise(connection)
                : Instant.ofEpochMilli(control.progress().requireCurrentTime(connection));
    }

    private static void requireControlWrite(
            Connection connection,
            BindingControl control,
            RuntimeBindingRecord replacement,
            Instant existingExpiry)
            throws SQLException {
        if (control == null) {
            return;
        }
        Instant now = controlTime(connection, control);
        Instant targetExpiry = replacement.getOperationLeaseUntil();
        if (existingExpiry != null && !existingExpiry.isAfter(now)
                || targetExpiry != null && !targetExpiry.isAfter(now)) {
            throw controlUnavailable();
        }
        if (control.progress() != null && (existingExpiry != null || targetExpiry != null)) {
            control.progress()
                    .requireLease(
                            connection,
                            (existingExpiry == null ? targetExpiry : existingExpiry).toEpochMilli(),
                            (targetExpiry == null ? existingExpiry : targetExpiry).toEpochMilli());
        }
    }

    private static RuntimeBrokerException controlUnavailable() {
        return new RuntimeBrokerException(
                409,
                "csi_application_continuation_unavailable",
                "The original CSI application does not admit this continuation.",
                false);
    }

    private record BindingControl(
            Connection connection,
            JdbcCsiFilesRetirementGuard.Original original,
            JdbcCsiReadyAdmission.Admission progress) {}

    private static void ensureSlot(Connection connection, String requestKey,
            RuntimeProvisionRequest request) throws SQLException {
        RuntimeScope scope = request.getScope();
        String sql = "INSERT INTO ma_runtime_slot (request_key, "
                + "tenant_id, workspace_id, workspace_generation, "
                + "canonical_cwd, capability_digest, isolation_class, "
                + "isolation_key, provisioner_kind, last_generation, "
                + "active_binding_id, storage_id) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?) "
                + "ON DUPLICATE KEY UPDATE request_key = request_key";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, requestKey);
            setScope(statement, 2, scope);
            JdbcRepositorySupport.setIdentity(statement, 8, request.getIsolationKey());
            statement.setString(9, request.getProvisionerKind());
            JdbcRepositorySupport.setIdentity(statement, 10, request.getStorageId());
            statement.executeUpdate();
        }
    }

    private static Slot selectSlot(Connection connection, String requestKey,
            boolean forUpdate) throws SQLException {
        return selectSlot(connection, requestKey, forUpdate, 0);
    }

    private static Slot selectSlot(Connection connection, String requestKey,
            boolean forUpdate, int timeoutSeconds) throws SQLException {
        String sql = "SELECT tenant_id, workspace_id, "
                + "workspace_generation, canonical_cwd, capability_digest, "
                + "isolation_class, isolation_key, provisioner_kind, "
                + "last_generation, active_binding_id, storage_id "
                + "FROM ma_runtime_slot "
                + "WHERE request_key = ?" + (forUpdate
                        ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(timeoutSeconds);
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

    public boolean usesDataSource(DataSource source) {
        return dataSource == source;
    }

    public RuntimeBindingRecord lockActiveForRetirement(Connection connection,
            RuntimeBindingRecord expected) throws SQLException {
        if (connection == null || connection.getAutoCommit() || expected == null) {
            throw new IllegalArgumentException("An active transaction and binding are required");
        }
        lockPlacementDomain(connection, expected.getRequest().getScope().getTenantId(), 10);
        Slot slot = selectSlot(connection, JdbcRepositorySupport.requestKey(expected.getRequest()), true, 10);
        if (slot == null) {
            throw new IllegalStateException("Runtime binding slot is unavailable");
        }
        requireSlotIdentity(slot, expected.getRequest());
        RuntimeBindingRecord current = selectById(connection, expected.getBindingId(), true, 10);
        if (current == null || !current.sameIdentity(expected)
                || !current.getBindingId().equals(slot.activeBindingId)) {
            throw new IllegalStateException("Original Runtime binding is unavailable");
        }
        return current;
    }

    public RuntimeBindingRecord sealForRetirement(Connection connection,
            RuntimeBindingRecord expected) throws SQLException {
        RuntimeBindingRecord current = lockActiveForRetirement(connection, expected);
        if (current == null || !current.sameIdentity(expected)
                || current.getVersion() != expected.getVersion() || !current.sameOperation(expected)
                || current.getState() != expected.getState() || !current.hasSameLease(expected.getLease())
                || !Objects.equals(current.getResourceHandle(), expected.getResourceHandle())
                || current.getAttestationGeneration() != expected.getAttestationGeneration()
                || !current.hasLiveOperationAt(JdbcRepositorySupport.databaseNowPrecise(connection))
                || !"kubernetes-workspace".equals(current.getRequest().getProvisionerKind())
                || current.isDrainRequested()
                || current.getState() != RuntimeBindingRecord.State.PROVISIONING
                        && current.getState() != RuntimeBindingRecord.State.READY
                        && current.getState() != RuntimeBindingRecord.State.RECOVERY_BLOCKED) {
            throw new IllegalStateException("Original CSI retirement claim is unavailable");
        }
        Instant now = JdbcRepositorySupport.databaseNow(connection);
        RuntimeBindingRecord sealed = current.withState(RuntimeBindingRecord.State.DRAINING,
                current.getLease(), now).withDrainRequested(true, now)
                .withOperation(null, null, current.getOperationGeneration() + 1)
                .withVersion(current.getVersion() + 1);
        updateBinding(connection, sealed);
        return sealed;
    }

    public RuntimeBindingRecord findByIdForUpdate(Connection connection,
            String bindingId) throws SQLException {
        if (connection == null || connection.getAutoCommit()) {
            throw new IllegalArgumentException("An active transaction is required");
        }
        return selectById(connection, BrokerValues.requireId(bindingId, "bindingId"), true, 10);
    }

    public RuntimeBindingRecord findByIdInReadOnlySnapshot(Connection connection,
            String bindingId) throws SQLException {
        if (connection == null || connection.getAutoCommit() || !connection.isReadOnly()
                || connection.getTransactionIsolation() != Connection.TRANSACTION_REPEATABLE_READ) {
            throw new IllegalArgumentException(
                    "A read-only repeatable-read transaction is required");
        }
        return selectById(connection, BrokerValues.requireId(bindingId, "bindingId"), false, 10);
    }

    private RuntimeBindingRecord selectById(Connection connection,
            String bindingId, boolean forUpdate) throws SQLException {
        return selectById(connection, bindingId, forUpdate, 0);
    }

    private RuntimeBindingRecord selectById(Connection connection,
            String bindingId, boolean forUpdate, int queryTimeoutSeconds) throws SQLException {
        String sql = "SELECT " + BINDING_COLUMNS
                + " FROM ma_runtime_binding WHERE binding_id = ?"
                + (forUpdate ? " FOR UPDATE" : "");
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(queryTimeoutSeconds);
            JdbcRepositorySupport.setIdentity(statement, 1, bindingId);
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

    public static void lockPlacementDomain(Connection connection, String tenantId)
            throws SQLException {
        lockPlacementDomain(connection, tenantId, 0);
    }

    /**
     * Bounded variant: each acquisition statement is capped at
     * {@code timeoutSeconds}, so a caller guarding per-turn traffic cannot
     * be frozen behind a long holder of the tenant row (#13800).
     */
    public static void lockPlacementDomain(Connection connection, String tenantId, int timeoutSeconds)
            throws SQLException {
        String key = JdbcRepositorySupport.valueKey(tenantId);
        try (PreparedStatement insert = connection.prepareStatement(
                        "INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES"
                            + " (?, ?, 'runtime_placement') ON DUPLICATE KEY UPDATE tenant_key ="
                            + " tenant_key")) {
            insert.setQueryTimeout(timeoutSeconds);
            insert.setString(1, key);
            JdbcRepositorySupport.setIdentity(insert, 2, tenantId);
            insert.executeUpdate();
        }
        try (PreparedStatement lock = connection.prepareStatement(
                        "SELECT tenant_id FROM ma_tenant_guard WHERE tenant_key = ? AND"
                                + " guard_domain = 'runtime_placement' FOR UPDATE")) {
            lock.setQueryTimeout(timeoutSeconds);
            lock.setString(1, key);
            try (ResultSet result = lock.executeQuery()) {
                if (!result.next() || !tenantId.equals(result.getString("tenant_id"))) {
                    throw new IllegalStateException("Runtime placement tenant hash collision");
                }
            }
        }
    }

    private void requireRecoverablePlacement(Connection connection, RuntimeProvisionRequest request)
            throws SQLException {
        RuntimeScope scope = request.getScope();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT 1 FROM ma_runtime_binding WHERE tenant_id = ? "
                        + "AND CAST(tenant_id AS BINARY(2048)) = CAST(? AS BINARY(2048)) "
                        + "AND binding_state IN ('LOST', 'RECOVERY_BLOCKED', 'OPERATOR_RECOVERY', 'FAILED', 'DRAINING') "
                        + "AND (binding_state IN ('LOST', 'OPERATOR_RECOVERY', 'DRAINING') "
                        + "OR (binding_state = 'FAILED' AND (provision_request_id IS NOT NULL "
                        + "OR provision_seed_ciphertext IS NOT NULL OR credential_key_id IS NOT NULL)) "
                        + "OR (binding_state = 'RECOVERY_BLOCKED' AND ("
                        + "CAST(provisioner_kind AS BINARY(2048)) <> CAST(? AS BINARY(2048)) "
                        + "OR attestation_generation > 0 OR runtime_instance_id IS NOT NULL "
                        + "OR runtime_endpoint IS NOT NULL OR runtime_lease_id IS NOT NULL OR runtime_epoch IS NOT NULL "
                        + "OR runtime_credential_ciphertext IS NOT NULL OR runtime_credential_key_id IS NOT NULL "
                        + "OR ((provision_request_id IS NOT NULL OR provision_seed_ciphertext IS NOT NULL OR credential_key_id IS NOT NULL) "
                        + "AND (provision_request_id IS NULL OR provision_seed_ciphertext IS NULL OR credential_key_id IS NULL))))) "
                        + "AND (storage_id IS NULL "
                        + "OR CAST(storage_id AS BINARY(2048)) = CAST(? AS BINARY(2048)) "
                        + "OR CAST(canonical_cwd AS BINARY(2048)) = CAST(? AS BINARY(2048)) "
                        + "OR CAST(workspace_id AS BINARY(2048)) = CAST(? AS BINARY(2048))) LIMIT 1")) {
            JdbcRepositorySupport.setIdentity(statement, 1, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 3, LocalProcessRuntimeProvisioner.KIND);
            JdbcRepositorySupport.setIdentity(statement, 4, request.getStorageId());
            JdbcRepositorySupport.setIdentity(statement, 5, scope.getCanonicalCwd());
            JdbcRepositorySupport.setIdentity(statement, 6, scope.getWorkspaceId());
            try (ResultSet result = statement.executeQuery()) {
                if (result.next()) {
                    throw new RuntimeBrokerException(409, "runtime_placement_recovery_required",
                            "An earlier runtime placement still requires physical recovery", false);
                }
            }
        }
    }

    private void insertBinding(Connection connection,
            RuntimeBindingRecord record) throws SQLException {
        String sql = "INSERT INTO ma_runtime_binding (" + BINDING_COLUMNS
                + ") VALUES (" + String.join(", ", java.util.Collections.nCopies(38, "?")) + ")";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            setBinding(statement, record);
            statement.executeUpdate();
        }
    }

    private void updateBinding(Connection connection,
            RuntimeBindingRecord record) throws SQLException {
        updateBinding(connection, record, null, null);
    }

    private void updateBinding(
            Connection connection,
            RuntimeBindingRecord record,
            BindingControl control,
            Instant existingExpiry)
            throws SQLException {
        // The provision seed is immutable after INSERT, so the update never
        // re-encrypts it; renewal ticks would otherwise pay an AES-GCM
        // encryption with a fresh IV for state that cannot change.
        String sql =
                "UPDATE ma_runtime_binding SET binding_state = ?, resource_handle_version = ?,"
                    + " resource_handle_json = ?, runtime_instance_id = ?, runtime_endpoint = ?,"
                    + " runtime_lease_id = ?, runtime_epoch = ?, runtime_credential_ciphertext = ?,"
                    + " runtime_credential_key_id = ?, attestation_generation = ?, drain_requested"
                    + " = ?, operation_owner = ?, operation_lease_until = ?, operation_generation ="
                    + " ?, record_version = ?, last_health_at = ?, last_reconciled_at = ?,"
                    + " last_active_at = ?, loss_evidence_json = ?, stop_evidence_json = ?,"
                    + " drain_receipt_json = ? WHERE binding_id = ?";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, record.getState().name());
            setHandleColumns(statement, 2, record);
            RuntimeLease lease = record.getLease();
            JdbcRepositorySupport.setIdentity(statement, 4, lease == null ? null : lease.getRuntimeInstanceId());
            statement.setString(5,
                    lease == null ? null : lease.getEndpoint().toString());
            JdbcRepositorySupport.setIdentity(statement, 6, lease == null ? null : lease.getLeaseId());
            if (lease == null) {
                statement.setObject(7, null);
            } else {
                statement.setLong(7, lease.getEpoch());
            }
            ProtectedSecret credential = protectLeaseToken(record);
            statement.setString(8,
                    credential == null ? null : credential.getCiphertext());
            JdbcRepositorySupport.setIdentity(statement, 9, credential == null ? null : credential.getKeyId());
            statement.setLong(10, record.getAttestationGeneration());
            statement.setBoolean(11, record.isDrainRequested());
            JdbcRepositorySupport.setIdentity(statement, 12, record.getOperationOwner());
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
            statement.setString(19, evidenceJson(record.getLossEvidence()));
            statement.setString(20, evidenceJson(record.getStopEvidence()));
            statement.setString(21, record.getDrainReceipt() == null ? null : record.getDrainReceipt().toJson());
            JdbcRepositorySupport.setIdentity(statement, 22, record.getBindingId());
            requireControlWrite(connection, control, record, existingExpiry);
            if (statement.executeUpdate() != 1) {
                throw new SQLException("Runtime binding update failed");
            }
        }
    }

    private void setBinding(PreparedStatement statement,
            RuntimeBindingRecord record) throws SQLException {
        RuntimeProvisionRequest request = record.getRequest();
        RuntimeScope scope = request.getScope();
        JdbcRepositorySupport.setIdentity(statement, 1, record.getBindingId());
        statement.setString(2, JdbcRepositorySupport.requestKey(request));
        statement.setString(3, JdbcRepositorySupport.scopeKey(scope));
        setScope(statement, 4, scope);
        JdbcRepositorySupport.setIdentity(statement, 10, request.getIsolationKey());
        statement.setString(11, request.getProvisionerKind());
        statement.setLong(12, record.getGeneration());
        statement.setString(13, record.getState().name());
        setSeedColumns(statement, 14, record);
        setHandleColumns(statement, 17, record);
        RuntimeLease lease = record.getLease();
        JdbcRepositorySupport.setIdentity(statement, 19, lease == null ? null : lease.getRuntimeInstanceId());
        statement.setString(20,
                lease == null ? null : lease.getEndpoint().toString());
        JdbcRepositorySupport.setIdentity(statement, 21, lease == null ? null : lease.getLeaseId());
        if (lease == null) {
            statement.setObject(22, null);
        } else {
            statement.setLong(22, lease.getEpoch());
        }
        ProtectedSecret credential = protectLeaseToken(record);
        statement.setString(23,
                credential == null ? null : credential.getCiphertext());
        JdbcRepositorySupport.setIdentity(statement, 24, credential == null ? null : credential.getKeyId());
        statement.setLong(25, record.getAttestationGeneration());
        statement.setBoolean(26, record.isDrainRequested());
        JdbcRepositorySupport.setIdentity(statement, 27, record.getOperationOwner());
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
        JdbcRepositorySupport.setIdentity(statement, 34, request.getStorageId());
        statement.setString(35, evidenceJson(record.getLossEvidence()));
        statement.setString(36, evidenceJson(record.getStopEvidence()));
        statement.setString(37, record.getDrainReceipt() == null ? null : record.getDrainReceipt().toJson());
        statement.setString(38, request.getStorageId() == null ? null
                : storageAliasKey(scope.getTenantId(), request.getStorageId()));
    }

    private void setSeedColumns(PreparedStatement statement, int start,
            RuntimeBindingRecord record) throws SQLException {
        RuntimeProvisionSeed seed = record.getProvisionSeed();
        ProtectedSecret protectedSeed = seed == null ? null
                : secretProtector.protect(seedContext(record.getBindingId()),
                        seed.encode());
        JdbcRepositorySupport.setIdentity(statement, start, seed == null ? null : seed.getProvisionRequestId());
        statement.setString(start + 1, protectedSeed == null ? null
                : protectedSeed.getCiphertext());
        JdbcRepositorySupport.setIdentity(statement, start + 2, protectedSeed == null ? null
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
        JdbcRepositorySupport.setIdentity(statement, start, scope.getTenantId());
        JdbcRepositorySupport.setIdentity(statement, start + 1, scope.getWorkspaceId());
        JdbcRepositorySupport.setIdentity(statement, start + 2, scope.getWorkspaceGeneration());
        statement.setString(start + 3, scope.getCanonicalCwd());
        JdbcRepositorySupport.setIdentity(statement, start + 4, scope.getCapabilityDigest());
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
                JdbcRepositorySupport.getInstant(result, "last_active_at"),
                RuntimeRecoveryEvidence.fromJson(result.getString("loss_evidence_json")),
                RuntimeRecoveryEvidence.fromJson(result.getString("stop_evidence_json")),
                RuntimeDrainReceipt.fromJson(result.getString("drain_receipt_json")));
    }

    private static String evidenceJson(RuntimeRecoveryEvidence evidence) {
        return evidence == null ? null : evidence.toJson();
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
