package com.alibaba.qwen.code.runtimebroker;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/**
 * Private HTTP face of the merged Runtime Broker for a Hosted Harness.
 *
 * <p>Immediate raw-tool dispatch and durable raw-tool or provider dispatch
 * share the original execution journal. Operator resolution is unavailable.
 */
public final class RuntimeBrokerHttpServer implements AutoCloseable {
    public static final String ROUTE_PREFIX = "/internal/runtime-broker/v1";
    private static final int MAXIMUM_REQUEST_BYTES = 8 * 1024 * 1024;
    private final RuntimeBrokerService service;
    private final byte[] authorization;
    private final HttpServer server;
    private final ExecutorService executor;

    public RuntimeBrokerHttpServer(InetSocketAddress address, String token,
            RuntimeBrokerService service) throws IOException {
        this(address, token, service, false);
    }

    /**
     * The face authenticates with one global Bearer token over plaintext
     * HTTP, so by default it only binds a loopback address. Serving beyond
     * loopback requires {@code allowNonLoopback} and a deployment that
     * terminates TLS and authorizes callers in front.
     */
    public RuntimeBrokerHttpServer(InetSocketAddress address, String token,
            RuntimeBrokerService service, boolean allowNonLoopback)
            throws IOException {
        if (address == null || service == null) {
            throw new IllegalArgumentException(
                    "address and service are required");
        }
        InetAddress bind = address.getAddress();
        if (!allowNonLoopback && (bind == null || !bind.isLoopbackAddress())) {
            throw new IllegalArgumentException("Runtime Broker serves one"
                    + " global token over plaintext HTTP and refuses a"
                    + " non-loopback listen address (" + address
                    + "); pass allowNonLoopback only behind a TLS-terminating"
                    + " layer that authorizes callers");
        }
        this.authorization = ("Bearer "
                + BrokerValues.requireId(token, "token"))
                .getBytes(StandardCharsets.UTF_8);
        this.service = service;
        this.server = HttpServer.create(address, 0);
        this.executor = Executors.newCachedThreadPool(task -> {
            Thread thread = new Thread(task, "runtime-broker-http");
            thread.setDaemon(true);
            return thread;
        });
        server.setExecutor(executor);
        server.createContext(ROUTE_PREFIX, this::handle);
    }

    public void start() {
        server.start();
    }

    public URI getBaseUri() {
        InetSocketAddress address = server.getAddress();
        String host = address.getAddress().getHostAddress();
        if (host.indexOf(':') >= 0) {
            host = "[" + host + "]";
        }
        return URI.create("http://" + host + ":" + address.getPort() + "/");
    }

    @Override
    public void close() {
        server.stop(0);
        executor.shutdownNow();
        service.close();
    }

    private void handle(HttpExchange exchange) {
        try {
            authorize(exchange);
            String path = exchange.getRequestURI().getRawPath();
            if (!path.startsWith(ROUTE_PREFIX)) {
                throw notFound();
            }
            String relative = path.substring(ROUTE_PREFIX.length());
            if ("POST".equals(exchange.getRequestMethod())
                    && "/runtimes:warm".equals(relative)) {
                Map<String, Object> body = requestBody(exchange, "warm request");
                requireProtocol(body);
                JsonCodec.requiredString(body, "requestId", "warm request");
                String sessionId = JsonCodec.requiredString(body, "harnessSessionId", "warm request");
                complete(exchange, service.warm(sessionId, lifecycleAuthority(exchange)), ignored -> Map.of(
                        "protocolVersion", 1, "harnessSessionId", sessionId, "ready", true));
                return;
            }
            if ("POST".equals(exchange.getRequestMethod()) && "/runtimes:authorize-lifecycle".equals(relative)) {
                Map<String, Object> body = requestBody(exchange, "lifecycle authorization");
                requireProtocol(body);
                String sessionId = JsonCodec.requiredString(body, "harnessSessionId", "lifecycle authorization");
                String runtimeSessionId = JsonCodec.requiredString(body, "runtimeSessionId", "lifecycle authorization");
                complete(exchange, service.authorizeLifecycle(sessionId, lifecycleAuthority(exchange)),
                        ignored -> envelope(sessionId, runtimeSessionId, "authorized", true));
                return;
            }
            if ("POST".equals(exchange.getRequestMethod())
                    && "/tool-sessions:acquire".equals(relative)) {
                acquire(exchange);
                return;
            }
            if ("POST".equals(exchange.getRequestMethod())
                    && "/executions:prepare".equals(relative)) {
                executionRequest(exchange, true);
                return;
            }
            if ("POST".equals(exchange.getRequestMethod())
                    && "/executions".equals(relative)) {
                executionRequest(exchange, false);
                return;
            }
            if (relative.startsWith("/tool-sessions/")) {
                toolSession(exchange, relative.substring(
                        "/tool-sessions/".length()));
                return;
            }
            if (relative.startsWith("/executions/")) {
                execution(exchange, relative.substring("/executions/"
                        .length()));
                return;
            }
            throw notFound();
        } catch (Throwable error) {
            sendError(exchange, error);
        }
    }

