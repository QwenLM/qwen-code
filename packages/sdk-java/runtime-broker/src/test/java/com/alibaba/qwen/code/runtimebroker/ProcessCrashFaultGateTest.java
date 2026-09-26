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
 * Broker leaves its worker running, as a crashed JVM does, and a restarted
 * Broker adopts it through the shared state directory; a host crash takes
 * both.
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
    private Map<String, Object> reference;

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
        BrokerProcess broker = rig.broker("broker", proxy);
        acquire(broker);
        String execution = create(broker);
        rig.awaitMarker("marker", List.of("start"));
        String bindingId = rig.execution(execution).getBindingId();

        long generation = rig.bindings.findById(bindingId).getGeneration();

        rig.killWorker(broker);

        // To the dispatcher a dead worker looks like a lost answer. The
        // binding's liveness check tells them apart: it finds the worker
        // gone, the generation is LOST, and the call is left UNKNOWN.
        rig.awaitExecution(execution, record -> record.getState()
                == ToolExecutionRecord.State.UNKNOWN, "UNKNOWN execution");
        assertEquals(RuntimeBindingRecord.State.LOST,
                rig.bindings.findById(bindingId).getState());
        assertEvidenceUnavailable(broker.reconcile(HARNESS, SESSION,
                execution));
        // The unknown call pins the lost placement (#12670) until an
        // operator decides it.
        assertEquals("runtime_broker_runtime_lost",
                broker.warm(HARNESS).code());
        ToolExecutionRecord unknown = rig.execution(execution);
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        assertNull(unknown.getResult());
        rig.holdMarker("marker", List.of("start"), Duration.ofSeconds(4));

        // Once the call is decided and its Session released, a new
        // generation serves new work.
        assertEquals("SETTLED", broker.resolve(HARNESS, SESSION, execution,
                UnknownExecutionResolution.ACCEPTED_UNKNOWN).object()
                .getString("state"));
        assertEquals(Boolean.TRUE, broker.release(HARNESS, SESSION)
                .requireOk().value());
        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"), rig.logs());
        RuntimeBindingRecord replacement = rig.activeBinding();
        assertTrue(!bindingId.equals(replacement.getBindingId())
                || replacement.getGeneration() > generation,
                "the lost generation was reused");
        assertEquals(List.of("start"), rig.marker("marker"));
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
        BrokerProcess first = rig.broker("first", firstProxy);
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
        BrokerProcess second = rig.broker("second", secondProxy);
        rig.awaitDispatchLapse(execution);
        second.acquire(HARNESS, SESSION).requireOk();
        // Before reuse, the restarted Broker finds the worker through the
        // shared state directory and attests it before it adopts it.
        assertEquals(1, secondProxy.count("attest"));

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
        BrokerProcess.Reply retried = second.create(HARNESS, SESSION,
                "key-1", reference);
        assertFalse(retried.ok(), "a lapsed claim was replayed");
        assertEquals("runtime_broker_execution_unknown", retried.code());
        assertEquals(ToolExecutionRecord.State.UNKNOWN,
                rig.execution(execution).getState());

        if (window == Window.AFTER_CLAIM) {
            // The worker never saw the execute: it holds the call only as
            // prepared, which is no evidence of an outcome.
            JSONObject lookup = second.reconcile(HARNESS, SESSION, execution)
                    .object();
            assertEquals("UNRESOLVED", lookup.getString("outcome"));
            assertEquals("prepared", lookup.getString("runtimeState"));
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
     * Pins today's behaviour for #12670: once a restart proves the worker
     * gone, the unsettled execution pins the LOST generation, so the
     * placement can neither be reclaimed nor released. Update this gate when
     * #12670 is decided.
     */
    @Test
    void aHostCrashPinsTheLostGenerationBehindTheUnsettledCall()
            throws Exception {
        BrokerProcess first = rig.broker("first", rig.proxy());
        acquire(first);
        String execution = create(first);
        rig.awaitMarker("marker", List.of("start"));
        List<ProcessHandle> workers = first.workers();

        rig.killBroker(first);
        workers.forEach(worker -> ProcessTrees.kill(worker,
                FaultGateRig.WAIT));
        FaultProxy secondProxy = rig.proxy();
        BrokerProcess second = rig.broker("second", secondProxy);

        // Recovery finds the worker gone and marks the generation LOST; the
        // unsettled call then pins it.
        assertEquals("runtime_broker_runtime_lost",
                second.warm(HARNESS).code());
        assertEquals(RuntimeBindingRecord.State.LOST,
                rig.activeBinding().getState());
        BrokerProcess.Reply acquire = second.acquire(HARNESS, SESSION);
        assertFalse(acquire.ok());
        assertEquals("runtime_broker_runtime_lost", acquire.code());
        assertEquals("runtime_broker_execution_active",
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

    private String create(BrokerProcess broker) {
        reference = FaultGateRig.shell(broker, "call-1", SLOW);
        return broker.create(HARNESS, SESSION, "key-1", reference).object()
                .getString("executionCallId");
    }

    private static void assertEvidenceUnavailable(BrokerProcess.Reply reply) {
        assertFalse(reply.ok(), "a dead generation settled an execution");
        assertEquals(409, reply.status());
        assertEquals("runtime_broker_execution_evidence_unavailable",
                reply.code());
        assertFalse(reply.retryable());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
