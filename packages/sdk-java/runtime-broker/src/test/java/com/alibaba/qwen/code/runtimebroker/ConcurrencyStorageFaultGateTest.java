package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.HARNESS;
import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.SESSION;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** FG4: two Brokers on one database, and a database that goes away. */
@Tag("fault-gate")
class ConcurrencyStorageFaultGateTest {
    private FaultGateRig rig;

    @BeforeEach
    void openRig() throws Exception {
        rig = FaultGateRig.open();
    }

    @AfterEach
    void closeRig() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    /**
     * A process-level takeover in the spirit of #12477: the dispatching
     * Broker freezes (SIGSTOP) past its dispatch lease, a second Broker
     * adopts the worker and fences the call, and the stale Broker is then
     * thawed and handed the worker's answer it was still waiting for. That
     * late answer must not settle the fenced record, and nothing the stale
     * Broker is asked afterwards may reach the Runtime. The unit test for
     * #12477 covers the narrower window between claim and execute, which a
     * signal cannot hit reliably.
     */
    @Test
    void aStaleBrokerStaysSilentAfterADispatchTakeover() throws Exception {
        FaultProxy staleProxy = rig.proxy();
        FaultProxy takeoverProxy = rig.proxy();
        TcpRelay staleDatabase = rig.databaseRelay();
        // The held answer must reach the stale Broker as an answer, not as a
        // request timeout, however long the takeover takes on a slow host.
        BrokerProcess stale = rig.broker("stale", staleProxy,
                FaultGateRig.Provisioner.RECOVERABLE, staleDatabase,
                FaultGateRig.WAIT.multipliedBy(2));
        BrokerProcess takeover = rig.broker("takeover", takeoverProxy,
                FaultGateRig.Provisioner.RECOVERABLE);
        assertEquals("READY", stale.warm(HARNESS).object()
                .getString("state"), rig.logs());
        stale.acquire(HARNESS, SESSION).requireOk();
        FaultProxy.Fault answer = staleProxy.schedule("execute",
                FaultProxy.Action.HOLD_RESPONSE);
        Map<String, Object> reference = FaultGateRig.shell("call-1",
                "echo ran >> marker");
        String execution = stale.create(HARNESS, SESSION, "key-1", reference)
                .object().getString("executionCallId");
        answer.awaitHeld(FaultGateRig.WAIT);
        assertEquals(List.of("ran"), rig.marker("marker"));

        freezeBetweenDatabaseCalls(stale, staleDatabase);
        rig.awaitDispatchLapse(execution);
        takeover.acquire(HARNESS, SESSION).requireOk();
        // Before reuse, the takeover Broker re-proves the worker's identity:
        // once as the provisioner observes it, once as the service adopts it.
        assertEquals(2, takeoverProxy.count("attest"));
        assertEquals("UNKNOWN", takeover.create(HARNESS, SESSION, "key-1",
                reference).object().getString("state"));
        long thawed = System.nanoTime();
        stale.resume();

        // The stale Broker gets the answer it was waiting for only now. Its
        // claim was fenced, so the record stays UNKNOWN until the takeover
        // Broker settles it from the Runtime's evidence.
        answer.release(FaultProxy.Action.PASS);
        answer.awaitDelivered(FaultGateRig.WAIT);
        FaultGateRig.hold(() -> rig.execution(execution).getState(),
                ToolExecutionRecord.State.UNKNOWN::equals,
                Duration.ofSeconds(2), "the fenced record");
        assertEquals("RESOLVED", takeover.reconcile(HARNESS, SESSION,
                execution).object().getString("outcome"));
        ToolExecutionRecord settled = rig.execution(execution);
        assertEquals("success", settled.getExecutionStatus());

        // Asked again by the same key, to cancel, or to reconcile, the stale
        // Broker answers from the settled record alone.
        for (BrokerProcess.Reply reply : List.of(
                stale.create(HARNESS, SESSION, "key-1", reference),
                stale.cancel(HARNESS, SESSION, execution),
                stale.get(HARNESS, SESSION, execution))) {
            assertEquals("SETTLED", reply.object().getString("state"));
        }
        assertEquals("ALREADY_SETTLED", stale.reconcile(HARNESS, SESSION,
                execution).object().getString("outcome"));
        assertEquals(0, staleProxy.countSince(thawed),
                "the stale Broker called its Runtime after the takeover: "
                        + staleProxy.exchanges());
        assertEquals(settled.getVersion(),
                rig.execution(execution).getVersion());
        assertEquals(List.of("ran"), rig.marker("marker"));
        assertEquals(1, staleProxy.count("execute"));
        assertEquals(0, takeoverProxy.count("execute"));
    }

    @Test
    void aDatabaseOutageDuringTheResultCommitNeverSettles()
            throws Exception {
        TcpRelay database = rig.databaseRelay();
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS, database);
        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"), rig.logs());
        broker.acquire(HARNESS, SESSION).requireOk();
        FaultProxy.Fault answer = proxy.schedule("execute",
                FaultProxy.Action.HOLD_RESPONSE);
        Map<String, Object> reference = FaultGateRig.shell("call-1",
                "echo ran >> marker");
        String execution = broker.create(HARNESS, SESSION, "key-1", reference)
                .object().getString("executionCallId");
        answer.awaitHeld(FaultGateRig.WAIT);
        assertEquals(List.of("ran"), rig.marker("marker"));

        database.cut();
        answer.release(FaultProxy.Action.PASS);
        FaultGateRig.await(database::refused, attempts -> attempts > 0,
                "the Broker to try committing the result");
        // The failed commit ends after a few attempts; nothing keeps
        // retrying it in a loop.
        int attempts = FaultGateRig.settle(database::refused,
                Duration.ofSeconds(3), "commit attempts during the outage");
        assertTrue(attempts <= 4, attempts + " commit attempts");
        // Nor does the Broker report an outcome it could not commit.
        assertFalse(broker.get(HARNESS, SESSION, execution).ok());
        database.restore();

        // Today nothing retries the commit once the database is back, so
        // the record waits for the claim to lapse.
        ToolExecutionRecord uncommitted = rig.execution(execution);
        assertEquals(ToolExecutionRecord.State.EXECUTING,
                uncommitted.getState());
        assertNull(uncommitted.getResult());
        assertEquals("EXECUTING", broker.get(HARNESS, SESSION, execution)
                .object().getString("state"));

        // Once the claim lapses, the same key fences the call and the
        // Runtime's evidence settles it; nothing runs it again.
        rig.awaitDispatchLapse(execution);
        assertEquals("UNKNOWN", broker.create(HARNESS, SESSION, "key-1",
                reference).object().getString("state"));
        assertEquals("RESOLVED", broker.reconcile(HARNESS, SESSION,
                execution).object().getString("outcome"));
        ToolExecutionRecord settled = rig.execution(execution);
        assertTrue(settled.isSettled());
        assertEquals("success", settled.getExecutionStatus());
        assertEquals(List.of("ran"), rig.marker("marker"));
        assertEquals(1, proxy.count("execute"));
    }

    /**
     * A Broker frozen inside a database transaction would hold its row locks
     * and wedge the takeover on them, which is not the fault under test.
     * Each repository call opens its own connection, so a relay with no open
     * connection means the Broker is between calls.
     */
    private static void freezeBetweenDatabaseCalls(BrokerProcess broker,
            TcpRelay database) throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            broker.pause();
            if (database.idle()) {
                return;
            }
            broker.resume();
            Thread.sleep(37);
        }
        throw new AssertionError("the Broker never paused between database"
                + " calls");
    }
}
