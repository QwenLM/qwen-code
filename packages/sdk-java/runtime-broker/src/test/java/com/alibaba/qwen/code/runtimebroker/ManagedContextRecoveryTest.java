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
            RuntimeBrokerException timeout = (RuntimeBrokerException) error.getCause();
            assertEquals("runtime_broker_provision_timeout", timeout.getCode());
            // The failed block write rides on the answer.
            assertEquals(List.of("transient database failure"), messages(timeout.getSuppressed()));
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
    void unadmittedManagedStartupDoesNotBlockAnotherWorkspaceSession() {
        RuntimeScope base = REQUEST.getScope();
        RuntimeScope scope = new RuntimeScope(base.getTenantId(), base.getWorkspaceId(),
                base.getWorkspaceGeneration(), base.getCanonicalCwd(),
                base.getCapabilityDigest(), "session");
        RuntimeProvisionRequest first = new RuntimeProvisionRequest(scope, "harness-1",
                "local-process", REQUEST.getStorageId());
        RuntimeProvisionRequest second = new RuntimeProvisionRequest(scope, "harness-2",
                "local-process", REQUEST.getStorageId());
        RuntimeProvisionRequest third = new RuntimeProvisionRequest(scope, "harness-3",
                "local-process", REQUEST.getStorageId());
        RuntimeProvisionRequest fourth = new RuntimeProvisionRequest(scope, "harness-4",
                "local-process", REQUEST.getStorageId());
        RuntimeScope customScope = new RuntimeScope("tenant-b", base.getWorkspaceId(),
                base.getWorkspaceGeneration(), base.getCanonicalCwd(),
                base.getCapabilityDigest(), "session");
        RuntimeProvisionRequest customFirst = new RuntimeProvisionRequest(customScope,
                "harness-1", "custom", REQUEST.getStorageId());
        RuntimeProvisionRequest customSecond = new RuntimeProvisionRequest(customScope,
                "harness-2", "custom", REQUEST.getStorageId());
        DataSource source = database();
        JdbcRuntimeBrokerSchema.initialize(source);
        for (RuntimeBindingRepository bindings : List.of(
                new InMemoryRuntimeBindingRepository(), repository(source))) {
            RuntimeBindingRecord initial = bindings.findOrCreate(first);
            RuntimeBindingRecord claimed = bindings.claimOperation(initial.getBindingId(),
                    "owner", Duration.ofMinutes(1));
            RuntimeBindingRecord handle = bindings.compareAndSet(claimed,
                    claimed.withResourceHandle(HANDLE, Instant.now()));
            RuntimeBindingRecord blocked = bindings.compareAndSet(handle,
                    handle.withState(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                            null, Instant.now()));

            assertEquals(blocked.getBindingId(), bindings.findOrCreate(first).getBindingId());
            RuntimeBindingRecord next = bindings.findOrCreate(second);
            assertNotEquals(blocked.getBindingId(), next.getBindingId());

            RuntimeBindingRecord nextClaim = bindings.claimOperation(next.getBindingId(),
                    "owner", Duration.ofMinutes(1));
            RuntimeProvisionSeed seed = nextClaim.getProvisionSeed();
            RuntimeLease lease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:12345"), seed.getToken(),
                    seed.getLeaseId(), seed.getEpoch());
            RuntimeBindingRecord ready = bindings.compareAndSet(nextClaim,
                    nextClaim.withAttestation(lease, HANDLE, Instant.now(), Instant.now()));
            RuntimeBindingRecord blockedReady = bindings.compareAndSet(ready, ready.withState(
                    RuntimeBindingRecord.State.RECOVERY_BLOCKED, lease, Instant.now()));
            RuntimeBrokerException refusal = assertThrows(RuntimeBrokerException.class,
                    () -> bindings.findOrCreate(third));
            assertEquals("runtime_placement_recovery_required", refusal.getCode());
            bindings.compareAndSet(blockedReady, blockedReady.withState(
                    RuntimeBindingRecord.State.RECOVERY_BLOCKED, null, Instant.now()));
            RuntimeBrokerException missingLease = assertThrows(RuntimeBrokerException.class,
                    () -> bindings.findOrCreate(fourth));
            assertEquals("runtime_placement_recovery_required", missingLease.getCode());

            RuntimeBindingRecord custom = bindings.findOrCreate(customFirst);
            RuntimeBindingRecord customClaim = bindings.claimOperation(custom.getBindingId(),
                    "owner", Duration.ofMinutes(1));
            bindings.compareAndSet(customClaim, customClaim.withState(
                    RuntimeBindingRecord.State.RECOVERY_BLOCKED, null, Instant.now()));
            RuntimeBrokerException unknownProvisioner = assertThrows(RuntimeBrokerException.class,
                    () -> bindings.findOrCreate(customSecond));
            assertEquals("runtime_placement_recovery_required", unknownProvisioner.getCode());
        }
    }

    @Test
    void unadmittedLegacyStartupDoesNotBlockAnotherWorkspace() {
        RuntimeScope base = REQUEST.getScope();
        RuntimeScope firstScope = new RuntimeScope(base.getTenantId(),
                "legacy-workspace-a", base.getWorkspaceGeneration(),
                base.getCanonicalCwd(), base.getCapabilityDigest(), "session");
        RuntimeScope secondScope = new RuntimeScope(base.getTenantId(),
                "legacy-workspace-b", base.getWorkspaceGeneration(),
                base.getCanonicalCwd(), base.getCapabilityDigest(), "session");
        RuntimeProvisionRequest first = new RuntimeProvisionRequest(firstScope,
                "legacy-harness-a", "local-process");
        RuntimeProvisionRequest second = new RuntimeProvisionRequest(secondScope,
                "legacy-harness-b", "local-process");
        RuntimeScope thirdScope = new RuntimeScope(base.getTenantId(),
                "legacy-workspace-c", base.getWorkspaceGeneration(),
                base.getCanonicalCwd(), base.getCapabilityDigest(), "session");
        RuntimeProvisionRequest third = new RuntimeProvisionRequest(thirdScope,
                "legacy-harness-c", "local-process");
        DataSource source = database();
        JdbcRuntimeBrokerSchema.initialize(source);
        for (RuntimeBindingRepository bindings : List.of(
                new InMemoryRuntimeBindingRepository(), repository(source))) {
            RuntimeBindingRecord initial = bindings.findOrCreate(first);
            RuntimeBindingRecord claimed = bindings.claimOperation(
                    initial.getBindingId(), "owner", Duration.ofMinutes(1));
            RuntimeBindingRecord handle = bindings.compareAndSet(claimed,
                    claimed.withResourceHandle(HANDLE, Instant.now()));
            RuntimeBindingRecord blocked = bindings.compareAndSet(handle,
                    handle.withState(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                            null, Instant.now()));

            assertEquals(blocked.getBindingId(),
                    bindings.findOrCreate(first).getBindingId());
            RuntimeBindingRecord next = bindings.findOrCreate(second);
            assertNotEquals(blocked.getBindingId(), next.getBindingId());

            RuntimeBindingRecord nextClaim = bindings.claimOperation(
                    next.getBindingId(), "owner", Duration.ofMinutes(1));
            RuntimeProvisionSeed seed = nextClaim.getProvisionSeed();
            RuntimeLease lease = new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:12345"), seed.getToken(),
                    seed.getLeaseId(), seed.getEpoch());
            RuntimeBindingRecord ready = bindings.compareAndSet(nextClaim,
                    nextClaim.withAttestation(lease, HANDLE, Instant.now(),
                            Instant.now()));
            bindings.compareAndSet(ready, ready.withState(
                    RuntimeBindingRecord.State.RECOVERY_BLOCKED, null,
                    Instant.now()));
            RuntimeBrokerException refusal = assertThrows(
                    RuntimeBrokerException.class,
                    () -> bindings.findOrCreate(third));
            assertEquals("runtime_placement_recovery_required",
                    refusal.getCode());
        }
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
            assertBlocked(service);
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
                statement.execute("DROP INDEX qwen_runtime_storage_bindings_idx");
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
    void aDeadlineThatFindsTheBindingAlreadyBlockedReportsTheBlock() throws Exception {
        InMemoryRuntimeBindingRepository delegate = new InMemoryRuntimeBindingRepository();
        AtomicInteger blockWrites = new AtomicInteger();
        java.util.concurrent.CountDownLatch deadlineTried = new java.util.concurrent.CountDownLatch(1);
        // The failure handler records the block, then is still in that
        // database round trip when the deadline tries to record its own.
        RuntimeBindingRepository bindings = (RuntimeBindingRepository) java.lang.reflect.Proxy
                .newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, args) -> {
                            if ("compareAndSet".equals(method.getName())
                                    && ((RuntimeBindingRecord) args[1]).getState()
                                            == RuntimeBindingRecord.State.RECOVERY_BLOCKED) {
                                if (blockWrites.getAndIncrement() == 0) {
                                    Object written = invoke(method, delegate, args);
                                    deadlineTried.await(8, TimeUnit.SECONDS);
                                    return written;
                                }
                                deadlineTried.countDown();
                            }
                            return invoke(method, delegate, args);
                        });
        FailingProvisioner provisioner = new FailingProvisioner(false);
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            assertBlocked(service);
            assertEquals(2, blockWrites.get());
        }
        assertEquals(1, provisioner.launches.get());
    }

    @Test
    void aLateFailureAfterTheDeadlineBlockedReportsTheBlock() throws Exception {
        InMemoryRuntimeBindingRepository delegate = new InMemoryRuntimeBindingRepository();
        AtomicInteger blockWrites = new AtomicInteger();
        FailingProvisioner provisioner = new FailingProvisioner(true);
        // The launch fails after the deadline recorded the block but before
        // the deadline answered, so the failure handler answers first.
        RuntimeBindingRepository bindings = (RuntimeBindingRepository) java.lang.reflect.Proxy
                .newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, args) -> {
                            Object result = invoke(method, delegate, args);
                            if ("compareAndSet".equals(method.getName())
                                    && ((RuntimeBindingRecord) args[1]).getState()
                                            == RuntimeBindingRecord.State.RECOVERY_BLOCKED
                                    && blockWrites.getAndIncrement() == 0) {
                                provisioner.pending.completeExceptionally(new RuntimeBrokerException(
                                        503, "runtime_provision_failed", "late failure", true));
                            }
                            return result;
                        });
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            assertBlocked(service);
            assertEquals(2, blockWrites.get());
        }
        assertEquals(1, provisioner.launches.get());
    }

    @Test
    void aNonRetryableFailedLaunchKeepsItsOwnAnswer() throws Exception {
        InMemoryRuntimeBindingRepository bindings = new InMemoryRuntimeBindingRepository();
        FailingProvisioner provisioner = new FailingProvisioner(new RuntimeBrokerException(409,
                "runtime_broker_attestation_conflict", "another Runtime answered", false));
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
            assertEquals("runtime_broker_attestation_conflict",
                    ((RuntimeBrokerException) error.getCause()).getCode());
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    bindings.findActive(REQUEST).getState());
            assertBlocked(service);
        }
        assertEquals(1, provisioner.launches.get());
    }

    @Test
    void aDeadlineThatFindsTheBlockKeepsANonRetryableAnswer() throws Exception {
        assertEquals("runtime_broker_attestation_conflict",
                failBeforeTheDeadline(REQUEST).getCode());
        // The failure handler's block write, then the deadline's.
        assertEquals(2, raceBlockWrites.get());
    }

    @Test
    void aLegacyDeadlineKeepsItsTimeoutAnswer() throws Exception {
        // Legacy startup is unchanged: its deadline records no block and
        // answers the timeout, even after a non-retryable failure.
        assertEquals("runtime_broker_provision_timeout", failBeforeTheDeadline(
                new RuntimeProvisionRequest(REQUEST.getScope(), null,
                        REQUEST.getProvisionerKind())).getCode());
        assertEquals(1, raceBlockWrites.get());
    }

    private final AtomicInteger raceBlockWrites = new AtomicInteger();

    /**
     * The launch fails before the deadline, and its handler records the
     * block but does not answer until the deadline has. Returns the answer.
     */
    private RuntimeBrokerException failBeforeTheDeadline(RuntimeProvisionRequest request)
            throws Exception {
        InMemoryRuntimeBindingRepository delegate = new InMemoryRuntimeBindingRepository();
        CompletableFuture<Void> answered = new CompletableFuture<>();
        java.util.concurrent.CountDownLatch held = new java.util.concurrent.CountDownLatch(1);
        RuntimeBindingRepository bindings = (RuntimeBindingRepository) java.lang.reflect.Proxy
                .newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, args) -> {
                            Object result = invoke(method, delegate, args);
                            if (isBlockWrite(method, args) && raceBlockWrites.getAndIncrement() == 0) {
                                answered.get(30, TimeUnit.SECONDS);
                                held.countDown();
                            }
                            return result;
                        });
        FailingProvisioner provisioner = new FailingProvisioner(request);
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            CompletableFuture<RuntimeBindingRecord> warm = service.warm("harness").toCompletableFuture();
            warm.whenComplete((ignored, error) -> answered.complete(null));
            provisioner.pending.completeExceptionally(ATTESTATION_CONFLICT);
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> warm.get(30, TimeUnit.SECONDS));
            assertTrue(held.await(30, TimeUnit.SECONDS));
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                    delegate.findActive(request).getState());
            return (RuntimeBrokerException) error.getCause();
        } finally {
            assertEquals(1, provisioner.launches.get());
        }
    }

    @Test
    void aNonRetryableFailureAfterTheDeadlineFiredReportsTheBlock() throws Exception {
        InMemoryRuntimeBindingRepository delegate = new InMemoryRuntimeBindingRepository();
        AtomicInteger blockWrites = new AtomicInteger();
        CompletableFuture<Void> answered = new CompletableFuture<>();
        CompletableFuture<Void> published = new CompletableFuture<>();
        java.util.concurrent.CountDownLatch held = new java.util.concurrent.CountDownLatch(2);
        FailingProvisioner provisioner = new FailingProvisioner(true);
        // The deadline records the block, then the launch fails on another
        // thread, whose handler has published the failure but not answered
        // when the deadline answers. The deadline fired first, so it keeps
        // its own answer, as it did before failures were published.
        RuntimeBindingRepository bindings = (RuntimeBindingRepository) java.lang.reflect.Proxy
                .newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class}, (proxy, method, args) -> {
                            Object result = invoke(method, delegate, args);
                            if (isBlockWrite(method, args)) {
                                if (blockWrites.getAndIncrement() == 0) {
                                    new Thread(() -> provisioner.pending
                                            .completeExceptionally(ATTESTATION_CONFLICT)).start();
                                    published.get(30, TimeUnit.SECONDS);
                                } else {
                                    published.complete(null);
                                    answered.get(30, TimeUnit.SECONDS);
                                }
                                held.countDown();
                            }
                            return result;
                        });
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            CompletableFuture<RuntimeBindingRecord> warm = service.warm("harness").toCompletableFuture();
            warm.whenComplete((ignored, error) -> answered.complete(null));
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> warm.get(30, TimeUnit.SECONDS));
            assertTrue(held.await(30, TimeUnit.SECONDS));
            assertEquals("runtime_broker_recovery_blocked",
                    ((RuntimeBrokerException) error.getCause()).getCode());
            assertEquals(2, blockWrites.get());
            assertBlocked(service);
        }
        assertEquals(1, provisioner.launches.get());
    }

    private static final RuntimeBrokerException ATTESTATION_CONFLICT = new RuntimeBrokerException(
            409, "runtime_broker_attestation_conflict", "another Runtime answered", false);

    private static boolean isBlockWrite(java.lang.reflect.Method method, Object[] args) {
        return "compareAndSet".equals(method.getName())
                && ((RuntimeBindingRecord) args[1]).getState()
                        == RuntimeBindingRecord.State.RECOVERY_BLOCKED;
    }

    private static List<String> messages(Throwable[] failures) {
        return java.util.Arrays.stream(failures).map(Throwable::getMessage).toList();
    }

    @Test
    void aBlockThatCannotBeRecordedKeepsTheFailuresAnswer() throws Exception {
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
                            return invoke(method, delegate, args);
                        });
        FailingProvisioner provisioner = new FailingProvisioner(false);
        try (RuntimeBrokerService service = service(bindings, provisioner)) {
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> service.warm("harness").toCompletableFuture().get(8, TimeUnit.SECONDS));
            RuntimeBrokerException failure = (RuntimeBrokerException) error.getCause();
            assertEquals("runtime_provision_failed", failure.getCode());
            assertTrue(failure.isRetryable());
            assertEquals(List.of("transient database failure"), messages(failure.getSuppressed()));
            // The resource handle was persisted, so the next call blocks.
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
                UUID.randomUUID().toString(), Duration.ofMillis(1500), Duration.ofMillis(1500));
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
        private final RuntimeBrokerException failure;
        private final RuntimeProvisionRequest request;

        private FailingProvisioner(boolean hang) {
            this.hang = hang;
            this.failure = new RuntimeBrokerException(503, "runtime_provision_failed",
                    "ambiguous launch", true);
            this.request = REQUEST;
        }

        private FailingProvisioner(RuntimeBrokerException failure) {
            this.hang = false;
            this.failure = failure;
            this.request = REQUEST;
        }

        /** Places {@code request} and hangs until the test settles {@link #pending}. */
        private FailingProvisioner(RuntimeProvisionRequest request) {
            this.hang = true;
            this.failure = null;
            this.request = request;
        }

        @Override
        public String kind() {
            return "local-process";
        }

        @Override
        public RuntimeProvisionRequest createRequest(RuntimeScope scope, String isolationKey) {
            return request;
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
            return hang ? pending : CompletableFuture.failedFuture(failure);
        }
    }
}
