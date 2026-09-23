package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/**
 * Attestation half of the preview Managed Runtime HTTP adapter.
 *
 * <p>Prepare, execute, cancel, and release stay on the later transport slice.
 * This slice talks only to the merged attestation route.
 */
public final class HttpRuntimeTransport {
    static final int BODY_LIMIT_BYTES = 16 * 1024;
    static final String PATH = "/internal/managed-runtime/v2/attest";
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);
    private static final Set<String> RESPONSE_FIELDS = Set.of(
            "protocolVersion", "runtimeInstanceId", "runtimeIncarnation",
            "leaseId", "epoch", "provisionRequestId", "tenantId",
            "workspaceId", "workspaceGeneration", "workspaceCwd",
            "capabilityDigest", "isolationClass");

    private final HttpClient client;

    public HttpRuntimeTransport() {
        this(HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(5))
                .build());
    }

    public HttpRuntimeTransport(HttpClient client) {
        if (client == null) {
            throw new IllegalArgumentException("client is required");
        }
        this.client = client;
    }

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
        client.sendAsync(request(lease, body),
                HttpResponse.BodyHandlers.ofInputStream())
                .whenComplete((response, error) -> {
                    if (error != null) {
                        result.completeExceptionally(unavailable(error));
                        return;
                    }
                    try (InputStream stream = response.body()) {
                        byte[] bytes = readAtMost(stream);
                        result.complete(parse(response, bytes, lease, request,
                                seed));
                    } catch (IOException exception) {
                        result.completeExceptionally(unavailable(exception));
                    } catch (RuntimeException exception) {
                        result.completeExceptionally(exception);
                    }
                });
        return result;
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
                .timeout(REQUEST_TIMEOUT)
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

    private static byte[] readAtMost(InputStream stream) throws IOException {
        byte[] buffer = new byte[BODY_LIMIT_BYTES + 1];
        int offset = 0;
        while (offset < buffer.length) {
            int read = stream.read(buffer, offset, buffer.length - offset);
            if (read < 0) {
                break;
            }
            offset += read;
        }
        byte[] payload = new byte[offset];
        System.arraycopy(buffer, 0, payload, 0, offset);
        return payload;
    }

    private static RuntimeAttestation parse(HttpResponse<?> response,
            byte[] bytes, RuntimeLease lease, RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
        int status = response.statusCode();
        if (bytes.length > BODY_LIMIT_BYTES) {
            if (status >= 500) {
                throw failure(status);
            }
            throw tooLarge();
        }
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

    private static RuntimeBrokerException error(int status, String code,
            String message, boolean retryable) {
        return new RuntimeBrokerException(status, code, message, retryable);
    }
}
