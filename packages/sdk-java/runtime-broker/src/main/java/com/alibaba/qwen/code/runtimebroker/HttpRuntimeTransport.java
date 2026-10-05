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
import java.util.Arrays;
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
 * the Broker's closed state and result. Prepared provider invocations use
 * their separate Session control protocol. MCP controls have their own
 * bounded envelope.
 */
public final class HttpRuntimeTransport implements RuntimeTransport {
    static final int BODY_LIMIT_BYTES = 16 * 1024;
    static final int TOOL_REQUEST_LIMIT_BYTES = 256 * 1024;
    static final int TOOL_RESULT_LIMIT_BYTES = 1024 * 1024;
    static final String PATH = "/internal/managed-runtime/v2/attest";
    static final String EXECUTE_PATH = "/internal/managed-runtime/v2/execute";
    static final String STATUS_PATH = "/internal/managed-runtime/v2/status";
    static final String CANCEL_PATH = "/internal/managed-runtime/v2/cancel";
    static final String V3_EXECUTE_PATH = "/internal/managed-runtime/v3/execute";
    static final String V3_STATUS_PATH = "/internal/managed-runtime/v3/status";
    static final String V3_CANCEL_PATH = "/internal/managed-runtime/v3/cancel";
    static final String V3_ACKNOWLEDGE_PATH = "/internal/managed-runtime/v3/acknowledge";
    static final String PUBLICATION_INSTALL_PATH = "/internal/managed-runtime/v3/publications:install";
    public static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);
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
            "input", "payloadDigest", "publicationId");
    private static final Set<String> RESULT_FIELDS = Set.of(
            "executionStatus", "responseParts", "error");
    private static final Set<String> ERROR_FIELDS = Set.of("message", "type");
    private static final Set<String> V3_RESPONSE_FIELDS = Set.of(
            "protocolVersion", "toolResult", "state", "result", "lastSequence");
    private static final Set<String> V3_RESULT_FIELDS = Set.of(
            "executionStatus", "responseParts", "error", "capture");
    private static final Set<String> V3_CAPTURE_FIELDS = Set.of(
            "captureStatus", "captureReason", "manifest", "previewTruncated",
            "deliveryStatus");
    private static final Set<String> V3_CAPTURE_REQUEST_FIELDS = Set.of(
            "tenantId", "sessionId", "turnId", "executionCallId",
            "bindingGeneration", "capturePolicy");
    private static final Set<String> V3_MANIFEST_REF_FIELDS = Set.of(
            "resourceId", "kind", "schemaVersion", "byteLength", "digest");
    private static final Set<String> V3_RECEIPT_FIELDS = Set.of(
            "executionCallId", "manifest", "deliveryStatus", "historyRevision");

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
    public CompletionStage<Map<String, Object>> installContext(
            RuntimeBindingRecord runtime, RuntimeSessionRecord sessionRecord,
            String operationId, ContextBinding binding) {
        if (runtime == null || sessionRecord == null) {
            throw new IllegalArgumentException("runtime and session are required");
        }
        // The record ties the lease and seed to the placement they serve.
        RuntimeProvisionRequest request = runtime.getRequest();
        RuntimeLease lease = runtime.getLease();
        RuntimeProvisionSeed seed = runtime.getProvisionSeed();
        RuntimeSession session = sessionRecord.getSession();
        String isolationKey = "session".equals(
                session.getScope().getIsolationClass())
                        ? session.getHarnessSessionId() : null;
        // Acquisition installs the context while the Session is still
        // ACQUIRING. A Session being released takes none, and neither does
        // a binding asked to drain, which admits no new Session either.
        if (!sessionRecord.isAcquirable()) {
            throw new IllegalArgumentException(
                    "session must be acquiring or ready");
        }
        if (runtime.getState() != RuntimeBindingRecord.State.READY
                || runtime.isDrainRequested()
                || lease == null || seed == null
                || !runtime.getBindingId().equals(sessionRecord.getBindingId())
                || runtime.getGeneration() != sessionRecord.getRuntimeGeneration()
                || !request.getScope().equals(session.getScope())
                || !java.util.Objects.equals(request.getIsolationKey(),
                        isolationKey)) {
            throw new IllegalArgumentException(
                    "session must belong to a READY Runtime binding");
        }
        String sessionId = session.getRuntimeSessionId();
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

    /** Activates or closes the installed fixed-profile Session gate. */
    public CompletionStage<Void> activateWorkspace(RuntimeBindingRecord runtime,
            RuntimeSessionRecord sessionRecord, ContextBinding binding, boolean active) {
        RuntimeSession session = sessionRecord.getSession();
        RuntimeProvisionSeed seed = runtime.getProvisionSeed();
        RuntimeProvisionRequest request = runtime.getRequest();
        if (seed == null || runtime.getLease() == null
                || !runtime.getBindingId().equals(sessionRecord.getBindingId())
                || runtime.getGeneration() != sessionRecord.getRuntimeGeneration()
                || !request.isManagedContext()
                || !request.getScope().equals(session.getScope())
                || !session.getHarnessSessionId().equals(request.getIsolationKey())
                || !WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(
                        session.getScope().getCapabilityDigest())
                || !WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(
                        binding.getContextConfigRef())) {
            throw new IllegalArgumentException("Workspace activation identity is invalid");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 1);
        body.put("operation", active ? "activate" : "release");
        body.put("sessionId", session.getRuntimeSessionId());
        body.put("contextDigest", binding.getContextDigest());
        body.put("contextConfigRef", binding.getContextConfigRef());
        body.put("profile", WorkspaceExecutionProfile.PROFILE);
        Map<String, Object> expected = new LinkedHashMap<>(body);
        expected.put("runtimeInstanceId", seed.getProvisionalRuntimeId());
        expected.put("runtimeIncarnation", seed.getGatewayIncarnation());
        expected.put("epoch", seed.getEpoch());
        expected.put("active", active);
        return post(runtime.getLease(), "/internal/managed-runtime/v3/activation",
                encodeToolRequest(body, BODY_LIMIT_BYTES), BODY_LIMIT_BYTES)
                .thenAccept(bytes -> ManagedContextProtocol.verify(
                        ManagedContextProtocol.parse(bytes), expected));
    }

    /**
     * Runs one tool call to settlement. Two reference shapes select two
     * protocols: the caller reference (the identity four plus
     * {@code toolName} and {@code input}) dispatches over Tool v2 and settles
     * to an {@code executionStatus}/{@code responseParts}/{@code error} map,
     * while a prepared reference of exactly the seven fields in
     * {@code ProviderRuntimeProtocol.REFERENCE_FIELDS} ({@code sessionId},
     * {@code promptId}, {@code callId}, {@code capabilityDigest},
     * {@code policyRevision}, {@code invocationId} and {@code argsDigest})
     * dispatches over the provider control protocol and settles to an
     * {@code executionStatus}/{@code result}/{@code error}/{@code postHook}/
     * {@code failureHook} map. Nothing else may ride along in either mode.
     */
    public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException(
                    "lease and session are required");
        }
        if (ProviderRuntimeProtocol.isReference(reference)) {
            ProviderRuntimeProtocol.reference(reference, session.getRuntimeSessionId());
            return provider(lease, session, Map.of("kind", "execute", "reference", reference))
                    .thenApply(value -> providerResult(value, "execute"));
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 2);
        body.put("reference", referenceIdentity(reference));
        body.put("toolName", referenceToolName(reference));
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
        if (ProviderRuntimeProtocol.isReference(reference)) {
            ProviderRuntimeProtocol.reference(reference, session.getRuntimeSessionId());
            return provider(lease, session, Map.of("kind", "status", "reference", reference,
                    "afterSequence", afterSequence))
                    .thenApply(value -> providerStatus(value, "status"));
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
        if (ProviderRuntimeProtocol.isReference(reference)) {
            ProviderRuntimeProtocol.reference(reference, session.getRuntimeSessionId());
            return provider(lease, session, Map.of("kind", "cancel", "reference", reference))
                    .thenApply(value -> providerStatus(value, "cancel"));
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 2);
        body.put("reference", referenceIdentity(reference));
        byte[] encoded = encodeToolRequest(body, BODY_LIMIT_BYTES);
        return post(lease, CANCEL_PATH, encoded, TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> projectClosedStatus(
                        parseToolResponse(bytes, "cancel"), "cancel"));
    }

    public CompletionStage<Void> installPublisherV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> publisher) {
        requireV3Context(lease, session);
        requireClosed(publisher, Set.of("url", "token"), "publisher");
        if (!(publisher.get("url") instanceof String url)
                || !url.matches("http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/internal/hosted-shell-publisher/v1")
                || URI.create(url).getPort() > 65535
                || !(publisher.get("token") instanceof String token)
                || !token.matches("[A-Za-z0-9_-]{43}")) {
            throw new IllegalArgumentException("Output publisher descriptor is invalid");
        }
        Map<String, Object> body = Map.of("protocolVersion", 3,
                "toolResult", "managed-tool-result/1", "sessionId", session.getRuntimeSessionId(),
                "publisher", publisher);
        Map<String, Object> expected = Map.of("protocolVersion", 3,
                "toolResult", "managed-tool-result/1", "sessionId", session.getRuntimeSessionId(),
                "installed", true);
        return post(lease, "/internal/managed-runtime/v3/publisher",
                encodeToolRequest(body, BODY_LIMIT_BYTES), BODY_LIMIT_BYTES)
                .thenAccept(bytes -> ManagedContextProtocol.verify(ManagedContextProtocol.parse(bytes), expected));
    }

    /** Explicit Tool v3 call; selection belongs to the saved Broker reference. */
    public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> capture) {
        requireV3Context(lease, session);
        requireClosed(capture, V3_CAPTURE_REQUEST_FIELDS, "capture");
        if (!"complete_required".equals(capture.get("capturePolicy"))) {
            throw new IllegalArgumentException("capture policy is invalid");
        }
        for (String key : List.of("tenantId", "sessionId", "turnId",
                "executionCallId", "bindingGeneration")) {
            if (!(capture.get(key) instanceof String text) || text.isEmpty()) {
                throw new IllegalArgumentException("capture " + key + " is invalid");
            }
        }
        Map<String, Object> body = v3Body(reference);
        body.put("toolName", referenceToolName(reference));
        body.put("input", referenceInput(reference));
        body.put("capture", capture);
        return post(lease, V3_EXECUTE_PATH,
                encodeToolRequest(body, TOOL_REQUEST_LIMIT_BYTES),
                TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> parseV3Response(bytes, "execute"));
    }

    @Override
    public CompletionStage<Void> installPublication(RuntimeLease lease,
            RuntimeSession session, RuntimePublicationGrant grant) {
        requireV3Context(lease, session);
        Map<String, Object> body = Map.of("protocolVersion", 3,
                "publication", "managed-tool-publication/1",
                "publicationId", grant.publicationId(),
                "publicationToken", grant.token(),
                "serviceBaseUrl", grant.serviceBaseUrl(),
                "binding", grant.binding());
        return post(lease, PUBLICATION_INSTALL_PATH,
                encodeToolRequest(body, 64 * 1024), BODY_LIMIT_BYTES)
                .thenApply(bytes -> {
                    Map<String, Object> response = JsonCodec.parseObject(bytes,
                            "publication installation response");
                    if (!Integer.valueOf(3).equals(response.get("protocolVersion"))
                            || !"managed-tool-publication/1".equals(response.get("publication"))
                            || !Boolean.TRUE.equals(response.get("installed"))) {
                        throw protocol("Publication installation was not confirmed.");
                    }
                    return null;
                });
    }

    @Override
    public CompletionStage<Map<String, Object>> executeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> payload, Map<String, Object> capture) {
        requireV3Context(lease, session);
        requireClosed(capture, V3_CAPTURE_REQUEST_FIELDS, "capture");
        Map<String, Object> body = v3Body(reference);
        body.put("toolName", payload.get("toolName"));
        body.put("input", payload.get("input"));
        body.put("capture", capture);
        return post(lease, V3_EXECUTE_PATH,
                encodeToolRequest(body, TOOL_REQUEST_LIMIT_BYTES),
                TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> parseV3Response(bytes, "execute"));
    }

    /** Read-only Tool v3 lookup by the original invocation reference. */
    public CompletionStage<Map<String, Object>> statusV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            long afterSequence) {
        requireV3Context(lease, session);
        if (afterSequence < 0) {
            throw new IllegalArgumentException("afterSequence must be non-negative");
        }
        Map<String, Object> body = v3Body(reference);
        body.put("afterSequence", afterSequence);
        return post(lease, V3_STATUS_PATH,
                encodeToolRequest(body, BODY_LIMIT_BYTES),
                TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> parseV3Response(bytes, "status"));
    }

    /** Requests cancellation without assuming the physical call was undone. */
    public CompletionStage<Map<String, Object>> cancelV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference) {
        requireV3Context(lease, session);
        return post(lease, V3_CANCEL_PATH,
                encodeToolRequest(v3Body(reference), BODY_LIMIT_BYTES),
                TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> parseV3Response(bytes, "cancel"));
    }

    /** Replays the exact Session receipt; a changed ACK is a conflict. */
    public CompletionStage<Map<String, Object>> acknowledgeV3(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> reference,
            Map<String, Object> receipt) {
        requireV3Context(lease, session);
        requireClosed(receipt, V3_RECEIPT_FIELDS, "receipt");
        if (!(receipt.get("executionCallId") instanceof String callId)
                || callId.isEmpty()) {
            throw new IllegalArgumentException("receipt executionCallId is invalid");
        }
        Object delivery = receipt.get("deliveryStatus");
        Object revision = receipt.get("historyRevision");
        if (!(delivery instanceof String status)
                || !("committed".equals(status) || "blocked".equals(status))
                || ("committed".equals(status)
                    ? !(revision instanceof Number number)
                            || new BigDecimal(number.toString()).compareTo(BigDecimal.ONE) < 0
                            || new BigDecimal(number.toString()).stripTrailingZeros().scale() > 0
                    : revision != null)) {
            throw new IllegalArgumentException("receipt decision is invalid");
        }
        Map<String, Object> body = v3Body(reference);
        body.put("receipt", receipt);
        return post(lease, V3_ACKNOWLEDGE_PATH,
                encodeToolRequest(body, BODY_LIMIT_BYTES),
                TOOL_RESULT_LIMIT_BYTES)
                .thenApply(bytes -> parseV3Response(bytes, "acknowledge"));
    }

    private static void requireV3Context(RuntimeLease lease,
            RuntimeSession session) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException("lease and session are required");
        }
    }

    private static Map<String, Object> v3Body(Map<String, Object> reference) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("protocolVersion", 3);
        body.put("toolResult", "managed-tool-result/1");
        body.put("reference", referenceIdentity(reference));
        return body;
    }

    private static void requireClosed(Map<String, Object> value,
            Set<String> fields, String name) {
        if (value == null || !value.keySet().equals(fields)) {
            throw new IllegalArgumentException(name + " fields are invalid");
        }
    }

    private static Map<String, Object> parseV3Response(byte[] bytes,
            String operation) {
        Map<String, Object> fields;
        try {
            fields = BrokerValues.immutableMap(JSON.parseObject(
                    new String(bytes, StandardCharsets.UTF_8),
                    JSONReader.Feature.DisableReferenceDetect,
                    JSONReader.Feature.UseBigDecimalForDoubles,
                    JSONReader.Feature.UseBigDecimalForFloats));
        } catch (RuntimeException exception) {
            throw protocol("Managed Runtime " + operation + " response is invalid.");
        }
        Object rawState = fields.get("state");
        if (!V3_RESPONSE_FIELDS.containsAll(fields.keySet())
                || !Integer.valueOf(3).equals(fields.get("protocolVersion"))
                || !"managed-tool-result/1".equals(fields.get("toolResult"))
                || !(rawState instanceof String state)
                || !TOOL_STATES.contains(state)) {
            throw protocol("Managed Runtime " + operation + " response is invalid.");
        }
        if ("acknowledge".equals(operation)
                && !("settled".equals(state) || "unknown".equals(state))) {
            throw protocol("Managed Runtime " + operation + " response is invalid.");
        }
        Object result = fields.get("result");
        if ("settled".equals(state)) {
            if (!(result instanceof Map<?, ?> envelope)
                    || !V3_RESULT_FIELDS.containsAll(envelope.keySet())
                    || !envelope.containsKey("capture")
                    || !(envelope.get("executionStatus") instanceof String outcome)
                    || !EXECUTION_STATUSES.contains(outcome)
                    || !(envelope.get("responseParts") instanceof List)) {
                throw protocol("Managed Runtime " + operation + " result is invalid.");
            }
            if (envelope.containsKey("error")) {
                Object error = envelope.get("error");
                if (!(error instanceof Map<?, ?> details)
                        || !ERROR_FIELDS.containsAll(details.keySet())
                        || !(details.get("message") instanceof String message)
                        || message.isEmpty()
                        || details.containsKey("type")
                            && (!(details.get("type") instanceof String type)
                                || type.isEmpty())) {
                    throw protocol("Managed Runtime " + operation
                            + " result is invalid.");
                }
            }
            Object capture = envelope.get("capture");
            if (!"not_started".equals(envelope.get("executionStatus"))) {
                if (!(capture instanceof Map<?, ?> data)
                        || !data.keySet().equals(V3_CAPTURE_FIELDS)
                        || !(data.get("captureStatus") instanceof String captureStatus)
                        || !Set.of("complete", "partial", "unavailable")
                                .contains(captureStatus)
                        || !(data.get("previewTruncated") instanceof Boolean)
                        || !(data.get("deliveryStatus") instanceof String deliveryStatus)
                        || !Set.of("pending", "committed", "blocked")
                                .contains(deliveryStatus)
                        || "complete".equals(captureStatus)
                            != (data.get("captureReason") == null)
                        || data.get("captureReason") != null
                            && (!(data.get("captureReason") instanceof String reason)
                                || !Set.of("quota_exhausted", "size_limit",
                                        "producer_lost", "storage_failed",
                                        "cancelled").contains(reason))
                        || data.get("manifest") == null
                            && !"unavailable".equals(captureStatus)
                        || data.get("manifest") != null
                            && !validV3ManifestRef(data.get("manifest"))) {
                    throw protocol("Managed Runtime " + operation
                            + " capture is invalid.");
                }
            } else if (capture != null) {
                throw protocol("Managed Runtime " + operation
                        + " capture is invalid.");
            }
        } else if (fields.containsKey("result")) {
            throw protocol("Managed Runtime " + operation + " response is invalid.");
        }
        if (fields.containsKey("lastSequence")) {
            BigDecimal sequence = BrokerValues.exactInteger(
                    fields.get("lastSequence"));
            if (!"status".equals(operation) || sequence == null
                    || sequence.signum() < 0) {
                throw protocol("Managed Runtime " + operation
                        + " sequence is invalid.");
            }
        }
        return fields;
    }

    private static boolean validV3ManifestRef(Object value) {
        if (!(value instanceof Map<?, ?> ref)) {
            return false;
        }
        Long byteLength = BrokerValues.exactLong(ref.get("byteLength"));
        if (!ref.keySet().equals(V3_MANIFEST_REF_FIELDS)
                || !(ref.get("resourceId") instanceof String resourceId)
                || resourceId.isEmpty()
                || !"managed-tool-result-manifest".equals(ref.get("kind"))
                || !Integer.valueOf(1).equals(ref.get("schemaVersion"))
                || byteLength == null || byteLength <= 0
                || byteLength > 64 * 1024
                || !(ref.get("digest") instanceof String digest)
                || !digest.matches("[0-9a-f]{64}")) {
            return false;
        }
        return true;
    }

    /** Session acquisition is Broker-local until the provider is used. */
    @Override
    public CompletionStage<Void> acquire(RuntimeLease lease,
            RuntimeSession session) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException("lease and session are required");
        }
        return CompletableFuture.completedFuture(null);
    }

    @Override
    public CompletionStage<Object> control(RuntimeLease lease,
            RuntimeSession session, Map<String, Object> operation) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException("lease and session are required");
        }
        Map<String, Object> immutable = BrokerValues.immutableMap(operation);
        if (ManagedMcpProtocol.isOperation(immutable)) {
            ManagedMcpProtocol.validateSession(session, immutable);
            Map<String, Object> body = Map.of("protocolVersion", 1,
                    "runtimeSessionId", session.getRuntimeSessionId(), "operation", immutable);
            byte[] encoded;
            try {
                encoded = encodeToolRequest(body, TOOL_REQUEST_LIMIT_BYTES);
            } catch (IllegalArgumentException tooLarge) {
                throw new RuntimeBrokerException(413, "runtime_control_operation_too_large",
                        "Runtime MCP operation exceeds its size limit.", false);
            }
            return post(lease, ManagedMcpProtocol.PATH, encoded, TOOL_RESULT_LIMIT_BYTES)
                    .thenApply(bytes -> ManagedMcpProtocol.response(bytes, session, immutable));
        }
        if (ManagedHookProtocol.isOperation(immutable)) {
            ManagedHookProtocol.validateSession(session, immutable);
            Map<String, Object> body = Map.of("protocolVersion", 1,
                    "runtimeSessionId", session.getRuntimeSessionId(), "operation", immutable);
            byte[] encoded;
            try {
                encoded = encodeToolRequest(body, 8 * 1024 * 1024);
            } catch (IllegalArgumentException tooLarge) {
                throw new RuntimeBrokerException(413, "runtime_control_operation_too_large",
                        "Runtime Hook operation exceeds its size limit.", false);
            }
            return post(lease, ManagedHookProtocol.PATH, encoded, TOOL_RESULT_LIMIT_BYTES)
                    .thenApply(bytes -> ManagedHookProtocol.response(bytes, session, immutable));
        }
        ProviderRuntimeProtocol.control(immutable, session.getHarnessSessionId(), session.getRuntimeSessionId());
        if ("history".equals(immutable.get("kind")) || "raw-file-history".equals(immutable.get("kind"))) {
            return provider(lease, session, immutable);
        }
        return provider(lease, session, Map.of("kind", "acquire"))
                .thenCompose(value -> {
                    if (!Boolean.TRUE.equals(value)) {
                        throw protocol("Managed Runtime acquire response is invalid.");
                    }
                    return provider(lease, session, immutable);
                });
    }

    @Override
    public CompletionStage<Boolean> release(RuntimeLease lease,
            RuntimeSession session) {
        return provider(lease, session, Map.of("kind", "release"))
                .thenApply(value -> {
                    if (!Boolean.TRUE.equals(value)) {
                        throw protocol("Managed Runtime did not confirm Session release.");
                    }
                    return true;
                });
    }

    private CompletionStage<Object> provider(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> operation) {
        if (lease == null || session == null) {
            throw new IllegalArgumentException("lease and session are required");
        }
        Map<String, Object> identity = Map.of("harnessSessionId", session.getHarnessSessionId(),
                "runtimeSessionId", session.getRuntimeSessionId(), "turnKind", session.getTurnKind());
        Map<String, Object> body = Map.of("protocolVersion", 1,
                "providerProtocol", ProviderRuntimeProtocol.NAME, "session", identity,
                "operation", operation);
        String kind = (String) operation.get("kind");
        int limit = ProviderRuntimeProtocol.limit(kind);
        byte[] encoded;
        try {
            encoded = encodeToolRequest(body, limit);
        } catch (IllegalArgumentException tooLarge) {
            // An oversized operation can never succeed; answer the definitive
            // 413 shape instead of letting a runtime exception degrade to a
            // retryable 503 downstream.
            throw new RuntimeBrokerException(413, "runtime_control_operation_too_large",
                    "Runtime provider operation exceeds its size limit.", false);
        }
        return post(lease, ProviderRuntimeProtocol.PATH, encoded, limit)
                .thenApply(bytes -> {
                    Map<String, Object> response;
                    try {
                        response = BrokerValues.immutableMap(JSON.parseObject(
                                new String(bytes, StandardCharsets.UTF_8),
                                JSONReader.Feature.DisableReferenceDetect,
                                JSONReader.Feature.UseBigDecimalForDoubles,
                                JSONReader.Feature.UseBigDecimalForFloats));
                    } catch (RuntimeException exception) {
                        throw protocol("Managed Runtime provider response is invalid.");
                    }
                    if (!response.keySet().equals(Set.of("protocolVersion", "providerProtocol",
                            "session", "result"))
                            || !Integer.valueOf(1).equals(response.get("protocolVersion"))
                            || !ProviderRuntimeProtocol.NAME.equals(response.get("providerProtocol"))
                            || !identity.equals(response.get("session"))) {
                        throw protocol("Managed Runtime provider response identity is invalid.");
                    }
                    Object result = response.get("result");
                    if (("begin-turn".equals(kind) || "confirm".equals(kind)) && result != null) {
                        throw protocol("Managed Runtime provider void response is invalid.");
                    }
                    if (!Set.of("acquire", "release", "begin-turn", "confirm").contains(kind)
                            && !(result instanceof Map)) {
                        throw protocol("Managed Runtime provider result is invalid.");
                    }
                    return result;
                });
    }

    private static Map<String, Object> providerResult(Object value, String operation) {
        if (!(value instanceof Map<?, ?> result)
                || !Set.of("executionStatus", "result", "error", "postHook", "failureHook")
                        .containsAll(result.keySet())
                || !(result.get("executionStatus") instanceof String status)
                || !EXECUTION_STATUSES.contains(status)
                || "success".equals(status) && !(result.get("result") instanceof Map)) {
            throw protocol("Managed Runtime provider " + operation + " result is invalid.");
        }
        return ProviderRuntimeProtocol.object(value);
    }

    private static Map<String, Object> providerStatus(Object value, String operation) {
        if (!(value instanceof Map<?, ?> status)
                || !Set.of("state", "cancelRequested", "lastSeq", "firstAvailableSeq",
                        "progressGap", "progress", "result").containsAll(status.keySet())) {
            throw protocol("Managed Runtime provider " + operation + " status is invalid.");
        }
        Map<String, Object> result = ProviderRuntimeProtocol.object(value);
        if ("unknown".equals(result.get("state"))) {
            if (!result.keySet().equals(Set.of("state"))) {
                throw protocol("Managed Runtime provider unknown status is invalid.");
            }
        } else if (!(result.get("cancelRequested") instanceof Boolean)
                || !(result.get("progressGap") instanceof Boolean)
                || !(result.get("progress") instanceof List)
                || !providerSequence(result.get("lastSeq"))
                || !providerSequence(result.get("firstAvailableSeq"))) {
            throw protocol("Managed Runtime provider status cursor is invalid.");
        }
        if ("settled".equals(result.get("state"))) {
            providerResult(result.get("result"), operation);
        }
        return projectClosedStatus(result, operation);
    }

    private static boolean providerSequence(Object value) {
        Long sequence = BrokerValues.exactLong(value);
        return sequence != null && sequence >= 0 && sequence <= 9007199254740991L;
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
            if (!CALLER_REFERENCE_FIELDS.contains(key) && !"dispatchMode".equals(key)) {
                throw new IllegalArgumentException(
                        "reference " + key + " is not allowed");
            }
        }
        Map<String, Object> identity = new LinkedHashMap<>();
        for (String field : List.of("sessionId", "promptId", "callId",
                "argsDigest")) {
            identity.put(field, BrokerValues.requireWellFormed(
                    referenceString(reference, field), "reference " + field));
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

    // The writer would send an unpaired surrogate as '?', and the Worker
    // would run that tool name or input instead of the caller's.
    private static String referenceToolName(Map<String, Object> reference) {
        return BrokerValues.requireWellFormed(
                referenceString(reference, "toolName"), "reference toolName");
    }

    private static Object referenceInput(Map<String, Object> reference) {
        Object input = reference.get("input");
        if (!(input instanceof Map)) {
            throw new IllegalArgumentException("reference input is required");
        }
        if (!BrokerValues.isWellFormedJson(input)) {
            throw new IllegalArgumentException(
                    "reference input must be JSON with well-formed text");
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
            BigDecimal sequence = BrokerValues.exactInteger(
                    fields.get("lastSequence"));
            if (!"status".equals(operation) || sequence == null
                    || sequence.signum() < 0) {
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
                RuntimeBrokerException providerError =
                        ProviderRuntimeProtocol.PATH.equals(path)
                                ? providerFailure(response, responseBody) : null;
                if (providerError != null) {
                    result.completeExceptionally(providerError);
                    return;
                }
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
                                + (responseLimit >= 1024 * 1024
                                        ? responseLimit / (1024 * 1024) + " MiB."
                                        : responseLimit / 1024 + " KiB."), false));
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

    private static RuntimeBrokerException providerFailure(
            HttpResponse<BoundedBody> response, BoundedBody body) {
        if (body.overflow()
                || !"no-store".equals(response.headers().firstValue("Cache-Control").orElse(""))
                || !jsonContentType(response.headers().firstValue("Content-Type").orElse(""))
                || response.headers().firstValue("Content-Encoding").isPresent()) {
            return null;
        }
        try {
            Map<String, Object> fields = ManagedContextProtocol.parse(body.bytes());
            if (!fields.keySet().equals(Set.of("code", "error"))
                    || !(fields.get("code") instanceof String code)
                    || !(fields.get("error") instanceof String message)
                    || message.isEmpty() || message.length() > 4096 || message.indexOf('\0') >= 0) {
                return null;
            }
            int expectedStatus = switch (code) {
                case "managed_runtime_provider_invalid", "managed_runtime_tool_invalid" -> 400;
                case "managed_runtime_identity_conflict", "managed_context_unavailable",
                        "managed_context_conflict", "managed_runtime_provider_operation_failed",
                        "managed_runtime_provider_incompatible" -> 409;
                case "managed_runtime_provider_too_large" -> 413;
                case "managed_runtime_provider_unsupported" -> 501;
                default -> 0;
            };
            if (response.statusCode() == expectedStatus) {
                return error(expectedStatus, code,
                        BrokerValues.requireWellFormed(message, "provider error"), false);
            }
        } catch (RuntimeBrokerException | IllegalArgumentException ignored) {
            // Unrecognized responses supply no provider-specific error evidence.
        }
        return null;
    }

    private static RuntimeBrokerException contextFailure(
            HttpResponse<BoundedBody> response, BoundedBody body, String path) {
        if (response.statusCode() == 501
                && (V3_EXECUTE_PATH.equals(path) || V3_STATUS_PATH.equals(path))) {
            return error(501, "runtime_tool_v3_unsupported",
                    "Managed Runtime does not support Tool v3.", false);
        }
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
        } catch (RuntimeBrokerException | IllegalArgumentException exception) {
            throw protocol("Managed Runtime attestation response is invalid.",
                    exception);
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
        if (!Long.valueOf(2L).equals(
                BrokerValues.exactLong(response.get("protocolVersion")))) {
            throw protocol("Managed Runtime " + operation
                    + " response is invalid.");
        }
    }

    private static long requiredPositiveLong(Map<String, Object> response,
            String field) {
        Long value = BrokerValues.exactLong(response.get(field));
        if (value == null || value <= 0) {
            throw protocol("Managed Runtime attestation response is invalid.");
        }
        return value;
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
        return protocol(message, null);
    }

    private static RuntimeBrokerException protocol(String message,
            Throwable cause) {
        return new RuntimeBrokerException(400,
                "managed_runtime_attestation_invalid", message, false, cause);
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

    static final class BoundedBody {
        private final byte[] bytes;
        private final boolean overflow;

        private BoundedBody(byte[] bytes, boolean overflow) {
            this.bytes = bytes;
            this.overflow = overflow;
        }

        byte[] bytes() {
            return bytes;
        }

        boolean overflow() {
            return overflow;
        }
    }

    /**
     * Stops reading once the cap is crossed. The buffer grows with the body,
     * so a small answer under a large cap stays small. A body that stalls
     * after the response headers is bounded by the stage deadline
     * ({@code orTimeout}), not by {@code HttpRequest.timeout}.
     */
    static final class BoundedBodySubscriber
            implements HttpResponse.BodySubscriber<BoundedBody> {
        private final int limit;
        private byte[] bytes;
        private int size;
        private final CompletableFuture<BoundedBody> body =
                new CompletableFuture<>();
        private Flow.Subscription subscription;

        BoundedBodySubscriber(int limit) {
            this.limit = limit;
            this.bytes = new byte[Math.min(limit, 8192)];
        }

        int capacity() {
            return bytes.length;
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
            // onNext never passes more than limit - size.
            if (count > bytes.length - size) {
                bytes = Arrays.copyOf(bytes, (int) Math.min(limit,
                        Math.max(2L * bytes.length, (long) size + count)));
            }
            buffer.get(bytes, size, count);
            size += count;
        }

        private byte[] copyOf(int length) {
            byte[] payload = new byte[length];
            System.arraycopy(bytes, 0, payload, 0, length);
            return payload;
        }
    }
}
