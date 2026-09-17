package com.alibaba.qwen.code.runtimebroker;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Process fixture for the Hosted Harness cold-Runtime E2E. */
public final class RuntimeBrokerFixtureMain {
    private static final int MAXIMUM_CONTROL_BYTES = 64 * 1024;

    private RuntimeBrokerFixtureMain() {
    }

    public static void main(String[] args) throws Exception {
        String brokerToken = requiredEnvironment("QWEN_BROKER_FIXTURE_TOKEN");
        String controlToken = requiredEnvironment(
                "QWEN_BROKER_FIXTURE_CONTROL_TOKEN");
        String runtimeToken = requiredEnvironment(
                "QWEN_BROKER_FIXTURE_RUNTIME_TOKEN");
        String leaseId = requiredEnvironment("QWEN_BROKER_FIXTURE_LEASE_ID");
        String workspace = requiredEnvironment(
                "QWEN_BROKER_FIXTURE_WORKSPACE");
        String workspaceId = requiredEnvironment(
                "QWEN_BROKER_FIXTURE_WORKSPACE_ID");

        RuntimeScope scope = new RuntimeScope("tenant-e2e", workspaceId,
                "generation-e2e", workspace, "capability-e2e", "workspace");
        CompletableFuture<RuntimeLease> runtimeReady =
                new CompletableFuture<>();
        AtomicInteger provisionCount = new AtomicInteger();
        AtomicInteger warmRequests = new AtomicInteger();
        AtomicInteger physicalAcquireCount = new AtomicInteger();
        AtomicInteger physicalExecutionCount = new AtomicInteger();
        AtomicLong provisionStartedAt = new AtomicLong(-1);
        AtomicLong runtimeReadyAt = new AtomicLong(-1);

        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(scope),
                ignored -> provision(runtimeReady, provisionCount,
                        provisionStartedAt),
                observedTransport(new HttpRuntimeTransport(),
                        physicalAcquireCount, physicalExecutionCount));
        RuntimeBrokerHttpServer broker = new RuntimeBrokerHttpServer(
                new InetSocketAddress("127.0.0.1", 0), brokerToken, service);
        HttpServer control = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService controlExecutor = Executors.newFixedThreadPool(2);
        byte[] expectedAuthorization = ("Bearer " + controlToken)
                .getBytes(StandardCharsets.UTF_8);
        control.setExecutor(controlExecutor);
        control.createContext("/fixture/warm", exchange -> warm(exchange,
                expectedAuthorization, service, warmRequests));
        control.createContext("/fixture/runtime-ready", exchange ->
                runtimeReady(exchange, expectedAuthorization, runtimeReady,
                        runtimeToken, leaseId, runtimeReadyAt));
        control.createContext("/fixture/status", exchange -> status(exchange,
                expectedAuthorization, provisionCount, warmRequests,
                physicalAcquireCount, physicalExecutionCount,
                provisionStartedAt, runtimeReadyAt));

