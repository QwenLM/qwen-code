package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.function.Consumer;

final class FakeKubernetesRuntimeClient implements KubernetesRuntimeClient {
    final Map<String, Map<String, Object>> objects = new LinkedHashMap<>();
    int reads;
    int creates;
    String loseCreateReply;
    String podIp = "10.42.0.8";
    RuntimeBrokerException readFailure;
    Consumer<Map<String, Object>> podCreated = ignored -> { };

    @Override
    public synchronized CompletionStage<Map<String, Object>> get(String resource, String namespace, String name) {
        reads++;
        return readFailure == null ? CompletableFuture.completedFuture(objects.get(key(resource, namespace, name)))
                : CompletableFuture.failedFuture(readFailure);
    }

    @Override
    public synchronized CompletionStage<Map<String, Object>> create(String resource, String namespace,
            Map<String, Object> body) {
        creates++;
        Map<String, Object> object = mutable(body);
        String name = (String) map(object.get("metadata")).get("name");
        String key = key(resource, namespace, name);
        if (objects.containsKey(key)) {
            return CompletableFuture.failedFuture(new RuntimeBrokerException(409, "conflict", "Conflict", false));
        }
        map(object.get("metadata")).put("uid", resource + "-uid-" + creates);
        map(object.get("metadata")).put("resourceVersion", "1");
        if (resource.equals("pods")) {
            for (String field : List.of("hostNetwork", "hostPID", "hostIPC")) {
                if (Boolean.FALSE.equals(map(object.get("spec")).get(field))) {
                    map(object.get("spec")).remove(field);
                }
            }
            object.put("status", mutable(Map.of("phase", "Running", "podIP", podIp,
                    "containerStatuses", List.of(Map.of("name", "runtime", "restartCount", 0,
                            "ready", true, "state", Map.of("running", Map.of()))))));
        }
        objects.put(key, object);
        if (resource.equals("pods")) {
            podCreated.accept(object);
        }
        if (resource.equals(loseCreateReply)) {
            loseCreateReply = null;
            return CompletableFuture.failedFuture(new RuntimeBrokerException(503, "lost_reply", "Lost reply", true));
        }
        return CompletableFuture.completedFuture(object);
    }

    Map<String, Object> object(String resource) {
        return objects.entrySet().stream().filter(entry -> entry.getKey().startsWith(resource + "/"))
                .map(Map.Entry::getValue).findFirst().orElseThrow();
    }

    void remove(String resource) {
        objects.keySet().removeIf(key -> key.startsWith(resource + "/"));
    }

    private static String key(String resource, String namespace, String name) {
        return resource + "/" + namespace + "/" + name;
    }

    static Map<String, Object> mutable(Map<String, Object> value) {
        return JSON.parseObject(JsonCodec.encode(value));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }
}
