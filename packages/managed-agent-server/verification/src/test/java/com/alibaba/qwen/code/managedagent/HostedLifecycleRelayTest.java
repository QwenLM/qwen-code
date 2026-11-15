package com.alibaba.qwen.code.managedagent;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HostedLifecycleRelayTest {
    @Test
    @Timeout(15)
    void preservesEndToEndHeadersAndDropsConnectionNominatedHeaders() throws Exception {
        var backend = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var calls = new AtomicInteger();
        backend.createContext("/", exchange -> {
            assertThat(exchange.getRequestURI().toString()).isEqualTo("/session/s/lifecycle?claim=2");
            assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer fixture");
            assertThat(exchange.getRequestHeaders().getFirst("X-Qwen-Lifecycle-Claim-Generation")).isEqualTo("2");
            assertThat(exchange.getRequestHeaders().getFirst("X-Request-Hop")).isNull();
            assertThat(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).isEqualTo("body");
            calls.incrementAndGet();
            exchange.getResponseHeaders().set("Connection", "X-Response-Hop");
            exchange.getResponseHeaders().set("X-Response-Hop", "hidden");
            exchange.getResponseHeaders().set("X-Qwen-Harness-Boot-Id", "original");
            exchange.sendResponseHeaders(200, 4);
            exchange.getResponseBody().write("done".getBytes(StandardCharsets.UTF_8));
            exchange.close();
        });
        backend.start();
        try (var relay = new HostedLifecycleRelay(); var socket = new Socket("127.0.0.1", relay.uri().getPort())) {
            relay.backend(URI.create("http://127.0.0.1:" + backend.getAddress().getPort()));
            socket.setSoTimeout(5000);
            socket.getOutputStream().write(("POST /session/s/lifecycle?claim=2 HTTP/1.1\r\nHost: fixture\r\n"
                    + "Authorization: Bearer fixture\r\nX-Qwen-Lifecycle-Claim-Generation: 2\r\n"
                    + "Connection: close, X-Request-Hop\r\nX-Request-Hop: hidden\r\nContent-Length: 4\r\n\r\nbody")
                    .getBytes(StandardCharsets.UTF_8));
            var bytes = new java.io.ByteArrayOutputStream();
            for (int value; (value = socket.getInputStream().read()) != -1;) {
                bytes.write(value);
                if (bytes.toString(StandardCharsets.UTF_8).endsWith("\r\n0\r\n\r\n")) {
                    break;
                }
            }
            String response = bytes.toString(StandardCharsets.UTF_8).toLowerCase(java.util.Locale.ROOT);
            assertThat(response).contains("200 ok", "x-qwen-harness-boot-id: original", "done").doesNotContain("x-response-hop");
            assertThat(calls.get()).isEqualTo(1);
            assertThat(relay.failure()).isNull();
        } finally {
            backend.stop(0);
        }
    }

    @Test
    @Timeout(15)
    void dropsAnAppliedReplyWithoutReplayingAndThenSwitchesBackend() throws Exception {
        var first = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var second = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var applied = new AtomicInteger();
        first.createContext("/", exchange -> {
            applied.incrementAndGet();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        second.createContext("/", exchange -> {
            exchange.sendResponseHeaders(200, 3);
            exchange.getResponseBody().write("new".getBytes(StandardCharsets.UTF_8));
            exchange.close();
        });
        first.start();
        second.start();
        try (var relay = new HostedLifecycleRelay(); var client = HttpClient.newHttpClient()) {
            relay.backend(URI.create("http://127.0.0.1:" + first.getAddress().getPort()));
            relay.fault(new HostedLifecycleRelay.Fault() {
                public boolean after(HostedLifecycleRelay.Request request, int status) {
                    assertThat(status).isEqualTo(204);
                    return false;
                }
            });
            var request = HttpRequest.newBuilder(relay.uri().resolve("/detach")).timeout(Duration.ofSeconds(5))
                    .POST(HttpRequest.BodyPublishers.ofString("{}")).build();
            assertThatThrownBy(() -> client.send(request, HttpResponse.BodyHandlers.ofString())).isInstanceOf(IOException.class);
            assertThat(applied.get()).isEqualTo(1);
            relay.fault(new HostedLifecycleRelay.Fault() { });
            relay.backend(URI.create("http://127.0.0.1:" + second.getAddress().getPort()));
            assertThat(client.send(request, HttpResponse.BodyHandlers.ofString()).body()).isEqualTo("new");
            assertThat(applied.get()).isEqualTo(1);
            assertThat(relay.failure()).isNull();
        } finally {
            first.stop(0);
            second.stop(0);
        }
    }

    @Test
    @Timeout(15)
    void forwardsAStreamingPrefixBeforeTheBackendCloses() throws Exception {
        var finish = new CountDownLatch(1);
        var backend = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        backend.createContext("/", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write("first".getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
            try {
                finish.await(10, TimeUnit.SECONDS);
            }
            catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
            exchange.getResponseBody().write("last".getBytes(StandardCharsets.UTF_8));
            exchange.close();
        });
        backend.start();
        try (var relay = new HostedLifecycleRelay(); var client = HttpClient.newHttpClient()) {
            relay.backend(URI.create("http://127.0.0.1:" + backend.getAddress().getPort()));
            var response = client.sendAsync(HttpRequest.newBuilder(relay.uri().resolve("/stream")).build(),
                    HttpResponse.BodyHandlers.ofInputStream()).get(5, TimeUnit.SECONDS);
            try (var body = response.body()) {
                assertThat(new String(body.readNBytes(5), StandardCharsets.UTF_8)).isEqualTo("first");
                assertThat(finish.getCount()).isEqualTo(1);
                finish.countDown();
                assertThat(new String(body.readAllBytes(), StandardCharsets.UTF_8)).isEqualTo("last");
            }
            assertThat(relay.failure()).isNull();
        } finally {
            finish.countDown();
            backend.stop(0);
        }
    }
}
