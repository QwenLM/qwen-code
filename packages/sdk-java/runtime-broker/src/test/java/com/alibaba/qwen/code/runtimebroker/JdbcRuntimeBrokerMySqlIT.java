package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;

class JdbcRuntimeBrokerMySqlIT {
    @Test
    void repositoriesPreserveTheirContractsOnMySql() throws Exception {
        // The database outlives the run, so each run needs its own prefix.
        JdbcRepositoryContract.verify(dataSource(), "mysql-" + UUID.randomUUID());
    }

    @Test
    void managedRecoveryKeepsPinsUntilTheOriginalHolderCleanupCompletes() throws Exception {
        DataSource source = dataSource();
        JdbcRuntimeBrokerSchema.initialize(source);
        RuntimeMaintenanceRecoveryTest.verifyBatches(new JdbcRuntimeBindingRepository(source,
                new AesGcmSecretProtector("maintenance", new byte[32])), new JdbcRuntimeSessionRepository(source),
                new JdbcToolExecutionRepository(source), "mysql-maintenance-" + java.util.UUID.randomUUID());
    }

    @Test
    void databaseClockIgnoresSessionTimeZone() throws Exception {
        DataSource dataSource = dataSource();
        for (String offset : new String[] {"+00:00", "+08:00", "-04:00"}) {
            try (Connection connection = dataSource.getConnection();
                    PreparedStatement timeZone = connection.prepareStatement(
                            "SET time_zone = '" + offset + "'")) {
                timeZone.execute();
                JdbcRepositorySupportTest.assertStorageSafeClock(
                        JdbcRepositorySupport.databaseNow(connection));
            }
        }
    }

