package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

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

        verifyHoldRowsByHarnessSession(repository, prefix + "-holds");
    }

    /** The restart-recovery read (#13930 R1-2): the hold rows of one Harness
     * Session across all of its Runtime Sessions, in ANY execution state —
     * plain executions and other Harness Sessions stay out, and a terminal
     * hold row still counts: the row's settle is not the Runtime Session's
     * release (the release-state filter lives in the service, tested there —
     * a settled hold whose Session was never released is still owed). */
    static void verifyHoldRowsByHarnessSession(ToolExecutionRepository repository, String prefix) {
        RuntimeScope scope = new RuntimeScope("tenant", "workspace", "generation",
                "/workspace", "capability", "session");
        String harness = prefix + "-harness";
        RuntimeSessionRecord first = new RuntimeSessionRecord(
                new RuntimeSession(harness, prefix + "-session-a", "bootstrap", scope),
                prefix + "-binding-a", 1, RuntimeSessionRecord.State.READY, 0, Instant.now());
        RuntimeSessionRecord second = new RuntimeSessionRecord(
                new RuntimeSession(harness, prefix + "-session-b", "bootstrap", scope),
                prefix + "-binding-b", 1, RuntimeSessionRecord.State.READY, 0, Instant.now());
        RuntimeSessionRecord foreign = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-foreign-harness", prefix + "-foreign-session",
                        "bootstrap", scope),
                prefix + "-binding-c", 1, RuntimeSessionRecord.State.READY, 0, Instant.now());

        ToolExecutionRecord shell = repository.findOrCreate(
                hold(first, prefix + "-shell", ManagedHoldFamily.SHELL));
        ToolExecutionRecord monitor = repository.findOrCreate(
                hold(second, prefix + "-monitor", ManagedHoldFamily.MONITOR));
        ToolExecutionRecord exited = repository.findOrCreate(
                hold(first, prefix + "-exited", ManagedHoldFamily.SHELL));
        assertNotNull(repository.settlePrepared(exited,
                Map.of("executionStatus", "success", "state", "exited"), Instant.now()));
        repository.findOrCreate(prepared(first, prefix + "-plain"));
        assertNotNull(repository.claimDispatch(
                repository.findOrCreate(prepared(first, prefix + "-claimed"))
                        .getExecutionCallId(),
                "owner", Duration.ofMinutes(10)));
        repository.findOrCreate(hold(foreign, prefix + "-foreign", ManagedHoldFamily.SHELL));
        // A Harness id that differs only in case is a different owner; on a
        // case-insensitive store the SQL's `=` would alias it in, so both
        // implementations fence the exact identity in Java (#13986 review).
        RuntimeSessionRecord caseVariant = new RuntimeSessionRecord(
                new RuntimeSession(harness.toUpperCase(java.util.Locale.ROOT),
                        prefix + "-session-case", "bootstrap", scope),
                prefix + "-binding-case", 1, RuntimeSessionRecord.State.READY, 0, Instant.now());
        repository.findOrCreate(hold(caseVariant, prefix + "-case", ManagedHoldFamily.SHELL));

        assertThrows(IllegalArgumentException.class,
                () -> repository.findHoldRowsByHarnessSession(harness, null, 0));
        assertThrows(IllegalArgumentException.class,
                () -> repository.findHoldRowsByHarnessSession(harness, null, 101));
        assertThrows(IllegalArgumentException.class,
                () -> repository.findHoldRowsByHarnessSession(null, null, 100));

        List<ToolExecutionRecord> holds =
                repository.findHoldRowsByHarnessSession(harness, null, 100);
        assertEquals(Set.of(shell.getExecutionCallId(), monitor.getExecutionCallId(),
                        exited.getExecutionCallId()),
                holds.stream().map(ToolExecutionRecord::getExecutionCallId)
                        .collect(Collectors.toSet()));
        assertEquals(Set.of(first.getRuntimeSessionId(), second.getRuntimeSessionId()),
                holds.stream().map(ToolExecutionRecord::getRuntimeSessionId)
                        .collect(Collectors.toSet()));
        assertEquals(List.of(prefix + "-foreign"),
                repository.findHoldRowsByHarnessSession(
                        foreign.getSession().getHarnessSessionId(), null, 100)
                        .stream().map(ToolExecutionRecord::getExecutionCallId)
                        .toList());
        assertTrue(repository.findHoldRowsByHarnessSession(
                prefix + "-unknown", null, 100).isEmpty());

        List<ToolExecutionRecord> pageOne =
                repository.findHoldRowsByHarnessSession(harness, null, 1);
        assertEquals(1, pageOne.size());
        List<ToolExecutionRecord> pageTwo = repository.findHoldRowsByHarnessSession(
                harness, pageOne.get(0).getExecutionCallId(), 1);
        assertEquals(1, pageTwo.size());
        List<ToolExecutionRecord> pageThree = repository.findHoldRowsByHarnessSession(
                harness, pageTwo.get(0).getExecutionCallId(), 1);
        assertEquals(1, pageThree.size());
        assertEquals(3, Set.of(pageOne.get(0).getExecutionCallId(),
                pageTwo.get(0).getExecutionCallId(),
                pageThree.get(0).getExecutionCallId()).size());
        assertTrue(repository.findHoldRowsByHarnessSession(
                harness, pageThree.get(0).getExecutionCallId(), 1).isEmpty());
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

    private static ToolExecutionRecord hold(RuntimeSessionRecord session, String id,
            ManagedHoldFamily family) {
        return ToolExecutionRecord.prepared(id, id + "-key", session.getBindingId(),
                session.getRuntimeGeneration(), session.getSession().getHarnessSessionId(),
                session.getRuntimeSessionId(), "turn", id, "digest",
                Map.of("dispatchMode", family.dispatchMode(), "sessionId",
                        session.getRuntimeSessionId(), "promptId", "turn", "callId", id,
                        "argsDigest", "digest"));
    }
}
