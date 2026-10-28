package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class StoreFaultGateTest {
    private static final byte[] EVENT = ("{\"managedSession\":{\"kind\":\"domain.committed\","
            + "\"payload\":{\"domain\":\"hook_execution\",\"recordRef\":{\"resourceId\":\"r1\"}}}}")
            .getBytes(StandardCharsets.UTF_8);
    private static final byte[] REGISTRATION_EVENT = ("{\"managedSession\":{\"kind\":"
            + "\"domain.committed\",\"payload\":{\"domain\":\"hook_registration\","
            + "\"recordRef\":{\"resourceId\":\"r2\"}}}}")
            .getBytes(StandardCharsets.UTF_8);

    @AfterEach
    void clear() {
        StoreFaultGate.INSTANCE.clear();
    }

    @Test
    void hookIntentPhaseSkipsThePlanMarker() {
        StoreFaultGate.INSTANCE.arm(StoreFaultGate.Phase.HOOK_INTENT, null);
        StoreFaultGate.INSTANCE.inspect(EVENT, record("__plan__", "intent"));
        assertThat(StoreFaultGate.INSTANCE.attempts()).isZero();
    }

    @Test
    void hookIntentPhaseRejectsTheHookExecution() {
        StoreFaultGate.INSTANCE.arm(StoreFaultGate.Phase.HOOK_INTENT, null);
        assertThatThrownBy(() -> StoreFaultGate.INSTANCE.inspect(
                EVENT, record("pre", "intent")))
                .isInstanceOf(IllegalStateException.class);
        assertThat(StoreFaultGate.INSTANCE.attempts()).isEqualTo(1);
    }

    @Test
    void hookDispatchPhaseSkipsThePlanMarker() {
        StoreFaultGate.INSTANCE.arm(
                StoreFaultGate.Phase.HOOK_DISPATCH_STARTED, null);
        StoreFaultGate.INSTANCE.inspect(
                EVENT, record("__plan__", "dispatch_started"));
        assertThat(StoreFaultGate.INSTANCE.attempts()).isZero();
    }

    @Test
    void hookDispatchPhaseRejectsTheHookExecution() {
        StoreFaultGate.INSTANCE.arm(
                StoreFaultGate.Phase.HOOK_DISPATCH_STARTED, null);
        assertThatThrownBy(() -> StoreFaultGate.INSTANCE.inspect(
                EVENT, record("pre", "dispatch_started")))
                .isInstanceOf(IllegalStateException.class);
        assertThat(StoreFaultGate.INSTANCE.attempts()).isEqualTo(1);
    }

    @Test
    void hookPlanSettledPhaseSkipsAnotherEventsMarker() {
        StoreFaultGate.INSTANCE.arm(
                StoreFaultGate.Phase.HOOK_PLAN_SETTLED, null);
        StoreFaultGate.INSTANCE.inspect(
                EVENT, record("__plan__", "settled", "SessionStart"));
        assertThat(StoreFaultGate.INSTANCE.attempts()).isZero();
    }

    @Test
    void hookPlanSettledPhaseRejectsThePreToolUseMarker() {
        StoreFaultGate.INSTANCE.arm(
                StoreFaultGate.Phase.HOOK_PLAN_SETTLED, null);
        assertThatThrownBy(() -> StoreFaultGate.INSTANCE.inspect(
                EVENT, record("__plan__", "settled", "PreToolUse")))
                .isInstanceOf(IllegalStateException.class);
        assertThat(StoreFaultGate.INSTANCE.attempts()).isEqualTo(1);
    }

    @Test
    void ackModeSkipsThePreCommitHookAndThrowsInAfterApply() {
        StoreFaultGate.INSTANCE.armAck(
                StoreFaultGate.Phase.HOOK_SETTLED, null);
        StoreFaultGate.INSTANCE.inspect(EVENT, record("pre", "settled"));
        assertThat(StoreFaultGate.INSTANCE.attempts()).isZero();
        assertThatThrownBy(() -> StoreFaultGate.INSTANCE.afterApply(
                EVENT, record("pre", "settled")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Store ack lost");
        assertThat(StoreFaultGate.INSTANCE.attempts()).isEqualTo(1);
    }

    @Test
    void ackModeLeavesThePlanMarkerAlone() {
        StoreFaultGate.INSTANCE.armAck(
                StoreFaultGate.Phase.HOOK_PLAN_SETTLED, null);
        StoreFaultGate.INSTANCE.afterApply(
                EVENT, record("__plan__", "settled", "SessionStart"));
        assertThat(StoreFaultGate.INSTANCE.attempts()).isZero();
    }

    @Test
    void registrationAckModeSkipsTheAdmissionCommit() {
        StoreFaultGate.INSTANCE.armAck(
                StoreFaultGate.Phase.HOOK_REGISTRATION_SETTLED, null);
        StoreFaultGate.INSTANCE.inspect(
                REGISTRATION_EVENT, registration("admitted"));
        // `inspect` skips matching while ack mode is armed, so the phase
        // predicate is only exercised through `afterApply`.
        StoreFaultGate.INSTANCE.afterApply(
                REGISTRATION_EVENT, registration("admitted"));
        assertThat(StoreFaultGate.INSTANCE.attempts()).isZero();
    }

    @Test
    void registrationAckModeThrowsAfterTheSettleLands() {
        StoreFaultGate.INSTANCE.armAck(
                StoreFaultGate.Phase.HOOK_REGISTRATION_SETTLED, null);
        StoreFaultGate.INSTANCE.inspect(
                REGISTRATION_EVENT, registration("settled"));
        assertThat(StoreFaultGate.INSTANCE.attempts()).isZero();
        assertThatThrownBy(() -> StoreFaultGate.INSTANCE.afterApply(
                REGISTRATION_EVENT, registration("settled")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Store ack lost");
        assertThat(StoreFaultGate.INSTANCE.attempts()).isEqualTo(1);
    }

    private static Function<String, StoredResource> registration(
            String state) {
        byte[] bytes = ("{\"registrationId\":\"occ-2\",\"catalogId\":\"fg13-hooks\","
                + "\"catalogRevision\":1,\"run\":{\"state\":\"" + state
                + "\",\"execution\":null}}")
                .getBytes(StandardCharsets.UTF_8);
        return id -> new StoredResource(id, "managed-hook-registration", 1,
                bytes.length, "sha256:x", bytes);
    }

    private static Function<String, StoredResource> record(
            String hookId, String execution) {
        return record(hookId, execution, "PreToolUse");
    }

    private static Function<String, StoredResource> record(
            String hookId, String execution, String eventName) {
        byte[] bytes = ("{\"hookExecutionId\":\"occ-1\",\"hookId\":\""
                + hookId + "\",\"eventName\":\"" + eventName
                + "\",\"run\":{\"execution\":\"" + execution + "\"}}")
                .getBytes(StandardCharsets.UTF_8);
        return id -> new StoredResource(id, "managed-hook-execution", 1,
                bytes.length, "sha256:x", bytes);
    }
}
