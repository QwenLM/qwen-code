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
     * Rounds of one thread admitting an execution while another runs
     * beginSessionRelease from a second repository stack. Odd rounds release
     * both from one latch as a tight race: the release wins almost all of
     * them, because admission takes the placement-domain lock and does two
     * reads first, and a missing Session row lock shows up here as the
     * contradictory end state - admission committed AND session RELEASING -
     * in a few percent of rounds. Even rounds hold the release until the
     * admission has committed, the direction a tight race does not reach, so
     * the transition's own re-check must answer runtime_session_busy. The
     * two outcomes must never contradict: a committed admission forces
     * runtime_session_busy; a committed RELEASING transition forces
     * runtime_admission_closed. Neither call may hit a lock failure. The win
     * counters assert that both arms ran, so the exact-error-code checks
     * cover both outcomes; they do not claim a contradictory interleaving
     * was reached, which is what the raced arm is for.
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

        // 300 raced rounds: a missing Session row lock contradicts in a few
        // percent of them, so the count sets the odds of catching it.
        int rounds = 600;
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
                // Odd rounds race; even rounds hold the release until the
                // admission has committed. The release wins a tight race
                // almost every time, so racing alone would leave the
                // committed-admission direction unexercised.
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
        // Both outcomes must have occurred, or the exact error-code checks
        // above only covered one of them. The committed-admission half is
        // guaranteed by the even rounds' latch, so what this really guards
        // is that the raced half still produces committed releases.
        assertTrue(admitWins.get() > 0 && releaseWins.get() > 0,
                "one outcome never occurred: admission won "
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
     * from spawn. This forks a broker JVM that exits on its own mid-provision,
     * at the test's signal, and then checks that the worker did not outlive
     * it. Before the fix, the worker survived: it only entered {@code owned}
     * after the handshake, which the exit never reached. The forked worker
     * obeys SIGTERM, so this covers the hook's {@code destroy()}; the
     * forcible fallback on the exit path is exercised by the close() and
     * release() escalation tests instead.
     */
    @Test
    void exitHookReclaimsAWorkerStillInStartup() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        String classpath = System.getProperty("java.class.path");
        Path harnessLog = Files.createTempFile("exit-harness", ".log");
        Path exitSignal = Files.createTempFile("exit-signal", ".flag");
        Files.delete(exitSignal);
        Process harness = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", classpath, ExitHarnessMain.class.getName(),
                exitSignal.toString())
                .redirectErrorStream(true)
                .redirectOutput(harnessLog.toFile()).start();
        long harnessPid = harness.pid();
        long worker = -1;
        try {
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
            // The test, not a timer inside the harness, decides when that
            // JVM exits, so the observation window above is not a race. The
            // harness exits itself rather than being killed from here:
            // System.exit runs the shutdown hooks on every platform, while
            // destroy() would not run them on Windows.
            Files.createFile(exitSignal);
            assertTrue(harness.waitFor(20, TimeUnit.SECONDS),
                    "the harness never exited; harness log: "
                            + logTail(harnessLog));
            Thread.sleep(1000);
            // running() rather than isAlive(): the JDK counts a zombie as
            // alive, and a worker killed at halt is reaped by whoever adopts
            // it, which a container runner's PID 1 may never do.
            boolean leaked = ProcessHandle.of(worker)
                    .map(ProcessTrees::running).orElse(false);
            assertTrue(!leaked,
                    "worker " + worker
                            + " survived the broker JVM exit mid-handshake;"
                            + " harness log: " + logTail(harnessLog));
        } finally {
            if (harness.isAlive()) {
                harness.destroyForcibly();
            }
            // A failed assertion above must not leave the harness's worker
            // spinning on the runner: nothing else ever stops it. Only kill
            // that pid while it still names a node worker, so a recycled pid
            // cannot take out an unrelated process.
            ProcessHandle.of(worker)
                    .filter(handle -> handle.info().command()
                            .map(command -> command.contains("node"))
                            .orElse(false))
                    .ifPresent(ProcessHandle::destroyForcibly);
            Files.deleteIfExists(harnessLog);
            Files.deleteIfExists(exitSignal);
        }
    }

    /**
     * The release grace window is tracked the same way the ready handshake
     * is: a worker that ignores SIGTERM is escalated by a daemon thread, and
     * that thread dies with the JVM, so an exit inside the window can only
     * be saved by the hook finding the worker. POSIX-only, like the other
     * escalation tests: on Windows destroy() terminates outright, so there
     * is no wedged worker to strand.
     */
    @Test
    @org.junit.jupiter.api.condition.DisabledOnOs(
            org.junit.jupiter.api.condition.OS.WINDOWS)
    void exitHookReclaimsAWorkerInsideItsReleaseGraceWindow() throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        String classpath = System.getProperty("java.class.path");
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        Path harnessLog = Files.createTempFile("release-harness", ".log");
        Process harness = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java")
                        .toString(),
                "-cp", classpath, ReleaseGraceHarnessMain.class.getName(),
                script.toString())
                .redirectErrorStream(true)
                .redirectOutput(harnessLog.toFile()).start();
        long worker = -1;
        try {
            assertTrue(harness.waitFor(60, TimeUnit.SECONDS),
                    "the harness never exited; harness log: "
                            + logTail(harnessLog));
            worker = reportedWorker(harnessLog);
            assertTrue(worker > 0,
                    "the harness never reported its worker; harness log: "
                            + logTail(harnessLog));
            // The harness has exited, and with it the hook's grace window,
            // so this loop only waits out pid reaping. It trusts the pid
            // only while that process still runs and still names a node
            // worker: a zombie counts as dead here, and the pid could be
            // recycled while the loop waits.
            long pid = worker;
            boolean alive = true;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (alive && System.nanoTime() < deadline) {
                alive = ProcessHandle.of(pid).map(handle ->
                        ProcessTrees.running(handle)
                                && handle.info().command()
                                        .map(command -> command
                                                .contains("node"))
                                        .orElse(true)).orElse(false);
                Thread.sleep(100);
            }
            assertTrue(!alive,
                    "worker " + worker
                            + " survived a JVM exit inside its release grace"
                            + " window; harness log: " + logTail(harnessLog));
        } finally {
            if (harness.isAlive()) {
                harness.destroyForcibly();
            }
            // A failed assertion must not leave the wedged worker behind -
            // and must not kill an unrelated process holding a recycled pid.
            ProcessHandle.of(worker)
                    .filter(handle -> handle.info().command()
                            .map(command -> command.contains("node"))
                            .orElse(false))
                    .ifPresent(ProcessHandle::destroyForcibly);
            Files.deleteIfExists(harnessLog);
        }
    }

    /** The pid the harness printed, or -1 when it never got that far. */
    private static long reportedWorker(Path log) {
        try {
            return Files.readAllLines(log).stream()
                    .filter(line -> line.startsWith("worker-pid "))
                    .map(line -> line.substring("worker-pid ".length()).trim())
                    .mapToLong(Long::parseLong).findFirst().orElse(-1L);
        } catch (Exception unreadable) {
            return -1;
        }
    }

    /**
     * Harness JVM: releases a worker that ignores SIGTERM and exits at once,
     * inside the escalation's grace window, so only the shutdown hook can
     * still reclaim it.
     */
    public static final class ReleaseGraceHarnessMain {
        public static void main(String[] args) throws Exception {
            LocalProcessRuntimeProvisioner provisioner =
                    new LocalProcessRuntimeProvisioner(
                            List.of("node", args[0], "--ignore-term"),
                            Path.of(".").toAbsolutePath(),
                            new HttpRuntimeTransport());
            RuntimeLease lease = provisioner
                    .provision(ManagedContextProtocolTest.request(),
                            ManagedContextProtocolTest.seed())
                    .toCompletableFuture().join();
            long worker = ProcessHandle.current().children()
                    .map(ProcessHandle::pid).findFirst().orElse(-1L);
            System.out.println("worker-pid " + worker);
            System.out.flush();
            provisioner.release(ManagedContextProtocolTest.request(), lease)
                    .toCompletableFuture().join();
            // Exit inside the 5s grace window. The hook's snapshot is what
            // keeps this JVM alive until the reclaim completes, and what
            // issues the forcible destroy: with the worker untracked the JVM
            // halts at once, the daemon escalation dies mid-wait, and a
            // worker ignoring SIGTERM keeps running.
            System.exit(0);
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
     * Harness JVM: starts provisioning a silent worker, waits for the test
     * to signal that it has been observed, and then exits mid-handshake on
     * its own so the shutdown hooks run.
     */
    public static final class ExitHarnessMain {
        public static void main(String[] args) throws Exception {
            Path exitSignal = Path.of(args[0]);
            LocalProcessRuntimeProvisioner provisioner =
                    new LocalProcessRuntimeProvisioner(
                            List.of("node", "-e", "setInterval(() => {}, 1000)"),
                            Path.of(".").toAbsolutePath(),
                            new HttpRuntimeTransport());
            provisioner.provision(ManagedContextProtocolTest.request(),
                    ManagedContextProtocolTest.seed());
            // The worker never prints a ready line, so it stays in `starting`
            // for as long as this JVM lives. The deadline only bounds a
            // harness the test abandoned.
            Instant giveUp = Instant.now().plusSeconds(60);
            while (!Files.exists(exitSignal)
                    && Instant.now().isBefore(giveUp)) {
                Thread.sleep(50);
            }
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