    private static RuntimeLifecycleAuthority lifecycleAuthority(HttpExchange exchange) {
        String operation = exchange.getRequestHeaders().getFirst(RuntimeLifecycleAuthority.OPERATION_HEADER);
        String generation = exchange.getRequestHeaders().getFirst(RuntimeLifecycleAuthority.GENERATION_HEADER);
        if (operation == null && generation == null) {
            return null;
        }
        try {
            return new RuntimeLifecycleAuthority(operation, Long.parseLong(generation));
        } catch (RuntimeException error) {
            throw new RuntimeBrokerException(400, "runtime_lifecycle_authority_invalid", "Invalid lifecycle authority", false);
        }
    }

    private void acquire(HttpExchange exchange) throws IOException {
        Map<String, Object> body = requestBody(exchange, "acquire request");
        requireProtocol(body);
        JsonCodec.requiredString(body, "requestId", "acquire request");
        String harnessSessionId = JsonCodec.requiredString(body,
                "harnessSessionId", "acquire request");
        String runtimeSessionId = JsonCodec.requiredString(body,
                "runtimeSessionId", "acquire request");
        String turnKind = JsonCodec.requiredString(body, "turnKind",
                "acquire request");
        CompletionStage<RuntimeSessionRecord> acquisition;
        if (body.containsKey("recoveryBindingId")) {
            acquisition = service.acquireRecovery(harnessSessionId, runtimeSessionId,
                    JsonCodec.requiredString(body, "recoveryBindingId", "acquire request"),
                    Long.parseLong(JsonCodec.requiredString(body, "recoveryGeneration", "acquire request")));
        } else {
            acquisition = service.acquire(harnessSessionId, runtimeSessionId, turnKind, lifecycleAuthority(exchange));
        }
        complete(exchange, acquisition, record -> {
            Map<String, Object> response = new LinkedHashMap<>(envelope(harnessSessionId,
                    runtimeSessionId, "acquired", true));
            RuntimeScope scope = record.getSession().getScope();
            response.put("scope", Map.of("tenantId", scope.getTenantId(),
                    "workspaceId", scope.getWorkspaceId(), "workspaceGeneration", scope.getWorkspaceGeneration(),
                    "capabilityDigest", scope.getCapabilityDigest()));
            response.put("runtime", Map.of("bindingId", record.getBindingId(),
                    "generation", Long.toString(record.getRuntimeGeneration())));
            return response;
        });
    }

