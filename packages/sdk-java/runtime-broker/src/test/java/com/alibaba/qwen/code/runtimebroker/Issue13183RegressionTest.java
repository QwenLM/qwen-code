package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

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
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
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
import java.util.stream.IntStream;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;

/**
 * Regression coverage for the code-audit findings of issue #13183: the
 * release decision and the no-active-execution check commit in one
 * transaction, renewals run on their own pool, v3 result polling backs off,
 * UNKNOWN observations carry a cooldown, non-loopback listen addresses are
 * refused unless opted in, a LOST reclaim drains the whole generation, and
 * a released worker that ignores SIGTERM is destroyed forcibly.
 */
@org.junit.jupiter.api.Timeout(180)
class Issue13183RegressionTest {
    // Shared with Issue13183AdversarialTest.
    static final RuntimeScope SCOPE = new RuntimeScope("tenant",
            "workspace", "generation", "/workspace", "capability",
            "workspace");
    static final RuntimeResourceHandle HANDLE =
            new RuntimeResourceHandle("test-scheduler", 1,
                    Map.of("resourceId", "runtime-resource"));
    // destroy() is a SIGTERM on POSIX and an outright kill on Windows, so
    // only POSIX has a grace window that --ignore-term can survive.
    static final boolean DESTROY_IS_SIGTERM = !System
            .getProperty("os.name", "")
            .toLowerCase(Locale.ROOT).contains("windows");

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
     * Dispatch lease renewals run on the dedicated renewal pool too, so one
     * stalled binding renewal does not starve them. The pool has two
     * threads, which bounds that to two simultaneous stalls and no more.
     */
    @Test
    void dispatchRenewalsRunOnTheRenewalPool() throws Exception {
        AtomicReference<String> renewalThread = new AtomicReference<>();
        DelegatingToolExecutionRepository executions =
                new DelegatingToolExecutionRepository(
                        new InMemoryToolExecutionRepository(
                                Clock.systemUTC())) {
                    @Override
                    public ToolExecutionRecord renewDispatch(
                            String executionCallId, String owner,
                            long dispatchGeneration, Duration leaseDuration) {
                        renewalThread.compareAndSet(null,
                                Thread.currentThread().getName());
                        return super.renewDispatch(executionCallId, owner,
                                dispatchGeneration, leaseDuration);
                    }
                };
        CompletableFuture<Map<String, Object>> executing =
                new CompletableFuture<>();
        NoopTransport transport = new NoopTransport() {
            @Override
            public CompletionStage<Map<String, Object>> execute(
                    RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> reference) {
                return executing;
            }
        };
        String runtime = "550e8400-e29b-41d4-a716-446655440399";
        RuntimeBrokerService service = new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(
                        new RuntimeScope("tenant-dispatch", "workspace",
                                "generation", "/workspace", "capability",
                                "workspace")),
                new StaticRuntimeProvisioner(new RuntimeLease("instance",
                        URI.create("http://127.0.0.1:1234"), "token",
                        "lease", 1)),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(), executions, "broker",
                Duration.ofMinutes(1), Duration.ofSeconds(3));
        try {
            service.acquire("harness", runtime, "bootstrap")
                    .toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", runtime,
                    "promptId", "turn", "callId", "call", "capabilityDigest",
                    "a".repeat(64), "policyRevision", "policy",
                    "invocationId", "invocation", "argsDigest",
                    "b".repeat(64));
            ToolExecutionRecord prepared = service.prepareExecution("harness",
                    runtime, "key", reference)
                    .toCompletableFuture().join();
            // The dispatch stays in flight, so its lease renewal ticks.
            service.startExecution("harness", runtime,
                    prepared.getExecutionCallId());
            await(() -> renewalThread.get() != null, Duration.ofSeconds(10));
            assertEquals("qwen-runtime-broker-lease-renewal",
                    renewalThread.get());
        } finally {
            executing.complete(Map.of("executionStatus", "success"));
            service.close();
        }
    }

    /**
     * close() must shut the renewal pool down, not only cancel its tasks: a
     * renewal tick cancels itself once the service is closed, but a pool's
     * threads exit only on shutdown, so a deployment that rebuilds the
     * service would otherwise leak them per instance.
     */
    @Test
    void closeStopsTheRenewalPool() throws Exception {
        Set<Long> before =
                liveThreadIds("qwen-runtime-broker-lease-renewal");
        CompletableFuture<Map<String, Object>> executing =
                new CompletableFuture<>();
        NoopTransport transport = new NoopTransport() {
            @Override
            public CompletionStage<Map<String, Object>> execute(
                    RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> reference) {
                return executing;
            }
        };
        String runtime = "550e8400-e29b-41d4-a716-446655440398";
        RuntimeBrokerService service = new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(SCOPE),
                new StaticRuntimeProvisioner(new RuntimeLease("instance",
                        URI.create("http://127.0.0.1:1234"), "token", "lease",
                        1)),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(Clock.systemUTC()),
                "broker", Duration.ofMinutes(1), Duration.ofSeconds(3));
        Set<Long> started = new HashSet<>();
        try {
            service.acquire("harness", runtime, "bootstrap")
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            Map<String, Object> reference = Map.of("sessionId", runtime,
                    "promptId", "turn", "callId", "call", "capabilityDigest",
                    "a".repeat(64), "policyRevision", "policy",
                    "invocationId", "invocation", "argsDigest",
                    "b".repeat(64));
            ToolExecutionRecord prepared = service.prepareExecution("harness",
                    runtime, "key", reference).toCompletableFuture().join();
            // The dispatch stays in flight, so its lease renewal ticks and
            // the pool has a thread to shut down.
            service.startExecution("harness", runtime,
                    prepared.getExecutionCallId());
            await(() -> !startedThreadIds(before,
                    "qwen-runtime-broker-lease-renewal").isEmpty(),
                    Duration.ofSeconds(10));
            started.addAll(startedThreadIds(before,
                    "qwen-runtime-broker-lease-renewal"));
        } finally {
            executing.complete(Map.of("executionStatus", "success"));
            service.close();
        }
        await(() -> Thread.getAllStackTraces().keySet().stream()
                .map(Thread::threadId).noneMatch(started::contains),
                Duration.ofSeconds(10));
    }

    private static Set<Long> liveThreadIds(String name) {
        Set<Long> ids = new HashSet<>();
        for (Thread thread : Thread.getAllStackTraces().keySet()) {
            if (name.equals(thread.getName())) {
                ids.add(thread.threadId());
            }
        }
        return ids;
    }

    /** The live threads with this name that were not there before. */
    private static Set<Long> startedThreadIds(Set<Long> before, String name) {
        Set<Long> live = liveThreadIds(name);
        live.removeAll(before);
        return live;
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
     * An Error is not a lookup answer. The takeover path and the HTTP face
     * both refuse to downgrade one, so the cooldown must not cache one
     * either: the next observation asks the Runtime again instead of being
     * served a synthetic UNRESOLVED answer built out of the failure.
     */
    @Test
    void anErrorDoesNotArmTheObservationCooldown() throws Exception {
        try (UnknownObservationHarness harness =
                new UnknownObservationHarness()) {
            String executionId = harness.prepared.getExecutionCallId();
            harness.transport.failStatusWithError = true;
            assertThrows(CompletionException.class, () -> harness.service
                    .observeExecution("harness", harness.runtime, executionId)
                    .toCompletableFuture().join());
            assertEquals(1, harness.transport.statusCalls.get());

            // Still inside the cooldown window: had the Error armed the
            // cache, this observation would be served from it and the worker
            // would never be asked again.
            harness.transport.failStatusWithError = false;
            harness.service.observeExecution("harness", harness.runtime,
                    executionId).toCompletableFuture().join();
            assertEquals(2, harness.transport.statusCalls.get(),
                    "an Error must not arm the observation cooldown");
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
     * A cached lookup whose own record already settled is replayed whole;
     * pairing its terminal answer with a caller's pre-settlement UNKNOWN
     * snapshot would report a settled execution as unknown.
     */
    @Test
    void cooledObservationNeverPairsASettledAnswerWithAStaleRecord()
            throws Exception {
        InMemoryToolExecutionRepository real =
                new InMemoryToolExecutionRepository(Clock.systemUTC());
        StaleReadExecutions executions = new StaleReadExecutions(real);
        try (UnknownObservationHarness harness =
                new UnknownObservationHarness(executions)) {
            String executionId = harness.prepared.getExecutionCallId();
            ToolExecutionRecord unknownSnapshot =
                    real.findByExecutionCallId(executionId);
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    unknownSnapshot.getState());

            // Observer A's lookup settles the execution and stamps the
            // cooldown.
            harness.transport.statusResult = Map.of("state", "settled",
                    "result", Map.of("executionStatus", "success"));
            ExecutionReconciliation first = harness.service
                    .observeExecution("harness", harness.runtime, executionId)
                    .toCompletableFuture().join();
            assertEquals(ExecutionReconciliation.Outcome.RESOLVED,
                    first.getOutcome());
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    first.getRecord().getState());

            // Observer B arrives inside the cooldown holding its
            // pre-settlement snapshot. No repository can produce that pair:
            // both backends refuse a CAS whose expectation is terminal and
            // always bump the version, so a settled record outranks any
            // snapshot taken before it settled and the version comparison
            // below already prefers the cache. B's snapshot is stamped with
            // the settled record's own version to pin the explicit
            // settled-cache branch anyway - it is what still holds the
            // invariant if that comparison is ever narrowed.
            ExecutionReconciliation second;
            executions.stale = unknownSnapshot.withVersion(
                    first.getRecord().getVersion());
            try {
                second = harness.service
                        .observeExecution("harness", harness.runtime,
                                executionId)
                        .toCompletableFuture().join();
            } finally {
                executions.stale = null;
            }
            assertEquals(ToolExecutionRecord.State.SETTLED,
                    second.getRecord().getState(),
                    "a settled answer must never ride a stale UNKNOWN record");
            assertEquals("success",
                    second.getRecord().getResult().get("executionStatus"));
        }
    }

    /**
     * While the cached record is still UNKNOWN, the replay serves the
     * fresher of the caller's snapshot and the lookup's own re-read — a
     * cancel landing between them must stay visible.
     */
    @Test
    void cooledObservationServesTheFresherUnknownRecord() throws Exception {
        InMemoryToolExecutionRepository real =
                new InMemoryToolExecutionRepository(Clock.systemUTC());
        StaleReadExecutions executions = new StaleReadExecutions(real);
        try (UnknownObservationHarness harness =
                new UnknownObservationHarness(executions)) {
            String executionId = harness.prepared.getExecutionCallId();
            // B's snapshot predates the cancel.
            ToolExecutionRecord preCancel =
                    real.findByExecutionCallId(executionId);
            assertTrue(!preCancel.isCancelRequested());
            ToolExecutionRecord cancelled = real.requestCancel(executionId,
                    preCancel.getVersion());
            assertNotNull(cancelled);
            assertTrue(cancelled.isCancelRequested());

            // A observes; the lookup's re-read carries the cancel.
            ExecutionReconciliation first = harness.service
                    .observeExecution("harness", harness.runtime, executionId)
                    .toCompletableFuture().join();
            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    first.getOutcome());
            assertTrue(first.getRecord().isCancelRequested());

            // B arrives inside the cooldown holding the pre-cancel snapshot.
            ExecutionReconciliation second;
            executions.stale = preCancel;
            try {
                second = harness.service
                        .observeExecution("harness", harness.runtime,
                                executionId)
                        .toCompletableFuture().join();
            } finally {
                executions.stale = null;
            }
            assertTrue(second.getRecord().isCancelRequested(),
                    "the fresher of the two UNKNOWN records must be served");
            assertEquals(cancelled.getVersion(),
                    second.getRecord().getVersion());
        }
    }

    /**
     * The other arm of the same rule: a cancel that lands after the cached
     * lookup makes the caller's own re-read the fresher UNKNOWN record, so
     * the replay must serve that record with the cached worker answer
     * instead of serving the cache's older record.
     */
    @Test
    void cooledObservationServesACancelThatLandsAfterTheCachedLookup()
            throws Exception {
        InMemoryToolExecutionRepository real =
                new InMemoryToolExecutionRepository(Clock.systemUTC());
        StaleReadExecutions executions = new StaleReadExecutions(real);
        try (UnknownObservationHarness harness =
                new UnknownObservationHarness(executions)) {
            String executionId = harness.prepared.getExecutionCallId();
            // A observes first; the cached record carries no cancel.
            ExecutionReconciliation first = harness.service
                    .observeExecution("harness", harness.runtime, executionId)
                    .toCompletableFuture().join();
            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    first.getOutcome());
            assertTrue(!first.getRecord().isCancelRequested());

            // The cancel lands inside the cooldown, after that lookup. It
            // keeps the record UNKNOWN, so the replay cannot take the
            // settled-cache branch.
            ToolExecutionRecord current =
                    real.findByExecutionCallId(executionId);
            ToolExecutionRecord cancelled = real.requestCancel(executionId,
                    current.getVersion());
            assertNotNull(cancelled);
            assertTrue(cancelled.isCancelRequested());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    cancelled.getState());

            // B observes with nothing injected: its own re-read is the
            // fresher record and must win over the cache.
            ExecutionReconciliation second = harness.service
                    .observeExecution("harness", harness.runtime, executionId)
                    .toCompletableFuture().join();
            assertEquals(ExecutionReconciliation.Outcome.UNRESOLVED,
                    second.getOutcome(),
                    "the cached worker answer is still the answer");
            assertTrue(second.getRecord().isCancelRequested(),
                    "a cancel after the cached lookup must stay visible");
            assertEquals(cancelled.getVersion(),
                    second.getRecord().getVersion());
        }
    }

    /** Serves one pre-settlement snapshot to the next reader. */
    private static final class StaleReadExecutions
            extends DelegatingToolExecutionRepository {
        private volatile ToolExecutionRecord stale;

        StaleReadExecutions(ToolExecutionRepository delegate) {
            super(delegate);
        }

        @Override
        public ToolExecutionRecord findByExecutionCallId(
                String executionCallId) {
            ToolExecutionRecord snapshot = stale;
            return snapshot != null ? snapshot
                    : super.findByExecutionCallId(executionCallId);
        }
    }

    /**
     * The cooldown is scoped per execution: a second UNKNOWN execution in
     * the same session is asked of the worker on its own first observation.
     */
    @Test
    void cooldownIsScopedPerExecution() throws Exception {
        try (UnknownObservationHarness harness = new UnknownObservationHarness();
                HttpClient client = HttpClient.newHttpClient()) {
            ToolExecutionRecord second = harness.prepareUnknown("key-2");
            assertEquals(409, observeUnknown(harness.server, client,
                    harness.prepared, harness.runtime, 0).statusCode());
            assertEquals(1, harness.transport.statusCalls.get());
            // A different execution is not covered by the first one's
            // cooldown.
            assertEquals(409, observeUnknown(harness.server, client, second,
                    harness.runtime, 1).statusCode());
            assertEquals(2, harness.transport.statusCalls.get(),
                    "each execution's first observation asks the worker");
            // The first execution is still cooled.
            assertEquals(409, observeUnknown(harness.server, client,
                    harness.prepared, harness.runtime, 2).statusCode());
            assertEquals(2, harness.transport.statusCalls.get());
        }
    }

    /**
     * The service's release path must reach the atomic transition: an
     * execution another process admits after the service's own pre-check
     * still blocks the release (issue #13183 item 1 through the service).
     */
    @Test
    void serviceReleaseRejectsARacingCrossProcessAdmission() throws Exception {
        DataSource dataSource = dataSource("wiring");
        JdbcRuntimeSessionRepository sessions = new JdbcRuntimeSessionRepository(
                dataSource);
        JdbcToolExecutionRepository executions = new JdbcToolExecutionRepository(
                dataSource);
        // The second Broker process's stack, sharing the database.
        JdbcRuntimeBindingRepository bindingsB =
                new JdbcRuntimeBindingRepository(dataSource,
                        protector("wiring"));
        JdbcRuntimeSessionRepository sessionsB =
                new JdbcRuntimeSessionRepository(dataSource);
        JdbcToolExecutionRepository executionsB =
                new JdbcToolExecutionRepository(dataSource);
        DelegatingBindingRepository bindings = new DelegatingBindingRepository(
                new JdbcRuntimeBindingRepository(dataSource,
                        protector("wiring"))) {
            @Override
            public RuntimeSessionRecord beginSessionRelease(
                    RuntimeSessionRepository sessionsArg,
                    ToolExecutionRepository executionsArg,
                    RuntimeSessionRecord expected) {
                // The racing admission lands after the service's pre-check,
                // committed by the other process before this transition's
                // in-transaction re-check reads.
                bindingsB.admitExecution(sessionsB, executionsB,
                        ToolExecutionRecord.prepared("racing-execution",
                                "racing-key", expected.getBindingId(),
                                expected.getRuntimeGeneration(), "harness",
                                expected.getRuntimeSessionId(), "turn",
                                "call", "digest",
                                Map.of("sessionId",
                                        expected.getRuntimeSessionId(),
                                        "promptId", "turn", "callId", "call",
                                        "argsDigest", "digest")));
                return super.beginSessionRelease(sessionsArg, executionsArg,
                        expected);
            }
        };
        RuntimeBrokerService service = new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(SCOPE),
                new StaticRuntimeProvisioner(new RuntimeLease("instance",
                        URI.create("http://127.0.0.1:1234"), "token", "lease",
                        1)),
                new NoopTransport(), bindings, sessions, executions,
                "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
        try {
            service.acquire("harness", "wiring-session", "bootstrap")
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            CompletionException failure = assertThrows(
                    CompletionException.class,
                    () -> service.release("harness", "wiring-session")
                            .toCompletableFuture().join());
            assertTrue(failure.getCause() instanceof RuntimeBrokerException);
            assertEquals("runtime_session_busy",
                    ((RuntimeBrokerException) failure.getCause()).getCode());
            RuntimeSessionRecord after = sessions.findById(SCOPE,
                    "wiring-session");
            assertEquals(RuntimeSessionRecord.State.READY, after.getState(),
                    "the racing admission must keep the session READY");
            assertTrue(executions.hasActiveByRuntimeSession(
                    after.getBindingId(), after.getRuntimeGeneration(),
                    "wiring-session"));
            // The refused release must leave the session's release path
            // usable: a retry re-runs the transition and answers the same
            // 409 instead of replaying a half-set release slot.
            CompletionException retry = assertThrows(
                    CompletionException.class,
                    () -> service.release("harness", "wiring-session")
                            .toCompletableFuture().join());
            assertTrue(retry.getCause() instanceof RuntimeBrokerException);
            assertEquals("runtime_session_busy",
                    ((RuntimeBrokerException) retry.getCause()).getCode());
        } finally {
            service.close();
        }
    }

    /**
     * A Session row already persisted as RELEASING — what a pre-fix peer
     * leaves behind when its unguarded check-then-act let an admission in
     * and its worker release then failed — must not complete its release
     * over a live execution: the re-entry short-circuits the guarded
     * transition, so it has to ask the execution repository itself. The
     * retry stays idempotent once nothing active is left.
     */
    @Test
    void releaseRetryOverAPersistedReleasingRowRefusesALiveExecution()
            throws Exception {
        InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        InMemoryRuntimeSessionRepository sessions =
                new InMemoryRuntimeSessionRepository();
        InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(Clock.systemUTC());
        AtomicInteger releaseCalls = new AtomicInteger();
        RuntimeTransport transport = new NoopTransport() {
            @Override
            public CompletionStage<Boolean> release(RuntimeLease lease,
                    RuntimeSession session) {
                releaseCalls.incrementAndGet();
                return CompletableFuture.completedFuture(true);
            }
        };
        RuntimeBrokerService service = new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(SCOPE),
                new StaticRuntimeProvisioner(new RuntimeLease("instance",
                        URI.create("http://127.0.0.1:1234"), "token", "lease",
                        1)),
                transport, bindings, sessions, executions, "broker",
                Duration.ofMinutes(1), Duration.ofMinutes(1));
        try {
            service.acquire("harness", "releasing-session", "bootstrap")
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            RuntimeSessionRecord ready = sessions.findById(SCOPE,
                    "releasing-session");
            bindings.admitExecution(sessions, executions,
                    ToolExecutionRecord.prepared("live-execution", "live-key",
                            ready.getBindingId(), ready.getRuntimeGeneration(),
                            "harness", ready.getRuntimeSessionId(), "turn",
                            "call", "digest",
                            Map.of("sessionId", ready.getRuntimeSessionId(),
                                    "promptId", "turn", "callId", "call",
                                    "argsDigest", "digest")));
            // The row an older peer persisted before its release failed.
            RuntimeSessionRecord releasing = sessions.compareAndSet(ready,
                    ready.withState(RuntimeSessionRecord.State.RELEASING,
                            Instant.now()));
            assertEquals(RuntimeSessionRecord.State.RELEASING,
                    releasing.getState());

            CompletionException failure = assertThrows(
                    CompletionException.class,
                    () -> service.release("harness", "releasing-session")
                            .toCompletableFuture().join());
            assertTrue(failure.getCause() instanceof RuntimeBrokerException);
            assertEquals("runtime_session_busy",
                    ((RuntimeBrokerException) failure.getCause()).getCode());
            assertEquals(RuntimeSessionRecord.State.RELEASING,
                    sessions.findById(SCOPE, "releasing-session").getState());
            assertEquals(0, releaseCalls.get(),
                    "the worker must not be released over a live execution");

            // With nothing active left, the same retry completes. Cancelling
            // a never-dispatched execution settles it at once.
            ToolExecutionRecord live = executions.findByExecutionCallId(
                    "live-execution");
            assertNotNull(executions.requestCancel("live-execution",
                    live.getVersion()));
            assertEquals(Boolean.TRUE, service.release("harness",
                    "releasing-session").toCompletableFuture().join());
            assertEquals(1, releaseCalls.get());
            assertEquals(RuntimeSessionRecord.State.RELEASED,
                    sessions.findById(SCOPE, "releasing-session").getState());
        } finally {
            service.close();
        }
    }

    /**
     * Finding 2 (v3 polling): result polling backs off exponentially from
     * 100ms instead of pinning two repository reads and one worker call at
     * 10/s for the whole window. Gaps are bounded both ways: the doubling
     * is the backoff, the upper bounds keep early polls prompt. The cap
     * itself is pinned deterministically below, so this test does not have
     * to wait for it.
     */
    @Test
    void v3ResultPollingBacksOff() throws Exception {
        V3Transport transport = new V3Transport();
        try (RuntimeBrokerService service = v3Service(transport,
                Duration.ofMinutes(30))) {
            startV3Execution(service);
            await(() -> transport.statusV3Nanos.size() >= 4,
                    Duration.ofSeconds(10));
            List<Long> times = transport.statusV3Nanos;
            long firstGap = times.get(1) - times.get(0);
            long secondGap = times.get(2) - times.get(1);
            long thirdGap = times.get(3) - times.get(2);
            assertTrue(firstGap >= Duration.ofMillis(90).toNanos(),
                    "first retry must double from 100ms: " + firstGap);
            assertTrue(firstGap < Duration.ofSeconds(1).toNanos(),
                    "first retry must stay prompt: " + firstGap);
            assertTrue(secondGap >= Duration.ofMillis(190).toNanos(),
                    "second retry must double: " + secondGap);
            assertTrue(secondGap < Duration.ofSeconds(2).toNanos(),
                    "second retry must stay prompt: " + secondGap);
            assertTrue(thirdGap >= Duration.ofMillis(390).toNanos(),
                    "third retry must double again: " + thirdGap);
            assertTrue(thirdGap < Duration.ofSeconds(3).toNanos(),
                    "third retry must stay prompt: " + thirdGap);
        }
    }

    /**
     * The backoff's exact schedule, including the cap: doubling from 100ms
     * and stopping at 2s, so a finished result is never picked up later
     * than the cap allows. Asserted on the computation rather than on the
     * wall clock, which cannot resolve a 2s cap from a 2.5s one without
     * depending on scheduler jitter. The tail is pinned by equality rather
     * than by bounds: an in-bounds schedule that dipped back to 100ms on
     * every other attempt would restore the 10/s polling the backoff exists
     * to remove, and only an exact cap catches it — as does an unclamped
     * shift, which wraps negative at attempt 57.
     */
    @Test
    void v3ResultPollingDelayDoublesToTheCap() {
        assertEquals(List.of(100L, 200L, 400L, 800L, 1600L, 2000L, 2000L,
                        2000L),
                IntStream.rangeClosed(0, 7)
                        .mapToObj(RuntimeBrokerService::v3PollDelayMillis)
                        .toList());
        // The window has a floor but no ceiling, so the attempt count is
        // unbounded; past the ramp every attempt must sit at the cap.
        IntStream.rangeClosed(8, 100_000).forEach(attempt -> assertEquals(
                2_000L, RuntimeBrokerService.v3PollDelayMillis(attempt),
                "the backoff left the cap at attempt " + attempt));
    }

    /**
     * The configured window bounds the polling: once it lapses, the
     * dispatch's result watch ends and the execution flips to UNKNOWN
     * instead of polling for the default half hour.
     */
    @Test
    void v3ResultWindowBoundsThePolling() throws Exception {
        V3Transport transport = new V3Transport();
        try (RuntimeBrokerService service = v3Service(transport,
                RuntimeBrokerService.MIN_V3_RESULT_WINDOW)) {
            ToolExecutionRecord prepared = startV3Execution(service);
            await(() -> {
                ToolExecutionRecord current = service.getExecution("harness",
                        "runtime", prepared.getExecutionCallId())
                        .toCompletableFuture().join();
                return current.getState() == ToolExecutionRecord.State.UNKNOWN;
            }, Duration.ofSeconds(10));
        }
    }

    /**
     * The window is validated against a floor: a suffix-less duration config
     * binds as milliseconds, so a window meant as "30" minutes arrives as
     * 30ms and construction fails instead of silently degrading every v3
     * execution to UNKNOWN.
     */
    @Test
    void v3ResultWindowBelowTheFloorIsRefused() {
        assertThrows(IllegalArgumentException.class,
                () -> v3Service(new V3Transport(), Duration.ofMillis(30)));
    }

    /**
     * Medium cluster: a released worker that ignores SIGTERM is destroyed
     * forcibly after the grace window instead of leaking. POSIX-only: on
     * Windows destroy() terminates outright, so {@code --ignore-term}
     * cannot wedge a worker and the escalation is unobservable.
     */
    @Test
    @DisabledOnOs(OS.WINDOWS)
    void releaseEscalatesToForcibleDestroyWhenWorkerIgnoresSigterm()
            throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        Set<Long> before = ProcessTrees.childPids();
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
            long worker = ProcessTrees.childPids().stream()
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
     * released), not only from release(). POSIX-only, like the release arm
     * above: Windows has no SIGTERM for {@code --ignore-term} to swallow.
     */
    @Test
    @DisabledOnOs(OS.WINDOWS)
    void closeEscalatesToForcibleDestroyWhenWorkerIgnoresSigterm()
            throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        Set<Long> before = ProcessTrees.childPids();
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
        long worker = ProcessTrees.childPids().stream()
                .filter(pid -> !before.contains(pid)).findFirst()
                .orElseThrow(() -> new AssertionError("no worker child"));
        provisioner.close();
        await(() -> ProcessHandle.of(worker).map(process -> !process.isAlive())
                .orElse(true), Duration.ofSeconds(10));
    }

    /**
     * Provisions a wedged worker, races provisions of {@code racing} against
     * close(), and returns the guard error one of them hit — null when the
     * race never reached the guard. The lingering-children check lives here
     * because it is the platform-independent half of the invariant.
     */
    private static RuntimeBrokerException raceProvisionsAgainstClose(
            RuntimeProvisionRequest racing,
            java.util.function.IntFunction<RuntimeProvisionSeed> racingSeeds)
            throws Exception {
        LocalProcessRuntimeProvisionerTest.requireNode();
        Set<Long> before = ProcessTrees.childPids();
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString(), "--ignore-term"),
                        Path.of(".").toAbsolutePath(),
                        new HttpRuntimeTransport());
        // A plain (non-managed) request keeps the wedge provision's own
        // startup path out of the way.
        RuntimeProvisionRequest plain = raceRequest();
        try {
            // A wedged worker stretches close()'s grace window, so the race
            // window is seconds wide instead of nanoseconds.
            provisioner.provision(plain, ManagedContextProtocolTest.seed())
                    .toCompletableFuture().get(10, TimeUnit.SECONDS);
            Thread closer = new Thread(provisioner::close, "closer");
            closer.start();
            RuntimeBrokerException refused = null;
            Instant giveUp = Instant.now().plusSeconds(10);
            int attempt = 0;
            while (refused == null && closer.isAlive()
                    && Instant.now().isBefore(giveUp)) {
                try {
                    provisioner.provision(racing, racingSeeds.apply(attempt++))
                            .toCompletableFuture().join();
                } catch (CompletionException failure) {
                    // Match the guard's exact message; a worker killed
                    // mid-handshake reports "closed before ready".
                    if (failure.getCause() instanceof RuntimeBrokerException broker
                            && "Managed Runtime provisioner is closed."
                                    .equals(broker.getMessage())) {
                        refused = broker;
                    }
                } catch (java.util.concurrent.RejectedExecutionException
                        poolShutDown) {
                    break;
                }
                Thread.sleep(20);
            }
            closer.join(TimeUnit.SECONDS.toMillis(15));
            assertFalse(closer.isAlive(),
                    "close() never finished, so the lingering-children check"
                            + " below would measure a live teardown");
            // Killed children linger as zombies until the JVM reaper runs, so
            // wait them out rather than snapshot once.
            await(() -> {
                Set<Long> lingering = ProcessTrees.childPids();
                lingering.removeAll(before);
                lingering.removeIf(pid -> ProcessHandle.of(pid)
                        .map(process -> !process.isAlive()).orElse(true));
                return lingering.isEmpty();
            }, Duration.ofSeconds(10));
            return refused;
        } finally {
            // A throw anywhere above must not leave the wedged worker
            // alive for the rest of the surefire JVM.
            provisioner.close();
        }
    }

    /** The plain request the race fixture provisions with. */
    private static RuntimeProvisionRequest raceRequest() {
        return new RuntimeProvisionRequest(
                new RuntimeScope("tenant-race", "workspace", "1", "/workspace",
                        "sha256:" + "a".repeat(64), "workspace"),
                null, "local-process");
    }

    private static RuntimeProvisionSeed raceSeed(int attempt) {
        return RuntimeProvisionSeed.create("racing-" + attempt, 1);
    }

    /**
     * A provision racing close() leaves no worker behind, whichever way the
     * race resolves: refused by the terminated guard, or spawned before it
     * and then torn down with the rest. Spawn-and-register atomicity is
     * structural rather than observable: start() spawns and adds to
     * {@code starting} inside the {@code lifecycle} lock that
     * {@code terminateAll()} also holds, so no teardown snapshot can fall
     * between the two, and nothing outside that lock can interleave there.
     */
    @Test
    void provisionDuringCloseNeverOrphansAWorker() throws Exception {
        raceProvisionsAgainstClose(raceRequest(),
                Issue13183RegressionTest::raceSeed);
    }

    /**
     * The guard half of the same race: a provision that reaches start()
     * after close() is refused with the closed message. Reaching it needs
     * the wedged worker to hold close() inside its grace window, which only
     * exists where destroy() is a signal — elsewhere close() finishes in
     * milliseconds and the race cannot overlap the teardown at all, so this
     * reports as skipped rather than passing without exercising the guard.
     */
    @Test
    void provisionAfterCloseHitsTheTerminatedGuard() throws Exception {
        assumeTrue(DESTROY_IS_SIGTERM,
                "destroy() terminates outright here, so close() finishes"
                        + " before the race can reach the guard");
        RuntimeBrokerException refused = raceProvisionsAgainstClose(
                raceRequest(), Issue13183RegressionTest::raceSeed);
        assertNotNull(refused,
                "a provision racing the close must hit the closed guard");
        assertEquals("Managed Runtime provisioner is closed.",
                refused.getMessage());
    }

    /**
     * The same refusal must survive managed-context retyping: start()'s catch
     * turns every other failure into a non-retryable "recovery is blocked"
     * 503, which would tell a caller provisioning directly that recovery is
     * blocked when the provisioner was merely closed. Through the service the
     * turn fails either way — a managed-context provision failure blocks
     * recovery regardless of the flag — so what this pins is the refusal's
     * own message and its retryable flag.
     */
    @Test
    void provisionRacingCloseStaysRetryableForManagedContext()
            throws Exception {
        assumeTrue(DESTROY_IS_SIGTERM,
                "destroy() terminates outright here, so close() finishes"
                        + " before the race can reach the guard");
        RuntimeBrokerException refused = raceProvisionsAgainstClose(
                ManagedContextProtocolTest.request(),
                ignored -> ManagedContextProtocolTest.seed());
        assertNotNull(refused,
                "a managed-context provision racing the close must hit the"
                        + " closed guard, not be retyped by the startup path");
        assertEquals("Managed Runtime provisioner is closed.",
                refused.getMessage());
        assertTrue(refused.isRetryable(),
                "a closed provisioner is a restart, not blocked recovery");
    }

    private static RuntimeBrokerService v3Service(V3Transport transport,
            Duration v3ResultWindow) {
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
        return new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(SCOPE),
                new StaticRuntimeProvisioner(new RuntimeLease("instance",
                        URI.create("http://127.0.0.1:1234"), "token", "lease",
                        1)),
                transport, new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(Clock.systemUTC()),
                "broker", Duration.ofMinutes(1), Duration.ofMinutes(1),
                verifier, v3ResultWindow);
    }

    /** Starts a v3 execution that never settles; the poll loop drives it. */
    private static ToolExecutionRecord startV3Execution(
            RuntimeBrokerService service) throws Exception {
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"pwd\"}}";
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(
                        payload.getBytes(StandardCharsets.UTF_8)));
        service.acquire("harness", "runtime", "bootstrap")
                .toCompletableFuture().join();
        Map<String, Object> reference = Map.of("sessionId", "runtime",
                "promptId", "prompt", "callId", "call", "argsDigest",
                "sha256:" + "a".repeat(64));
        ToolExecutionRecord prepared = service.prepareExecution("harness",
                "runtime", "key", reference, digest, "pub-1")
                .toCompletableFuture().join();
        service.startExecution("harness", "runtime",
                prepared.getExecutionCallId(), payload, "pub-1", "token");
        return prepared;
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

    private static String failureCode(CompletionStage<?> stage)
            throws Exception {
        // Bounded: a regression that never answers must fail red, not hang.
        java.util.concurrent.ExecutionException failure = assertThrows(
                java.util.concurrent.ExecutionException.class,
                () -> stage.toCompletableFuture().get(30,
                        TimeUnit.SECONDS));
        Throwable cause = failure.getCause();
        assertTrue(cause instanceof RuntimeBrokerException,
                () -> "unexpected failure " + cause);
        return ((RuntimeBrokerException) cause).getCode();
    }

    private static URI warmUri(RuntimeBrokerHttpServer server) {
        return server.getBaseUri().resolve(
                RuntimeBrokerHttpServer.ROUTE_PREFIX + "/runtimes:warm");
    }

    static DataSource dataSource(String name) {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:issue13183-" + name + "-"
                + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1");
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        return dataSource;
    }

    static SecretProtector protector(String prefix) {
        return new AesGcmSecretProtector("key-" + prefix,
                keyBytes(prefix.hashCode()));
    }

    static byte[] keyBytes(int seed) {
        byte[] key = new byte[32];
        for (int index = 0; index < key.length; index++) {
            key[index] = (byte) (seed + index);
        }
        return key;
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

    static class ReclaimProvisioner implements RuntimeProvisioner {
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

    static class NoopTransport implements RuntimeTransport {
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

    static final class AttestingTransport extends NoopTransport {
        @Override
        public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            return CompletableFuture.completedFuture(new RuntimeAttestation(
                    lease.getRuntimeInstanceId(), seed.getGatewayIncarnation(),
                    lease.getLeaseId(), lease.getEpoch(), request.getScope(),
                    seed.getProvisionRequestId()));
        }
    }

    static class CountingTransport extends NoopTransport {
        final AtomicInteger statusCalls = new AtomicInteger();
        volatile boolean failExecutions;
        volatile boolean failStatus;
        volatile boolean failStatusWithError;
        volatile Map<String, Object> statusResult = Map.of("state",
                "unknown");

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
            if (failStatusWithError) {
                // Thrown, not returned, so it reaches the caller through
                // safeStage's Error arm the way a broken JVM would.
                throw new AssertionError("worker status blew up");
            }
            if (failStatus) {
                return CompletableFuture.failedFuture(new RuntimeBrokerException(
                        503, "managed_runtime_unavailable",
                        "Runtime is unavailable", true));
            }
            return CompletableFuture.completedFuture(statusResult);
        }
    }

    /**
     * One UNKNOWN execution behind a loopback HTTP face, with a mutable
     * service clock so the cooldown window can lapse without sleeping.
     */
    static final class UnknownObservationHarness
            implements AutoCloseable {
        final MutableClock clock = new MutableClock();
        final CountingTransport transport = new CountingTransport();
        final String runtime = "550e8400-e29b-41d4-a716-446655440302";
        final RuntimeBrokerService service;
        final RuntimeBrokerHttpServer server;
        final ToolExecutionRecord prepared;

        UnknownObservationHarness() throws IOException {
            this(new InMemoryToolExecutionRepository(Clock.systemUTC()));
        }

        UnknownObservationHarness(ToolExecutionRepository executions)
                throws IOException {
            service = new RuntimeBrokerService(
                    harnessId -> CompletableFuture.completedFuture(
                            new RuntimeScope("tenant-cooldown", "workspace",
                                    "generation", "/workspace", "capability",
                                    "workspace")),
                    new StaticRuntimeProvisioner(new RuntimeLease("instance",
                            URI.create("http://127.0.0.1:1234"), "token",
                            "lease", 1)),
                    transport, new InMemoryRuntimeBindingRepository(),
                    new InMemoryRuntimeSessionRepository(), executions,
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
            prepared = prepareUnknown("key");
        }

        /** Prepares another execution and drives it to UNKNOWN. */
        ToolExecutionRecord prepareUnknown(String idempotencyKey) {
            Map<String, Object> reference = Map.of("sessionId", runtime,
                    "promptId", "turn", "callId", "call", "capabilityDigest",
                    "a".repeat(64), "policyRevision", "policy", "invocationId",
                    "invocation", "argsDigest", "b".repeat(64));
            ToolExecutionRecord record = service.prepareExecution("harness",
                    runtime, idempotencyKey, reference).toCompletableFuture()
                    .join();
            transport.failExecutions = true;
            service.startExecution("harness", runtime,
                    record.getExecutionCallId()).toCompletableFuture().join();
            // The dispatch answer was lost, so the record flips to UNKNOWN;
            // markUnknown runs inside the failed invocation's handle.
            Instant giveUp = Instant.now().plusSeconds(5);
            while (service.getExecution("harness", runtime,
                    record.getExecutionCallId()).toCompletableFuture().join()
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
            return record;
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
        // The test thread advances this while the service reads it from the
        // HTTP handler and the coordination scheduler, so the write has to be
        // published.
        private volatile Instant now = Instant.now();

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
