package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.RuntimeAdmission;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.HarnessFence;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.fence;
import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.lockPlacementDomain;
import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.requireHarnessAdmission;
import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.storageAliasKey;
import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.unverifiedWorkspaceHolder;

/**
 * The Session release/stop-lock arm of the binding repository: the physical
 * storage admission and stopped-member checks plus the begin/complete release
 * transitions. Split out of JdbcRuntimeBindingRepository verbatim; the SQL,
 * lock order and verdicts are the ones the repository ran inline.
 */
final class RuntimeBindingSessionRelease {
    private final DataSource dataSource;
    private final JdbcRuntimeBindingRepository repository;

    RuntimeBindingSessionRelease(DataSource dataSource, JdbcRuntimeBindingRepository repository) {
        this.dataSource = dataSource;
        this.repository = repository;
    }

    RuntimeSessionRecord completeSessionRelease(RuntimeSessionRepository sessions,
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
                        throw CsiFilesRetirementProfile.releaseUnavailable();
                    }
                    RuntimeBindingRecord binding =
                            repository.selectById(connection, expected.getBindingId(), true);
                    RuntimeAdmission.requireRelease(binding, expected);
                    return JdbcRuntimeSessionRepository.compareAndSet(
                            connection,
                            expected,
                            expected.withState(
                                    RuntimeSessionRecord.State.RELEASED,
                                    JdbcRepositorySupport.databaseNow(connection)));
                });
    }

    RuntimeSessionRecord completeStoppedSessionRelease(RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeSessionRecord expected, RuntimeBindingRecord claim) {
        if (com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile
                        .isExternalWorkspaceRequest(claim.getRequest())
                && HarnessOwnership.sharesRuntimeSessions(
                        claim.getRequest())) {
            throw new RuntimeBrokerException(409,
                    "external_workspace_recovery_required",
                    "A resident Workspace cannot be destroyed by closing one Session",
                    false);
        }
        if (!(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !jdbcSessions.usesDataSource(dataSource)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcExecutions.usesDataSource(dataSource)) {
            throw new IllegalArgumentException("Release requires the same DataSource");
        }
        return JdbcRepositorySupport.transaction(dataSource, connection -> {
            lockPlacementDomain(connection, claim.getRequest().getScope().getTenantId()); // binding, then storage rows
            boolean external = WorkspaceExecutionProfile.isExternalWorkspaceRequest(claim.getRequest());
            var externalOwner = external ? JdbcExternalWorkspaceOwnership.lockStoppedRelease(
                    connection, claim, expected.getSession().getHarnessSessionId()) : null;
            RuntimeBindingRecord binding = external
                    ? JdbcExternalWorkspaceOwnership.requireCurrent(connection, repository, claim, false)
                    : repository.selectById(connection, expected.getBindingId(), true);
            String physical = external ? null : localStorageOwnerKey(connection, claim.getRequest().getScope().getTenantId(),
                    claim.getRequest().getStorageId(), true);
            if (physical != null) {
                try (var lock = connection.prepareStatement("SELECT physical_key FROM ma_storage_owner WHERE storage_key = ?"
                        + " AND storage_kind = (SELECT storage_kind FROM ma_storage WHERE alias_key = ?)"
                        + " FOR UPDATE")) {
                    lock.setString(1, physical);
                    lock.setString(2, storageAliasKey(claim.getRequest().getScope().getTenantId(), claim.getRequest().getStorageId()));
                    try (var rows = lock.executeQuery()) {
                        if (!rows.next() || !physical.equals(rows.getString(1))
                                || !com.alibaba.qwen.code.managedagent.persistence.StorageOwnerMembership.membersAllowed(connection, physical, true)) {
                            throw unverifiedWorkspaceHolder();
                        }
                    }
                }
            }
            var authority = claim.getRequest().getScope().getLifecycleAuthority();
            if (authority != null) {
                requireHarnessAdmission(connection, claim.getRequest().getScope(), claim.getRequest().getIsolationKey(),
                        authority, fence(false, HarnessFence.CLEANUP));
            }
            RuntimeAdmission.requireStoppedRelease(binding, claim, expected, JdbcRepositorySupport.databaseNowPrecise(connection));
            if (JdbcToolExecutionRepository.hasActiveByBinding(connection, binding.getBindingId(), binding.getGeneration())) {
                throw new RuntimeBrokerException(409, "workspace_close_execution_unsettled",
                        "Original resources remain active", false);
            }
            RuntimeSessionRecord updated = JdbcRuntimeSessionRepository.compareAndSet(connection, expected,
                    expected.withState(RuntimeSessionRecord.State.RELEASED, JdbcRepositorySupport.databaseNow(connection)));
            if (updated != null) {
                JdbcExternalWorkspaceOwnership.releaseStoppedMember(connection, external, externalOwner, binding, claim, expected, physical);
                RuntimeAdmission.requireStoppedRelease(binding, claim, expected, JdbcRepositorySupport.databaseNowPrecise(connection));
            }
            return updated;
        });
    }

    static void clearStoppedMember(Connection connection, String key, RuntimeSessionRecord session) throws SQLException {
        try (var read = connection.prepareStatement("SELECT execution_storage_key FROM ma_runtime_session"
                + " WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(read, 1, session.getBindingId());
            read.setLong(2, session.getRuntimeGeneration());
            JdbcRepositorySupport.setIdentity(read, 3, session.getRuntimeSessionId());
            try (var rows = read.executeQuery()) {
                if (!rows.next() || rows.getString(1) != null && !key.equals(rows.getString(1))) {
                    throw unverifiedWorkspaceHolder();
                }
            }
        }
        try (var clear = connection.prepareStatement("UPDATE ma_runtime_session SET execution_storage_key = NULL,"
                + " is_rewind_pending = FALSE WHERE execution_storage_key = ? AND binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id = ?")) {
            clear.setString(1, key);
            JdbcRepositorySupport.setIdentity(clear, 2, session.getBindingId());
            clear.setLong(3, session.getRuntimeGeneration());
            JdbcRepositorySupport.setIdentity(clear, 4, session.getRuntimeSessionId());
            com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore.releaseMembers(connection, key,
                    clear.executeUpdate());
        }
    }

    private static String localStorageOwnerKey(Connection connection, String tenant, String storage) throws SQLException {
        return localStorageOwnerKey(connection, tenant, storage, false);
    }

    private static String localStorageOwnerKey(Connection connection, String tenant, String storage, boolean includeSsh) throws SQLException {
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
                if (!"LOCAL".equals(row.getString("storage_kind"))
                        && !(includeSsh && "SSH_LOCAL".equals(row.getString("storage_kind")))) {
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

    static void requirePhysicalStorageAdmission(Connection connection, RuntimeProvisionRequest request) throws SQLException {
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

    RuntimeSessionRecord beginSessionRelease(RuntimeSessionRepository sessions,
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
                        throw CsiFilesRetirementProfile.releaseUnavailable();
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
}