    private void toolSession(HttpExchange exchange, String suffix)
            throws IOException {
        if ("POST".equals(exchange.getRequestMethod()) && suffix.endsWith(":publisher")) {
            String runtimeSessionId = pathId(suffix.substring(0, suffix.length() - ":publisher".length()));
            Map<String, Object> body = requestBody(exchange, "publisher request");
            requireProtocol(body);
            JsonCodec.requiredString(body, "requestId", "publisher request");
            String harnessSessionId = JsonCodec.requiredString(body, "harnessSessionId", "publisher request");
            if (!runtimeSessionId.equals(JsonCodec.requiredString(body, "runtimeSessionId", "publisher request"))) {
                throw new RuntimeBrokerException(409, "runtime_session_conflict", "Runtime Session identity differs", false);
            }
            complete(exchange, service.installPublisher(harnessSessionId, runtimeSessionId,
                    requiredObject(body, "publisher", "publisher request")), result -> {
                        Map<String, Object> response = envelope(harnessSessionId, runtimeSessionId,
                                "installed", result.get("installed"));
                        response.put("bindingGeneration", result.get("bindingGeneration"));
                        return response;
                    });
            return;
        }
        if ("POST".equals(exchange.getRequestMethod())
                && suffix.endsWith("/control")) {
            String runtimeSessionId = pathId(suffix.substring(0,
                    suffix.length() - "/control".length()));
            Map<String, Object> body = requestBody(exchange,
                    "control request");
            requireProtocol(body);
            JsonCodec.requiredString(body, "requestId", "control request");
            String harnessSessionId = JsonCodec.requiredString(body,
                    "harnessSessionId", "control request");
            Map<String, Object> operation = requiredObject(body, "operation",
                    "control request");
            complete(exchange, service.control(harnessSessionId,
                    runtimeSessionId, operation, lifecycleAuthority(exchange)), result -> envelope(
                            harnessSessionId, runtimeSessionId, "result",
                            result));
            return;
        }
        if ("POST".equals(exchange.getRequestMethod())
                && suffix.endsWith(":release")) {
            String runtimeSessionId = pathId(suffix.substring(0,
                    suffix.length() - ":release".length()));
            Map<String, Object> body = requestBody(exchange,
                    "release request");
            requireProtocol(body);
            JsonCodec.requiredString(body, "requestId", "release request");
            String harnessSessionId = JsonCodec.requiredString(body,
                    "harnessSessionId", "release request");
            complete(exchange, service.release(harnessSessionId,
                    runtimeSessionId), released -> envelope(harnessSessionId,
                            runtimeSessionId, "released", released));
            return;
        }
        throw notFound();
    }

    private void executionRequest(HttpExchange exchange, boolean prepare) throws IOException {
        Map<String, Object> body = requestBody(exchange, "execution request");
        requireProtocol(body);
        JsonCodec.requiredString(body, "requestId", "execution request");
        String idempotencyKey = JsonCodec.requiredString(body,
                "idempotencyKey", "execution request");
        String harnessSessionId = JsonCodec.requiredString(body,
                "harnessSessionId", "execution request");
        String runtimeSessionId = JsonCodec.requiredString(body,
                "runtimeSessionId", "execution request");
        String turnId = JsonCodec.requiredString(body, "turnId", "execution request");
        String callId = JsonCodec.requiredString(body, "toolCallId", "execution request");
        String digest = JsonCodec.requiredString(body, "requestDigest", "execution request");
        Map<String, Object> reference = requiredObject(body, "reference", "execution request");
        if (body.containsKey("toolProtocol")
                && (!prepare || !"v3".equals(body.get("toolProtocol")))) {
            throw new RuntimeBrokerException(400, "runtime_reference_invalid",
                    "Unsupported execution protocol selection", false);
        }
        if (prepare) {
            Set<String> preparedFields = new LinkedHashSet<>(Set.of("protocolVersion", "requestId",
                    "idempotencyKey", "harnessSessionId", "runtimeSessionId", "turnId", "toolCallId",
                    "requestDigest", "reference"));
            if (body.containsKey("toolProtocol")) {
                preparedFields.add("toolProtocol");
                preparedFields.add("publicationId");
            }
            if (!body.keySet().equals(preparedFields)) {
                throw new RuntimeBrokerException(400, "runtime_broker_invalid_request",
                        "Prepared execution fields are invalid.", false);
            }
        }
        if (prepare && (!runtimeSessionId.equals(reference.get("sessionId"))
                || !turnId.equals(reference.get("promptId"))
                || !callId.equals(reference.get("callId"))
                || (!"v3".equals(body.get("toolProtocol"))
                        && !digest.equals(reference.get("argsDigest"))))) {
            throw new RuntimeBrokerException(409, "runtime_reference_conflict",
                    "Execution envelope differs from its reference", false);
        }
        complete(exchange, prepare
                        ? service.prepareExecution(harnessSessionId, runtimeSessionId, idempotencyKey,
                        reference, "v3".equals(body.get("toolProtocol")) ? digest : null,
                        "v3".equals(body.get("toolProtocol"))
                                ? JsonCodec.requiredString(body, "publicationId", "execution request") : null)
                        : service.createExecution(harnessSessionId, runtimeSessionId, idempotencyKey, reference),
                record -> executionEnvelope(harnessSessionId,
                        runtimeSessionId, record));
    }

