package com.alibaba.qwen.code.runtimebroker;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

/**
 * HTTP adapter for the Managed Runtime worker routes.
 *
 * <p>The attestation route enforces a bounded response body, a stage
 * deadline, and caller-driven cancellation. Prepare, execute, cancel, and
 * release keep the existing worker-route contract.
 */
public final class HttpRuntimeTransport implements RuntimeTransport {
    static final int BODY_LIMIT_BYTES = 16 * 1024;
    static final String PATH = "/internal/managed-runtime/v2/attest";
    private static final Duration ATTESTATION_TIMEOUT = Duration.ofSeconds(30);
    private static final Set<String> RESPONSE_FIELDS = Set.of(
            "protocolVersion", "runtimeInstanceId", "runtimeIncarnation",
            "leaseId", "epoch", "provisionRequestId", "tenantId",
            "workspaceId", "workspaceGeneration", "workspaceCwd",
            "capabilityDigest", "isolationClass");
    private static final int MAXIMUM_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final Duration REQUEST_TIMEOUT = Duration.ofMinutes(10);
    private final HttpClient client;
    private final Duration attestationTimeout;

    public HttpRuntimeTransport() {
        this(HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(5))
                .build(), ATTESTATION_TIMEOUT);
    }

    public HttpRuntimeTransport(HttpClient client) {
        this(client, ATTESTATION_TIMEOUT);
    }

    HttpRuntimeTransport(HttpClient client, Duration attestationTimeout) {
        if (client == null) {
            throw new IllegalArgumentException("client is required");
        }
        if (attestationTimeout == null || attestationTimeout.isNegative()
                || attestationTimeout.isZero()) {
            throw new IllegalArgumentException(
                    "attestationTimeout is required");
        }
        this.client = client;
        this.attestationTimeout = attestationTimeout;
    }

    @Override
    public CompletionStage<RuntimeAttestation> attest(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        if (lease == null || request == null || seed == null) {
            throw new IllegalArgumentException(
                    "lease, request, and seed are required");
        }
        if (!seed.matches(lease)) {
            throw new IllegalArgumentException(
                    "seed must bind the lease");
        }
        RuntimeScope scope = request.getScope();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 2);
        body.put("provisionRequestId", seed.getProvisionRequestId());
        body.put("tenantId", scope.getTenantId());
        body.put("workspaceId", scope.getWorkspaceId());
        body.put("workspaceGeneration", scope.getWorkspaceGeneration());
        body.put("workspaceCwd", scope.getCanonicalCwd());
        body.put("capabilityDigest", scope.getCapabilityDigest());
        body.put("isolationClass", scope.getIsolationClass());
        CompletableFuture<RuntimeAttestation> result =
                new CompletableFuture<>();
        CompletableFuture<HttpResponse<BoundedBody>> exchange = client
                .sendAsync(request(lease, body),
                        info -> new BoundedBodySubscriber(BODY_LIMIT_BYTES));
        exchange.whenComplete((response, error) -> {
            if (error != null) {
                result.completeExceptionally(unavailable(unwrap(error)));
                return;
            }
            try {
                result.complete(parse(response, response.body(), lease,
                        request, seed));
            } catch (RuntimeException exception) {
                result.completeExceptionally(exception);
            }
        });
        CompletableFuture<RuntimeAttestation> returned = result
                .orTimeout(attestationTimeout.toMillis(), TimeUnit.MILLISECONDS)
                .handle((value, error) -> {
                    if (error == null) {
                        return value;
                    }
                    Throwable cause = unwrap(error);
                    if (cause instanceof RuntimeBrokerException failure) {
                        throw failure;
                    }
                    throw unavailable(cause);
                });
        returned.whenComplete((value, error) -> {
            if (error != null || returned.isCancelled()) {
                exchange.cancel(true);
                result.cancel(false);
            }
        });
        return returned;
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
    public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        if (afterSequence < 0) {
            throw new IllegalArgumentException(
                    "afterSequence must be non-negative");
        }
        Map<String, Object> body = baseRequest(session, 2);
        body.put("reference", reference);
        body.put("afterSeq", afterSequence);
        return post(lease, "/internal/managed-runtime/v2/status", body)
                .thenApply(response -> result(response, "status"));
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
        CompletableFuture<Map<String, Object>> result =
                new CompletableFuture<>();
        client.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                .whenComplete((response, error) -> {
                    if (error != null) {
                        result.completeExceptionally(unavailable(error));
                        return;
                    }
                    byte[] bytes = response.body();
                    if (bytes.length > MAXIMUM_RESPONSE_BYTES) {
                        result.completeExceptionally(unavailable(
                                "Managed Runtime response exceeded its "
                                        + "limit."));
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

    private static Throwable unwrap(Throwable error) {
        Throwable cause = error;
        while (cause instanceof CompletionException
                && cause.getCause() != null) {
            cause = cause.getCause();
        }
        return cause;
    }

    static String classificationFor(int status) {
        if (status == 200) {
            return "ok";
        }
        if (status == 401 || status == 403) {
            return "credentials";
        }
        if (status == 400 || status == 413) {
            return "protocol";
        }
        if (status == 409) {
            return "identity";
        }
        if (status == 404 || status == 405) {
            return "incompatible";
        }
        return "incompatible";
    }

    private HttpRequest request(RuntimeLease lease, Map<String, Object> body) {
        URI target = lease.getEndpoint().resolve(PATH);
        return HttpRequest.newBuilder(target)
                .timeout(attestationTimeout)
                .header("Authorization", "Bearer " + lease.getToken())
                .header("Cache-Control", "no-store")
                .header("Content-Type", "application/json")
                .header("X-Qwen-Managed-Lease-Id", lease.getLeaseId())
                .header("X-Qwen-Managed-Lease-Epoch",
                        Long.toString(lease.getEpoch()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(
                        JsonCodec.encode(body)))
                .build();
    }

    private static RuntimeAttestation parse(HttpResponse<BoundedBody> response,
            BoundedBody body, RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        int status = response.statusCode();
        if (body.overflow()) {
            if (status >= 500) {
                throw failure(status);
            }
            throw tooLarge();
        }
        byte[] bytes = body.bytes();
        if (status != 200) {
            throw failure(status);
        }
        String cacheControl = response.headers()
                .firstValue("Cache-Control").orElse("");
        String contentType = response.headers()
                .firstValue("Content-Type").orElse("");
        if (!"no-store".equals(cacheControl)
                || !jsonContentType(contentType)) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
        Map<String, Object> fields;
        try {
            fields = JsonCodec.parseObject(bytes,
                    "Managed Runtime attestation");
        } catch (RuntimeBrokerException exception) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
        if (!fields.keySet().equals(RESPONSE_FIELDS)) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
        requireProtocol(fields);
        RuntimeAttestation attestation = readAttestation(fields);
        if (!matches(attestation, lease, request, seed)) {
            throw conflict(
                    "Managed Runtime attestation identity conflicts.");
        }
        return attestation;
    }

    private static RuntimeAttestation readAttestation(
            Map<String, Object> fields) {
        try {
            RuntimeScope scope = new RuntimeScope(
                    JsonCodec.requiredString(fields, "tenantId",
                            "attestation"),
                    JsonCodec.requiredString(fields, "workspaceId",
                            "attestation"),
                    JsonCodec.requiredString(fields, "workspaceGeneration",
                            "attestation"),
                    JsonCodec.requiredString(fields, "workspaceCwd",
                            "attestation"),
                    JsonCodec.requiredString(fields, "capabilityDigest",
                            "attestation"),
                    JsonCodec.requiredString(fields, "isolationClass",
                            "attestation"));
            return new RuntimeAttestation(
                    JsonCodec.requiredString(fields, "runtimeInstanceId",
                            "attestation"),
                    JsonCodec.requiredString(fields, "runtimeIncarnation",
                            "attestation"),
                    JsonCodec.requiredString(fields, "leaseId",
                            "attestation"),
                    requiredPositiveLong(fields, "epoch"),
                    scope,
                    JsonCodec.requiredString(fields, "provisionRequestId",
                            "attestation"));
        } catch (RuntimeBrokerException | IllegalArgumentException exception) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
    }

    /**
     * The preview broker accepts a proof only when the seed's gateway
     * incarnation is the runtime incarnation echoed by attestation.
     */
    private static boolean matches(RuntimeAttestation attestation,
            RuntimeLease lease, RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
        return lease.getRuntimeInstanceId().equals(
                        attestation.getRuntimeInstanceId())
                && seed.getGatewayIncarnation().equals(
                        attestation.getRuntimeIncarnation())
                && lease.getLeaseId().equals(attestation.getLeaseId())
                && lease.getEpoch() == attestation.getEpoch()
                && request.getScope().equals(attestation.getScope())
                && seed.getProvisionRequestId().equals(
                        attestation.getProvisionRequestId());
    }

    private static void requireProtocol(Map<String, Object> response) {
        Object raw = response.get("protocolVersion");
        if (!(raw instanceof Number number)
                || number.longValue() != 2
                || number.doubleValue() != 2) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
    }

    private static long requiredPositiveLong(Map<String, Object> response,
            String field) {
        Object value = response.get(field);
        if (!(value instanceof Number number)) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
        long parsed = number.longValue();
        if (number.doubleValue() != parsed || parsed <= 0) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
        return parsed;
    }

    private static boolean jsonContentType(String value) {
        String[] parts = value.split(";");
        if (!"application/json".equalsIgnoreCase(parts[0].trim())) {
            return false;
        }
        for (int index = 1; index < parts.length; index++) {
            if (!"charset=utf-8".equalsIgnoreCase(parts[index].trim())) {
                return false;
            }
        }
        return true;
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
        Object raw = response.get("protocolVersion");
        if (!(raw instanceof Number)) {
            throw unavailable("Managed Runtime protocol version changed.");
        }
        Number number = (Number) raw;
        if (number.longValue() != expected
                || number.doubleValue() != expected) {
            throw unavailable("Managed Runtime protocol version changed.");
        }
    }

    private static RuntimeBrokerException failure(int status) {
        String classification = classificationFor(status);
        if ("credentials".equals(classification)) {
            return error(status, "managed_runtime_unauthorized",
                    "Managed Runtime credentials are invalid.", false);
        }
        if ("protocol".equals(classification)) {
            if (status == 413) {
                return tooLarge();
            }
            return protocol(
                    "Managed Runtime attestation response is invalid.");
        }
        if ("identity".equals(classification)) {
            return conflict(
                    "Managed Runtime attestation identity conflicts.");
        }
        if (status == 404 || status == 405) {
            return error(status, "managed_runtime_incompatible",
                    "Managed Runtime attestation endpoint is incompatible.",
                    false);
        }
        if (status >= 500) {
            return error(status, "managed_runtime_unavailable",
                    "Managed Runtime attestation endpoint is unavailable.",
                    true);
        }
        return error(502, "managed_runtime_incompatible",
                "Managed Runtime attestation endpoint is incompatible.",
                false);
    }

    private static RuntimeBrokerException tooLarge() {
        return error(413, "managed_runtime_attestation_too_large",
                "Managed Runtime attestation response exceeds 16 KiB.",
                false);
    }

    private static RuntimeBrokerException protocol(String message) {
        return error(400, "managed_runtime_attestation_invalid", message,
                false);
    }

    private static RuntimeBrokerException conflict(String message) {
        return error(409, "managed_runtime_identity_conflict", message,
                false);
    }

    private static RuntimeBrokerException unavailable(Throwable cause) {
        return new RuntimeBrokerException(503, "managed_runtime_unavailable",
                "Managed Runtime request failed.", true, cause);
    }

    private static RuntimeBrokerException unavailable(String message) {
        return new RuntimeBrokerException(503, "managed_runtime_unavailable",
                message, true);
    }

    private static RuntimeBrokerException error(int status, String code,
            String message, boolean retryable) {
        return new RuntimeBrokerException(status, code, message, retryable);
    }

    private static final class BoundedBody {
        private final byte[] bytes;
        private final boolean overflow;

        private BoundedBody(byte[] bytes, boolean overflow) {
            this.bytes = bytes;
            this.overflow = overflow;
        }

        private byte[] bytes() {
            return bytes;
        }

        private boolean overflow() {
            return overflow;
        }
    }

    /**
     * Stops reading once the cap is crossed. A body that stalls after the
     * response headers is bounded by the stage deadline ({@code orTimeout}),
     * not by {@code HttpRequest.timeout}.
     */
    private static final class BoundedBodySubscriber
            implements HttpResponse.BodySubscriber<BoundedBody> {
        private final int limit;
        private final byte[] bytes;
        private int size;
        private final CompletableFuture<BoundedBody> body =
                new CompletableFuture<>();
        private Flow.Subscription subscription;

        private BoundedBodySubscriber(int limit) {
            this.limit = limit;
            this.bytes = new byte[limit];
        }

        @Override
        public CompletionStage<BoundedBody> getBody() {
            return body;
        }

        @Override
        public void onSubscribe(Flow.Subscription newSubscription) {
            if (subscription != null) {
                newSubscription.cancel();
                return;
            }
            subscription = newSubscription;
            newSubscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            if (body.isDone()) {
                return;
            }
            for (ByteBuffer buffer : buffers) {
                int remaining = limit - size;
                if (buffer.remaining() > remaining) {
                    copy(buffer, remaining);
                    subscription.cancel();
                    body.complete(new BoundedBody(copyOf(size), true));
                    return;
                }
                copy(buffer, buffer.remaining());
            }
        }

        @Override
        public void onError(Throwable throwable) {
            body.completeExceptionally(throwable);
        }

        @Override
        public void onComplete() {
            body.complete(new BoundedBody(copyOf(size), false));
        }

        private void copy(ByteBuffer buffer, int count) {
            if (count <= 0) {
                return;
            }
            byte[] chunk = new byte[count];
            buffer.get(chunk);
            System.arraycopy(chunk, 0, bytes, size, count);
            size += count;
        }

        private byte[] copyOf(int length) {
            byte[] payload = new byte[length];
            System.arraycopy(bytes, 0, payload, 0, length);
            return payload;
        }
    }
}