        broker.start();
        control.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            control.stop(0);
            controlExecutor.shutdownNow();
            broker.close();
        }, "runtime-broker-fixture-shutdown"));

        Map<String, Object> ready = new LinkedHashMap<>();
        ready.put("brokerUrl", broker.getBaseUri().toString());
        ready.put("controlUrl", origin(control.getAddress()).toString());
        System.out.println("QWEN_RUNTIME_BROKER_FIXTURE "
                + new String(JsonCodec.encode(ready), StandardCharsets.UTF_8));
        System.out.flush();
        new CountDownLatch(1).await();
    }

    private static CompletableFuture<RuntimeLease> provision(
            CompletableFuture<RuntimeLease> runtimeReady,
            AtomicInteger provisionCount, AtomicLong provisionStartedAt) {
        provisionCount.incrementAndGet();
        provisionStartedAt.compareAndSet(-1, System.currentTimeMillis());
        return runtimeReady;
    }

    private static RuntimeTransport observedTransport(
            RuntimeTransport delegate, AtomicInteger physicalAcquireCount,
            AtomicInteger physicalExecutionCount) {
        return new RuntimeTransport() {
            @Override
            public CompletionStage<Void> acquire(RuntimeLease lease,
                    RuntimeSession session) {
                return observe("acquire", delegate.acquire(lease, session))
                        .thenApply(ignored -> {
                            physicalAcquireCount.incrementAndGet();
                            return null;
                        });
            }

            @Override
            public CompletionStage<Object> control(RuntimeLease lease,
                    RuntimeSession session, Map<String, Object> operation) {
                return observe("control", delegate.control(lease, session,
                        operation));
            }

            @Override
            public CompletionStage<Map<String, Object>> execute(
                    RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> reference) {
                physicalExecutionCount.incrementAndGet();
                return observe("execute", delegate.execute(lease, session,
                        reference));
            }

            @Override
            public CompletionStage<Map<String, Object>> cancel(
                    RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> reference) {
                return observe("cancel", delegate.cancel(lease, session,
                        reference));
            }

            @Override
            public CompletionStage<Boolean> release(RuntimeLease lease,
                    RuntimeSession session) {
                return observe("release", delegate.release(lease, session));
            }
        };
    }

    private static <T> CompletionStage<T> observe(String operation,
            CompletionStage<T> stage) {
        return stage.whenComplete((value, error) -> {
            if (error != null) {
                System.err.println("QWEN_RUNTIME_BROKER_"
                        + operation.toUpperCase() + "_FAILED " + error);
                error.printStackTrace(System.err);
                System.err.flush();
            }
        });
    }

    private static void warm(HttpExchange exchange,
            byte[] expectedAuthorization, RuntimeBrokerService service,
            AtomicInteger warmRequests) throws IOException {
        try {
            authorize(exchange, expectedAuthorization);
            if (!"POST".equals(exchange.getRequestMethod())) {
                send(exchange, 405, Map.of("error", "method_not_allowed"));
                return;
            }
            byte[] bytes = exchange.getRequestBody().readNBytes(
                    MAXIMUM_CONTROL_BYTES + 1);
            if (bytes.length > MAXIMUM_CONTROL_BYTES) {
                send(exchange, 413, Map.of("error", "request_too_large"));
                return;
            }
            Map<String, Object> body = JsonCodec.parseObject(bytes,
                    "fixture warm request");
            String harnessSessionId = JsonCodec.requiredString(body,
                    "harnessSessionId", "fixture warm request");
            warmRequests.incrementAndGet();
            service.warm(harnessSessionId).whenComplete((ignored, error) -> {
                if (error != null) {
                    System.out.println("QWEN_RUNTIME_BROKER_WARM_FAILED");
                    System.out.flush();
                }
            });
            send(exchange, 202, Map.of("accepted", true));
        } catch (RuntimeBrokerException error) {
            send(exchange, error.getStatusCode(),
                    Map.of("error", error.getCode()));
        } catch (IllegalArgumentException error) {
            send(exchange, 400, Map.of("error", "invalid_request"));
        }
    }

    private static void runtimeReady(HttpExchange exchange,
            byte[] expectedAuthorization,
            CompletableFuture<RuntimeLease> runtimeReady,
            String runtimeToken, String leaseId, AtomicLong runtimeReadyAt)
            throws IOException {
        try {
            authorize(exchange, expectedAuthorization);
            if (!"POST".equals(exchange.getRequestMethod())) {
                send(exchange, 405, Map.of("error", "method_not_allowed"));
                return;
            }
            byte[] bytes = exchange.getRequestBody().readNBytes(
                    MAXIMUM_CONTROL_BYTES + 1);
            if (bytes.length > MAXIMUM_CONTROL_BYTES) {
                send(exchange, 413, Map.of("error", "request_too_large"));
                return;
            }
            Map<String, Object> body = JsonCodec.parseObject(bytes,
                    "fixture runtime-ready request");
            URI runtimeUrl = URI.create(JsonCodec.requiredString(body,
                    "runtimeUrl", "fixture runtime-ready request"));
            long readyAt = System.currentTimeMillis();
            if (!runtimeReadyAt.compareAndSet(-1, readyAt)) {
                send(exchange, 409,
                        Map.of("error", "runtime_already_ready"));
                return;
            }
            runtimeReady.complete(new RuntimeLease("runtime-e2e", runtimeUrl,
                    runtimeToken, leaseId, 1));
            System.out.println("QWEN_RUNTIME_BROKER_RUNTIME_READY " + readyAt);
            System.out.flush();
            send(exchange, 200, Map.of("ready", true));
        } catch (RuntimeBrokerException error) {
            send(exchange, error.getStatusCode(),
                    Map.of("error", error.getCode()));
        } catch (IllegalArgumentException error) {
            send(exchange, 400, Map.of("error", "invalid_request"));
        }
    }

    private static void status(HttpExchange exchange,
            byte[] expectedAuthorization, AtomicInteger provisionCount,
            AtomicInteger warmRequests, AtomicInteger physicalAcquireCount,
            AtomicInteger physicalExecutionCount,
            AtomicLong provisionStartedAt, AtomicLong runtimeReadyAt)
            throws IOException {
        try {
            authorize(exchange, expectedAuthorization);
            if (!"GET".equals(exchange.getRequestMethod())) {
                send(exchange, 405, Map.of("error", "method_not_allowed"));
                return;
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("provisionCount", provisionCount.get());
            body.put("warmRequests", warmRequests.get());
            body.put("physicalAcquireCount", physicalAcquireCount.get());
            body.put("physicalExecutionCount", physicalExecutionCount.get());
            body.put("provisionStartedAtEpochMillis",
                    provisionStartedAt.get());
            body.put("runtimeReadyAtEpochMillis", runtimeReadyAt.get());
            send(exchange, 200, body);
        } catch (RuntimeBrokerException error) {
            send(exchange, 401, Map.of("error", "unauthorized"));
        }
    }

    private static void authorize(HttpExchange exchange, byte[] expected) {
        String supplied = exchange.getRequestHeaders().getFirst(
                "Authorization");
        byte[] actual = supplied == null ? new byte[0]
                : supplied.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(expected, actual)) {
            throw new RuntimeBrokerException(401, "fixture_unauthorized",
                    "Fixture authentication failed.", false);
        }
    }

    private static void send(HttpExchange exchange, int status,
            Map<String, Object> body) throws IOException {
        byte[] bytes = JsonCodec.encode(body);
        exchange.getResponseHeaders().set("Content-Type",
                "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static URI origin(InetSocketAddress address) {
        return URI.create("http://127.0.0.1:" + address.getPort() + "/");
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
