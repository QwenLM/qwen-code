package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.HARNESS;
import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.SESSION;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** FG1: the rig itself, proven by a run with no fault injected. */
@Tag("fault-gate")
class FaultGateControlTest {
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
    void aToolCallSettlesOnceThroughTheRealWorkerAndProxy()
            throws Exception {
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("control", proxy);
        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"), rig.logs());
        // The provisioner waits for the worker it started to answer its
        // health probe, then the service attests it once before it records
        // the binding READY.
        assertEquals(1, proxy.count("attest"));
        broker.acquire(HARNESS, SESSION).requireOk();
        // The worker checks the lease's token, ID and epoch on every later
        // request, starting with this Session verb, so reuse needs no new
        // attestation.
        assertEquals(1, proxy.count("prepare"));
        assertEquals(1, proxy.count("attest"));
        String execution = broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell(broker, "call-1",
                        "echo ran >> control"))
                .object().getString("executionCallId");

        ToolExecutionRecord settled = rig.awaitExecution(execution,
                ToolExecutionRecord::isSettled, "settled execution");
        assertEquals("success", settled.getExecutionStatus());
        assertEquals(List.of("ran"), rig.marker("control"));
        assertEquals(1, proxy.count("execute"));

        // The Runtime answers a lookup by the original identity with the
        // same result the Broker recorded.
        RuntimeBindingRecord binding = rig.activeBinding();
        Map<String, Object> status = new HttpRuntimeTransport()
                .status(binding.getLease(), rig.session(),
                        settled.getReference(), 0)
                .toCompletableFuture().get(10, TimeUnit.SECONDS);
        assertEquals("settled", status.get("state"));
        assertTrue(BrokerValues.sameJsonMap(settled.getResult(),
                BrokerValues.immutableMap(castMap(status.get("result")))));
        assertEquals(Boolean.TRUE, broker.release(HARNESS, SESSION)
                .requireOk().value());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object value) {
        return (Map<String, Object>) value;
    }
}
