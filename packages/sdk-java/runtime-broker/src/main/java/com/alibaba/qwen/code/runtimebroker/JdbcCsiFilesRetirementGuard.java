package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

/** Original-connection parent fence for the private file-only CSI profile. */
public final class JdbcCsiFilesRetirementGuard {
    private JdbcCsiFilesRetirementGuard() {
    }

    public record Original(RuntimeProvisionRequest request, String bindingId,
            long generation, RuntimeBindingRecord.State state, boolean draining) {
        public void requireAdmission() {
            if (state != RuntimeBindingRecord.State.READY || draining) {
                throw closed();
            }
        }

        public void requireSession(RuntimeSessionRecord session) {
            if (session == null || !bindingId.equals(session.getBindingId())
                    || generation != session.getRuntimeGeneration()
                    || !request.getScope().equals(session.getSession().getScope())
                    || !request.getIsolationKey().equals(session.getRuntimeSessionId())
                    || !request.getIsolationKey().equals(session.getSession().getHarnessSessionId())
                    || !"bootstrap".equals(session.getSession().getTurnKind())) {
                throw unavailable();
            }
        }

        public void requireContinuation() {
            if (state != RuntimeBindingRecord.State.READY
                    && (state != RuntimeBindingRecord.State.DRAINING || !draining)) {
                throw closed();
            }
        }
    }

    public static boolean isProfile(RuntimeScope scope) {
        return scope != null && CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(scope.getCapabilityDigest());
    }

