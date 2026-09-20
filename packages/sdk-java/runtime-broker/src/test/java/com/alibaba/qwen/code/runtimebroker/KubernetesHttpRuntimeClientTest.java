package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class KubernetesHttpRuntimeClientTest {
    @Test
    void serviceAccountCredentialsRequireHttps() {
        assertThrows(IllegalArgumentException.class, () ->
                KubernetesHttpRuntimeClient.fromServiceAccount(
                        URI.create("http://127.0.0.1:6443"),
                        Path.of("missing-token"), Path.of("missing-ca")));
    }

    @Test
    void usesCoreV1AndUidDeletePreconditions() throws Exception {
        Map<String, Map<String, Object>> resources =
                new ConcurrentHashMap<>();
        List<String> authorizations = new ArrayList<>();
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/namespaces/", exchange ->
                respond(exchange, resources, authorizations));
        server.start();
        try {
            URI apiServer = URI.create("http://127.0.0.1:"
                    + server.getAddress().getPort());
            KubernetesHttpRuntimeClient client =
                    new KubernetesHttpRuntimeClient(apiServer, "api-token");
            assertNull(client.getSecret("runtime-ns", "runtime-a")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));

            Map<String, Object> created = client.createSecret("runtime-ns",
                    "runtime-a", resource("Secret", "runtime-ns",
                            "runtime-a")).toCompletableFuture()
                    .get(1, TimeUnit.SECONDS);
            assertEquals("secret-uid", object(created, "metadata")
                    .get("uid"));
            assertNotNull(client.getSecret("runtime-ns", "runtime-a")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));

            assertThrows(Exception.class, () -> client.deleteSecret(
                    "runtime-ns", "runtime-a", "wrong-uid", "1")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));
            assertNotNull(client.getSecret("runtime-ns", "runtime-a")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));
            client.deleteSecret("runtime-ns", "runtime-a", "secret-uid",
                    "1").toCompletableFuture().get(1, TimeUnit.SECONDS);
            assertNull(client.getSecret("runtime-ns", "runtime-a")
                    .toCompletableFuture().get(1, TimeUnit.SECONDS));
            assertTrue(authorizations.stream().allMatch(
                    "Bearer api-token"::equals));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void treatsAuthorizationRejectionAsNonRetryable() throws Exception {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> write(exchange, 403,
                Map.of("kind", "Status")));
        server.start();
        try {
            KubernetesHttpRuntimeClient client =
                    new KubernetesHttpRuntimeClient(URI.create(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort()),
                            "api-token");
            Exception failure = assertThrows(Exception.class, () ->
                    client.getPod("runtime-ns", "runtime-a")
                            .toCompletableFuture()
                            .get(1, TimeUnit.SECONDS));
            Throwable cause = failure;
            while (cause.getCause() != null
                    && !(cause instanceof RuntimeBrokerException)) {
                cause = cause.getCause();
            }
            RuntimeBrokerException rejected =
                    (RuntimeBrokerException) cause;
            assertEquals("runtime_broker_scheduler_rejected",
                    rejected.getCode());
            assertFalse(rejected.isRetryable());
        } finally {
            server.stop(0);
        }
    }

    private static void respond(HttpExchange exchange,
            Map<String, Map<String, Object>> resources,
            List<String> authorizations) throws IOException {
        authorizations.add(exchange.getRequestHeaders().getFirst(
                "Authorization"));
        String path = exchange.getRequestURI().getPath();
        if ("GET".equals(exchange.getRequestMethod())) {
            Map<String, Object> resource = resources.get(path);
            write(exchange, resource == null ? 404 : 200,
                    resource == null ? Map.of("kind", "Status") : resource);
            return;
        }
        if ("POST".equals(exchange.getRequestMethod())) {
            Map<String, Object> body = JsonCodec.parseObject(
                    exchange.getRequestBody().readAllBytes(), "create");
            Map<String, Object> metadata = new LinkedHashMap<>(
                    object(body, "metadata"));
            String name = (String) metadata.get("name");
            metadata.put("uid", path.endsWith("/secrets")
                    ? "secret-uid" : "pod-uid");
            metadata.put("resourceVersion", "1");
            Map<String, Object> created = new LinkedHashMap<>(body);
            created.put("metadata", metadata);
            resources.put(path + "/" + name, created);
            write(exchange, 201, created);
            return;
        }
        if ("DELETE".equals(exchange.getRequestMethod())) {
            Map<String, Object> options = JsonCodec.parseObject(
                    exchange.getRequestBody().readAllBytes(), "delete");
            String expectedUid = (String) object(options,
                    "preconditions").get("uid");
            Map<String, Object> current = resources.get(path);
            String actualUid = current == null ? null
                    : (String) object(current, "metadata").get("uid");
            if (current == null) {
                write(exchange, 404, Map.of("kind", "Status"));
            } else if (!expectedUid.equals(actualUid)) {
                write(exchange, 409, Map.of("kind", "Status"));
            } else {
                resources.remove(path);
                write(exchange, 200, Map.of("kind", "Status"));
            }
            return;
        }
        write(exchange, 405, Map.of("kind", "Status"));
    }

    private static Map<String, Object> resource(String kind,
            String namespace, String name) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("apiVersion", "v1");
        value.put("kind", kind);
        value.put("metadata", Map.of("namespace", namespace, "name", name));
        return value;
    }

    private static void write(HttpExchange exchange, int status,
            Map<String, Object> body) throws IOException {
        byte[] encoded = JsonCodec.encode(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, encoded.length);
        exchange.getResponseBody().write(encoded);
        exchange.close();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Map<String, Object> parent,
            String field) {
        return (Map<String, Object>) parent.get(field);
    }
}
