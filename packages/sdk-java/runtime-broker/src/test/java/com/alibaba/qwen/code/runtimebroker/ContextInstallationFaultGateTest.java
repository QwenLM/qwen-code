package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.HARNESS;
import static com.alibaba.qwen.code.runtimebroker.FaultGateRig.SESSION;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

/**
 * FG5: faults around W0c context installation. Every Broker places the
 * Session on managed-context/1 (boot v2, attestation v3) for the Workspace
 * execution profile, and acquire installs the Session's context and
 * activates its gate before a tool can run. The worker keeps installations
 * in memory only.
 */
@Tag("fault-gate")
class ContextInstallationFaultGateTest {
    private static final String NEXT_SESSION = "runtime-session-2";

    /** Which attestation of a new managed worker is lost. */
    enum Attester {
        /** The provisioner's, while it starts the worker. */
        PROVISIONER,
        /** The service's, after the provisioner handed over the lease. */
        SERVICE
    }

    /** How far acquire got when its Broker JVM died. */
    enum Window {
        /** Installed; the activation request never reached the worker. */
        INSTALLED,
        /** Activated; the worker's activation answer never came back. */
        ACTIVATED
    }

    private FaultGateRig rig;

    @BeforeEach
    void openRig() throws Exception {
        rig = FaultGateRig.open(FaultGateRig.Placement.MANAGED);
    }

    @AfterEach
    void closeRig() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    @Test
    void aControlRunInstallsTheContextAndRunsInItsDirectory()
            throws Exception {
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);

        warm(broker);
        broker.acquire(HARNESS, SESSION).requireOk();
        String execution = create(broker, SESSION);

