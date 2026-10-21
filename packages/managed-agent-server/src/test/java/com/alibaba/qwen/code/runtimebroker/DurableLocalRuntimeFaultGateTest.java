package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.HARNESS;
import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.SESSION;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

/** Real JVMs, real worker and SQL; portable identity injection is not reboot evidence. */
@Tag("fault-gate")
class DurableLocalRuntimeFaultGateTest {
    @ParameterizedTest
    @EnumSource(FaultGateRig.Placement.class)
    void brokerCrashAdoptsOriginalWorkerWithoutReplaying(FaultGateRig.Placement placement) throws Exception {
        try (var rig = FaultGateRig.open(placement)) {
            var firstProxy = rig.proxy();
            var response = firstProxy.schedule("execute", FaultProxy.Action.HOLD_RESPONSE);
            var first = rig.broker("first", firstProxy, FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            first.acquire(HARNESS, SESSION).requireOk();
            var reference = FaultGateRig.shell("call", "echo start >> marker; echo end >> marker");
            var created = first.create(HARNESS, SESSION, "original", reference).object();
            String execution = created.getString("executionCallId");
            // Keep the result from settling in the first Broker before the crash.
            response.awaitHeld(FaultGateRig.WAIT);
            assertNull(rig.execution(execution).getResult());
            var original = rig.activeBinding();
            var worker = first.workers().getFirst();
            rig.killBroker(first);
            response.release(FaultProxy.Action.RESET);
            var secondProxy = rig.proxy();
            var second = rig.broker("second", secondProxy, FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            rig.awaitDispatchLapse(execution);
            second.acquire(HARNESS, SESSION).requireOk();
            assertEquals(ToolExecutionRecord.State.SETTLED, rig.execution(execution).getState());
            var retry = second.create(HARNESS, SESSION, "original", reference).object();
            assertEquals(execution, retry.getString("executionCallId"));
            assertEquals("SETTLED", retry.getString("state"));
            assertEquals("ALREADY_SETTLED",
                    second.reconcile(HARNESS, SESSION, execution).object().getString("outcome"));
            var restored = rig.activeBinding();
            assertEquals(original.getBindingId(), restored.getBindingId());
            assertEquals(original.getGeneration(), restored.getGeneration());
            assertEquals(original.getProvisionSeed(), restored.getProvisionSeed());
            assertEquals(original.getLease().getEndpoint(), restored.getLease().getEndpoint());
            assertTrue(worker.isAlive());
            assertTrue(second.workers().isEmpty());
            assertEquals(List.of("start", "end"), rig.marker(marker(rig)));
            assertEquals(1, firstProxy.count("execute"));
            assertEquals(0, secondProxy.count("execute"));
            assertEquals("success", rig.execution(execution).getExecutionStatus());
            assertTrue(second.cancel(HARNESS, SESSION, execution).ok());
            assertTrue(second.release(HARNESS, SESSION).ok());
        }
    }

    @ParameterizedTest
    @EnumSource(FaultGateRig.Placement.class)
    void registeredWorkerSurvivesCrashBeforeEndpointPublication(FaultGateRig.Placement placement) throws Exception {
        try (var rig = FaultGateRig.open(placement)) {
            var proxy = rig.proxy();
            var held = proxy.schedule("attest", FaultProxy.Action.HOLD_REQUEST);
            var first = rig.broker("first", proxy, FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            var pending = CompletableFuture.runAsync(() -> first.warm(HARNESS));
            held.awaitHeld(FaultGateRig.WAIT);
            var saved = rig.activeBinding();
            assertEquals(RuntimeBindingRecord.State.PROVISIONING, saved.getState());
            assertNull(saved.getLease());
            var worker = first.workers().getFirst();
            String key = saved.getResourceHandle().getValue().get("resourceId").toString();
            var registration = JsonCodec.parseObject(Files.readAllBytes(rig.root.resolve("durable")
                    .resolve(key + ".json")), "test registration");
            assertEquals("REGISTERED", registration.get("state"));
            assertEquals(worker.pid(), ((Number) registration.get("pid")).longValue());
            assertEquals("", registration.get("endpoint"));
            rig.killBroker(first);
            held.release(FaultProxy.Action.RESET);
            pending.handle((ignored, failure) -> null).get(5, TimeUnit.SECONDS);
            var second = rig.broker("second", rig.proxy(), FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            FaultGateRig.await(() -> second.warm(HARNESS), BrokerProcess.Reply::ok, "startup adoption");
            assertEquals(saved.getBindingId(), rig.activeBinding().getBindingId());
            assertEquals(saved.getProvisionSeed(), rig.activeBinding().getProvisionSeed());
            assertTrue(worker.isAlive());
            assertTrue(second.workers().isEmpty());
            second.acquire(HARNESS, SESSION).requireOk();
            second.release(HARNESS, SESSION).requireOk();
        }
    }

    @ParameterizedTest
    @EnumSource(FaultGateRig.Placement.class)
    void closingAnObserverCannotKillTheSharedWorker(FaultGateRig.Placement placement) throws Exception {
        try (var rig = FaultGateRig.open(placement)) {
            var first = rig.broker("first", rig.proxy(), FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            first.acquire(HARNESS, SESSION).requireOk();
            var worker = first.workers().getFirst();
            var original = rig.activeBinding();
            var second = rig.broker("second", rig.proxy(), FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            second.acquire(HARNESS, SESSION).requireOk();
            rig.closeBroker(second);
            assertTrue(worker.isAlive());
            first.warm(HARNESS).requireOk();
            var third = rig.broker("third", rig.proxy(), FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            third.acquire(HARNESS, SESSION).requireOk();
            rig.closeBroker(first);
            assertTrue(worker.isAlive());
            third.warm(HARNESS).requireOk();
            assertEquals(original.getLease().getEndpoint(), rig.activeBinding().getLease().getEndpoint());
            third.release(HARNESS, SESSION).requireOk();
        }
    }

    @ParameterizedTest
    @EnumSource(FaultGateRig.Placement.class)
    void adoptedWorkerCanCancelALiveClaimBeforeOriginalBrokerExit(FaultGateRig.Placement placement) throws Exception {
        try (var rig = FaultGateRig.open(placement)) {
            var first = rig.broker("first", rig.proxy(), FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            first.acquire(HARNESS, SESSION).requireOk();
            var reference = FaultGateRig.shell("call",
                    "echo start >> marker; while [ ! -f finish ]; do sleep 0.05; done; echo end >> marker");
            String execution = first.create(HARNESS, SESSION, "key", reference).object().getString("executionCallId");
            rig.awaitMarker(marker(rig), List.of("start"));
            var proxy = rig.proxy();
            var second = rig.broker("second", proxy, FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            second.acquire(HARNESS, SESSION).requireOk();
            // Keep the dispatch claim live through cancellation; a lapsed v2
            // claim is deliberately left UNKNOWN and does not send a cancel.
            second.cancel(HARNESS, SESSION, execution).requireOk();
            assertEquals(1, proxy.count("cancel"), "cancellation must reach the original active worker");
            rig.killBroker(first);
            rig.awaitDispatchLapse(execution);
            assertEquals(execution, second.create(HARNESS, SESSION, "key", reference).object()
                    .getString("executionCallId"));
            FaultGateRig.await(() -> second.reconcile(HARNESS, SESSION, execution).object().getString("outcome"),
                    outcome -> "RESOLVED".equals(outcome) || "ALREADY_SETTLED".equals(outcome),
                    "cancelled original call");
            assertEquals("cancelled", rig.execution(execution).getExecutionStatus());
            assertEquals(List.of("start"), rig.marker(marker(rig)));
            assertEquals(1, proxy.count("cancel"));
            assertEquals(0, proxy.count("execute"));
            second.release(HARNESS, SESSION).requireOk();
        }
    }

    @ParameterizedTest
    @EnumSource(FaultGateRig.Placement.class)
    void absentWorkerAfterRestartLeavesItsDomainPinned(FaultGateRig.Placement placement) throws Exception {
        try (var rig = FaultGateRig.open(placement)) {
            var first = rig.broker("first", rig.proxy(), FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            first.acquire(HARNESS, SESSION).requireOk();
            String execution = first.create(HARNESS, SESSION, "key", FaultGateRig.shell("call",
                    "echo start >> marker; sleep 30; echo end >> marker")).object().getString("executionCallId");
            rig.awaitMarker(marker(rig), List.of("start"));
            var original = rig.activeBinding();
            rig.killWorker(first);
            rig.killBroker(first);
            var second = rig.broker("second", rig.proxy(), FaultGateRig.Provisioner.DURABLE_LOCAL_PROCESS);
            var warm = FaultGateRig.await(() -> second.warm(HARNESS),
                    reply -> !"runtime_provision_fenced".equals(reply.code())
                            && !"runtime_broker_reconcile_timeout".equals(reply.code()),
                    "original worker loss after recovery fencing");
            assertEquals("runtime_broker_runtime_lost", warm.code(),
                    () -> warm.message() + rig.logs());
            assertEquals(ToolExecutionRecord.State.ABANDONED, rig.execution(execution).getState());
            assertEquals(original.getBindingId(), rig.activeBinding().getBindingId());
            assertNull(rig.activeBinding().getStopEvidence());
            assertTrue(second.workers().isEmpty());
            rig.holdMarker(marker(rig), List.of("start"), Duration.ofMillis(250));
        }
    }

    private static String marker(FaultGateRig rig) {
        return rig.placement == FaultGateRig.Placement.MANAGED ? "project/marker" : "marker";
    }
}
