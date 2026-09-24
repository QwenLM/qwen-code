package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

class InMemoryRepositoryTest {
    private static final Instant START = Instant.parse(
            "2026-09-18T00:00:00Z");
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant",
            "workspace", "generation", "/workspace", "capability",
            "session");
    private static final RuntimeProvisionRequest REQUEST =
            new RuntimeProvisionRequest(SCOPE, "harness");
    private static final RuntimeLease LEASE = new RuntimeLease("runtime",
            URI.create("http://127.0.0.1:4096"), "token", "lease", 1);

    @Test
    void bindingFindOrCreateIsAtomicAndStartsOneGeneration()
            throws Exception {
        MutableClock clock = new MutableClock(START);
        AtomicInteger ids = new AtomicInteger();
        InMemoryRuntimeBindingRepository repository =
                new InMemoryRuntimeBindingRepository(clock,
                        () -> "binding-" + ids.incrementAndGet());

        List<RuntimeBindingRecord> records = invokeConcurrently(
                () -> repository.findOrCreate(REQUEST));

        assertEquals(Set.of("binding-1"), records.stream()
                .map(RuntimeBindingRecord::getBindingId)
                .collect(Collectors.toSet()));
        assertEquals(Set.of(1L), records.stream()
                .map(RuntimeBindingRecord::getGeneration)
                .collect(Collectors.toSet()));
        assertEquals(1, ids.get());
    }

    @Test
    void terminalBindingAllowsANewGenerationAndRejectsStaleCas() {
        MutableClock clock = new MutableClock(START);
        AtomicInteger ids = new AtomicInteger();
        InMemoryRuntimeBindingRepository repository =
                new InMemoryRuntimeBindingRepository(clock,
                        () -> "binding-" + ids.incrementAndGet());
        RuntimeBindingRecord created = repository.findOrCreate(REQUEST);
        assertNull(repository.compareAndSet(created,
                created.withState(RuntimeBindingRecord.State.READY, LEASE,
                        START)));
        RuntimeBindingRecord claimed = repository.claimOperation(
                created.getBindingId(), "owner", Duration.ofMinutes(1));
        RuntimeBindingRecord ready = repository.compareAndSet(claimed,
                claimed.withState(RuntimeBindingRecord.State.READY, LEASE,
                        START));

        assertNull(repository.compareAndSet(created,
                created.withDrainRequested(true, START)));
        RuntimeBindingRecord released = repository.compareAndSet(ready,
                ready.withState(RuntimeBindingRecord.State.RELEASED, LEASE,
                        START));
        assertFalse(released.isActive());
        assertNull(repository.findActive(REQUEST));

        RuntimeBindingRecord next = repository.findOrCreate(REQUEST);
        assertEquals(2, next.getGeneration());
        assertEquals("binding-2", next.getBindingId());
        RuntimeBindingRecord forgedExpected = released.withState(
                RuntimeBindingRecord.State.READY, LEASE, START);
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(forgedExpected,
                        forgedExpected.withDrainRequested(true, START)));
        assertSame(next, repository.findActive(REQUEST));
    }

    @Test
    void bindingOperationClaimCanOnlyBeTakenOverAfterExpiry() {
        MutableClock clock = new MutableClock(START);
        InMemoryRuntimeBindingRepository repository =
                new InMemoryRuntimeBindingRepository(clock, () -> "binding");
        RuntimeBindingRecord binding = repository.findOrCreate(REQUEST);

        RuntimeBindingRecord first = repository.claimOperation(
                binding.getBindingId(), "owner-a", Duration.ofSeconds(30));
        assertEquals(1, first.getOperationGeneration());
        assertNull(repository.claimOperation(binding.getBindingId(),
                "owner-b", Duration.ofSeconds(30)));

        clock.advance(Duration.ofSeconds(31));
        assertNull(repository.compareAndSet(first,
                first.withState(RuntimeBindingRecord.State.READY, LEASE,
                        clock.instant())));
        RuntimeBindingRecord takeover = repository.claimOperation(
                binding.getBindingId(), "owner-b", Duration.ofSeconds(30));
        assertEquals(2, takeover.getOperationGeneration());
        assertEquals("owner-b", takeover.getOperationOwner());
        assertNull(repository.renewOperation(binding.getBindingId(),
                "owner-a", first.getOperationGeneration(),
                Duration.ofSeconds(30)));
    }

    @Test
    void bindingCasRejectsStaleVersionWithCurrentOperationClaim() {
        InMemoryRuntimeBindingRepository repository =
                new InMemoryRuntimeBindingRepository(
                        new MutableClock(START), () -> "binding");
        RuntimeBindingRecord created = repository.findOrCreate(REQUEST);
        RuntimeBindingRecord claimed = repository.claimOperation(
                created.getBindingId(), "owner", Duration.ofSeconds(30));
        RuntimeBindingRecord staleVersion = claimed.withVersion(
                created.getVersion());

        assertNull(repository.compareAndSet(staleVersion,
                staleVersion.withDrainRequested(true, START)));
        assertSame(claimed, repository.findById(created.getBindingId()));
    }

    @Test
    void currentOperationOwnerCanRenewItsLease() {
        MutableClock clock = new MutableClock(START);
        InMemoryRuntimeBindingRepository repository =
                new InMemoryRuntimeBindingRepository(clock, () -> "binding");
        RuntimeBindingRecord created = repository.findOrCreate(REQUEST);
        RuntimeBindingRecord claimed = repository.claimOperation(
                created.getBindingId(), "owner", Duration.ofSeconds(30));
        clock.advance(Duration.ofSeconds(10));

        RuntimeBindingRecord renewed = repository.renewOperation(
                created.getBindingId(), "owner",
                claimed.getOperationGeneration(), Duration.ofSeconds(30));

        assertEquals(claimed.getOperationGeneration(),
                renewed.getOperationGeneration());
        assertEquals(claimed.getVersion() + 1, renewed.getVersion());
        assertEquals(clock.instant().plusSeconds(30),
                renewed.getOperationLeaseUntil());
        assertSame(renewed, repository.findById(created.getBindingId()));
    }

    @Test
    void runtimePlacementNeverReusesAcrossTenants() {
        AtomicInteger ids = new AtomicInteger();
        InMemoryRuntimeBindingRepository repository =
                new InMemoryRuntimeBindingRepository(
                        new MutableClock(START),
                        () -> "binding-" + ids.incrementAndGet());
        RuntimeScope otherScope = new RuntimeScope("other-tenant",
                "workspace", "generation", "/workspace", "capability",
                "session");

        RuntimeBindingRecord first = repository.findOrCreate(REQUEST);
        RuntimeBindingRecord other = repository.findOrCreate(
                new RuntimeProvisionRequest(otherScope, "harness"));

        assertEquals("binding-1", first.getBindingId());
        assertEquals("binding-2", other.getBindingId());
        assertEquals(1, first.getGeneration());
        assertEquals(1, other.getGeneration());
        assertEquals(List.of(first), repository.findActiveByIsolationKey(
                SCOPE, "harness"));
        assertEquals(List.of(other), repository.findActiveByIsolationKey(
                otherScope, "harness"));
    }

    @Test
    void duplicateGeneratedBindingIdFailsWithoutOverwriting() {
        InMemoryRuntimeBindingRepository repository =
                new InMemoryRuntimeBindingRepository(
                        new MutableClock(START), () -> "binding");
        RuntimeBindingRecord first = repository.findOrCreate(REQUEST);
        RuntimeScope otherScope = new RuntimeScope("other-tenant",
                "workspace", "generation", "/workspace", "capability",
                "session");

        assertThrows(IllegalStateException.class,
                () -> repository.findOrCreate(
                        new RuntimeProvisionRequest(otherScope, "harness")));
        assertSame(first, repository.findById("binding"));
    }

    @Test
    void runtimeSessionIdentityIsStableAndActiveCountIsDerived() {
        InMemoryRuntimeSessionRepository repository =
                new InMemoryRuntimeSessionRepository();
        RuntimeSession session = new RuntimeSession("harness", "session",
                "bootstrap", SCOPE);
        RuntimeSessionRecord candidate = new RuntimeSessionRecord(session,
                "binding", 1, RuntimeSessionRecord.State.ACQUIRING, 0,
                START);

        assertSame(candidate, repository.findOrCreate(candidate));
        assertSame(candidate, repository.findOrCreate(new RuntimeSessionRecord(
                session, "binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START)));
        RuntimeSession conflictingSession = new RuntimeSession(
                "other-harness", "session", "bootstrap", SCOPE);
        RuntimeSessionRecord conflicting = new RuntimeSessionRecord(
                conflictingSession, "binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertThrows(IllegalArgumentException.class,
                () -> repository.findOrCreate(conflicting));
        assertFalse(candidate.sameIdentity(conflicting));
        RuntimeScope otherScope = new RuntimeScope("other-tenant",
                "workspace", "generation", "/workspace", "capability",
                "session");
        RuntimeSessionRecord otherCandidate = new RuntimeSessionRecord(
                new RuntimeSession("harness", "session", "bootstrap",
                        otherScope),
                "other-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertSame(otherCandidate, repository.findOrCreate(otherCandidate));
        assertSame(candidate, repository.findById(SCOPE, "session"));
        assertSame(otherCandidate,
                repository.findById(otherScope, "session"));
        assertEquals(1, repository.countActiveByBinding("binding", 1));

        RuntimeSessionRecord released = repository.compareAndSet(candidate,
                candidate.withState(RuntimeSessionRecord.State.RELEASED,
                        START));
        assertEquals(0, repository.countActiveByBinding("binding", 1));
        assertNull(repository.compareAndSet(candidate,
                candidate.withState(RuntimeSessionRecord.State.FAILED,
                        START)));
        assertEquals(RuntimeSessionRecord.State.RELEASED,
                released.getState());
        RuntimeSessionRecord forgedExpected = released.withState(
                RuntimeSessionRecord.State.READY, START);
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(forgedExpected,
                        forgedExpected.withState(
                                RuntimeSessionRecord.State.RELEASING,
                                START)));
    }

    @Test
    void runtimeSessionRequiresAnAuthoritativeScope() {
        assertThrows(IllegalArgumentException.class,
                () -> new RuntimeSession("harness", "session",
                        "bootstrap", null));
    }

    @Test
    void runtimeSessionReplacementCannotMoveAcrossScopes() {
        InMemoryRuntimeSessionRepository repository =
                new InMemoryRuntimeSessionRepository();
        RuntimeSessionRecord current = new RuntimeSessionRecord(
                new RuntimeSession("harness", "session", "bootstrap",
                        SCOPE),
                "binding", 1, RuntimeSessionRecord.State.ACQUIRING, 0,
                START);
        repository.findOrCreate(current);
        RuntimeScope otherScope = new RuntimeScope("other-tenant",
                "workspace", "generation", "/workspace", "capability",
                "session");
        RuntimeSessionRecord replacement = new RuntimeSessionRecord(
                new RuntimeSession("harness", "session", "bootstrap",
                        otherScope),
                "binding", 1, RuntimeSessionRecord.State.READY,
                current.getVersion(), START);

        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(current, replacement));
        assertSame(current, repository.findById(SCOPE, "session"));
        assertNull(repository.findById(otherScope, "session"));
    }

    @Test
    void executionIdempotencyAndDispatchClaimAreDurablePrimitives()
            throws Exception {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);

        List<ToolExecutionRecord> records = invokeConcurrently(() ->
                repository.findOrCreate(execution(
                        "execution-" + Thread.currentThread().threadId())));
        Set<String> executionIds = records.stream()
                .map(ToolExecutionRecord::getExecutionCallId)
                .collect(Collectors.toSet());
        assertEquals(1, executionIds.size());
        String executionId = executionIds.iterator().next();

        ToolExecutionRecord first = repository.claimDispatch(executionId,
                "owner-a", Duration.ofSeconds(30));
        assertEquals(1, first.getDispatchGeneration());
        assertNull(repository.claimDispatch(executionId, "owner-b",
                Duration.ofSeconds(30)));
        assertTrue(repository.hasActiveByRuntimeSession("session"));

        clock.advance(Duration.ofSeconds(31));
        ToolExecutionRecord takeover = repository.claimDispatch(executionId,
                "owner-b", Duration.ofSeconds(30));
        assertEquals(2, takeover.getDispatchGeneration());
        assertNull(repository.compareAndSet(first,
                first.withResult(result("error"), 0, clock.instant()),
                "owner-a", 1));

        ToolExecutionRecord settled = repository.compareAndSet(takeover,
                takeover.withResult(result("success"), 0,
                        clock.instant()), "owner-b", 2);
        assertEquals("success", settled.getExecutionStatus());
        assertFalse(repository.hasActiveByRuntimeSession("session"));
        assertNull(repository.compareAndSet(settled,
                settled.withState(ToolExecutionRecord.State.PREPARED,
                        false), "owner-b", 2));
    }

    @Test
    void claimDispatchNeverWritesALiveClaim() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        repository.findOrCreate(execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch("execution",
                "owner-a", Duration.ofSeconds(30));
        ToolExecutionRecord executing = repository.compareAndSet(claimed,
                claimed.withState(ToolExecutionRecord.State.EXECUTING,
                        false), "owner-a", 1);

        ToolExecutionRecord own = repository.claimDispatch("execution",
                "owner-a", Duration.ofMinutes(5));
        assertNull(repository.claimDispatch("execution", "owner-b",
                Duration.ofSeconds(30)));

        ToolExecutionRecord stored = repository.findByExecutionCallId(
                "execution");
        assertEquals(executing.getVersion(), own.getVersion());
        assertEquals(ToolExecutionRecord.State.EXECUTING, stored.getState());
        assertEquals(executing.getVersion(), stored.getVersion());
        assertEquals(executing.getDispatchLeaseUntil(),
                stored.getDispatchLeaseUntil());
    }

    @Test
    void executionIdempotencyReturnsOriginalIdentityForConflictChecking() {
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(new MutableClock(START));
        ToolExecutionRecord original = execution("execution-a");
        ToolExecutionRecord duplicate = new ToolExecutionRecord(
                "execution-b", original.getIdempotencyKey(), "binding", 1,
                "harness", "session", "turn", "tool", "changed",
                reference("changed"), ToolExecutionRecord.State.PREPARED,
                null, null, 0, false, null, null, 0, 0, null);

        assertSame(original, repository.findOrCreate(original));
        assertSame(original, repository.findOrCreate(duplicate));
        assertFalse(original.sameRequest(duplicate));
    }

    @Test
    void settlementRequiresTheCurrentDispatchClaim() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord first = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        clock.advance(Duration.ofSeconds(31));
        ToolExecutionRecord takeover = repository.claimDispatch(
                created.getExecutionCallId(), "owner-b",
                Duration.ofSeconds(30));

        // Same record version, but the stale owner's claim: fencing, not
        // optimistic versioning, must reject the settlement.
        ToolExecutionRecord staleClaim = takeover.withDispatch("owner-a",
                first.getDispatchLeaseUntil(),
                first.getDispatchGeneration(), takeover.getState());
        assertNull(repository.compareAndSet(staleClaim,
                staleClaim.withResult(result("error"), 0,
                        clock.instant()), "owner-a", 1));

        ToolExecutionRecord noClaim = takeover.withDispatch(null, null, 0,
                takeover.getState());
        assertNull(repository.compareAndSet(noClaim,
                noClaim.withResult(result("error"), 0, clock.instant()),
                null, 0));

        assertSame(takeover, repository.findByExecutionCallId(
                created.getExecutionCallId()));
    }

    @Test
    void replacementCannotHandOverTheDispatchClaim() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));

        // Only claimDispatch moves a claim, after its lease lapses and at a
        // new generation; the holder's compareAndSet replacement must repeat
        // it.
        ToolExecutionRecord handedOver = claimed.withDispatch("owner-b",
                claimed.getDispatchLeaseUntil(),
                claimed.getDispatchGeneration(), claimed.getState());
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(claimed, handedOver,
                        "owner-a", 1));
        ToolExecutionRecord nextGeneration = claimed.withDispatch("owner-a",
                claimed.getDispatchLeaseUntil(),
                claimed.getDispatchGeneration() + 1, claimed.getState());
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(claimed, nextGeneration,
                        "owner-a", 1));
        assertSame(claimed, repository.findByExecutionCallId(
                created.getExecutionCallId()));
    }

    @Test
    void replacementKeepsTheSnapshotIdentityAndVersion() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord otherRequest = ToolExecutionRecord.prepared(
                "execution", "key", "binding", 1, "harness", "session",
                "turn", "tool", "other", reference("other")).withDispatch(
                        "owner-a", claimed.getDispatchLeaseUntil(),
                        claimed.getDispatchGeneration(), claimed.getState())
                .withVersion(claimed.getVersion());
        ToolExecutionRecord executing = claimed.withState(
                ToolExecutionRecord.State.EXECUTING, false);

        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(claimed,
                        otherRequest.withState(
                                ToolExecutionRecord.State.EXECUTING, false),
                        "owner-a", 1));
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(claimed,
                        executing.withVersion(claimed.getVersion() + 1),
                        "owner-a", 1));
        assertSame(claimed, repository.findByExecutionCallId(
                created.getExecutionCallId()));
    }

    @Test
    void onlyAFreshPreparedCandidateIsCreated() {
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(
                        new MutableClock(START));

        assertThrows(IllegalArgumentException.class,
                () -> repository.findOrCreate(execution("versioned")
                        .withVersion(1)));
        assertThrows(IllegalArgumentException.class,
                () -> repository.findOrCreate(execution("claimed")
                        .withDispatch("owner-a", START, 1,
                                ToolExecutionRecord.State.PREPARED)));
        assertThrows(IllegalArgumentException.class,
                () -> repository.findOrCreate(execution("stated")
                        .withState(ToolExecutionRecord.State.EXECUTING,
                                false)));
        assertNull(repository.findByIdempotencyKey("key"));

        // An executionCallId that already belongs to another request is
        // refused rather than returned.
        repository.findOrCreate(execution("execution"));
        assertThrows(IllegalArgumentException.class,
                () -> repository.findOrCreate(ToolExecutionRecord.prepared(
                        "execution", "other-key", "binding", 1, "harness",
                        "session", "turn", "tool", "digest",
                        reference("digest"))));
    }

    @Test
    void compareAndSetRequiresTheStoredSnapshot() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        Map<String, ToolExecutionRecord> forgeries = new LinkedHashMap<>();
        forgeries.put("request", ToolExecutionRecord.prepared("execution",
                "key", "binding", 1, "harness", "session", "turn", "tool",
                "other", reference("other")).withDispatch("owner-a",
                        claimed.getDispatchLeaseUntil(),
                        claimed.getDispatchGeneration(), claimed.getState())
                .withVersion(claimed.getVersion()));
        forgeries.put("key", withIdentity(claimed, "other", "binding", 1,
                "harness"));
        forgeries.put("binding", withIdentity(claimed, "key", "other", 1,
                "harness"));
        forgeries.put("runtime generation", withIdentity(claimed, "key",
                "binding", 2, "harness"));
        forgeries.put("harness", withIdentity(claimed, "key", "binding", 1,
                "other"));
        forgeries.put("lease", claimed.withDispatch("owner-a",
                claimed.getDispatchLeaseUntil().plus(Duration.ofDays(1)),
                claimed.getDispatchGeneration(), claimed.getState()));
        forgeries.put("version", claimed.withVersion(
                claimed.getVersion() - 1));

        for (Map.Entry<String, ToolExecutionRecord> forged
                : forgeries.entrySet()) {
            assertNull(repository.compareAndSet(forged.getValue(),
                    forged.getValue().withState(
                            ToolExecutionRecord.State.EXECUTING, false),
                    "owner-a", 1), forged.getKey());
        }
        assertSame(claimed, repository.findByExecutionCallId(
                created.getExecutionCallId()));
        ToolExecutionRecord executing = repository.compareAndSet(claimed,
                claimed.withState(ToolExecutionRecord.State.EXECUTING,
                        false), "owner-a", 1);
        assertEquals(claimed.getVersion() + 1, executing.getVersion());
    }

    @Test
    void settlementRequiresALiveLease() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));

        clock.advance(Duration.ofSeconds(31));
        assertNull(repository.compareAndSet(claimed,
                claimed.withResult(result("success"), 0,
                        clock.instant()), "owner-a", 1));
        assertNull(repository.renewDispatch(created.getExecutionCallId(),
                "owner-a", claimed.getDispatchGeneration(),
                Duration.ofSeconds(30)));

        // Re-claiming a DISPATCHING record is safe: nothing physically ran.
        ToolExecutionRecord reclaimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        assertEquals(claimed.getDispatchGeneration() + 1,
                reclaimed.getDispatchGeneration());
        ToolExecutionRecord settled = repository.compareAndSet(reclaimed,
                reclaimed.withResult(result("success"), 0,
                        clock.instant()), "owner-a", 2);
        assertEquals("success", settled.getExecutionStatus());
    }

    @Test
    void takeoverOfExecutingClaimBecomesUnknown() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord executing = repository.compareAndSet(claimed,
                claimed.withState(ToolExecutionRecord.State.EXECUTING,
                        false), "owner-a", 1);

        clock.advance(Duration.ofSeconds(31));
        assertNull(repository.claimDispatch(created.getExecutionCallId(),
                "owner-b", Duration.ofSeconds(30)));

        ToolExecutionRecord unknown = repository.findByExecutionCallId(
                created.getExecutionCallId());
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        assertEquals("owner-a", unknown.getDispatchOwner());

        assertNull(repository.compareAndSet(executing,
                executing.withResult(result("success"), 0,
                        clock.instant()), "owner-a", 1));
        assertNull(repository.claimDispatch(created.getExecutionCallId(),
                "owner-b", Duration.ofSeconds(30)));
        assertNull(repository.renewDispatch(created.getExecutionCallId(),
                "owner-a", executing.getDispatchGeneration(),
                Duration.ofSeconds(30)));
        assertTrue(repository.hasActiveByRuntimeSession("session"));

        ToolExecutionRecord resolved = repository.resolveUnknown(unknown,
                result("cancelled"), clock.instant());
        assertEquals("cancelled", resolved.getExecutionStatus());
        // The last claim survives settlement for attestation.
        assertEquals("owner-a", resolved.getDispatchOwner());
        assertEquals(unknown.getDispatchLeaseUntil(),
                resolved.getDispatchLeaseUntil());
        assertFalse(repository.hasActiveByRuntimeSession("session"));
        assertNull(repository.resolveUnknown(resolved, result("error"),
                clock.instant()));
        assertNull(repository.compareAndSet(resolved,
                resolved.withState(ToolExecutionRecord.State.PREPARED,
                        false), "owner-a", 1));
    }

    @Test
    void cancellationIntentDoesNotRequireTheDispatchClaim() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord executing = repository.compareAndSet(claimed,
                claimed.withState(ToolExecutionRecord.State.EXECUTING,
                        false), "owner-a", 1);

        ToolExecutionRecord requested = repository.requestCancel(
                created.getExecutionCallId(), executing.getVersion());
        assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                requested.getState());
        assertSame(requested, repository.requestCancel(
                created.getExecutionCallId(), requested.getVersion()));
        assertNull(repository.requestCancel(created.getExecutionCallId(),
                requested.getVersion() - 1));

        ToolExecutionRecord dropping = repository.findByExecutionCallId(
                created.getExecutionCallId());
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(dropping,
                        dropping.withState(
                                ToolExecutionRecord.State.CANCEL_REQUESTED,
                                false), "owner-a", 1));

        ToolExecutionRecord settled = repository.compareAndSet(dropping,
                dropping.withResult(result("cancelled"), 0,
                        clock.instant()), "owner-a", 1);
        assertTrue(settled.isCancelRequested());
        assertNull(repository.requestCancel(created.getExecutionCallId(),
                settled.getVersion()));
    }

    @Test
    void cancelBeforeDispatchSettlesImmediately() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));

        ToolExecutionRecord settled = repository.requestCancel(
                created.getExecutionCallId(), created.getVersion());
        assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
        assertEquals("cancelled", settled.getExecutionStatus());
        assertTrue(settled.isCancelRequested());
        assertFalse(repository.hasActiveByRuntimeSession("session"));
        assertNull(repository.requestCancel(created.getExecutionCallId(),
                created.getVersion()));
    }

    @Test
    void cancelWhileDispatchingKeepsStateAndSurvivesTakeover() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));

        ToolExecutionRecord requested = repository.requestCancel(
                created.getExecutionCallId(), claimed.getVersion());
        assertEquals(ToolExecutionRecord.State.DISPATCHING,
                requested.getState());
        assertTrue(requested.isCancelRequested());

        clock.advance(Duration.ofSeconds(31));
        ToolExecutionRecord takeover = repository.claimDispatch(
                created.getExecutionCallId(), "owner-b",
                Duration.ofSeconds(30));
        assertTrue(takeover.isCancelRequested());
        // The new owner honours the intent instead of dispatching again.
        ToolExecutionRecord settled = repository.compareAndSet(takeover,
                takeover.withResult(result("cancelled"), 0,
                        clock.instant()), "owner-b", 2);
        assertEquals("cancelled", settled.getExecutionStatus());
    }

    @Test
    void staleOwnerCannotSettleAfterReReadingAFreshVersion() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        repository.claimDispatch(created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        clock.advance(Duration.ofSeconds(31));
        ToolExecutionRecord takeover = repository.claimDispatch(
                created.getExecutionCallId(), "owner-b",
                Duration.ofSeconds(30));

        // Owner A re-reads for a fresh version; its settlement must fail.
        ToolExecutionRecord reread = repository.findByExecutionCallId(
                created.getExecutionCallId());
        assertNull(repository.compareAndSet(reread,
                reread.withResult(result("error"), 0, clock.instant()),
                "owner-a", 1));
        // Right generation, wrong owner: still not owner B's claim.
        assertNull(repository.compareAndSet(reread,
                reread.withResult(result("error"), 0, clock.instant()),
                "owner-a", 2));
        ToolExecutionRecord settled = repository.compareAndSet(takeover,
                takeover.withResult(result("success"), 0, clock.instant()),
                "owner-b", 2);
        assertEquals("success", settled.getExecutionStatus());
    }

    @Test
    void sameOwnerCannotWriteWithAStaleGeneration() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        repository.claimDispatch(created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        clock.advance(Duration.ofSeconds(31));
        ToolExecutionRecord reclaimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        assertEquals(2, reclaimed.getDispatchGeneration());

        // Same owner, but the generation it claimed first: fenced off.
        assertNull(repository.compareAndSet(reclaimed,
                reclaimed.withResult(result("error"), 0, clock.instant()),
                "owner-a", 1));
        assertEquals("success", repository.compareAndSet(reclaimed,
                reclaimed.withResult(result("success"), 0, clock.instant()),
                "owner-a", 2).getExecutionStatus());
    }

    @Test
    void renewalRequiresTheCurrentOwnerAndGeneration() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord first = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        clock.advance(Duration.ofSeconds(31));
        ToolExecutionRecord reclaimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));

        // The first claim's heartbeat must not extend the second claim, and
        // another owner presenting the live generation must not take it.
        assertNull(repository.renewDispatch(created.getExecutionCallId(),
                "owner-a", first.getDispatchGeneration(),
                Duration.ofSeconds(30)));
        assertNull(repository.renewDispatch(created.getExecutionCallId(),
                "owner-b", reclaimed.getDispatchGeneration(),
                Duration.ofSeconds(30)));
        assertSame(reclaimed, repository.findByExecutionCallId(
                created.getExecutionCallId()));
        ToolExecutionRecord renewed = repository.renewDispatch(
                created.getExecutionCallId(), "owner-a",
                reclaimed.getDispatchGeneration(), Duration.ofSeconds(30));
        assertEquals(reclaimed.getVersion() + 1, renewed.getVersion());
    }

    @Test
    void renewalRefusesASettledOrUnknownExecution() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository settledRepository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord settling = settledRepository.claimDispatch(
                settledRepository.findOrCreate(execution("execution"))
                        .getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        settledRepository.compareAndSet(settling, settling.withResult(
                result("success"), 0, clock.instant()), "owner-a", 1);
        InMemoryToolExecutionRepository unknownRepository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord reporting = unknownRepository.claimDispatch(
                unknownRepository.findOrCreate(execution("execution"))
                        .getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        unknownRepository.compareAndSet(reporting, reporting.withUnknown(),
                "owner-a", 1);

        // Both records keep the live claim they were written under, yet
        // renewal must refuse them.
        assertNull(settledRepository.renewDispatch("execution", "owner-a", 1,
                Duration.ofSeconds(30)));
        assertNull(unknownRepository.renewDispatch("execution", "owner-a", 1,
                Duration.ofSeconds(30)));
    }

    @Test
    void executionStateDoesNotMoveBackwards() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord executing = repository.compareAndSet(claimed,
                claimed.withState(ToolExecutionRecord.State.EXECUTING,
                        false), "owner-a", 1);

        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(executing,
                        executing.withState(
                                ToolExecutionRecord.State.PREPARED, false),
                        "owner-a", 1));
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(executing,
                        executing.withState(
                                ToolExecutionRecord.State.DISPATCHING,
                                false), "owner-a", 1));

        // The dispatcher's own ambiguous-outcome report stays legal.
        ToolExecutionRecord unknown = repository.compareAndSet(executing,
                executing.withUnknown(), "owner-a", 1);
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        assertEquals("owner-a", unknown.getDispatchOwner());
    }

    @Test
    void unknownExecutionSettlesOnlyThroughRecovery() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord unknown = repository.compareAndSet(claimed,
                claimed.withUnknown(), "owner-a", 1);

        // The reporting dispatcher still holds a live claim, yet only
        // resolveUnknown may settle an UNKNOWN execution.
        assertNull(repository.compareAndSet(unknown,
                unknown.withResult(result("success"), 0, clock.instant()),
                "owner-a", 1));
        assertSame(unknown, repository.findByExecutionCallId(
                created.getExecutionCallId()));
        // Recovery must present the stored version and identity.
        assertNull(repository.resolveUnknown(unknown.withVersion(
                unknown.getVersion() - 1), result("success"),
                clock.instant()));
        assertNull(repository.resolveUnknown(ToolExecutionRecord.prepared(
                "execution", "key", "binding", 1, "harness", "session",
                "turn", "tool", "other", reference("other")).withVersion(
                        unknown.getVersion()), result("success"),
                clock.instant()));
        assertEquals("success", repository.resolveUnknown(unknown,
                result("success"), clock.instant()).getExecutionStatus());
    }

    @Test
    void cancellationStickinessReadsTheStoredRecord() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord flagged = repository.requestCancel(
                created.getExecutionCallId(), claimed.getVersion());
        assertTrue(flagged.isCancelRequested());

        // A caller-derived snapshot with the flag dropped must not erase
        // the stored intent, even from the claim holder itself.
        ToolExecutionRecord forged = flagged.withState(
                ToolExecutionRecord.State.DISPATCHING, false);
        assertFalse(forged.isCancelRequested());
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(forged, forged, "owner-a",
                        1));
        assertTrue(repository.findByExecutionCallId(
                created.getExecutionCallId()).isCancelRequested());
    }

    @Test
    void resultSequenceCannotMoveBackwards() {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);
        ToolExecutionRecord progressed = new ToolExecutionRecord(
                "execution", "key", "binding", 1, "harness", "session",
                "turn", "tool", "digest", reference("digest"),
                ToolExecutionRecord.State.PREPARED, null, null, 5, false,
                null, null, 0, 0, null);
        assertThrows(IllegalArgumentException.class,
                () -> repository.findOrCreate(progressed));

        ToolExecutionRecord atFive = new ToolExecutionRecord("execution",
                "key", "binding", 1, "harness", "session", "turn", "tool",
                "digest", reference("digest"),
                ToolExecutionRecord.State.DISPATCHING, null, null, 5, false,
                "owner-a", START.plusSeconds(30), 1, 1, null);
        ToolExecutionRecord regressed = new ToolExecutionRecord("execution",
                "key", "binding", 1, "harness", "session", "turn", "tool",
                "digest", reference("digest"),
                ToolExecutionRecord.State.DISPATCHING, null, null, 0, false,
                "owner-a", START.plusSeconds(30), 1, 1, null);
        assertThrows(IllegalArgumentException.class,
                () -> repository.compareAndSet(atFive, regressed, "owner-a",
                        1));

        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord settled = repository.compareAndSet(claimed,
                claimed.withResult(result("success"), 7, clock.instant()),
                "owner-a", 1);
        assertEquals(7, settled.getLastSequence());
        assertThrows(IllegalArgumentException.class,
                () -> settled.withResult(result("error"), 6,
                        clock.instant()));
    }

    @Test
    void payloadsRejectInvalidNumbersAndNonStringKeys() {
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(new MutableClock(START));
        Map<String, Object> topLevel = new HashMap<>(reference("digest"));
        topLevel.put("tokens", new AtomicLong(1));
        assertThrows(IllegalArgumentException.class,
                () -> ToolExecutionRecord.prepared("execution", "key",
                        "binding", 1, "harness", "session", "turn", "tool",
                        "digest", topLevel));
        Map<String, Object> nested = new HashMap<>(reference("digest"));
        nested.put("tokens", Map.of("deep", new AtomicLong(1)));
        assertThrows(IllegalArgumentException.class,
                () -> ToolExecutionRecord.prepared("execution", "key",
                        "binding", 1, "harness", "session", "turn", "tool",
                        "digest", nested));
        Map<String, Object> badKey = new HashMap<>(reference("digest"));
        badKey.put("nested", Map.of(1, "x"));
        assertThrows(IllegalArgumentException.class,
                () -> ToolExecutionRecord.prepared("execution", "key",
                        "binding", 1, "harness", "session", "turn", "tool",
                        "digest", badKey));
        for (Number nonFinite : List.of(Double.NaN,
                Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY,
                Float.NaN, Float.POSITIVE_INFINITY,
                Float.NEGATIVE_INFINITY)) {
            Map<String, Object> invalid = new HashMap<>(reference("digest"));
            invalid.put("tokens", nonFinite);
            assertThrows(IllegalArgumentException.class,
                    () -> ToolExecutionRecord.prepared("execution", "key",
                            "binding", 1, "harness", "session", "turn",
                            "tool", "digest", invalid));
        }
        assertTrue(BrokerValues.sameJsonMap(
                Map.of("value", 162544.13f),
                Map.of("value", new BigDecimal("162544.13"))));
        assertFalse(BrokerValues.sameJsonMap(
                Map.of("value", 9_007_199_254_740_993L),
                Map.of("value", 9_007_199_254_740_992d)));
        assertFalse(BrokerValues.sameJsonMap(
                Map.of("value", 16_777_217),
                Map.of("value", 16_777_216f)));

        ToolExecutionRecord created = repository.findOrCreate(
                execution("execution"));
        assertThrows(IllegalArgumentException.class,
                () -> created.withResult(
                        Map.of("executionStatus", "success", "tokens",
                                new AtomicLong(1)),
                        0, START));
        assertThrows(IllegalArgumentException.class,
                () -> created.withResult(
                        Map.of("executionStatus", "success", "tokens",
                                Double.NaN),
                        0, START));
        ToolExecutionRecord claimed = repository.claimDispatch(
                created.getExecutionCallId(), "owner-a",
                Duration.ofSeconds(30));
        ToolExecutionRecord settled = repository.compareAndSet(claimed,
                claimed.withResult(
                        Map.of("executionStatus", "success", "tokens", 1L),
                        0, START),
                "owner-a", 1);
        assertEquals("success", settled.getExecutionStatus());
    }

    @Test
    void cancelRequestedStateRequiresTheFlag() {
        assertThrows(IllegalArgumentException.class,
                () -> new ToolExecutionRecord("execution", "key", "binding",
                        1, "harness", "session", "turn", "tool", "digest",
                        reference("digest"),
                        ToolExecutionRecord.State.CANCEL_REQUESTED, null,
                        null, 0, false, null, null, 0, 0, null));
    }

    private static ToolExecutionRecord execution(String executionCallId) {
        return ToolExecutionRecord.prepared(executionCallId, "key",
                "binding", 1, "harness", "session", "turn", "tool",
                "digest", reference("digest"));
    }

    private static ToolExecutionRecord withIdentity(
            ToolExecutionRecord claimed, String idempotencyKey,
            String bindingId, long runtimeGeneration,
            String harnessSessionId) {
        return ToolExecutionRecord.prepared(claimed.getExecutionCallId(),
                idempotencyKey, bindingId, runtimeGeneration,
                harnessSessionId, claimed.getRuntimeSessionId(),
                claimed.getTurnId(), claimed.getToolCallId(),
                claimed.getRequestDigest(), claimed.getReference())
                .withDispatch(claimed.getDispatchOwner(),
                        claimed.getDispatchLeaseUntil(),
                        claimed.getDispatchGeneration(), claimed.getState())
                .withVersion(claimed.getVersion());
    }

    private static Map<String, Object> reference(String digest) {
        return Map.of("sessionId", "session", "promptId", "turn",
                "callId", "tool", "argsDigest", digest);
    }

    private static Map<String, Object> result(String status) {
        return Map.of("executionStatus", status);
    }

    private static <T> List<T> invokeConcurrently(Callable<T> operation)
            throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(8);
        try {
            List<Future<T>> futures = new ArrayList<>();
            for (int index = 0; index < 32; index++) {
                futures.add(executor.submit(operation));
            }
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get());
            }
            return results;
        } finally {
            executor.shutdownNow();
        }
    }

    private static final class MutableClock extends Clock {
        private Instant current;

        MutableClock(Instant current) {
            this.current = current;
        }

        synchronized void advance(Duration duration) {
            current = current.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public synchronized Instant instant() {
            return current;
        }
    }
}
