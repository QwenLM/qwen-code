package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/**
 * Adversarial stress: two independent repository stacks over one database
 * (two Broker processes) race admission against the release transition;
 * the LOST drain loop faces a generation mixing active executions with
 * more sessions than one bounded pass releases.
 */
class Issue13183AdversarialTest {
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant",
            "workspace", "generation", "/workspace", "capability",
            "workspace");
    private static final RuntimeResourceHandle HANDLE =
            new RuntimeResourceHandle("test-scheduler", 1,
                    Map.of("resourceId", "runtime-resource"));

    /**
     * N rounds; in each round one thread admits an execution while another
     * runs beginSessionRelease from a second repository stack, both
     * released by one latch. The two outcomes must never contradict: a
     * committed admission forces runtime_session_busy; a committed
     * RELEASING transition forces runtime_admission_closed. The
     * contradictory end state - admission committed AND session RELEASING -
     * must never occur, and neither call may hit a lock failure.
     */
    @Test
    void concurrentCrossProcessAdmitAndReleaseNeverContradict()
            throws Exception {
        DataSource dataSource = dataSource("stress");
        JdbcRuntimeSessionRepository sessionsA = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executionsA = new JdbcToolExecutionRepository(
                dataSource);
        JdbcRuntimeBindingRepository bindingsB = new JdbcRuntimeBindingRepository(
                dataSource, protector("b"));
        JdbcRuntimeSessionRepository sessionsB = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executionsB = new JdbcToolExecutionRepository(
                dataSource);

        int rounds = 200;
        ExecutorService pool = Executors.newFixedThreadPool(2);
        AtomicInteger contradictions = new AtomicInteger();
        AtomicInteger unexpected = new AtomicInteger();
        StringBuilder surprises = new StringBuilder();
        try {
            for (int round = 0; round < rounds; round++) {
                int roundNumber = round;
                JdbcRuntimeBindingRepository bindingsA =
                        new JdbcRuntimeBindingRepository(dataSource,
                                protector("a"), () -> "binding-" + roundNumber
                                        + "-" + UUID.randomUUID());
                RuntimeRecoveryContract.Fixture fixture =
                        new RuntimeRecoveryContract.Fixture(bindingsA,
                                sessionsA, executionsA, "race-" + round);
                RuntimeSessionRecord expected = sessionsB.findById(
                        fixture.binding.getRequest().getScope(),
                        fixture.session.getRuntimeSessionId());
                CountDownLatch gate = new CountDownLatch(1);
                AtomicReference<Throwable> admitOutcome =
                        new AtomicReference<>();
                AtomicReference<Throwable> releaseOutcome =
                        new AtomicReference<>();
                AtomicReference<Boolean> admitted = new AtomicReference<>(
                        Boolean.FALSE);
                int admitKey = round;
                Future<?> admitThread = pool.submit(() -> {
                    await(gate);
                    try {
                        fixture.prepare("key-" + admitKey);
                        admitted.set(Boolean.TRUE);
                    } catch (Throwable failure) {
                        admitOutcome.set(failure);
                    }
                });
                Future<?> releaseThread = pool.submit(() -> {
                    await(gate);
                    try {
                        bindingsB.beginSessionRelease(sessionsB, executionsB,
                                expected);
                    } catch (Throwable failure) {
                        releaseOutcome.set(failure);
                    }
                });
                gate.countDown();
                admitThread.get(30, TimeUnit.SECONDS);
                releaseThread.get(30, TimeUnit.SECONDS);

                boolean admitCommitted = admitted.get();
                RuntimeSessionRecord after = sessionsA.findById(
                        fixture.binding.getRequest().getScope(),
                        fixture.session.getRuntimeSessionId());
                boolean releasing = after.getState()
                        == RuntimeSessionRecord.State.RELEASING;
                if (admitCommitted && releasing) {
                    contradictions.incrementAndGet();
                }
                if (!admitCommitted && !releasing) {
                    contradictions.incrementAndGet();
                }
                if (admitCommitted && !(releaseOutcome
                        .get() instanceof RuntimeBrokerException failure
                        && "runtime_session_busy".equals(failure.getCode()))) {
                    unexpected.incrementAndGet();
                    surprises.append("release: ").append(releaseOutcome.get())
                            .append('\n');
                }
                if (!admitCommitted && !(admitOutcome
                        .get() instanceof RuntimeBrokerException failure
                        && "runtime_admission_closed".equals(
                                failure.getCode()))) {
                    unexpected.incrementAndGet();
                    surprises.append("admit: ").append(admitOutcome.get())
                            .append('\n');
                }
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(0, contradictions.get(),
                "admission and release contradicted each other");
        assertEquals(0, unexpected.get(),
                () -> "unexpected failure: " + surprises);
    }

    /**
     * The drain loop must terminalize a generation holding 150 active
     * executions AND 250 active sessions - each bounded pass abandons at
     * most 100 executions and releases at most 100 sessions, and sessions
     * only drain once executions are gone, so the progress guard sees a
     * stalled session count while executions still drain.
     */
    @Test
    void lostReclaimDrainsExecutionsAndSessionsTogether() throws Exception {
        DataSource dataSource = dataSource("mixed");
        JdbcRuntimeBindingRepository bindings = new JdbcRuntimeBindingRepository(
                dataSource, protector("mixed"));
        JdbcRuntimeSessionRepository sessions = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executions = new JdbcToolExecutionRepository(
                dataSource);

        RuntimeBindingRecord first;
        try (RuntimeBrokerService service = service(new ReclaimProvisioner(),
                bindings, sessions, executions, "broker-one")) {
            first = service.warm("harness").toCompletableFuture().get(10,
                    TimeUnit.SECONDS);
        }
        // One READY session carrying 150 still-active executions.
        RuntimeSessionRecord acquiring = bindings.admitSession(sessions,
                new RuntimeSessionRecord(new RuntimeSession("harness",
                                "runtime", "bootstrap", SCOPE),
                        first.getBindingId(), first.getGeneration(),
                        RuntimeSessionRecord.State.ACQUIRING, 0,
                        Instant.now()));
        sessions.compareAndSet(acquiring, acquiring.withState(
                RuntimeSessionRecord.State.READY, Instant.now()));
        for (int index = 0; index < 150; index++) {
            bindings.admitExecution(sessions, executions,
                    ToolExecutionRecord.prepared("exec-" + index,
                            "idem-" + index, first.getBindingId(),
                            first.getGeneration(), "harness", "runtime",
                            "turn", "call-" + index, "digest",
                            Map.of("sessionId", "runtime", "promptId", "turn",
                                    "callId", "call-" + index, "argsDigest",
                                    "digest")));
        }
        // 250 more sessions pinning the same generation.
        for (int index = 0; index < 250; index++) {
            bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession("harness", "extra-" + index,
                            "bootstrap", SCOPE), first.getBindingId(),
                    first.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        }
        assertEquals(251, sessions.countActiveByBinding(first.getBindingId(),
                first.getGeneration()));
        assertTrue(executions.hasActiveByBinding(first.getBindingId(),
                first.getGeneration()));

        try (RuntimeBrokerService service = service(new ReclaimProvisioner(),
                bindings, sessions, executions, "broker-two")) {
            RuntimeBindingRecord reclaimed = service.warm("harness")
                    .toCompletableFuture().get(30, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY,
                    reclaimed.getState());
            assertEquals(0, sessions.countActiveByBinding(
                    first.getBindingId(), first.getGeneration()));
            assertTrue(!executions.hasActiveByBinding(first.getBindingId(),
                    first.getGeneration()));
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    bindings.findById(first.getBindingId()).getState());
        }
    }

    /**
     * A renewal tick parked inside its JDBC call holds the renewal monitor;
     * close() must still shut the service down within a hard bound - no
     * deadlock between the renewal pool, the coordination scheduler, and
     * the closer.
     */
    @Test
    void stalledRenewalTickDoesNotDeadlockClose() throws Exception {
        DataSource dataSource = dataSource("deadlock");
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        DelegatingBindingRepository bindings = new DelegatingBindingRepository(
                new JdbcRuntimeBindingRepository(dataSource,
                        protector("deadlock"))) {
            @Override
            public RuntimeBindingRecord renewOperation(String bindingId,
                    String owner, long operationGeneration,
                    Duration leaseDuration) {
                entered.countDown();
                try {
                    if (!release.await(15, TimeUnit.SECONDS)) {
                        throw new AssertionError("test gate stuck");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                return delegate.renewOperation(bindingId, owner,
                        operationGeneration, leaseDuration);
            }
        };
        JdbcRuntimeSessionRepository sessions = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executions = new JdbcToolExecutionRepository(
                dataSource);
        java.util.concurrent.ScheduledExecutorService delayer =
                Executors.newSingleThreadScheduledExecutor();
        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                new SlowProvisioner(delayer), new AttestingTransport(),
                bindings, sessions, executions, "broker",
                Duration.ofSeconds(2), Duration.ofSeconds(2));
        long started = System.nanoTime();
        try {
            CompletionStage<RuntimeBindingRecord> warm = service.warm(
                    "harness");
            assertTrue(entered.await(10, TimeUnit.SECONDS),
                    "no renewal tick entered the repository");
            // The tick is parked inside renewOperation while close() lands.
            service.close();
            release.countDown();
            warm.toCompletableFuture().exceptionally(ignored -> null)
                    .get(15, TimeUnit.SECONDS);
        } finally {
            release.countDown();
            service.close();
            delayer.shutdownNow();
        }
        assertTrue(System.nanoTime() - started
                < TimeUnit.SECONDS.toNanos(30), "close took too long");
    }

    /** Provisioning that answers slowly, so renewal ticks fire mid-flight. */
    private static final class SlowProvisioner extends ReclaimProvisioner {
        private final java.util.concurrent.ScheduledExecutorService delayer;

        SlowProvisioner(
                java.util.concurrent.ScheduledExecutorService delayer) {
            this.delayer = delayer;
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            CompletableFuture<RuntimeLease> lease = new CompletableFuture<>();
            delayer.schedule(() -> lease.complete(new RuntimeLease(
                    seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:4190"), seed.getToken(),
                    seed.getLeaseId(), seed.getEpoch())), 5,
                    TimeUnit.SECONDS);
            return lease;
        }
    }

    /**
     * The exit hook iterates {@code owned}, but a worker enters {@code
     * owned} only after the ready handshake and attestation complete. A JVM
     * exit while {@code start()} is still waiting for the ready line (up to
     * READY_TIMEOUT) strands the already-spawned worker: the hook never saw
     * it. This forks a broker JVM that exits mid-provision and then checks
     * whether the worker outlived it.
     */
    @Test
    void exitHookMissesAWorkerStillInStartup() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        String classpath = System.getProperty("java.class.path");
        Process harness = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", classpath, ExitHarnessMain.class.getName())
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
        long harnessPid = harness.pid();
        long worker = -1;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) {
            java.util.Optional<ProcessHandle> node = ProcessHandle
                    .of(harnessPid).flatMap(process -> process.children()
                            .filter(child -> child.info().command()
                                    .map(command -> command.contains("node"))
                                    .orElse(false))
                            .findFirst());
            if (node.isPresent()) {
                worker = node.get().pid();
                break;
            }
            Thread.sleep(50);
        }
        assertTrue(worker > 0, "the harness never spawned a worker");
        harness.waitFor(20, TimeUnit.SECONDS);
        Thread.sleep(1000);
        boolean leaked = ProcessHandle.of(worker).map(ProcessHandle::isAlive)
                .orElse(false);
        if (leaked) {
            // Do not leave the proof behind on the machine.
            ProcessHandle.of(worker).ifPresent(
                    process -> process.destroyForcibly());
        }
        assertTrue(!leaked,
                "worker " + worker
                        + " survived the broker JVM exit: spawned during the"
                        + " ready wait, it was never in `owned`, so the exit"
                        + " hook could not destroy it");
    }

    /** Harness JVM: starts provisioning a silent worker, exits mid-start. */
    public static final class ExitHarnessMain {
        public static void main(String[] args) throws Exception {
            LocalProcessRuntimeProvisioner provisioner =
                    new LocalProcessRuntimeProvisioner(
                            List.of("node", "-e", "setInterval(() => {}, 1000)"),
                            Path.of(".").toAbsolutePath(),
                            new HttpRuntimeTransport());
            provisioner.provision(ManagedContextProtocolTest.request(),
                    ManagedContextProtocolTest.seed());
            Thread.sleep(2000);
            System.exit(0);
        }
    }

    private static void await(CountDownLatch gate) {
        try {
            gate.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            fail(interrupted);
        }
    }

    private static RuntimeBrokerService service(RuntimeProvisioner provisioner,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String owner) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new AttestingTransport(), bindings, sessions,
                executions, owner, Duration.ofSeconds(3),
                Duration.ofSeconds(3));
    }

    private static DataSource dataSource(String name) {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:adv13183-" + name + "-"
                + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1");
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        return dataSource;
    }

    private static SecretProtector protector(String prefix) {
        return new AesGcmSecretProtector("key-" + prefix,
                keyBytes(prefix.hashCode()));
    }

    private static byte[] keyBytes(int seed) {
        byte[] key = new byte[32];
        for (int index = 0; index < key.length; index++) {
            key[index] = (byte) (seed + index);
        }
        return key;
    }

    private static class ReclaimProvisioner implements RuntimeProvisioner {
        @Override
        public String kind() {
            return "test-scheduler";
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            throw new AssertionError("durable provisioning is used instead");
        }

        @Override
        public CompletionStage<RuntimeResourceHandle> ensureResource(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle knownHandle) {
            return CompletableFuture.completedFuture(HANDLE);
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            return CompletableFuture.completedFuture(new RuntimeLease(
                    seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:4190"), seed.getToken(),
                    seed.getLeaseId(), seed.getEpoch()));
        }

        @Override
        public CompletionStage<RuntimeObservation> reconcile(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle handle, RuntimeLease lastLease) {
            return CompletableFuture.completedFuture(RuntimeObservation
                    .notFound(
                            proof(seed, handle,
                                    RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                            proof(seed, handle,
                                    RuntimeRecoveryEvidence.Fact
                                            .WRITERS_STOPPED)));
        }

        private static RuntimeRecoveryEvidence proof(RuntimeProvisionSeed seed,
                RuntimeResourceHandle handle,
                RuntimeRecoveryEvidence.Fact fact) {
            return new RuntimeRecoveryEvidence(UUID.randomUUID().toString(),
                    fact, "test-supervisor", Instant.now(),
                    "test-host/domain", seed.getProvisionRequestId(),
                    seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(),
                    seed.getLeaseId(), seed.getEpoch(), handle);
        }
    }

    private static class NoopTransport implements RuntimeTransport {
        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(
                    Map.of("executionStatus", "success"));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of("state",
                    "unknown"));
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class AttestingTransport extends NoopTransport {
        @Override
        public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            return CompletableFuture.completedFuture(new RuntimeAttestation(
                    lease.getRuntimeInstanceId(), seed.getGatewayIncarnation(),
                    lease.getLeaseId(), lease.getEpoch(), request.getScope(),
                    seed.getProvisionRequestId()));
        }
    }
}
