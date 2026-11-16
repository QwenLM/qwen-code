package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * Which tool execution admissions may skip tenant placement, and the first
 * lock each one takes (design 2026-11-05-managed-admission-placement).
 *
 * <p>An ordinary session-class admission locks its Session root first
 * instead of placement. Every writer that closes the Harness fence holds that
 * root: lifecycle begin and effects already do, and
 * {@link #lockDrainRoot} makes {@code requestHarnessDrain} do so too.
 */
final class ExecutionAdmissionPlacement {
    private ExecutionAdmissionPlacement() {
    }

    /**
     * Decided before the admission transaction, on its own connection, so
     * the transaction's first statement can be the root lock. A missing root
     * keeps placement: a locking read of it would take only a gap lock.
     * Storage stays limited to none or {@code LOCAL}, whose alias and owner
     * rows every writer locks after the binding.
     */
    static boolean free(DataSource dataSource, RuntimeBindingRecord original) {
        var request = original.getRequest();
        var scope = request.getScope();
        if (CsiFilesRetirementProfile.isProfile(scope) || !"session".equals(scope.getIsolationClass())
                || ResidentWorkspaceProfile.selects(scope) || HarnessOwnership.sharesRuntimeSessions(request)
                || scope.getLifecycleAuthority() != null || request.getIsolationKey() == null) {
            return false;
        }
        return JdbcRepositorySupport.read(dataSource, connection ->
                JdbcCsiFilesRetirementGuard.sessionRootExists(connection, scope.getTenantId(),
                        request.getIsolationKey(), false)
                && (request.getStorageId() == null || localOrAbsent(connection, scope.getTenantId(),
                        request.getStorageId())));
    }

    /**
     * The admission's first lock. Under REPEATABLE READ the first plain read
     * fixes the snapshot, and the Harness fence read must see every drain
     * that committed before this root was granted, so nothing reads first.
     */
    static void lockEntry(Connection connection, RuntimeBindingRecord original, boolean free) throws SQLException {
        String tenant = original.getRequest().getScope().getTenantId();
        if (!free) {
            JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant);
        } else if (!JdbcCsiFilesRetirementGuard.sessionRootExists(connection, tenant,
                original.getRequest().getIsolationKey(), true)) {
            throw new RuntimeBrokerException(409, "runtime_admission_closed", "Session admission is closed", false);
        }
    }

    /**
     * Drain closes the Harness fence behind the Session root, after
     * placement, so a placement-free admission holding that root is ordered
     * against it. A Harness Session without a root admits only under
     * placement.
     */
    static void lockDrainRoot(Connection connection, String tenantId, String harnessSessionId) throws SQLException {
        JdbcCsiFilesRetirementGuard.sessionRootExists(connection, tenantId, harnessSessionId, true);
    }

    private static boolean localOrAbsent(Connection connection, String tenant, String storage) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT storage_kind FROM ma_storage WHERE alias_key = ?")) {
            statement.setString(1, RuntimeAdmissionFences.storageAliasKey(tenant, storage));
            try (ResultSet row = statement.executeQuery()) {
                return !row.next() || "LOCAL".equals(row.getString(1));
            }
        }
    }
}
