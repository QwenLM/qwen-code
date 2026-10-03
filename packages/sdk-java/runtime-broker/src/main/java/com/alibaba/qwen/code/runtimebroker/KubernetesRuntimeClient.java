package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/** Explicit API operations needed for Runtime resources and their storage identity. */
public interface KubernetesRuntimeClient {
    /** Returns null only when the API authoritatively answers 404. */
    CompletionStage<Map<String, Object>> get(String resource, String namespace, String name);

    /** Read-only cluster objects; implementations must reject unsupported resource kinds. */
    default CompletionStage<Map<String, Object>> getCluster(String resource, String name) {
        return java.util.concurrent.CompletableFuture.failedFuture(
                new UnsupportedOperationException("Cluster reads are unavailable"));
    }

    CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body);

    /** Bounded current log segment; rotation and kubelet container selection are not proven here. */
    default CompletionStage<String> readCsiPodLog(String podName) {
        return java.util.concurrent.CompletableFuture.failedFuture(
                new UnsupportedOperationException("CSI log reads are unavailable"));
    }
}
