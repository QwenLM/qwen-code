package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExternalHttpRuntimeClientTest {
    private static final String TOKEN = "provider-test-token";

    @Test
    void sendsAuthenticatedBoundedJsonToConfiguredPrefix() throws Exception {
        var received = new AtomicReference<Map<String, Object>>();
        var authorization = new AtomicReference<String>();
        var cacheControl = new AtomicReference<String>();
        var contentType = new AtomicReference<String>();
        var accept = new AtomicReference<String>();
        var method = new AtomicReference<String>();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/runtime/provision", exchange -> {
            try (exchange) {
                authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                cacheControl.set(exchange.getRequestHeaders().getFirst("Cache-Control"));
                contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
                accept.set(exchange.getRequestHeaders().getFirst("Accept"));
                method.set(exchange.getRequestMethod());
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
            assertEquals("application/json", contentType.get());
            assertEquals("application/json", accept.get());
            assertEquals("POST", method.get());
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

    // The retryable set is exactly 408/429/5xx; every other non-200 is
    // permanent. 3xx is already pinned above (302 must not be retried).
    @ParameterizedTest
    @ValueSource(ints = {503, 429, 408, 404, 409})
    void classifiesProviderStatusesIntoTheRetryableSet(int status) throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/runtime/observe", exchange -> {
            try (exchange) {
                byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, body.length);
                exchange.getResponseBody().write(body);
            }
        });
        server.start();
        try {
            var error = assertThrows(CompletionException.class,
                    () -> client(server).observe(Map.of("protocolVersion", 1)).toCompletableFuture().join());
            var failure = (RuntimeBrokerException) error.getCause();
            assertEquals("runtime_external_provider_failed", failure.getCode());
            assertEquals(status, failure.getStatusCode());
            assertEquals(status == 408 || status == 429 || status >= 500, failure.isRetryable());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void refusesAnOversizedResponseEvenWhenItIsValidJson() throws Exception {
        byte[] oversized = JsonCodec.encode(Map.of("data", "A".repeat(64 * 1024)));
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/runtime/provision", exchange -> {
            try (exchange) {
                exchange.sendResponseHeaders(200, oversized.length);
                exchange.getResponseBody().write(oversized);
            }
        });
        server.start();
        try {
            var error = assertThrows(CompletionException.class,
                    () -> client(server).provision(Map.of("protocolVersion", 1)).toCompletableFuture().join());
            var failure = (RuntimeBrokerException) error.getCause();
            assertEquals("runtime_external_provider_failed", failure.getCode());
            assertEquals(502, failure.getStatusCode());
            assertFalse(failure.isRetryable());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void boundsRequestAndValidJsonResponseBytes() throws Exception {
        var response = new AtomicReference<byte[]>();
        var requests = new java.util.concurrent.atomic.AtomicInteger();
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/runtime/provision", exchange -> {
            try (exchange) {
                requests.incrementAndGet();
                byte[] body = response.get();
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            }
        });
        server.start();
        try {
            var client = client(server);
            var oversized = assertThrows(CompletionException.class,
                    () -> client.provision(Map.of("padding", "x".repeat(64 * 1024))).toCompletableFuture().join());
            assertEquals(400, ((RuntimeBrokerException) oversized.getCause()).getStatusCode());
            assertEquals(0, requests.get());
            int overhead = JsonCodec.encode(Map.of("protocolVersion", 1, "padding", "")).length;
            response.set(JsonCodec.encode(Map.of("protocolVersion", 1, "padding", "x".repeat(64 * 1024 - overhead))));
            client.provision(Map.of("protocolVersion", 1)).toCompletableFuture().join();
            response.set(JsonCodec.encode(Map.of("protocolVersion", 1, "padding", "x".repeat(64 * 1024 + 1 - overhead))));
            var overflow = assertThrows(CompletionException.class,
                    () -> client.provision(Map.of("protocolVersion", 1)).toCompletableFuture().join());
            var failure = (RuntimeBrokerException) overflow.getCause();
            assertEquals(502, failure.getStatusCode());
            assertFalse(failure.isRetryable());
        } finally {
            server.stop(0);
        }
    }

    // The request-level timeout is satisfied once headers arrive; a body
    // that then stalls past the deadline is what .orTimeout exists for.
    // The handler needs its own dispatch thread or this test deadlocks.
    @Test
    void timesOutAStalledResponseBodyAsRetryable() throws Exception {
        var releaseBody = new CountDownLatch(1);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var executor = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(executor);
        server.createContext("/runtime/observe", exchange -> {
            try {
                byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, body.length);
                releaseBody.await(30, TimeUnit.SECONDS);
                exchange.getResponseBody().write(body);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            var error = assertThrows(CompletionException.class,
                    () -> client(server).observe(Map.of("protocolVersion", 1)).toCompletableFuture().join());
            var failure = (RuntimeBrokerException) error.getCause();
            assertEquals("runtime_external_provider_failed", failure.getCode());
            assertEquals(503, failure.getStatusCode());
            assertTrue(failure.isRetryable());
        } finally {
            releaseBody.countDown();
            server.stop(0);
            executor.shutdownNow();
        }
    }

    @Test
    void refusesAmbiguousUrlsTokensClientsAndTimeoutsAtConstruction() {
        for (URI url : new URI[] {URI.create("ftp://provider.invalid"),
                URI.create("http://user@provider.invalid"),
                URI.create("http://provider.invalid/?x=1"),
                URI.create("http://provider.invalid/#section")}) {
            var error = assertThrows(IllegalArgumentException.class,
                    () -> new ExternalHttpRuntimeClient(url, TOKEN, Duration.ofSeconds(1)));
            assertTrue(error.getMessage().contains("HTTP(S)"), url + " -> " + error.getMessage());
        }
        var tokenError = assertThrows(IllegalArgumentException.class, () -> new ExternalHttpRuntimeClient(
                URI.create("http://provider.invalid"), "short-token", Duration.ofSeconds(1)));
        assertTrue(tokenError.getMessage().contains("safe characters"), tokenError.getMessage());
        var clientError = assertThrows(IllegalArgumentException.class, () -> new ExternalHttpRuntimeClient(
                URI.create("http://provider.invalid"), TOKEN,
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS).build(),
                Duration.ofSeconds(1)));
        assertTrue(clientError.getMessage().contains("Non-redirecting"), clientError.getMessage());
        var timeoutError = assertThrows(IllegalArgumentException.class, () -> new ExternalHttpRuntimeClient(
                URI.create("http://provider.invalid"), TOKEN,
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build(), Duration.ZERO));
        assertTrue(timeoutError.getMessage().contains("positive timeout"), timeoutError.getMessage());
    }

    private static ExternalHttpRuntimeClient client(HttpServer server) {
        return new ExternalHttpRuntimeClient(URI.create("http://127.0.0.1:"
                + server.getAddress().getPort() + "/runtime"), TOKEN, Duration.ofSeconds(2));
    }
}
