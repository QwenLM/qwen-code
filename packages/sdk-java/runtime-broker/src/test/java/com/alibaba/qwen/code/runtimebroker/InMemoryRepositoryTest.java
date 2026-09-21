package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
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
