package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.HARNESS;
import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.SESSION;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.fastjson2.JSONObject;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

/**
 * FG2: the worker answered, and the answer never reached the Broker. Every
 * case checks that the side effect ran at most once, that nothing reported a
 * completion that did not happen, that nothing settled without the Runtime's
 * evidence, and that the original identity returns the original result. The
 * dispatcher looks a call up by its reference before it executes it and
 * again after any lost answer, so a lost answer is recovered from the
 * Runtime's own record of the call instead of being left UNKNOWN.
 */
@Tag("fault-gate")
class LostResponseFaultGateTest {
    private FaultGateRig rig;
    private FaultProxy proxy;
    private BrokerProcess broker;

    @BeforeEach
    void openRig() throws Exception {
        rig = FaultGateRig.open();
        proxy = rig.proxy();
        broker = rig.broker("broker", proxy);
    }

    @AfterEach
    void closeRig() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    // A slow answer is not a lost one: a tool request waits for as long as
    // the tool runs, up to ten minutes.
    @ParameterizedTest
    @EnumSource(value = FaultProxy.Action.class, names = {"DROP", "RESET"})
    void aLostExecuteResponseIsRecoveredFromEvidenceAndNeverReplayed(
            FaultProxy.Action loss) throws Exception {
        proxy.schedule("execute", loss);
        acquire();
        Map<String, Object> reference = FaultGateRig.shell(broker, "call-1",
                "echo ran >> marker");
        String execution = broker.create(HARNESS, SESSION, "key-1",
                reference).object().getString("executionCallId");

        ToolExecutionRecord settled = rig.awaitExecution(execution,
                ToolExecutionRecord::isSettled, "settled execution");
        assertEquals("success", settled.getExecutionStatus());
        rig.awaitMarker("marker", List.of("ran"));
        // The result came from a lookup made after the answer was lost.
        List<String> operations = proxy.exchanges().stream()
                .map(FaultProxy.Exchange::operation).toList();
        assertTrue(operations.lastIndexOf("status")
                > operations.indexOf("execute"), operations.toString());

        // A same-key retry answers from the settled row and dispatches
        // nothing.
        JSONObject retried = broker.create(HARNESS, SESSION, "key-1",
                reference).object();
        assertEquals(execution, retried.getString("executionCallId"));
        assertEquals("SETTLED", retried.getString("state"));
        // The Runtime joins a retry of the same identity to the call it
        // already ran instead of running it again.
        RuntimeLease lease = rig.activeBinding().getLease();
        HttpRuntimeTransport runtime = new HttpRuntimeTransport();
        Map<String, Object> joined = runtime.execute(lease, rig.session(),
                reference).toCompletableFuture().get(30, TimeUnit.SECONDS);
        Map<String, Object> status = runtime.status(lease, rig.session(),
                reference, 0).toCompletableFuture().get(30,
                        TimeUnit.SECONDS);
        assertEquals("settled", status.get("state"));
        assertTrue(BrokerValues.sameJsonMap(BrokerValues.immutableMap(joined),
                BrokerValues.immutableMap(castMap(status.get("result")))));
        assertTrue(BrokerValues.sameJsonMap(settled.getResult(),
                BrokerValues.immutableMap(joined)));
        assertEquals(List.of("ran"), rig.marker("marker"));
        assertEquals(1, proxy.count("execute"));
    }

    @Test
    void aLostStatusResponseNeverSettlesTheCall() throws Exception {
        proxy.schedule("execute", FaultProxy.Action.DROP);
        // The first lookup comes before the execute; the next ones recover
        // the lost execute answer.
        proxy.schedule("status", FaultProxy.Action.PASS);
        FaultProxy.Fault held = proxy.schedule("status",
                FaultProxy.Action.HOLD_RESPONSE);
        proxy.schedule("status", FaultProxy.Action.RESET);
        acquire();
        String execution = broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell(broker, "call-1", "echo ran >> marker"))
                .object().getString("executionCallId");
        held.awaitHeld(FaultGateRig.WAIT);
        rig.awaitMarker("marker", List.of("ran"));

