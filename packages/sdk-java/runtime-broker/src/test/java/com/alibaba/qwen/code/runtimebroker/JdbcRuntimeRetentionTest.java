package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class JdbcRuntimeRetentionTest {
    private static final Instant OLD = Instant.parse("2000-01-01T00:00:00Z");
    private static final Instant FUTURE = Instant.parse("2100-01-01T00:00:00Z");
    private static final Duration MAX_AGE = Duration.ofDays(30);
    private static final JdbcRuntimeRetention.ReferenceGuard NO_REFERENCES = guard(Set.of(), Set.of());

    @Test
    void ageBoundaryUsesTheDatabaseClockAndRequiresStrictlyOlderRows() throws Exception {
        Instant databaseNow = Instant.parse("2001-06-01T00:00:00Z");
        Instant cutoff = databaseNow.minus(MAX_AGE);
        Fixture fixture = new Fixture(clockSource(Fixture.h2(), databaseNow));
        RuntimeBindingRecord boundary = fixture.binding("boundary", "legacy", false, "RELEASED");
        fixture.execute("UPDATE qwen_runtime_binding SET last_active_at = ? WHERE binding_id = ?",
                Timestamp.from(cutoff), boundary.getBindingId());
        RuntimeBindingRecord older = fixture.binding("older", "legacy", false, "RELEASED");
        fixture.execute("UPDATE qwen_runtime_binding SET last_active_at = ? WHERE binding_id = ?",
                Timestamp.from(cutoff.minusNanos(1000)), older.getBindingId());
        RuntimeBindingRecord completion = fixture.binding("completion", "legacy", false, "RELEASED");
        fixture.session(completion, "session", "RELEASED", cutoff);
        fixture.execution(completion, "session", "at-boundary", "SETTLED", cutoff);
        fixture.execution(completion, "session", "before-boundary", "ABANDONED", cutoff.minusNanos(1000));
        RuntimeBindingRecord sessionBoundary = fixture.binding("session-boundary", "legacy", false, "RELEASED");
        fixture.session(sessionBoundary, "boundary-session", "FAILED", cutoff);
        RuntimeBindingRecord sessionOlder = fixture.binding("session-older", "legacy", false, "RELEASED");
        fixture.session(sessionOlder, "older-session", "FAILED", cutoff.minusNanos(1000));

        assertEquals(List.of(1, 1, 2), fixture.complete(100, NO_REFERENCES));
        assertNotNull(fixture.bindings.findById(boundary.getBindingId()));
        assertNull(fixture.bindings.findById(older.getBindingId()));
        assertNotNull(fixture.executions.findByExecutionCallId("at-boundary"));
        assertNull(fixture.executions.findByExecutionCallId("before-boundary"));
        assertNotNull(fixture.sessions.findById(completion.getRequest().getScope(), "session"));
        assertNotNull(fixture.sessions.findById(sessionBoundary.getRequest().getScope(), "boundary-session"));
        assertNull(fixture.sessions.findById(sessionOlder.getRequest().getScope(), "older-session"));
    }

    @Test
    void rejectsNonpositiveAgeAndOutOfRangeBudgets() {
        JdbcRuntimeRetention retention = new Fixture().retention(NO_REFERENCES);
        for (Duration age : List.of(Duration.ZERO, Duration.ofSeconds(-1))) {
            assertThrows(IllegalArgumentException.class, () -> retention.sweep(age, 100, null));
        }
        for (int budget : List.of(0, -1, 1001)) {
            assertThrows(IllegalArgumentException.class, () -> retention.sweep(MAX_AGE, budget, null));
        }
    }

    @Test
    void deletesChildrenBeforeBindingAndPreservesGenerationAndPlacementEvidence() throws Exception {
        Fixture fixture = new Fixture();
        RuntimeBindingRecord binding = fixture.binding("old", "legacy", false, "RELEASED");
        fixture.session(binding, "session", "RELEASED", OLD);
        fixture.execution(binding, "session", "settled", "SETTLED", OLD);
        fixture.execution(binding, "session", "abandoned", "ABANDONED", OLD);
        fixture.execute("INSERT INTO qwen_runtime_harness_drain"
                + " (tenant_key, harness_key, tenant_id, harness_session_id) VALUES (?, ?, ?, ?)",
                JdbcRepositorySupport.valueKey("other-tenant"), JdbcRepositorySupport.valueKey("other-harness"),
                "other-tenant", "other-harness");
        fixture.execute("INSERT INTO qwen_runtime_storage_fence VALUES (?, ?, ?, ?, ?)",
                JdbcRepositorySupport.valueKey("other-tenant"), JdbcRepositorySupport.valueKey("other-storage"),
                "other-tenant", "other-storage", UUID.randomUUID().toString());

        var total = fixture.complete(1, NO_REFERENCES);

        assertEquals(List.of(2, 1, 1), total);
        assertNull(fixture.bindings.findById(binding.getBindingId()));
        assertNull(fixture.sessions.findById(binding.getRequest().getScope(), "session"));
        assertNull(fixture.executions.findByExecutionCallId("settled"));
        assertNull(fixture.executions.findByIdempotencyKey("settled-key"));
        assertNull(fixture.sessions.findHistorical("tenant-old", "harness", "session"));
        assertEquals(0, fixture.count("qwen_tool_execution"));
        assertEquals(1, fixture.count("qwen_runtime_binding_slot"));
        assertEquals(1, fixture.count("qwen_runtime_placement_guard"));
        assertEquals(1, fixture.count("qwen_runtime_harness_drain"));
        assertEquals(1, fixture.count("qwen_runtime_storage_fence"));
        RuntimeBindingRecord next = fixture.bindings.findOrCreate(binding.getRequest());
        assertEquals(binding.getGeneration() + 1, next.getGeneration());
    }

    @Test
    void expiredBrokerHistoryReturnsNotFoundWithoutProvisioningOrRedispatch() throws Exception {
        verifyMissingHistory(new Fixture());
    }

    private static void verifyMissingHistory(Fixture fixture) throws Exception {
        RuntimeBindingRecord binding = fixture.binding("expired-history", "legacy", false, "RELEASED");
        fixture.session(binding, "expired-session", "RELEASED", OLD);
        fixture.execution(binding, "expired-session", "expired-execution", "SETTLED", OLD);
        AtomicInteger provisions = new AtomicInteger();
        AtomicInteger runtimeCalls = new AtomicInteger();
        RuntimeProvisioner provisioner = request -> {
            provisions.incrementAndGet();
            throw new AssertionError("Historical lookup must never provision a Runtime");
        };
        RuntimeTransport transport = (RuntimeTransport) Proxy.newProxyInstance(RuntimeTransport.class.getClassLoader(),
                new Class<?>[] {RuntimeTransport.class}, (proxy, method, arguments) -> {
                    runtimeCalls.incrementAndGet();
                    throw new AssertionError("Historical lookup called Runtime transport: " + method.getName());
                });
        try (RuntimeBrokerService service = new RuntimeBrokerService(
                harness -> CompletableFuture.completedFuture(binding.getRequest().getScope()), provisioner, transport,
                fixture.bindings, fixture.sessions, fixture.executions, "history-reader",
                Duration.ofSeconds(30), Duration.ofSeconds(30))) {
            assertEquals("expired-execution", service.getExecution("harness", "expired-session", "expired-execution")
                    .toCompletableFuture().join().getExecutionCallId());
            assertTrue(service.release("harness", "expired-session").toCompletableFuture().join());

            assertEquals(List.of(1, 1, 1), fixture.complete(1, NO_REFERENCES));

            assertNotFound(service.getExecution("harness", "expired-session", "expired-execution"),
                    "runtime_execution_not_found");
            assertNotFound(service.reconcileExecution("harness", "expired-session", "expired-execution"),
                    "runtime_execution_not_found");
            assertNotFound(service.release("harness", "expired-session"), "runtime_session_not_found");
            assertEquals(0, provisions.get());
            assertEquals(0, runtimeCalls.get());
            assertNull(fixture.executions.findByIdempotencyKey("expired-execution-key"));
            assertNull(fixture.sessions.findById(binding.getRequest().getScope(), "expired-session"));
            assertNull(fixture.bindings.findById(binding.getBindingId()));
            assertEquals(0, fixture.count("qwen_tool_execution"));
            assertEquals(0, fixture.count("qwen_runtime_session"));
            assertEquals(0, fixture.count("qwen_runtime_binding"));
        }
    }

    private static void assertNotFound(CompletionStage<?> lookup, String code) {
        CompletionException failure = assertThrows(CompletionException.class, () -> lookup.toCompletableFuture().join());
        RuntimeBrokerException missing = assertInstanceOf(RuntimeBrokerException.class, failure.getCause());
        assertEquals(404, missing.getStatusCode());
        assertEquals(code, missing.getCode());
        assertFalse(missing.isRetryable());
    }

    @Test
    void retainsActiveStatesAndRecentBindingSessionOrCompletionTimes() throws Exception {
        Fixture fixture = new Fixture();
        for (String state : List.of("PROVISIONING", "READY", "DRAINING", "LOST",
                "RECOVERY_BLOCKED", "OPERATOR_RECOVERY")) {
            fixture.binding(state, "legacy", false, state);
        }
        RuntimeBindingRecord recent = fixture.binding("recent", "legacy", false, "RELEASED");
        fixture.execute("UPDATE qwen_runtime_binding SET last_active_at = CURRENT_TIMESTAMP WHERE binding_id = ?",
                recent.getBindingId());
        RuntimeBindingRecord future = fixture.binding("future", "legacy", false, "RELEASED");
        fixture.execute("UPDATE qwen_runtime_binding SET last_active_at = ? WHERE binding_id = ?",
                Timestamp.from(FUTURE), future.getBindingId());
        RuntimeBindingRecord child = fixture.binding("child", "static", false, "RELEASED");
        fixture.session(child, "new-session", "FAILED", FUTURE);
        fixture.execution(child, "new-session", "new-result", "SETTLED", FUTURE);
        fixture.execution(child, "new-session", "new-abandonment", "ABANDONED", FUTURE);
        RuntimeBindingRecord retainedSession = fixture.binding("recent-session", "legacy", false, "RELEASED");
        fixture.session(retainedSession, "recent-session", "RELEASED", FUTURE);

        assertEquals(List.of(0, 0, 0), fixture.complete(100, NO_REFERENCES));
        assertEquals(10, fixture.count("qwen_runtime_binding"));
        assertEquals(2, fixture.count("qwen_tool_execution"));
        assertEquals(2, fixture.count("qwen_runtime_session"));
    }

    @Test
    void failedBindingsRequireLegacyOrStaticAndAllThreeSeedColumnsAbsent() throws Exception {
        Fixture fixture = new Fixture();
        fixture.binding("legacy", "legacy", false, "FAILED");
        fixture.binding("static", "static", false, "FAILED");
        fixture.binding("durable", "local-process", false, "FAILED");
        fixture.binding("managed", "local-process", true, "FAILED");
        for (String column : List.of("provision_request_id", "provision_seed_ciphertext", "credential_key_id")) {
            RuntimeBindingRecord partial = fixture.binding(column, "legacy", false, "FAILED");
            fixture.execute("UPDATE qwen_runtime_binding SET " + column + " = ? WHERE binding_id = ?",
                    "present", partial.getBindingId());
        }

        assertEquals(List.of(0, 0, 2), fixture.complete(100, NO_REFERENCES));
        assertEquals(5, fixture.count("qwen_runtime_binding"));
    }

    @Test
    void expiredClaimsAllowRetirementButIncompleteClaimsRetainEvidence() throws Exception {
        Fixture fixture = new Fixture();
        RuntimeBindingRecord expired = fixture.binding("expired", "legacy", false, "RELEASED");
        fixture.execute("UPDATE qwen_runtime_binding SET operation_owner = ?, operation_lease_until = ?, "
                        + "operation_generation = 1 WHERE binding_id = ?", "owner", Timestamp.from(OLD), expired.getBindingId());
        fixture.session(expired, "expired-session", "RELEASED", OLD);
        fixture.execution(expired, "expired-session", "expired-result", "SETTLED", OLD);
        fixture.execute("UPDATE qwen_tool_execution SET dispatch_owner = ?, dispatch_lease_until = ?, "
                        + "dispatch_generation = 1 WHERE execution_call_id = ?", "owner", Timestamp.from(OLD), "expired-result");
        RuntimeBindingRecord incomplete = fixture.binding("incomplete-operation", "legacy", false, "RELEASED");
        fixture.execute("UPDATE qwen_runtime_binding SET operation_owner = ?, operation_generation = 1 "
                + "WHERE binding_id = ?", "owner", incomplete.getBindingId());
        RuntimeBindingRecord dispatch = fixture.binding("incomplete-dispatch", "legacy", false, "RELEASED");
        fixture.session(dispatch, "partial-session", "RELEASED", OLD);
        fixture.execution(dispatch, "partial-session", "partial-result", "SETTLED", OLD);
        fixture.execute("UPDATE qwen_tool_execution SET dispatch_owner = ?, dispatch_generation = 1 "
                + "WHERE execution_call_id = ?", "owner", "partial-result");

        assertEquals(List.of(1, 1, 1), fixture.complete(100, NO_REFERENCES));
        assertEquals(2, fixture.count("qwen_runtime_binding"));
        assertEquals(1, fixture.count("qwen_tool_execution"));
    }

    @Test
    void managedRetirementRequiresMatchingDrainOrLossAndStoppedWriterProof() throws Exception {
        Fixture fixture = new Fixture();
        fixture.binding("unproven", "local-process", true, "RELEASED");
        RuntimeBindingRecord drained = fixture.binding("drained", "local-process", true, "RELEASED");
        RuntimeResourceHandle drainHandle = fixture.handle(drained);
        fixture.execute("UPDATE qwen_runtime_binding SET drain_requested = TRUE, drain_receipt_json = ? "
                        + "WHERE binding_id = ?",
                new RuntimeDrainReceipt(drained.getBindingId(), drained.getGeneration(),
                        drained.getProvisionSeed().getProvisionRequestId(), drainHandle, OLD).toJson(),
                drained.getBindingId());
        RuntimeBindingRecord stopped = fixture.binding("stopped", "local-process", true, "RELEASED");
        RuntimeResourceHandle stoppedHandle = fixture.handle(stopped);
        RuntimeRecoveryEvidence loss = fixture.evidence(stopped, stoppedHandle,
                RuntimeRecoveryEvidence.Fact.JOURNAL_LOST);
        RuntimeRecoveryEvidence stop = fixture.evidence(stopped, stoppedHandle,
                RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED);
        fixture.execute("UPDATE qwen_runtime_binding SET loss_evidence_json = ?, stop_evidence_json = ? "
                        + "WHERE binding_id = ?", loss.toJson(), stop.toJson(), stopped.getBindingId());
        RuntimeBindingRecord onlyLoss = fixture.binding("loss-only", "local-process", true, "RELEASED");
        RuntimeResourceHandle lossHandle = fixture.handle(onlyLoss);
        fixture.execute("UPDATE qwen_runtime_binding SET loss_evidence_json = ? WHERE binding_id = ?",
                fixture.evidence(onlyLoss, lossHandle, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST).toJson(),
                onlyLoss.getBindingId());

        assertEquals(List.of(0, 0, 2), fixture.complete(100, NO_REFERENCES));
        assertNotNull(fixture.bindings.findById("unproven"));
        assertNotNull(fixture.bindings.findById("loss-only"));
    }

    @Test
    void activeClaimsAndAnyNonterminalChildProtectTheirFamily() throws Exception {
        Fixture fixture = new Fixture();
        RuntimeBindingRecord operation = fixture.binding("operation", "legacy", false, "RELEASED");
        fixture.execute("UPDATE qwen_runtime_binding SET operation_owner = ?, operation_lease_until = ?, "
                        + "operation_generation = 1 WHERE binding_id = ?",
                "owner", Timestamp.from(FUTURE), operation.getBindingId());
        RuntimeBindingRecord dispatch = fixture.binding("dispatch", "legacy", false, "RELEASED");
        fixture.session(dispatch, "leased-session", "RELEASED", OLD);
        fixture.execution(dispatch, "leased-session", "leased-result", "SETTLED", OLD);
        fixture.execute("UPDATE qwen_tool_execution SET dispatch_owner = ?, dispatch_lease_until = ?, "
                        + "dispatch_generation = 1 WHERE execution_call_id = ?",
                "owner", Timestamp.from(FUTURE), "leased-result");
        for (String state : List.of("ACQUIRING", "READY", "RELEASING")) {
            RuntimeBindingRecord binding = fixture.binding("session-" + state, "legacy", false, "RELEASED");
            fixture.session(binding, state, state, OLD);
            fixture.execution(binding, state, "terminal-" + state, "SETTLED", OLD);
        }
        for (String state : List.of("PREPARED", "DISPATCHING", "EXECUTING", "CANCEL_REQUESTED", "UNKNOWN")) {
            RuntimeBindingRecord binding = fixture.binding("execution-" + state, "legacy", false, "RELEASED");
            fixture.session(binding, state, "RELEASED", OLD);
            fixture.execution(binding, state, state, state, OLD);
            fixture.execution(binding, state, "sibling-" + state, "SETTLED", OLD);
        }

        assertEquals(List.of(0, 0, 0), fixture.complete(100, NO_REFERENCES));
        assertEquals(10, fixture.count("qwen_runtime_binding"));
        assertEquals(14, fixture.count("qwen_tool_execution"));
    }

    @Test
    void completedOperatorRecoveryAndEmbeddingBindingReferencesKeepAllChildren() throws Exception {
        Fixture fixture = new Fixture();
        RuntimeBindingRecord recovery = fixture.binding("recovery", "legacy", false, "RELEASED");
        RuntimeBindingRecord holder = fixture.binding("holder", "legacy", false, "RELEASED");
        for (RuntimeBindingRecord binding : List.of(recovery, holder)) {
            fixture.session(binding, binding.getBindingId(), "RELEASED", OLD);
            fixture.execution(binding, binding.getBindingId(), binding.getBindingId(), "SETTLED", OLD);
        }
        fixture.execute("INSERT INTO managed_workspace_operator_recovery (recovery_id, binding_id, "
                        + "runtime_generation, storage_key, holder_key, runtime_session_id, provision_request_id, "
                        + "resource_handle_json, runtime_lease_id, runtime_epoch, blocked_execution_call_id, "
                        + "operator_id, reason, prepared_at, completed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, "
                        + "1, ?, ?, ?, ?, ?)",
                UUID.randomUUID().toString(), recovery.getBindingId(), "storage", "holder", "session",
                "request", "{}", "lease", "execution", "operator", "reason", Timestamp.from(OLD), Timestamp.from(OLD));

        assertEquals(List.of(0, 0, 0), fixture.complete(100, guard(Set.of("holder"), Set.of())));
        assertEquals(2, fixture.count("qwen_runtime_binding"));
        assertEquals(2, fixture.count("qwen_tool_execution"));
    }

    @Test
    void protectedFirstHundredExecutionsAdvanceToUnprotectedSibling() throws Exception {
        verifyProtectedProgress(new Fixture());
    }

    @Test
    void protectedFirstHundredBindingsAdvanceToNextEligibleBinding() throws Exception {
        Fixture fixture = new Fixture();
        Set<String> protectedBindings = new HashSet<>();
        for (int index = 0; index < 101; index++) {
            String id = "binding-" + String.format("%03d", index);
            fixture.binding(id, "legacy", false, "RELEASED");
            if (index < 100) {
                protectedBindings.add(id);
            }
        }
        assertEquals(List.of(0, 0, 1), fixture.complete(100, guard(protectedBindings, Set.of())));
        assertNull(fixture.bindings.findById("binding-100"));
        assertEquals(100, fixture.count("qwen_runtime_binding"));
    }

    @Test
    void protectedSubsecondBindingsAdvanceAcrossSingleRowBatches() throws Exception {
        verifySubsecondBindingProgress(new Fixture());
    }

    private static void verifySubsecondBindingProgress(Fixture fixture) throws Exception {
        List<String> ids = List.of("subsecond-01", "subsecond-02", "subsecond-03");
        for (String id : ids) {
            fixture.binding(id, "legacy", false, "RELEASED");
            // SQL literals preserve migrated microseconds even when the driver truncates Timestamp parameters.
            fixture.execute("UPDATE qwen_runtime_binding SET last_active_at = '2000-01-01 00:00:00.250001' "
                    + "WHERE binding_id = ?", id);
        }
        fixture.execute("UPDATE qwen_runtime_binding SET last_active_at = '2000-01-01 00:00:00.750003' "
                + "WHERE binding_id = ?", ids.getLast());
        JdbcRuntimeRetention retention = fixture.retention(guard(Set.of(ids.getFirst()), Set.of()));
        JdbcRuntimeRetention.Cursor cursor = null;
        for (int index = 0; index < ids.size(); index++) {
            var result = retention.sweep(MAX_AGE, 1, cursor);
            assertEquals(1, result.bindingsScanned());
            assertEquals(0, result.childrenScanned());
            assertEquals(0, result.executionsDeleted());
            assertEquals(0, result.sessionsDeleted());
            assertEquals(index == 0 ? 1 : 0, result.skipped());
            assertEquals(index == 0 ? 0 : 1, result.bindingsDeleted());
            cursor = result.cursor();
            assertNotNull(cursor);
            assertEquals(ids.get(index), cursor.bindingId());
        }
        var end = retention.sweep(MAX_AGE, 1, cursor);
        assertNull(end.cursor());
        assertEquals(0, end.bindingsScanned());
        assertNotNull(fixture.bindings.findById(ids.getFirst()));
        assertNull(fixture.bindings.findById(ids.get(1)));
        assertNull(fixture.bindings.findById(ids.getLast()));
        assertEquals(List.of(0, 0, 1), fixture.complete(1, NO_REFERENCES));
    }

    private static void verifyProtectedProgress(Fixture fixture) throws Exception {
        RuntimeBindingRecord binding = fixture.binding("large", "legacy", false, "RELEASED");
        fixture.session(binding, "session", "RELEASED", OLD);
        List<String> ids = new ArrayList<>();
        for (int index = 0; index < 101; index++) {
            String id = "execution-" + index;
            ids.add(id);
            fixture.execution(binding, "session", id, "SETTLED", OLD);
        }
        ids.sort(Comparator.comparing(JdbcRepositorySupport::valueKey));
        String deletable = ids.getLast();
        Set<String> protectedIds = new HashSet<>(ids.subList(0, 100));

        assertEquals(List.of(1, 0, 0), fixture.complete(100, guard(Set.of(), protectedIds)));
        assertNull(fixture.executions.findByExecutionCallId(deletable));
        for (String protectedId : protectedIds) {
            assertNotNull(fixture.executions.findByExecutionCallId(protectedId));
        }
        assertNotNull(fixture.sessions.findById(binding.getRequest().getScope(), "session"));
        assertNotNull(fixture.bindings.findById(binding.getBindingId()));
    }

    @Test
    void failuresRollBackAlreadyDeletedSiblingsAndReferenceChecksShareTheTransaction() throws Exception {
        verifyRollback(new Fixture(), false);
    }

    @Test
    void fatalReferenceErrorsAlsoRollBackTheCurrentBindingTransaction() throws Exception {
        verifyRollback(new Fixture(), true);
    }

    private static void verifyRollback(Fixture fixture, boolean fatal) throws Exception {
        RuntimeBindingRecord binding = fixture.binding("rollback", "legacy", false, "RELEASED");
        fixture.session(binding, "session", "RELEASED", OLD);
        fixture.execution(binding, "session", "first", "SETTLED", OLD);
        fixture.execution(binding, "session", "second", "SETTLED", OLD);
        AtomicInteger calls = new AtomicInteger();
        JdbcRuntimeRetention.ReferenceGuard failing = new JdbcRuntimeRetention.ReferenceGuard() {
            private Connection bindingConnection;

            @Override
            public boolean bindingReferenced(Connection connection, RuntimeBindingRecord record) throws SQLException {
                assertFalse(connection.getAutoCommit());
                bindingConnection = connection;
                return false;
            }

            @Override
            public boolean executionReferenced(Connection connection, String executionCallId) throws SQLException {
                assertEquals(bindingConnection, connection);
                if (calls.incrementAndGet() == 2) {
                    if (fatal) {
                        throw new AssertionError("Injected fatal reference lookup failure");
                    }
                    throw new SQLException("Injected reference lookup failure");
                }
                return false;
            }
        };

        Class<? extends Throwable> expectedFailure = fatal ? AssertionError.class : IllegalStateException.class;
        assertThrows(expectedFailure,
                () -> fixture.retention(failing).sweep(MAX_AGE, 100, null));
        assertEquals(2, fixture.count("qwen_tool_execution"));
        assertEquals(1, fixture.count("qwen_runtime_session"));
        assertEquals(1, fixture.count("qwen_runtime_binding"));
        assertEquals(List.of(2, 1, 1), fixture.complete(100, NO_REFERENCES));
    }

    @Test
    void concurrentSweepersDeleteEachRecordOnce() throws Exception {
        verifyConcurrentSweepers(new Fixture());
    }

    private static void verifyConcurrentSweepers(Fixture fixture) throws Exception {
        RuntimeBindingRecord binding = fixture.binding("concurrent", "legacy", false, "RELEASED");
        fixture.session(binding, "session", "RELEASED", OLD);
        fixture.execution(binding, "session", "execution", "SETTLED", OLD);
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> {
                assertTrue(start.await(10, TimeUnit.SECONDS));
                return fixture.complete(1, NO_REFERENCES);
            });
            var second = executor.submit(() -> {
                assertTrue(start.await(10, TimeUnit.SECONDS));
                return fixture.complete(1, NO_REFERENCES);
            });
            start.countDown();
            List<Integer> left = first.get(20, TimeUnit.SECONDS);
            List<Integer> right = second.get(20, TimeUnit.SECONDS);
            assertEquals(List.of(1, 1, 1), List.of(left.get(0) + right.get(0),
                    left.get(1) + right.get(1), left.get(2) + right.get(2)));
        }
        assertEquals(0, fixture.count("qwen_runtime_binding"));
    }

    static void verifyOnDatabase(DataSource source) throws Exception {
        Fixture fixture = new Fixture(source);
        verifySubsecondBindingProgress(fixture);
        verifyProtectedProgress(fixture);
        assertEquals(List.of(100, 1, 1), fixture.complete(1, NO_REFERENCES));
        verifyRollback(fixture, false);
        verifyRollback(fixture, true);
        verifyConcurrentSweepers(fixture);
        verifyMissingHistory(fixture);
        RuntimeBindingRecord previous = fixture.binding("generation", "legacy", false, "RELEASED");
        fixture.complete(1, NO_REFERENCES);
        assertNull(fixture.bindings.findById(previous.getBindingId()));
        assertEquals(previous.getGeneration() + 1, fixture.bindings.findOrCreate(previous.getRequest()).getGeneration());
    }

    private static JdbcRuntimeRetention.ReferenceGuard guard(Set<String> bindings, Set<String> executions) {
        return new JdbcRuntimeRetention.ReferenceGuard() {
            @Override
            public boolean bindingReferenced(Connection connection, RuntimeBindingRecord binding) {
                return bindings.contains(binding.getBindingId());
            }

            @Override
            public boolean executionReferenced(Connection connection, String executionCallId) {
                return executions.contains(executionCallId);
            }
        };
    }

    private static DataSource clockSource(DataSource source, Instant clock) {
        return (DataSource) Proxy.newProxyInstance(DataSource.class.getClassLoader(), new Class<?>[] {DataSource.class},
                (proxy, method, arguments) -> {
                    Object result;
                    try {
                        result = method.invoke(source, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                    if (!(result instanceof Connection connection)) {
                        return result;
                    }
                    return Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
                            (connectionProxy, connectionMethod, connectionArguments) -> {
                                if ("prepareStatement".equals(connectionMethod.getName())
                                        && ((String) connectionArguments[0]).startsWith("SELECT UNIX_TIMESTAMP(),")) {
                                    connectionArguments[0] = "SELECT " + clock.getEpochSecond() + ", " + clock.getNano() / 1000;
                                }
                                try {
                                    return connectionMethod.invoke(connection, connectionArguments);
                                } catch (InvocationTargetException failure) {
                                    throw failure.getCause();
                                }
                            });
                });
    }

    private static final class Fixture {
        private final DataSource source;
        private final JdbcRuntimeBindingRepository bindings;
        private final JdbcRuntimeSessionRepository sessions;
        private final JdbcToolExecutionRepository executions;
        private String nextId;

        Fixture() {
            this(h2());
        }

        Fixture(DataSource dataSource) {
            source = dataSource;
            JdbcRuntimeBrokerSchema.initialize(source);
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]),
                    () -> nextId);
            sessions = new JdbcRuntimeSessionRepository(source);
            executions = new JdbcToolExecutionRepository(source);
        }

        private static DataSource h2() {
            JdbcDataSource dataSource = new JdbcDataSource();
            dataSource.setURL("jdbc:h2:mem:retention-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
            return dataSource;
        }

        RuntimeBindingRecord binding(String id, String kind, boolean managed, String state) throws SQLException {
            RuntimeScope scope = new RuntimeScope("tenant-" + id, "workspace", "1", "/workspace",
                    "sha256:" + "a".repeat(64), "session");
            RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope, "harness", kind,
                    managed ? "storage-" + id : null);
            nextId = id;
            RuntimeBindingRecord created = bindings.findOrCreate(request);
            nextId = id + "-next";
            execute("UPDATE qwen_runtime_binding SET binding_state = ?, last_active_at = ? "
                            + "WHERE binding_id = ?", state, Timestamp.from(OLD), created.getBindingId());
            execute("UPDATE qwen_runtime_binding_slot SET active_binding_id = NULL WHERE request_key = ?",
                    JdbcRepositorySupport.requestKey(request));
            return bindings.findById(id);
        }

        void session(RuntimeBindingRecord binding, String id, String state, Instant activeAt) {
            RuntimeSessionRecord created = sessions.findOrCreate(new RuntimeSessionRecord(
                    new RuntimeSession("harness", id, "bootstrap", binding.getRequest().getScope()),
                    binding.getBindingId(), binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, activeAt));
            sessions.compareAndSet(created, created.withState(RuntimeSessionRecord.State.valueOf(state), activeAt));
        }

        void execution(RuntimeBindingRecord binding, String session, String id, String state, Instant completedAt)
                throws SQLException {
            executions.findOrCreate(ToolExecutionRecord.prepared(id, id + "-key", binding.getBindingId(),
                    binding.getGeneration(), "harness", session, "turn", "call", "digest",
                    Map.of("sessionId", session, "promptId", "turn", "callId", "call", "argsDigest", "digest")));
            execute("UPDATE qwen_tool_execution SET execution_state = ?, cancel_requested = ?, execution_status = ?, "
                            + "result_json = ?, settled_at = ?, abandoned_at = ?, loss_evidence_id = ? "
                            + "WHERE execution_call_id = ?", state, "CANCEL_REQUESTED".equals(state),
                    "SETTLED".equals(state) ? "success" : null,
                    "SETTLED".equals(state) ? "{\"executionStatus\":\"success\"}" : null,
                    "SETTLED".equals(state) ? Timestamp.from(completedAt) : null,
                    "ABANDONED".equals(state) ? Timestamp.from(completedAt) : null,
                    "ABANDONED".equals(state) ? "loss" : null, id);
        }

        RuntimeResourceHandle handle(RuntimeBindingRecord binding) throws SQLException {
            RuntimeResourceHandle handle = new RuntimeResourceHandle(binding.getRequest().getProvisionerKind(),
                    1, Map.of("worker", binding.getBindingId()));
            execute("UPDATE qwen_runtime_binding SET resource_handle_version = ?, resource_handle_json = ? "
                    + "WHERE binding_id = ?", handle.getVersion(), handle.toJson(), binding.getBindingId());
            return handle;
        }

        RuntimeRecoveryEvidence evidence(RuntimeBindingRecord binding, RuntimeResourceHandle handle,
                RuntimeRecoveryEvidence.Fact fact) {
            RuntimeProvisionSeed seed = binding.getProvisionSeed();
            return new RuntimeRecoveryEvidence(fact.name(), fact, "test", OLD, "original-host",
                    seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(),
                    seed.getLeaseId(), seed.getEpoch(), handle);
        }

        JdbcRuntimeRetention retention(JdbcRuntimeRetention.ReferenceGuard references) {
            return new JdbcRuntimeRetention(source, bindings, references);
        }

        List<Integer> complete(int batchSize, JdbcRuntimeRetention.ReferenceGuard references) {
            JdbcRuntimeRetention retention = retention(references);
            JdbcRuntimeRetention.Cursor cursor = null;
            int executionsDeleted = 0;
            int sessionsDeleted = 0;
            int bindingsDeleted = 0;
            for (int tick = 0; tick < 1000; tick++) {
                var result = retention.sweep(MAX_AGE, batchSize, cursor);
                assertTrue(result.bindingsScanned() <= batchSize);
                assertTrue(result.childrenScanned() <= batchSize);
                int deleted = result.executionsDeleted() + result.sessionsDeleted() + result.bindingsDeleted();
                assertTrue(deleted <= batchSize, "Deletion budget exceeded");
                executionsDeleted += result.executionsDeleted();
                sessionsDeleted += result.sessionsDeleted();
                bindingsDeleted += result.bindingsDeleted();
                cursor = result.cursor();
                if (cursor == null) {
                    return List.of(executionsDeleted, sessionsDeleted, bindingsDeleted);
                }
            }
            throw new AssertionError("Sweep never completed a bounded traversal");
        }

        void execute(String sql, Object... values) throws SQLException {
            try (Connection connection = source.getConnection();
                    PreparedStatement statement = connection.prepareStatement(sql)) {
                for (int index = 0; index < values.length; index++) {
                    if (values[index] instanceof Timestamp timestamp) {
                        JdbcRepositorySupport.setInstant(statement, index + 1, timestamp.toInstant());
                    } else {
                        statement.setObject(index + 1, values[index]);
                    }
                }
                statement.executeUpdate();
            }
        }

        int count(String table) throws SQLException {
            try (Connection connection = source.getConnection();
                    PreparedStatement statement = connection.prepareStatement("SELECT COUNT(*) FROM " + table);
                    var rows = statement.executeQuery()) {
                assertTrue(rows.next());
                return rows.getInt(1);
            }
        }
    }
}
