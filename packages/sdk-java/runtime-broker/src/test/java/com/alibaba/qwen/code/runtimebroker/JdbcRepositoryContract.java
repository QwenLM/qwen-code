package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import javax.sql.DataSource;

final class JdbcRepositoryContract {
    private static final Instant START = Instant.parse(
            "2026-09-20T00:00:00Z");

    private JdbcRepositoryContract() {
    }

    static void verify(DataSource dataSource, String prefix) throws Exception {
        verifySchema(dataSource);
        verifyBinding(dataSource, prefix);
        verifySession(dataSource, prefix);
        verifyExecution(dataSource, prefix);
    }

    private static void verifySchema(DataSource dataSource)
            throws SQLException {
        try (Connection connection = dataSource.getConnection()) {
            try (PreparedStatement create = connection.prepareStatement(
                    "CREATE TABLE IF NOT EXISTS broker_witness "
                            + "(witness_id INT PRIMARY KEY)")) {
                create.execute();
            }
            try (PreparedStatement delete = connection.prepareStatement(
                    "DELETE FROM broker_witness")) {
                delete.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO broker_witness (witness_id) VALUES (1)")) {
                insert.executeUpdate();
            }
        }
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        JdbcRuntimeBrokerSchema.initialize(dataSource);
        try (Connection connection = dataSource.getConnection();
                PreparedStatement query = connection.prepareStatement(
                        "SELECT COUNT(*) FROM broker_witness");
                ResultSet result = query.executeQuery()) {
            assertTrue(result.next());
            assertEquals(1, result.getLong(1));
        }
    }

    private static void verifyBinding(DataSource dataSource, String prefix)
            throws Exception {
        RuntimeScope scope = scope(prefix + "-tenant");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                prefix + "-isolation");
        AtomicInteger firstIds = new AtomicInteger();
        AtomicInteger secondIds = new AtomicInteger();
        JdbcRuntimeBindingRepository first =
                new JdbcRuntimeBindingRepository(dataSource,
                        () -> prefix + "-binding-a-"
                                + firstIds.incrementAndGet());
        JdbcRuntimeBindingRepository second =
                new JdbcRuntimeBindingRepository(dataSource,
                        () -> prefix + "-binding-b-"
                                + secondIds.incrementAndGet());

        List<RuntimeBindingRecord> created = invokeConcurrently(32,
                index -> (index % 2 == 0 ? first : second)
                        .findOrCreate(request));
        Set<String> bindingIds = created.stream()
                .map(RuntimeBindingRecord::getBindingId)
                .collect(Collectors.toSet());
        assertEquals(1, bindingIds.size());
        assertEquals(Set.of(1L), created.stream()
                .map(RuntimeBindingRecord::getGeneration)
                .collect(Collectors.toSet()));
        String bindingId = bindingIds.iterator().next();
        assertThrows(IllegalArgumentException.class,
                () -> first.claimOperation(bindingId, prefix + "-owner-a",
                        Duration.ofNanos(1)));

        RuntimeBindingRecord ownerA = first.claimOperation(bindingId,
                prefix + "-owner-a", Duration.ofMinutes(30));
        assertNotNull(ownerA);
        assertEquals(1, ownerA.getOperationGeneration());
        RuntimeBindingRecord renewedA = first.renewOperation(bindingId,
                prefix + "-owner-a", ownerA.getOperationGeneration(),
                Duration.ofMinutes(30));
        assertEquals(ownerA.getOperationGeneration(),
                renewedA.getOperationGeneration());
        assertEquals(ownerA.getVersion() + 1, renewedA.getVersion());
        assertNull(second.claimOperation(bindingId, prefix + "-owner-b",
                Duration.ofMinutes(30)));
        expire(dataSource, "qwen_runtime_binding",
                "operation_lease_until", "binding_id", bindingId);

        RuntimeBindingRecord ownerB = second.claimOperation(bindingId,
                prefix + "-owner-b", Duration.ofMinutes(30));
        assertEquals(2, ownerB.getOperationGeneration());
        assertNull(first.renewOperation(bindingId, prefix + "-owner-a",
                ownerA.getOperationGeneration(), Duration.ofMinutes(30)));
        RuntimeBindingRecord renewedB = second.renewOperation(bindingId,
                prefix + "-owner-b", ownerB.getOperationGeneration(),
                Duration.ofMinutes(30));
        assertNull(first.compareAndSet(ownerA,
                ownerA.withDrainRequested(true, START)));