    @Test
    void closeFenceSharesPlacementLockWithLateBindingSessionAndExecutionAdmission() throws Exception {
        DataSource source = dataSource();
        JdbcRuntimeBrokerSchema.initialize(source);
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("close", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var executions = new JdbcToolExecutionRepository(source);
        var prefix = "mysql-close-" + UUID.randomUUID();
        var scope = new RuntimeScope(prefix, "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, "harness", "local-process", "storage");
        var ready = ready(bindings, request);
        var original = bindings.admitSession(sessions, session(ready, "original"));
        assertNotNull(sessions.compareAndSet(original,
                original.withState(RuntimeSessionRecord.State.READY, Instant.now())));
        var receipt = execution(ready, "existing");
        assertNotNull(bindings.admitExecution(sessions, executions, receipt));
        try (var lock = source.getConnection(); var pool = Executors.newFixedThreadPool(4)) {
            lock.setAutoCommit(false);
            JdbcRuntimeBindingRepository.lockPlacementDomain(lock, prefix);
            var started = new CountDownLatch(4);
            Future<Object> fence = pool.submit(waiter(started, () -> {
                bindings.requestHarnessDrain(prefix, "harness");
                return null;
            }));
            Future<Object> warm = pool.submit(waiter(started, () -> bindings.findOrCreate(request)));
            Future<Object> acquire = pool.submit(waiter(started, () -> bindings.admitSession(sessions, session(ready, "late"))));
            Future<Object> execute = pool.submit(waiter(started,
                    () -> bindings.admitExecution(sessions, executions, execution(ready, "late"))));
            assertTrue(started.await(5, TimeUnit.SECONDS));
            try {
                for (Future<Object> pending : List.of(fence, warm, acquire, execute)) {
                    assertThrows(TimeoutException.class, () -> pending.get(100, TimeUnit.MILLISECONDS));
                }
                try (var insert = lock.prepareStatement("INSERT INTO qwen_runtime_harness_drain"
                        + " (tenant_key, harness_key, tenant_id, harness_session_id) VALUES (?, ?, ?, ?)")) {
                    insert.setString(1, JdbcRepositorySupport.valueKey(prefix));
                    insert.setString(2, JdbcRepositorySupport.valueKey("harness"));
                    insert.setString(3, prefix);
                    insert.setString(4, "harness");
                    assertEquals(1, insert.executeUpdate());
                }
            } finally {
                lock.commit();
            }
            assertNull(fence.get(5, TimeUnit.SECONDS));
            for (Future<Object> admission : List.of(warm, acquire, execute)) {
                Object outcome = admission.get(5, TimeUnit.SECONDS);
                assertTrue(outcome instanceof RuntimeBrokerException);
                assertEquals("runtime_admission_closed", ((RuntimeBrokerException) outcome).getCode());
            }
        }
        var restored = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("close", new byte[32]));
        assertTrue(restored.isHarnessDraining(prefix, "harness"));
        assertFalse(restored.isHarnessDraining(prefix, "Harness"));
        assertThrows(RuntimeBrokerException.class, () -> restored.findOrCreate(request));
        assertThrows(RuntimeBrokerException.class, () -> restored.admitSession(sessions, session(ready, "after")));
        assertThrows(RuntimeBrokerException.class,
                () -> restored.admitExecution(sessions, executions, execution(ready, "after")));
        assertEquals(receipt.getExecutionCallId(), restored.admitExecution(sessions, executions, receipt).getExecutionCallId());
        assertEquals(List.of(ready.getBindingId()), restored.findByHarnessSession(prefix, "harness", null, 50)
                .stream().map(RuntimeBindingRecord::getBindingId).toList());
    }

    @Test
    void absentCloseFenceDoesNotBlockAnotherTenantsFence() throws Exception {
        String schema = "broker_close_" + UUID.randomUUID().toString().replace("-", "");
        DataSource admin = dataSource();
        try (var connection = admin.getConnection(); var statement = connection.createStatement()) {
            statement.execute("CREATE DATABASE " + schema);
        }
        try {
            DataSource source = new DriverManagerDataSource(
                    required("mysql.url").replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema),
                    required("mysql.user"), System.getProperty("mysql.password", ""));
            JdbcRuntimeBrokerSchema.initialize(source);
            var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("close", new byte[32]));
            var probe = JdbcRuntimeBindingRepository.class.getDeclaredMethod("hasHarnessDrain",
                    Connection.class, String.class, String.class);
            probe.setAccessible(true);
            try (var admission = source.getConnection(); var pool = Executors.newSingleThreadExecutor()) {
                admission.setAutoCommit(false);
                try {
                    JdbcRuntimeBindingRepository.lockPlacementDomain(admission, "tenant-a");
                    assertFalse((Boolean) probe.invoke(null, admission, "tenant-a", "harness"));
                    Future<?> fence = pool.submit(() -> bindings.requestHarnessDrain("tenant-b", "harness"));
                    fence.get(5, TimeUnit.SECONDS);
                    assertTrue(bindings.isHarnessDraining("tenant-b", "harness"));
                } finally {
                    admission.rollback();
                }
            }
        } finally {
            try (var connection = admin.getConnection(); var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS " + schema);
            }
        }
    }

    @Test
    void secondBrokerRejectsExpiredStopClaimAndRestoresTheOriginalReceipt() throws Exception {
        DataSource source = dataSource();
        JdbcRuntimeBrokerSchema.initialize(source);
        var first = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("close", new byte[32]));
        var second = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("close", new byte[32]));
        var tenant = "mysql-stop-" + UUID.randomUUID();
        var request = new RuntimeProvisionRequest(new RuntimeScope(tenant, "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session"), "harness", "local-process", "storage");
        var ready = ready(first, request);
        first.requestHarnessDrain(tenant, "harness");
        var claim = first.claimOperation(ready.getBindingId(), "first", Duration.ofSeconds(10));
        var draining = first.compareAndSet(claim,
                claim.withDrainRequested(true, Instant.now()).withState(RuntimeBindingRecord.State.DRAINING, claim.getLease(), Instant.now()));
        assertNotNull(draining);
        try (var connection = source.getConnection(); var update = connection.prepareStatement(
                "UPDATE qwen_runtime_binding SET operation_lease_until = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(6)) WHERE binding_id = ?")) {
            update.setString(1, ready.getBindingId());
            assertEquals(1, update.executeUpdate());
        }
        var receipt = new RuntimeDrainReceipt(draining.getBindingId(), draining.getGeneration(),
                draining.getProvisionSeed().getProvisionRequestId(), draining.getResourceHandle(), Instant.now());
        try (var connection = source.getConnection()) {
            assertTrue(first.findById(draining.getBindingId()).getOperationLeaseUntil()
                    .isBefore(JdbcRepositorySupport.databaseNowPrecise(connection)));
        }
        assertNull(first.renewOperation(draining.getBindingId(), "first", draining.getOperationGeneration(), Duration.ofSeconds(10)));
        assertNull(first.compareAndSet(draining, draining.withDrainReceipt(receipt)));
        var takeover = second.claimOperation(ready.getBindingId(), "second", Duration.ofSeconds(10));
        assertTrue(takeover.getOperationGeneration() > draining.getOperationGeneration());
        var persisted = second.compareAndSet(takeover, takeover.withDrainReceipt(receipt));
        assertNotNull(persisted);
        assertNotNull(second.compareAndSet(persisted,
                persisted.withState(RuntimeBindingRecord.State.RELEASED, persisted.getLease(), Instant.now())));
        var restored = first.findById(ready.getBindingId());
        assertEquals(RuntimeBindingRecord.State.RELEASED, restored.getState());
        assertTrue(restored.getDrainReceipt().matches(restored));
        assertNull(restored.getLossEvidence());
        assertEquals(ready.getGeneration(), restored.getGeneration());
        assertThrows(RuntimeBrokerException.class, () -> first.findOrCreate(request));
    }

    @Test
    void directedCloseEnumerationDoesNotMixCaseDistinctTenantsOrHarnessSessions() {
        DataSource source = dataSource();
        JdbcRuntimeBrokerSchema.initialize(source);
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("close-case", new byte[32]));
        var tenant = "mysql-case-" + UUID.randomUUID();
        var otherTenant = tenant.replace("mysql", "MySQL");
        var original = ready(bindings, new RuntimeProvisionRequest(new RuntimeScope(tenant, "workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session"), "harness", "local-process", "storage"));
        var differentTenant = ready(bindings, new RuntimeProvisionRequest(new RuntimeScope(otherTenant, "other-workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session"), "harness", "local-process", "storage"));
        var differentHarness = ready(bindings, new RuntimeProvisionRequest(new RuntimeScope(tenant, "third-workspace", "1", "/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session"), "Harness", "local-process", "storage"));
        assertEquals(List.of(original.getBindingId()), bindings.findByHarnessSession(tenant, "harness", null, 50)
                .stream().map(RuntimeBindingRecord::getBindingId).toList());
        assertEquals(List.of(differentTenant.getBindingId()), bindings.findByHarnessSession(otherTenant, "harness", null, 50)
                .stream().map(RuntimeBindingRecord::getBindingId).toList());
        assertEquals(List.of(differentHarness.getBindingId()), bindings.findByHarnessSession(tenant, "Harness", null, 50)
                .stream().map(RuntimeBindingRecord::getBindingId).toList());
        assertEquals(List.of(original.getBindingId()), bindings.findByHarnessSession(tenant, "harness", null, 1)
                .stream().map(RuntimeBindingRecord::getBindingId).toList());
        assertTrue(bindings.findByHarnessSession(tenant, "harness", original.getBindingId(), 1).isEmpty());
    }

    private static Callable<Object> waiter(CountDownLatch started, Callable<Object> operation) {
        return () -> {
            started.countDown();
            try {
                return operation.call();
            } catch (RuntimeBrokerException rejection) {
                return rejection;
            }
        };
    }

    private static RuntimeBindingRecord ready(RuntimeBindingRepository bindings, RuntimeProvisionRequest request) {
        var initial = bindings.findOrCreate(request);
        var claim = bindings.claimOperation(initial.getBindingId(), "setup", Duration.ofSeconds(10));
        var seed = claim.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9999"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var handle = new RuntimeResourceHandle("local-process", 2, Map.of("resource", initial.getBindingId()));
        var ready = bindings.compareAndSet(claim, claim.withAttestation(lease, handle, Instant.now(), Instant.now()));
        assertNotNull(ready);
        return bindings.releaseOperation(ready.getBindingId(), "setup", ready.getOperationGeneration());
    }

    private static RuntimeSessionRecord session(RuntimeBindingRecord binding, String id) {
        return new RuntimeSessionRecord(new RuntimeSession("harness", id, "bootstrap", binding.getRequest().getScope()),
                binding.getBindingId(), binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
    }

    private static ToolExecutionRecord execution(RuntimeBindingRecord binding, String id) {
        String key = binding.getBindingId() + "-" + id;
        return ToolExecutionRecord.prepared(key, key, binding.getBindingId(), binding.getGeneration(), "harness",
                "original", "prompt", "call", "digest", Map.of("sessionId", "original", "promptId", "prompt",
                        "callId", "call", "argsDigest", "digest"));
    }

    private static DataSource dataSource() {
        return new DriverManagerDataSource(required("mysql.url"),
                required("mysql.user"),
                System.getProperty("mysql.password", ""));
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