    static boolean requireProvisionPin(Connection connection, RuntimeProvisionRequest request)
            throws SQLException {
        if (!isProfile(request.getScope())) {
            return false;
        }
        requireTransaction(connection);
        String tenant = request.getScope().getTenantId();
        String session = request.getIsolationKey();
        JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant, 10);
        List<Slot> slots = lockSlots(connection, tenant, session);
        List<Binding> bindings = lockBindings(connection, tenant, session, slots);
        requirePin(readPin(connection, tenant, session), request);
        if (slots.size() > 1 || bindings.size() > 1
                || !slots.isEmpty() && (!request.equals(slots.getFirst().request())
                        || !request.requestKey().equals(slots.getFirst().key()))
                || !bindings.isEmpty() && !matches(request, bindings.getFirst())) {
            throw unavailable();
        }
        if (!bindings.isEmpty()) {
            requireOriginal(slots, bindings);
        }
        return true;
    }

    public static Original lockManagedSession(Connection connection, String tenantId, String sessionId)
            throws SQLException {
        requireTransaction(connection);
        JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenantId, 10);
        List<Slot> slots = lockSlots(connection, tenantId, sessionId);
        List<Binding> bindings = lockBindings(connection, tenantId, sessionId, slots);
        Pin pin = readPin(connection, tenantId, sessionId);
        if (pin == null || !CsiFilesRetirementProfile.PROFILE.equals(pin.profile())) {
            if (pin != null && pin.requestKey() != null
                    || slots.stream().anyMatch(slot -> isProfile(slot.request().getScope()))
                    || bindings.stream().anyMatch(binding -> isProfile(binding.original().request().getScope()))) {
                throw unavailable();
            }
            return null;
        }
        Original original = requireOriginal(slots, bindings);
        requirePin(pin, original.request());
        return original;
    }

    private static Original requireOriginal(List<Slot> slots, List<Binding> bindings) {
        if (slots.size() != 1 || bindings.size() != 1) {
            throw unavailable();
        }
        Slot slot = slots.getFirst();
        Binding binding = bindings.getFirst();
        Original original = binding.original();
        if (slot.lastGeneration() != 1 || original.generation() != 1
                || !original.bindingId().equals(slot.activeBinding())
                || !original.request().equals(slot.request())
                || !original.request().requestKey().equals(slot.key())
                || !matches(original.request(), binding)) {
            throw unavailable();
        }
        return original;
    }

    private static boolean matches(RuntimeProvisionRequest request, Binding binding) {
        return request.equals(binding.original().request())
                && request.requestKey().equals(binding.key())
                && JdbcRepositorySupport.scopeKey(request.getScope()).equals(binding.scopeKey());
    }

    private static List<Slot> lockSlots(Connection connection, String tenantId, String sessionId) throws SQLException {
        List<Slot> slots = new ArrayList<>();
        try (PreparedStatement statement = statement(connection,
                "SELECT * FROM qwen_runtime_binding_slot WHERE tenant_id = ? AND isolation_key = ?"
                        + " ORDER BY request_key FOR UPDATE")) {
            statement.setString(1, tenantId);
            statement.setString(2, sessionId);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    slots.add(new Slot(request(rows), rows.getString("request_key"),
                            rows.getString("active_binding_id"), rows.getLong("last_generation")));
                }
            }
        }
        return slots;
    }

    private static List<Binding> lockBindings(Connection connection, String tenantId, String sessionId,
            List<Slot> slots) throws SQLException {
        List<Binding> bindings = new ArrayList<>();
        StringBuilder sql = new StringBuilder("SELECT * FROM qwen_runtime_binding"
                + " WHERE (tenant_id = ? AND isolation_key = ?)");
        List<String> references = new ArrayList<>();
        for (Slot slot : slots) {
            sql.append(" OR request_key = ?");
            references.add(slot.key());
            if (slot.activeBinding() != null) {
                sql.append(" OR binding_id = ?");
                references.add(slot.activeBinding());
            }
        }
        sql.append(" ORDER BY request_key, binding_id FOR UPDATE");
        try (PreparedStatement statement = statement(connection, sql.toString())) {
            statement.setString(1, tenantId);
            statement.setString(2, sessionId);
            for (int index = 0; index < references.size(); index++) {
                statement.setString(index + 3, references.get(index));
            }
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    Original original = new Original(request(rows), rows.getString("binding_id"),
                            rows.getLong("runtime_generation"),
                            RuntimeBindingRecord.State.valueOf(rows.getString("binding_state")),
                            rows.getBoolean("drain_requested"));
                    if (bindings.size() < 2 || isProfile(original.request().getScope())
                            && bindings.stream().noneMatch(binding -> isProfile(binding.original().request().getScope()))) {
                        bindings.add(new Binding(original, rows.getString("request_key"), rows.getString("scope_key")));
                    }
                }
            }
        }
        return bindings;
    }

    static Original lockRuntimeSession(Connection connection, RuntimeSessionRecord session)
            throws SQLException {
        if (!isProfile(session.getSession().getScope())) {
            return null;
        }
        Original original = lockManagedSession(connection, session.getSession().getScope().getTenantId(),
                session.getSession().getHarnessSessionId());
        if (original == null) {
            throw unavailable();
        }
        original.requireSession(session);
        return original;
    }

    static Original lockBinding(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        if (!isProfile(binding.getRequest().getScope())) {
            return null;
        }
        Original original = lockManagedSession(connection, binding.getRequest().getScope().getTenantId(),
                binding.getRequest().getIsolationKey());
        if (original == null || !original.request().equals(binding.getRequest())
                || !original.bindingId().equals(binding.getBindingId())
                || original.generation() != binding.getGeneration()) {
            throw unavailable();
        }
        return original;
    }

    static void requireSingleSession(Connection connection, Original original) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT * FROM qwen_runtime_session WHERE binding_id = ?"
                        + " OR (tenant_id = ? AND harness_session_id = ?)"
                        + " ORDER BY scope_key, runtime_session_id LIMIT 2 FOR UPDATE")) {
            statement.setString(1, original.bindingId());
            statement.setString(2, original.request().getScope().getTenantId());
            statement.setString(3, original.request().getIsolationKey());
            try (ResultSet rows = statement.executeQuery()) {
                if (rows.next()) {
                    if (!original.bindingId().equals(rows.getString("binding_id"))
                            || original.generation() != rows.getLong("runtime_generation")
                            || !original.request().getIsolationKey().equals(rows.getString("runtime_session_id"))
                            || !original.request().getIsolationKey().equals(rows.getString("harness_session_id"))
                            || !"bootstrap".equals(rows.getString("turn_kind"))
                            || !original.request().getScope().equals(scope(rows))
                            || !JdbcRepositorySupport.scopeKey(original.request().getScope())
                                    .equals(rows.getString("scope_key")) || rows.next()) {
                        throw unavailable();
                    }
                }
            }
        }
    }

    static RuntimeBrokerException releaseUnavailable() {
        return new RuntimeBrokerException(409, "csi_finalize_required",
                "The original CSI Session requires retirement finalization.", false);
    }

    private static Pin readPin(Connection connection, String tenantId, String sessionId) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT tenant_id, session_id, agent_id, tool_profile, runtime_request_key, workspace_id,"
                        + " workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref, workspace_policy_ref"
                        + " FROM managed_agent_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE")) {
            statement.setString(1, tenantId);
            statement.setString(2, sessionId);
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next()) {
                    return null;
                }
                if (!tenantId.equals(rows.getString("tenant_id")) || !sessionId.equals(rows.getString("session_id"))) {
                    throw unavailable();
                }
                String profile = rows.getString("tool_profile");
                if (!CsiFilesRetirementProfile.PROFILE.equals(profile)) {
                    return new Pin(profile, rows.getString("runtime_request_key"), null, sessionId);
                }
                if (!"qwen-code".equals(rows.getString("agent_id"))
                        || !CsiFilesRetirementProfile.CONFIG_REF.equals(rows.getString("workspace_config_ref"))
                        || !CsiFilesRetirementProfile.POLICY_REF.equals(rows.getString("workspace_policy_ref"))) {
                    throw unavailable();
                }
                ContextBinding context = new ContextBinding(tenantId, rows.getString("workspace_id"),
                        rows.getLong("workspace_generation"), rows.getString("workspace_storage_id"),
                        rows.getString("cwd_relative"), rows.getString("context_config_ref"),
                        rows.getLong("context_revision"));
                return new Pin(profile, rows.getString("runtime_request_key"), context, sessionId);
            }
        }
    }

    private static void requirePin(Pin pin, RuntimeProvisionRequest request) {
        if (pin == null || !CsiFilesRetirementProfile.PROFILE.equals(pin.profile())
                || !request.equals(CsiFilesRetirementProfile.request(pin.context(),
                        request.getScope().getCanonicalCwd(), pin.sessionId()))
                || !request.requestKey().equals(pin.requestKey())) {
            throw unavailable();
        }
    }

    private static RuntimeProvisionRequest request(ResultSet row) throws SQLException {
        return new RuntimeProvisionRequest(scope(row), row.getString("isolation_key"),
                row.getString("provisioner_kind"), row.getString("storage_id"));
    }

    private static RuntimeScope scope(ResultSet row) throws SQLException {
        return new RuntimeScope(row.getString("tenant_id"), row.getString("workspace_id"),
                row.getString("workspace_generation"), row.getString("canonical_cwd"),
                row.getString("capability_digest"), row.getString("isolation_class"));
    }

    private static PreparedStatement statement(Connection connection, String sql) throws SQLException {
        PreparedStatement statement = connection.prepareStatement(sql);
        statement.setQueryTimeout(10);
        return statement;
    }

    private static void requireTransaction(Connection connection) throws SQLException {
        if (connection == null || connection.getAutoCommit()) {
            throw new IllegalArgumentException("An active original transaction is required");
        }
    }

    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_original_binding_unavailable",
                "The original CSI Session binding is unavailable.", false);
    }

    private static RuntimeBrokerException closed() {
        return new RuntimeBrokerException(409, "runtime_admission_closed", "Session is draining or unstarted.", false);
    }

    private record Slot(RuntimeProvisionRequest request, String key, String activeBinding, long lastGeneration) {
    }

    private record Binding(Original original, String key, String scopeKey) {
    }

    private record Pin(String profile, String requestKey, ContextBinding context, String sessionId) {
    }
}
