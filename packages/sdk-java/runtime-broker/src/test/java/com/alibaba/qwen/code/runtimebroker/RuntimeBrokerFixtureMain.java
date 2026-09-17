package com.alibaba.qwen.code.runtimebroker;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
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
        String workspace = requiredEnvironment(
                "QWEN_BROKER_FIXTURE_WORKSPACE");
        String workspaceId = requiredEnvironment(
                "QWEN_BROKER_FIXTURE_WORKSPACE_ID");
        Path nodeExecutable = Path.of(requiredEnvironment(
                "QWEN_BROKER_FIXTURE_NODE"));
        Path workerEntry = Path.of(requiredEnvironment(
                "QWEN_BROKER_FIXTURE_WORKER_ENTRY"));
        Path cliEntry = Path.of(requiredEnvironment(
                "QWEN_BROKER_FIXTURE_CLI_ENTRY"));
        Path stateDirectory = Path.of(requiredEnvironment(
                "QWEN_BROKER_FIXTURE_STATE_DIRECTORY"));
        long startupDelayMillis = Long.parseLong(requiredEnvironment(
                "QWEN_BROKER_FIXTURE_START_DELAY_MS"));

        RuntimeScope scope = new RuntimeScope("tenant-e2e", workspaceId,
                "generation-e2e", workspace, "capability-e2e", "workspace");
        AtomicInteger provisionCount = new AtomicInteger();
        AtomicInteger warmRequests = new AtomicInteger();
        AtomicInteger physicalAcquireCount = new AtomicInteger();
        AtomicInteger physicalExecutionCount = new AtomicInteger();
        AtomicInteger physicalCancelCount = new AtomicInteger();
        Set<String> acquiredHarnessSessionIds =
                ConcurrentHashMap.newKeySet();
        Set<String> executedHarnessSessionIds =
                ConcurrentHashMap.newKeySet();
        AtomicLong provisionStartedAt = new AtomicLong(-1);
        AtomicLong runtimeReadyAt = new AtomicLong(-1);
        ExecutorService runtimeExecutor = Executors.newCachedThreadPool(
                runnable -> daemonThread(runnable, "runtime-fixture-worker"));
        LocalProcessRuntimeProvisioner localProvisioner =
                new LocalProcessRuntimeProvisioner(stateDirectory,
                        delayedWorkerCommand(startupDelayMillis,
                                nodeExecutable, workerEntry), cliEntry,
                        runtimeEnvironment(), 4, Duration.ofSeconds(60),
                        Duration.ofSeconds(2), Duration.ofSeconds(5),
                        Duration.ofSeconds(5), HttpClient.newBuilder()
                                .version(HttpClient.Version.HTTP_1_1)
                                .connectTimeout(Duration.ofSeconds(2))
                                .followRedirects(HttpClient.Redirect.NEVER)
                                .build(), runtimeExecutor);

        RuntimeBrokerService service = new RuntimeBrokerService(
                ignored -> CompletableFuture.completedFuture(scope),
                observedProvisioner(localProvisioner, provisionCount,
                        provisionStartedAt, runtimeReadyAt),
                observedTransport(new HttpRuntimeTransport(),
                        physicalAcquireCount, physicalExecutionCount,
                        physicalCancelCount, acquiredHarnessSessionIds,
                        executedHarnessSessionIds));
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
        control.createContext("/fixture/status", exchange -> status(exchange,
                expectedAuthorization, provisionCount, warmRequests,
                physicalAcquireCount, physicalExecutionCount,
                physicalCancelCount,
                acquiredHarnessSessionIds, executedHarnessSessionIds,
                provisionStartedAt, runtimeReadyAt, localProvisioner));

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

    private static RuntimeProvisioner observedProvisioner(
            LocalProcessRuntimeProvisioner delegate,
            AtomicInteger provisionCount, AtomicLong provisionStartedAt,
            AtomicLong runtimeReadyAt) {
        return new RuntimeProvisioner() {
            @Override
            public CompletionStage<RuntimeLease> provision(
                    RuntimeProvisionRequest request) {
                provisionCount.incrementAndGet();
                provisionStartedAt.compareAndSet(-1,
                        System.currentTimeMillis());
                return delegate.provision(request).whenComplete(
                        (lease, error) -> {
                            if (error == null) {
                                runtimeReadyAt.compareAndSet(-1,
                                        System.currentTimeMillis());
                            } else {
                                System.err.println(
                                        "QWEN_RUNTIME_BROKER_PROVISION_FAILED");
                                error.printStackTrace(System.err);
                                System.err.flush();
                            }
                        });
            }

            @Override
            public CompletionStage<Void> drain(
                    RuntimeProvisionRequest request, RuntimeLease lease) {
                return delegate.drain(request, lease);
            }

            @Override
            public CompletionStage<Void> release(
                    RuntimeProvisionRequest request, RuntimeLease lease) {
                return delegate.release(request, lease);
            }

            @Override
            public CompletionStage<Boolean> health(RuntimeLease lease) {
                return delegate.health(lease);
            }

            @Override
            public void close() {
                delegate.close();
            }
        };
    }

    private static RuntimeTransport observedTransport(
            RuntimeTransport delegate, AtomicInteger physicalAcquireCount,
            AtomicInteger physicalExecutionCount,
            AtomicInteger physicalCancelCount,
            Set<String> acquiredHarnessSessionIds,
            Set<String> executedHarnessSessionIds) {
        return new RuntimeTransport() {
            @Override
            public CompletionStage<Void> acquire(RuntimeLease lease,
                    RuntimeSession session) {
                return observe("acquire", delegate.acquire(lease, session))
                        .thenApply(ignored -> {
                            physicalAcquireCount.incrementAndGet();
                            acquiredHarnessSessionIds.add(
                                    session.getHarnessSessionId());
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
                executedHarnessSessionIds.add(
                        session.getHarnessSessionId());
                return observe("execute", delegate.execute(lease, session,
                        reference));
            }

            @Override
            public CompletionStage<Map<String, Object>> cancel(
                    RuntimeLease lease, RuntimeSession session,
                    Map<String, Object> reference) {
                return observe("cancel", delegate.cancel(lease, session,
                        reference)).thenApply(status -> {
                            physicalCancelCount.incrementAndGet();
                            return status;
                        });
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

    private static void status(HttpExchange exchange,
            byte[] expectedAuthorization, AtomicInteger provisionCount,
            AtomicInteger warmRequests, AtomicInteger physicalAcquireCount,
            AtomicInteger physicalExecutionCount,
            AtomicInteger physicalCancelCount,
            Set<String> acquiredHarnessSessionIds,
            Set<String> executedHarnessSessionIds,
            AtomicLong provisionStartedAt, AtomicLong runtimeReadyAt,
            LocalProcessRuntimeProvisioner provisioner)
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
            body.put("physicalCancelCount", physicalCancelCount.get());
            body.put("acquiredHarnessSessionIds",
                    List.copyOf(acquiredHarnessSessionIds));
            body.put("executedHarnessSessionIds",
                    List.copyOf(executedHarnessSessionIds));
            body.put("provisionStartedAtEpochMillis",
                    provisionStartedAt.get());
            body.put("runtimeReadyAtEpochMillis", runtimeReadyAt.get());
            body.put("physicalStartCount",
                    provisioner.getPhysicalStartCount());
            body.put("physicalStopCount",
                    provisioner.getPhysicalStopCount());
            body.put("liveProcessIds",
                    List.copyOf(provisioner.getLiveProcessIds()));
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

    private static List<String> delayedWorkerCommand(long delayMillis,
            Path nodeExecutable, Path workerEntry) {
        if (delayMillis < 0) {
            throw new IllegalArgumentException(
                    "startup delay must be non-negative");
        }
        return List.of("/bin/sh", "-c",
                "sleep \"$1\"; shift; exec \"$@\"",
                "managed-runtime-delay",
                Double.toString(delayMillis / 1000.0),
                nodeExecutable.toString(), workerEntry.toString());
    }

    private static Map<String, String> runtimeEnvironment() {
        Map<String, String> environment = new LinkedHashMap<>();
        copyEnvironment(environment, "HOME");
        copyEnvironment(environment, "QWEN_HOME");
        copyEnvironment(environment, "PATH");
        copyEnvironment(environment, "TMPDIR");
        copyEnvironment(environment, "LANG");
        copyEnvironment(environment, "LC_ALL");
        copyEnvironment(environment, "SHELL");
        copyEnvironment(environment, "USER");
        copyEnvironment(environment, "LOGNAME");
        copyEnvironment(environment, "NO_PROXY");
        copyEnvironment(environment, "no_proxy");
        return environment;
    }

    private static void copyEnvironment(Map<String, String> target,
            String name) {
        String value = System.getenv(name);
        if (value != null) {
            target.put(name, value);
        }
    }

    private static Thread daemonThread(Runnable runnable, String name) {
        Thread thread = new Thread(runnable, name);
        thread.setDaemon(true);
        return thread;
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
