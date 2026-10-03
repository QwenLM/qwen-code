package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.concurrent.CompletionStage;

/** Explicit API operations needed for Session-exclusive scratch Runtime resources. */
public interface KubernetesRuntimeClient {
    /** Returns null only when the API authoritatively answers 404. */
    CompletionStage<Map<String, Object>> get(String resource, String namespace, String name);

    CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body);
}
