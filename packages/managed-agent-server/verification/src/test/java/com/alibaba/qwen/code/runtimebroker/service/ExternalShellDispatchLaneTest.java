package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalShellPublication;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The external foreground-Shell lane (#15512 slice C), whose worker publishes
 * nothing to the control plane: the Broker opens its channel, moves the bytes
 * itself and only then settles.
 *
 * <p>Every other v3 placement has its worker finish its own publication before
 * it settles, so only the durable envelope may answer there. These cases pin the
 * difference, because reading the worker's settled answer as "not yet durable"
 * leaves an ordinary successful call polling until its window expires.
 */
class ExternalShellDispatchLaneTest {
    @Test
    @Timeout(15)
    void successfulShellMovesItsCaptureAndSettlesThePublishedEnvelope() {
        var fixture = new Fixture();
        fixture.dispatch();

        assertEquals(List.of("begin", "execute", "drain", "published"), fixture.events);
        // The worker's envelope names its own local manifest; the settled record
        // must carry the control plane's rebuilt one, which is what the Harness
        // compares against `/finished` verbatim.
        assertNotNull(fixture.settled.get());
        assertEquals(fixture.publishedEnvelope(), fixture.settled.get());
        assertEquals("control-plane-manifest",
                capture(fixture.settled.get()).get("manifest"));
        assertNull(fixture.unknown.get(), "A drained call must not be marked unknown");
    }

    @Test
    @Timeout(15)
    void shellOutlivingItsExecuteTimeoutArrivesThroughTheResultPoll() {
        var fixture = new Fixture();
        // The execute call answers before the process ends, exactly as a
        // foreground command longer than the transport's own request timeout
        // does; the status poll is then the only way its outcome arrives.
        fixture.answer.complete(Map.of("state", "executing"));
        fixture.statusAnswers.add(CompletableFuture.completedFuture(Map.of(
                "state", "settled", "result", fixture.workerEnvelope())));
        fixture.dispatch();

        assertEquals(List.of("begin", "execute", "status", "drain", "published"), fixture.events);
        assertEquals(fixture.publishedEnvelope(), fixture.settled.get());
    }

    @Test
    @Timeout(15)
    void startedShellWithAnIncompleteCaptureRefusesInsteadOfSettling() {
        var fixture = new Fixture();
        var partial = Map.<String, Object>of(
                "executionStatus", "success",
                "responseParts", List.of(),
                "capture", Map.of("captureStatus", "partial", "manifest", "worker-manifest"));
        fixture.answer.complete(Map.of("state", "settled", "result", partial));
        fixture.dispatch();

        // `finish` admits only a complete capture, so no retry could publish
        // these bytes. Settling would let the close reach a stop the worker can
        // never prove, so the record stays recoverable instead.
        assertNull(fixture.settled.get());
        assertEquals("execution", fixture.unknown.get());
        assertTrue(fixture.events.stream().noneMatch("drain"::equals));
    }

    @Test
    @Timeout(15)
    void unstartedShellSettlesWithoutMovingAnyBytes() {
        var fixture = new Fixture();
        var unstarted = new java.util.LinkedHashMap<String, Object>();
        unstarted.put("executionStatus", "not_started");
        unstarted.put("responseParts", List.of());
        unstarted.put("capture", null);
        fixture.answer.complete(Map.of("state", "settled", "result", unstarted));
        fixture.dispatch();

        assertEquals("not_started", fixture.settled.get().get("executionStatus"));
        assertTrue(fixture.events.stream().noneMatch("drain"::equals));
        assertTrue(fixture.events.stream().noneMatch("published"::equals));
    }

    @Test
    @Timeout(15)
    void recoveredDispatchSettlesFromAnAlreadyFinishedPublicationWithoutMovingAgain() {
        var fixture = new Fixture();
        // The drain finished but its settle did not land. Publishing over a
        // FINISHED lane would refuse, so the durable envelope is already the
        // outcome.
        fixture.finished = true;
        fixture.dispatch();

        assertEquals(fixture.publishedEnvelope(), fixture.settled.get());
        assertTrue(fixture.events.stream().noneMatch("drain"::equals));
    }

    @Test
    @Timeout(15)
    void failedDrainLeavesTheCallUnknownAndTheChannelUnacknowledged() {
        var fixture = new Fixture();
        fixture.failDrain = true;
        fixture.dispatch();

        assertNull(fixture.settled.get());
        assertEquals("execution", fixture.unknown.get());
        assertTrue(fixture.events.stream().noneMatch("published"::equals));
    }

    @Test
    @Timeout(15)
    void refusedChannelBeginNeverStartsTheShellAndLeavesTheCallUnknown() {
        var fixture = new Fixture();
        fixture.failBegin = true;
        fixture.dispatch();

        // The worker prepares against a channel that already exists, so a
        // refused begin must stop the Shell rather than run a command whose
        // output has nowhere to go.
        assertNull(fixture.settled.get());
        assertEquals("execution", fixture.unknown.get());
        assertEquals(List.of("begin"), fixture.events);
    }

    @Test
    @Timeout(15)
    void claimLostBeforeTheMoveLeavesTheCallUnknownWithoutPublishing() {
        var fixture = new Fixture();
        // A takeover re-granted the claim between the Shell's answer and the
        // move. The new owner is the one that has to move these bytes; writing
        // over its claim would publish a result it does not own.
        var taken = mock(ToolExecutionRecord.class);
        when(taken.getExecutionCallId()).thenReturn("execution");
        when(taken.getDispatchOwner()).thenReturn("broker");
        when(taken.getDispatchGeneration()).thenReturn(8L);
        fixture.answer.complete(Map.of("state", "settled", "result", fixture.workerEnvelope()));
        when(fixture.executions.findByExecutionCallId("execution")).thenReturn(taken);
        fixture.dispatch();

        assertNull(fixture.settled.get());
        assertEquals("execution", fixture.unknown.get());
        assertEquals(List.of("begin", "execute"), fixture.events);
    }

    @Test
    @Timeout(15)
    void renewalPushesTheGrantsHorizonToTheWorkerChannelAndTheShellStillSettles() throws Exception {
        var fixture = new Fixture();
        // A foreground command longer than one dispatch lease: the tick renews
        // the claim, and the channel's own horizon has to move with it or the
        // capture closes mid-command and the drain can never finish.
        var renewed = new CountDownLatch(1);
        fixture.onRenew = renewed::countDown;
        fixture.holdExecute = true;
        var dispatched = Thread.ofPlatform().start(fixture::dispatch);
        assertTrue(fixture.shellStarted.await(5, TimeUnit.SECONDS), "The Shell never started");

        fixture.tick.run();
        assertTrue(renewed.await(5, TimeUnit.SECONDS), "The channel horizon was never pushed");
        assertEquals(fixture.grant, fixture.renewedGrant.get(),
                "The renewal rechecks the grant and pushes that grant's current horizon");

        fixture.answer.complete(Map.of("state", "settled", "result", fixture.workerEnvelope()));
        dispatched.join(10_000);
        assertEquals(fixture.publishedEnvelope(), fixture.settled.get());
        assertTrue(fixture.events.contains("drain"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> capture(Map<String, Object> envelope) {
        return (Map<String, Object>) envelope.get("capture");
    }

    /**
     * Drives one claimed dispatch over the external Shell lane. The producer and
     * the publication verifier are the real collaborators' contract, stubbed at
     * their boundary: what is under test is the Broker's sequencing of begin,
     * execute, move and settle, not the store's own SQL.
     */
    private static final class Fixture {
        private static final Duration LEASE = Duration.ofSeconds(60);
        private static final Map<String, Object> REFERENCE = Map.of(
                "sessionId", "runtime", "promptId", "turn", "callId", "call",
                "argsDigest", "sha256:" + "a".repeat(64),
                "dispatchMode", "deferred_v3", "publicationId", "publication",
                "payloadDigest", "sha256:" + "b".repeat(64));
        private static final Map<String, Object> PAYLOAD = Map.of(
                "toolName", "run_shell_command", "input", Map.of("command", "printf witness"));

        private final List<String> events = new ArrayList<>();
        private final AtomicReference<Map<String, Object>> settled = new AtomicReference<>();
        private final AtomicReference<String> unknown = new AtomicReference<>();
        private final CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();
        private final List<CompletableFuture<Map<String, Object>>> statusAnswers = new ArrayList<>();
        private boolean finished;
        private boolean failDrain;
        private boolean failBegin;
        private boolean holdExecute;
        private Runnable onRenew = () -> { };
        private final CountDownLatch shellStarted = new CountDownLatch(1);
        private final AtomicReference<RuntimePublicationGrant> renewedGrant = new AtomicReference<>();
        private Runnable tick = () -> { };

        private final RuntimeLease lease = mock(RuntimeLease.class);
        private final RuntimeSession session = mock(RuntimeSession.class);
        private final RuntimeBindingRecord binding = mock(RuntimeBindingRecord.class);
        private final SessionContext context = mock(SessionContext.class);
        private final ToolExecutionRecord prepared = mock(ToolExecutionRecord.class);
        private final ToolExecutionRecord executing = mock(ToolExecutionRecord.class);
        private final ToolExecutionRepository executions = mock(ToolExecutionRepository.class);
        private final RuntimeTransport transport = mock(RuntimeTransport.class);
        private final RuntimeProvisioner provisioner = mock(RuntimeProvisioner.class);
        private final ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        private final RuntimeExecutionState state = mock(RuntimeExecutionState.class);
        private final RuntimePublicationGrant grant = new RuntimePublicationGrant(
                "publication", "token", "http://127.0.0.1:1", Map.of(
                        "sessionKey", Map.of("tenantId", "tenant", "sessionId", "harness"),
                        "turnId", "turn", "executionCallId", "execution",
                        "bindingGeneration", "1", "captureId", "capture-a"),
                Instant.parse("2026-11-01T01:00:00Z").toEpochMilli());
        private final RuntimeExecutionDispatcher dispatcher;

        private Fixture() {
            var registry = mock(RuntimeBindingRegistry.class);
            var bindings = mock(RuntimeBindingRepository.class);
            var sessions = mock(RuntimeSessionRepository.class);
            // The external placement names its registered storage as the
            // workspace id; a mismatch there is not this lane at all.
            var scope = new RuntimeScope("tenant", "storage", "1", "/workspace",
                    WorkspaceExecutionProfile.EXTERNAL_SHELL_CAPABILITY_DIGEST, "session");
            when(binding.getRequest()).thenReturn(new RuntimeProvisionRequest(
                    scope, "harness", "external-workspace", "storage"));
            when(context.binding()).thenReturn(binding);
            when(context.session()).thenReturn(session);
            when(context.lease()).thenReturn(lease);
            when(session.getScope()).thenReturn(scope);
            when(session.getHarnessSessionId()).thenReturn("harness");
            for (var record : new ToolExecutionRecord[] {prepared, executing}) {
                when(record.getExecutionCallId()).thenReturn("execution");
                when(record.getReference()).thenReturn(REFERENCE);
                when(record.getDispatchOwner()).thenReturn("broker");
                when(record.getDispatchGeneration()).thenReturn(7L);
                when(record.getBindingId()).thenReturn("binding");
                when(record.getRuntimeGeneration()).thenReturn(1L);
                // The claim's own owner and generation are what fence the
                // move; identity is not what these cases vary.
                when(record.sameIdentity(any())).thenReturn(true);
                when(record.sameAuthorization(any())).thenReturn(true);
            }
            when(binding.getBindingId()).thenReturn("binding");
            when(binding.getGeneration()).thenReturn(1L);
            when(prepared.getState()).thenReturn(ToolExecutionRecord.State.DISPATCHING);
            when(executing.getState()).thenReturn(ToolExecutionRecord.State.EXECUTING);
            when(executions.claimDispatch("execution", "broker", LEASE)).thenReturn(prepared);
            when(bindings.authorizeDispatch(sessions, executions, prepared, "broker", 7L))
                    .thenReturn(executing);
            when(executions.findByExecutionCallId("execution")).thenReturn(executing);
            when(provisioner.isUsable(lease)).thenReturn(true);
            when(transport.executeV3(eq(lease), eq(session), eq(REFERENCE), eq(PAYLOAD), any()))
                    .thenAnswer(call -> {
                        events.add("execute");
                        shellStarted.countDown();
                        return answer;
                    });
            when(executions.renewDispatch("execution", "broker", 7L, LEASE))
                    .thenReturn(executing);
            when(transport.statusV3(lease, session, REFERENCE, 0)).thenAnswer(call -> {
                events.add("status");
                return statusAnswers.isEmpty()
                        ? CompletableFuture.completedFuture(Map.of("state", "executing"))
                        : statusAnswers.remove(0);
            });
            // Every scheduled poll runs inline, so a case never waits on a real
            // backoff to observe the next status answer.
            when(scheduler.schedule(any(Runnable.class), anyLong(), eq(TimeUnit.MILLISECONDS)))
                    .thenAnswer(call -> {
                        call.<Runnable>getArgument(0).run();
                        return mock(ScheduledFuture.class);
                    });
            var renewalScheduler = mock(ScheduledExecutorService.class);
            // The tick is driven by hand: a case decides when a lease has
            // elapsed instead of waiting a third of one.
            when(renewalScheduler.scheduleWithFixedDelay(any(Runnable.class), anyLong(), anyLong(),
                    eq(TimeUnit.MILLISECONDS))).thenAnswer(call -> {
                        tick = call.getArgument(0);
                        return mock(ScheduledFuture.class);
                    });

            org.mockito.Mockito.doAnswer(call -> {
                settled.set(call.getArgument(1));
                return null;
            }).when(state).settleExecution(any(), any());
            org.mockito.Mockito.doAnswer(call -> {
                unknown.set(call.<ToolExecutionRecord>getArgument(0).getExecutionCallId());
                return null;
            }).when(state).markUnknown(any());

            dispatcher = new RuntimeExecutionDispatcher(registry, state, bindings, sessions,
                    executions, provisioner, transport, verifier(), "broker", LEASE,
                    Duration.ofMinutes(30),
                    Clock.fixed(Instant.parse("2026-11-01T00:00:00Z"), ZoneOffset.UTC),
                    scheduler, renewalScheduler, new AtomicBoolean());
        }

        /** The worker's own settled envelope: its manifest ref is worker-local. */
        private Map<String, Object> workerEnvelope() {
            return Map.of("executionStatus", "success", "responseParts", List.of(),
                    "capture", Map.of("captureStatus", "complete", "manifest", "worker-manifest"));
        }

        /** The control plane's rebuilt envelope, which the drain finished with. */
        private Map<String, Object> publishedEnvelope() {
            return Map.of("executionStatus", "success", "responseParts", List.of(),
                    "capture", Map.of("captureStatus", "complete",
                            "manifest", "control-plane-manifest"));
        }

        private RuntimePublicationVerifier verifier() {
            var producer = new ExternalShellPublication() {
                public CompletableFuture<String> begin(RuntimeLease lease, RuntimeBindingRecord binding,
                        ToolExecutionRecord execution, RuntimePublicationGrant grant) {
                    events.add("begin");
                    return failBegin
                            ? CompletableFuture.failedFuture(new RuntimeBrokerException(
                                    409, "external_shell_publication_unavailable",
                                    "Channel refused", false))
                            : CompletableFuture.completedFuture("channel");
                }

                public CompletableFuture<Void> renew(RuntimeLease lease, RuntimeBindingRecord binding,
                        RuntimePublicationGrant grant, String channelId) {
                    assertEquals("channel", channelId);
                    renewedGrant.set(grant);
                    onRenew.run();
                    return CompletableFuture.completedFuture(null);
                }

                public CompletableFuture<Void> drain(RuntimeLease lease, RuntimeBindingRecord binding,
                        ToolExecutionRecord execution, RuntimePublicationGrant grant,
                        String channelId, Map<String, Object> result) {
                    events.add("drain");
                    assertEquals("channel", channelId);
                    assertEquals(workerEnvelope(), result, "The move carries the worker's own envelope");
                    if (failDrain) {
                        return CompletableFuture.failedFuture(new RuntimeBrokerException(
                                409, "external_shell_publication_conflict", "Move refused", false));
                    }
                    finished = true;
                    return CompletableFuture.completedFuture(null);
                }
            };
            return new RuntimePublicationVerifier() {
                public RuntimePublicationGrant verify(ToolExecutionRecord execution,
                        String publicationId, String token) {
                    return grant;
                }

                public Map<String, Object> finished(ToolExecutionRecord execution) {
                    if (!finished) {
                        return null;
                    }
                    events.add("published");
                    return publishedEnvelope();
                }

                public ExternalShellPublication externalShell() {
                    return producer;
                }
            };
        }

        private void dispatch() {
            if (!holdExecute && !answer.isDone()) {
                answer.complete(Map.of("state", "settled", "result", workerEnvelope()));
            }
            dispatcher.beginDispatch(context, prepared, PAYLOAD, grant, null, null);
            // beginDispatch owns its stage and returns void, so the lane's own
            // terminal write is the only completion signal a caller has.
            long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
            while (settled.get() == null && unknown.get() == null) {
                if (System.nanoTime() > deadline) {
                    throw new AssertionError("Dispatch did not settle: " + events);
                }
                Thread.onSpinWait();
            }
        }
    }
}
