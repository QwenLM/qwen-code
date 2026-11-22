package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.MySqlLockProbe;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

import java.time.Duration;
import java.util.ArrayList;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ExecutionControlTenantGuardsMySqlIT extends ExecutionControlTenantGuardsTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(database.source());
        return database.source();
    }

    @AfterEach
    void close() {
        if (database != null) {
            database.close();
        }
    }

    /**
     * Dispatch locks the Session root and then its binding. Binding control of
     * the same session-class binding takes placement, the publication guard,
     * the root and then the binding rows. Both lock the root before the
     * binding, so they never close a cycle on one Session. Without a root,
     * a locking read takes only a gap lock and orders nothing, so dispatch
     * keeps the guarded path: their two lookups lock the binding's primary and
     * unique indexes in opposite orders.
     */
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {true, false})
    void dispatchBesideBindingControlOfTheSameSessionDoesNotDeadlock(boolean root) throws Exception {
        var fixture = sessionFixture(root);
        int rounds = 25;
        var claims = new ArrayList<ToolExecutionRecord>();
        for (int index = 0; index < rounds; index++) {
            claims.add(executions.claimDispatch(fixture.prepare("call-" + index).getExecutionCallId(), "owner",
                    Duration.ofMinutes(1)));
        }
        // The fixture keeps its provisioning claim; release it so control can claim.
        bindings.releaseOperation(fixture.binding.getBindingId(), "recovery", fixture.binding.getOperationGeneration());
        var admin = new JdbcTemplate(source);
        long deadlocks = MySqlLockProbe.innodbDeadlocks(admin);
        var start = new CyclicBarrier(2);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var dispatch = pool.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                int executing = 0;
                for (var claim : claims) {
                    if (bindings.authorizeDispatch(sessions, executions, claim, "owner",
                            claim.getDispatchGeneration()).getState() == ToolExecutionRecord.State.EXECUTING) {
                        executing++;
                    }
                }
                return executing;
            });
            var control = pool.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                int controlled = 0;
                for (int index = 0; index < rounds; index++) {
                    var claimed = bindings.claimOperation(fixture.binding.getBindingId(), "control",
                            Duration.ofMinutes(1));
                    if (claimed != null) {
                        bindings.renewOperation(claimed.getBindingId(), "control",
                                claimed.getOperationGeneration(), Duration.ofMinutes(1));
                        bindings.releaseOperation(claimed.getBindingId(), "control",
                                claimed.getOperationGeneration());
                        controlled++;
                    }
                }
                return controlled;
            });
            assertEquals(rounds, dispatch.get(120, TimeUnit.SECONDS));
            assertEquals(rounds, control.get(120, TimeUnit.SECONDS));
        }
        assertEquals(0, MySqlLockProbe.innodbDeadlocks(admin) - deadlocks);
    }

    /**
     * Placement-free admission locks the Session root, then the binding.
     * Binding control takes the root before the binding behind both guards,
     * and the drain takes the root behind placement, so the three never close
     * a cycle. Once the drain commits, every later admission is refused.
     */
    @org.junit.jupiter.api.Test
    void admissionBesideDrainAndBindingControlOfTheSameSessionDoesNotDeadlock() throws Exception {
        var fixture = sessionFixture(true);
        bindings.releaseOperation(fixture.binding.getBindingId(), "recovery", fixture.binding.getOperationGeneration());
        var admin = new JdbcTemplate(source);
        long deadlocks = MySqlLockProbe.innodbDeadlocks(admin);
        int rounds = 40;
        var start = new CyclicBarrier(3);
        var drainNow = new java.util.concurrent.CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(3)) {
            var admission = pool.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                var outcomes = new ArrayList<String>();
                for (int index = 0; index < rounds; index++) {
                    if (index == rounds / 4) {
                        drainNow.countDown();
                    }
                    try {
                        fixture.prepare("call-" + index);
                        outcomes.add("admitted");
                    } catch (RuntimeBrokerException refused) {
                        outcomes.add(refused.getCode());
                    }
                }
                return outcomes;
            });
            var drain = pool.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                drainNow.await(60, TimeUnit.SECONDS);
                bindings.requestHarnessDrain(fixture.id, fixture.id + "-harness");
                return null;
            });
            var control = pool.submit(() -> {
                start.await(10, TimeUnit.SECONDS);
                for (int index = 0; index < rounds; index++) {
                    var claimed = bindings.claimOperation(fixture.binding.getBindingId(), "control",
                            Duration.ofMinutes(1));
                    if (claimed != null) {
                        bindings.renewOperation(claimed.getBindingId(), "control",
                                claimed.getOperationGeneration(), Duration.ofMinutes(1));
                        bindings.releaseOperation(claimed.getBindingId(), "control",
                                claimed.getOperationGeneration());
                    }
                }
                return null;
            });
            drain.get(120, TimeUnit.SECONDS);
            control.get(120, TimeUnit.SECONDS);
            var outcomes = admission.get(120, TimeUnit.SECONDS);
            int firstClosed = outcomes.indexOf("runtime_admission_closed");
            org.junit.jupiter.api.Assertions.assertTrue(firstClosed > 0, outcomes.toString());
            org.junit.jupiter.api.Assertions.assertTrue(outcomes.subList(firstClosed, rounds).stream()
                    .allMatch("runtime_admission_closed"::equals), outcomes.toString());
        }
        assertEquals(0, MySqlLockProbe.innodbDeadlocks(admin) - deadlocks);
        org.junit.jupiter.api.Assertions.assertTrue(bindings.isHarnessDraining(fixture.id, fixture.id + "-harness"));
    }
}
