package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

class LocalProcessRuntimeProvisionerTest {
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void reportsUnknownWhenTheProcessIsNotOwned() throws Exception {
        HttpRuntimeTransport transport = new HttpRuntimeTransport();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(List.of("node"),
                        Path.of("").toAbsolutePath(), transport)) {
            assertEquals(LocalProcessRuntimeProvisioner.KIND,
                    provisioner.kind());
            RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a",
                    "7", "/runtime/workspace", DIGEST, "workspace");
            RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                    scope, null, provisioner.kind());
            RuntimeProvisionSeed seed = RuntimeProvisionSeed.create(
                    "binding-1", 1);
            RuntimeResourceHandle handle = provisioner
                    .ensureResource(request, seed, null)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS);
            assertEquals(LocalProcessRuntimeProvisioner.KIND,
                    handle.getKind());
            RuntimeLease missing = new RuntimeLease(
                    seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:1"), seed.getToken(),
                    seed.getLeaseId(), seed.getEpoch());
            RuntimeObservation observation = provisioner
                    .reconcile(request, seed, handle, missing)
                    .toCompletableFuture().get(5, TimeUnit.SECONDS);
            assertEquals(RuntimeObservation.Outcome.UNKNOWN,
                    observation.getOutcome());
        }
    }

    @Test
    void adoptsAWorkerOnlyAfterAttestationAndRejectsToolRoutes()
            throws Exception {
        requireNode();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        HttpRuntimeTransport transport = new HttpRuntimeTransport();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString()),
                        Path.of("").toAbsolutePath(), transport)) {
            InMemoryRuntimeBindingRepository bindings =
                    new InMemoryRuntimeBindingRepository(
                            java.time.Clock.systemUTC(), () -> "binding-1");
            RuntimeBrokerService service = new RuntimeBrokerService(
                    harnessSessionId -> java.util.concurrent.CompletableFuture
                            .completedFuture(scope),
                    provisioner, new AcceptingTransport(), bindings,
                    new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(
                            java.time.Clock.systemUTC()),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            try {
                RuntimeBindingRecord ready = service.warm("harness")
                        .toCompletableFuture().get(30, TimeUnit.SECONDS);
                assertEquals(RuntimeBindingRecord.State.READY,
                        ready.getState());
                RuntimeLease lease = ready.getLease();
                ExecutionException failure = org.junit.jupiter.api.Assertions
                        .assertThrows(ExecutionException.class,
                                () -> transport.execute(lease,
                                        new RuntimeSession("harness",
                                                "runtime", "bootstrap", scope),
                                        java.util.Map.of(
                                                "sessionId", "runtime",
                                                "promptId", "prompt-1",
                                                "callId", "tool-1",
                                                "argsDigest", "digest-1",
                                                "toolName", "read_file",
                                                "input", java.util.Map.of()))
                                        .toCompletableFuture()
                                        .get(10, TimeUnit.SECONDS));
                Throwable cause = failure.getCause();
                assertTrue(cause instanceof RuntimeBrokerException);
                RuntimeBrokerException rejected =
                        (RuntimeBrokerException) cause;
                assertEquals(404, rejected.getStatusCode());
                assertEquals("managed_runtime_incompatible",
                        rejected.getCode());
                assertFalse(rejected.isRetryable());

                provisioner.stop(lease);
                ExecutionException again = org.junit.jupiter.api.Assertions
                        .assertThrows(ExecutionException.class,
                                () -> service.warm("harness")
                                        .toCompletableFuture()
                                        .get(10, TimeUnit.SECONDS));
                assertTrue(again.getCause() instanceof RuntimeBrokerException);
            } finally {
                service.close();
            }
        }
    }

    @Test
    void releasingAnOlderGenerationPreservesTheWinningWorker()
            throws Exception {
        assertReleasePreservesOtherAttempt(false);
    }

    @Test
    void releasingARetriedSeedPreservesTheWinningWorker()
            throws Exception {
        assertReleasePreservesOtherAttempt(true);
    }

    private static void assertReleasePreservesOtherAttempt(boolean sameSeed)
            throws Exception {
        requireNode();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                scope, null, LocalProcessRuntimeProvisioner.KIND);
        RuntimeProvisionSeed firstSeed = RuntimeProvisionSeed.create(
                "binding-1", 1);
        RuntimeProvisionSeed nextSeed = sameSeed ? firstSeed
                : RuntimeProvisionSeed.create("binding-1", 2);
        Set<Long> before = childPids();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString()),
                        Path.of("").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            RuntimeLease first = provisioner.provision(request, firstSeed)
                    .toCompletableFuture().get(30, TimeUnit.SECONDS);
            RuntimeLease winner = provisioner.provision(request, nextSeed)
                    .toCompletableFuture().get(30, TimeUnit.SECONDS);
            provisioner.confirm(request, winner).toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            provisioner.release(request, first).toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            assertTrue(provisioner.isUsable(winner),
                    "releasing a losing attempt must preserve the winner");
            provisioner.confirm(request, winner).toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            assertFalse(provisioner.isUsable(first));
            provisioner.release(request, winner).toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            assertNoNewChildren(before);
        } finally {
            ProcessHandle.current().children()
                    .filter(process -> !before.contains(process.pid()))
                    .forEach(ProcessHandle::destroyForcibly);
            assertNoNewChildren(before);
        }
    }

    @Test
    void rejectsReusingADeadWorkersLeaseIdentity() throws Exception {
        assertRejectsReusedWorkerIdentity(false);
    }

    @Test
    void rejectsReusingAReleasedWorkersLeaseIdentity() throws Exception {
        assertRejectsReusedWorkerIdentity(true);
    }

    private static void assertRejectsReusedWorkerIdentity(boolean release)
            throws Exception {
        requireNode();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        int port;
        try (ServerSocket socket = new ServerSocket(0, 0,
                InetAddress.getByName("127.0.0.1"))) {
            port = socket.getLocalPort();
        }
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(
                scope, null, LocalProcessRuntimeProvisioner.KIND);
        RuntimeProvisionSeed seed = RuntimeProvisionSeed.create(
                "binding-1", 1);
        Set<Long> before = childPids();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString(), "--port=" + port),
                        Path.of("").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            RuntimeLease first = provisioner.provision(request, seed)
                    .toCompletableFuture().get(30, TimeUnit.SECONDS);
            assertEquals(port, first.getEndpoint().getPort());
            ProcessHandle worker = ProcessHandle.current().children()
                    .filter(process -> !before.contains(process.pid()))
                    .findFirst().orElseThrow();
            if (release) {
                provisioner.release(request, first).toCompletableFuture()
                        .get(10, TimeUnit.SECONDS);
            } else {
                worker.destroyForcibly();
            }
            worker.onExit().get(10, TimeUnit.SECONDS);
            assertFalse(provisioner.isUsable(first));
            if (release) {
                provisioner.release(request, first).toCompletableFuture()
                        .get(10, TimeUnit.SECONDS);
            }
            ExecutionException failure = org.junit.jupiter.api.Assertions
                    .assertThrows(ExecutionException.class,
                            () -> provisioner.provision(request, seed)
                                    .toCompletableFuture()
                                    .get(30, TimeUnit.SECONDS));
            assertTrue(failure.getCause() instanceof RuntimeBrokerException);
            RuntimeBrokerException error =
                    (RuntimeBrokerException) failure.getCause();
            assertEquals(409, error.getStatusCode());
            assertEquals("runtime_broker_resource_conflict", error.getCode());
            assertFalse(error.isRetryable());
            assertNoNewChildren(before);
            provisioner.release(request, first).toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            assertFalse(provisioner.isUsable(first));
            assertNoNewChildren(before);
        } finally {
            ProcessHandle.current().children()
                    .filter(process -> !before.contains(process.pid()))
                    .forEach(ProcessHandle::destroyForcibly);
            assertNoNewChildren(before);
        }
    }

    @Test
    void rejectsMalformedCapabilityDigestBeforeSpawning() {
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", "sha256:" + "A".repeat(64),
                "workspace");
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", "-e", "process.exit(0)"),
                        Path.of("").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            ExecutionException failure = org.junit.jupiter.api.Assertions
                    .assertThrows(ExecutionException.class,
                            () -> provisioner
                                    .provision(new RuntimeProvisionRequest(
                                            scope, null))
                                    .toCompletableFuture()
                                    .get(10, TimeUnit.SECONDS));
            RuntimeBrokerException error =
                    (RuntimeBrokerException) failure.getCause();
            assertEquals(400, error.getStatusCode());
            assertEquals("runtime_provision_failed", error.getCode());
            assertFalse(error.isRetryable());
        }
    }

    @Test
    void failsFastWhenReadyRecordExceedsTheLimit() throws Exception {
        requireNode();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString(), "--big-ready"),
                        Path.of("").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            long started = System.nanoTime();
            ExecutionException failure = org.junit.jupiter.api.Assertions
                    .assertThrows(ExecutionException.class,
                            () -> provisioner
                                    .provision(new RuntimeProvisionRequest(
                                            scope, null))
                                    .toCompletableFuture()
                                    .get(35, TimeUnit.SECONDS));
            long elapsedMillis =
                    (System.nanoTime() - started) / 1_000_000L;
            RuntimeBrokerException error =
                    (RuntimeBrokerException) failure.getCause();
            assertEquals("runtime_provision_failed", error.getCode());
            assertEquals("Managed Runtime ready record exceeds the 32 KiB"
                    + " limit.", error.getMessage());
            assertTrue(elapsedMillis < 10_000,
                    "took " + elapsedMillis + " ms");
        }
    }

    @Test
    void reportsClosedBeforeReadyWhenTheWorkerExits() throws Exception {
        requireNode();
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", "-e",
                                "setTimeout(() => process.exit(3), 50)"),
                        Path.of("").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            ExecutionException failure = org.junit.jupiter.api.Assertions
                    .assertThrows(ExecutionException.class,
                            () -> provisioner
                                    .provision(new RuntimeProvisionRequest(
                                            scope, null))
                                    .toCompletableFuture()
                                    .get(10, TimeUnit.SECONDS));
            RuntimeBrokerException error =
                    (RuntimeBrokerException) failure.getCause();
            assertEquals("Managed Runtime worker closed before ready.",
                    error.getMessage());
            org.junit.jupiter.api.Assertions.assertNull(error.getCause());
        }
    }

    @Test
    void keepsTheWorkerAliveWhenItPrintsAfterReady() throws Exception {
        requireNode();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        HttpRuntimeTransport transport = new HttpRuntimeTransport();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString(), "--chatty"),
                        Path.of("").toAbsolutePath(), transport)) {
            RuntimeBrokerService service = new RuntimeBrokerService(
                    harnessSessionId -> java.util.concurrent.CompletableFuture
                            .completedFuture(scope),
                    provisioner, new AcceptingTransport(),
                    new InMemoryRuntimeBindingRepository(),
                    new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(
                            java.time.Clock.systemUTC()),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            try {
                RuntimeBindingRecord ready = service.warm("harness")
                        .toCompletableFuture().get(30, TimeUnit.SECONDS);
                assertEquals(RuntimeBindingRecord.State.READY,
                        ready.getState());
                RuntimeBindingRecord again = service.warm("harness")
                        .toCompletableFuture().get(30, TimeUnit.SECONDS);
                assertEquals(RuntimeBindingRecord.State.READY,
                        again.getState());
                assertEquals(ready.getLease().getRuntimeInstanceId(),
                        again.getLease().getRuntimeInstanceId());
            } finally {
                service.close();
            }
        }
    }

    @Test
    void rejectsANonLoopbackReadyUrlBeforeSendingTheToken()
            throws Exception {
        requireNode();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        Path probe = Files.createTempDirectory("runtime-ready-probe");
        Path hits = probe.resolve("hits");
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        Set<Long> before = childPids();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString(), "--foreign-url",
                                "--probe=" + hits),
                        Path.of("").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            ExecutionException failure = org.junit.jupiter.api.Assertions
                    .assertThrows(ExecutionException.class,
                            () -> provisioner
                                    .provision(new RuntimeProvisionRequest(
                                            scope, null))
                                    .toCompletableFuture()
                                    .get(30, TimeUnit.SECONDS));
            RuntimeBrokerException error =
                    (RuntimeBrokerException) failure.getCause();
            assertEquals("Managed Runtime ready record is invalid.",
                    error.getMessage());
            assertFalse(Files.exists(hits));
            assertNoNewChildren(before);
        } finally {
            Files.walk(probe).sorted(Comparator.reverseOrder())
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {
                            // Best-effort cleanup of the probe directory.
                        }
                    });
        }
    }

    @Test
    void fencedProvisioningReapsTheWorker() throws Exception {
        requireNode();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        Set<Long> before = childPids();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString()),
                        Path.of("").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            RuntimeBrokerService service = new RuntimeBrokerService(
                    harnessSessionId -> java.util.concurrent.CompletableFuture
                            .completedFuture(scope),
                    provisioner, new AcceptingTransport(),
                    new FencingBindingRepository(),
                    new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(
                            java.time.Clock.systemUTC()),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            try {
                ExecutionException failure = org.junit.jupiter.api.Assertions
                        .assertThrows(ExecutionException.class,
                                () -> service.warm("harness")
                                        .toCompletableFuture()
                                        .get(30, TimeUnit.SECONDS));
                Throwable cause = failure.getCause();
                assertTrue(cause instanceof RuntimeBrokerException);
                assertEquals("runtime_provision_fenced",
                        ((RuntimeBrokerException) cause).getCode());
                // The discarded lease's worker must be reaped by release,
                // before close() gets a chance to mask a missing release.
                assertNoNewChildren(before);
            } finally {
                service.close();
            }
        }
    }

    private static void assertNoNewChildren(Set<Long> before)
            throws InterruptedException {
        long deadline = System.nanoTime()
                + Duration.ofSeconds(10).toNanos();
        while (System.nanoTime() < deadline) {
            if (before.containsAll(childPids())) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError(
                "worker children still alive: " + childPids());
    }

    private static Set<Long> childPids() {
        return ProcessHandle.current().children().map(ProcessHandle::pid)
                .collect(Collectors.toSet());
    }

    static void requireNode() {
        if (commandExists("node")) {
            return;
        }
        if ("github-hosted".equals(System.getenv("RUNNER_ENVIRONMENT"))) {
            throw new AssertionError(
                    "node is required on hosted CI runners");
        }
        assumeTrue(false, "node is required");
    }

    private static boolean commandExists(String command) {
        Process process;
        try {
            process = new ProcessBuilder(command, "-v")
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();
        } catch (IOException missing) {
            return false;
        }
        // Starting proves the command exists; a busy runner can take
        // seconds to print the version, which is not a missing command.
        try {
            process.waitFor(30, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } finally {
            process.destroyForcibly();
        }
        return true;
    }

    /**
     * Adopts the worker, then refuses to publish READY. The service must
     * release that lease. This does not wait for the renewal timer, which
     * can lose the race on a fast machine.
     */
    private static final class FencingBindingRepository
            implements RuntimeBindingRepository {
        private final InMemoryRuntimeBindingRepository delegate =
                new InMemoryRuntimeBindingRepository();

        @Override
        public RuntimeBindingRecord findOrCreate(
                RuntimeProvisionRequest request) {
            return delegate.findOrCreate(request);
        }

        @Override
        public RuntimeBindingRecord findActive(
                RuntimeProvisionRequest request) {
            return delegate.findActive(request);
        }

        @Override
        public RuntimeBindingRecord findById(String bindingId) {
            return delegate.findById(bindingId);
        }

        @Override
        public List<RuntimeBindingRecord> findActiveByIsolationKey(
                RuntimeScope scope, String isolationKey) {
            return delegate.findActiveByIsolationKey(scope, isolationKey);
        }

        @Override
        public RuntimeBindingRecord compareAndSet(
                RuntimeBindingRecord expected,
                RuntimeBindingRecord replacement) {
            if (replacement.getState()
                    == RuntimeBindingRecord.State.READY) {
                return null;
            }
            return delegate.compareAndSet(expected, replacement);
        }

        @Override
        public RuntimeBindingRecord claimOperation(String bindingId,
                String owner, Duration leaseDuration) {
            return delegate.claimOperation(bindingId, owner, leaseDuration);
        }

        @Override
        public RuntimeBindingRecord renewOperation(String bindingId,
                String owner, long operationGeneration,
                Duration leaseDuration) {
            return delegate.renewOperation(bindingId, owner,
                    operationGeneration, leaseDuration);
        }

        @Override
        public RuntimeBindingRecord releaseOperation(String bindingId,
                String owner, long operationGeneration) {
            return delegate.releaseOperation(bindingId, owner,
                    operationGeneration);
        }
    }

    private static final class AcceptingTransport implements RuntimeTransport {
        @Override
        public java.util.concurrent.CompletionStage<RuntimeAttestation> attest(
                RuntimeLease lease, RuntimeProvisionRequest request,
                RuntimeProvisionSeed seed) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    new RuntimeAttestation(lease.getRuntimeInstanceId(),
                            seed.getGatewayIncarnation(), lease.getLeaseId(),
                            lease.getEpoch(), request.getScope(),
                            seed.getProvisionRequestId()));
        }

        @Override
        public java.util.concurrent.CompletionStage<Void> acquire(
                RuntimeLease lease, RuntimeSession session) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    null);
        }

        @Override
        public java.util.concurrent.CompletionStage<Object> control(
                RuntimeLease lease, RuntimeSession session,
                java.util.Map<String, Object> operation) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    "ok");
        }

        @Override
        public java.util.concurrent.CompletionStage<java.util.Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                java.util.Map<String, Object> reference) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    java.util.Map.of("executionStatus", "success"));
        }

        @Override
        public java.util.concurrent.CompletionStage<java.util.Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                java.util.Map<String, Object> reference) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    java.util.Map.of("state", "settled"));
        }

        @Override
        public java.util.concurrent.CompletionStage<Boolean> release(
                RuntimeLease lease, RuntimeSession session) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    true);
        }
    }
}
