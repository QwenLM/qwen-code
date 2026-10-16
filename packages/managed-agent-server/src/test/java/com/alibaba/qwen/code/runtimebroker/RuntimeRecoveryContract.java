package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

final class RuntimeRecoveryContract {
    private RuntimeRecoveryContract() {
    }

    static void verify(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String prefix) throws Exception {
        for (ToolExecutionRecord.State state : ToolExecutionRecord.State.values()) {
            if (state == ToolExecutionRecord.State.ABANDONED) {
                continue;
            }
            Fixture fixture = new Fixture(bindings, sessions, executions, prefix + state);
            ToolExecutionRecord prepared = fixture.prepare("execution");
            ToolExecutionRecord original = prepared;
            if (state != ToolExecutionRecord.State.PREPARED) {
                original = executions.claimDispatch(prepared.getExecutionCallId(), "dispatcher",
                        Duration.ofMinutes(5));
                if (state == ToolExecutionRecord.State.CANCEL_REQUESTED) {
                    original = executions.compareAndSet(original,
                            original.withState(ToolExecutionRecord.State.EXECUTING, false),
                            "dispatcher", original.getDispatchGeneration());
                    original = executions.requestCancel(original.getExecutionCallId(), original.getVersion());
                } else if (state == ToolExecutionRecord.State.SETTLED) {
                    original = executions.compareAndSet(original, original.withResult(
                            Map.of("executionStatus", "success"), 3, Instant.now()),
                            "dispatcher", original.getDispatchGeneration());
                } else if (state != ToolExecutionRecord.State.DISPATCHING) {
                    original = executions.compareAndSet(original, original.withState(state, false),
                            "dispatcher", original.getDispatchGeneration());
                }
            }
            assertEquals(state, original.getState());
            RuntimeBindingRecord lost = fixture.lose(false);
            assertThrows(RuntimeBrokerException.class, () -> bindings.admitSession(sessions,
                    new RuntimeSessionRecord(new RuntimeSession("other", fixture.id + "-new-session",
                            "bootstrap", lost.getRequest().getScope()), lost.getBindingId(),
                            lost.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now())));
            assertThrows(RuntimeBrokerException.class, () -> fixture.prepare("late"));
            assertThrows(IllegalArgumentException.class, () -> bindings.compareAndSet(lost,
                    lost.withState(RuntimeBindingRecord.State.RELEASED, lost.getLease(), Instant.now())));
            assertThrows(IllegalArgumentException.class, () -> bindings.compareAndSet(lost,
                    lost.withState(RuntimeBindingRecord.State.READY, lost.getLease(), Instant.now())));
            RuntimeBindingRecord pinned = bindings.recoverLost(sessions, executions, lost);
            assertEquals(RuntimeBindingRecord.State.LOST, pinned.getState());
            assertEquals(1, sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration()));
            ToolExecutionRecord terminal = executions.findByExecutionCallId(original.getExecutionCallId());
            assertTrue(terminal.isTerminal());
            if (state == ToolExecutionRecord.State.SETTLED) {
                assertEquals(original.getResult(), terminal.getResult());
                assertEquals(original.getVersion(), terminal.getVersion());
            } else {
                assertEquals(ToolExecutionRecord.State.ABANDONED, terminal.getState());
                assertFalse(terminal.isSettled());
                assertNull(terminal.getResult());
                assertNull(terminal.getExecutionStatus());
                assertNull(terminal.getSettledAt());
                assertNotNull(terminal.getAbandonedAt());
                assertEquals("runtime_lost", terminal.getAbandonmentReason());
                assertEquals(lost.getLossEvidence().evidenceId(), terminal.getLossEvidenceId());
                assertEquals(original.getDispatchOwner(), terminal.getDispatchOwner());
                assertEquals(original.getDispatchGeneration(), terminal.getDispatchGeneration());
                assertEquals(original.isCancelRequested(), terminal.isCancelRequested());
                assertEquals(original.getReference(), terminal.getReference());
                assertEquals(original.getLastSequence(), terminal.getLastSequence());
            }
            assertNull(executions.claimDispatch(terminal.getExecutionCallId(), "other", Duration.ofSeconds(10)));
            assertNull(executions.renewDispatch(terminal.getExecutionCallId(), "dispatcher",
                    terminal.getDispatchGeneration(), Duration.ofSeconds(10)));
            assertNull(executions.requestCancel(terminal.getExecutionCallId(), terminal.getVersion()));
            assertNull(executions.resolveUnknown(original, Map.of("executionStatus", "error"), Instant.now()));
            assertNull(executions.compareAndSet(original,
                    original.withResult(Map.of("executionStatus", "success"), 9, Instant.now()),
                    original.getDispatchOwner(), original.getDispatchGeneration()));
            bindings.recoverLost(sessions, executions, pinned);
            assertEquals(terminal.getVersion(), executions.findByExecutionCallId(terminal.getExecutionCallId()).getVersion());
            assertEquals(terminal.getExecutionCallId(), bindings.admitExecution(sessions, executions, prepared)
                    .getExecutionCallId());
            assertFalse(executions.hasActiveByRuntimeSession(lost.getBindingId(), lost.getGeneration(),
                    fixture.session.getRuntimeSessionId()));
            assertFalse(executions.hasActiveByBinding(lost.getBindingId(), lost.getGeneration()));
            RuntimeBindingRecord proved = bindings.compareAndSet(pinned, pinned.withRecoveryEvidence(
                    evidence(pinned, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    evidence(pinned, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED), Instant.now()));
            assertEquals(lost.getLossEvidence(), proved.getLossEvidence());
            RuntimeBindingRecord released = bindings.recoverLost(sessions, executions, proved);
            assertEquals(RuntimeBindingRecord.State.RELEASED, released.getState());
            assertEquals(RuntimeSessionRecord.State.RELEASED, sessions.findById(
                    fixture.session.getSession().getScope(), fixture.session.getRuntimeSessionId()).getState());
            assertEquals(proved.getStopEvidence(), bindings.findById(released.getBindingId()).getStopEvidence());
            assertTrue(bindings.findOrCreate(released.getRequest()).getGeneration() > released.getGeneration());
            assertEquals(terminal.getExecutionCallId(), bindings.admitExecution(sessions, executions, prepared)
                    .getExecutionCallId());
        }
        for (boolean sessionAdmission : new boolean[] {false, true}) {
            Fixture raced = new Fixture(bindings, sessions, executions, prefix + "-race-" + sessionAdmission);
            try (var pool = Executors.newFixedThreadPool(2)) {
                CountDownLatch start = new CountDownLatch(1);
                var admission = pool.submit(() -> {
                    start.await();
                    try {
                        if (sessionAdmission) {
                            bindings.admitSession(sessions, new RuntimeSessionRecord(
                                    new RuntimeSession(raced.id + "-harness", raced.id + "-racing", "bootstrap",
                                            raced.binding.getRequest().getScope()), raced.binding.getBindingId(),
                                    raced.binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
                        } else {
                            raced.prepare("racing");
                        }
                        return true;
                    } catch (RuntimeBrokerException closed) {
                        assertEquals("runtime_admission_closed", closed.getCode());
                        return false;
                    }
                });
                var fence = pool.submit(() -> { start.await(); return raced.lose(true); });
                start.countDown();
                boolean admitted = admission.get(10, TimeUnit.SECONDS);
                RuntimeBindingRecord fenced = fence.get(10, TimeUnit.SECONDS);
                assertNotNull(fenced);
                assertEquals(RuntimeBindingRecord.State.RELEASED,
                        bindings.recoverLost(sessions, executions, fenced).getState());
                assertFalse(executions.hasActiveByBinding(fenced.getBindingId(), fenced.getGeneration()));
                assertEquals(0, sessions.countActiveByBinding(fenced.getBindingId(), fenced.getGeneration()));
                if (admitted && !sessionAdmission) {
                    assertEquals(ToolExecutionRecord.State.ABANDONED,
                            executions.findByExecutionCallId(raced.id + "racing").getState());
                }
            }
        }
        Fixture bounded = new Fixture(bindings, sessions, executions, prefix + "-batch");
        for (int index = 0; index < 103; index++) {
            bounded.prepare("batch-" + index);
        }
        RuntimeBindingRecord lost = bounded.lose(true);
        RuntimeBindingRecord first = bindings.recoverLost(sessions, executions, lost);
        assertEquals(RuntimeBindingRecord.State.LOST, first.getState());
        assertTrue(executions.hasActiveByBinding(first.getBindingId(), first.getGeneration()));
        assertEquals(1, sessions.countActiveByBinding(first.getBindingId(), first.getGeneration()));
        assertEquals(RuntimeBindingRecord.State.RELEASED,
                bindings.recoverLost(sessions, executions, first).getState());

        Fixture sessionBatch = new Fixture(bindings, sessions, executions, prefix + "-session-batch");
        for (int index = 0; index < 102; index++) {
            bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession(sessionBatch.id + "-harness", "extra-" + index, "bootstrap",
                            sessionBatch.binding.getRequest().getScope()), sessionBatch.binding.getBindingId(),
                    sessionBatch.binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        }
        RuntimeBindingRecord batchLost = sessionBatch.lose(true);
        assertEquals(RuntimeBindingRecord.State.LOST, bindings.recoverLost(sessions, executions, batchLost).getState());
        assertEquals(3, sessions.countActiveByBinding(batchLost.getBindingId(), batchLost.getGeneration()));
        assertEquals(RuntimeBindingRecord.State.RELEASED, bindings.recoverLost(sessions, executions, batchLost).getState());

        Fixture scoped = new Fixture(bindings, sessions, executions, prefix + "-scope-a", "shared-id");
        Fixture other = new Fixture(bindings, sessions, executions, prefix + "-scope-b", "shared-id");
        scoped.prepare("call");
        ToolExecutionRecord otherCall = other.prepare("call");
        RuntimeBindingRecord scopedLost = scoped.lose(true);
        assertEquals(RuntimeBindingRecord.State.RELEASED, bindings.recoverLost(sessions, executions, scopedLost).getState());
        assertFalse(executions.hasActiveByRuntimeSession(scoped.binding.getBindingId(), 1, "shared-id"));
        assertTrue(executions.hasActiveByRuntimeSession(other.binding.getBindingId(), 1, "shared-id"));
        assertEquals(ToolExecutionRecord.State.PREPARED, executions.findByExecutionCallId(otherCall.getExecutionCallId()).getState());
        assertEquals(RuntimeSessionRecord.State.READY, sessions.findById(other.binding.getRequest().getScope(), "shared-id").getState());

        Fixture release = new Fixture(bindings, sessions, executions, prefix + "-release-fence");
        RuntimeSessionRecord releasing = sessions.compareAndSet(release.session,
                release.session.withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
        RuntimeBindingRecord releaseLost = release.lose(false);
        assertThrows(RuntimeBrokerException.class, () -> bindings.completeSessionRelease(sessions, releasing));
        assertEquals(RuntimeSessionRecord.State.RELEASING,
                sessions.findById(releasing.getSession().getScope(), releasing.getRuntimeSessionId()).getState());
        RuntimeBindingRecord releaseStopped = bindings.compareAndSet(releaseLost, releaseLost.withRecoveryEvidence(null,
                evidence(releaseLost, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED), Instant.now()));
        assertEquals(RuntimeSessionRecord.State.RELEASED, bindings.completeSessionRelease(sessions, releasing).getState());
        assertEquals(RuntimeBindingRecord.State.RELEASED, bindings.recoverLost(sessions, executions, releaseStopped).getState());

        Fixture unproved = new Fixture(bindings, sessions, executions, prefix + "-unproved");
        RuntimeBindingRecord bare = bindings.compareAndSet(unproved.binding, unproved.binding.withState(
                RuntimeBindingRecord.State.LOST, unproved.binding.getLease(), Instant.now()));
        assertEquals(RuntimeBindingRecord.State.LOST, bindings.recoverLost(sessions, executions, bare).getState());
        assertEquals(1, sessions.countActiveByBinding(bare.getBindingId(), bare.getGeneration()));
        RuntimeScope old = bare.getRequest().getScope();
        RuntimeScope changed = new RuntimeScope(old.getTenantId(), "changed-workspace", "new-generation",
                "/changed", "changed-profile", "workspace");
        assertThrows(RuntimeBrokerException.class, () -> bindings.findOrCreate(
                new RuntimeProvisionRequest(changed, null, "other-provisioner")));
        RuntimeRecoveryEvidence foreign = evidence(bounded.binding, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST);
        assertThrows(IllegalArgumentException.class, () -> bare.withRecoveryEvidence(foreign, null, Instant.now()));
    }

    /**
     * Contract for the release decision's outcomes (#13183 item 1). Every leg
     * is single-threaded, so this pins the state machine and the refusals,
     * not the atomicity itself: the evidence that the no-active-execution
     * check and the RELEASING transition commit as one decision under the
     * Session row lock is the cross-process race in
     * {@code Issue13183AdversarialTest}.
     */
    static void verifyBeginSessionRelease(RuntimeBindingRepository bindings,
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, String prefix) {
        // A READY session with no executions transitions, once.
        Fixture ready = new Fixture(bindings, sessions, executions,
                prefix + "-ready");
        RuntimeSessionRecord releasing = bindings.beginSessionRelease(
                sessions, executions, ready.session);
        assertEquals(RuntimeSessionRecord.State.RELEASING,
                releasing.getState());
        assertEquals(ready.session.getVersion() + 1, releasing.getVersion());
        // Already RELEASING hands the current record back.
        assertEquals(releasing.getVersion(), bindings.beginSessionRelease(
                sessions, executions, releasing).getVersion());
        // A stale snapshot loses.
        assertNull(bindings.beginSessionRelease(sessions, executions,
                ready.session));

        // An active execution blocks the transition and nothing moves.
        Fixture busy = new Fixture(bindings, sessions, executions,
                prefix + "-busy");
        busy.prepare("call");
        RuntimeBrokerException busyFailure = assertThrows(
                RuntimeBrokerException.class, () -> bindings
                        .beginSessionRelease(sessions, executions,
                                busy.session));
        assertEquals("runtime_session_busy", busyFailure.getCode());
        assertEquals(RuntimeSessionRecord.State.READY,
                sessions.findById(busy.session.getSession().getScope(),
                        busy.session.getRuntimeSessionId()).getState());

        // The predicate is session-scoped, not binding-scoped: a sibling
        // session on the same binding, with no execution of its own, still
        // releases while the busy one stays refused. Widening it to the
        // binding would make every healthy session on a busy binding
        // unreleasable, and a single-session fixture cannot tell.
        RuntimeSessionRecord siblingAcquiring = bindings.admitSession(sessions,
                new RuntimeSessionRecord(new RuntimeSession(busy.id + "-harness",
                        busy.session.getRuntimeSessionId() + "-sibling",
                        "bootstrap", busy.binding.getRequest().getScope()),
                        busy.binding.getBindingId(),
                        busy.binding.getGeneration(),
                        RuntimeSessionRecord.State.ACQUIRING, 0,
                        Instant.now()));
        RuntimeSessionRecord sibling = sessions.compareAndSet(
                siblingAcquiring, siblingAcquiring.withState(
                        RuntimeSessionRecord.State.READY, Instant.now()));
        assertEquals(RuntimeSessionRecord.State.RELEASING,
                bindings.beginSessionRelease(sessions, executions, sibling)
                        .getState());
        assertEquals("runtime_session_busy", assertThrows(
                RuntimeBrokerException.class, () -> bindings
                        .beginSessionRelease(sessions, executions,
                                busy.session)).getCode());

        // ACQUIRING transitions (a broker that died mid-acquire).
        Fixture acquiring = new Fixture(bindings, sessions, executions,
                prefix + "-acquiring");
        RuntimeSessionRecord backToAcquiring = sessions.compareAndSet(
                acquiring.session, acquiring.session.withState(
                        RuntimeSessionRecord.State.ACQUIRING, Instant.now()));
        assertEquals(RuntimeSessionRecord.State.RELEASING,
                bindings.beginSessionRelease(sessions, executions,
                        backToAcquiring).getState());

        // A terminal session is refused.
        Fixture failedFixture = new Fixture(bindings, sessions, executions,
                prefix + "-failed");
        RuntimeSessionRecord failedSession = sessions.compareAndSet(
                failedFixture.session, failedFixture.session.withState(
                        RuntimeSessionRecord.State.FAILED, Instant.now()));
        RuntimeBrokerException notReady = assertThrows(
                RuntimeBrokerException.class, () -> bindings
                        .beginSessionRelease(sessions, executions,
                                failedSession));
        assertEquals("runtime_session_not_ready", notReady.getCode());

        // RELEASED hands the current record back.
        Fixture toRelease = new Fixture(bindings, sessions, executions,
                prefix + "-released");
        RuntimeSessionRecord released = bindings.completeSessionRelease(
                sessions, bindings.beginSessionRelease(sessions, executions,
                        toRelease.session));
        assertEquals(RuntimeSessionRecord.State.RELEASED, released.getState());
        assertEquals(RuntimeSessionRecord.State.RELEASED,
                bindings.beginSessionRelease(sessions, executions, released)
                        .getState());
    }

    static RuntimeRecoveryEvidence evidence(RuntimeBindingRecord binding, RuntimeRecoveryEvidence.Fact fact) {
        RuntimeProvisionSeed seed = binding.getProvisionSeed();
        return new RuntimeRecoveryEvidence(UUID.randomUUID().toString(), fact, "deterministic-test-supervisor",
                Instant.now(), "test-host/boot/domain-" + binding.getBindingId(), seed.getProvisionRequestId(),
                seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(),
                binding.getResourceHandle());
    }

    static final class Fixture {
        final String id;
        final RuntimeBindingRepository bindings;
        final RuntimeSessionRepository sessions;
        final ToolExecutionRepository executions;
        final RuntimeBindingRecord binding;
        final RuntimeSessionRecord session;

        Fixture(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
                ToolExecutionRepository executions, String id) {
            this(bindings, sessions, executions, id, id + "-session");
        }

        Fixture(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
                ToolExecutionRepository executions, String id, String runtimeSessionId) {
            this.id = id;
            this.bindings = bindings;
            this.sessions = sessions;
            this.executions = executions;
            RuntimeScope scope = new RuntimeScope(id, "workspace", "generation", "/workspace",
                    "profile", "workspace");
            RuntimeBindingRecord created = bindings.findOrCreate(new RuntimeProvisionRequest(scope, null,
                    "test-supervisor"));
            RuntimeBindingRecord claimed = bindings.claimOperation(created.getBindingId(), "recovery",
                    Duration.ofMinutes(5));
            RuntimeProvisionSeed seed = claimed.getProvisionSeed();
            RuntimeLease lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:2345"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            RuntimeResourceHandle handle = new RuntimeResourceHandle("test-supervisor", 1,
                    Map.of("resource", id));
            binding = bindings.compareAndSet(claimed, claimed.withAttestation(lease, handle, Instant.now(), Instant.now()));
            RuntimeSessionRecord acquiring = bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession(id + "-harness", runtimeSessionId, "bootstrap", scope), binding.getBindingId(),
                    binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
            session = sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        }

        ToolExecutionRecord prepare(String suffix) {
            return bindings.admitExecution(sessions, executions, ToolExecutionRecord.prepared(id + suffix,
                    id + suffix + "-key", binding.getBindingId(), binding.getGeneration(), id + "-harness",
                    session.getRuntimeSessionId(), "turn", suffix, "digest",
                    Map.of("sessionId", session.getRuntimeSessionId(), "promptId", "turn", "callId", suffix,
                            "argsDigest", "digest")));
        }

        RuntimeBindingRecord lose(boolean stopped) {
            return bindings.compareAndSet(binding, binding.withRecoveryEvidence(
                    evidence(binding, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    stopped ? evidence(binding, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED) : null, Instant.now()));
        }
    }
}