    private void execution(HttpExchange exchange, String suffix)
            throws IOException {
        if ("POST".equals(exchange.getRequestMethod()) && suffix.endsWith(":acknowledge")) {
            String executionCallId = pathId(suffix.substring(0, suffix.length() - ":acknowledge".length()));
            Map<String, Object> body = requestBody(exchange, "acknowledge request");
            requireProtocol(body);
            JsonCodec.requiredString(body, "requestId", "acknowledge request");
            String harnessSessionId = JsonCodec.requiredString(body, "harnessSessionId", "acknowledge request");
            String runtimeSessionId = JsonCodec.requiredString(body, "runtimeSessionId", "acknowledge request");
            complete(exchange, service.acknowledgeExecution(harnessSessionId, runtimeSessionId, executionCallId,
                    requiredObject(body, "receipt", "acknowledge request")), result -> {
                        Map<String, Object> response = envelope(harnessSessionId, runtimeSessionId,
                                "executionCallId", executionCallId);
                        response.put("status", result);
                        response.put("acknowledged", true);
                        return response;
                    });
            return;
        }
        if ("POST".equals(exchange.getRequestMethod())
                && suffix.endsWith(":start")) {
            String executionCallId = pathId(suffix.substring(0, suffix.length() - ":start".length()));
            Map<String, Object> body = requestBody(exchange, "start request");
            requireProtocol(body);
            Set<String> fields = new LinkedHashSet<>(List.of("protocolVersion", "requestId",
                    "harnessSessionId", "runtimeSessionId"));
            if (body.containsKey("payloadJson")) {
                fields.add("payloadJson");
                // A publication grant travels only with a raw-tool payload.
                if (body.containsKey("publicationId")) {
                    fields.add("publicationId");
                }
                if (body.containsKey("publicationToken")) {
                    fields.add("publicationToken");
                }
            }
            if (!body.keySet().equals(fields)) {
                throw new RuntimeBrokerException(400, "runtime_broker_invalid_request",
                        "Start request fields are invalid.", false);
            }
            JsonCodec.requiredString(body, "requestId", "start request");
            String harnessSessionId = JsonCodec.requiredString(body, "harnessSessionId", "start request");
            String runtimeSessionId = JsonCodec.requiredString(body, "runtimeSessionId", "start request");
            if (body.containsKey("payloadJson") && !(body.get("payloadJson") instanceof String)) {
                throw new RuntimeBrokerException(400, "runtime_payload_invalid", "payloadJson must be a string", false);
            }
            complete(exchange, (body.containsKey("payloadJson")
                            ? service.startExecution(harnessSessionId, runtimeSessionId, executionCallId,
                                    (String) body.get("payloadJson"),
                                    body.get("publicationId") instanceof String publicationId ? publicationId : null,
                                    body.get("publicationToken") instanceof String publicationToken
                                            ? publicationToken : null)
                            : service.startExecution(harnessSessionId, runtimeSessionId, executionCallId))
                    .thenCompose(record -> observe(harnessSessionId, runtimeSessionId, record, false, false)),
                    observation -> observedExecutionEnvelope(harnessSessionId, runtimeSessionId, observation));
            return;
        }
        if ("POST".equals(exchange.getRequestMethod())
                && suffix.endsWith(":cancel")) {
            String executionCallId = pathId(suffix.substring(0,
                    suffix.length() - ":cancel".length()));
            Map<String, Object> body = requestBody(exchange,
                    "cancel request");
            requireProtocol(body);
            JsonCodec.requiredString(body, "requestId", "cancel request");
            String harnessSessionId = JsonCodec.requiredString(body,
                    "harnessSessionId", "cancel request");
            String runtimeSessionId = JsonCodec.requiredString(body,
                    "runtimeSessionId", "cancel request");
            complete(exchange, service.cancelExecution(harnessSessionId, runtimeSessionId, executionCallId)
                    .thenCompose(record -> observe(harnessSessionId, runtimeSessionId, record, false, false)),
                    observation -> observedExecutionEnvelope(harnessSessionId, runtimeSessionId, observation));
            return;
        }
        if ("POST".equals(exchange.getRequestMethod())
                && suffix.endsWith(":resolve")) {
            throw unsupported();
        }
        if ("GET".equals(exchange.getRequestMethod())
                && suffix.indexOf('/') < 0) {
            String executionCallId = pathId(suffix);
            Map<String, String> query = query(exchange.getRequestURI());
            requireQuery(query, "requestId");
            String harnessSessionId = requireQuery(query, "harnessSessionId");
            String runtimeSessionId = requireQuery(query, "runtimeSessionId");
            if (query.containsKey("afterSeq")) {
                parseSequence(query.get("afterSeq"));
            }
            String reconcile = query.getOrDefault("reconcile", "false");
            if (!"true".equals(reconcile) && !"false".equals(reconcile)) {
                throw new RuntimeBrokerException(400, "runtime_broker_invalid_request",
                        "reconcile must be true or false.", false);
            }
            complete(exchange, service.getExecution(harnessSessionId, runtimeSessionId, executionCallId)
                    .thenCompose(record -> observe(harnessSessionId, runtimeSessionId, record,
                            Boolean.parseBoolean(reconcile), true)),
                    observation -> observedExecutionEnvelope(harnessSessionId, runtimeSessionId, observation));
            return;
        }
        throw notFound();
    }

