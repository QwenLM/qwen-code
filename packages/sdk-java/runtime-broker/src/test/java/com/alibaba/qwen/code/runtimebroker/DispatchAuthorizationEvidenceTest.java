package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class DispatchAuthorizationEvidenceTest {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void onlyAtomicAdmissionMintsEvidenceAndOriginalResultPreservesIt(boolean jdbc) {
        var f = fixture(jdbc, "kubernetes-workspace");
        var prepared = f.prepare("original");
        assertNull(prepared.getAuthorizedDispatchGeneration());
        assertFalse(prepared.wasDispatchAuthorizedBefore(Long.MAX_VALUE));
        var claim = f.claim(prepared);
        assertNull(claim.getAuthorizedDispatchGeneration());
        assertNull(f.bindings.authorizeDispatch(f.sessions, f.executions, claim, "foreign", claim.getDispatchGeneration()));
        assertNull(f.bindings.authorizeDispatch(f.sessions, f.executions, claim, "owner", claim.getDispatchGeneration() + 1));
        assertNull(f.executions.findByExecutionCallId(claim.getExecutionCallId()).getAuthorizedBindingVersion());
        var authorized = f.authorize(claim);
        assertEvidence(authorized, claim.getDispatchGeneration(), f.binding.getVersion());
        assertFalse(authorized.wasDispatchAuthorizedBefore(f.binding.getVersion()));
        var sealed = f.bindings.compareAndSet(f.binding, f.binding.withState(RuntimeBindingRecord.State.DRAINING,
                f.binding.getLease(), Instant.now()).withDrainRequested(true, Instant.now()));
        assertTrue(authorized.wasDispatchAuthorizedBefore(sealed.getVersion()));
        var settled = f.executions.compareAndSet(authorized,
                authorized.withResult(Map.of("executionStatus", "success"), 1, Instant.now()), "owner", claim.getDispatchGeneration());
        assertEvidence(settled, claim.getDispatchGeneration(), f.binding.getVersion());
        ToolExecutionRepository reader = jdbc ? new JdbcToolExecutionRepository(f.source) : f.executions;
        assertEvidence(reader.findByExecutionCallId(claim.getExecutionCallId()), claim.getDispatchGeneration(), f.binding.getVersion());
        assertEvidence(reader.findByBinding(f.binding.getBindingId(), f.binding.getGeneration(), null, 100).getFirst(),
                claim.getDispatchGeneration(), f.binding.getVersion());
        assertEvidence(f.bindings.admitExecution(f.sessions, f.executions, prepared), claim.getDispatchGeneration(), f.binding.getVersion());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void renewalCancellationUnknownReconciliationAndAbandonmentRetainEvidence(boolean jdbc) {
        var f = fixture(jdbc, "test-supervisor");
        var authorized = f.authorize(f.claim(f.prepare("original")));
        var renewed = f.executions.renewDispatch(authorized.getExecutionCallId(), "owner",
                authorized.getDispatchGeneration(), Duration.ofMinutes(5));
        assertEvidence(renewed, authorized.getDispatchGeneration(), f.binding.getVersion());
        var cancelled = f.executions.requestCancel(renewed.getExecutionCallId(), renewed.getVersion());
        assertEvidence(cancelled, authorized.getDispatchGeneration(), f.binding.getVersion());
        var unknown = f.executions.compareAndSet(cancelled, cancelled.withUnknown(), "owner", cancelled.getDispatchGeneration());
        assertEvidence(unknown, authorized.getDispatchGeneration(), f.binding.getVersion());
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        var resolved = f.executions.resolveUnknown(unknown, Map.of("executionStatus", "cancelled"), Instant.now());
        assertEvidence(resolved, authorized.getDispatchGeneration(), f.binding.getVersion());
        var abandoned = f.authorize(f.claim(f.prepare("abandoned")));
        var lost = f.bindings.compareAndSet(f.binding, f.binding.withRecoveryEvidence(
                RuntimeRecoveryContract.evidence(f.binding, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST), null, Instant.now()));
        f.bindings.recoverLost(f.sessions, f.executions, lost);
        var stored = f.executions.findByExecutionCallId(abandoned.getExecutionCallId());
        assertEquals(ToolExecutionRecord.State.ABANDONED, stored.getState());
        assertEvidence(stored, abandoned.getDispatchGeneration(), f.binding.getVersion());
        assertEquals(resolved.getResult(), f.executions.findByExecutionCallId(resolved.getExecutionCallId()).getResult());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void genericCasCannotIntroduceEraseOrChangeEvidenceIncludingForgedExpected(boolean jdbc) {
        var f = fixture(jdbc, "kubernetes-workspace");
        var claim = f.claim(f.prepare("original"));
        assertThrows(IllegalArgumentException.class, () -> f.executions.compareAndSet(claim,
                claim.authorizeDispatch(f.binding.getVersion()), "owner", claim.getDispatchGeneration()));
        var marked = f.authorize(claim);
        var unmarked = copy(marked, marked.getState(), null, null);
        assertThrows(IllegalArgumentException.class, () -> f.executions.compareAndSet(marked, unmarked,
                "owner", marked.getDispatchGeneration()));
        assertNull(f.executions.compareAndSet(unmarked, unmarked.withUnknown(), "owner", marked.getDispatchGeneration()));
        var changed = copy(marked, marked.getState(), marked.getAuthorizedDispatchGeneration(), f.binding.getVersion() + 1);
        assertThrows(IllegalArgumentException.class, () -> f.executions.compareAndSet(marked, changed,
                "owner", marked.getDispatchGeneration()));
        assertNull(f.executions.compareAndSet(changed, changed.withUnknown(), "owner", marked.getDispatchGeneration()));
        assertEvidence(f.executions.findByExecutionCallId(marked.getExecutionCallId()), marked.getDispatchGeneration(), f.binding.getVersion());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void forgedClaimCannotRetroactivelyAuthorizeAnUnmarkedExecutingOrCancelledRow(boolean jdbc) {
        var f = fixture(jdbc, "kubernetes-workspace");
        var claim = f.claim(f.prepare("legacy"));
        var legacy = f.executions.compareAndSet(claim, claim.withState(ToolExecutionRecord.State.EXECUTING, false),
                "owner", claim.getDispatchGeneration());
        var forged = legacy.withState(ToolExecutionRecord.State.DISPATCHING, false);
        assertNull(f.authorize(forged));
        assertNull(f.executions.findByExecutionCallId(legacy.getExecutionCallId()).getAuthorizedDispatchGeneration());
        var cancelled = f.executions.requestCancel(legacy.getExecutionCallId(), legacy.getVersion());
        assertNull(f.authorize(cancelled.withState(ToolExecutionRecord.State.DISPATCHING, false)));
        assertEquals(cancelled.getVersion(), f.executions.findByExecutionCallId(legacy.getExecutionCallId()).getVersion());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void sealWinnerCannotAuthorizeLateClaimAndUnmarkedOutcomesStayUnmarked(boolean jdbc) {
        var f = fixture(jdbc, "kubernetes-workspace");
        var claim = f.claim(f.prepare("late"));
        assertNotNull(f.bindings.compareAndSet(f.binding, f.binding.withState(RuntimeBindingRecord.State.DRAINING,
                f.binding.getLease(), Instant.now()).withDrainRequested(true, Instant.now())));
        assertEquals("runtime_admission_closed", assertThrows(RuntimeBrokerException.class, () -> f.authorize(claim)).getCode());
        var unknown = f.executions.compareAndSet(claim, claim.withUnknown(), "owner", claim.getDispatchGeneration());
        var resolved = f.executions.resolveUnknown(unknown, Map.of("executionStatus", "error"), Instant.now());
        assertNull(resolved.getAuthorizedDispatchGeneration());
        assertFalse(resolved.wasDispatchAuthorizedBefore(Long.MAX_VALUE));
        var other = fixture(jdbc, "test-supervisor");
        var prepared = other.prepare("not-started");
        var cancelled = other.executions.requestCancel(prepared.getExecutionCallId(), prepared.getVersion());
        assertTrue(cancelled.isSettled());
        assertNull(cancelled.getAuthorizedBindingVersion());
    }

    @Test
    void customMemoryRepositoriesPreserveLocalHooksButCannotMintCsiEvidence() {
        for (String kind : new String[] {"test-supervisor", "kubernetes-workspace"}) {
            for (boolean wrapSessions : new boolean[] {false, true}) {
                var f = fixture(false, kind);
                var claim = f.claim(f.prepare("custom"));
                var calls = new AtomicInteger();
                var sessions = wrapSessions ? proxy(RuntimeSessionRepository.class, f.sessions, calls) : f.sessions;
                var executions = wrapSessions ? f.executions : proxy(ToolExecutionRepository.class, f.executions, calls);
                if ("kubernetes-workspace".equals(kind)) {
                    assertEquals("runtime_dispatch_admission_unavailable", assertThrows(RuntimeBrokerException.class,
                            () -> f.bindings.authorizeDispatch(sessions, executions, claim, "owner", claim.getDispatchGeneration())).getCode());
                    assertEquals(ToolExecutionRecord.State.DISPATCHING, f.executions.findByExecutionCallId(claim.getExecutionCallId()).getState());
                    assertEquals(0, calls.get());
                } else {
                    var result = f.bindings.authorizeDispatch(sessions, executions, claim, "owner", claim.getDispatchGeneration());
                    assertEquals(ToolExecutionRecord.State.EXECUTING, result.getState());
                    assertNull(result.getAuthorizedBindingVersion());
                    assertEquals(wrapSessions ? 0 : 1, calls.get());
                }
            }
        }
    }

    @Test
    void additivePrivateSchemaUpgradeDoesNotBackfillLegacyRows() throws Exception {
        var f = fixture(true, "test-supervisor");
        var prepared = f.prepare("legacy");
        try (var connection = f.source.getConnection(); var statement = connection.createStatement()) {
            statement.execute("ALTER TABLE qwen_tool_execution DROP COLUMN authorized_dispatch_generation");
            statement.execute("ALTER TABLE qwen_tool_execution DROP COLUMN authorized_binding_version");
        }
        JdbcRuntimeBrokerSchema.initialize(f.source);
        JdbcRuntimeBrokerSchema.initialize(f.source);
        var reloaded = f.executions.findByExecutionCallId(prepared.getExecutionCallId());
        assertTrue(prepared.sameRequest(reloaded));
        assertNull(reloaded.getAuthorizedDispatchGeneration());
        assertNull(reloaded.getAuthorizedBindingVersion());
        assertEvidence(f.authorize(f.claim(reloaded)), 1, f.binding.getVersion());
    }

    @Test
    void persistedMalformedEvidenceFailsDecode() throws Exception {
        for (String mutation : new String[] {"authorized_binding_version = NULL", "authorized_dispatch_generation = 0",
                "authorized_dispatch_generation = 2", "authorized_binding_version = -1", "execution_state = 'DISPATCHING'"}) {
            var f = fixture(true, "test-supervisor");
            var marked = f.authorize(f.claim(f.prepare("corrupt")));
            try (var connection = f.source.getConnection(); var statement = connection.createStatement()) {
                assertEquals(1, statement.executeUpdate("UPDATE qwen_tool_execution SET " + mutation));
            }
            assertThrows(IllegalArgumentException.class, () -> f.executions.findByExecutionCallId(marked.getExecutionCallId()));
        }
    }

    private static ToolExecutionRecord copy(ToolExecutionRecord r, ToolExecutionRecord.State state, Long generation, Long version) {
        return new ToolExecutionRecord(r.getExecutionCallId(), r.getIdempotencyKey(), r.getBindingId(), r.getRuntimeGeneration(),
                r.getHarnessSessionId(), r.getRuntimeSessionId(), r.getTurnId(), r.getToolCallId(), r.getRequestDigest(), r.getReference(),
                state, r.getExecutionStatus(), r.getResult(), r.getLastSequence(), r.isCancelRequested(), r.getDispatchOwner(),
                r.getDispatchLeaseUntil(), r.getDispatchGeneration(), r.getVersion(), r.getSettledAt(), r.getAbandonedAt(),
                r.getLossEvidenceId(), generation, version);
    }

    private static void assertEvidence(ToolExecutionRecord r, long dispatchGeneration, long bindingVersion) {
        assertNotNull(r);
        assertEquals(Long.valueOf(dispatchGeneration), r.getAuthorizedDispatchGeneration());
        assertEquals(Long.valueOf(bindingVersion), r.getAuthorizedBindingVersion());
    }

    private static <T> T proxy(Class<T> type, T delegate, AtomicInteger calls) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> {
            if ("compareAndSet".equals(method.getName())) {
                calls.incrementAndGet();
            }
            try {
                return method.invoke(delegate, args);
            } catch (InvocationTargetException failure) {
                throw failure.getCause();
            }
        }));
    }

    private static Fixture fixture(boolean jdbc, String kind) {
        JdbcDataSource source = null;
        RuntimeBindingRepository bindings;
        RuntimeSessionRepository sessions;
        ToolExecutionRepository executions;
        if (jdbc) {
            source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:authorization-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            JdbcRuntimeBrokerSchema.initialize(source);
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
            sessions = new JdbcRuntimeSessionRepository(source);
            executions = new JdbcToolExecutionRepository(source);
        } else {
            bindings = new InMemoryRuntimeBindingRepository();
            sessions = new InMemoryRuntimeSessionRepository();
            executions = new InMemoryToolExecutionRepository();
        }
        String id = UUID.randomUUID().toString();
        var scope = new RuntimeScope(id, "workspace", "7", "/workspace", "sha256:" + "a".repeat(64), "workspace");
        var created = bindings.findOrCreate(new RuntimeProvisionRequest(scope, null, kind, "storage"));
        var claimed = bindings.claimOperation(created.getBindingId(), "coordinator", Duration.ofMinutes(5));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var binding = bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                new RuntimeResourceHandle(kind, 3, Map.of("pod", "original")), Instant.now(), Instant.now()));
        var acquiring = bindings.admitSession(sessions, new RuntimeSessionRecord(new RuntimeSession(id, "session", "bootstrap", scope),
                binding.getBindingId(), binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        var session = sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        return new Fixture(source, bindings, sessions, executions, binding, session);
    }

    private record Fixture(JdbcDataSource source, RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, RuntimeBindingRecord binding, RuntimeSessionRecord session) {
        ToolExecutionRecord prepare(String call) {
            return bindings.admitExecution(sessions, executions, ToolExecutionRecord.prepared(UUID.randomUUID().toString(),
                    UUID.randomUUID().toString(), binding.getBindingId(), binding.getGeneration(), session.getSession().getHarnessSessionId(),
                    session.getRuntimeSessionId(), "turn", call, "digest", Map.of("sessionId", session.getRuntimeSessionId(),
                            "promptId", "turn", "callId", call, "argsDigest", "digest")));
        }

        ToolExecutionRecord claim(ToolExecutionRecord prepared) {
            return executions.claimDispatch(prepared.getExecutionCallId(), "owner", Duration.ofMinutes(5));
        }

        ToolExecutionRecord authorize(ToolExecutionRecord claim) {
            return bindings.authorizeDispatch(sessions, executions, claim, "owner", claim.getDispatchGeneration());
        }
    }
}
