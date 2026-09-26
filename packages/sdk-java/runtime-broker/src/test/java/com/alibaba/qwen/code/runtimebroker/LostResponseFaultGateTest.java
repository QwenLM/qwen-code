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
import org.junit.jupiter.params.provider.ValueSource;

/**
 * FG2: the worker answered, and the answer never reached the Broker. Every
 * case checks that the side effect ran at most once, that nothing reported a
 * completion that did not happen, that UNKNOWN stayed blocked until the
 * Runtime gave evidence, and that the original identity returns the original
 * result.
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
        broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);
    }

    @AfterEach
    void closeRig() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    @ParameterizedTest
    @EnumSource(value = FaultProxy.Action.class,
            names = {"DROP", "RESET", "DELAY"})
    void aLostExecuteResponseIsReconciledAndNeverReplayed(
            FaultProxy.Action loss) throws Exception {
        proxy.schedule("execute", loss == FaultProxy.Action.DELAY
                ? FaultProxy.Fault.delay(FaultGateRig.REQUEST_TIMEOUT
                        .plusSeconds(3))
                : FaultProxy.Fault.of(loss));
        acquire();
        Map<String, Object> reference = FaultGateRig.shell("call-1",
                "echo ran >> marker");
        String execution = broker.create(HARNESS, SESSION, "key-1",
                reference).object().getString("executionCallId");

        rig.awaitExecution(execution, record -> record.getState()
                == ToolExecutionRecord.State.UNKNOWN, "UNKNOWN execution");
        rig.awaitMarker("marker", List.of("ran"));

        // A same-key retry joins the UNKNOWN record and dispatches nothing.
        JSONObject retried = broker.create(HARNESS, SESSION, "key-1",
                reference).object();
        assertEquals(execution, retried.getString("executionCallId"));
        assertEquals("UNKNOWN", retried.getString("state"));
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
        assertEquals(joined, status.get("result"));
        assertEquals(List.of("ran"), rig.marker("marker"));

        JSONObject reconciled = broker.reconcile(HARNESS, SESSION, execution)
                .object();
        assertEquals("RESOLVED", reconciled.getString("outcome"));
        ToolExecutionRecord settled = rig.execution(execution);
        assertTrue(settled.isSettled());
        assertEquals("success", settled.getExecutionStatus());
        assertTrue(BrokerValues.sameJsonMap(settled.getResult(),
                BrokerValues.immutableMap(joined)));
        assertEquals(List.of("ran"), rig.marker("marker"));
        assertEquals(1, proxy.count("execute"));
    }

    @Test
    void aLostStatusResponseLeavesTheExecutionUnknown() throws Exception {
        proxy.schedule("execute", FaultProxy.Action.DROP);
        acquire();
        String execution = broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell("call-1", "echo ran >> marker"))
                .object().getString("executionCallId");
        rig.awaitExecution(execution, record -> record.getState()
                == ToolExecutionRecord.State.UNKNOWN, "UNKNOWN execution");
        rig.awaitMarker("marker", List.of("ran"));

        for (FaultProxy.Action loss : List.of(FaultProxy.Action.DROP,
                FaultProxy.Action.RESET)) {
            proxy.schedule("status", loss);
            BrokerProcess.Reply lost = broker.reconcile(HARNESS, SESSION,
                    execution);
            assertFalse(lost.ok(), loss + " status settled the execution");
            assertEquals("managed_runtime_unavailable", lost.code());
            assertTrue(lost.retryable());
            ToolExecutionRecord still = rig.execution(execution);
            assertEquals(ToolExecutionRecord.State.UNKNOWN, still.getState());
            assertNull(still.getResult());
        }

        assertEquals("RESOLVED", broker.reconcile(HARNESS, SESSION,
                execution).object().getString("outcome"));
        assertEquals("success", rig.execution(execution)
                .getExecutionStatus());
        assertEquals(3, proxy.count("status"));
        assertEquals(1, proxy.count("execute"));
        assertEquals(List.of("ran"), rig.marker("marker"));
    }

    @Test
    void aLostCancelResponseNeverReportsTheCancellation() throws Exception {
        acquire();
        String execution = broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell("call-1",
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

    @ParameterizedTest
    @ValueSource(ints = {0, 1})
    void aLostAttestationNeverYieldsAReadyLease(int lostAttestation)
            throws Exception {
        // The provisioner attests the worker it started (0), then the
        // service attests it again (1).
        for (int index = 0; index < lostAttestation; index++) {
            proxy.schedule("attest", FaultProxy.Action.PASS);
        }
        proxy.schedule("attest", FaultProxy.Action.DROP);

        BrokerProcess.Reply lost = broker.warm(HARNESS);
        assertFalse(lost.ok(), "a lost attestation produced a binding");
        assertTrue(lost.retryable());
        RuntimeBindingRecord binding = rig.activeBinding();
        assertEquals(RuntimeBindingRecord.State.PROVISIONING,
                binding.getState());
        assertNull(binding.getLease());
        FaultGateRig.await(broker::workers, List::isEmpty,
                "the unattested worker to be reaped");

        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"));
        assertEquals(1, broker.workers().size());
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
