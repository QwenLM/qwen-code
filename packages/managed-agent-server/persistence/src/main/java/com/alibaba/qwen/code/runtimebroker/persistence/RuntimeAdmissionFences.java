package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.REQUEST_COLUMNS_AS_B;
import static com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository.sharesRuntimeSessions;

/**
 * The Harness admission/fence engine and the shared fence vocabulary
 * (design 2026-11-11-managed-binding-admission-fences). Every method is
 * static and runs on the caller's {@link Connection}: this class owns no
 * transactions and no state, so transaction and lock ownership stay with
 * the repository wrappers and the existing callers.
 */
public final class RuntimeAdmissionFences {
    private RuntimeAdmissionFences() {
    }

    static String localStorageOwnerKey(Connection connection, String tenant, String storage) throws SQLException {
        return localStorageOwnerKey(connection, tenant, storage, false);
    }

    static String localStorageOwnerKey(Connection connection, String tenant, String storage, boolean includeSsh) throws SQLException {
        if (storage == null) {
            return null;
        }
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT tenant_id, storage_id, storage_kind,"
                                + " physical_id FROM ma_storage WHERE tenant_id = ? AND storage_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenant);
            JdbcRepositorySupport.setIdentity(statement, 2, storage);
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
                String physical = ManagedSchemaRows.identity(row, "physical_id");
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
                        "SELECT registration_state FROM ma_storage WHERE tenant_id = ? AND storage_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, request.getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, request.getStorageId());
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next() || !"REGISTERED".equals(row.getString("registration_state"))) {
                    throw new RuntimeBrokerException(
                            409, "workspace_migrating", "Storage is under maintenance.", false);
                }
            }
        }
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT physical_id, mount_state, storage_kind"
                                + " FROM ma_storage_owner WHERE physical_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, key);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()
                        || !key.equals(ManagedSchemaRows.identity(row, "physical_id"))
                        || !"LOCAL".equals(row.getString("storage_kind"))
                        || !"READY".equals(row.getString("mount_state"))) {
                    throw new RuntimeBrokerException(
                            409, "workspace_migrating", "Storage is under maintenance.", false);
                }
            }
        }
    }

    static RuntimeBrokerException unverifiedWorkspaceHolder() {
        return new RuntimeBrokerException(
                409,
                "workspace_close_identity_unverified",
                "Original Workspace holder differs",
                false);
    }

    static boolean hasHarnessDrain(Connection connection, String tenantId, String harnessSessionId)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT tenant_id, harness_session_id, phase FROM ma_session_head WHERE"
                                + " tenant_id = ? AND harness_session_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
            try (ResultSet result = statement.executeQuery()) {
                if (!result.next()) {
                    return false;
                }
                return !"OPEN".equals(result.getString("phase"));
            }
        }
    }

    static void requireStorageAdmission(Connection connection, RuntimeProvisionRequest request)
            throws SQLException {
        if (request.getStorageId() != null && storageFence(connection,
                request.getScope().getTenantId(), request.getStorageId()) != null) {
            throw new RuntimeBrokerException(
                    409, "workspace_migrating", "Storage is under maintenance.", false);
        }
        requirePhysicalStorageAdmission(connection, request);
    }

    static boolean requireHarnessRecovery(Connection connection, RuntimeScope scope, String harnessSessionId,
            RuntimeLifecycleAuthority authority, boolean runtimeSessionOwner) throws SQLException {
        try (PreparedStatement fence =
                connection.prepareStatement(
                        "SELECT operation_id FROM ma_session_head"
                                + " WHERE tenant_id = ? AND harness_session_id = ?")) {
            JdbcRepositorySupport.setIdentity(fence, 1, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(fence, 2, harnessSessionId);
            try (ResultSet row = fence.executeQuery()) {
                if (!row.next() || row.getString(1) == null) {
                    return false;
                }
            }
        }
        boolean h2 = "H2".equals(connection.getMetaData().getDatabaseProductName());
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT o.lifecycle_protocol_version FROM ma_session_head f"
                            + " JOIN ma_operation o ON o.operation_kind IN ('CLOSE',"
                            + " 'ARCHIVE', 'DELETE') AND o.tenant_id = f.tenant_id AND"
                            + " o.session_id = f.harness_session_id AND "
                            + ManagedSchemaJdbcTemplate.binaryIdentity("o.operation_id", h2)
                            + " = f.operation_id WHERE f.tenant_id = ? AND"
                            + " f.harness_session_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
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
    }

    public static void requireHarnessAdmission(Connection connection, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority) throws SQLException {
        requireHarnessAdmission(connection, scope, harnessSessionId, authority, fence(false));
    }

    /** What a Harness fence admits beyond ordinary new work. */
    enum HarnessFence {
        LEGACY_HOOK,
        RETIREMENT,
        CLEANUP,
        /** Fences a shared binding by the admitted Runtime Session's own Harness Session. */
        RUNTIME_SESSION_OWNER
    }

    static Set<HarnessFence> fence(boolean runtimeSessionOwner, HarnessFence... fences) {
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
    static void requireHarnessAdmission(Connection connection, RuntimeScope scope,
            String harnessSessionId, RuntimeLifecycleAuthority authority, Set<HarnessFence> fence) throws SQLException {
        boolean legacyHook = fence.contains(HarnessFence.LEGACY_HOOK);
        boolean retirement = fence.contains(HarnessFence.RETIREMENT);
        boolean cleanup = fence.contains(HarnessFence.CLEANUP);
        if (fence.contains(HarnessFence.RUNTIME_SESSION_OWNER)) {
            BrokerValues.requireId(harnessSessionId, "harnessSessionId");
        } else if (!"session".equals(scope.getIsolationClass())
                && !(WorkspaceExecutionProfile.isBoundWorkspaceScope(scope) && harnessSessionId != null
                        && authority != null)) {
            if (authority != null) {
                throw admissionClosed();
            }
            return;
        }
        String claimLock = "";
        if (authority != null) {
            // Claim updates queue on the Session, independently of tenant placement.
            claimLock = "H2".equals(connection.getMetaData().getDatabaseProductName())
                    ? " FOR UPDATE" : " FOR SHARE";
        }
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT tenant_id, harness_session_id, phase, operation_id,"
                                + " claim_generation, claim_lease_until FROM ma_session_head WHERE"
                                + " tenant_id = ? AND harness_session_id = ?" + claimLock)) {
            JdbcRepositorySupport.setIdentity(statement, 1, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, harnessSessionId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) {
                    if (authority != null) {
                        throw admissionClosed();
                    }
                    return;
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
                        "INSERT INTO ma_session_head (tenant_id, harness_session_id, session_id, head_kind, phase, operation_id, gmt_create, gmt_modified) VALUES (?, ?, ?, 'HARNESS', 'LIFECYCLE_ONLY', ?, " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE gmt_modified = CASE WHEN phase IS NULL OR phase <> 'LIFECYCLE_ONLY' OR operation_id IS NULL OR operation_id <> VALUES(operation_id) THEN VALUES(gmt_modified) ELSE gmt_modified END, phase = 'LIFECYCLE_ONLY', operation_id = VALUES(operation_id)")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, sessionId);
            JdbcRepositorySupport.setIdentity(statement, 3, sessionId);
            JdbcRepositorySupport.setIdentity(statement, 4, operationId);
            statement.executeUpdate();
        }
    }

    static RuntimeBrokerException admissionClosed() {
        return new RuntimeBrokerException(
                409, "runtime_admission_closed", "Session admission is closed", false);
    }

    public static String storageAliasKey(String tenantId, String storageId) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key("qwen-csi-alias/1", tenantId, storageId);
    }

    static String storageFence(Connection connection, String tenantId, String storageId) throws SQLException {
        try (PreparedStatement statement =
                connection.prepareStatement(
                        "SELECT tenant_id, storage_id, fence_operation_id"
                                + " FROM ma_storage WHERE tenant_id = ? AND storage_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, storageId);
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
}
