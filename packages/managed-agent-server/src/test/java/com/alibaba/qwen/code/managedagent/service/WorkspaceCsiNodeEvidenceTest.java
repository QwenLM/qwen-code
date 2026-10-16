package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiNodeSourceStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceClient;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal;
import com.alibaba.qwen.code.runtimebroker.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.math.BigInteger;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class WorkspaceCsiNodeEvidenceTest {
    private static final String NODE_UID = "11111111-1111-4111-8111-111111111111";
    private static final String BOOT_ID = "22222222-2222-4222-8222-222222222222";
    private final WorkspaceCsiNodeSourceStore store = mock(WorkspaceCsiNodeSourceStore.class);
    private final KubernetesRuntimeClient api = mock(KubernetesRuntimeClient.class);
    private final CsiNodeSourceClient source = mock(CsiNodeSourceClient.class);
    private final CsiNodeSourceClient gateway = mock(CsiNodeSourceClient.class);

    @ParameterizedTest
    @ValueSource(strings = {"different", "missing-info", "missing-boot", "empty", "not-string"})
    void rejectsChangedOrMissingBootBeforeArmingSource(String mutation) {
        when(api.getCluster("nodes", "owned-node")).thenReturn(CompletableFuture.completedFuture(node(mutation)));
        var evidence = evidence();
        assertThatThrownBy(() -> evidence.arm(mock(RuntimeBindingRecord.class),
                mock(WorkspaceCsiReservationStore.Reservation.class), () -> {})).isInstanceOf(RuntimeBrokerException.class);
        verify(api).getCluster("nodes", "owned-node");
        verifyNoInteractions(source, gateway, store);
    }

    @Test
    void matchingBootAllowsTheOriginalSourceRead() {
        when(api.getCluster("nodes", "owned-node")).thenReturn(CompletableFuture.completedFuture(node("correct")));
        when(api.getCluster("runtimeclasses", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS))
                .thenReturn(CompletableFuture.completedFuture(runtimeClass("correct")));
        var nextStage = new IllegalStateException("source observation reached");
        when(source.observeEvidence()).thenThrow(nextStage);
        var original = mock(RuntimeBindingRecord.class);
        when(original.getBindingId()).thenReturn(NODE_UID);
        when(original.getProvisionSeed()).thenReturn(RuntimeProvisionSeed.create(NODE_UID, 1));
        var reservation = mock(WorkspaceCsiReservationStore.Reservation.class);
        when(reservation.reservationId()).thenReturn("33333333-3333-4333-8333-333333333333");
        assertThatThrownBy(() -> evidence().arm(original, reservation, () -> {})).isSameAs(nextStage);
        verify(api).getCluster("nodes", "owned-node");
        verify(api).getCluster("runtimeclasses", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS);
        verify(source).observeEvidence();
        verifyNoInteractions(gateway, store);
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "name", "handler", "version", "kind", "uid", "deleted", "grace", "overhead", "scheduling", "extra"})
    void rejectsMissingOrChangedRuntimeClassBeforeArmingSource(String mutation) {
        when(api.getCluster("nodes", "owned-node")).thenReturn(CompletableFuture.completedFuture(node("correct")));
        when(api.getCluster("runtimeclasses", KubernetesHttpRuntimeClient.CSI_RUNTIME_CLASS))
                .thenReturn(CompletableFuture.completedFuture(runtimeClass(mutation)));
        assertThatThrownBy(() -> evidence().arm(mock(RuntimeBindingRecord.class),
                mock(WorkspaceCsiReservationStore.Reservation.class), () -> {})).isInstanceOf(RuntimeBrokerException.class);
        verifyNoInteractions(source, gateway, store);
    }

    private static Map<String, Object> runtimeClass(String mutation) {
        if (mutation.equals("missing")) {
            return null;
        }
        var metadata = new LinkedHashMap<String, Object>(Map.of("name", "qwen-k2-runc-v1", "uid", NODE_UID));
        var runtime = new LinkedHashMap<String, Object>(Map.of("apiVersion", "node.k8s.io/v1", "kind", "RuntimeClass",
                "handler", "qwen-k2-runc-v1", "metadata", metadata));
        switch (mutation) {
            case "name" -> metadata.put("name", "default");
            case "handler" -> runtime.put("handler", "runc");
            case "version" -> runtime.put("apiVersion", "node.k8s.io/v1beta1");
            case "kind" -> runtime.put("kind", "Node");
            case "uid" -> metadata.put("uid", "wrong");
            case "deleted" -> metadata.put("deletionTimestamp", "2026-10-13T00:00:00Z");
            case "grace" -> metadata.put("deletionGracePeriodSeconds", 0);
            case "overhead" -> runtime.put("overhead", Map.of());
            case "scheduling" -> runtime.put("scheduling", Map.of());
            case "extra" -> runtime.put("extra", true);
            case "correct" -> { /* Leave the control input unchanged. */ }
            default -> throw new AssertionError(mutation);
        }
        return runtime;
    }

    private WorkspaceCsiNodeEvidence evidence() {
        var identity = new CsiNodeSourceJournal.SourceIdentity(NODE_UID, BOOT_ID, "a".repeat(64), BigInteger.ONE,
                10, "b".repeat(32), "c".repeat(64), BigInteger.TWO, 20);
        var node = new WorkspaceCsiNodeSourceStore.Node("owned-node", "d".repeat(32), identity,
                URI.create("https://source.example"), "spiffe://example/source", URI.create("https://gateway.example"),
                "spiffe://example/gateway", "e".repeat(64));
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "runtime", "claim", "pvc-uid",
                "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "handle", "backend", "serial", "/workspace", 1);
        return new WorkspaceCsiNodeEvidence(store, node, registration, api, source, gateway,
                "registry.example/worker@sha256:" + "a".repeat(64));
    }

    private static Map<String, Object> node(String mutation) {
        var info = new LinkedHashMap<String, Object>(Map.of("bootID", BOOT_ID));
        switch (mutation) {
            case "different" -> info.put("bootID", "44444444-4444-4444-8444-444444444444");
            case "missing-boot" -> info.clear();
            case "empty" -> info.put("bootID", "");
            case "not-string" -> info.put("bootID", 2);
            case "correct", "missing-info" -> { /* These controls need no mutation. */ }
            default -> throw new AssertionError(mutation);
        }
        var status = new LinkedHashMap<String, Object>(Map.of("conditions", List.of(Map.of("type", "Ready", "status", "True"))));
        if (!mutation.equals("missing-info")) {
            status.put("nodeInfo", info);
        }
        return Map.of("metadata", Map.of("name", "owned-node", "uid", NODE_UID), "status", status);
    }
}
