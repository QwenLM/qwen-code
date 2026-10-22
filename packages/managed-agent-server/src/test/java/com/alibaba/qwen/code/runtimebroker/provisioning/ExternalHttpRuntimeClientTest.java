package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ExternalHttpRuntimeClientTest {
    private static final String TOKEN = "provider-test-token";

    @Test
    void sendsAuthenticatedBoundedJsonToConfiguredPrefix() throws Exception {
        var received = new AtomicReference<Map<String, Object>>();
        var authorization = new AtomicReference<String>();
        var cacheControl = new AtomicReference<String>();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/runtime/provision", exchange -> {
            try (exchange) {
                authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                cacheControl.set(exchange.getRequestHeaders().getFirst("Cache-Control"));
                received.set(JsonCodec.parseObject(exchange.getRequestBody().readAllBytes(), "request"));
                byte[] body = JsonCodec.encode(Map.of("protocolVersion", 1, "handle", Map.of("sandboxId", "worker")));
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            }
        });
        server.start();
        try {
            var client = client(server);
            var request = Map.<String, Object>of("protocolVersion", 1, "provisionRequestId", "request-1");
            var result = client.provision(request).toCompletableFuture().join();
            assertEquals(request, received.get());
            assertEquals("Bearer " + TOKEN, authorization.get());
            assertEquals("no-store", cacheControl.get());
            assertEquals(Map.of("sandboxId", "worker"), result.get("handle"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void doesNotFollowRedirectsOrExposeProviderErrorBody() throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var redirected = new AtomicReference<Boolean>(false);
        server.createContext("/runtime/observe", exchange -> {
            try (exchange) {
                byte[] body = ("private details " + TOKEN).getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Location", "/credential-sink");
                exchange.sendResponseHeaders(302, body.length);
                exchange.getResponseBody().write(body);
            }
        });
        server.createContext("/credential-sink", exchange -> {
            redirected.set(true);
            exchange.close();
        });
        server.start();
        try {
            var error = assertThrows(CompletionException.class,
                    () -> client(server).observe(Map.of("protocolVersion", 1)).toCompletableFuture().join());
            var failure = (RuntimeBrokerException) error.getCause();
            assertEquals("runtime_external_provider_failed", failure.getCode());
            assertFalse(failure.isRetryable());
            assertFalse(failure.getMessage().contains(TOKEN));
            assertFalse(redirected.get());
        } finally {
            server.stop(0);
        }
    }

    private static ExternalHttpRuntimeClient client(HttpServer server) {
        return new ExternalHttpRuntimeClient(URI.create("http://127.0.0.1:"
                + server.getAddress().getPort() + "/runtime"), TOKEN, Duration.ofSeconds(2));
    }
}
