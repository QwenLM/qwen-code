package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/** Minimal Kubernetes core-v1 boundary used by the Runtime provisioner. */
public interface KubernetesRuntimeClient {
    CompletionStage<Map<String, Object>> getSecret(String namespace,
            String name);

    CompletionStage<Map<String, Object>> createSecret(String namespace,
            String name, Map<String, Object> body);

    CompletionStage<Map<String, Object>> getPod(String namespace,
            String name);

    CompletionStage<Map<String, Object>> createPod(String namespace,
            String name, Map<String, Object> body);

    CompletionStage<Void> deleteSecret(String namespace, String name,
            String uid, String resourceVersion);

    CompletionStage<Void> deletePod(String namespace, String name,
            String uid, String resourceVersion);
}
