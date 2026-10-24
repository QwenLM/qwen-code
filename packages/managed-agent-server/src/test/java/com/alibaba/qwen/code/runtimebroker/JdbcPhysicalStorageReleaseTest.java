package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;

import javax.sql.DataSource;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JdbcPhysicalStorageReleaseTest {
    @Test
    void aliasesReleaseOnlyTheirMatchingExecutionMember() throws Exception {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:physical-release-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        verify(source);
    }

    static void verify(DataSource source) throws Exception {
        ManagedSchema.initialize(source);
        verifyCleanupOrdering(source, false, false);
        verifyCleanupOrdering(source, false, true);
        verifyCleanupOrdering(source, true, false);
        for (boolean ssh : new boolean[] {false, true}) {
            Fixture shared = new Fixture(source, ssh);
            shared.sessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "neighbor", "bootstrap",
                    shared.binding.getRequest().getScope()), shared.binding.getBindingId(), shared.binding.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
            shared.execute("UPDATE ma_runtime_session SET execution_storage_key = ? WHERE binding_id = ?", shared.physical,
                    shared.binding.getBindingId().getBytes(StandardCharsets.UTF_8));
            assertEquals(RuntimeSessionRecord.State.RELEASED, shared.release().getState());
            assertNull(shared.text("SELECT execution_storage_key FROM ma_runtime_session WHERE binding_id = ? AND runtime_session_id = X'6f726967696e616c'",
                    shared.binding.getBindingId().getBytes(StandardCharsets.UTF_8)));
            assertEquals(shared.physical, shared.text("SELECT execution_storage_key FROM ma_runtime_session WHERE binding_id = ? AND runtime_session_id = X'6e65696768626f72'",
                    shared.binding.getBindingId().getBytes(StandardCharsets.UTF_8)));
        }
        Fixture matched = new Fixture(source);
        assertEquals(RuntimeSessionRecord.State.RELEASED, matched.release().getState());
        assertNull(matched.member());
        assertEquals(
                2L,
                matched.scalar(
                        "SELECT COUNT(*) FROM ma_storage WHERE physical_key=?", matched.physical));

        Fixture frozen = new Fixture(source);
        frozen.execute(
                "UPDATE ma_storage_owner SET mount_state='FENCED' WHERE storage_key=?",
                frozen.physical);
        assertEquals(
                "workspace_migrating",
                assertThrows(
                                RuntimeBrokerException.class,
                                () -> frozen.bindings.findOrCreate(frozen.binding.getRequest()))
                        .getCode());
        assertEquals(
                "workspace_migrating",
                assertThrows(
                                RuntimeBrokerException.class,
                                () ->
                                        frozen.bindings.admitSession(
                                                frozen.sessions,
                                                new RuntimeSessionRecord(
                                                        new RuntimeSession(
                                                                "harness",
                                                                "late",
                                                                "bootstrap",
                                                                frozen.binding
                                                                        .getRequest()
                                                                        .getScope()),
                                                        frozen.binding.getBindingId(),
                                                        frozen.binding.getGeneration(),
                                                        RuntimeSessionRecord.State.ACQUIRING,
                                                        0,
                                                        Instant.now())))
                        .getCode());
        assertEquals(
                JdbcRuntimeBindingRepository.storageAliasKey(frozen.tenant, "second"),
                frozen.text(
                        "SELECT storage_alias_key FROM ma_runtime_binding WHERE binding_id=?",
                        frozen.binding.getBindingId().getBytes(StandardCharsets.UTF_8)));

        Fixture mismatched = new Fixture(source);
        mismatched.execute("UPDATE ma_runtime_session SET execution_storage_key = ? WHERE binding_id = ?",
                "f".repeat(64), mismatched.binding.getBindingId().getBytes(StandardCharsets.UTF_8));
        assertEquals(
                "workspace_close_identity_unverified",
                assertThrows(RuntimeBrokerException.class, mismatched::release).getCode());
        assertEquals("f".repeat(64), mismatched.member());
        mismatched.unreleased();

        Fixture missing = new Fixture(source);
        missing.execute("DELETE FROM ma_storage_owner WHERE storage_key=?", missing.physical);
        assertThrows(RuntimeBrokerException.class, missing::release);
        missing.unreleased();

        Fixture wrongScope = new Fixture(source);
        wrongScope.execute(
                "UPDATE ma_storage SET tenant_id=? WHERE alias_key=?",
                "other-tenant".getBytes(StandardCharsets.UTF_8),
                JdbcRuntimeBindingRepository.storageAliasKey(wrongScope.tenant, "second"));
        assertThrows(RuntimeBrokerException.class, wrongScope::release);
        assertEquals(wrongScope.physical, wrongScope.member());
        wrongScope.unreleased();
    }

    private static void verifyCleanupOrdering(DataSource source, boolean ssh, boolean lost) throws Exception {
        var observing = new CleanupDataSource(source);
        var fixture = new Fixture(observing, ssh);
        RuntimeBindingRecord cleanup = fixture.binding;
        if (lost) {
            var seed = cleanup.getProvisionSeed();
            var loss = new RuntimeRecoveryEvidence("lost", RuntimeRecoveryEvidence.Fact.JOURNAL_LOST,
                    "test-reboot", Instant.now(), "original-boot", seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(),
                    seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(), cleanup.getResourceHandle());
            var stop = new RuntimeRecoveryEvidence("stopped", RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED,
                    "test-reboot", Instant.now(), "original-boot", seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(),
                    seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(), cleanup.getResourceHandle());
            cleanup = fixture.bindings.compareAndSet(cleanup, cleanup.withRecoveryEvidence(loss, stop, Instant.now()));
            assertNotNull(cleanup);
        }
        var original = cleanup;
        try (var pool = Executors.newSingleThreadExecutor(); var holder = source.getConnection()) {
            holder.setAutoCommit(false);
            try (var lock = holder.prepareStatement("SELECT storage_key FROM ma_storage_owner WHERE storage_key = ? FOR UPDATE")) {
                lock.setString(1, fixture.physical);
                try (var rows = lock.executeQuery()) {
                    assertTrue(rows.next());
                }
            }
            observing.armed = true;
            var pending = pool.submit(() -> {
                if (lost) {
                    new WorkspaceExecutionStore(new ManagedSchemaJdbcTemplate(observing),
                            new DataSourceTransactionManager(observing)).releaseLost(original);
                } else {
                    fixture.release();
                }
            });
            assertTrue(observing.ownerRequested.await(5, TimeUnit.SECONDS));
            // Another tenant holding this physical owner must still be able to scan its members.
            try (var scan = holder.prepareStatement("SELECT execution_storage_key FROM ma_runtime_session WHERE binding_id = ?"
                    + " AND runtime_generation = ? AND runtime_session_id = ? FOR UPDATE NOWAIT")) {
                scan.setBytes(1, original.getBindingId().getBytes(StandardCharsets.UTF_8));
                scan.setLong(2, original.getGeneration());
                scan.setBytes(3, fixture.session.getRuntimeSessionId().getBytes(StandardCharsets.UTF_8));
                try (var rows = scan.executeQuery()) {
                    assertTrue(rows.next());
                    assertEquals(fixture.physical, rows.getString(1));
                }
            }
            assertFalse(pending.isDone());
            holder.commit();
            pending.get(5, TimeUnit.SECONDS);
        }
        assertNull(fixture.text("SELECT execution_storage_key FROM ma_runtime_session WHERE binding_id = ?",
                original.getBindingId().getBytes(StandardCharsets.UTF_8)));
    }

    private static final class CleanupDataSource extends DelegatingDataSource {
        private final CountDownLatch ownerRequested = new CountDownLatch(1);
        private volatile boolean armed;

        CleanupDataSource(DataSource source) {
            super(source);
        }

        @Override
        public Connection getConnection() throws SQLException {
            var actual = super.getConnection();
            return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                    (proxy, method, arguments) -> {
                        try {
                            Object result = method.invoke(actual, arguments);
                            if (result instanceof PreparedStatement statement && arguments[0] instanceof String sql
                                    && sql.contains("FROM ma_storage_owner") && sql.contains("storage_key = ?") && sql.contains("FOR UPDATE")) {
                                return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {PreparedStatement.class},
                                        (unused, operation, values) -> {
                                            if (armed && operation.getName().equals("executeQuery")) {
                                                ownerRequested.countDown();
                                            }
                                            try {
                                                return operation.invoke(statement, values);
                                            } catch (InvocationTargetException failure) {
                                                throw failure.getCause();
                                            }
                                        });
                            }
                            return result;
                        } catch (InvocationTargetException failure) {
                            throw failure.getCause();
                        }
                    });
        }
    }

    private static final class Fixture {
        private final DataSource source;
        private final String tenant = "release-" + UUID.randomUUID();
        private final String physical = ManagedSchemaKeys.key("local-volume", tenant);
        private final JdbcRuntimeBindingRepository bindings;
        private final JdbcRuntimeSessionRepository sessions;
        private final JdbcToolExecutionRepository executions;
        private final RuntimeBindingRecord binding;
        private final RuntimeSessionRecord session;
        private final String storageKind;

        Fixture(DataSource source) throws Exception {
            this(source, false);
        }

        Fixture(DataSource source, boolean ssh) throws Exception {
            this.source = source;
            storageKind = ssh ? "SSH_LOCAL" : "LOCAL";
            bindings =
                    new JdbcRuntimeBindingRepository(
                            source, new AesGcmSecretProtector("release", new byte[32]));
            sessions = new JdbcRuntimeSessionRepository(source);
            executions = new JdbcToolExecutionRepository(source);
            alias(tenant + "-first", "first");
            alias(tenant, "second");
            execute(
                    "INSERT INTO"
                        + " ma_storage_owner(storage_key,physical_key,storage_kind,tenant_id,storage_id,mount_state)"
                        + " VALUES(?,?,?,?,?,'READY')",
                    physical,
                    physical,
                    storageKind,
                    (tenant + "-first").getBytes(StandardCharsets.UTF_8),
                    "first".getBytes(StandardCharsets.UTF_8));
            var scope =
                    new RuntimeScope(
                            tenant,
                            "workspace",
                            "1",
                            "/workspace",
                            WorkspaceExecutionProfile.CAPABILITY_DIGEST,
                            "session");
            var initial =
                    bindings.findOrCreate(
                            new RuntimeProvisionRequest(
                                    scope, "harness", ssh ? "ssh-process" : "local-process", "second"));
            var claim =
                    bindings.claimOperation(initial.getBindingId(), "setup", Duration.ofMinutes(1));
            var seed = claim.getProvisionSeed();
            var lease =
                    new RuntimeLease(
                            seed.getProvisionalRuntimeId(),
                            URI.create("http://127.0.0.1:9999"),
                            seed.getToken(),
                            seed.getLeaseId(),
                            seed.getEpoch());
            var ready =
                    bindings.compareAndSet(
                            claim,
                            claim.withAttestation(
                                    lease,
                                    new RuntimeResourceHandle(
                                            ssh ? "ssh-process" : "local-process",
                                            ssh ? 1 : 2,
                                            Map.of("resource", initial.getBindingId())),
                                    Instant.now(),
                                    Instant.now()));
            ready =
                    bindings.releaseOperation(
                            ready.getBindingId(), "setup", ready.getOperationGeneration());
            var acquired =
                    bindings.admitSession(
                            sessions,
                            new RuntimeSessionRecord(
                                    new RuntimeSession("harness", "original", "bootstrap", scope),
                                    ready.getBindingId(),
                                    ready.getGeneration(),
                                    RuntimeSessionRecord.State.ACQUIRING,
                                    0,
                                    Instant.now()));
            var active =
                    sessions.compareAndSet(
                            acquired,
                            acquired.withState(RuntimeSessionRecord.State.READY, Instant.now()));
            session =
                    sessions.compareAndSet(
                            active,
                            active.withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
            claim = bindings.claimOperation(ready.getBindingId(), "stop", Duration.ofMinutes(1));
            var draining =
                    bindings.compareAndSet(
                            claim,
                            claim.withDrainRequested(true, Instant.now())
                                    .withState(
                                            RuntimeBindingRecord.State.DRAINING,
                                            claim.getLease(),
                                            Instant.now()));
            binding =
                    bindings.compareAndSet(
                            draining,
                            draining.withDrainReceipt(
                                    new RuntimeDrainReceipt(
                                            draining.getBindingId(),
                                            draining.getGeneration(),
                                            draining.getProvisionSeed().getProvisionRequestId(),
                                            draining.getResourceHandle(),
                                            Instant.now())));
            execute("UPDATE ma_runtime_session SET execution_storage_key = ? WHERE binding_id = ?",
                    physical, binding.getBindingId().getBytes(StandardCharsets.UTF_8));
        }

        private String text(String sql, Object parameter) throws Exception {
            try (var connection = source.getConnection();
                    var statement = connection.prepareStatement(sql)) {
                statement.setObject(1, parameter);
                try (var rows = statement.executeQuery()) {
                    if (!rows.next()) {
                        throw new IllegalStateException("Missing fixture row");
                    }
                    return rows.getString(1);
                }
            }
        }

        private void alias(String aliasTenant, String storage) throws Exception {
            execute(
                    "INSERT INTO"
                        + " ma_storage(alias_key,tenant_key,storage_key,tenant_id,storage_id,physical_key,registration_state,storage_kind,registration_revision,registration_json)"
                        + " VALUES(?,?,?,?,?,?,'REGISTERED',?,1,'{}')",
                    JdbcRuntimeBindingRepository.storageAliasKey(aliasTenant, storage),
                    JdbcRuntimeBindingRepository.storageFenceKey(aliasTenant),
                    JdbcRuntimeBindingRepository.storageFenceKey(storage),
                    aliasTenant.getBytes(StandardCharsets.UTF_8),
                    storage.getBytes(StandardCharsets.UTF_8),
                    physical, storageKind);
        }

        private RuntimeSessionRecord release() {
            return bindings.completeStoppedSessionRelease(sessions, executions, session, binding);
        }

        private String member() throws Exception {
            return text("SELECT execution_storage_key FROM ma_runtime_session WHERE binding_id = ?"
                    + " AND runtime_session_id = X'6f726967696e616c'", binding.getBindingId().getBytes(StandardCharsets.UTF_8));
        }

        private void unreleased() {
            assertEquals(
                    RuntimeSessionRecord.State.RELEASING,
                    sessions.findById(binding.getRequest().getScope(), "original").getState());
        }

        private long scalar(String sql, String key) throws Exception {
            try (var connection = source.getConnection();
                    var statement = connection.prepareStatement(sql)) {
                statement.setString(1, key);
                try (var row = statement.executeQuery()) {
                    assertEquals(true, row.next());
                    return row.getLong(1);
                }
            }
        }

        private void execute(String sql, Object... arguments) throws Exception {
            try (var connection = source.getConnection();
                    var statement = connection.prepareStatement(sql)) {
                for (int index = 0; index < arguments.length; index++) {
                    statement.setObject(index + 1, arguments[index]);
                }
                statement.executeUpdate();
            }
        }
    }
}
