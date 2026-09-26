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
 * FG3: a worker or a Broker JVM dies with a tool call in flight. A killed
 * Broker leaves its worker running, as a crashed JVM does; a host crash
 * takes both.
 */
@Tag("fault-gate")
class ProcessCrashFaultGateTest {
    private static final String SLOW =
            "echo start >> marker; sleep 3; echo end >> marker";

    /** Where the Broker JVM dies relative to the one execute exchange. */
    enum Window {
        /** Claimed and sent, but the worker never received it. */
        AFTER_CLAIM,
        /** The worker is running the command. */
        AFTER_SEND,
        /** The worker settled; its answer has not reached the Broker. */
        BEFORE_COMMIT
    }

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

    @Test
    void aWorkerKilledMidExecutionLeavesItUnknownWithoutEvidence()
            throws Exception {
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);
        acquire(broker);
        String execution = create(broker);
        rig.awaitMarker("marker", List.of("start"));
        String bindingId = rig.execution(execution).getBindingId();

        rig.killWorker(broker);

        rig.awaitExecution(execution, record -> record.getState()
                == ToolExecutionRecord.State.UNKNOWN, "UNKNOWN execution");
        assertEvidenceUnavailable(broker.reconcile(HARNESS, SESSION,
                execution));
        // The dead generation is retired, and a new one serves new work.
        assertEquals(RuntimeBindingRecord.State.FAILED,
                rig.bindings.findById(bindingId).getState());
        JSONObject replacement = broker.warm(HARNESS).object();
        assertEquals("READY", replacement.getString("state"));
        assertFalse(bindingId.equals(replacement.getString("bindingId")));
        // Nothing the new generation says can settle the old call.
        assertEvidenceUnavailable(broker.reconcile(HARNESS, SESSION,
                execution));
        ToolExecutionRecord unknown = rig.execution(execution);
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        assertNull(unknown.getResult());
        rig.holdMarker("marker", List.of("start"), Duration.ofSeconds(4));
        assertEquals(1, proxy.count("execute"));
    }

    @ParameterizedTest
    @EnumSource(Window.class)
    void aRestartedBrokerAdoptsTheWorkerAndNeverRunsTheCallTwice(
            Window window) throws Exception {
        FaultProxy firstProxy = rig.proxy();
        FaultProxy.Fault fault = firstProxy.schedule("execute",
                switch (window) {
                    case AFTER_CLAIM -> FaultProxy.Action.HOLD_REQUEST;
                    case AFTER_SEND -> FaultProxy.Action.PASS;
                    case BEFORE_COMMIT -> FaultProxy.Action.HOLD_RESPONSE;
                });
        BrokerProcess first = rig.broker("first", firstProxy,
                FaultGateRig.Provisioner.RECOVERABLE);
        acquire(first);
        String execution = create(first);
        switch (window) {
            case AFTER_CLAIM, BEFORE_COMMIT -> fault.awaitHeld(
                    FaultGateRig.WAIT);
            default -> rig.awaitMarker("marker", List.of("start"));
        }
        RuntimeBindingRecord before = rig.activeBinding();

        rig.killBroker(first);
        fault.release(FaultProxy.Action.RESET);
        FaultProxy secondProxy = rig.proxy();
        BrokerProcess second = rig.broker("second", secondProxy,
                FaultGateRig.Provisioner.RECOVERABLE);
        rig.awaitDispatchLapse(execution);
        second.acquire(HARNESS, SESSION).requireOk();
        // Before reuse, the restarted Broker re-proves the worker's identity:
        // once as the provisioner observes it, once as the service adopts it.
        assertEquals(2, secondProxy.count("attest"));

        // Adopted, not replaced: the same generation and lease, and the
        // second Broker started no worker of its own.
        RuntimeBindingRecord adopted = rig.activeBinding();
        assertEquals(before.getBindingId(), adopted.getBindingId());
        assertEquals(before.getGeneration(), adopted.getGeneration());
        assertEquals(RuntimeBindingRecord.State.READY, adopted.getState());
        assertEquals(before.getLease().getEndpoint(),
                adopted.getLease().getEndpoint());
        assertTrue(second.workers().isEmpty());

        // A same-key retry fences the lapsed claim instead of replaying it.
        JSONObject retried = second.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell("call-1", SLOW)).object();
        assertEquals(execution, retried.getString("executionCallId"));
        assertEquals("UNKNOWN", retried.getString("state"));

        if (window == Window.AFTER_CLAIM) {
            // The worker never saw the call, so it has no evidence to give.
            JSONObject lookup = second.reconcile(HARNESS, SESSION, execution)
                    .object();
            assertEquals("UNRESOLVED", lookup.getString("outcome"));
            assertEquals("unknown", lookup.getString("runtimeState"));
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    rig.execution(execution).getState());
            rig.holdMarker("marker", List.of(), Duration.ofSeconds(1));
        } else {
            FaultGateRig.await(() -> second.reconcile(HARNESS, SESSION,
                    execution).object().getString("outcome"),
                    "RESOLVED"::equals, "reconciliation from evidence");
            ToolExecutionRecord settled = rig.execution(execution);
            assertEquals("success", settled.getExecutionStatus());
            Map<String, Object> status = new HttpRuntimeTransport().status(
                    adopted.getLease(), rig.session(),
                    settled.getReference(), 0).toCompletableFuture()
                    .get(30, TimeUnit.SECONDS);
            assertTrue(BrokerValues.sameJsonMap(settled.getResult(),
                    BrokerValues.immutableMap(castMap(
                            status.get("result")))));
            assertEquals(List.of("start", "end"), rig.marker("marker"));
        }
        assertEquals(1, firstProxy.count("execute"));
        assertEquals(0, secondProxy.count("execute"));
    }

    /**
     * Pins today's production behaviour. {@link LocalProcessRuntimeProvisioner}
     * keeps worker ownership in memory, so a restarted Broker observes its
     * worker as UNKNOWN until the reconciliation deadline: the binding is
     * neither adopted nor retired, and the orphaned worker keeps running.
     * Recoverable local-process provisioning is follow-up work in the
     * runtime-binding reconciliation design; this gate flips to adoption
     * when it lands.
     */
    @Test
    void theProductionProvisionerCannotAdoptAfterARestart()
            throws Exception {
        BrokerProcess first = rig.broker("first", rig.proxy(),
                FaultGateRig.Provisioner.LOCAL_PROCESS);
        acquire(first);
        String execution = create(first);
        rig.awaitMarker("marker", List.of("start"));
        RuntimeBindingRecord before = rig.activeBinding();

        rig.killBroker(first);
        FaultProxy secondProxy = rig.proxy();
        BrokerProcess second = rig.broker("second", secondProxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);

        BrokerProcess.Reply warm = second.warm(HARNESS);
        assertFalse(warm.ok(), "a restarted Broker adopted a worker it"
                + " cannot observe");
        assertEquals("runtime_broker_reconcile_timeout", warm.code());
        assertTrue(warm.retryable());
        RuntimeBindingRecord after = rig.activeBinding();
        assertEquals(before.getBindingId(), after.getBindingId());
        assertEquals(RuntimeBindingRecord.State.READY, after.getState());
        assertEquals(before.getLease().getEndpoint(),
                after.getLease().getEndpoint());
        assertTrue(second.workers().isEmpty());
        // The orphan finishes the call on its own; nothing runs it again,
        // and without a Session nothing fences or settles the record.
        rig.awaitMarker("marker", List.of("start", "end"));
        assertEquals("IN_FLIGHT", second.reconcile(HARNESS, SESSION,
                execution).object().getString("outcome"));
        assertEquals(ToolExecutionRecord.State.EXECUTING,
                rig.execution(execution).getState());
        assertEquals(0, secondProxy.count("execute"));
    }

    /**
     * Pins today's behaviour for #12670: once a restart proves the worker
     * gone, the unsettled execution pins the LOST generation, so the
     * placement can neither be reclaimed nor released. Update this gate when
     * #12670 is decided.
     */
    @Test
    void aHostCrashPinsTheLostGenerationBehindTheUnsettledCall()
            throws Exception {
        BrokerProcess first = rig.broker("first", rig.proxy(),
                FaultGateRig.Provisioner.RECOVERABLE);
        acquire(first);
        String execution = create(first);
        rig.awaitMarker("marker", List.of("start"));
        List<ProcessHandle> workers = first.workers();

        rig.killBroker(first);
        workers.forEach(worker -> ProcessTrees.kill(worker,
                FaultGateRig.WAIT));
        FaultProxy secondProxy = rig.proxy();
        BrokerProcess second = rig.broker("second", secondProxy,
                FaultGateRig.Provisioner.RECOVERABLE);

        BrokerProcess.Reply acquire = second.acquire(HARNESS, SESSION);
        assertFalse(acquire.ok());
        assertEquals("runtime_broker_runtime_lost", acquire.code());
        assertEquals(RuntimeBindingRecord.State.LOST,
                rig.activeBinding().getState());
        assertEquals("runtime_broker_runtime_lost",
                second.warm(HARNESS).code());
        assertEquals("runtime_reconciliation_required",
                second.release(HARNESS, SESSION).code());
        assertEquals("IN_FLIGHT", second.reconcile(HARNESS, SESSION,
                execution).object().getString("outcome"));
        assertEquals(ToolExecutionRecord.State.EXECUTING,
                rig.execution(execution).getState());
        assertTrue(second.workers().isEmpty());
        rig.holdMarker("marker", List.of("start"), Duration.ofSeconds(4));
        assertEquals(0, secondProxy.count("execute"));
    }

    private void acquire(BrokerProcess broker) {
        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"), rig.logs());
        broker.acquire(HARNESS, SESSION).requireOk();
    }

    private static String create(BrokerProcess broker) {
        return broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell("call-1", SLOW)).object()
                .getString("executionCallId");
    }

    private static void assertEvidenceUnavailable(BrokerProcess.Reply reply) {
        assertFalse(reply.ok(), "a dead generation settled an execution");
        assertEquals(409, reply.status());
        assertEquals("runtime_execution_evidence_unavailable", reply.code());
        assertFalse(reply.retryable());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
