package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class DurableLocalProcessRuntimeProvisionerTest {
    static final LocalRuntimeStore.HostIdentity HOST = new LocalRuntimeStore.HostIdentity(
            "a".repeat(32), "11111111-1111-1111-1111-111111111111", "pid:[1]", "time:[1]");
    private static final RuntimeProvisionSeed SEED = RuntimeProvisionSeed.create("binding", 1);
    private static final HttpRuntimeTransport TRANSPORT = new HttpRuntimeTransport();
    @TempDir
    Path directory;
    private final List<ProcessHandle> workers = new ArrayList<>();

    @AfterEach
    void cleanup() throws Exception {
        for (ProcessHandle worker : workers) {
            worker.destroyForcibly();
            worker.onExit().get(5, TimeUnit.SECONDS);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void restartAndConcurrentObserversKeepTheSameWorker(boolean managed) throws Exception {
        RuntimeProvisionRequest request = request(managed);
        LocalRuntimeStore store = store();
        RuntimeLease lease;
        RuntimeResourceHandle handle;
        try (var first = provisioner(store)) {
            handle = await(first.ensureResource(request, SEED, null));
            lease = launch(first, store, request);
            assertEquals(2, handle.getVersion());
            assertEquals(lease.getEndpoint(), await(first.provision(request, SEED)).getEndpoint());
            try (var files = Files.list(directory)) {
                for (Path path : files.toList()) {
                    assertFalse(Files.readString(path).contains(SEED.getToken()), "credential leaked to local disk");
                }
            }
        }
        assertTrue(workers.getFirst().isAlive(), "close must detach");
        try (var second = provisioner(store()); var observer = provisioner(store())) {
            assertEquals(RuntimeObservation.Outcome.READY,
                    await(second.reconcile(request, SEED, handle, lease)).getOutcome());
            assertEquals(RuntimeObservation.Outcome.READY,
                    await(observer.reconcile(request, SEED, handle, lease)).getOutcome());
            await(second.release(request, lease));
            assertTrue(second.isUsable(lease), "late lease discard cannot invalidate the winning observer");
            await(second.confirm(request, lease));
            observer.close();
            await(second.confirm(request, lease));
        }
    }

    @Test
    void recoversReadyOutputWhenPublicationWasInterrupted() throws Exception {
        var request = request(true);
        var store = store();
        try (var first = provisioner(store); var second = provisioner(store())) {
            var handle = await(first.ensureResource(request, SEED, null));
            var lease = launch(first, store, request);
            store.locked(request, SEED, handle, false, (resource, record) -> {
                resource.save(new LocalRuntimeStore.Registration(handle, LocalRuntimeStore.State.REGISTERED,
                        record.pid(), record.started(), null));
                return null;
            });
            var observation = await(second.reconcile(request, SEED, handle, null));
            assertEquals(RuntimeObservation.Outcome.READY, observation.getOutcome());
            assertEquals(lease.getEndpoint(), observation.getEndpoint());
            assertEquals(LocalRuntimeStore.State.READY, registration(store, request, handle).state());
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"PROVISIONING", "RECOVERY_BLOCKED"})
    void brokerAdoptsARegisteredStartupWithoutASavedLease(String state) throws Exception {
        RuntimeProvisionRequest request = request(true);
        var bindings = new InMemoryRuntimeBindingRepository();
        var initial = bindings.findOrCreate(request);
        var claim = bindings.claimOperation(initial.getBindingId(), "setup", Duration.ofSeconds(10));
        var seed = claim.getProvisionSeed();
        var store = store();
        RuntimeLease lease;
        try (var first = provisioner(store)) {
            var handle = await(first.ensureResource(request, seed, null));
            var saved = bindings.compareAndSet(claim, claim.withResourceHandle(handle, Instant.now()));
            lease = await(first.provision(request, seed));
            workers.add(store.locked(request, seed, handle, false, (resource, record) -> record.process()));
            if (state.equals("RECOVERY_BLOCKED")) {
                assertNotNull(bindings.compareAndSet(saved, saved.withState(
                        RuntimeBindingRecord.State.RECOVERY_BLOCKED, null, Instant.now())));
            }
            bindings.releaseOperation(claim.getBindingId(), "setup", claim.getOperationGeneration());
        }
        try (var restored = provisioner(store()); var service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(request.getScope()), restored, TRANSPORT,
                bindings, new InMemoryRuntimeSessionRepository(), new InMemoryToolExecutionRepository(),
                "restored", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
            var ready = await(service.warm("harness"));
            assertEquals(RuntimeBindingRecord.State.READY, ready.getState());
            assertEquals(initial.getBindingId(), ready.getBindingId());
            assertEquals(lease.getEndpoint(), ready.getLease().getEndpoint());
            assertEquals(seed.getToken(), ready.getLease().getToken());
        }
    }

    @Test
    void journalLossLeavesTombstoneAndNeverClaimsWritersStopped() throws Exception {
        var request = request(false);
        var store = store();
        try (var first = provisioner(store); var second = provisioner(store())) {
            var handle = await(first.ensureResource(request, SEED, null));
            var lease = launch(first, store, request);
            var worker = workers.getFirst();
            worker.destroyForcibly();
            worker.onExit().get(5, TimeUnit.SECONDS);
            var lost = await(second.reconcile(request, SEED, handle, lease));
            assertEquals(RuntimeObservation.Outcome.NOT_FOUND, lost.getOutcome());
            assertTrue(lost.getLossEvidence().matches(SEED, handle, lease));
            assertNull(lost.getStopEvidence());
            assertEquals(LocalRuntimeStore.State.RETIRED, registration(store, request, handle).state());
            assertBlocked(second.provision(request, SEED));
            assertEquals(RuntimeObservation.Outcome.NOT_FOUND,
                    await(second.reconcile(request, SEED, handle, lease)).getOutcome());
        }
    }

    @Test
    void pidReuseDoesNotKillTheUnrelatedProcessOrProveWritersStopped() throws Exception {
        var request = request(false);
        var store = store();
        try (var provisioner = provisioner(store)) {
            var handle = await(provisioner.ensureResource(request, SEED, null));
            var lease = launch(provisioner, store, request);
            store.locked(request, SEED, handle, false, (resource, record) -> {
                resource.save(new LocalRuntimeStore.Registration(handle, LocalRuntimeStore.State.READY,
                        ProcessHandle.current().pid(), "Linux".equals(System.getProperty("os.name")) ? "ticks:0" : "instant:2000-01-01T00:00:00Z", lease.getEndpoint()));
                return null;
            });
            var lost = await(provisioner.reconcile(request, SEED, handle, lease));
            assertEquals(RuntimeObservation.Outcome.NOT_FOUND, lost.getOutcome());
            assertNull(lost.getStopEvidence());
            assertTrue(ProcessHandle.current().isAlive());
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "corrupt", "permission", "symlink", "lock"})
    void unsafeRecordsCannotBeAdoptedOrRecreated(String damage) throws Exception {
        var request = request(false);
        var store = store();
        try (var provisioner = provisioner(store)) {
            var handle = await(provisioner.ensureResource(request, SEED, null));
            var lease = launch(provisioner, store, request);
            Path record = directory.resolve(handle.getValue().get("resourceId") + ".json");
            switch (damage) {
                case "missing" -> Files.delete(record);
                case "corrupt" -> Files.writeString(record, "{broken");
                case "permission" -> Files.setPosixFilePermissions(record, PosixFilePermissions.fromString("rw-r--r--"));
                case "lock" -> Files.delete(directory.resolve(handle.getValue().get("resourceId") + ".lock"));
                case "symlink" -> {
                    Path target = directory.resolve("original.json");
                    Files.move(record, target);
                    Files.createSymbolicLink(record, target);
                }
                default -> throw new AssertionError();
            }
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    await(provisioner.reconcile(request, SEED, handle, lease)).getOutcome());
            assertBlocked(provisioner.ensureResource(request, SEED, handle));
            assertBlocked(provisioner.ensureResource(request, SEED, null));
            assertBlocked(provisioner.provision(request, SEED));
            assertTrue(workers.getFirst().isAlive());
        }
    }

    @Test
    void interruptedLaunchingAndBusyLocksProveNothing() throws Exception {
        var request = request(false);
        var store = store();
        try (var provisioner = provisioner(store)) {
            var handle = await(provisioner.ensureResource(request, SEED, null));
            store.locked(request, SEED, handle, false, (resource, record) -> {
                resource.save(record.withState(LocalRuntimeStore.State.LAUNCHING));
                return null;
            });
            assertBlocked(provisioner.provision(request, SEED));
            assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                    await(provisioner.reconcile(request, SEED, handle, null)).getOutcome());
            CountDownLatch locked = new CountDownLatch(1);
            CountDownLatch unlock = new CountDownLatch(1);
            var held = CompletableFuture.runAsync(() -> store.locked(request, SEED, handle, false, (resource, record) -> {
                locked.countDown();
                try {
                    assertTrue(unlock.await(10, TimeUnit.SECONDS));
                } catch (InterruptedException error) {
                    throw new AssertionError(error);
                }
                return null;
            }));
            try {
                assertTrue(locked.await(5, TimeUnit.SECONDS));
                assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                        await(provisioner.reconcile(request, SEED, handle, null)).getOutcome());
            } finally {
                unlock.countDown();
                held.get(5, TimeUnit.SECONDS);
            }
            assertTrue(workers.isEmpty());
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"host", "boot", "namespace", "time-namespace"})
    void hostOrBootChangeCannotAdoptOrRelaunch(String changedField) throws Exception {
        var request = request(false);
        var store = store();
        try (var first = provisioner(store)) {
            var handle = await(first.ensureResource(request, SEED, null));
            var lease = launch(first, store, request);
            var changed = new LocalRuntimeStore.HostIdentity(changedField.equals("host") ? "b".repeat(32) : HOST.hostId(),
                    changedField.equals("boot") ? "22222222-2222-2222-2222-222222222222" : HOST.bootId(),
                    changedField.equals("namespace") ? "pid:[2]" : HOST.pidNamespace(),
                    changedField.equals("time-namespace") ? "time:[2]" : HOST.timeNamespace());
            try (var second = provisioner(new LocalRuntimeStore(directory.toRealPath(), changed))) {
                assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                        await(second.reconcile(request, SEED, handle, lease)).getOutcome());
                assertBlocked(second.provision(request, SEED));
                assertTrue(workers.getFirst().isAlive());
            }
        }
    }

    @Test
    void refusesPlacementDriftAndOldHandles() throws Exception {
        var request = request(false);
        var store = store();
        try (var provisioner = provisioner(store)) {
            var handle = await(provisioner.ensureResource(request, SEED, null));
            var lease = launch(provisioner, store, request);
            assertEquals(RuntimeObservation.Outcome.CONFLICT,
                    await(provisioner.reconcile(request(true), SEED, handle, lease)).getOutcome());
            var old = new RuntimeResourceHandle(LocalProcessRuntimeProvisioner.KIND, 1,
                    Map.of("provider", LocalProcessRuntimeProvisioner.KIND));
            assertFalse(provisioner.supportsStartupRecovery(old));
            assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                    await(provisioner.reconcile(request, SEED, old, lease)).getOutcome());
        }
    }

    @Test
    void rejectsUnsafeDirectoryAndInvalidOsIdentity() throws Exception {
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        assertThrows(IllegalStateException.class, this::store);
        assertThrows(IllegalArgumentException.class, () -> new LocalRuntimeStore.HostIdentity("unknown", HOST.bootId(), HOST.pidNamespace(), HOST.timeNamespace()));
        if (!"Linux".equals(System.getProperty("os.name"))) {
            assertThrows(IllegalStateException.class, LocalRuntimeStore.HostIdentity::linux);
        } else {
            assertNotNull(LocalRuntimeStore.HostIdentity.linux());
        }
    }

    @Test
    void linuxIdentityUsesRawTicksAfterTheLastCommandParenthesis() {
        String fields = "S " + "0 ".repeat(18) + "987654321 0 0";
        assertEquals("ticks:987654321", LocalRuntimeStore.linuxStartIdentity("123 (worker ) with\nname) " + fields));
        assertEquals("ticks:987654321", LocalRuntimeStore.linuxStartIdentity("123 (different name) " + fields));
        assertThrows(IllegalArgumentException.class, () -> LocalRuntimeStore.linuxStartIdentity("123 (short) S 0"));
        assertThrows(IllegalArgumentException.class, () -> LocalRuntimeStore.linuxStartIdentity("123 (bad) "
                + fields.replace("987654321", "unknown")));
        if ("Linux".equals(System.getProperty("os.name"))) {
            assertTrue(LocalRuntimeStore.startIdentity(ProcessHandle.current()).startsWith("ticks:"));
        }
    }

    @Test
    void unreadableOrMalformedProcStatCannotProveDeath() throws Exception {
        Path stat = directory.resolve("stat");
        String fields = "S " + "0 ".repeat(18) + "987654321 0 0";
        Files.writeString(stat, "123 (worker) " + fields);
        assertFalse(LocalRuntimeStore.linuxProcessAbsent(stat, "ticks:987654321"));
        assertTrue(LocalRuntimeStore.linuxProcessAbsent(stat, "ticks:987654320"));
        Files.writeString(stat, "unparseable");
        assertFalse(LocalRuntimeStore.linuxProcessAbsent(stat, "ticks:987654321"));
        assertFalse(LocalRuntimeStore.linuxProcessAbsent(directory, "ticks:987654321"),
                "a non-ENOENT read failure is uncertainty, even if ProcessHandle reports absent");
        Files.delete(stat);
        assertTrue(LocalRuntimeStore.linuxProcessAbsent(stat, "ticks:987654321"));
    }

    private RuntimeProvisionRequest request(boolean managed) {
        return new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1",
                directory.toAbsolutePath().toString(), "sha256:" + "a".repeat(64), "workspace"),
                null, LocalProcessRuntimeProvisioner.KIND, managed ? "storage:a" : null);
    }

    private LocalRuntimeStore store() throws Exception {
        return new LocalRuntimeStore(directory.toRealPath(), HOST);
    }

    private LocalProcessRuntimeProvisioner provisioner(LocalRuntimeStore store) {
        return new LocalProcessRuntimeProvisioner(List.of("node", Path.of(
                "src/test/resources/fake-attestation-worker.mjs").toAbsolutePath().toString()),
                directory, TRANSPORT, ignored -> "storage:a", store);
    }

    private RuntimeLease launch(LocalProcessRuntimeProvisioner provisioner, LocalRuntimeStore store,
            RuntimeProvisionRequest request) throws Exception {
        var lease = await(provisioner.provision(request, SEED));
        workers.add(registration(store, request, null).process());
        assertNotNull(workers.getLast());
        return lease;
    }

    private static LocalRuntimeStore.Registration registration(LocalRuntimeStore store,
            RuntimeProvisionRequest request, RuntimeResourceHandle handle) {
        return store.locked(request, SEED, handle, false, (resource, registration) -> registration);
    }

    private static void assertBlocked(CompletionStage<?> operation) {
        var failure = assertThrows(java.util.concurrent.ExecutionException.class, () -> await(operation));
        assertTrue(failure.getCause() instanceof RuntimeBrokerException);
        assertEquals("runtime_broker_recovery_blocked", ((RuntimeBrokerException) failure.getCause()).getCode());
    }

    private static <T> T await(CompletionStage<T> operation) throws Exception {
        return operation.toCompletableFuture().get(35, TimeUnit.SECONDS);
    }
}