        // The Runtime's answer is held in flight: nothing has settled.
        ToolExecutionRecord pending = rig.execution(execution);
        assertEquals(ToolExecutionRecord.State.EXECUTING,
                pending.getState());
        assertNull(pending.getResult());
        held.release(FaultProxy.Action.DROP);

        // A dropped and then a reset lookup settle nothing; the next
        // answered lookup settles the call from the Runtime's record.
        ToolExecutionRecord settled = rig.awaitExecution(execution,
                ToolExecutionRecord::isSettled, "settled execution");
        assertEquals("success", settled.getExecutionStatus());
        assertTrue(proxy.count("status") >= 4,
                proxy.exchanges().toString());
        assertEquals(1, proxy.count("execute"));
        assertEquals(List.of("ran"), rig.marker("marker"));
    }

    @Test
    void aLostCancelResponseNeverReportsTheCancellation() throws Exception {
        acquire();
        String execution = broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell(broker, "call-1",
                        "echo start >> marker; sleep 5; echo end >> marker"))
                .object().getString("executionCallId");
        rig.awaitMarker("marker", List.of("start"));

        proxy.schedule("cancel", FaultProxy.Action.DROP);
        BrokerProcess.Reply cancel = broker.cancel(HARNESS, SESSION,
                execution);
        assertFalse(cancel.ok(), "a lost cancel answer was reported");
        assertEquals("managed_runtime_unavailable", cancel.code());

        // The worker did receive the cancel; the Broker learns the outcome
        // only from the execute answer the worker then sends.
        ToolExecutionRecord settled = rig.awaitExecution(execution,
                ToolExecutionRecord::isSettled, "settled execution");
        assertEquals("cancelled", settled.getExecutionStatus());
        // The command's sleep would have ended by now; its tail never runs.
        rig.holdMarker("marker", List.of("start"), Duration.ofSeconds(6));
        Map<String, Object> status = new HttpRuntimeTransport().status(
                rig.activeBinding().getLease(), rig.session(),
                settled.getReference(), 0).toCompletableFuture()
                .get(30, TimeUnit.SECONDS);
        assertEquals("settled", status.get("state"));
        assertTrue(BrokerValues.sameJsonMap(settled.getResult(),
                BrokerValues.immutableMap(castMap(status.get("result")))));
        assertEquals(1, proxy.count("cancel"));
        assertEquals(1, proxy.count("execute"));
    }

    @Test
    void aLostAttestationIsProvenAgainBeforeTheBindingIsReady()
            throws Exception {
        proxy.schedule("attest", FaultProxy.Action.DROP);

        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"), rig.logs());
        // The lost answer proved nothing; READY waited for a second
        // attestation of the same worker.
        assertEquals(2, proxy.count("attest"));
        assertEquals(1, broker.workers().size());
    }

    @Test
    void attestationsLostUntilTheDeadlineNeverYieldAReadyLease()
            throws Exception {
        // A short operation lease bounds how long recovery keeps trying.
        BrokerProcess shortLived = rig.broker("short", proxy, null,
                Duration.ofSeconds(3));
        for (int index = 0; index < 1000; index++) {
            proxy.schedule("attest", FaultProxy.Action.DROP);
        }

        BrokerProcess.Reply lost = shortLived.warm(HARNESS);
        assertFalse(lost.ok(), "a lost attestation produced a binding");
        assertTrue(lost.retryable());
        assertTrue(proxy.count("attest") > 1, proxy.exchanges().toString());
        RuntimeBindingRecord binding = rig.activeBinding();
        assertFalse(binding.getState() == RuntimeBindingRecord.State.READY);
        assertNull(binding.getLease());
        assertEquals(1, shortLived.workers().size());

        // Once an attestation is answered, the next warm proves the same
        // worker and binding instead of starting another.
        proxy.clear("attest");
        assertEquals("READY", shortLived.warm(HARNESS).object()
                .getString("state"), rig.logs());
        assertEquals(1, shortLived.workers().size());
        assertEquals(binding.getBindingId(), rig.activeBinding()
                .getBindingId());
    }

    private void acquire() {
        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"), rig.logs());
        broker.acquire(HARNESS, SESSION).requireOk();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
