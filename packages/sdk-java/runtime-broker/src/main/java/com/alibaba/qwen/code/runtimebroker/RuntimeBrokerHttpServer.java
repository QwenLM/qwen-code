package com.alibaba.qwen.code.runtimebroker;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/** Reference HTTP adapter for the private Hosted Harness Broker contract. */
public final class RuntimeBrokerHttpServer implements AutoCloseable {
    public static final String ROUTE_PREFIX = "/internal/runtime-broker/v1";
    private static final int MAXIMUM_REQUEST_BYTES = 8 * 1024 * 1024;
    private final RuntimeBrokerService service;
    private final byte[] authorization;
    private final HttpServer server;
    private final ExecutorService executor;

    public RuntimeBrokerHttpServer(InetSocketAddress address, String token,
            RuntimeBrokerService service) throws IOException {
        if (address == null || service == null) {
            throw new IllegalArgumentException("address and service are required");
        }
        this.authorization = ("Bearer "
                + BrokerValues.requireId(token, "token"))
                .getBytes(StandardCharsets.UTF_8);
        this.service = service;
        this.server = HttpServer.create(address, 0);
        this.executor = Executors.newCachedThreadPool();
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
    }

    private void handle(HttpExchange exchange) {
        try {
            authorize(exchange);
            String path = exchange.getRequestURI().getRawPath();
            String relative = path.substring(ROUTE_PREFIX.length());
            if ("POST".equals(exchange.getRequestMethod())
                    && "/tool-sessions:acquire".equals(relative)) {
                acquire(exchange);
                return;
            }
            if ("POST".equals(exchange.getRequestMethod())
                    && "/executions".equals(relative)) {
                createExecution(exchange);
                return;
            }
            if (relative.startsWith("/tool-sessions/")) {
                toolSession(exchange, relative.substring(
                        "/tool-sessions/".length()));
                return;
            }
            if (relative.startsWith("/executions/")) {
                execution(exchange, relative.substring(
                        "/executions/".length()));
                return;
            }
            throw new RuntimeBrokerException(404,
                    "runtime_broker_route_not_found",
                    "Runtime Broker route was not found.", false);
        } catch (Throwable error) {
            sendError(exchange, error);
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
        complete(exchange, service.acquire(harnessSessionId, runtimeSessionId,
                turnKind), ignored -> envelope(harnessSessionId,
                        runtimeSessionId, "acquired", true));
    }

    private void toolSession(HttpExchange exchange, String suffix)
            throws IOException {
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
            Map<String, Object> operation = JsonCodec.requiredObject(body,
                    "operation", "control request");
            complete(exchange, service.control(harnessSessionId,
                    runtimeSessionId, operation), result -> envelope(
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
        throw new RuntimeBrokerException(404,
                "runtime_broker_route_not_found",
                "Runtime Broker route was not found.", false);
    }

    private void createExecution(HttpExchange exchange) throws IOException {
        Map<String, Object> body = requestBody(exchange,
                "execution request");
        requireProtocol(body);
        JsonCodec.requiredString(body, "requestId", "execution request");
        String idempotencyKey = JsonCodec.requiredString(body,
                "idempotencyKey", "execution request");
        String harnessSessionId = JsonCodec.requiredString(body,
                "harnessSessionId", "execution request");
        String runtimeSessionId = JsonCodec.requiredString(body,
                "runtimeSessionId", "execution request");
        Map<String, Object> snapshot = service.createExecution(idempotencyKey,
                harnessSessionId, runtimeSessionId,
                JsonCodec.requiredString(body, "turnId", "execution request"),
                JsonCodec.requiredString(body, "toolCallId",
                        "execution request"),
                JsonCodec.requiredString(body, "requestDigest",
                        "execution request"),
                JsonCodec.requiredObject(body, "reference",
                        "execution request"));
        sendJson(exchange, 200, executionEnvelope(harnessSessionId,
                runtimeSessionId, snapshot));
    }

    private void execution(HttpExchange exchange, String suffix)
            throws IOException {
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
            complete(exchange, service.cancelExecution(harnessSessionId,
                    runtimeSessionId, executionCallId), snapshot ->
                            executionEnvelope(harnessSessionId,
                                    runtimeSessionId, snapshot));
            return;
        }
        if ("GET".equals(exchange.getRequestMethod())
                && suffix.indexOf('/') < 0) {
            String executionCallId = pathId(suffix);
            Map<String, String> query = query(exchange.getRequestURI());
            requireQuery(query, "requestId");
            String harnessSessionId = requireQuery(query,
                    "harnessSessionId");
            String runtimeSessionId = requireQuery(query,
                    "runtimeSessionId");
            Long afterSequence = query.containsKey("afterSeq")
                    ? parseSequence(query.get("afterSeq")) : null;
            Map<String, Object> snapshot = service.getExecution(
                    harnessSessionId, runtimeSessionId, executionCallId,
                    afterSequence);
            sendJson(exchange, 200, executionEnvelope(harnessSessionId,
                    runtimeSessionId, snapshot));
            return;
        }
        throw new RuntimeBrokerException(404,
                "runtime_broker_route_not_found",
                "Runtime Broker route was not found.", false);
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

    private static void requireProtocol(Map<String, Object> body) {
        if (JsonCodec.requiredInt(body, "protocolVersion", "request") != 1) {
            throw new RuntimeBrokerException(409,
                    "runtime_broker_protocol_conflict",
                    "Runtime Broker protocol version changed.", false);
        }
    }

    private static Map<String, Object> requestBody(HttpExchange exchange,
            String context) throws IOException {
        int contentLength = 0;
        String rawLength = exchange.getRequestHeaders().getFirst(
                "Content-Length");
        if (rawLength != null) {
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

    private static String pathId(String raw) {
        String decoded = URLDecoder.decode(raw, StandardCharsets.UTF_8);
        if (decoded.indexOf('/') >= 0) {
            throw new RuntimeBrokerException(404,
                    "runtime_broker_route_not_found",
                    "Runtime Broker route was not found.", false);
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

    private static Long parseSequence(String raw) {
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
            Map<String, Object> snapshot) {
        Map<String, Object> response = envelope(harnessSessionId,
                runtimeSessionId, "executionCallId",
                snapshot.get("executionCallId"));
        response.put("status", snapshot.get("status"));
        return response;
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
        if (actual instanceof RuntimeBrokerException) {
            failure = (RuntimeBrokerException) actual;
        } else if (actual instanceof IllegalArgumentException) {
            failure = new RuntimeBrokerException(400,
                    "runtime_broker_invalid_request",
                    "Runtime Broker request is invalid.", false);
        } else {
            failure = new RuntimeBrokerException(500,
                    "runtime_broker_internal_error",
                    "Runtime Broker operation failed.", false);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", failure.getMessage());
        body.put("code", failure.getCode());
        body.put("retryable", failure.isRetryable());
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