        RuntimeLease lease = new RuntimeLease(prefix + "-runtime",
                URI.create("http://127.0.0.1:4096"), prefix + "-token",
                prefix + "-lease", 1);
        RuntimeBindingRecord ready = second.compareAndSet(renewedB,
                renewedB.withState(RuntimeBindingRecord.State.READY, lease,
                        START));
        RuntimeBindingRecord healthy = second.compareAndSet(ready,
                ready.withLastHealthAt(START, START)
                        .withDrainRequested(true, START));
        RuntimeBindingRecord persistedReady = first.findById(bindingId);
        assertTrue(persistedReady.isDrainRequested());
        assertEquals(START, persistedReady.getLastHealthAt());
        assertEquals(prefix + "-token",
                persistedReady.getLease().getToken());
        RuntimeBindingRecord released = second.compareAndSet(healthy,
                healthy.withState(RuntimeBindingRecord.State.RELEASED, lease,
                        START));
        assertFalse(released.isActive());
        assertNull(first.findActive(request));

        RuntimeBindingRecord next = first.findOrCreate(request);
        assertEquals(2, next.getGeneration());
        assertTrue(next.isActive());
        JdbcRuntimeBindingRepository reconstructed =
                new JdbcRuntimeBindingRepository(dataSource);
        assertEquals(next.getBindingId(), reconstructed.findActive(request)
                .getBindingId());

        RuntimeScope otherScope = scope(prefix + "-other-tenant");
        RuntimeProvisionRequest otherRequest = new RuntimeProvisionRequest(
                otherScope, prefix + "-isolation");
        RuntimeBindingRecord other = second.findOrCreate(otherRequest);
        assertFalse(next.getBindingId().equals(other.getBindingId()));
        assertEquals(List.of(next.getBindingId()), first
                .findActiveByIsolationKey(scope, prefix + "-isolation")
                .stream().map(RuntimeBindingRecord::getBindingId).toList());
        assertEquals(List.of(other.getBindingId()), first
                .findActiveByIsolationKey(otherScope,
                        prefix + "-isolation")
                .stream().map(RuntimeBindingRecord::getBindingId).toList());

