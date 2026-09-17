package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** HTTP adapter for the existing Managed Runtime v1/v2 worker routes. */
public final class HttpRuntimeTransport implements RuntimeTransport {
    private static final int MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final Duration REQUEST_TIMEOUT = Duration.ofMinutes(10);
    private final HttpClient client;

    public HttpRuntimeTransport() {
        this(HttpClient.newBuilder().followRedirects(
                HttpClient.Redirect.NEVER).build());
    }

    public HttpRuntimeTransport(HttpClient client) {
        if (client == null) {
            throw new IllegalArgumentException("client is required");
        }
        this.client = client;
    }

    @Override
    public CompletionStage<Void> acquire(RuntimeLease lease,
            RuntimeSession session) {
        return post(lease, "/internal/managed-runtime/v1/prepare",
                baseRequest(session, 1)).thenApply(response -> {
                    requireProtocol(response, 1);
                    if (!Boolean.TRUE.equals(response.get("ready"))) {
                        throw unavailable("Managed Runtime is not ready.");
                    }
                    return null;
                });
    }

    @Override
    public CompletionStage<Object> control(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> operation) {
        String kind = JsonCodec.requiredString(operation, "kind",
                "operation");
        Map<String, Object> body = baseRequest(session, 2);
        for (Map.Entry<String, Object> entry : operation.entrySet()) {
            if (!"kind".equals(entry.getKey())) {
                body.put(entry.getKey(), entry.getValue());
            }
        }
        return post(lease, "/internal/managed-runtime/v2/" + kind, body)
                .thenApply(response -> {
                    requireProtocol(response, 2);
                    if (!response.containsKey("result")) {
                        throw unavailable(
                                "Managed Runtime omitted control result.");
                    }
                    return response.get("result");
                });
    }

    @Override
    public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        Map<String, Object> body = baseRequest(session, 2);
        body.put("reference", reference);
        return post(lease, "/internal/managed-runtime/v2/execute", body)
                .thenApply(response -> result(response, "execution"));
    }

    @Override
    public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        Map<String, Object> body = baseRequest(session, 2);
        body.put("reference", reference);
        return post(lease, "/internal/managed-runtime/v2/cancel", body)
                .thenApply(response -> result(response, "cancellation"));
    }

    @Override
    public CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session) {
        return post(lease, "/internal/managed-runtime/v2/release",
                baseRequest(session, 2)).thenApply(response -> {
                    requireProtocol(response, 2);
                    return Boolean.TRUE.equals(response.get("released"));
                });
    }

    private CompletionStage<Map<String, Object>> post(RuntimeLease lease,
            String path, Map<String, Object> body) {
        URI target = lease.getEndpoint().resolve(path);
        HttpRequest request = HttpRequest.newBuilder(target)
                .timeout(REQUEST_TIMEOUT)
                .header("Authorization", "Bearer " + lease.getToken())
                .header("Content-Type", "application/json")
                .header("X-Qwen-Managed-Lease-Id", lease.getLeaseId())
                .header("X-Qwen-Managed-Lease-Epoch",
                        Long.toString(lease.getEpoch()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(
                        JsonCodec.encode(body)))
                .build();
        CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                .whenComplete((response, error) -> {
                    if (error != null) {
                        result.completeExceptionally(unavailable(
                                "Managed Runtime request failed."));
                        return;
                    }
                    byte[] bytes = response.body();
                    if (bytes.length > MAXIMUM_RESPONSE_BYTES) {
                        result.completeExceptionally(unavailable(
                                "Managed Runtime response exceeded its limit."));
                        return;
                    }
                    if (response.statusCode() < 200
                            || response.statusCode() >= 300) {
                        result.completeExceptionally(unavailable(
                                "Managed Runtime returned HTTP "
                                        + response.statusCode() + "."));
                        return;
                    }
                    try {
                        result.complete(JsonCodec.parseObject(bytes,
                                "Managed Runtime response"));
                    } catch (RuntimeException exception) {
                        result.completeExceptionally(unavailable(
                                "Managed Runtime returned invalid JSON."));
                    }
                });
        return result;
    }

    private static Map<String, Object> baseRequest(RuntimeSession session,
            int protocolVersion) {
        RuntimeScope scope = session.getScope();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", protocolVersion);
        body.put("tenantId", scope.getTenantId());
        body.put("workspaceId", scope.getWorkspaceId());
        body.put("workspaceCwd", scope.getCanonicalCwd());
        body.put("sessionId", session.getRuntimeSessionId());
        body.put("turnKind", session.getTurnKind());
        return body;
    }

    private static Map<String, Object> result(Map<String, Object> response,
            String operation) {
        requireProtocol(response, 2);
        Object value = response.get("result");
        if (!(value instanceof Map)) {
            throw unavailable("Managed Runtime returned an invalid "
                    + operation + " result.");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> cast = (Map<String, Object>) value;
        return BrokerValues.immutableMap(cast);
    }

    private static void requireProtocol(Map<String, Object> response,
            int expected) {
        if (!(response.get("protocolVersion") instanceof Number)
                || ((Number) response.get("protocolVersion")).intValue()
                        != expected) {
            throw unavailable("Managed Runtime protocol version changed.");
        }
    }

    private static RuntimeBrokerException unavailable(String message) {
        return new RuntimeBrokerException(503, "managed_runtime_unavailable",
                message, true);
    }
}
