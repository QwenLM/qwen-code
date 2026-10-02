package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

/**
 * Regression coverage for the code-audit findings of issue #13183: the
 * release decision and the no-active-execution check commit in one
 * transaction, renewals run on their own pool, v3 result polling backs off,
 * UNKNOWN observations carry a cooldown, non-loopback listen addresses are
 * refused unless opted in, a LOST reclaim drains the whole generation, and
 * a released worker that ignores SIGTERM is destroyed forcibly.
 */
class Issue13183RegressionTest {
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant",
            "workspace", "generation", "/workspace", "capability",
            "workspace");
    private static final RuntimeResourceHandle HANDLE =
            new RuntimeResourceHandle("test-scheduler", 1,
                    Map.of("resourceId", "runtime-resource"));

    /**
     * Finding 1: an admission committed between another process's snapshot
     * read and its release transition must block the release. The
     * transition takes the Session row lock admission also takes and
     * re-checks executions in the same transaction, so the gap is closed
     * for two Broker processes sharing one database.
     */
    @Test
    void admissionBetweenCheckAndCasBlocksCrossProcessRelease() {
        DataSource dataSource = dataSource("race");
        JdbcRuntimeBindingRepository bindingsA = new JdbcRuntimeBindingRepository(
                dataSource, protector("race"), () -> "race-binding");
        JdbcRuntimeSessionRepository sessionsA = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executionsA = new JdbcToolExecutionRepository(
                dataSource);
        RuntimeRecoveryContract.Fixture fixture = new RuntimeRecoveryContract.Fixture(
                bindingsA, sessionsA, executionsA, "race");
        RuntimeBindingRecord binding = fixture.binding;
        RuntimeSessionRecord session = fixture.session;

        // Process B: a second, independent repository stack over the same
        // database. The service's synchronized(context) does not span it.
        JdbcRuntimeBindingRepository bindingsB = new JdbcRuntimeBindingRepository(
                dataSource, protector("race"));
        JdbcRuntimeSessionRepository sessionsB = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executionsB = new JdbcToolExecutionRepository(
                dataSource);
        RuntimeScope scope = binding.getRequest().getScope();
        String sessionId = session.getRuntimeSessionId();

        // B's snapshot, exactly as releaseSession reads it before the
        // transition.
        RuntimeSessionRecord expected = sessionsB.findById(scope, sessionId);
        assertEquals(RuntimeSessionRecord.State.READY, expected.getState());

        // A admits an execution in the gap.
        ToolExecutionRecord admitted = fixture.prepare("racing");
        assertEquals(ToolExecutionRecord.State.PREPARED, admitted.getState());

        // B's transition re-checks executions under the Session row lock
        // and refuses.
        RuntimeBrokerException busy = assertThrows(RuntimeBrokerException.class,
                () -> bindingsB.beginSessionRelease(sessionsB, executionsB,
                        expected));
        assertEquals("runtime_session_busy", busy.getCode());
        assertEquals(RuntimeSessionRecord.State.READY,
                sessionsB.findById(scope, sessionId).getState());
        assertTrue(executionsB.hasActiveByRuntimeSession(
                binding.getBindingId(), binding.getGeneration(), sessionId));

        // Reverse order: once B holds RELEASING, A's admission is refused.
        ToolExecutionRecord claimed = executionsA.claimDispatch(
                admitted.getExecutionCallId(), "dispatcher",
                Duration.ofMinutes(5));
        assertNotNull(claimed);
        ToolExecutionRecord settled = executionsA.compareAndSet(claimed,
                claimed.withResult(Map.of("executionStatus", "success"), 1,
                        Instant.now()),
                "dispatcher", claimed.getDispatchGeneration());
        assertNotNull(settled);
        RuntimeSessionRecord releasing = bindingsB.beginSessionRelease(
                sessionsB, executionsB, expected);
        assertEquals(RuntimeSessionRecord.State.RELEASING, releasing.getState());
        assertEquals(expected.getVersion() + 1, releasing.getVersion());
        RuntimeBrokerException closed = assertThrows(RuntimeBrokerException.class,
                () -> fixture.prepare("late"));
        assertEquals("runtime_admission_closed", closed.getCode());

        // A stale snapshot loses the CAS; the current RELEASING row is
        // handed back idempotently.
        assertNull(bindingsB.beginSessionRelease(sessionsB, executionsB,
                expected));
        RuntimeSessionRecord again = bindingsB.beginSessionRelease(sessionsB,
                executionsB, releasing);
        assertEquals(RuntimeSessionRecord.State.RELEASING, again.getState());
        assertEquals(releasing.getVersion(), again.getVersion());
    }

    /**
     * Control for finding 1: a committed admission is visible to the
     * release guard when the check runs after the commit.
     */
    @Test
    void releaseGuardSeesAdmissionWhenCheckedAfterCommit() {
        DataSource dataSource = dataSource("control");
        JdbcRuntimeBindingRepository bindings = new JdbcRuntimeBindingRepository(
                dataSource, protector("control"), () -> "control-binding");
        JdbcRuntimeSessionRepository sessions = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executions = new JdbcToolExecutionRepository(
                dataSource);
        RuntimeRecoveryContract.Fixture fixture = new RuntimeRecoveryContract.Fixture(
                bindings, sessions, executions, "control");
        fixture.prepare("settled-order");
        assertTrue(executions.hasActiveByRuntimeSession(
                fixture.binding.getBindingId(), fixture.binding.getGeneration(),
                fixture.session.getRuntimeSessionId()));
    }

    /**
     * Medium cluster: a LOST generation with more sessions than three
     * bounded 100-row passes could drain must still be reclaimed in one
     * warm. The service loops the bounded passes under a renewed claim
     * instead of answering 503 runtime_broker_runtime_lost.
     */
    @Test
    void lostReclaimDrainsAWholeGeneration() throws Exception {
        DataSource dataSource = dataSource("reclaim");
        JdbcRuntimeBindingRepository bindings = new JdbcRuntimeBindingRepository(
                dataSource, protector("reclaim"));
        JdbcRuntimeSessionRepository sessions = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executions = new JdbcToolExecutionRepository(
                dataSource);

        RuntimeBindingRecord first;
        try (RuntimeBrokerService service = reclaimService(
                new ReclaimProvisioner(), bindings, sessions, executions,
                "broker-one")) {
            first = service.warm("harness").toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            assertEquals(RuntimeBindingRecord.State.READY, first.getState());
        }
        for (int index = 0; index < 303; index++) {
            bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession("harness", "extra-" + index,
                            "bootstrap", first.getRequest().getScope()),
                    first.getBindingId(), first.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        }
        assertEquals(303, sessions.countActiveByBinding(first.getBindingId(),
                first.getGeneration()));

        try (RuntimeBrokerService service = reclaimService(
                new ReclaimProvisioner(), bindings, sessions, executions,
                "broker-two")) {
            RuntimeBindingRecord reclaimed = service.warm("harness")
                    .toCompletableFuture().get(20, TimeUnit.SECONDS);
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
     * Finding 3: the HTTP face refuses a wildcard or otherwise non-loopback
     * listen address unless the deployment explicitly opts in; loopback is
     * the default and keeps the single-token guard.
     */
    @Test
    void nonLoopbackListenAddressIsRefusedWithoutOptIn() throws Exception {
        RuntimeBrokerService refused = httpService(new NoopTransport());
        try {
            IllegalArgumentException wildcard = assertThrows(
                    IllegalArgumentException.class,
                    () -> new RuntimeBrokerHttpServer(
                            new InetSocketAddress("0.0.0.0", 0), "secret",
                            refused));
            assertTrue(wildcard.getMessage().contains("non-loopback"),
                    wildcard.getMessage());
            assertThrows(IllegalArgumentException.class,
                    () -> new RuntimeBrokerHttpServer(
                            InetSocketAddress.createUnresolved(
                                    "broker.internal", 4182),
                            "secret", refused));
        } finally {
            refused.close();
        }

        // The explicit opt-in binds for deployments that terminate TLS and
        // authorize callers in front.
        try (RuntimeBrokerHttpServer optedIn = new RuntimeBrokerHttpServer(
                new InetSocketAddress("0.0.0.0", 0), "secret",
                httpService(new NoopTransport()), true)) {
            optedIn.start();
            assertTrue(InetAddress.getByName(optedIn.getBaseUri().getHost())
                    .isAnyLocalAddress());
        }

        try (RuntimeBrokerHttpServer loopback = new RuntimeBrokerHttpServer(
                new InetSocketAddress("127.0.0.1", 0), "secret",
                httpService(new NoopTransport()))) {
            loopback.start();
            HttpClient client = HttpClient.newHttpClient();
            try {
                HttpResponse<String> warm = client.send(
                        HttpRequest.newBuilder(warmUri(loopback))
                                .header("Authorization", "Bearer secret")
                                .header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString(
                                        "{\"protocolVersion\":1,"
                                                + "\"requestId\":\"warm-1\","
                                                + "\"harnessSessionId\":\"alice\"}"))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
                assertEquals(200, warm.statusCode(), warm.body());
                HttpResponse<String> anonymous = client.send(
                        HttpRequest.newBuilder(warmUri(loopback))
                                .header("Content-Type", "application/json")
                                .POST(HttpRequest.BodyPublishers.ofString(
                                        "{\"protocolVersion\":1,"
                                                + "\"requestId\":\"warm-2\","
                                                + "\"harnessSessionId\":\"alice\"}"))
                                .build(),
                        HttpResponse.BodyHandlers.ofString());
                assertEquals(401, anonymous.statusCode());
            } finally {
                client.close();
            }
        }
    }

    /**
     * Finding 2: renewals run on their own pool, so one binding's stalled
     * renewal fences only that binding — an unrelated binding keeps
     * renewing and provisions.
     */
    @Test
    void stalledRenewalDoesNotFenceUnrelatedBinding() throws Exception {
        DataSource dataSource = dataSource("scheduler");
        AtomicBoolean stall = new AtomicBoolean(true);
        CountDownLatch stallEntered = new CountDownLatch(1);
        AtomicReference<String> renewalThread = new AtomicReference<>();
        DelegatingBindingRepository bindings = new DelegatingBindingRepository(
                new JdbcRuntimeBindingRepository(dataSource,
                        protector("scheduler"))) {
            @Override
            public RuntimeBindingRecord renewOperation(String bindingId,
                    String owner, long operationGeneration,
                    Duration leaseDuration) {
                renewalThread.compareAndSet(null,
                        Thread.currentThread().getName());
                if (stall.get()) {
                    stall.set(false);
                    stallEntered.countDown();
                    try {
                        Thread.sleep(6000);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
                return delegate.renewOperation(bindingId, owner,
                        operationGeneration, leaseDuration);
            }
        };
        ScheduledExecutorService delayer = Executors
                .newSingleThreadScheduledExecutor();
        // Session isolation gives each Harness Session its own binding, so
        // the two warms exercise two independent claims.
        RuntimeBrokerService service = new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(new RuntimeScope(
                        "tenant-scheduler", "workspace", "generation",
                        "/workspace", "capability", "session")),
                new DelayedProvisioner(delayer), new NoopTransport(), bindings,
                new JdbcRuntimeSessionRepository(dataSource),
                new JdbcToolExecutionRepository(dataSource),
                "broker", Duration.ofSeconds(3), Duration.ofSeconds(3));
        try {
            // Binding one's renewal tick at T+1s parks one renewal-pool
            // thread for 6s; its own provisioning fences when its claim
            // lapses.
            CompletionStage<RuntimeBindingRecord> first = service.warm("one");
            assertTrue(stallEntered.await(5, TimeUnit.SECONDS),
                    "first renewal tick never entered the repository");
            assertEquals("qwen-runtime-broker-lease-renewal",
                    renewalThread.get());
            Thread.sleep(300);
            // Binding two's ticks run on the other renewal thread: its
            // claim survives until its provisioning answers at T+8s.
            CompletionStage<RuntimeBindingRecord> second = service.warm("two");
            assertEquals("runtime_provision_fenced", failureCode(first));
            assertEquals(RuntimeBindingRecord.State.READY, second
                    .toCompletableFuture().get(20, TimeUnit.SECONDS)
                    .getState());
        } finally {
            service.close();
            delayer.shutdownNow();
        }
    }

    /**
     * Finding 2 (lookupOnce): sequential UNKNOWN observations inside the
     * cooldown share the one worker lookup instead of fanning through; the
     * next observation after the cooldown asks the worker again.
     */
    @Test
    void unknownObservationsCooldownAfterFirstLookup() throws Exception {
        try (UnknownObservationHarness harness = new UnknownObservationHarness();
                HttpClient client = HttpClient.newHttpClient()) {
            for (int index = 0; index < 3; index++) {
                assertEquals(409, observeUnknown(harness.server, client,
                        harness.prepared, harness.runtime, index)
                        .statusCode());
            }
            assertEquals(1, harness.transport.statusCalls.get(),
                    "sequential observations inside the cooldown must"
                            + " share the one worker lookup");

            harness.clock.advance(Duration.ofSeconds(2));
            assertEquals(409, observeUnknown(harness.server, client,
                    harness.prepared, harness.runtime, 3).statusCode());
            assertEquals(2, harness.transport.statusCalls.get(),
                    "the first observation past the cooldown asks the"
                            + " worker again");
        }
    }

    /**
     * A lookup that failed (the Runtime was unreachable) cools the same
     * window: hammering a worker that cannot answer changes nothing.
     */
    @Test
    void failedUnknownLookupCoolsDownLikeACompletedOne() throws Exception {
        try (UnknownObservationHarness harness = new UnknownObservationHarness();
                HttpClient client = HttpClient.newHttpClient()) {
            harness.transport.failStatus = true;
            for (int index = 0; index < 3; index++) {
                assertEquals(409, observeUnknown(harness.server, client,
                        harness.prepared, harness.runtime, index)
                        .statusCode());
            }
            assertEquals(1, harness.transport.statusCalls.get(),
                    "a failed lookup also cools sequential observations");

            harness.clock.advance(Duration.ofSeconds(2));
            assertEquals(409, observeUnknown(harness.server, client,
                    harness.prepared, harness.runtime, 3).statusCode());
            assertEquals(2, harness.transport.statusCalls.get());
        }
    }

    /**
     * An explicit {@code reconcile=true} asks the Runtime every time, even
     * inside the automatic observation's cooldown window.
     */
    @Test
    void explicitReconcileBypassesTheCooldown() throws Exception {
        try (UnknownObservationHarness harness = new UnknownObservationHarness();
                HttpClient client = HttpClient.newHttpClient()) {
            assertEquals(409, observeUnknown(harness.server, client,
                    harness.prepared, harness.runtime, 0).statusCode());
            assertEquals(1, harness.transport.statusCalls.get());
            URI uri = harness.server.getBaseUri().resolve(
                    RuntimeBrokerHttpServer.ROUTE_PREFIX + "/executions/"
                            + harness.prepared.getExecutionCallId()
                            + "?requestId=explicit&harnessSessionId=harness"
                            + "&runtimeSessionId=" + harness.runtime
                            + "&reconcile=true");
            HttpResponse<String> response = client.send(
                    HttpRequest.newBuilder(uri)
                            .header("Authorization", "Bearer secret").GET()
                            .build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(409, response.statusCode(), response.body());
            assertEquals(2, harness.transport.statusCalls.get(),
                    "an explicit reconcile is never cooled");
        }
    }

    /**
     * Finding 2 (v3 polling): result polling backs off exponentially from
     * 100ms instead of pinning two repository reads and one worker call at
     * 10/s for the whole window.
     */
    @Test
    void v3ResultPollingBacksOff() throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\"}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(
                        payload.getBytes(StandardCharsets.UTF_8)));
        RuntimePublicationVerifier verifier = new RuntimePublicationVerifier() {
            @Override
            public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                    String id, String token) {
                return new RuntimePublicationGrant(id, token,
                        "https://publisher.test",
                        Map.of("sessionKey", Map.of("tenantId", "tenant",
                                        "sessionId", "managed"),
                                "turnId", "prompt", "executionCallId",
                                execution.getExecutionCallId(),
                                "bindingGeneration", "1"));
            }
        };
        V3Transport transport = new V3Transport();
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(SCOPE),
                new StaticRuntimeProvisioner(new RuntimeLease("instance",
                        URI.create("http://127.0.0.1:1234"), "token", "lease",
                        1)),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(Clock.systemUTC()),
                "broker", Duration.ofMinutes(1), Duration.ofMinutes(1),
                verifier)) {
            service.acquire("harness", "runtime", "bootstrap")
                    .toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", "runtime",
                    "promptId", "prompt", "callId", "call", "argsDigest",
                    "sha256:" + "a".repeat(64));
            ToolExecutionRecord prepared = service.prepareExecution("harness",
                    "runtime", "key", reference, digest, "pub-1")
                    .toCompletableFuture().join();
            // Never settles: the dispatch drives result polling until the
            // window closes, which the test never waits for.
            service.startExecution("harness", "runtime",
                    prepared.getExecutionCallId(), payload, "pub-1", "token");

            await(() -> transport.statusV3Nanos.size() >= 4,
                    Duration.ofSeconds(10));
            List<Long> times = transport.statusV3Nanos;
            long firstGap = times.get(1) - times.get(0);
            long secondGap = times.get(2) - times.get(1);
            long thirdGap = times.get(3) - times.get(2);
            assertTrue(firstGap >= Duration.ofMillis(90).toNanos(),
                    "first retry must stay prompt: " + firstGap);
            assertTrue(secondGap >= Duration.ofMillis(190).toNanos(),
                    "second retry must double: " + secondGap);
            assertTrue(thirdGap >= Duration.ofMillis(390).toNanos(),
                    "third retry must double again: " + thirdGap);
        }
    }

    /**
     * Medium cluster: a released worker that ignores SIGTERM is destroyed
     * forcibly after the grace window instead of leaking.
     */
    @Test
    void releaseEscalatesToForcibleDestroyWhenWorkerIgnoresSigterm()
            throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        Set<Long> before = childPids();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString(), "--ignore-term"),
                        Path.of(".").toAbsolutePath(),
                        new HttpRuntimeTransport())) {
            RuntimeLease lease = provisioner.provision(
                    ManagedContextProtocolTest.request(),
                    ManagedContextProtocolTest.seed()).toCompletableFuture()
                    .get(10, TimeUnit.SECONDS);
            long worker = childPids().stream()
                    .filter(pid -> !before.contains(pid)).findFirst()
                    .orElseThrow(() -> new AssertionError("no worker child"));
            assertTrue(ProcessHandle.of(worker).orElseThrow().isAlive());
            provisioner.release(ManagedContextProtocolTest.request(), lease)
                    .toCompletableFuture().get(5, TimeUnit.SECONDS);
            await(() -> ProcessHandle.of(worker).map(process -> !process.isAlive())
                    .orElse(true), Duration.ofSeconds(10));
        }
    }

    /**
     * The same escalation runs from close() (a wedged worker that was never
     * released), not only from release().
     */
    @Test
    void closeEscalatesToForcibleDestroyWhenWorkerIgnoresSigterm()
            throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        Set<Long> before = childPids();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString(), "--ignore-term"),
                        Path.of(".").toAbsolutePath(),
                        new HttpRuntimeTransport());
        provisioner.provision(ManagedContextProtocolTest.request(),
                ManagedContextProtocolTest.seed()).toCompletableFuture()
                .get(10, TimeUnit.SECONDS);
        long worker = childPids().stream()
                .filter(pid -> !before.contains(pid)).findFirst()
                .orElseThrow(() -> new AssertionError("no worker child"));
        provisioner.close();
        await(() -> ProcessHandle.of(worker).map(process -> !process.isAlive())
                .orElse(true), Duration.ofSeconds(10));
    }

    private static HttpResponse<String> observeUnknown(
            RuntimeBrokerHttpServer server, HttpClient client,
            ToolExecutionRecord prepared, String runtime, int index)
            throws IOException, InterruptedException {
        URI uri = server.getBaseUri().resolve(
                RuntimeBrokerHttpServer.ROUTE_PREFIX + "/executions/"
                        + prepared.getExecutionCallId() + "?requestId=obs-"
                        + index + "&harnessSessionId=harness"
                        + "&runtimeSessionId=" + runtime);
        HttpResponse<String> response = client.send(
                HttpRequest.newBuilder(uri)
                        .header("Authorization", "Bearer secret").GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertTrue(response.body().contains("runtime_broker_execution_unknown"),
                response.body());
        return response;
    }

    private static RuntimeBrokerService reclaimService(
            RuntimeProvisioner provisioner, RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String owner) {
        return new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                provisioner, new AttestingTransport(), bindings, sessions,
                executions, owner, Duration.ofSeconds(3),
                Duration.ofSeconds(3));
    }

    private static RuntimeBrokerService httpService(RuntimeTransport transport) {
        return new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(new RuntimeScope(
                        "tenant-" + harnessId, "workspace", "generation",
                        "/workspace", "capability", "workspace")),
                new StaticRuntimeProvisioner(new RuntimeLease("instance",
                        URI.create("http://127.0.0.1:1234"), "token", "lease",
                        1)),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(Clock.systemUTC()),
                "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
    }

    private static String failureCode(CompletionStage<?> stage) {
        CompletionException failure = assertThrows(CompletionException.class,
                () -> stage.toCompletableFuture().join());
        Throwable cause = failure.getCause();
        assertTrue(cause instanceof RuntimeBrokerException,
                () -> "unexpected failure " + cause);
        return ((RuntimeBrokerException) cause).getCode();
    }

    private static URI warmUri(RuntimeBrokerHttpServer server) {
        return server.getBaseUri().resolve(
                RuntimeBrokerHttpServer.ROUTE_PREFIX + "/runtimes:warm");
    }

    private static DataSource dataSource(String name) {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:issue13183-" + name + "-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1");
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

    private static Set<Long> childPids() {
        return ProcessHandle.current().children().map(ProcessHandle::pid)
                .collect(Collectors.toSet());
    }

    private static void await(CheckedCondition condition, Duration timeout)
            throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (condition.evaluate()) {
                return;
            }
            Thread.sleep(10);
        }
        assertTrue(condition.evaluate(), "condition did not become true");
    }

    @FunctionalInterface
    private interface CheckedCondition {
        boolean evaluate() throws Exception;
    }

    private static final class DelayedProvisioner implements RuntimeProvisioner {
        private final ScheduledExecutorService delayer;
        private final AtomicInteger provisions = new AtomicInteger();

        DelayedProvisioner(ScheduledExecutorService delayer) {
            this.delayer = delayer;
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            int order = provisions.incrementAndGet();
            long delayMillis = order == 1 ? 2500 : 8000;
            CompletableFuture<RuntimeLease> lease = new CompletableFuture<>();
            delayer.schedule(() -> lease.complete(new RuntimeLease(
                    "instance-" + order, URI.create("http://127.0.0.1:1234"),
                    "token-" + order, "lease-" + order, order)),
                    delayMillis, TimeUnit.MILLISECONDS);
            return lease;
        }

        @Override
        public String kind() {
            return "static";
        }
    }

    private static final class ReclaimProvisioner implements RuntimeProvisioner {
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
            return CompletableFuture.completedFuture(RuntimeObservation.notFound(
                    proof(seed, handle, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    proof(seed, handle,
                            RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED)));
        }

        private static RuntimeRecoveryEvidence proof(RuntimeProvisionSeed seed,
                RuntimeResourceHandle handle,
                RuntimeRecoveryEvidence.Fact fact) {
            return new RuntimeRecoveryEvidence(UUID.randomUUID().toString(),
                    fact, "test-supervisor", Instant.now(), "test-host/domain",
                    seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(),
                    seed.getGatewayIncarnation(), seed.getLeaseId(),
                    seed.getEpoch(), handle);
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

    private static final class CountingTransport extends NoopTransport {
        private final AtomicInteger statusCalls = new AtomicInteger();
        private volatile boolean failExecutions;
        private volatile boolean failStatus;

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            if (failExecutions) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(
                        503, "managed_runtime_unavailable",
                        "Runtime is unavailable", true));
            }
            return super.execute(lease, session, reference);
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            statusCalls.incrementAndGet();
            if (failStatus) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(
                        503, "managed_runtime_unavailable",
                        "Runtime is unavailable", true));
            }
            return CompletableFuture.completedFuture(Map.of("state",
                    "unknown"));
        }
    }

    /**
     * One UNKNOWN execution behind a loopback HTTP face, with a mutable
     * service clock so the cooldown window can lapse without sleeping.
     */
    private static final class UnknownObservationHarness
            implements AutoCloseable {
        private final MutableClock clock = new MutableClock();
        private final CountingTransport transport = new CountingTransport();
        private final String runtime =
                "550e8400-e29b-41d4-a716-446655440302";
        private final RuntimeBrokerHttpServer server;
        private final ToolExecutionRecord prepared;

        UnknownObservationHarness() throws IOException {
            RuntimeBrokerService service = new RuntimeBrokerService(
                    harnessId -> CompletableFuture.completedFuture(
                            new RuntimeScope("tenant-cooldown", "workspace",
                                    "generation", "/workspace", "capability",
                                    "workspace")),
                    new StaticRuntimeProvisioner(new RuntimeLease("instance",
                            URI.create("http://127.0.0.1:1234"), "token",
                            "lease", 1)),
                    transport, new InMemoryRuntimeBindingRepository(),
                    new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(Clock.systemUTC()),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1),
                    clock, () -> UUID.randomUUID().toString());
            server = new RuntimeBrokerHttpServer(
                    new InetSocketAddress("127.0.0.1", 0), "secret", service);
            try {
                server.start();
            } catch (RuntimeException failure) {
                service.close();
                throw failure;
            }
            service.acquire("harness", runtime, "bootstrap")
                    .toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", runtime,
                    "promptId", "turn", "callId", "call", "capabilityDigest",
                    "a".repeat(64), "policyRevision", "policy", "invocationId",
                    "invocation", "argsDigest", "b".repeat(64));
            prepared = service.prepareExecution("harness", runtime, "key",
                    reference).toCompletableFuture().join();
            transport.failExecutions = true;
            service.startExecution("harness", runtime,
                    prepared.getExecutionCallId()).toCompletableFuture().join();
            // The dispatch answer was lost, so the record flips to UNKNOWN;
            // markUnknown runs inside the failed invocation's handle.
            Instant giveUp = Instant.now().plusSeconds(5);
            while (service.getExecution("harness", runtime,
                    prepared.getExecutionCallId()).toCompletableFuture().join()
                    .getState() != ToolExecutionRecord.State.UNKNOWN) {
                if (!Instant.now().isBefore(giveUp)) {
                    throw new IllegalStateException(
                            "execution never went UNKNOWN");
                }
                try {
                    Thread.sleep(20);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(interrupted);
                }
            }
        }

        @Override
        public void close() {
            server.close();
        }
    }

    private static final class V3Transport extends NoopTransport {
        private final List<Long> statusV3Nanos =
                Collections.synchronizedList(new ArrayList<>());

        @Override
        public CompletionStage<Void> installPublication(RuntimeLease lease,
                RuntimeSession session, RuntimePublicationGrant grant) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                Map<String, Object> payload, Map<String, Object> capture) {
            return CompletableFuture.completedFuture(Map.of("state",
                    "executing"));
        }

        @Override
        public CompletionStage<Map<String, Object>> statusV3(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference,
                long afterSequence) {
            statusV3Nanos.add(System.nanoTime());
            return CompletableFuture.completedFuture(Map.of("state",
                    "executing"));
        }
    }

    private static final class MutableClock extends Clock {
        private Instant now = Instant.now();

        @Override
        public ZoneId getZone() {
            return ZoneId.of("UTC");
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }
    }
}
