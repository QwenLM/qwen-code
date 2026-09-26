package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.fastjson2.JSONWriter;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
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
 * HTTP client for private Runtime attestation, context and tool routes.
 *
 * <p>Attestation plus the tool operations execute, status, and cancel, keyed
 * by the original call reference. Status and cancel answers are projected to
 * the Broker's closed state and result. Acquire, control, and release are
 * not part of the v2 tool contract and fail closed.
 */
public final class HttpRuntimeTransport implements RuntimeTransport {
    static final int BODY_LIMIT_BYTES = 16 * 1024;
    static final int TOOL_REQUEST_LIMIT_BYTES = 256 * 1024;
    static final int TOOL_RESULT_LIMIT_BYTES = 1024 * 1024;
    static final String PATH = "/internal/managed-runtime/v2/attest";
    static final String EXECUTE_PATH = "/internal/managed-runtime/v2/execute";
    static final String STATUS_PATH = "/internal/managed-runtime/v2/status";
    static final String CANCEL_PATH = "/internal/managed-runtime/v2/cancel";
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);
    private static final Set<String> RESPONSE_FIELDS = Set.of(
            "protocolVersion", "runtimeInstanceId", "runtimeIncarnation",
            "leaseId", "epoch", "provisionRequestId", "tenantId",
            "workspaceId", "workspaceGeneration", "workspaceCwd",
            "capabilityDigest", "isolationClass");
    private static final Set<String> TOOL_RESPONSE_FIELDS = Set.of(
            "protocolVersion", "state", "result", "lastSequence");
    private static final Set<String> TOOL_STATES = Set.of("prepared",
            "executing", "cancel_requested", "settled", "unknown");
    private static final Set<String> EXECUTION_STATUSES = Set.of(
            "not_started", "success", "error", "cancelled");
    private static final Set<String> CALLER_REFERENCE_FIELDS = Set.of(
            "sessionId", "promptId", "callId", "argsDigest", "toolName",
            "input");
    private static final Set<String> RESULT_FIELDS = Set.of(
            "executionStatus", "responseParts", "error");
    private static final Set<String> ERROR_FIELDS = Set.of("message", "type");

    private final HttpClient client;
    private final Duration requestTimeout;

    public HttpRuntimeTransport() {
        this(HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(5))
                .build(), REQUEST_TIMEOUT);
    }

    public HttpRuntimeTransport(HttpClient client) {
        this(client, REQUEST_TIMEOUT);
    }

    HttpRuntimeTransport(HttpClient client, Duration requestTimeout) {
        if (client == null) {
            throw new IllegalArgumentException("client is required");
        }
        if (requestTimeout == null || requestTimeout.isNegative()
                || requestTimeout.isZero()) {
            throw new IllegalArgumentException("requestTimeout is required");
        }
        this.client = client;
        this.requestTimeout = requestTimeout;
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
        if (request.isManagedContext()) {
            Map<String, Object> boot = ManagedContextProtocol.boot(request, seed);
            return post(lease, ManagedContextProtocol.ATTEST_PATH,
                    encodeToolRequest(ManagedContextProtocol.attestationRequest(boot),
                            BODY_LIMIT_BYTES), BODY_LIMIT_BYTES)
                    .thenApply(bytes -> {
                        ManagedContextProtocol.verify(ManagedContextProtocol.parse(bytes),
                                ManagedContextProtocol.attestationResponse(boot));
                        return new RuntimeAttestation(seed.getProvisionalRuntimeId(),
                                seed.getGatewayIncarnation(), seed.getLeaseId(),
                                seed.getEpoch(), request.getScope(),
                                seed.getProvisionRequestId(), request.getStorageId());
                    });
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
                .orTimeout(requestTimeout.toMillis(), TimeUnit.MILLISECONDS)
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
    public CompletionStage<Map<String, Object>> installContext(RuntimeLease lease,
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            String operationId, String sessionId, ContextBinding binding) {
        if (seed == null || !seed.matches(lease)) {
            throw new IllegalArgumentException("seed must bind the lease");
        }
        ManagedContextProtocol.boot(request, seed);
        Map<String, Object> body = ManagedContextProtocol.installation(request,
                operationId, sessionId, binding);
        Map<String, Object> expected = ManagedContextProtocol.receipt(seed,
                operationId, sessionId, binding);
        return post(lease, ManagedContextProtocol.CONTEXT_PATH,
                encodeToolRequest(body, BODY_LIMIT_BYTES), BODY_LIMIT_BYTES)
                .thenApply(bytes -> {
                    Map<String, Object> receipt = ManagedContextProtocol.parse(bytes);
                    ManagedContextProtocol.verify(receipt, expected);
                    return receipt;
                });
    }

    /**
     * Runs one tool call to settlement. The reference carries the identity
     * four plus {@code toolName} and {@code input}; nothing else may ride
     * along. Returns the settled result map.
     */
    public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException(
                    "lease and session are required");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 2);
        body.put("reference", referenceIdentity(reference));
        body.put("toolName", referenceString(reference, "toolName"));
        body.put("input", referenceInput(reference));
        byte[] encoded = encodeToolRequest(body, TOOL_REQUEST_LIMIT_BYTES);
        return post(lease, EXECUTE_PATH, encoded, TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> {
                    Map<String, Object> response = parseToolResponse(bytes,
                            "execute");
                    if (!"settled".equals(response.get("state"))) {
                        throw protocol("Managed Runtime execute did not "
                                + "settle.");
                    }
                    @SuppressWarnings("unchecked")
                    Map<String, Object> result =
                            (Map<String, Object>) response.get("result");
                    return result;
                });
    }

    /**
     * Read-only lookup of one call by its original reference. An
     * {@code unknown} state is a valid answer and never evidence that the
     * call did not run.
     */
    public CompletionStage<Map<String, Object>> status(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException(
                    "lease and session are required");
        }
        if (afterSequence < 0) {
            throw new IllegalArgumentException(
                    "afterSequence must be non-negative");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 2);
        body.put("reference", referenceIdentity(reference));
        body.put("afterSequence", afterSequence);
        byte[] encoded = encodeToolRequest(body, BODY_LIMIT_BYTES);
        return post(lease, STATUS_PATH, encoded, TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> projectClosedStatus(
                        parseToolResponse(bytes, "status"), "status"));
    }

    /** Asks the Runtime to cancel one call by its original reference. */
    public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException(
                    "lease and session are required");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 2);
        body.put("reference", referenceIdentity(reference));
        byte[] encoded = encodeToolRequest(body, BODY_LIMIT_BYTES);
        return post(lease, CANCEL_PATH, encoded, TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> projectClosedStatus(
                        parseToolResponse(bytes, "cancel"), "cancel"));
    }

    /**
     * Session verbs are not on the v2 tool contract. Fail closed instead of
     * inventing a route the worker does not serve.
     */
    @Override
    public CompletionStage<Void> acquire(RuntimeLease lease,
            RuntimeSession session) {
        return unsupportedSessionVerb();
    }

    @Override
    public CompletionStage<Object> control(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> operation) {
        return unsupportedSessionVerb();
    }

    @Override
    public CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session) {
        return unsupportedSessionVerb();
    }

    private static <T> CompletionStage<T> unsupportedSessionVerb() {
        return CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_session_verb_unsupported",
                "Runtime transport does not support session verbs.", false));
    }

    /**
     * The Broker accepts only {@code state}, plus {@code result} when the
     * state is {@code settled}. Wire fields such as {@code protocolVersion}
     * and {@code lastSequence} stay on the HTTP response and are validated
     * before this projection.
     */
    private static Map<String, Object> projectClosedStatus(
            Map<String, Object> response, String operation) {
        Object state = response.get("state");
        if (!(state instanceof String text) || !TOOL_STATES.contains(text)) {
            throw protocol("Managed Runtime " + operation
                    + " returned an invalid state.");
        }
        boolean settled = "settled".equals(text);
        if (settled != response.containsKey("result")) {
            throw protocol("Managed Runtime " + operation
                    + " result does not match its state.");
        }
        Map<String, Object> projected = new LinkedHashMap<>();
        projected.put("state", text);
        if (settled) {
            projected.put("result", response.get("result"));
        }
        return Map.copyOf(projected);
    }

    private static Map<String, Object> referenceIdentity(
            Map<String, Object> reference) {
        if (reference == null) {
            throw new IllegalArgumentException("reference is required");
        }
        for (Object key : reference.keySet()) {
            if (!CALLER_REFERENCE_FIELDS.contains(key)) {
                throw new IllegalArgumentException(
                        "reference " + key + " is not allowed");
            }
        }
        Map<String, Object> identity = new LinkedHashMap<>();
        for (String field : List.of("sessionId", "promptId", "callId",
                "argsDigest")) {
            identity.put(field, referenceString(reference, field));
        }
        return Map.copyOf(identity);
    }

    private static String referenceString(Map<String, Object> reference,
            String field) {
        Object value = reference.get(field);
        if (!(value instanceof String text) || text.isEmpty()) {
            throw new IllegalArgumentException(
                    "reference " + field + " is required");
        }
        return text;
    }

    private static Object referenceInput(Map<String, Object> reference) {
        Object input = reference.get("input");
        if (!(input instanceof Map)) {
            throw new IllegalArgumentException("reference input is required");
        }
        return input;
    }

    private static byte[] encodeToolRequest(Map<String, Object> body,
            int limit) {
        byte[] encoded = JSON.toJSONBytes(body, JSONWriter.Feature.WriteNulls);
        if (encoded.length > limit) {
            throw new IllegalArgumentException(
                    "Managed Runtime tool request exceeds "
                            + limit / 1024 + " KiB.");
        }
        return encoded;
    }

    private static Map<String, Object> parseToolResponse(byte[] bytes,
            String operation) {
        Map<String, Object> fields;
        try {
            // Keep fractional cursors exact before validating integer fields.
            fields = BrokerValues.immutableMap(JSON.parseObject(
                    new String(bytes, StandardCharsets.UTF_8),
                    JSONReader.Feature.DisableReferenceDetect,
                    JSONReader.Feature.UseBigDecimalForDoubles,
                    JSONReader.Feature.UseBigDecimalForFloats));
        } catch (RuntimeException exception) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
        if (!TOOL_RESPONSE_FIELDS.containsAll(fields.keySet())) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
        requireProtocol(fields, operation);
        Object rawState = fields.get("state");
        if (!(rawState instanceof String state)
                || !TOOL_STATES.contains(state)) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
        Object result = fields.get("result");
        if ("settled".equals(state)) {
            if (result == null) {
                throw protocol("Managed Runtime " + operation
                        + " settled without a result.");
            }
            requireResult(result, operation);
        } else if (fields.containsKey("result")) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
        if (fields.containsKey("lastSequence")) {
            if (!"status".equals(operation)
                    || !(fields.get("lastSequence") instanceof Number number)) {
                throw protocol("Managed Runtime " + operation
                        + " response is invalid.");
            }
            BigDecimal sequence = new BigDecimal(number.toString());
            if (sequence.signum() < 0
                    || sequence.stripTrailingZeros().scale() > 0) {
                throw protocol("Managed Runtime " + operation
                        + " response is invalid.");
            }
        }
        return fields;
    }

    private static void requireResult(Object result, String operation) {
        if (!(result instanceof Map<?, ?> resultMap)
                || !RESULT_FIELDS.containsAll(resultMap.keySet())) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
        Object status = resultMap.get("executionStatus");
        if (!(status instanceof String)
                || !EXECUTION_STATUSES.contains(status)) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
        if (!(resultMap.get("responseParts") instanceof List)) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
        Object error = resultMap.get("error");
        if (resultMap.containsKey("error")) {
            if (!(error instanceof Map<?, ?> errorMap)
                    || !ERROR_FIELDS.containsAll(errorMap.keySet())
                    || !(errorMap.get("message") instanceof String message)
                    || message.isEmpty()) {
                throw protocol("Managed Runtime " + operation
                        + " response is invalid.");
            }
            Object type = errorMap.get("type");
            if (errorMap.containsKey("type")
                    && (!(type instanceof String text)
                    || text.isEmpty())) {
                throw protocol("Managed Runtime " + operation
                        + " response is invalid.");
            }
        }
    }

    private CompletionStage<byte[]> post(RuntimeLease lease, String path,
            byte[] encoded, int responseLimit) {
        HttpRequest httpRequest = HttpRequest.newBuilder(
                lease.getEndpoint().resolve(path))
                .timeout(requestTimeout)
                .header("Authorization", "Bearer " + lease.getToken())
                .header("Cache-Control", "no-store")
                .header("Content-Type", "application/json")
                .header("X-Qwen-Managed-Lease-Id", lease.getLeaseId())
                .header("X-Qwen-Managed-Lease-Epoch",
                        Long.toString(lease.getEpoch()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(encoded))
                .build();
        CompletableFuture<byte[]> result = new CompletableFuture<>();
        CompletableFuture<HttpResponse<BoundedBody>> exchange = client
                .sendAsync(httpRequest,
                        info -> new BoundedBodySubscriber(responseLimit));
        exchange.whenComplete((response, error) -> {
            if (error != null) {
                result.completeExceptionally(unavailable(unwrap(error)));
                return;
            }
            BoundedBody responseBody = response.body();
            String operation = path.substring(path.lastIndexOf('/') + 1);
            if (response.statusCode() != 200) {
                RuntimeBrokerException classified =
                        contextFailure(response, responseBody, path);
                result.completeExceptionally(error(classified.getStatusCode(),
                        classified.getCode(), "Managed Runtime " + operation
                                + " request failed (HTTP "
                                + response.statusCode()
                                + ").", classified.isRetryable()));
                return;
            }
            if (responseBody.overflow()) {
                result.completeExceptionally(error(413,
                        "managed_runtime_attestation_too_large",
                        "Managed Runtime " + operation
                                + " response exceeds "
                                + (responseLimit == TOOL_RESULT_LIMIT_BYTES
                                        ? "1 MiB." : "16 KiB."), false));
                return;
            }
            if (!"no-store".equals(response.headers()
                    .firstValue("Cache-Control").orElse(""))
                    || !jsonContentType(response.headers()
                            .firstValue("Content-Type").orElse(""))
                    || response.headers().firstValue("Content-Encoding").isPresent()) {
                result.completeExceptionally(protocol(
                        "Managed Runtime " + operation
                                + " response is invalid."));
                return;
            }
            result.complete(responseBody.bytes());
        });
        CompletableFuture<byte[]> returned = result
                .orTimeout(requestTimeout.toMillis(), TimeUnit.MILLISECONDS)
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

    private static RuntimeBrokerException contextFailure(
            HttpResponse<BoundedBody> response, BoundedBody body, String path) {
        if (response.statusCode() == 409 && !body.overflow()
                && !path.endsWith("/attest")
                && "no-store".equals(response.headers()
                        .firstValue("Cache-Control").orElse(""))
                && jsonContentType(response.headers()
                        .firstValue("Content-Type").orElse(""))) {
            try {
                Map<String, Object> fields = ManagedContextProtocol.parse(body.bytes());
                Object code = fields.get("code");
                if (fields.keySet().equals(Set.of("code", "error"))
                        && fields.get("error") instanceof String
                        && ("managed_context_unavailable".equals(code)
                                || "managed_context_conflict".equals(code))) {
                    return error(409, (String) code,
                            "Managed Session context is unavailable or conflicts.", false);
                }
            } catch (RuntimeBrokerException ignored) {
                // An unrecognized error body supplies no Session-scoped evidence.
            }
        }
        return failure(response.statusCode());
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
                .timeout(requestTimeout)
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
        requireProtocol(fields, "attestation");
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

    private static void requireProtocol(Map<String, Object> response,
            String operation) {
        Object raw = response.get("protocolVersion");
        if (!(raw instanceof Number number)
                || new BigDecimal(number.toString())
                        .compareTo(BigDecimal.valueOf(2)) != 0) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
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
        if (parts.length == 0
                || !"application/json".equalsIgnoreCase(parts[0].trim())) {
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
