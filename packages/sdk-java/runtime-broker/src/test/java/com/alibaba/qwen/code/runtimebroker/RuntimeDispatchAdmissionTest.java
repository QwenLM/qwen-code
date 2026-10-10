package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
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

    @Test
    void jdbcDispatchAdmissionCapsTheBindingSessionAndExecutionLockQueries() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:dispatch-timeout-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(source);
        var queries = new ArrayList<String>();
        var timeouts = new ArrayList<Integer>();
        var recording = (DataSource) Proxy.newProxyInstance(DataSource.class.getClassLoader(),
                new Class<?>[] {DataSource.class}, (proxy, method, arguments) -> {
                    Object result = invoke(source, method, arguments);
                    if (!(result instanceof Connection connection)) {
                        return result;
                    }
                    return Proxy.newProxyInstance(Connection.class.getClassLoader(),
                            new Class<?>[] {Connection.class}, (connectionProxy, operation, values) -> {
                                Object value = invoke(connection, operation, values);
                                if (!(value instanceof PreparedStatement statement)
                                        || !(values[0] instanceof String sql) || !sql.endsWith(" FOR UPDATE")) {
                                    return value;
                                }
                                return Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(),
                                        new Class<?>[] {PreparedStatement.class}, (statementProxy, call, parameters) -> {
                                            if (call.getName().equals("executeQuery")) {
                                                queries.add(sql);
                                                timeouts.add(statement.getQueryTimeout());
                                            }
                                            return invoke(statement, call, parameters);
                                        });
                            });
                });
        var bindings = new JdbcRuntimeBindingRepository(recording, new AesGcmSecretProtector("test", new byte[32]));
        var sessions = new JdbcRuntimeSessionRepository(recording);
        var executions = new JdbcToolExecutionRepository(recording);
        var fixture = new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, UUID.randomUUID().toString());
        var claimed = executions.claimDispatch(fixture.prepare("timeout").getExecutionCallId(), "owner", Duration.ofMinutes(1));
        queries.clear();
        timeouts.clear();
        assertEquals(ToolExecutionRecord.State.EXECUTING, bindings.authorizeDispatch(
                sessions, executions, claimed, "owner", claimed.getDispatchGeneration()).getState());
        assertEquals(3, queries.size());
        assertEquals(List.of("qwen_runtime_binding", "qwen_runtime_session", "qwen_tool_execution"),
                queries.stream().map(sql -> sql.substring(sql.indexOf(" FROM ") + 6).split(" ")[0]).toList());
        assertEquals(List.of(10, 10, 10), timeouts);
    }

    private static Object invoke(Object target, Method method, Object[] arguments) throws Throwable {
        try {
            return method.invoke(target, arguments);
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
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
