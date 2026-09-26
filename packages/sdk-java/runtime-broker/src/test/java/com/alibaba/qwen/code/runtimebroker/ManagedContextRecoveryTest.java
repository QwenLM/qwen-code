package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class ManagedContextRecoveryTest {
    private static final RuntimeProvisionRequest REQUEST = ManagedContextProtocolTest.request();
    private static final RuntimeResourceHandle HANDLE = new RuntimeResourceHandle(
            "local-process", 1, Map.of("provider", "local-process"));
    private static final SecretProtector PROTECTOR = new AesGcmSecretProtector(
            "test-key", new byte[32]);

    @Test
    void deadlineStillCompletesWhenPersistingTheBlockFails() throws Exception {
        InMemoryRuntimeBindingRepository delegate = new InMemoryRuntimeBindingRepository();
        AtomicInteger blockWrites = new AtomicInteger();
        RuntimeBindingRepository bindings = (RuntimeBindingRepository) java.lang.reflect.Proxy
                .newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, args) -> {
                            if ("compareAndSet".equals(method.getName())
                                    && ((RuntimeBindingRecord) args[1]).getState()
                                            == RuntimeBindingRecord.State.RECOVERY_BLOCKED
                                    && blockWrites.getAndIncrement() == 0) {
                                throw new IllegalStateException("transient database failure");
                            }
                            try {
                                return method.invoke(delegate, args);
                            } catch (java.lang.reflect.InvocationTargetException failure) {
                                throw failure.getCause();
                            }
                        });
        FailingProvisioner provisioner = new FailingProvisioner(true);
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
            assertEquals("runtime_broker_provision_timeout",
                    ((RuntimeBrokerException) error.getCause()).getCode());
            assertEquals(1, blockWrites.get());
            org.junit.jupiter.api.Assertions.assertNull(delegate.findActive(REQUEST).getOperationOwner());
            assertBlocked(service);
            assertEquals(1, provisioner.launches.get());
        }
    }

    @Test
    void failedLaunchRemainsBlockedAcrossWarmAndDatabaseReconstruction() throws Exception {
        DataSource source = database();
        JdbcRuntimeBrokerSchema.initialize(source);
        FailingProvisioner provisioner = new FailingProvisioner(false);
        JdbcRuntimeBindingRepository first = repository(source);
        try (RuntimeBrokerService service = service(first, provisioner)) {
            assertThrows(ExecutionException.class,
                    () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
            for (int index = 0; index < 3; index++) {
                assertBlocked(service);
            }
        }
        JdbcRuntimeBindingRepository restored = repository(source);
        try (RuntimeBrokerService service = service(restored, provisioner)) {
            assertBlocked(service);
        }
        assertEquals(1, provisioner.launches.get());
        RuntimeBindingRecord blocked = restored.findActive(REQUEST);
        assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED, blocked.getState());
        assertEquals(1, blocked.getGeneration());
        assertEquals(REQUEST, blocked.getRequest());
        assertNotNull(blocked.getResourceHandle());
    }

    @Test
    void persistedMarkerBeforeSpawnBlocksTheFirstCallAfterRestart() throws Exception {
        DataSource source = database();
        JdbcRuntimeBrokerSchema.initialize(source);
        JdbcRuntimeBindingRepository first = repository(source);
        RuntimeBindingRecord initial = first.findOrCreate(REQUEST);
        RuntimeBindingRecord saved = first.claimOperation(initial.getBindingId(), "setup", Duration.ofMinutes(1));
        assertNotNull(first.compareAndSet(saved, saved.withResourceHandle(HANDLE, Instant.now())));
        first.releaseOperation(saved.getBindingId(), "setup", saved.getOperationGeneration());
        FailingProvisioner provisioner = new FailingProvisioner(false);
        try (RuntimeBrokerService service = service(repository(source), provisioner)) {
            assertBlocked(service);
            assertBlocked(service);
        }
        assertEquals(0, provisioner.launches.get());
    }

    @Test
    void timedOutLaunchIsBlockedAndLateCompletionCannotPublishReady() throws Exception {
        DataSource source = database();
        JdbcRuntimeBrokerSchema.initialize(source);
        FailingProvisioner provisioner = new FailingProvisioner(true);
        try (RuntimeBrokerService service = service(repository(source), provisioner)) {
            assertThrows(ExecutionException.class,
                    () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
            assertBlocked(service);
            RuntimeProvisionSeed seed = repository(source).findActive(REQUEST).getProvisionSeed();
            HttpServer worker = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            worker.createContext(ManagedContextProtocol.ATTEST_PATH, exchange -> {
                exchange.getRequestBody().readAllBytes();
                byte[] proof = JsonCodec.encode(ManagedContextProtocol.attestationResponse(
                        ManagedContextProtocol.boot(REQUEST, seed)));
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, proof.length);
                exchange.getResponseBody().write(proof);
                exchange.close();
            });
            worker.start();
            try {
                provisioner.pending.complete(new RuntimeLease(seed.getProvisionalRuntimeId(),
                        URI.create("http://127.0.0.1:" + worker.getAddress().getPort()),
                        seed.getToken(), seed.getLeaseId(), seed.getEpoch()));
                assertTrue(provisioner.released.await(5, TimeUnit.SECONDS));
                assertBlocked(service);
                assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                        repository(source).findActive(REQUEST).getState());
            } finally {
                worker.stop(0);
            }
        }
        assertEquals(1, provisioner.launches.get());
    }

    @Test
    void schemaUpgradePreservesLegacyAndRoundtripsManagedReadyIdentity() throws Exception {
        for (boolean flyway : new boolean[] {false, true}) {
            DataSource source = database();
            JdbcRuntimeBrokerSchema.initialize(source);
            RuntimeProvisionRequest legacy = new RuntimeProvisionRequest(
                    REQUEST.getScope(), null, REQUEST.getProvisionerKind());
            RuntimeBindingRecord old = repository(source).findOrCreate(legacy);
            try (Connection connection = source.getConnection(); var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE qwen_runtime_binding DROP COLUMN storage_id");
                statement.execute("ALTER TABLE qwen_runtime_binding_slot DROP COLUMN storage_id");
                if (flyway) {
                    String migration = Files.readString(Path.of("../managed-agent-server/src/main/resources/"
                            + "db/migration/V10__managed_runtime_context.sql"));
                    for (String sql : migration.split(";")) {
                        if (!sql.isBlank()) {
                            statement.execute(sql);
                        }
                    }
                }
            }
            JdbcRuntimeBrokerSchema.initialize(source);
            JdbcRuntimeBrokerSchema.initialize(source);
            assertEquals(old.getBindingId(), repository(source).findOrCreate(legacy).getBindingId());
            JdbcRuntimeBindingRepository repo = repository(source);
            RuntimeBindingRecord initial = repo.findOrCreate(REQUEST);
            RuntimeBindingRecord created = repo.claimOperation(initial.getBindingId(), "setup", Duration.ofMinutes(1));
            RuntimeProvisionSeed seed = created.getProvisionSeed();
            RuntimeLease lease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:12345"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            RuntimeBindingRecord ready = repo.compareAndSet(created,
                    created.withAttestation(lease, HANDLE, Instant.now(), Instant.now()));
            assertNotNull(ready);
            RuntimeBindingRecord restored = repository(source).findById(ready.getBindingId());
            assertEquals(REQUEST, restored.getRequest());
            assertEquals(RuntimeBindingRecord.State.READY, restored.getState());
            assertEquals(seed.getProvisionRequestId(), restored.getProvisionSeed().getProvisionRequestId());
            RuntimeProvisionRequest other = new RuntimeProvisionRequest(REQUEST.getScope(), null,
                    REQUEST.getProvisionerKind(), "other-storage");
            assertNotEquals(created.getBindingId(), repo.findOrCreate(other).getBindingId());
            try (Connection connection = source.getConnection(); var statement = connection.prepareStatement(
                    "UPDATE qwen_runtime_binding SET storage_id = ? WHERE binding_id = ?")) {
                statement.setString(1, "tampered-storage");
                statement.setString(2, ready.getBindingId());
                statement.executeUpdate();
            }
            assertThrows(IllegalStateException.class, () -> repository(source).findById(ready.getBindingId()));
        }
    }

    private static void assertBlocked(RuntimeBrokerService service) {
        ExecutionException failure = assertThrows(ExecutionException.class,
                () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
        assertTrue(failure.getCause() instanceof RuntimeBrokerException);
        assertEquals("runtime_broker_recovery_blocked", ((RuntimeBrokerException) failure.getCause()).getCode());
        assertFalse(((RuntimeBrokerException) failure.getCause()).isRetryable());
    }

    @Test
    void aRetryableFailedLaunchReportsTheBlock() throws Exception {
        InMemoryRuntimeBindingRepository bindings = new InMemoryRuntimeBindingRepository();
        FailingProvisioner provisioner = new FailingProvisioner(false);
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            assertBlocked(service);
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(REQUEST).getState());
        }
        assertEquals(1, provisioner.launches.get());
    }

    @Test
    void aDeadlineWhoseBlockLosesItsWriteStillAnswersTheTimeout() throws Exception {
        InMemoryRuntimeBindingRepository delegate = new InMemoryRuntimeBindingRepository();
        AtomicInteger blockWrites = new AtomicInteger();
        RuntimeBindingRepository bindings = (RuntimeBindingRepository) java.lang.reflect.Proxy
                .newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, args) -> {
                            if ("compareAndSet".equals(method.getName())
                                    && ((RuntimeBindingRecord) args[1]).getState()
                                            == RuntimeBindingRecord.State.RECOVERY_BLOCKED
                                    && blockWrites.getAndIncrement() == 0) {
                                return null;
                            }
                            return invoke(method, delegate, args);
                        });
        FailingProvisioner provisioner = new FailingProvisioner(true);
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
            assertEquals("runtime_broker_provision_timeout",
                    ((RuntimeBrokerException) error.getCause()).getCode());
            assertBlocked(service);
        }
        assertEquals(1, provisioner.launches.get());
    }

    @Test
    void theCallThatHitsTheDeadlineReportsTheBlock() throws Exception {
        InMemoryRuntimeBindingRepository bindings = new InMemoryRuntimeBindingRepository();
        FailingProvisioner provisioner = new FailingProvisioner(true);
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            assertBlocked(service);
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(REQUEST).getState());
            assertBlocked(service);
        }
        assertEquals(1, provisioner.launches.get());
    }

    @Test
    void unplaceableScopeIsATypedRefusal() throws Exception {
        try (RuntimeBrokerService service = service(new InMemoryRuntimeBindingRepository(),
                new LocalProcessRuntimeProvisioner(List.of("node"), Path.of("."),
                        new HttpRuntimeTransport(), scope -> null))) {
            ExecutionException failure = assertThrows(ExecutionException.class,
                    () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
            RuntimeBrokerException refusal = (RuntimeBrokerException) failure.getCause();
            assertEquals(400, refusal.getStatusCode());
            assertEquals("runtime_placement_invalid", refusal.getCode());
            assertFalse(refusal.isRetryable());
        }
    }

    @Test
    void schemaUpgradeToleratesAColumnAnotherInstanceAdded() throws Exception {
        DataSource source = database();
        JdbcRuntimeBrokerSchema.initialize(source);
        AtomicInteger stale = new AtomicInteger();
        // The first check sees the table as another instance left it just
        // before that instance added the column.
        DataSource racing = (DataSource) java.lang.reflect.Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[] {DataSource.class},
                (proxy, method, args) -> {
                    Object result = invoke(method, source, args);
                    return result instanceof Connection connection
                            ? staleConnection(connection, stale) : result;
                });
        JdbcRuntimeBrokerSchema.initialize(racing);
        // Checked stale, then again after its own ALTER failed.
        assertEquals(2, stale.get());
    }

    private static Connection staleConnection(Connection connection, AtomicInteger stale) {
        return (Connection) java.lang.reflect.Proxy.newProxyInstance(
                Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
                (proxy, method, args) -> {
                    Object result = invoke(method, connection, args);
                    return "createStatement".equals(method.getName())
                            ? staleStatement((java.sql.Statement) result, stale) : result;
                });
    }

    private static java.sql.Statement staleStatement(java.sql.Statement statement,
            AtomicInteger stale) {
        return (java.sql.Statement) java.lang.reflect.Proxy.newProxyInstance(
                java.sql.Statement.class.getClassLoader(),
                new Class<?>[] {java.sql.Statement.class}, (proxy, method, args) -> {
                    if ("executeQuery".equals(method.getName())
                            && ((String) args[0]).startsWith("SELECT * FROM qwen_runtime_binding_slot")
                            && stale.getAndIncrement() == 0) {
                        return statement.executeQuery(
                                "SELECT request_key FROM qwen_runtime_binding_slot WHERE 1 = 0");
                    }
                    return invoke(method, statement, args);
                });
    }

    private static Object invoke(java.lang.reflect.Method method, Object target, Object[] args)
            throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (java.lang.reflect.InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static RuntimeBrokerService service(RuntimeBindingRepository bindings,
            RuntimeProvisioner provisioner) {
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(REQUEST.getScope()),
                provisioner, new HttpRuntimeTransport(), bindings,
                new InMemoryRuntimeSessionRepository(), new InMemoryToolExecutionRepository(),
                UUID.randomUUID().toString(), Duration.ofSeconds(1), Duration.ofSeconds(1));
    }

    private static JdbcRuntimeBindingRepository repository(DataSource source) {
        return new JdbcRuntimeBindingRepository(source, PROTECTOR);
    }

    private static DataSource database() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:managed-context-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return source;
    }

    private static final class FailingProvisioner implements RuntimeProvisioner {
        private final AtomicInteger launches = new AtomicInteger();
        private final CompletableFuture<RuntimeLease> pending = new CompletableFuture<>();
        private final java.util.concurrent.CountDownLatch released =
                new java.util.concurrent.CountDownLatch(1);
        private final boolean hang;

        private FailingProvisioner(boolean hang) {
            this.hang = hang;
        }

        @Override
        public String kind() {
            return "local-process";
        }

        @Override
        public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
            return REQUEST;
        }

        @Override
        public CompletionStage<RuntimeResourceHandle> ensureResource(RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed, RuntimeResourceHandle knownHandle) {
            return CompletableFuture.completedFuture(HANDLE);
        }

        @Override
        public CompletionStage<Void> release(RuntimeProvisionRequest request, RuntimeLease lease) {
            released.countDown();
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            launches.incrementAndGet();
            return hang ? pending : CompletableFuture.failedFuture(new RuntimeBrokerException(
                    503, "runtime_provision_failed", "ambiguous launch", true));
        }
    }
}