    private CompletionStage<ExecutionReconciliation> observe(String harnessSessionId,
            String runtimeSessionId, ToolExecutionRecord record,
            boolean reconcile, boolean coolable) {
        // A lost dispatch is asked of the original Runtime when it can answer;
        // a tool v2 reference keeps its UNKNOWN unless reconciliation is requested.
        if (record.getState() != ToolExecutionRecord.State.UNKNOWN
                || (!reconcile && !record.observableAfterLoss())) {
            return CompletableFuture.completedFuture(new ExecutionReconciliation(record,
                    ExecutionReconciliation.Outcome.IN_FLIGHT, null));
        }
        // An explicit reconcile asks the Runtime every time, and a mutation's
        // own response never serves the cooldown cache; only pure polling
        // reuses a cooled answer.
        CompletionStage<ExecutionReconciliation> observation =
                reconcile || !coolable
                        ? service.reconcileExecution(harnessSessionId,
                                runtimeSessionId, record.getExecutionCallId())
                        : service.observeExecution(harnessSessionId,
                                runtimeSessionId, record.getExecutionCallId());
        if (reconcile) {
            return observation;
        }
        // The automatic ask is best-effort: when the original Runtime cannot be asked
        // or cannot answer, whatever the reason, the record's own UNKNOWN
        // stands rather than the error of the attempt.
        return observation.handle((reconciled, error) -> {
            if (error == null) {
                return reconciled;
            }
            Throwable cause = unwrap(error);
            if (cause instanceof Error) {
                throw new CompletionException(cause);
            }
            return new ExecutionReconciliation(record,
                    ExecutionReconciliation.Outcome.IN_FLIGHT, null);
        });
    }

    private static Map<String, Object> observedExecutionEnvelope(String harnessSessionId,
            String runtimeSessionId, ExecutionReconciliation observation) {
        ToolExecutionRecord record = observation.getRecord();
        String state = observation.getRuntimeState();
        // A provider call the worker still holds as prepared was never
        // started, and nothing dispatches it a second time: it stays UNKNOWN
        // for the caller, who would otherwise wait for it for ever.
        boolean neverStarted = "prepared".equals(state)
                && ProviderRuntimeProtocol.isReference(record.getReference());
        if (record.getState() == ToolExecutionRecord.State.UNKNOWN && !neverStarted
                && ("prepared".equals(state) || "executing".equals(state)
                    || "cancel_requested".equals(state))) {
            Map<String, Object> response = envelope(harnessSessionId, runtimeSessionId,
                    "executionCallId", record.getExecutionCallId());
            Map<String, Object> observedStatus = status(record);
            observedStatus.put("state", state);
            observedStatus.put("cancelRequested", record.isCancelRequested() || "cancel_requested".equals(state));
            response.put("status", observedStatus);
            return response;
        }
        return executionEnvelope(harnessSessionId, runtimeSessionId, record);
    }