        rig.awaitExecution(execution, ToolExecutionRecord::isSettled,
                "settled execution");
        assertEquals("success", rig.execution(execution)
                .getExecutionStatus());
        assertEquals(List.of(rig.directory.toString()), rig.runs());
        // Warm attests the new worker twice (provisioner, then service),
        // and acquire re-attests it once.
        assertEquals(3, proxy.count("attest"));
        assertEquals(1, proxy.count("context"));
        assertEquals(1, proxy.count("activation"));
        assertEquals(1, proxy.count("execute"));
        int beforeRelease = proxy.exchanges().size();
        assertEquals(Boolean.TRUE, broker.release(HARNESS, SESSION).requireOk().value());
        assertEquals(List.of("control", "activation"), proxy.exchanges().stream()
                .skip(beforeRelease).map(FaultProxy.Exchange::operation).toList());
    }

    @ParameterizedTest
    @EnumSource(value = FaultProxy.Action.class,
            names = {"DROP", "RESET", "DELAY"})
    void aLostInstallationAnswerIsReplayedUnderTheSameOperation(
            FaultProxy.Action loss) throws Exception {
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);
        warm(broker);
        proxy.schedule("context", loss == FaultProxy.Action.DELAY
                ? FaultProxy.Fault.delay(FaultGateRig.REQUEST_TIMEOUT
                        .plusSeconds(3))
                : FaultProxy.Fault.of(loss));

        // The worker installed the context, but no receipt came back, so
        // acquire fails retryably and the Session cannot run a tool yet.
        BrokerProcess.Reply lost = broker.acquire(HARNESS, SESSION);
        assertFalse(lost.ok(), loss + " installation acquired the Session");
        assertEquals("managed_runtime_unavailable", lost.code());
        assertTrue(lost.retryable());
        assertEquals(0, proxy.count("activation"));
        assertFalse(broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell("call-1", rig.recordRun())).ok());
        assertEquals(0, proxy.count("execute"));

        // The worker recorded the installation although its answer was
        // lost. With the context directory moved away, only a replay of
        // that recorded operation succeeds; a new installation would verify
        // the directory and be refused.
        Path away = moveContextAway();
        broker.acquire(HARNESS, SESSION).requireOk();
        assertEquals(2, proxy.count("context"));
        assertEquals(1, proxy.count("activation"));
        assertNewInstallationRefused(broker);
        Files.move(away, rig.directory);
        String execution = create(broker, SESSION);
        rig.awaitExecution(execution, ToolExecutionRecord::isSettled,
                "settled execution");
        assertEquals("success", rig.execution(execution)
                .getExecutionStatus());
        assertEquals(List.of(rig.directory.toString()), rig.runs());
        assertEquals(1, proxy.count("execute"));
    }

    @Test
    void aLostActivationAnswerIsRetriedAgainstTheSameGate()
            throws Exception {
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);
        warm(broker);
        proxy.schedule("activation", FaultProxy.Action.DROP);

        BrokerProcess.Reply lost = broker.acquire(HARNESS, SESSION);
        assertFalse(lost.ok(), "a lost activation acquired the Session");
        assertEquals("managed_runtime_unavailable", lost.code());
        assertTrue(lost.retryable());
        assertFalse(broker.create(HARNESS, SESSION, "key-1",
                FaultGateRig.shell("call-1", rig.recordRun())).ok());
        assertEquals(0, proxy.count("execute"));

        // The retry replays the recorded installation, which needs no
        // directory, and repeats the idempotent activation.
        Path away = moveContextAway();
        broker.acquire(HARNESS, SESSION).requireOk();
        assertEquals(2, proxy.count("context"));
        assertEquals(2, proxy.count("activation"));
        assertNewInstallationRefused(broker);
        Files.move(away, rig.directory);
        String execution = create(broker, SESSION);
        rig.awaitExecution(execution, ToolExecutionRecord::isSettled,
                "settled execution");
        assertEquals("success", rig.execution(execution)
                .getExecutionStatus());
        assertEquals(List.of(rig.directory.toString()), rig.runs());
        assertEquals(1, proxy.count("execute"));
    }

    @ParameterizedTest
    @EnumSource(Attester.class)
    void aLostManagedAttestationBlocksRecoveryWithoutARelaunch(
            Attester attester) throws Exception {
        FaultProxy proxy = rig.proxy();
        if (attester == Attester.SERVICE) {
            proxy.schedule("attest", FaultProxy.Action.PASS);
        }
        proxy.schedule("attest", FaultProxy.Action.DROP);
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);

        // Unlike boot v1, a managed startup that cannot be proven is not
        // retried: the binding is blocked and the unproven worker stopped.
        BrokerProcess.Reply failed = broker.warm(HARNESS);
        assertFalse(failed.ok(), "an unattested managed worker became READY");
        assertFalse(failed.retryable());
        if (attester == Attester.PROVISIONER) {
            assertEquals("runtime_provision_failed", failed.code());
        } else {
            assertEquals(409, failed.status());
            assertEquals("runtime_broker_recovery_blocked", failed.code());
        }
        RuntimeBindingRecord blocked = rig.activeBinding();
        assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                blocked.getState());
        assertNull(blocked.getLease());
        FaultGateRig.await(broker::workers, List::isEmpty,
                "the unattested worker to stop");

        long attested = proxy.count("attest");
        assertBlocked(broker.warm(HARNESS));
        assertBlocked(broker.acquire(HARNESS, SESSION));
        assertEquals(attested, proxy.count("attest"));
        assertEquals(0, proxy.count("context"));
        assertTrue(broker.workers().isEmpty());
    }

    @Test
    void aBrokerKilledDuringManagedStartupStaysBlockedAfterRestart()
            throws Exception {
        FaultProxy firstProxy = rig.proxy();
        FaultProxy.Fault held = firstProxy.schedule("attest",
                FaultProxy.Action.HOLD_RESPONSE);
        BrokerProcess first = rig.broker("first", firstProxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);
        CompletableFuture<BrokerProcess.Reply> warming =
                CompletableFuture.supplyAsync(() -> first.warm(HARNESS));
        held.awaitHeld(FaultGateRig.WAIT);

        rig.killBroker(first);
        held.release(FaultProxy.Action.RESET);
        warming.handle((reply, error) -> null).get(FaultGateRig.WAIT
                .toMillis(), TimeUnit.MILLISECONDS);
        FaultProxy secondProxy = rig.proxy();
        BrokerProcess second = rig.broker("second", secondProxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);

        // The started worker may be running a Session nobody can prove, so
        // the restarted Broker blocks the binding instead of relaunching,
        // once the dead Broker's startup claim has lapsed.
        BrokerProcess.Reply blocked = FaultGateRig.await(
                () -> second.warm(HARNESS),
                reply -> !"runtime_provisioning_in_progress".equals(
                        reply.code()),
                "the dead Broker's startup claim to lapse");
        assertBlocked(blocked);
        assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                rig.activeBinding().getState());
        assertBlocked(second.warm(HARNESS));
        assertBlocked(second.acquire(HARNESS, SESSION));
        assertTrue(second.workers().isEmpty());
        assertEquals(0, secondProxy.count("attest"));
        assertEquals(0, secondProxy.count("context"));
    }

    @Test
    void aLostManagedWorkerKeepsItsContextAndWriterDomainPinned()
            throws Exception {
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);
        warm(broker);
        broker.acquire(HARNESS, SESSION).requireOk();
        RuntimeBindingRecord dead = rig.activeBinding();

        rig.killWorker(broker);

        assertFalse(broker.warm(HARNESS).ok());
        var warm = FaultGateRig.await(
                () -> broker.warm(HARNESS),
                reply -> !"runtime_provision_fenced".equals(reply.code())
                        && !"runtime_broker_reconcile_timeout".equals(reply.code()),
                "managed worker loss after recovery fencing");
        assertEquals("runtime_broker_runtime_lost", warm.code(),
                () -> warm.message() + rig.logs());
        assertEquals(dead.getBindingId(), rig.activeBinding().getBindingId());
        assertEquals(RuntimeBindingRecord.State.LOST, rig.activeBinding().getState());
        assertNull(rig.activeBinding().getStopEvidence());
        assertFalse(broker.acquire(HARNESS, NEXT_SESSION).ok());
        assertFalse(broker.release(HARNESS, SESSION).ok());
        assertEquals(1, proxy.count("context"));
        assertEquals(0, proxy.count("execute"));
        assertTrue(broker.workers().isEmpty());
        assertTrue(rig.runs().isEmpty());
    }

    @ParameterizedTest
    @EnumSource(Window.class)
    void aRestartedBrokerReplaysTheInstallationOnTheAdoptedWorker(
            Window window) throws Exception {
        FaultProxy firstProxy = rig.proxy();
        FaultProxy.Fault held = firstProxy.schedule("activation",
                window == Window.INSTALLED ? FaultProxy.Action.HOLD_REQUEST
                        : FaultProxy.Action.HOLD_RESPONSE);
        BrokerProcess first = rig.broker("first", firstProxy,
                FaultGateRig.Provisioner.RECOVERABLE);
        warm(first);
        CompletableFuture<BrokerProcess.Reply> acquiring =
                CompletableFuture.supplyAsync(
                        () -> first.acquire(HARNESS, SESSION));
        held.awaitHeld(FaultGateRig.WAIT);
        RuntimeBindingRecord before = rig.activeBinding();

        rig.killBroker(first);
        held.release(FaultProxy.Action.RESET);
        acquiring.handle((reply, error) -> null).get(FaultGateRig.WAIT
                .toMillis(), TimeUnit.MILLISECONDS);
        if (window == Window.INSTALLED) {
            // An installed Session that was never activated runs nothing.
            assertRefused(before.getLease(), SESSION);
        }
        FaultProxy secondProxy = rig.proxy();
        BrokerProcess second = rig.broker("second", secondProxy,
                FaultGateRig.Provisioner.RECOVERABLE);
        // The adopted worker still holds the installation: with the context
        // directory moved away, only a replay of it succeeds.
        Path away = moveContextAway();
        second.acquire(HARNESS, SESSION).requireOk();

        // The worker is re-proved before reuse.
        assertEquals(2, secondProxy.count("attest"));
        assertEquals(1, secondProxy.count("context"));
        assertEquals(1, secondProxy.count("activation"));
        assertNewInstallationRefused(second);
        Files.move(away, rig.directory);
        RuntimeBindingRecord adopted = rig.activeBinding();
        assertEquals(before.getBindingId(), adopted.getBindingId());
        assertEquals(before.getGeneration(), adopted.getGeneration());
        assertEquals(before.getLease().getEndpoint(),
                adopted.getLease().getEndpoint());
        assertTrue(second.workers().isEmpty());

        String execution = create(second, SESSION);
        rig.awaitExecution(execution, ToolExecutionRecord::isSettled,
                "settled execution");
        assertEquals("success", rig.execution(execution)
                .getExecutionStatus());
        assertEquals(List.of(rig.directory.toString()), rig.runs());
        assertEquals(1, secondProxy.count("execute"));
    }

    @Test
    void aRemovedContextDirectoryIsRefusedWithoutAFallback()
            throws Exception {
        FaultProxy proxy = rig.proxy();
        BrokerProcess broker = rig.broker("broker", proxy,
                FaultGateRig.Provisioner.LOCAL_PROCESS);
        warm(broker);
        broker.acquire(HARNESS, SESSION).requireOk();

        Files.delete(rig.directory);
        String execution = create(broker, SESSION);

        // The worker refuses the call before it starts. The transport
        // reports that refusal as 409 managed_context_unavailable, but
        // dispatch records every failed execute as UNKNOWN, and the worker,
        // which never recorded the call, has no evidence to settle it with.
        rig.awaitExecution(execution, record -> record.getState()
                == ToolExecutionRecord.State.UNKNOWN, "UNKNOWN execution");
        JSONObject lookup = broker.reconcile(HARNESS, SESSION, execution)
                .object();
        assertEquals("UNRESOLVED", lookup.getString("outcome"));
        assertEquals("unknown", lookup.getString("runtimeState"));
        ToolExecutionRecord unknown = rig.execution(execution);
        assertEquals(ToolExecutionRecord.State.UNKNOWN, unknown.getState());
        assertNull(unknown.getResult());
        assertEquals(1, proxy.count("execute"));
        assertRefused(rig.activeBinding().getLease(), SESSION);
        // The tool ran nowhere: not in the mount root, not in the worker's
        // own directory.
        FaultGateRig.hold(rig::runs, List::isEmpty, Duration.ofSeconds(2),
                "runs");

        // Nor is the Session closed: once the directory is back, its next
        // call runs. The W0c designs say this refusal keeps the Session's
        // tool gate closed and blocks its context for recovery.
        Files.createDirectory(rig.directory);
        String next = broker.create(HARNESS, SESSION, "key-2",
                FaultGateRig.shell("call-2", rig.recordRun())).object()
                .getString("executionCallId");
        rig.awaitExecution(next, ToolExecutionRecord::isSettled,
                "settled execution");
        assertEquals("success", rig.execution(next).getExecutionStatus());
        assertEquals(List.of(rig.directory.toString()), rig.runs());
        assertEquals(ToolExecutionRecord.State.UNKNOWN,
                rig.execution(execution).getState());
    }

    /** A tool of the Session, sent straight to the worker, is refused. */
    private void assertRefused(RuntimeLease lease, String session) {
        FaultGateRig.ToolCall call = FaultGateRig.shell(session, "stray", rig.recordRun());
        ExecutionException refused = assertThrows(ExecutionException.class,
                () -> new HttpRuntimeTransport().execute(lease,
                        new RuntimeSession(HARNESS, session, "bootstrap",
                                rig.scope),
                        call.reference(), JSON.parseObject(call.payloadJson()))
                        .toCompletableFuture().get(30, TimeUnit.SECONDS));
        RuntimeBrokerException refusal =
                (RuntimeBrokerException) refused.getCause();
        assertEquals(409, refusal.getStatusCode());
        assertEquals("managed_context_unavailable", refusal.getCode());
        assertTrue(rig.runs().isEmpty());
    }

    /**
     * While the context directory is away, a new installation, here for
     * another Runtime Session, verifies the directory and is refused.
     */
    private static void assertNewInstallationRefused(BrokerProcess broker) {
        BrokerProcess.Reply fresh = broker.acquire(HARNESS, NEXT_SESSION);
        assertFalse(fresh.ok(), "a new installation verified a missing "
                + "directory");
        assertEquals(409, fresh.status());
        assertEquals("managed_context_unavailable", fresh.code());
    }

    /** Moves the context directory where no installation can verify it. */
    private Path moveContextAway() throws IOException {
        return Files.move(rig.directory,
                rig.directory.resolveSibling("project.away"));
    }

    private static void assertBlocked(BrokerProcess.Reply reply) {
        assertFalse(reply.ok(), "a blocked binding was used");
        assertEquals(409, reply.status());
        assertEquals("runtime_broker_recovery_blocked", reply.code());
        assertFalse(reply.retryable());
    }

    private void warm(BrokerProcess broker) {
        assertEquals("READY", broker.warm(HARNESS).object()
                .getString("state"), rig.logs());
    }

    private String create(BrokerProcess broker, String session) {
        return broker.create(HARNESS, session, "key-" + session,
                FaultGateRig.shell(session, "call-" + session,
                        rig.recordRun())).object()
                .getString("executionCallId");
    }
}
