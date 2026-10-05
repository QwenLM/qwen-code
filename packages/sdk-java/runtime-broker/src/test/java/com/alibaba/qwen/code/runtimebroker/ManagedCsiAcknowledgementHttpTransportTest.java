package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.ManagedCsiAcknowledgementProtocolTest.fixtures;
import static com.alibaba.qwen.code.runtimebroker.ManagedCsiAcknowledgementProtocolTest.map;
import static com.alibaba.qwen.code.runtimebroker.ManagedCsiAcknowledgementProtocolTest.with;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ManagedCsiAcknowledgementHttpTransportTest {
    @Test
    void componentMockVerifiesOriginalHeadersExactWireAndRetryWithoutChangingGenericAck() throws Exception {
        var fixture = fixtures();
        var boot = map(fixture.get("boot"));
        var request = map(fixture.get("request"));
        var response = map(fixture.get("response"));
        var capture = map(response.get("captureIdentity"));
        var errors = new ConcurrentLinkedQueue<Throwable>();
        var calls = new AtomicInteger();
        var allowMutableReply = new CountDownLatch(1);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try {
                int call = calls.incrementAndGet();
                var context = map(boot.get("context"));
                assertEquals(ManagedCsiProtocol.ACKNOWLEDGE_PATH, exchange.getRequestURI().toString());
                assertEquals("POST", exchange.getRequestMethod());
                assertEquals("Bearer " + context.get("token"), exchange.getRequestHeaders().getFirst("Authorization"));
                assertEquals(context.get("leaseId"), exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Id"));
                assertEquals(context.get("epoch").toString(), exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Epoch"));
                assertEquals("no-store", exchange.getRequestHeaders().getFirst("Cache-Control"));
                assertEquals(request, ManagedCsiProtocol.parseAcknowledgement(exchange.getRequestBody().readAllBytes()));
                if (call == 3) {
                    assertTrue(allowMutableReply.await(2, TimeUnit.SECONDS));
                }
                byte[] bytes = JsonCodec.encode(response);
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (Throwable error) {
                errors.add(error);
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            var lease = ManagedCsiAcknowledgementProtocolTest.lease(boot,
                    URI.create("http://127.0.0.1:" + server.getAddress().getPort()));
            var session = ManagedCsiAcknowledgementProtocolTest.session(fixture);
            var pod = map(fixture.get("expectedPod"));
            var transport = new HttpRuntimeTransport();
            for (int index = 0; index < 2; index++) {
                assertEquals(response, transport.acknowledgeCsi(lease, session, boot, pod, request, capture).toCompletableFuture().join());
            }
            var mutableRequest = new java.util.LinkedHashMap<>(request);
            var mutableCapture = new java.util.LinkedHashMap<>(capture);
            var pending = transport.acknowledgeCsi(lease, session, boot, pod, mutableRequest, mutableCapture);
            mutableRequest.put("retirementId", "other");
            mutableCapture.put("bindingGeneration", "other");
            allowMutableReply.countDown();
            assertEquals(response, pending.toCompletableFuture().join());
            var foreign = new RuntimeLease("other", lease.getEndpoint(), lease.getToken(), lease.getLeaseId(), lease.getEpoch());
            assertThrows(IllegalArgumentException.class, () -> transport.acknowledgeCsi(foreign, session, boot, pod, request, capture));
            assertThrows(IllegalArgumentException.class, () -> transport.acknowledgeCsi(lease, session, boot, pod,
                    with(request, "reference", with(map(request.get("reference")), "sessionId", "other")), capture));
            var redirects = new HttpRuntimeTransport(HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS).build());
            assertThrows(IllegalArgumentException.class, () -> redirects.acknowledgeCsi(lease, session, boot, pod, request, capture));
            assertThrows(IllegalArgumentException.class, () -> transport.acknowledgeCsi(lease, session, boot, pod,
                    with(request, "protocolVersion", new BigDecimal("1.0")), capture));
            assertEquals(3, calls.get());
            assertEquals(List.of(), List.copyOf(errors));
            var unsupported = failure(() -> new UnsupportedTransport().acknowledgeCsi(lease, session, boot, pod, request, capture));
            assertEquals(501, unsupported.getStatusCode());
            assertEquals("workspace_csi_acknowledgement_unavailable", unsupported.getCode());
        } finally {
            allowMutableReply.countDown();
            server.stop(0);
        }
    }

    @Test
    void rejectsStrictBodyFailuresIdentityConflictsHeadersLimitsAndErrorBodies() throws Exception {
        var fixture = fixtures();
        var response = map(fixture.get("response"));
        var encoded = JsonCodec.encode(response);
        String json = new String(encoded, StandardCharsets.UTF_8);
        var replies = new ConcurrentLinkedQueue<>(List.of(
                new Reply(200, JsonCodec.encode(with(response, "state", "settled")), true, false),
                new Reply(200, JsonCodec.encode(with(response, "captureIdentity",
                        with(map(response.get("captureIdentity")), "bindingGeneration", "7"))), true, false),
                new Reply(200, (json + " {}").getBytes(StandardCharsets.UTF_8), true, false),
                new Reply(200, json.replace("\"state\":\"ACKNOWLEDGED\"", "\"state\":null,\"state\":\"ACKNOWLEDGED\"")
                        .getBytes(StandardCharsets.UTF_8), true, false),
                new Reply(200, new byte[] {(byte) 0xc3, 0x28}, true, false),
                new Reply(200, new byte[16 * 1024 + 1], true, false),
                new Reply(200, encoded, false, false),
                new Reply(200, encoded, true, true),
                new Reply(409, encoded, true, false),
                new Reply(401, encoded, true, false),
                new Reply(501, encoded, true, false)));
        int count = replies.size();
        int[] statuses = {409, 409, 409, 409, 409, 413, 400, 400, 409, 401, 501};
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try {
                exchange.getRequestBody().readAllBytes();
                Reply reply = replies.remove();
                if (reply.headers()) {
                    exchange.getResponseHeaders().set("Cache-Control", "no-store");
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                }
                if (reply.encoded()) {
                    exchange.getResponseHeaders().set("Content-Encoding", "gzip");
                }
                exchange.sendResponseHeaders(reply.status(), reply.body().length);
                exchange.getResponseBody().write(reply.body());
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            var boot = map(fixture.get("boot"));
            var lease = ManagedCsiAcknowledgementProtocolTest.lease(boot,
                    URI.create("http://127.0.0.1:" + server.getAddress().getPort()));
            var transport = new HttpRuntimeTransport();
            for (int index = 0; index < count; index++) {
                RuntimeBrokerException refused = failure(() -> transport.acknowledgeCsi(lease,
                        ManagedCsiAcknowledgementProtocolTest.session(fixture), boot, map(fixture.get("expectedPod")),
                        map(fixture.get("request")), map(response.get("captureIdentity"))));
                assertEquals(statuses[index], refused.getStatusCode(), "response " + index);
            }
            assertTrue(replies.isEmpty());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void totalDeadlineIncludesAResponseBodyThatNeverFinishes() throws Exception {
        var fixture = fixtures();
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try {
                exchange.getRequestBody().readAllBytes();
                exchange.getResponseHeaders().set("Cache-Control", "no-store");
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, 0);
                exchange.getResponseBody().write('{');
                exchange.getResponseBody().flush();
                entered.countDown();
                release.await(5, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // Client cancellation can close the exchange while its body is deliberately blocked.
            } finally {
                exchange.close();
            }
        });
        server.start();
        try {
            var boot = map(fixture.get("boot"));
            var lease = ManagedCsiAcknowledgementProtocolTest.lease(boot,
                    URI.create("http://127.0.0.1:" + server.getAddress().getPort()));
            var transport = new HttpRuntimeTransport(HttpClient.newHttpClient(), Duration.ofMillis(500));
            long start = System.nanoTime();
            var stage = transport.acknowledgeCsi(lease, ManagedCsiAcknowledgementProtocolTest.session(fixture),
                    boot, map(fixture.get("expectedPod")), map(fixture.get("request")),
                    map(map(fixture.get("response")).get("captureIdentity")));
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertEquals("managed_runtime_unavailable", failure(() -> stage).getCode());
            assertTrue(Duration.ofNanos(System.nanoTime() - start).compareTo(Duration.ofSeconds(3)) < 0);
        } finally {
            release.countDown();
            server.stop(0);
        }
    }

    private static RuntimeBrokerException failure(java.util.function.Supplier<CompletionStage<Map<String, Object>>> call) {
        return assertInstanceOf(RuntimeBrokerException.class,
                assertThrows(CompletionException.class, () -> call.get().toCompletableFuture().join()).getCause());
    }

    private record Reply(int status, byte[] body, boolean headers, boolean encoded) {
    }

    private static final class UnsupportedTransport implements RuntimeTransport {
        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease, RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(false);
        }
    }
}
