package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.Issue13183RegressionTest.SCOPE;
import static com.alibaba.qwen.code.runtimebroker.Issue13183RegressionTest.dataSource;
import static com.alibaba.qwen.code.runtimebroker.Issue13183RegressionTest.protector;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.alibaba.qwen.code.runtimebroker.Issue13183RegressionTest.AttestingTransport;
import com.alibaba.qwen.code.runtimebroker.Issue13183RegressionTest.ReclaimProvisioner;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.time.Duration;
import java.time.Instant;
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
import org.junit.jupiter.api.Test;


/**
 * Adversarial stress: two independent repository stacks over one database
 * (two Broker processes) race admission against the release transition;
 * the LOST drain loop faces a generation mixing active executions with
 * more sessions than one bounded pass releases.
 */
@org.junit.jupiter.api.Timeout(180)
class Issue13183AdversarialTest {

    /**
     * N rounds; in each round one thread admits an execution while another
     * runs beginSessionRelease from a second repository stack. Half the
     * rounds release both from one latch as a tight race; the other half
     * hold the release until the admission has committed, so both
     * directions are covered rather than whichever one the scheduler
     * favours. The two outcomes must never contradict: a
     * committed admission forces runtime_session_busy; a committed
     * RELEASING transition forces runtime_admission_closed. The
     * contradictory end state - admission committed AND session RELEASING -
     * must never occur, and neither call may hit a lock failure. Both
     * interleavings must actually occur, so a one-sided schedule cannot pass
     * the exact-error-code checks by never exercising one direction.
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
        AtomicInteger admitWins = new AtomicInteger();
        AtomicInteger releaseWins = new AtomicInteger();
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
                // Half the rounds are a tight race; the other half hold the
                // release until the admission has committed. The release
                // reaches the session row first in a tight race often enough
                // that racing alone would leave the committed-admission
                // direction unexercised.
                boolean raced = (round & 1) == 1;
                CountDownLatch admitDone = new CountDownLatch(raced ? 0 : 1);
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
                    } finally {
                        admitDone.countDown();
                    }
                });
                Future<?> releaseThread = pool.submit(() -> {
                    await(gate);
                    await(admitDone);
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
                if (admitCommitted) {
                    admitWins.incrementAndGet();
                } else {
                    releaseWins.incrementAndGet();
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
        // Both interleavings must actually have occurred, or the exact
        // error-code checks above only covered the direction the scheduler
        // happened to favour.
        assertTrue(admitWins.get() > 0 && releaseWins.get() > 0,
                "the stress never exercised both interleavings: admission won "
                        + admitWins.get() + " rounds, release won "
                        + releaseWins.get() + " of " + rounds);
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
        // One READY session carrying 150 still-active (EXECUTING)
        // executions.
        RuntimeSessionRecord acquiring = bindings.admitSession(sessions,
                new RuntimeSessionRecord(new RuntimeSession("harness",
                                "runtime", "bootstrap", SCOPE),
                        first.getBindingId(), first.getGeneration(),
                        RuntimeSessionRecord.State.ACQUIRING, 0,
                        Instant.now()));
        sessions.compareAndSet(acquiring, acquiring.withState(
                RuntimeSessionRecord.State.READY, Instant.now()));
        for (int index = 0; index < 150; index++) {
            ToolExecutionRecord prepared = bindings.admitExecution(sessions,
                    executions, ToolExecutionRecord.prepared("exec-" + index,
                            "idem-" + index, first.getBindingId(),
                            first.getGeneration(), "harness", "runtime",
                            "turn", "call-" + index, "digest",
                            Map.of("sessionId", "runtime", "promptId", "turn",
                                    "callId", "call-" + index, "argsDigest",
                                    "digest")));
            ToolExecutionRecord claimed = executions.claimDispatch(
                    prepared.getExecutionCallId(), "dispatcher",
                    Duration.ofMinutes(5));
            executions.compareAndSet(claimed, claimed.withState(
                    ToolExecutionRecord.State.EXECUTING, false), "dispatcher",
                    claimed.getDispatchGeneration());
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
        RuntimeSessionRecord readySession = sessions.findById(SCOPE,
                "runtime");
        assertEquals(150, countUnsettled(executions, readySession),
                "the execution half of the premise must hold exactly: the"
                        + " multi-pass abandon only engages past 100");

        try (RuntimeBrokerService service = service(new ReclaimProvisioner(),
                bindings, sessions, executions, "broker-two")) {
            RuntimeBindingRecord reclaimed = service.warm("harness")
                    .toCompletableFuture().get(30, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY,
                    reclaimed.getState());
            assertEquals(0, sessions.countActiveByBinding(
                    first.getBindingId(), first.getGeneration()));
            assertEquals(0, countUnsettled(executions, readySession));
            assertEquals(RuntimeBindingRecord.State.RELEASED,
                    bindings.findById(first.getBindingId()).getState());
        }
    }

    private static long countUnsettled(ToolExecutionRepository executions,
            RuntimeSessionRecord session) {
        long count = 0;
        String after = null;
        for (;;) {
            List<ToolExecutionRecord> batch = executions.findUnsettled(
                    session, after, 100);
            count += batch.size();
            if (batch.size() < 100) {
                return count;
            }
            after = batch.get(batch.size() - 1).getExecutionCallId();
        }
    }

    /**
     * The drain loop's pass budget caps one reclaim's inline work: a
     * generation larger than the budget answers runtime_broker_runtime_lost
     * within a bounded wait instead of draining to completion inline, and
     * the next reclaim resumes.
     */
    @Test
    void reclaimBeyondThePassBudgetAnswersLost() throws Exception {
        DataSource dataSource = dataSource("budget");
        JdbcRuntimeBindingRepository bindings = new JdbcRuntimeBindingRepository(
                dataSource, protector("budget"));
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
        // More sessions than one reclaim's pass budget can release: the
        // first site returns before any release (the loss evidence is not
        // yet written), then two sites drain 16 * 100 rows each, so the
        // ~1.6k that remain must stop the reclaim with LOST instead of
        // looping. The budget answers in about 2s; the 10s lease (a 40s
        // operation deadline) keeps a slow runner from answering on the
        // deadline instead, which the previous 3s lease did.
        int sessionsToCreate = 3 * 16 * 100 + 1;
        for (int index = 0; index < sessionsToCreate; index++) {
            bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession("harness", "extra-" + index,
                            "bootstrap", SCOPE), first.getBindingId(),
                    first.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        }

        try (RuntimeBrokerService service = service(new ReclaimProvisioner(),
                bindings, sessions, executions, "broker-two",
                Duration.ofSeconds(10))) {
            java.util.concurrent.ExecutionException failure =
                    org.junit.jupiter.api.Assertions.assertThrows(
                            java.util.concurrent.ExecutionException.class,
                            () -> service.warm("harness").toCompletableFuture()
                                    .get(60, TimeUnit.SECONDS));
            RuntimeBrokerException broker = null;
            for (Throwable cause = failure.getCause(); cause != null;
                    cause = cause.getCause()) {
                if (cause instanceof RuntimeBrokerException hit) {
                    broker = hit;
                    break;
                }
            }
            assertEquals("runtime_broker_runtime_lost",
                    broker == null ? null : broker.getCode());
            // The drain made progress and stopped inside the budget.
            long remaining = sessions.countActiveByBinding(
                    first.getBindingId(), first.getGeneration());
            assertTrue(remaining > 0 && remaining < sessionsToCreate,
                    "budgeted drain must make progress without finishing: "
                            + remaining);
        }

        // The next reclaim resumes where the budgeted one stopped.
        try (RuntimeBrokerService service = service(new ReclaimProvisioner(),
                bindings, sessions, executions, "broker-three",
                Duration.ofSeconds(10))) {
            RuntimeBindingRecord reclaimed = service.warm("harness")
                    .toCompletableFuture().get(60, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY,
                    reclaimed.getState());
            assertEquals(first.getGeneration() + 1, reclaimed.getGeneration());
            assertEquals(0, sessions.countActiveByBinding(
                    first.getBindingId(), first.getGeneration()));
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
        try {
            CompletionStage<RuntimeBindingRecord> warm = service.warm(
                    "harness");
            assertTrue(entered.await(10, TimeUnit.SECONDS),
                    "no renewal tick entered the repository");
            // The tick is parked inside renewOperation while close() lands;
            // the bracket measures close() alone, not the whole test.
            long closeStart = System.nanoTime();
            service.close();
            long closeElapsed = System.nanoTime() - closeStart;
            assertTrue(closeElapsed < TimeUnit.SECONDS.toNanos(5),
                    "close() blocked on the parked renewal tick: "
                            + closeElapsed + "ns");
            release.countDown();
            warm.toCompletableFuture().exceptionally(ignored -> null)
                    .get(15, TimeUnit.SECONDS);
        } finally {
            release.countDown();
            service.close();
            delayer.shutdownNow();
        }
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
     * The exit hook must reclaim even a worker that is still in its ready
     * handshake when the JVM exits: it is registered in {@code starting}
     * from spawn. This forks a broker JVM that is signalled mid-provision
     * and then checks that the worker did not outlive it. Before the fix,
     * the worker survived: it only entered {@code owned} after the
     * handshake, which the exit never reached. The forked worker obeys
     * SIGTERM, so this covers the hook's {@code destroy()}; the forcible
     * fallback on the exit path is exercised by the close() and release()
     * escalation tests instead.
     */
    @Test
    void exitHookReclaimsAWorkerStillInStartup() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        String classpath = System.getProperty("java.class.path");
        Path harnessLog = Files.createTempFile("exit-harness", ".log");
        Process harness = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", classpath, ExitHarnessMain.class.getName())
                .redirectErrorStream(true)
                .redirectOutput(harnessLog.toFile()).start();
        long harnessPid = harness.pid();
        try {
            long worker = -1;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            while (System.nanoTime() < deadline) {
                java.util.Optional<ProcessHandle> node = ProcessHandle
                        .of(harnessPid).flatMap(process -> process.children()
                                .filter(child -> child.info().command()
                                        .map(command -> command.contains(
                                                "node"))
                                        .orElse(false))
                                .findFirst());
                if (node.isPresent()) {
                    worker = node.get().pid();
                    break;
                }
                Thread.sleep(50);
            }
            assertTrue(worker > 0,
                    "the harness never spawned a worker; harness log: "
                            + logTail(harnessLog));
            // The test ends the harness JVM rather than waiting for a timer
            // inside it: SIGTERM runs the same shutdown hooks a natural exit
            // would, and the observation window above no longer has to fit
            // inside the harness's own sleep.
            harness.destroy();
            assertTrue(harness.waitFor(20, TimeUnit.SECONDS),
                    "the harness never exited; harness log: "
                            + logTail(harnessLog));
            Thread.sleep(1000);
            boolean leaked = ProcessHandle.of(worker)
                    .map(ProcessHandle::isAlive).orElse(false);
            if (leaked) {
                // Do not leave the proof behind on the machine.
                ProcessHandle.of(worker).ifPresent(
                        process -> process.destroyForcibly());
            }
            assertTrue(!leaked,
                    "worker " + worker
                            + " survived the broker JVM exit mid-handshake;"
                            + " harness log: " + logTail(harnessLog));
        } finally {
            if (harness.isAlive()) {
                harness.destroyForcibly();
            }
            Files.deleteIfExists(harnessLog);
        }
    }

    private static String logTail(Path log) {
        try {
            String content = Files.readString(log);
            return content.substring(Math.max(0, content.length() - 2000));
        } catch (Exception unreadable) {
            return "<unreadable: " + unreadable + ">";
        }
    }

    /**
     * Harness JVM: starts provisioning a silent worker, stays in the ready
     * handshake until the test ends the JVM, and so exits mid-start.
     */
    public static final class ExitHarnessMain {
        public static void main(String[] args) throws Exception {
            LocalProcessRuntimeProvisioner provisioner =
                    new LocalProcessRuntimeProvisioner(
                            List.of("node", "-e", "setInterval(() => {}, 1000)"),
                            Path.of(".").toAbsolutePath(),
                            new HttpRuntimeTransport());
            provisioner.provision(ManagedContextProtocolTest.request(),
                    ManagedContextProtocolTest.seed());
            // The worker never prints a ready line, so it stays in `starting`
            // for as long as this JVM lives; the sleep only bounds an
            // orphaned harness.
            Thread.sleep(60_000);
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
        return service(provisioner, bindings, sessions, executions, owner,
                Duration.ofSeconds(3));
    }

    /**
     * A service with explicit operation and dispatch leases. The measured
     * operation deadline is four times the operation lease, so a test that
     * drains thousands of rows needs a lease long enough to keep that
     * deadline ahead of its own wall clock.
     */
    private static RuntimeBrokerService service(RuntimeProvisioner provisioner,
            RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String owner,
            Duration lease) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new AttestingTransport(), bindings, sessions,
                executions, owner, lease, lease);
    }






}
