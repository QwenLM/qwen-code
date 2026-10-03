package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class RuntimeDispatchAdmissionTest {
    @Test
    void memoryAdmissionRejectsSealedParentsButAllowsOriginalCompletion() {
        verify(new InMemoryRuntimeBindingRepository(), new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository());
    }

    @Test
    void jdbcAdmissionUsesTheSameParentSessionAndExecutionTransaction() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:dispatch-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(source);
        verify(new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])),
                new JdbcRuntimeSessionRepository(source), new JdbcToolExecutionRepository(source));
    }

    private static void verify(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            ToolExecutionRepository executions) {
        for (boolean draining : new boolean[] {false, true}) {
            var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, UUID.randomUUID().toString());
            var prepared = fixture.prepare("call");
            var claimed = executions.claimDispatch(prepared.getExecutionCallId(), "owner", Duration.ofMinutes(1));
            assertNull(bindings.authorizeDispatch(sessions, executions, claimed, "foreign", claimed.getDispatchGeneration()));
            assertNull(bindings.authorizeDispatch(sessions, executions, claimed, "owner", claimed.getDispatchGeneration() + 1));
            var executing = bindings.authorizeDispatch(sessions, executions, claimed, "owner", claimed.getDispatchGeneration());
            assertEquals(ToolExecutionRecord.State.EXECUTING, executing.getState());
            var late = fixture.prepare("late");
            var sealed = draining
                    ? fixture.binding.withState(RuntimeBindingRecord.State.DRAINING, fixture.binding.getLease(), Instant.now())
                    : fixture.binding.withDrainRequested(true, Instant.now());
            assertNotNull(bindings.compareAndSet(fixture.binding, sealed));
            var lateClaim = executions.claimDispatch(late.getExecutionCallId(), "owner", Duration.ofMinutes(1));
            var refusal = assertThrows(RuntimeBrokerException.class, () -> bindings.authorizeDispatch(
                    sessions, executions, lateClaim, "owner", lateClaim.getDispatchGeneration()));
            assertEquals("runtime_admission_closed", refusal.getCode());
            assertEquals(lateClaim.getVersion(), executions.findByExecutionCallId(late.getExecutionCallId()).getVersion());
            assertEquals(ToolExecutionRecord.State.DISPATCHING, executions.findByExecutionCallId(late.getExecutionCallId()).getState());
            assertEquals(ToolExecutionRecord.State.SETTLED, executions.compareAndSet(executing,
                    executing.withResult(Map.of("executionStatus", "success"), 1, Instant.now()),
                    "owner", executing.getDispatchGeneration()).getState());
        }

        var cancelled = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, UUID.randomUUID().toString());
        var claim = executions.claimDispatch(cancelled.prepare("cancel").getExecutionCallId(), "owner", Duration.ofMinutes(1));
        var intent = executions.requestCancel(claim.getExecutionCallId(), claim.getVersion());
        assertNull(bindings.authorizeDispatch(sessions, executions, claim, "owner", claim.getDispatchGeneration()));
        assertThrows(IllegalArgumentException.class, () -> bindings.authorizeDispatch(
                sessions, executions, intent, "owner", intent.getDispatchGeneration()));
        assertEquals(ToolExecutionRecord.State.DISPATCHING, intent.getState());

        var released = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, UUID.randomUUID().toString());
        var old = executions.claimDispatch(released.prepare("session").getExecutionCallId(), "owner", Duration.ofMinutes(1));
        sessions.compareAndSet(released.session, released.session.withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
        assertEquals("runtime_admission_closed", assertThrows(RuntimeBrokerException.class, () -> bindings.authorizeDispatch(
                sessions, executions, old, "owner", old.getDispatchGeneration())).getCode());
    }
}
