package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.sql.Connection;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tool execution admission and dispatch on an ordinary session-class binding
 * decide the CSI pin under the Session root alone and take no tenant guard
 * there (designs 2026-11-05-managed-dispatch-tenant-guards and
 * 2026-11-05-managed-admission-placement).
 */
class ExecutionControlTenantGuardsTest {
    protected DataSource source;
    protected JdbcRuntimeBindingRepository bindings;
    protected JdbcRuntimeSessionRepository sessions;
    protected JdbcToolExecutionRepository executions;

    protected DataSource dataSource() {
        var h2 = new JdbcDataSource();
        h2.setURL("jdbc:h2:mem:execution-control-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(h2);
        return h2;
    }

    @BeforeEach
    void setUp() {
        source = dataSource();
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        sessions = new JdbcRuntimeSessionRepository(source);
        executions = new JdbcToolExecutionRepository(source);
    }

    @Test
    void sessionIsolatedDispatchCompletesWhileBothTenantGuardsAreHeld() throws Exception {
        var fixture = sessionFixture(true);
        var claimed = executions.claimDispatch(fixture.prepare("call").getExecutionCallId(), "owner",
                Duration.ofMinutes(1));
        var authorized = whileGuardsHeld(fixture.id, true, () -> bindings.authorizeDispatch(
                sessions, executions, claimed, "owner", claimed.getDispatchGeneration()));
        assertEquals(ToolExecutionRecord.State.EXECUTING, authorized.getState());
    }

    @Test
    void sessionIsolatedAdmissionCompletesWhileBothTenantGuardsAreHeld() throws Exception {
        var fixture = sessionFixture(true);
        var admitted = whileGuardsHeld(fixture.id, true, () -> fixture.prepare("call"));
        assertEquals(ToolExecutionRecord.State.PREPARED, admitted.getState());
    }

    @Test
    void withoutASessionRootAdmissionKeepsPlacement() throws Exception {
        var fixture = sessionFixture(false);
        var waited = org.junit.jupiter.api.Assertions.assertThrows(Exception.class,
                () -> whileGuardsHeld(fixture.id, true, () -> fixture.prepare("call")));
        assertTrue(waited instanceof java.util.concurrent.TimeoutException, waited.toString());
    }

    @Test
    void drainWaitsForTheSessionRootAnAdmissionHolds() throws Exception {
        // A placement-free admission holds the Session root through commit, so
        // the drain fence cannot close between its read and its insert.
        var fixture = sessionFixture(true);
        String harness = fixture.id + "-harness";
        var waited = org.junit.jupiter.api.Assertions.assertThrows(Exception.class,
                () -> whileRootHeld(fixture.id, harness, () -> {
                    bindings.requestHarnessDrain(fixture.id, harness);
                    return null;
                }));
        assertTrue(waited instanceof java.util.concurrent.TimeoutException, waited.toString());
    }

    @Test
    void admissionAfterACommittedDrainIsRefusedWithoutPlacement() throws Exception {
        var fixture = sessionFixture(true);
        bindings.requestHarnessDrain(fixture.id, fixture.id + "-harness");
        var refused = org.junit.jupiter.api.Assertions.assertThrows(java.util.concurrent.ExecutionException.class,
                () -> whileGuardsHeld(fixture.id, true, () -> fixture.prepare("call")));
        assertTrue(refused.getCause() instanceof RuntimeBrokerException closed
                && "runtime_admission_closed".equals(closed.getCode()), refused.getCause().toString());
    }

    @Test
    void withoutASessionRootDispatchKeepsTheGuardedPath() throws Exception {
        // A missing root cannot order dispatch against binding control, so the
        // guarded path stays: dispatch waits for a held placement guard.
        var fixture = sessionFixture(false);
        var claimed = executions.claimDispatch(fixture.prepare("call").getExecutionCallId(), "owner",
                Duration.ofMinutes(1));
        var waited = org.junit.jupiter.api.Assertions.assertThrows(Exception.class, () -> whileGuardsHeld(
                fixture.id, true, () -> bindings.authorizeDispatch(sessions, executions, claimed, "owner",
                        claimed.getDispatchGeneration())));
        assertTrue(waited instanceof java.util.concurrent.TimeoutException, waited.toString());
        // Released, the waiting dispatch finishes on the guarded path.
        assertEquals(ToolExecutionRecord.State.EXECUTING,
                executions.findByExecutionCallId(claimed.getExecutionCallId()).getState());
    }

    /** A session-class fixture; {@code root} adds the managed Session root of its harness Session. */
    protected RuntimeRecoveryContract.Fixture sessionFixture(boolean root) throws Exception {
        String tenant = "tenant-" + UUID.randomUUID();
        if (root) {
            String session = tenant + "-harness";
            try (Connection connection = source.getConnection(); var insert = connection.prepareStatement(
                    "INSERT INTO ma_session (tenant_id, session_id, session_kind, tenant_key, session_key,"
                            + " session_scope_key, gmt_create, gmt_modified) VALUES (?, ?, 'CONTROL', ?, ?, ?, ?, ?)")) {
                long now = System.currentTimeMillis();
                insert.setBytes(1, ManagedSchemaKeys.identity(tenant));
                insert.setBytes(2, ManagedSchemaKeys.identity(session));
                insert.setString(3, ManagedSchemaKeys.key(tenant));
                insert.setString(4, ManagedSchemaKeys.key(session));
                insert.setString(5, ManagedSchemaKeys.key(tenant, session));
                insert.setLong(6, now);
                insert.setLong(7, now);
                insert.executeUpdate();
            }
        }
        return new RuntimeRecoveryContract.Fixture(bindings, sessions, executions, tenant, "runtime-session", true);
    }

    /** Holds a Session root on another connection, as a placement-free admission does. */
    protected <T> T whileRootHeld(String tenant, String session, Callable<T> action) throws Exception {
        var held = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var holder = Executors.newSingleThreadExecutor(); var subject = Executors.newSingleThreadExecutor()) {
            var hold = holder.submit(() -> {
                try (Connection connection = source.getConnection()) {
                    connection.setAutoCommit(false);
                    try (var lock = connection.prepareStatement(
                            "SELECT session_id FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE")) {
                        lock.setBytes(1, ManagedSchemaKeys.identity(tenant));
                        lock.setBytes(2, ManagedSchemaKeys.identity(session));
                        lock.executeQuery().close();
                    }
                    held.countDown();
                    assertTrue(release.await(60, TimeUnit.SECONDS));
                    connection.rollback();
                }
                return null;
            });
            try {
                assertTrue(held.await(10, TimeUnit.SECONDS));
                return subject.submit(action).get(5, TimeUnit.SECONDS);
            } finally {
                release.countDown();
                hold.get(30, TimeUnit.SECONDS);
            }
        }
    }