        RuntimeBindingRecord forged = released.withState(
                RuntimeBindingRecord.State.READY, lease, START);
        assertThrows(IllegalArgumentException.class,
                () -> second.compareAndSet(forged,
                        forged.withDrainRequested(true, START)));
    }

    private static void verifySession(DataSource dataSource, String prefix)
            throws Exception {
        JdbcRuntimeSessionRepository first =
                new JdbcRuntimeSessionRepository(dataSource);
        JdbcRuntimeSessionRepository second =
                new JdbcRuntimeSessionRepository(dataSource);
        RuntimeScope scope = scope(prefix + "-session-tenant");
        RuntimeSession session = new RuntimeSession(prefix + "-harness",
                prefix + "-session", "bootstrap", scope);
        RuntimeSessionRecord candidate = new RuntimeSessionRecord(session,
                prefix + "-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);

        List<RuntimeSessionRecord> created = invokeConcurrently(16,
                index -> (index % 2 == 0 ? first : second)
                        .findOrCreate(candidate));
        assertEquals(Set.of(prefix + "-session-binding"), created.stream()
                .map(RuntimeSessionRecord::getBindingId)
                .collect(Collectors.toSet()));
        assertEquals(1, first.countActiveByBinding(
                prefix + "-session-binding", 1));

        RuntimeSessionRecord conflicting = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-different-harness",
                        prefix + "-session", "bootstrap", scope),
                prefix + "-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertThrows(IllegalArgumentException.class,
                () -> first.findOrCreate(conflicting));

        RuntimeScope otherScope = scope(prefix + "-session-other-tenant");
        RuntimeSessionRecord other = new RuntimeSessionRecord(
                new RuntimeSession(prefix + "-harness",
                        prefix + "-session", "bootstrap", otherScope),
                prefix + "-other-session-binding", 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, START);
        assertEquals(other.getBindingId(), second.findOrCreate(other)
                .getBindingId());
        assertEquals(candidate.getBindingId(), second.findById(scope,
                prefix + "-session").getBindingId());
        assertEquals(other.getBindingId(), first.findById(otherScope,
                prefix + "-session").getBindingId());

        RuntimeSessionRecord released = second.compareAndSet(candidate,
                candidate.withState(RuntimeSessionRecord.State.RELEASED,
                        START));
        assertEquals(0, first.countActiveByBinding(
                prefix + "-session-binding", 1));
        RuntimeSessionRecord forged = released.withState(
                RuntimeSessionRecord.State.READY, START);
        assertThrows(IllegalArgumentException.class,
                () -> first.compareAndSet(forged,
                        forged.withState(
                                RuntimeSessionRecord.State.RELEASING,
                                START)));
    }

    private static RuntimeScope scope(String tenant) {
        return new RuntimeScope(tenant, "workspace", "generation",
                "/workspace", "capability", "session");
    }

    private static void verifyExecution(DataSource dataSource, String prefix)
            throws Exception {
        JdbcToolExecutionRepository first =
                new JdbcToolExecutionRepository(dataSource);
        JdbcToolExecutionRepository second =
                new JdbcToolExecutionRepository(dataSource);
        String idempotencyKey = prefix + "-idempotency";

        List<ToolExecutionRecord> created = invokeConcurrently(32,
                index -> (index % 2 == 0 ? first : second).findOrCreate(
                        execution(prefix + "-execution-" + index,
                                idempotencyKey, prefix + "-digest")));
        Set<String> executionIds = created.stream()
                .map(ToolExecutionRecord::getExecutionCallId)
                .collect(Collectors.toSet());
        assertEquals(1, executionIds.size());
        String executionId = executionIds.iterator().next();
        assertThrows(IllegalArgumentException.class,
                () -> first.claimDispatch(executionId,
                        prefix + "-dispatcher-a", Duration.ofNanos(1)));

        ToolExecutionRecord ownerA = first.claimDispatch(executionId,
                prefix + "-dispatcher-a", Duration.ofMinutes(30));
        assertEquals(1, ownerA.getDispatchGeneration());
        ToolExecutionRecord reclaimedA = first.claimDispatch(executionId,
                prefix + "-dispatcher-a", Duration.ofMinutes(30));
        assertEquals(ownerA.getDispatchGeneration(),
                reclaimedA.getDispatchGeneration());
        assertEquals(ownerA.getVersion(), reclaimedA.getVersion());
        assertNull(second.claimDispatch(executionId,
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        ToolExecutionRecord stillOwnedByA = second.findByExecutionCallId(
                executionId);
        assertEquals(ToolExecutionRecord.State.DISPATCHING,
                stillOwnedByA.getState());
        assertEquals(ownerA.getVersion(), stillOwnedByA.getVersion());
        ToolExecutionRecord renewedA = first.renewDispatch(executionId,
                prefix + "-dispatcher-a", ownerA.getDispatchGeneration(),
                Duration.ofMinutes(30));
        assertEquals(ownerA.getDispatchGeneration(),
                renewedA.getDispatchGeneration());
        assertEquals(ownerA.getVersion() + 1, renewedA.getVersion());
        ToolExecutionRecord executing = first.compareAndSet(renewedA,
                renewedA.withState(ToolExecutionRecord.State.EXECUTING,
                        false),
                prefix + "-dispatcher-a",
                renewedA.getDispatchGeneration());
        assertThrows(IllegalArgumentException.class,
                () -> first.compareAndSet(executing,
                        executing.withState(
                                ToolExecutionRecord.State.PREPARED, false),
                        prefix + "-dispatcher-a",
                        executing.getDispatchGeneration()));
        assertThrows(IllegalArgumentException.class,
                () -> first.compareAndSet(executing,
                        executing.withState(
                                ToolExecutionRecord.State.DISPATCHING,
                                false),
                        prefix + "-dispatcher-a",
                        executing.getDispatchGeneration()));
        ToolExecutionRecord staleVersion = executing.withVersion(
                executing.getVersion() - 1);
        assertNull(first.compareAndSet(staleVersion, staleVersion,
                prefix + "-dispatcher-a",
                executing.getDispatchGeneration()));
        assertNull(first.compareAndSet(executing,
                executing.withState(ToolExecutionRecord.State.EXECUTING,
                        false),
                prefix + "-dispatcher-b",
                executing.getDispatchGeneration()));
        ToolExecutionRecord cancelling = second.requestCancel(executionId,
                executing.getVersion());
        assertEquals(ToolExecutionRecord.State.CANCEL_REQUESTED,
                cancelling.getState());
        assertNull(second.requestCancel(executionId,
                cancelling.getVersion() - 1));
        assertNull(second.claimDispatch(executionId,
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        assertTrue(second.hasActiveByRuntimeSession(
                prefix + "-runtime-session"));
        assertFalse(second.hasActiveByRuntimeSession(
                prefix + "-other-runtime-session"));
        expire(dataSource, "qwen_tool_execution",
                "dispatch_lease_until", "execution_call_id", executionId);

        assertNull(second.claimDispatch(executionId,
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        ToolExecutionRecord unknown = second.findByExecutionCallId(
                executionId);
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        assertEquals(prefix + "-dispatcher-a", unknown.getDispatchOwner());
        assertTrue(unknown.isCancelRequested());
        assertNull(second.claimDispatch(executionId,
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        assertNull(first.renewDispatch(executionId,
                prefix + "-dispatcher-a", ownerA.getDispatchGeneration(),
                Duration.ofMinutes(30)));
        assertNull(first.compareAndSet(cancelling,
                cancelling.withResult(result("error"), 1, START),
                prefix + "-dispatcher-a",
                cancelling.getDispatchGeneration()));
        Map<String, Object> result = result("cancelled");
        ToolExecutionRecord settled = second.resolveUnknown(unknown, result,
                START);
        assertEquals(result, settled.getResult());
        assertFalse(first.hasActiveByRuntimeSession(
                prefix + "-runtime-session"));
        assertNull(first.claimDispatch(executionId,
                prefix + "-dispatcher-a", Duration.ofMinutes(1)));

        JdbcToolExecutionRepository reconstructed =
                new JdbcToolExecutionRepository(dataSource);
        ToolExecutionRecord restored = reconstructed
                .findByExecutionCallId(executionId);
        assertEquals("cancelled", restored.getExecutionStatus());
        assertEquals(result, restored.getResult());
        assertEquals(executionId, reconstructed.findByIdempotencyKey(
                idempotencyKey).getExecutionCallId());
        ToolExecutionRecord changed = execution(prefix + "-changed",
                idempotencyKey, prefix + "-changed-digest");
        ToolExecutionRecord original = reconstructed.findOrCreate(changed);
        assertEquals(executionId, original.getExecutionCallId());
        assertFalse(original.sameRequest(changed));

        String lowercaseId = prefix + "-case-execution";
        String uppercaseId = prefix + "-CASE-EXECUTION";
        ToolExecutionRecord lowercase = first.findOrCreate(execution(
                lowercaseId, prefix + "-case-lower-idempotency",
                prefix + "-case-lower-digest"));
        ToolExecutionRecord uppercase = first.findOrCreate(execution(
                uppercaseId, prefix + "-case-upper-idempotency",
                prefix + "-case-upper-digest"));
        assertEquals(lowercaseId, lowercase.getExecutionCallId());
        assertEquals(uppercaseId, uppercase.getExecutionCallId());
        assertEquals(lowercaseId, second.findByExecutionCallId(lowercaseId)
                .getExecutionCallId());
        assertEquals(uppercaseId, second.findByExecutionCallId(uppercaseId)
                .getExecutionCallId());

        String typesKey = prefix + "-types-idempotency";
        Map<String, Object> typedReference = new LinkedHashMap<>();
        typedReference.put("sessionId", prefix + "-types-runtime-session");
        typedReference.put("promptId", prefix + "-types-turn");
        typedReference.put("callId", prefix + "-types-tool");
        typedReference.put("argsDigest", prefix + "-types-digest");
        typedReference.put("attempt", 1L);
        typedReference.put("note", null);
        typedReference.put("schema", Map.of("$ref", "$"));
        Map<String, Object> jsonLdReference = new LinkedHashMap<>();
        jsonLdReference.put("@type", List.of("Product", "Thing"));
        jsonLdReference.put("name", "widget");
        typedReference.put("jsonLd", jsonLdReference);
        Map<String, Object> untypedReference = new LinkedHashMap<>();
        untypedReference.put("@type", null);
        untypedReference.put("name", "widget");
        typedReference.put("untyped", untypedReference);
        typedReference.put("scale",
                new BigDecimal("1.2345678901234567890123E+30"));
        typedReference.put("ratio", 162544.13f);
        typedReference.put("weight", -1363683.0538119469d);
        for (Number nonFinite : List.of(Double.NaN,
                Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY,
                Float.NaN, Float.POSITIVE_INFINITY,
                Float.NEGATIVE_INFINITY)) {
            Map<String, Object> invalidReference = new LinkedHashMap<>(
                    typedReference);
            invalidReference.put("attempt", nonFinite);
            assertThrows(IllegalArgumentException.class,
                    () -> ToolExecutionRecord.prepared(
                            prefix + "-invalid-types-execution", typesKey,
                            prefix + "-types-binding", 1,
                            prefix + "-types-harness",
                            prefix + "-types-runtime-session",
                            prefix + "-types-turn", prefix + "-types-tool",
                            prefix + "-types-digest", invalidReference));
        }
        ToolExecutionRecord typedCandidate = ToolExecutionRecord.prepared(
                prefix + "-types-execution", typesKey,
                prefix + "-types-binding", 1, prefix + "-types-harness",
                prefix + "-types-runtime-session", prefix + "-types-turn",
                prefix + "-types-tool", prefix + "-types-digest",
                typedReference);
        assertTrue(first.findOrCreate(typedCandidate)
                .sameRequest(typedCandidate));
        JdbcToolExecutionRepository rereader =
                new JdbcToolExecutionRepository(dataSource);
        ToolExecutionRecord reread = rereader.findByIdempotencyKey(typesKey);
        assertTrue(reread.sameRequest(typedCandidate));
        Map<String, Object> changedReference = new LinkedHashMap<>(
                typedReference);
        changedReference.put("attempt", 2L);
        assertFalse(reread.sameRequest(ToolExecutionRecord.prepared(
                prefix + "-types-execution-2", typesKey,
                prefix + "-types-binding", 1, prefix + "-types-harness",
                prefix + "-types-runtime-session", prefix + "-types-turn",
                prefix + "-types-tool", prefix + "-types-digest",
                changedReference)));
        ToolExecutionRecord typedClaim = rereader.claimDispatch(
                typedCandidate.getExecutionCallId(),
                prefix + "-dispatcher-a", Duration.ofMinutes(30));
        Map<String, Object> typedResult = new LinkedHashMap<>();
        typedResult.put("executionStatus", "success");
        typedResult.put("durationMs", 12L);
        typedResult.put("copied", Map.of("$ref", "$.executionStatus"));
        typedResult.put("external", Map.of("$ref",
                "./common.yaml#/components/schemas/Error"));
        typedResult.put("jsonLd", jsonLdReference);
        typedResult.put("untyped", untypedReference);
        typedResult.put("limit", new BigDecimal("1E+400"));
        ToolExecutionRecord typedSettled = rereader.compareAndSet(typedClaim,
                typedClaim.withResult(typedResult, 1, START),
                prefix + "-dispatcher-a",
                typedClaim.getDispatchGeneration());
        assertEquals("success", typedSettled.getExecutionStatus());
        JdbcToolExecutionRepository restoredReader =
                new JdbcToolExecutionRepository(dataSource);
        ToolExecutionRecord typedRestored = restoredReader
                .findByExecutionCallId(typedCandidate.getExecutionCallId());
        assertTrue(BrokerValues.sameJsonMap(typedResult,
                typedRestored.getResult()));
        assertTrue(typedRestored.sameRequest(typedCandidate));

        String takeoverKey = prefix + "-takeover-idempotency";
        ToolExecutionRecord takeoverCreated = first.findOrCreate(execution(
                prefix + "-takeover-execution", takeoverKey,
                prefix + "-takeover-digest"));
        ToolExecutionRecord firstClaim = first.claimDispatch(
                takeoverCreated.getExecutionCallId(),
                prefix + "-dispatcher-a", Duration.ofMinutes(30));
        expire(dataSource, "qwen_tool_execution",
                "dispatch_lease_until", "execution_call_id",
                takeoverCreated.getExecutionCallId());
        // A snapshot carrying the same (expired) lease as the stored row
        // passes sameDispatch, so only the live-lease fence rejects it.
        ToolExecutionRecord expiredSnapshot = firstClaim.withDispatch(
                prefix + "-dispatcher-a",
                Instant.parse("2000-01-01T00:00:00Z"),
                firstClaim.getDispatchGeneration(),
                ToolExecutionRecord.State.DISPATCHING);
        assertNull(first.compareAndSet(expiredSnapshot,
                expiredSnapshot.withState(
                        ToolExecutionRecord.State.EXECUTING, false),
                prefix + "-dispatcher-a",
                expiredSnapshot.getDispatchGeneration()));
        ToolExecutionRecord secondClaim = second.claimDispatch(
                takeoverCreated.getExecutionCallId(),
                prefix + "-dispatcher-b", Duration.ofMinutes(30));
        assertEquals(2, secondClaim.getDispatchGeneration());
        assertNull(first.renewDispatch(takeoverCreated.getExecutionCallId(),
                prefix + "-dispatcher-b", firstClaim.getDispatchGeneration(),
                Duration.ofMinutes(30)));
        assertNull(first.renewDispatch(takeoverCreated.getExecutionCallId(),
                prefix + "-dispatcher-a",
                secondClaim.getDispatchGeneration(),
                Duration.ofMinutes(30)));
        assertNull(first.compareAndSet(secondClaim,
                secondClaim.withResult(result("error"), 0, START),
                prefix + "-dispatcher-a",
                firstClaim.getDispatchGeneration()));
        ToolExecutionRecord takeoverSettled = second.compareAndSet(
                secondClaim,
                secondClaim.withResult(result("success"), 0, START),
                prefix + "-dispatcher-b",
                secondClaim.getDispatchGeneration());
        assertEquals("success", takeoverSettled.getExecutionStatus());

        String executingKey = prefix + "-executing-idempotency";
        ToolExecutionRecord executingCreated = first.findOrCreate(execution(
                prefix + "-executing-execution", executingKey,
                prefix + "-executing-digest"));
        ToolExecutionRecord executingClaim = first.claimDispatch(
                executingCreated.getExecutionCallId(),
                prefix + "-dispatcher-a", Duration.ofMinutes(30));
        ToolExecutionRecord rawExecuting = first.compareAndSet(
                executingClaim,
                executingClaim.withState(
                        ToolExecutionRecord.State.EXECUTING, false),
                prefix + "-dispatcher-a",
                executingClaim.getDispatchGeneration());
        ToolExecutionRecord liveExecuting = second.findByExecutionCallId(
                executingCreated.getExecutionCallId());
        ToolExecutionRecord executingReclaim = first.claimDispatch(
                executingCreated.getExecutionCallId(),
                prefix + "-dispatcher-a", Duration.ofMinutes(45));
        assertEquals(liveExecuting.getVersion(),
                executingReclaim.getVersion());
        assertEquals(liveExecuting.getDispatchLeaseUntil(),
                executingReclaim.getDispatchLeaseUntil());
        assertNull(second.claimDispatch(
                executingCreated.getExecutionCallId(),
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        ToolExecutionRecord stillExecuting = second.findByExecutionCallId(
                executingCreated.getExecutionCallId());
        assertEquals(ToolExecutionRecord.State.EXECUTING,
                stillExecuting.getState());
        assertEquals(liveExecuting.getVersion(),
                stillExecuting.getVersion());
        assertEquals(liveExecuting.getDispatchOwner(),
                stillExecuting.getDispatchOwner());
        assertEquals(liveExecuting.getDispatchLeaseUntil(),
                stillExecuting.getDispatchLeaseUntil());
        expire(dataSource, "qwen_tool_execution",
                "dispatch_lease_until", "execution_call_id",
                executingCreated.getExecutionCallId());
        assertNull(second.claimDispatch(
                executingCreated.getExecutionCallId(),
                prefix + "-dispatcher-b", Duration.ofMinutes(30)));
        ToolExecutionRecord executingUnknown = second
                .findByExecutionCallId(
                        executingCreated.getExecutionCallId());
        assertEquals(ToolExecutionRecord.State.UNKNOWN,
                executingUnknown.getState());
        assertFalse(executingUnknown.isCancelRequested());
        assertNull(first.compareAndSet(rawExecuting,
                rawExecuting.withResult(result("error"), 1, START),
                prefix + "-dispatcher-a",
                rawExecuting.getDispatchGeneration()));
        ToolExecutionRecord executingResolved = second.resolveUnknown(
                executingUnknown, result("cancelled"), START);
        assertEquals("cancelled",
                executingResolved.getExecutionStatus());

        String preparedKey = prefix + "-prepared-idempotency";
        ToolExecutionRecord prepared = first.findOrCreate(execution(
                prefix + "-prepared-execution", preparedKey,
                prefix + "-prepared-digest"));
        assertTrue(first.hasActiveByRuntimeSession(
                prefix + "-prepared-runtime-session"));
        ToolExecutionRecord preparedCancelled = second.requestCancel(
                prepared.getExecutionCallId(), prepared.getVersion());
        assertEquals(ToolExecutionRecord.State.SETTLED,
                preparedCancelled.getState());
        assertEquals("cancelled", preparedCancelled.getExecutionStatus());
        assertFalse(second.hasActiveByRuntimeSession(
                prefix + "-prepared-runtime-session"));
        assertNull(second.claimDispatch(prepared.getExecutionCallId(),
                prefix + "-dispatcher-a", Duration.ofMinutes(30)));

        String stickyKey = prefix + "-sticky-idempotency";
        ToolExecutionRecord sticky = first.findOrCreate(execution(
                prefix + "-sticky-execution", stickyKey,
                prefix + "-sticky-digest"));
        ToolExecutionRecord stickyClaim = first.claimDispatch(
                sticky.getExecutionCallId(), prefix + "-dispatcher-a",
                Duration.ofMinutes(30));
        ToolExecutionRecord stickyFlagged = first.requestCancel(
                sticky.getExecutionCallId(), stickyClaim.getVersion());
        assertTrue(stickyFlagged.isCancelRequested());
        ToolExecutionRecord stickyForged = stickyFlagged.withState(
                ToolExecutionRecord.State.DISPATCHING, false);
        assertThrows(IllegalArgumentException.class,
                () -> first.compareAndSet(stickyForged, stickyForged,
                        prefix + "-dispatcher-a",
                        stickyForged.getDispatchGeneration()));

        // Forge a session-key collision: the full-id comparison must still
        // exclude a row whose hash matches the queried session.
        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        "UPDATE qwen_tool_execution SET runtime_session_key"
                                + " = ? WHERE execution_call_id = ?")) {
            statement.setString(1, JdbcRepositorySupport.valueKey(
                    prefix + "-collision-runtime-session"));
            statement.setString(2, sticky.getExecutionCallId());
            assertEquals(1, statement.executeUpdate());
        }
        assertFalse(first.hasActiveByRuntimeSession(
                prefix + "-collision-runtime-session"));
    }

    private static ToolExecutionRecord execution(String executionCallId,
            String idempotencyKey, String digest) {
        String prefix = idempotencyKey.substring(0,
                idempotencyKey.length() - "-idempotency".length());
        return ToolExecutionRecord.prepared(executionCallId, idempotencyKey,
                prefix + "-binding", 1, prefix + "-harness",
                prefix + "-runtime-session", prefix + "-turn",
                prefix + "-tool", digest,
                Map.of("sessionId", prefix + "-runtime-session",
                        "promptId", prefix + "-turn", "callId",
                        prefix + "-tool", "argsDigest", digest));
    }

    private static Map<String, Object> result(String status) {
        return Map.of("executionStatus", status, "output",
                List.of("durable", "result"));
    }

    private static void expire(DataSource dataSource, String table,
            String leaseColumn, String idColumn, String id)
            throws SQLException {
        String sql = "UPDATE " + table + " SET " + leaseColumn
                + " = ? WHERE " + idColumn + " = ?";
        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        sql)) {
            JdbcRepositorySupport.setInstant(statement, 1,
                    Instant.parse("2000-01-01T00:00:00Z"));
            statement.setString(2, id);
            assertEquals(1, statement.executeUpdate());
        }
    }

    private static <T> List<T> invokeConcurrently(int count,
            IndexedOperation<T> operation) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(8);
        try {
            List<Callable<T>> operations = new ArrayList<>();
            for (int index = 0; index < count; index++) {
                int current = index;
                operations.add(() -> operation.run(current));
            }
            List<Future<T>> futures = executor.invokeAll(operations);
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get());
            }
            return results;
        } finally {
            executor.shutdownNow();
        }
    }

    @FunctionalInterface
    private interface IndexedOperation<T> {
        T run(int index) throws Exception;
    }
}
