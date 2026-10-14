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
            long generation, RuntimeBindingRecord.State state, boolean draining,
            long version, Long firstActivationJournalRevision) {
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

    static Original readHistoricalBinding(Connection connection, RuntimeBindingRecord binding) throws SQLException {
        if (connection == null || connection.getAutoCommit() || !connection.isReadOnly()
                || connection.getTransactionIsolation() != Connection.TRANSACTION_REPEATABLE_READ
                || binding == null || !isProfile(binding.getRequest().getScope())) {
            throw unavailable();
        }
        try (var statement = statement(connection, "SELECT * FROM ma_runtime_binding WHERE binding_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, binding.getBindingId());
            try (var row = statement.executeQuery()) {
                if (!row.next()) {
                    throw unavailable();
                }
                var original = new Original(request(row), row.getString("binding_id"), row.getLong("runtime_generation"),
                        RuntimeBindingRecord.State.valueOf(row.getString("binding_state")), row.getBoolean("drain_requested"),
                        row.getLong("record_version"), row.getObject("first_activation_journal_revision", Long.class));
                if (!binding.getBindingId().equals(original.bindingId()) || !binding.getRequest().equals(original.request())
                        || binding.getGeneration() != original.generation() || binding.getState() != original.state()
                        || binding.isDrainRequested() != original.draining() || binding.getVersion() != original.version()
                        || original.generation() != 1 || !original.draining() || original.version() <= 0
                        || original.state() != RuntimeBindingRecord.State.DRAINING && original.state() != RuntimeBindingRecord.State.RELEASED
                        || !java.util.Objects.equals(original.firstActivationJournalRevision(), 2L)
                        || !original.request().requestKey().equals(row.getString("request_key"))
                        || !JdbcRepositorySupport.scopeKey(original.request().getScope()).equals(row.getString("scope_key"))
                        || row.next()) {
                    throw unavailable();
                }
                return original;
            }
        }
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
        boolean retained = lockRetentionRoot(connection, tenant);
        if (!retained) {
            initializeRetentionRoot(connection, tenant);
        }
        List<Slot> slots = lockSlots(connection, tenant, session);
        List<Binding> bindings = lockBindings(connection, tenant, session, slots);
        requirePin(readPin(connection, tenant, session), request);
        if (!retained && (!slots.isEmpty() || !bindings.isEmpty())) {
            throw unavailable();
        }
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

    public static Original lockBindingControl(Connection connection, String bindingId) throws SQLException {
        requireTransaction(connection);
        String tenant;
        String session;
        boolean profile;
        try (PreparedStatement statement = statement(connection,
                "SELECT tenant_id, isolation_key, isolation_class, capability_digest"
                        + " FROM ma_runtime_binding WHERE binding_id = ?")) {
            JdbcRepositorySupport.setIdentity(statement, 1, bindingId);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) {
                    return null;
                }
                profile = CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(row.getString("capability_digest"));
                if (!profile && !"session".equals(row.getString("isolation_class"))) {
                    return null;
                }
                tenant = row.getString("tenant_id");
                session = row.getString("isolation_key");
                if (tenant == null || session == null || row.next()) {
                    throw unavailable();
                }
            }
        }
        if (!hasTable(connection, "ma_session")) {
            throw unavailable();
        }
        JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant, 10);
        boolean retained = lockRetentionRoot(connection, tenant);
        Original original = lockManagedSession(connection, tenant, session);
        if (original == null ? profile : !retained || !bindingId.equals(original.bindingId())) {
            throw unavailable();
        }
        return original;
    }

    private static boolean hasTable(Connection connection, String name) throws SQLException {
        var metadata = connection.getMetaData();
        String tableName = metadata.storesUpperCaseIdentifiers() ? name.toUpperCase(java.util.Locale.ROOT) : name;
        String catalog = connection.getCatalog();
        String schema = connection.getSchema();
        try (ResultSet tables = metadata.getTables(catalog, schema,
                tableName, new String[] {"TABLE"})) {
            while (tables.next()) {
                if (tableName.equals(tables.getString("TABLE_NAME"))
                        && java.util.Objects.equals(catalog, tables.getString("TABLE_CAT"))
                        && java.util.Objects.equals(schema, tables.getString("TABLE_SCHEM"))) {
                    return true;
                }
            }
            return false;
        }
    }

    private static boolean lockRetentionRoot(Connection connection, String tenantId) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "SELECT tenant_id FROM ma_tenant_guard WHERE tenant_key = ? AND guard_domain = 'output_publication' FOR UPDATE")) {
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(tenantId));
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) {
                    return false;
                }
                if (!tenantId.equals(row.getString("tenant_id")) || row.next()) {
                    throw unavailable();
                }
                return true;
            }
        }
    }

    private static void initializeRetentionRoot(Connection connection, String tenantId) throws SQLException {
        try (PreparedStatement statement = statement(connection,
                "INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES (?, ?, 'output_publication')"
                        + " ON DUPLICATE KEY UPDATE tenant_key = tenant_key")) {
            statement.setString(1, com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(tenantId));
            JdbcRepositorySupport.setIdentity(statement, 2, tenantId);
            statement.executeUpdate();
        }
        if (!lockRetentionRoot(connection, tenantId)) {
            throw unavailable();
        }
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
                "SELECT * FROM ma_runtime_slot WHERE tenant_id = ? AND isolation_key = ?"
                        + " ORDER BY request_key FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, sessionId);
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
        StringBuilder sql = new StringBuilder("SELECT * FROM ma_runtime_binding"
                + " WHERE (tenant_id = ? AND isolation_key = ?)");
        List<Object> references = new ArrayList<>();
        for (Slot slot : slots) {
            sql.append(" OR request_key = ?");
            references.add(slot.key());
            if (slot.activeBinding() != null) {
                sql.append(" OR binding_id = ?");
                references.add(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.identity(slot.activeBinding()));
            }
        }
        sql.append(" ORDER BY request_key, binding_id FOR UPDATE");
        try (PreparedStatement statement = statement(connection, sql.toString())) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, sessionId);
            for (int index = 0; index < references.size(); index++) {
                Object value = references.get(index);
                if (value instanceof byte[] bytes) {
                    statement.setBytes(index + 3, bytes);
                } else {
                    statement.setString(index + 3, (String) value);
                }
            }
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    Original original = new Original(request(rows), rows.getString("binding_id"),
                            rows.getLong("runtime_generation"),
                            RuntimeBindingRecord.State.valueOf(rows.getString("binding_state")),
                            rows.getBoolean("drain_requested"), rows.getLong("record_version"),
                            rows.getObject("first_activation_journal_revision", Long.class));
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

    public static void requireReadCompletion(Connection connection, Original original) throws SQLException {
        requireTransaction(connection);
        original.requireContinuation();
        JdbcCsiRetirementSeal.lock(connection, original);
    }

    public static void requireSingleSession(Connection connection, Original original) throws SQLException {
        requireTransaction(connection);
        try (PreparedStatement statement = statement(connection,
                "SELECT * FROM ma_runtime_session WHERE binding_id = ?"
                        + " OR (tenant_id = ? AND harness_session_id = ?)"
                        + " ORDER BY scope_key, runtime_session_id LIMIT 2 FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, original.bindingId());
            JdbcRepositorySupport.setIdentity(statement, 2, original.request().getScope().getTenantId());
            JdbcRepositorySupport.setIdentity(statement, 3, original.request().getIsolationKey());
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
        String product = connection.getMetaData().getDatabaseProductName();
        String index = "MySQL".equals(product) || "MariaDB".equals(product)
                ? " FORCE INDEX (ix_ma_session_csi_guard)" : "";
        try (PreparedStatement statement = statement(connection,
                "SELECT csi_guard FROM ma_session" + index
                        + " WHERE tenant_id = ? AND session_id = ? AND csi_guard = TRUE FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, sessionId);
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next()) {
                    return null;
                }
            }
        }
        try (PreparedStatement statement = statement(connection,
                "SELECT tenant_id, session_id, agent_id, tool_profile, runtime_request_key, workspace_id,"
                        + " workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref, workspace_policy_ref"
                        + " FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE")) {
            JdbcRepositorySupport.setIdentity(statement, 1, tenantId);
            JdbcRepositorySupport.setIdentity(statement, 2, sessionId);
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
