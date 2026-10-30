package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry.RegisteredExternalStorage;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.provisioning.ManagedContextProtocol;
import org.apache.commons.codec.digest.DigestUtils;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/** EXTERNAL physical ownership under the caller's transaction; never contacts a worker. */
public final class JdbcExternalWorkspaceOwnership {
    private JdbcExternalWorkspaceOwnership() {
    }

    public record Owner(RegisteredExternalStorage registration, String holder,
            String bindingId, Long generation, String sessionId) {
        boolean empty() {
            return holder == null && bindingId == null && generation == null && sessionId == null;
        }

        boolean matches(RuntimeBindingRecord binding, RuntimeSessionRecord session) {
            return holderKey(binding, session).equals(holder) && binding.getBindingId().equals(bindingId)
                    && Long.valueOf(binding.getGeneration()).equals(generation)
                    && session.getRuntimeSessionId().equals(sessionId);
        }
    }

    public static Owner lockOwner(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        if (connection.getAutoCommit() || !ExternalWorkspaceProvisioner.isWorkspaceRequest(binding.getRequest())) {
            throw unavailable();
        }
        var request = binding.getRequest();
        String tenant = request.getScope().getTenantId();
        String storage = request.getStorageId();
        JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant);
        RegisteredExternalStorage registration;
        try (var statement = connection.prepareStatement("SELECT * FROM ma_storage WHERE alias_key = ? FOR UPDATE")) {
            statement.setString(1, JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage));
            try (var row = statement.executeQuery()) {
                if (!row.next() || !tenant.equals(row.getString("tenant_id")) || !storage.equals(row.getString("storage_id"))
                        || !"EXTERNAL".equals(row.getString("storage_kind"))
                        || !"REGISTERED".equals(row.getString("registration_state"))) {
                    throw unavailable();
                }
                String encoded = row.getString("registration_json");
                try {
                    registration = ExternalStorageRegistry.decodeRegistration(encoded);
                } catch (RuntimeException invalid) {
                    throw unavailable();
                }
                if (!storage.equals(registration.tenantWorkspaceId())
                        || !registration.ownerKey().equals(row.getString("physical_key"))
                        || registration.registrationRevision() != row.getLong("registration_revision")) {
                    throw unavailable();
                }
            }
        }
        requireBoot(binding, registration);
        try (var statement = connection.prepareStatement("SELECT * FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE")) {
            statement.setString(1, registration.ownerKey());
            try (var row = statement.executeQuery()) {
                if (!row.next() || !registration.ownerKey().equals(row.getString("physical_key"))
                        || !"EXTERNAL".equals(row.getString("storage_kind"))
                        || !tenant.equals(row.getString("tenant_id")) || !storage.equals(row.getString("storage_id"))
                        || !registration.mountRoot().equals(row.getString("mount_root"))
                        || registration.registrationRevision() != row.getLong("mount_revision")
                        || !"UNVERIFIED".equals(row.getString("mount_state"))
                        || row.getObject("maintenance_id") != null || row.getObject("maintenance_generation") != null
                        || !"RELEASED".equals(row.getString("csi_phase")) || row.getLong("csi_revision") != 0
                        || row.getObject("csi_reservation_id") != null || row.getObject("csi_registration_key") != null
                        || row.getObject("csi_registration_revision") != null || row.getObject("csi_provision_request_id") != null) {
                    throw unavailable();
                }
                Long generation = row.getObject("runtime_generation") == null ? null : row.getLong("runtime_generation");
                Owner owner = new Owner(registration, row.getString("holder_key"), row.getString("binding_id"),
                        generation, row.getString("runtime_session_id"));
                if (!owner.empty() && (owner.holder() == null || owner.bindingId() == null
                        || owner.generation() == null || owner.sessionId() == null)) {
                    throw unavailable();
                }
                return owner;
            }
        }
    }

    private static void requireBoot(RuntimeBindingRecord binding, RegisteredExternalStorage registration) {
        var seed = binding.getProvisionSeed();
        var handle = binding.getResourceHandle();
        if (seed == null || binding.getLease() == null || !seed.matches(binding.getLease()) || handle == null
                || handle.getVersion() != 1 || !ExternalWorkspaceProvisioner.KIND.equals(handle.getKind())
                || binding.getAttestationGeneration() <= 0
                || !registration.mountRoot().equals(binding.getRequest().getScope().getCanonicalCwd())) {
            throw unavailable();
        }
        var boot = new TreeMap<String, Object>(ManagedContextProtocol.boot(binding.getRequest(), seed));
        boot.remove("token");
        boot.put("storage", new TreeMap<>(Map.of("kind", "external", "physicalKey", registration.physicalKey(),
                "aliasPath", registration.aliasPath(), "mountRoot", registration.mountRoot(),
                "registrationRevision", registration.registrationRevision())));
        String identity = DigestUtils.sha256Hex(JsonCodec.encode(new TreeMap<>(Map.of("version", 1,
                "providerId", registration.providerId(), "isolationKey", binding.getRequest().getIsolationKey(), "boot", boot))));
        if (!handle.getValue().equals(Map.of("providerId", registration.providerId(),
                "provisionRequestId", seed.getProvisionRequestId(), "identity", identity,
                "provider", Map.of("requestId", seed.getProvisionRequestId())))) {
            throw unavailable();
        }
    }

    public static RuntimeBindingRecord requireCurrent(Connection connection, JdbcRuntimeBindingRepository repository,
            RuntimeBindingRecord original, boolean acquiring) throws SQLException {
        var current = repository.findByIdForUpdate(connection, original.getBindingId());
        if (current == null || !current.sameIdentity(original)
                || !Objects.equals(current.getProvisionSeed(), original.getProvisionSeed())
                || !Objects.equals(current.getResourceHandle(), original.getResourceHandle())
                || !current.hasSameLease(original.getLease())
                || current.getAttestationGeneration() != original.getAttestationGeneration()
                || current.getState() != original.getState() || current.isDrainRequested() != original.isDrainRequested()
                || !Objects.equals(current.getOperationOwner(), original.getOperationOwner())
                || current.getOperationGeneration() != original.getOperationGeneration()
                || current.getOperationOwner() != null && !current.hasLiveOperationAt(JdbcRepositorySupport.databaseNowPrecise(connection))
                || acquiring && (current.getState() != RuntimeBindingRecord.State.READY || current.isDrainRequested())
                || !acquiring && current.getState() != RuntimeBindingRecord.State.READY
                        && current.getState() != RuntimeBindingRecord.State.DRAINING
                        && (current.getState() != RuntimeBindingRecord.State.LOST
                                || !current.isDrainRequested() || current.getOperationOwner() == null)) {
            throw unavailable();
        }
        return current;
    }

    public static ContextBinding savedContext(Connection connection, RuntimeBindingRecord binding,
            boolean acquiring) throws SQLException {
        var scope = binding.getRequest().getScope();
        String harness = binding.getRequest().getIsolationKey();
        if (acquiring) {
            requireExecutionGrant(connection, binding);
        }
        try (var statement = connection.prepareStatement("SELECT * FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, harness);
            try (var row = statement.executeQuery()) {
                if (!row.next() || !scope.getTenantId().equals(row.getString("tenant_id"))
                        || !harness.equals(row.getString("session_id")) || row.getObject("deleted_at") != null
                        || !"qwen-code".equals(row.getString("agent_id")) || row.getObject("agent_definition_digest") != null
                        || row.getObject("parent_session_id") != null
                        || !"hosted-workspace-external-files/1".equals(row.getString("tool_profile"))
                        || !WorkspaceExecutionProfile.CONFIG_REF.equals(row.getString("workspace_config_ref"))
                        || !WorkspaceExecutionProfile.POLICY_REF.equals(row.getString("workspace_policy_ref"))
                        || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(row.getString("context_config_ref"))
                        || !scope.getWorkspaceId().equals(row.getString("workspace_id"))
                        || !scope.getWorkspaceGeneration().equals(Long.toString(row.getLong("workspace_generation")))
                        || !binding.getRequest().getStorageId().equals(row.getString("workspace_storage_id"))
                        || acquiring && !"ACTIVE".equals(row.getString("status"))) {
                    throw unavailable();
                }
                return new ContextBinding(scope.getTenantId(), scope.getWorkspaceId(), row.getLong("workspace_generation"),
                        row.getString("workspace_storage_id"), row.getString("cwd_relative"),
                        row.getString("context_config_ref"), row.getLong("context_revision"));
            }
        }
    }

    private static void requireExecutionGrant(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        var scope = binding.getRequest().getScope();
        try (var statement = connection.prepareStatement("SELECT w.workspace_generation, w.storage_id FROM ma_workspace w"
                + " JOIN ma_session s ON s.tenant_id = w.tenant_id AND s.workspace_id = w.workspace_id"
                + " JOIN ma_workspace_access a ON a.tenant_id = w.tenant_id AND a.workspace_id = w.workspace_id"
                + " AND a.actor_id = COALESCE(s.owner_actor_key, s.creator_actor_key) WHERE w.tenant_id = ? AND w.workspace_id = ?"
                + " AND s.session_id = ? AND w.state = 'ACTIVE' AND a.role IN ('OPERATOR', 'OWNER') FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, scope.getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 2, scope.getWorkspaceId());
            JdbcRepositorySupport.setIdentity(statement, 3, binding.getRequest().getIsolationKey());
            try (var row = statement.executeQuery()) {
                if (!row.next() || !scope.getWorkspaceGeneration().equals(Long.toString(row.getLong("workspace_generation")))
                        || !binding.getRequest().getStorageId().equals(row.getString("storage_id")) || row.next()) {
                    throw unavailable();
                }
            }
        }
    }

    private static boolean member(Connection connection, RuntimeBindingRecord binding,
            RuntimeSessionRecord session, String physical, boolean acquiring) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT * FROM ma_runtime_session WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, binding.getBindingId());
            statement.setLong(2, binding.getGeneration());
            JdbcRepositorySupport.setIdentity(statement, 3, session.getRuntimeSessionId());
            try (var row = statement.executeQuery()) {
                var scope = binding.getRequest().getScope();
                if (!row.next() || !binding.getBindingId().equals(session.getBindingId())
                        || binding.getGeneration() != session.getRuntimeGeneration()
                        || !scope.equals(session.getSession().getScope())
                        || !session.getSession().getHarnessSessionId().equals(binding.getRequest().getIsolationKey())
                        || !session.getSession().getHarnessSessionId().equals(row.getString("harness_session_id"))
                        || !session.getSession().getTurnKind().equals(row.getString("turn_kind"))
                        || !scope.getTenantId().equals(row.getString("tenant_id"))
                        || !scope.getWorkspaceId().equals(row.getString("workspace_id"))
                        || !scope.getWorkspaceGeneration().equals(row.getString("workspace_generation"))
                        || !scope.getCanonicalCwd().equals(row.getString("canonical_cwd"))
                        || !scope.getCapabilityDigest().equals(row.getString("capability_digest"))
                        || !scope.getIsolationClass().equals(row.getString("isolation_class"))
                        || acquiring && (!session.isAcquirable() || !java.util.Set.of("ACQUIRING", "READY").contains(row.getString("session_state"))
                                || session.getState() == RuntimeSessionRecord.State.READY && !"READY".equals(row.getString("session_state")))
                        || !acquiring && !java.util.Set.of("ACQUIRING", "READY", "RELEASING", "RELEASED").contains(row.getString("session_state"))
                        || row.getBoolean("execution_exclusive")
                        || row.getString("execution_storage_key") != null && !physical.equals(row.getString("execution_storage_key"))) {
                    throw unavailable();
                }
                return physical.equals(row.getString("execution_storage_key"));
            }
        }
    }

    public static boolean held(Connection connection, Owner owner, RuntimeBindingRecord binding,
            RuntimeSessionRecord session, boolean acquiring) throws SQLException {
        boolean member = member(connection, binding, session, owner.registration().ownerKey(), acquiring);
        if (!owner.empty() && !owner.matches(binding, session)) {
            throw busy();
        }
        requireSoleMember(connection, owner, binding, session);
        return owner.matches(binding, session) && member;
    }

    private static void requireSoleMember(Connection connection, Owner owner, RuntimeBindingRecord binding,
            RuntimeSessionRecord session) throws SQLException {
        try (var statement = connection.prepareStatement("SELECT binding_id, runtime_generation, runtime_session_id"
                + " FROM ma_runtime_session WHERE execution_storage_key = ? FOR UPDATE")) {
            statement.setString(1, owner.registration().ownerKey());
            try (var row = statement.executeQuery()) {
                while (row.next()) {
                    if (!binding.getBindingId().equals(row.getString("binding_id"))
                            || binding.getGeneration() != row.getLong("runtime_generation")
                            || !session.getRuntimeSessionId().equals(row.getString("runtime_session_id"))) {
                        throw busy();
                    }
                }
            }
        }
    }

    public static void claim(Connection connection, Owner owner, RuntimeBindingRecord binding,
            RuntimeSessionRecord session) throws SQLException {
        held(connection, owner, binding, session, true);
        if (owner.empty()) {
            try (var statement = connection.prepareStatement("UPDATE ma_storage_owner SET holder_key = ?, binding_id = ?,"
                    + " runtime_generation = ?, runtime_session_id = ? WHERE storage_key = ?")) {
                statement.setString(1, holderKey(binding, session));
                JdbcRepositorySupport.setIdentity(statement, 2, binding.getBindingId());
                statement.setLong(3, binding.getGeneration());
                JdbcRepositorySupport.setIdentity(statement, 4, session.getRuntimeSessionId());
                statement.setString(5, owner.registration().ownerKey());
                if (statement.executeUpdate() != 1) {
                    throw unavailable();
                }
            }
        }
        try (var statement = connection.prepareStatement("UPDATE ma_runtime_session SET execution_storage_key = ?"
                + " WHERE binding_id = ? AND runtime_generation = ? AND runtime_session_id = ?")) {
            statement.setString(1, owner.registration().ownerKey());
            JdbcRepositorySupport.setIdentity(statement, 2, binding.getBindingId());
            statement.setLong(3, binding.getGeneration());
            JdbcRepositorySupport.setIdentity(statement, 4, session.getRuntimeSessionId());
            statement.executeUpdate();
        }
    }

    public static void releaseMember(Connection connection, Owner owner, RuntimeBindingRecord binding,
            RuntimeSessionRecord session) throws SQLException {
        held(connection, owner, binding, session, false);
        try (var statement = connection.prepareStatement("UPDATE ma_runtime_session SET execution_storage_key = NULL,"
                + " execution_exclusive = FALSE WHERE execution_storage_key = ? AND binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id = ? AND harness_session_id = ?")) {
            statement.setString(1, owner.registration().ownerKey());
            JdbcRepositorySupport.setIdentity(statement, 2, binding.getBindingId());
            statement.setLong(3, binding.getGeneration());
            JdbcRepositorySupport.setIdentity(statement, 4, session.getRuntimeSessionId());
            JdbcRepositorySupport.setIdentity(statement, 5, session.getSession().getHarnessSessionId());
            statement.executeUpdate();
        }
    }

    public static void releaseStopped(Connection connection, Owner owner, RuntimeBindingRecord current,
            RuntimeBindingRecord claim, RuntimeSessionRecord session) throws SQLException {
        requireStopped(connection, current, claim, session);
        requireDrainMembers(connection, owner, current);
        var saved = JdbcRuntimeSessionRepository.selectSession(connection, current.getRequest().getScope(), session.getRuntimeSessionId(), true);
        if (saved == null || !saved.sameIdentity(session)
                || saved.getState() != RuntimeSessionRecord.State.RELEASING && saved.getState() != RuntimeSessionRecord.State.RELEASED) {
            throw unavailable();
        }
        if (!owner.empty() && !owner.matches(current, session)) {
            member(connection, current, session, owner.registration().ownerKey(), false);
            return;
        }
        releaseMember(connection, owner, current, session);
        if (!owner.empty()) {
            try (var statement = connection.prepareStatement("UPDATE ma_storage_owner SET holder_key = NULL, binding_id = NULL,"
                    + " runtime_generation = NULL, runtime_session_id = NULL WHERE storage_key = ? AND holder_key = ?"
                    + " AND binding_id = ? AND runtime_generation = ? AND runtime_session_id = ?")) {
                statement.setString(1, owner.registration().ownerKey());
                statement.setString(2, holderKey(current, session));
                JdbcRepositorySupport.setIdentity(statement, 3, current.getBindingId());
                statement.setLong(4, current.getGeneration());
                JdbcRepositorySupport.setIdentity(statement, 5, session.getRuntimeSessionId());
                if (statement.executeUpdate() != 1) {
                    throw unavailable();
                }
            }
        }
        requireStopped(connection, current, claim, session);
    }

    private static void requireStopped(Connection connection, RuntimeBindingRecord current,
            RuntimeBindingRecord claim, RuntimeSessionRecord session) throws SQLException {
        if (session.getState() != RuntimeSessionRecord.State.RELEASING && session.getState() != RuntimeSessionRecord.State.RELEASED) {
            throw unavailable();
        }
        RuntimeAdmission.requireStoppedRelease(current, claim,
                session.withState(RuntimeSessionRecord.State.RELEASING, session.getLastActiveAt()),
                JdbcRepositorySupport.databaseNowPrecise(connection));
        if (JdbcToolExecutionRepository.hasActiveByBinding(connection, current.getBindingId(), current.getGeneration())) {
            throw unavailable();
        }
    }

    public static boolean hasHolder(Connection connection, Owner owner, RuntimeBindingRecord binding) throws SQLException {
        if (owner.empty()) {
            return false;
        }
        if (!binding.getBindingId().equals(owner.bindingId()) || !Long.valueOf(binding.getGeneration()).equals(owner.generation())) {
            throw busy();
        }
        String expected = ManagedSchemaKeys.key("external-workspace-holder/1", binding.getBindingId(),
                Long.toString(binding.getGeneration()), owner.sessionId());
        if (!expected.equals(owner.holder())) {
            throw unavailable();
        }
        return true;
    }

    public static void requireDrainMembers(Connection connection, Owner owner, RuntimeBindingRecord binding) throws SQLException {
        if (hasHolder(connection, owner, binding)) {
            var session = JdbcRuntimeSessionRepository.selectSession(connection, binding.getRequest().getScope(), owner.sessionId(), true);
            if (session == null) {
                throw unavailable();
            }
            held(connection, owner, binding, session, false);
        }
        try (var statement = connection.prepareStatement("SELECT binding_id, runtime_generation, runtime_session_id"
                + " FROM ma_runtime_session WHERE execution_storage_key = ? FOR UPDATE")) {
            statement.setString(1, owner.registration().ownerKey());
            try (var row = statement.executeQuery()) {
                while (row.next()) {
                    if (owner.empty() || !binding.getBindingId().equals(row.getString("binding_id"))
                            || binding.getGeneration() != row.getLong("runtime_generation")
                            || !owner.sessionId().equals(row.getString("runtime_session_id"))) {
                        throw unavailable();
                    }
                }
            }
        }
    }

    private static String holderKey(RuntimeBindingRecord binding, RuntimeSessionRecord session) {
        return ManagedSchemaKeys.key("external-workspace-holder/1", binding.getBindingId(),
                Long.toString(binding.getGeneration()), session.getRuntimeSessionId());
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_close_identity_unverified", "Original EXTERNAL ownership is unavailable.", false);
    }

    private static RuntimeBrokerException busy() {
        return new RuntimeBrokerException(409, "workspace_busy", "External storage retains its original Runtime owner.", true);
    }
}
