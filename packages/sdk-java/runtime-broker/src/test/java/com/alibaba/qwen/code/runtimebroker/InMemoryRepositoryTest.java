package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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
        RuntimeBindingRecord ready = repository.compareAndSet(created,
                created.withState(RuntimeBindingRecord.State.READY, LEASE,
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
        RuntimeBindingRecord takeover = repository.claimOperation(
                binding.getBindingId(), "owner-b", Duration.ofSeconds(30));
        assertEquals(2, takeover.getOperationGeneration());
        assertEquals("owner-b", takeover.getOperationOwner());
        assertNull(repository.renewOperation(binding.getBindingId(),
                "owner-a", first.getOperationGeneration(),
                Duration.ofSeconds(30)));
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
    }

    @Test
    void executionIdempotencyAndDispatchClaimAreDurablePrimitives()
            throws Exception {
        MutableClock clock = new MutableClock(START);
        InMemoryToolExecutionRepository repository =
                new InMemoryToolExecutionRepository(clock);

        List<ToolExecutionRecord> records = invokeConcurrently(() ->
                repository.findOrCreate(execution(
                        "execution-" + Thread.currentThread().getId())));
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
                first.withResult(result("error"), 0, clock.instant())));

        ToolExecutionRecord settled = repository.compareAndSet(takeover,
                takeover.withResult(result("success"), 0,
                        clock.instant()));
        assertEquals("success", settled.getExecutionStatus());
        assertFalse(repository.hasActiveByRuntimeSession("session"));
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

    private static ToolExecutionRecord execution(String executionCallId) {
        return ToolExecutionRecord.prepared(executionCallId, "key",
                "binding", 1, "harness", "session", "turn", "tool",
                "digest", reference("digest"));
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
