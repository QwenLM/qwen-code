package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
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

    static RuntimeBrokerException unverifiedWorkspaceHolder() {
        return new RuntimeBrokerException(
                409,
                "workspace_close_identity_unverified",
                "Original Workspace holder differs",
                false);
    }

    public static String harnessDrainKey(String value) {
        return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(value);
    }

    static boolean hasHarnessDrain(Connection connection, String tenantId, String harnessSessionId)
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
        String claimLock = "";
        if (authority != null) {
            // Claim updates queue on the Session, independently of tenant placement.
            claimLock = "H2".equals(connection.getMetaData().getDatabaseProductName())
                    ? " FOR UPDATE" : " FOR SHARE";
        }
        try (PreparedStatement statement = connection.prepareStatement(
                        "SELECT tenant_id, harness_session_id, phase, operation_id,"
                                + " claim_generation, claim_lease_until FROM ma_session_head WHERE"
                                + " tenant_key = ? AND harness_key = ?" + claimLock)) {
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

    static RuntimeBrokerException admissionClosed() {
        return new RuntimeBrokerException(
                409, "runtime_admission_closed", "Session admission is closed", false);
    }

    public static String storageFenceKey(String value) {
        return JdbcRepositorySupport.valueKey(value);
    }

    public static String storageAliasKey(String tenantId, String storageId) {
        return WorkspaceCsiRegistration.aliasKey(tenantId, storageId);
    }

    static String storageFence(Connection connection, String tenantId, String storageId) throws SQLException {
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

    static void requireResidentWorkspaceAdmission(Connection connection,
            RuntimeProvisionRequest request) throws SQLException {
        if (!ResidentWorkspaceProfile.selects(request)) {
            return;
        }
        var scope = request.getScope();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT workspace_generation, storage_id, state FROM ma_workspace"
                        + " WHERE tenant_id = ? AND workspace_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, scope.getWorkspaceId());
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next() || !"ACTIVE".equals(row.getString("state"))
                        || !scope.getWorkspaceGeneration().equals(Long.toString(row.getLong("workspace_generation")))
                        || !request.getStorageId().equals(row.getString("storage_id"))) {
                    throw admissionClosed();
                }
            }
        }
    }
}
