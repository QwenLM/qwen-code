package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.JdbcRuntimeBrokerSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class JdbcCsiBindingControlTest {
    private static final String SESSION = "2815c6b8-468c-449a-869a-8794b0d52fca";
    private static final String ALIAS = "ec77f5fe1b4225e8f8203d59b5858eb235f9155261c440efaa02efd5513bd2df";
    private static final String PHYSICAL = "a".repeat(64);
    private static final String RESERVATION = "cfd417c7-f9dc-450d-b880-5667c7a5b029";
    private static final Duration LEASE = Duration.ofSeconds(30);

    // The decoy is load-bearing: every statement and catalog probe is recorded,
    // and none may name the other schema, so a re-introduced cross-schema read
    // reds this test even though the decoy row itself is never selected.
    @Test
    void ordinarySessionControlsIgnoreADecoySessionTableInAnotherSchema() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            sql(connection, "CREATE SCHEMA other");
            sql(connection, "CREATE TABLE other.ma_session (is_csi_guard BOOLEAN)");
        }
        var calls = new java.util.ArrayList<String>();
        var bindings = bindings(recording(source, calls));
        var request = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                "sha256:" + "b".repeat(64), "session"), SESSION, "test-supervisor", "storage");
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "owner", LEASE);
        assertNotNull(claimed);
        assertEquals(claimed.getVersion(), bindings.claimOperation(created.getBindingId(), "owner", LEASE).getVersion());
        assertNull(bindings.claimOperation(created.getBindingId(), "other", LEASE));
        var renewed = bindings.renewOperation(created.getBindingId(), "owner", claimed.getOperationGeneration(), LEASE);
        assertNotNull(renewed);
        var updated = bindings.compareAndSet(renewed, renewed.withLastHealthAt(Instant.now(), Instant.now()));
        assertNotNull(updated);
        assertNotNull(bindings.releaseOperation(created.getBindingId(), "owner", updated.getOperationGeneration()));
        assertEquals(List.of(), calls.stream().filter(call -> call.contains("other")).toList(), calls.toString());
    }

    @Test
    void provisioningControlsPreserveTheOriginalBootstrapWithoutAReservation() throws Exception {
        var fixture = fixture();
        try (var connection = fixture.source().getConnection()) {
            assertEquals(0, count(connection, "ma_tenant_guard"));
            assertEquals(0, count(connection, "ma_runtime_slot"));
            assertEquals(0, count(connection, "ma_runtime_binding"));
        }
        var created = fixture.bindings().findOrCreate(request());
        assertEquals(1, created.getGeneration());
        assertEquals(created.getBindingId(), fixture.bindings().findOrCreate(request()).getBindingId());
        var claimed = fixture.bindings().claimOperation(created.getBindingId(), "owner", LEASE);
        assertEquals(RuntimeBindingRecord.State.PROVISIONING, claimed.getState());
        assertNotNull(fixture.bindings().renewOperation(created.getBindingId(), "owner", claimed.getOperationGeneration(), LEASE));
        assertNotNull(fixture.bindings().releaseOperation(created.getBindingId(), "owner", claimed.getOperationGeneration()));
        assertNotNull(fixture.bindings().claimOperation(created.getBindingId(), "next", LEASE));
        try (var connection = fixture.source().getConnection()) {
            assertEquals(1, count(connection, "ma_tenant_guard"));
            assertEquals(1, count(connection, "ma_runtime_slot"));
            assertEquals(1, count(connection, "ma_runtime_binding"));
            assertEquals(0, count(connection, "ma_storage_owner"));
            assertEquals(0, count(connection, "ma_operation"));
        }
    }

    @Test
    void anUnprovisionedPrivateSessionCannotCreateARetentionRootWithoutItsFullPin() throws Exception {
        for (String mutation : List.of(
                        "DELETE FROM ma_session",
                        "UPDATE ma_session SET runtime_request_key = '" + "b".repeat(64) + "'",
                        "UPDATE ma_session SET workspace_generation = 2")) {
            var fixture = fixture();
            try (var connection = fixture.source().getConnection()) {
                sql(connection, mutation);
            }
            var failure = assertThrows(RuntimeBrokerException.class, () -> fixture.bindings().findOrCreate(request()));
            assertEquals("csi_original_binding_unavailable", failure.getCode());
            try (var connection = fixture.source().getConnection()) {
                assertEquals(0, count(connection, "ma_tenant_guard"));
                assertEquals(0, count(connection, "ma_runtime_slot"));
                assertEquals(0, count(connection, "ma_runtime_binding"));
            }
        }
    }

    @Test
    void firstPrivateProvisionCannotOverwriteAConflictingRetentionTenant() throws Exception {
        var fixture = fixture();
        try (var connection = fixture.source().getConnection()) {
            sql(connection,
                    "INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES ('"
                            + com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys
                                    .key("tenant")
                            + "', 'other', 'output_publication')");
        }
        var failure = assertThrows(RuntimeBrokerException.class, () -> fixture.bindings().findOrCreate(request()));
        assertEquals("csi_original_binding_unavailable", failure.getCode());
        try (var connection = fixture.source().getConnection(); var statement = connection.createStatement();
                var row = statement.executeQuery(
                                "SELECT tenant_id FROM ma_tenant_guard WHERE guard_domain ="
                                        + " 'output_publication'")) {
            row.next();
            assertEquals("other", row.getString(1));
            assertEquals(0, count(connection, "ma_runtime_slot"));
            assertEquals(0, count(connection, "ma_runtime_binding"));
        }
    }

    @Test
    void anOrdinarySessionInTheFullManagedSchemaDoesNotRequireAPrivateRetentionRoot() throws Exception {
        var fixture = fixture();
        var ordinary = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                "sha256:" + "b".repeat(64), "session"), UUID.randomUUID().toString(), "test-supervisor", "storage");
        var original = fixture.bindings().findOrCreate(ordinary);
        try (var connection = fixture.source().getConnection()) {
            sql(connection,
                    "DELETE FROM ma_tenant_guard WHERE guard_domain = 'output_publication'");
        }
        var claimed = fixture.bindings().claimOperation(original.getBindingId(), "owner", LEASE);
        assertNotNull(claimed);
        assertNotNull(fixture.bindings().renewOperation(original.getBindingId(), "owner", claimed.getOperationGeneration(), LEASE));
        assertNotNull(fixture.bindings().releaseOperation(original.getBindingId(), "owner", claimed.getOperationGeneration()));
    }

    @ParameterizedTest
    @ValueSource(strings = {"csi-files-retirement/1", "csi-files-retirement/2"})
    void aRetainedCurrentPinCannotBeSkippedWhenTheBindingCapabilityLooksGeneric(String profile) throws Exception {
        var fixture = fixture();
        var original = fixture.bindings().findOrCreate(request());
        var ordinary = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/workspace",
                "sha256:" + "b".repeat(64), "session"), SESSION, "kubernetes-workspace", "storage");
        try (var connection = fixture.source().getConnection()) {
            sql(connection,
                    "UPDATE ma_runtime_binding SET capability_digest = '"
                            + ordinary.getScope().getCapabilityDigest()
                    + "', request_key = '" + ordinary.requestKey() + "', scope_key = '"
                    + JdbcRepositorySupport.scopeKey(ordinary.getScope()) + "'");
            sql(connection,
                    "UPDATE ma_runtime_slot SET capability_digest = '"
                            + ordinary.getScope().getCapabilityDigest()
                    + "', request_key = '" + ordinary.requestKey() + "'");
            sql(connection,
                    "DELETE FROM ma_tenant_guard WHERE guard_domain = 'output_publication'");
            sql(connection, "UPDATE ma_session SET tool_profile = '" + profile + "', runtime_request_key = NULL");
            connection.setAutoCommit(false);
            assertThrows(RuntimeBrokerException.class,
                    () -> JdbcCsiFilesRetirementGuard.lockExecutionControl(connection, original.getBindingId()));
            connection.rollback();
        }
        assertEquals(ordinary, fixture.bindings().findById(original.getBindingId()).getRequest());
        assertThrows(RuntimeBrokerException.class,
                () -> fixture.bindings().claimOperation(original.getBindingId(), "owner", LEASE));
        assertEquals(original.getVersion(), fixture.bindings().findById(original.getBindingId()).getVersion());
    }

    @Test
    void aManagedSchemaWithAMissingRetentionRootCannotFallBackToBareControls() throws Exception {
        var fixture = fixture();
        var original = fixture.bindings().findOrCreate(request());
        try (var connection = fixture.source().getConnection()) {
            sql(connection,
                    "DELETE FROM ma_tenant_guard WHERE guard_domain = 'output_publication'");
        }
        for (Runnable control : List.<Runnable>of(
                () -> fixture.bindings().claimOperation(original.getBindingId(), "owner", LEASE),
                () -> fixture.bindings().renewOperation(original.getBindingId(), "owner", 1, LEASE),
                () -> fixture.bindings().releaseOperation(original.getBindingId(), "owner", 1),
                () -> fixture.bindings().compareAndSet(original, original.withLastHealthAt(Instant.now(), Instant.now())),
                () -> fixture.bindings().findOrCreate(request()))) {
            var failure = assertThrows(RuntimeBrokerException.class, control::run);
            assertEquals("csi_original_binding_unavailable", failure.getCode());
            assertEquals(original.getVersion(), fixture.bindings().findById(original.getBindingId()).getVersion());
            try (var connection = fixture.source().getConnection()) {
                assertEquals(0, count(connection, "ma_tenant_guard"));
                assertEquals(1, count(connection, "ma_runtime_slot"));
                assertEquals(1, count(connection, "ma_runtime_binding"));
            }
        }
    }

    @Test
    void anOldPrivateSlotCannotRecreateAMissingRetentionRootOrReplacementBinding() throws Exception {
        var fixture = fixture();
        fixture.bindings().findOrCreate(request());
        try (var connection = fixture.source().getConnection()) {
            sql(connection,
                    "DELETE FROM ma_tenant_guard WHERE guard_domain = 'output_publication'");
            sql(connection, "DELETE FROM ma_runtime_binding");
            sql(
                    connection,
                    "UPDATE ma_runtime_slot SET active_binding_id = NULL, last_generation = 0");
        }
        var failure = assertThrows(RuntimeBrokerException.class, () -> fixture.bindings().findOrCreate(request()));
        assertEquals("csi_original_binding_unavailable", failure.getCode());
        try (var connection = fixture.source().getConnection()) {
            assertEquals(0, count(connection, "ma_tenant_guard"));
            assertEquals(1, count(connection, "ma_runtime_slot"));
            assertEquals(0, count(connection, "ma_runtime_binding"));
        }
    }

    @Test
    void anyRetirementEvidenceRefusesOriginalControlsWithoutChangingTheBinding() throws Exception {
        var fixture = fixture();
        var created = fixture.bindings().findOrCreate(request());
        var claimed = fixture.bindings().claimOperation(created.getBindingId(), "owner", LEASE);
        try (var connection = fixture.source().getConnection(); var statement = connection.prepareStatement(
                                "INSERT INTO ma_operation (operation_key, scope_key, operation_id, operation_kind, tenant_id, target_kind, target_key, target_revision, request_digest, request_json, state, phase, gmt_create, gmt_modified) VALUES (?, ?, ?, 'CSI_RETIREMENT', 'tenant', 'RUNTIME_BINDING', ?, 1, 'digest', '{}', 'ADMITTED', 'ADMITTED', 0, 0)")) {
            String id = UUID.randomUUID().toString();
            statement.setString(
                    1,
                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                            "CSI_RETIREMENT", "tenant", id));
            statement.setString(2,
                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                            "tenant"));
            JdbcRepositorySupport.setIdentity(statement, 3, id);
            statement.setString(
                    4,
                    com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                            claimed.getBindingId()));
            statement.executeUpdate();
        }
        for (Runnable control : List.<Runnable>of(
                () -> fixture.bindings().claimOperation(claimed.getBindingId(), "owner", LEASE),
                () -> fixture.bindings().renewOperation(claimed.getBindingId(), "owner", claimed.getOperationGeneration(), LEASE),
                () -> fixture.bindings().releaseOperation(claimed.getBindingId(), "owner", claimed.getOperationGeneration()),
                () -> fixture.bindings().compareAndSet(claimed, claimed.withLastHealthAt(Instant.now(), Instant.now())))) {
            assertThrows(RuntimeBrokerException.class, control::run);
            assertEquals(claimed.getVersion(), fixture.bindings().findById(claimed.getBindingId()).getVersion());
        }
    }

    private static RuntimeProvisionRequest request() {
        return CsiFilesRetirementProfile.request(new ContextBinding("tenant", "workspace", 1, "storage", ".",
                CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", SESSION);
    }

    private static Fixture fixture() throws Exception {
        var source = source();
        try (var connection = source.getConnection()) {
            try (var statement = connection.prepareStatement(
                            "INSERT INTO ma_session (tenant_id, session_id, agent_id, tool_profile, runtime_request_key, workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref, gmt_create, gmt_modified) VALUES ('tenant', ?, 'qwen-code', ?, ?, 'workspace', 1, 'storage', '.', ?, 1, ?, ?, 0, 0)")) {
                JdbcRepositorySupport.setIdentity(statement, 1, SESSION);
                statement.setString(2, CsiFilesRetirementProfile.PROFILE);
                statement.setString(3, request().requestKey());
                JdbcRepositorySupport.setIdentity(
                        statement, 4, CsiFilesRetirementProfile.CONTEXT_CONFIG_REF);
                JdbcRepositorySupport.setIdentity(
                        statement, 5, CsiFilesRetirementProfile.CONFIG_REF);
                JdbcRepositorySupport.setIdentity(
                        statement, 6, CsiFilesRetirementProfile.POLICY_REF);
                statement.executeUpdate();
            }
        }
        return new Fixture(source, bindings(source), null);
    }

    private static JdbcDataSource source() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:binding-control-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(source);
        return source;
    }

    private static JdbcRuntimeBindingRepository bindings(javax.sql.DataSource source) {
        return new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
    }

    /** Records prepared SQL and catalog probes (schema-qualified) without changing either. */
    private static javax.sql.DataSource recording(javax.sql.DataSource source, List<String> calls) {
        return new org.springframework.jdbc.datasource.DelegatingDataSource(source) {
            @Override
            public Connection getConnection() throws java.sql.SQLException {
                return record(Connection.class, super.getConnection(), calls);
            }
        };
    }

    private static <T> T record(Class<T> type, T target, List<String> calls) {
        return type.cast(java.lang.reflect.Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type},
                (proxy, method, args) -> {
                    if (method.getName().equals("prepareStatement")) {
                        calls.add((String) args[0]);
                    } else if (method.getName().equals("getTables")) {
                        calls.add("getTables " + args[1] + "." + args[2]);
                    }
                    Object result;
                    try {
                        result = method.invoke(target, args);
                    } catch (java.lang.reflect.InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                    return method.getName().equals("getMetaData")
                            ? record(java.sql.DatabaseMetaData.class, (java.sql.DatabaseMetaData) result, calls)
                            : result;
                }));
    }

    private static int count(Connection connection, String table) throws Exception {
        try (var statement = connection.createStatement(); var row = statement.executeQuery("SELECT COUNT(*) FROM " + table
                                        + ("ma_tenant_guard".equals(table)
                                                ? " WHERE guard_domain = 'output_publication'"
                                                : ""))) {
            row.next();
            return row.getInt(1);
        }
    }

    private static void sql(Connection connection, String sql) throws Exception {
        try (var statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static final class Fixture {
        private final JdbcDataSource source;
        private final JdbcRuntimeBindingRepository bindings;
        private RuntimeBindingRecord binding;

        private Fixture(JdbcDataSource source, JdbcRuntimeBindingRepository bindings, RuntimeBindingRecord binding) {
            this.source = source;
            this.bindings = bindings;
            this.binding = binding;
        }

        JdbcDataSource source() { return source; }
        JdbcRuntimeBindingRepository bindings() { return bindings; }
        RuntimeBindingRecord binding() { return binding; }
    }
}