    /** Holds the tenant publication guard, and placement when asked, on another connection. */
    protected <T> T whileGuardsHeld(String tenant, boolean placement, Callable<T> action) throws Exception {
        var held = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var holder = Executors.newSingleThreadExecutor(); var subject = Executors.newSingleThreadExecutor()) {
            var hold = holder.submit(() -> {
                try (Connection connection = source.getConnection()) {
                    connection.setAutoCommit(false);
                    if (placement) {
                        JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant);
                    }
                    String key = ManagedSchemaKeys.key(tenant);
                    try (var insert = connection.prepareStatement("INSERT INTO ma_tenant_guard (tenant_key, tenant_id,"
                            + " guard_domain) VALUES (?, ?, 'output_publication') ON DUPLICATE KEY UPDATE"
                            + " tenant_key = tenant_key")) {
                        insert.setString(1, key);
                        insert.setBytes(2, ManagedSchemaKeys.identity(tenant));
                        insert.executeUpdate();
                    }
                    try (var lock = connection.prepareStatement("SELECT tenant_id FROM ma_tenant_guard WHERE"
                            + " guard_domain = 'output_publication' AND tenant_key = ? FOR UPDATE")) {
                        lock.setString(1, key);
                        lock.executeQuery().close();
                    }
                    held.countDown();
                    assertTrue(release.await(60, TimeUnit.SECONDS));
                    connection.rollback();
                }
                return null;
            });
            try {
                assertTrue(held.await(10, TimeUnit.SECONDS));
                return subject.submit(action).get(5, TimeUnit.SECONDS);
            } finally {
                release.countDown();
                hold.get(30, TimeUnit.SECONDS);
            }
        }
    }
}
