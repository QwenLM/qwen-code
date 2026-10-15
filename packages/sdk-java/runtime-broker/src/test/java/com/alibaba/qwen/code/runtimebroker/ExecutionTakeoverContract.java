package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class ExecutionTakeoverContract {
    private ExecutionTakeoverContract() {
    }

    static void verify(ToolExecutionRepository repository, String prefix) {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "generation",
                "/workspace", "capability", "session");
        RuntimeSessionRecord session = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-harness", prefix + "-session", "bootstrap", scope),
                prefix + "-binding", 1, RuntimeSessionRecord.State.READY, 0, Instant.now());
        Set<String> expected = new HashSet<>();
        for (int i = 0; i < 105; i++) {
            ToolExecutionRecord record = executing(repository, session, prefix + "-" + i);
            expected.add(record.getExecutionCallId());
        }
        for (int i = 0; i < 4; i++) {
            RuntimeSessionRecord other = new RuntimeSessionRecord(
                    new RuntimeSession(i == 0 ? prefix + "-other-harness" : prefix + "-harness",
                            i == 1 ? prefix + "-other-session" : prefix + "-session", "bootstrap", scope),
                    i == 2 ? prefix + "-other-binding" : prefix + "-binding",
                    i == 3 ? 2 : 1, RuntimeSessionRecord.State.READY, 0, Instant.now());
            executing(repository, other, prefix + "-foreign-" + i);
        }
        ToolExecutionRecord prepared = repository.findOrCreate(prepared(session, prefix + "-prepared"));
        ToolExecutionRecord dispatching = repository.findOrCreate(prepared(session, prefix + "-dispatching"));
        dispatching = repository.claimDispatch(dispatching.getExecutionCallId(), "old-owner", Duration.ofMinutes(10));
        Map<String, Object> result = Map.of("executionStatus", "success");
        assertNull(repository.resolveUnsettled(prepared, result, Instant.now()));
        assertNull(repository.resolveUnsettled(dispatching, result, Instant.now()));
        assertThrows(IllegalArgumentException.class, () -> repository.findUnsettled(session, null, 0));
        assertThrows(IllegalArgumentException.class, () -> repository.findUnsettled(session, null, 101));

        List<ToolExecutionRecord> first = repository.findUnsettled(session, null, 100);
        assertEquals(100, first.size());
        Set<String> visited = new HashSet<>();
        first.forEach(record -> assertTrue(visited.add(record.getExecutionCallId())));
        ToolExecutionRecord old = first.get(99);
        ToolExecutionRecord cancelled = repository.requestCancel(old.getExecutionCallId(), old.getVersion());
        assertNull(repository.resolveUnsettled(old, result, Instant.now()), "stale version must fail");
        ToolExecutionRecord forged = ToolExecutionRecordFixtures.withIdentity(old.withVersion(cancelled.getVersion()),
                cancelled.getIdempotencyKey(), cancelled.getBindingId(), 2, cancelled.getHarnessSessionId());
        assertNull(repository.resolveUnsettled(forged, result, Instant.now()), "wrong generation must fail");
        assertNull(repository.resolveUnknown(cancelled, result, Instant.now()), "old API remains UNKNOWN-only");
        assertThrows(IllegalArgumentException.class,
                () -> repository.resolveUnsettled(cancelled, Map.of("executionStatus", "invalid"), Instant.now()));
        ToolExecutionRecord settled = repository.resolveUnsettled(cancelled, result, Instant.now());
        assertEquals(ToolExecutionRecord.State.SETTLED, settled.getState());
        assertEquals(cancelled.getVersion() + 1, settled.getVersion());
        assertEquals(cancelled.getDispatchOwner(), settled.getDispatchOwner());
        assertEquals(cancelled.getDispatchGeneration(), settled.getDispatchGeneration());
        assertEquals(cancelled.getDispatchLeaseUntil(), settled.getDispatchLeaseUntil());
        assertEquals(cancelled.getLastSequence(), settled.getLastSequence());
        assertTrue(settled.isCancelRequested());
        assertNull(repository.resolveUnsettled(settled, Map.of("executionStatus", "error"), Instant.now()));
        assertNull(repository.compareAndSet(cancelled, cancelled.withResult(result, 0, Instant.now()),
                cancelled.getDispatchOwner(), cancelled.getDispatchGeneration()), "old dispatcher cannot overwrite");

        List<ToolExecutionRecord> second = repository.findUnsettled(session, old.getExecutionCallId(), 100);
        assertEquals(5, second.size(), "settling the cursor must not shift the page");
        second.forEach(record -> assertTrue(visited.add(record.getExecutionCallId())));
        assertEquals(expected, visited);
        assertTrue(repository.findUnsettled(session, second.get(4).getExecutionCallId(), 100).isEmpty());
        assertFalse(repository.findUnsettled(session, null, 100).stream()
                .anyMatch(record -> record.getExecutionCallId().equals(settled.getExecutionCallId())));
    }

    private static ToolExecutionRecord executing(ToolExecutionRepository repository,
            RuntimeSessionRecord session, String id) {
        ToolExecutionRecord prepared = repository.findOrCreate(prepared(session, id));
        ToolExecutionRecord claimed = repository.claimDispatch(prepared.getExecutionCallId(),
                "old-owner", Duration.ofMinutes(10));
        return repository.compareAndSet(claimed, claimed.withState(ToolExecutionRecord.State.EXECUTING, false),
                "old-owner", claimed.getDispatchGeneration());
    }

    private static ToolExecutionRecord prepared(RuntimeSessionRecord session, String id) {
        return ToolExecutionRecord.prepared(id, id + "-key", session.getBindingId(),
                session.getRuntimeGeneration(), session.getSession().getHarnessSessionId(),
                session.getRuntimeSessionId(), "turn", id, "digest",
                Map.of("sessionId", session.getRuntimeSessionId(), "promptId", "turn", "callId", id,
                        "argsDigest", "digest"));
    }
}
