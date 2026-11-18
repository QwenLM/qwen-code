package com.alibaba.qwen.code.runtimebroker.spi;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** Explicit API operations needed for Runtime resources and their storage identity. */
public interface KubernetesRuntimeClient {
    /** Returns null only when the API authoritatively answers 404. */
    public CompletionStage<Map<String, Object>> get(String resource, String namespace, String name);

    /** Read-only cluster objects; implementations must reject unsupported resource kinds. */
    public default CompletionStage<Map<String, Object>> getCluster(String resource, String name) {
        return CompletableFuture.failedFuture(
                new UnsupportedOperationException("Cluster reads are unavailable"));
    }

    public CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body);
}