    private void authorize(HttpExchange exchange) {
        String supplied = exchange.getRequestHeaders().getFirst(
                "Authorization");
        byte[] bytes = supplied == null ? new byte[0]
                : supplied.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(authorization, bytes)) {
            throw new RuntimeBrokerException(401,
                    "runtime_broker_unauthorized",
                    "Runtime Broker authentication failed.", false);
        }
    }

    private static RuntimeBrokerException unsupported() {
        return new RuntimeBrokerException(501,
                "runtime_broker_operation_unsupported",
                "Operator resolution is not implemented.",
                false);
    }

    private static void requireProtocol(Map<String, Object> body) {
        if (!Long.valueOf(1L).equals(
                BrokerValues.exactLong(body.get("protocolVersion")))) {
            throw new RuntimeBrokerException(409,
                    "runtime_broker_protocol_conflict",
                    "Runtime Broker protocol version changed.", false);
        }
    }

    private static Map<String, Object> requiredObject(
            Map<String, Object> body, String field, String context) {
        Object value = body.get(field);
        if (!(value instanceof Map)) {
            throw new RuntimeBrokerException(400,
                    "runtime_broker_invalid_request",
                    context + "." + field + " must be an object.", false);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> object = (Map<String, Object>) value;
        return object;
    }

    private static Map<String, Object> requestBody(HttpExchange exchange,
            String context) throws IOException {
        String rawLength = exchange.getRequestHeaders().getFirst(
                "Content-Length");
        if (rawLength != null) {
            int contentLength;
            try {
                contentLength = Integer.parseInt(rawLength);
            } catch (NumberFormatException exception) {
                throw new RuntimeBrokerException(400,
                        "runtime_broker_invalid_request",
                        "Content-Length is invalid.", false);
            }
            if (contentLength < 0 || contentLength > MAXIMUM_REQUEST_BYTES) {
                throw tooLarge();
            }
        }
        byte[] bytes;
        try (InputStream input = exchange.getRequestBody()) {
            bytes = input.readNBytes(MAXIMUM_REQUEST_BYTES + 1);
        }
        if (bytes.length > MAXIMUM_REQUEST_BYTES) {
            throw tooLarge();
        }
        return JsonCodec.parseObject(bytes, context);
    }

    private static RuntimeBrokerException tooLarge() {
        return new RuntimeBrokerException(413,
                "runtime_broker_request_too_large",
                "Runtime Broker request exceeded its limit.", false);
    }

    private static RuntimeBrokerException notFound() {
        return new RuntimeBrokerException(404,
                "runtime_broker_route_not_found",
                "Runtime Broker route was not found.", false);
    }

    private static String pathId(String raw) {
        String decoded = URLDecoder.decode(raw, StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0) {
            throw notFound();
        }
        return BrokerValues.requireId(decoded, "path id");
    }

    private static Map<String, String> query(URI uri) {
        Map<String, String> result = new LinkedHashMap<>();
        String raw = uri.getRawQuery();
        if (raw == null || raw.isEmpty()) {
            return result;
        }
        for (String pair : raw.split("&", -1)) {
            int separator = pair.indexOf('=');
            String key = URLDecoder.decode(separator < 0 ? pair
                    : pair.substring(0, separator), StandardCharsets.UTF_8);
            String value = URLDecoder.decode(separator < 0 ? ""
                    : pair.substring(separator + 1), StandardCharsets.UTF_8);
            if (result.putIfAbsent(key, value) != null) {
                throw new RuntimeBrokerException(400,
                        "runtime_broker_invalid_request",
                        "Runtime Broker query contains duplicate fields.",
                        false);
            }
        }
        return result;
    }

    private static String requireQuery(Map<String, String> query,
            String field) {
        String value = query.get(field);
        try {
            return BrokerValues.requireId(value, field);
        } catch (IllegalArgumentException exception) {
            throw new RuntimeBrokerException(400,
                    "runtime_broker_invalid_request",
                    "Runtime Broker query is incomplete.", false);
        }
    }

    private static long parseSequence(String raw) {
        try {
            long value = Long.parseLong(raw);
            if (value < 0) {
                throw new NumberFormatException();
            }
            return value;
        } catch (NumberFormatException exception) {
            throw new RuntimeBrokerException(400,
                    "runtime_broker_invalid_request",
                    "afterSeq must be a non-negative integer.", false);
        }
    }

    private static Map<String, Object> envelope(String harnessSessionId,
            String runtimeSessionId, String field, Object value) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("protocolVersion", 1);
        response.put("harnessSessionId", harnessSessionId);
        response.put("runtimeSessionId", runtimeSessionId);
        response.put(field, value);
        return response;
    }

    private static Map<String, Object> executionEnvelope(
            String harnessSessionId, String runtimeSessionId,
            ToolExecutionRecord record) {
        if (record.getState() == ToolExecutionRecord.State.ABANDONED) {
            throw new RuntimeBrokerException(409, "runtime_broker_execution_unknown",
                    "Runtime execution outcome is permanently unknown.", false, null,
                    Map.of("terminal", true, "reason", record.getAbandonmentReason(),
                            "executionCallId", record.getExecutionCallId()));
        }
        if (record.getState() == ToolExecutionRecord.State.UNKNOWN) {
            throw new RuntimeBrokerException(409,
                    "runtime_broker_execution_unknown",
                    "Runtime execution outcome is unknown.", false);
        }
        Map<String, Object> response = envelope(harnessSessionId,
                runtimeSessionId, "executionCallId",
                record.getExecutionCallId());
        response.put("status", status(record));
        response.put("runtimeBindingId", record.getBindingId());
        response.put("bindingGeneration", Long.toString(record.getRuntimeGeneration()));
        return response;
    }

    private static Map<String, Object> status(ToolExecutionRecord record) {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", wireState(record.getState()));
        status.put("cancelRequested", record.isCancelRequested());
        status.put("lastSeq", record.getLastSequence());
        boolean gap = record.getLastSequence() > 0;
        status.put("firstAvailableSeq", gap ? record.getLastSequence() : 0L);
        status.put("progressGap", gap);
        status.put("progress", List.of());
        if (record.isSettled()) {
            status.put("result", record.getResult());
        }
        return status;
    }

    // Package-private for the H0c contract test, which pins this mapping to
    // the wire statuses the Harness replays.
    static String wireState(ToolExecutionRecord.State state) {
        switch (state) {
            case PREPARED:
                return "prepared";
            case CANCEL_REQUESTED:
                return "cancel_requested";
            case SETTLED:
                return "settled";
            case DISPATCHING:
            case EXECUTING:
            case UNKNOWN:
            default:
                return "executing";
        }
    }

    private static <T> void complete(HttpExchange exchange,
            CompletionStage<T> operation,
            Function<T, Map<String, Object>> response) {
        operation.whenComplete((value, error) -> {
            if (error != null) {
                sendError(exchange, error);
                return;
            }
            try {
                sendJson(exchange, 200, response.apply(value));
            } catch (Throwable failure) {
                sendError(exchange, failure);
            }
        });
    }

    private static void sendError(HttpExchange exchange, Throwable error) {
        Throwable actual = unwrap(error);
        RuntimeBrokerException failure;
        if (actual instanceof RuntimeBrokerException brokerFailure) {
            failure = brokerFailure;
        } else if (actual instanceof IllegalArgumentException) {
            failure = new RuntimeBrokerException(400,
                    "runtime_broker_invalid_request",
                    "Runtime Broker request is invalid.", false);
        } else if (actual instanceof IllegalStateException
                && actual.getMessage() != null
                && actual.getMessage().contains("closed")) {
            failure = new RuntimeBrokerException(503,
                    "runtime_broker_closed",
                    "Runtime Broker is closed.", false);
        } else {
            failure = new RuntimeBrokerException(500,
                    "runtime_broker_internal_error",
                    "Runtime Broker operation failed.", false);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", failure.getMessage());
        body.put("code", failure.getCode());
        body.put("retryable", failure.isRetryable());
        if (!failure.getDetails().isEmpty()) {
            body.put("details", failure.getDetails());
        }
        try {
            sendJson(exchange, failure.getStatusCode(), body);
        } catch (IOException ignored) {
            exchange.close();
        }
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while (current instanceof CompletionException
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static void sendJson(HttpExchange exchange, int status,
            Map<String, Object> body) throws IOException {
        byte[] bytes = JsonCodec.encode(body);
        exchange.getResponseHeaders().set("Content-Type",
                "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }
}
