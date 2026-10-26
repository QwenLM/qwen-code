package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Operator allocation is simulated; HTTP, Broker and CLI worker are real. */
@Tag("fault-gate")
@Timeout(120)
class ExternalRuntimeWorkerFaultGateTest {
    @TempDir
    Path directory;

    @Test
    void lostProvisionReplyAndBrokerRecreationKeepTheOriginalWorkerAndItsWrites() throws Exception {
        Path cli = Path.of(System.getProperty("qwen.cli.entry", "../../dist/cli.js")).toAbsolutePath().normalize();
        assertTrue(Files.isRegularFile(cli), "Build and bundle the CLI before running this fault gate");
        Path workspace = Files.createDirectory(directory.resolve("workspace")).toRealPath();
        var scope = new RuntimeScope("tenant", "workspace", "1", workspace.toString(),
                "sha256:" + "a".repeat(64), "session");
        var bindings = new InMemoryRuntimeBindingRepository();
        var sessions = new InMemoryRuntimeSessionRepository();
        var executions = new InMemoryToolExecutionRepository();
        var transport = new HttpRuntimeTransport();
        try (var operator = new Operator(cli, workspace)) {
            var first = operator.provisioner();
            RuntimeBindingRecord ready;
            ToolExecutionRecord written;
            Map<String, Object> write;
            Path file = workspace.resolve("result.txt");
            try (first; var broker = broker(first, scope, transport, bindings, sessions, executions, "first")) {
                var failure = assertThrows(ExecutionException.class, () -> join(broker.warm("harness")));
                assertTrue(failure.getCause() instanceof RuntimeBrokerException);
                assertTrue(((RuntimeBrokerException) failure.getCause()).isRetryable());
                var retained = bindings.findOrCreate(first.createRequest(scope, "harness"));
                assertEquals(RuntimeBindingRecord.State.PROVISIONING, retained.getState());
                assertNotNull(retained.getResourceHandle());
                assertEquals(retained.getResourceHandle().getValue().get("provider"), operator.request.get("handle"));
                long pid = operator.worker.pid();
                ready = join(broker.warm("harness"));
                assertEquals(RuntimeBindingRecord.State.READY, ready.getState());
                assertEquals(retained.getProvisionSeed(), ready.getProvisionSeed());
                assertEquals(retained.getResourceHandle(), ready.getResourceHandle());
                assertEquals(1, operator.allocations);
                assertTrue(operator.provisions >= 2);
                assertEquals(pid, operator.worker.pid());

                join(broker.acquire("harness", "runtime-session", "bootstrap"));
                write = reference("write", "write_file", Map.of("file_path", file.toString(), "content", "alpha\n"));
                written = settle(broker, join(broker.createExecution("harness", "runtime-session", "write-key", write)));
                assertEquals("success", written.getExecutionStatus());
                assertEquals("alpha\n", Files.readString(file));
                var edit = reference("edit", "edit", Map.of("file_path", file.toString(),
                        "old_string", "alpha", "new_string", "beta"));
                var edited = settle(broker, join(broker.createExecution("harness", "runtime-session", "edit-key", edit)));
                assertEquals("success", edited.getExecutionStatus());
                assertEquals("beta\n", Files.readString(file));

                operator.unknown = true;
                var unknownFailure = assertThrows(ExecutionException.class, () -> join(broker.warm("harness")));
                assertTrue(unknownFailure.getCause() instanceof RuntimeBrokerException);
                assertTrue(((RuntimeBrokerException) unknownFailure.getCause()).isRetryable());
                assertEquals("runtime_external_unavailable",
                        ((RuntimeBrokerException) unknownFailure.getCause()).getCode());
                assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(ready.getBindingId()).getState());
                operator.unknown = false;
                assertSameLease(ready.getLease(), join(broker.warm("harness")).getLease());
            }
            int provisions = operator.provisions;
            try (var restored = operator.provisioner();
                    var broker = broker(restored, scope, transport, bindings, sessions, executions, "restored")) {
                var adopted = join(broker.warm("harness"));
                assertEquals(ready.getResourceHandle(), adopted.getResourceHandle());
                assertEquals(ready.getProvisionSeed(), adopted.getProvisionSeed());
                assertSameLease(ready.getLease(), adopted.getLease());
                assertEquals(provisions, operator.provisions, "Instance recreation must observe, not allocate");
                assertEquals(1, operator.allocations);
                // Session liveness is per Broker process by contract: a
                // recreated Broker adopts the worker first, then callers
                // re-acquire the Session. The repository dedupe reuses the
                // READY record instead of re-driving transport.acquire.
                var reacquired = join(broker.acquire("harness", "runtime-session", "bootstrap"));
                assertEquals(adopted.getBindingId(), reacquired.getBindingId());
                assertEquals(RuntimeSessionRecord.State.READY, reacquired.getState());
                var duplicate = join(broker.createExecution("harness", "runtime-session", "write-key", write));
                assertEquals(written.getExecutionCallId(), duplicate.getExecutionCallId());
                assertTrue(duplicate.isSettled(), "Duplicate must be the original settled terminal receipt");
                assertEquals(written.getExecutionStatus(), duplicate.getExecutionStatus());
                assertEquals(written.getResult(), duplicate.getResult());
                // A replayed terminal write would land after this receipt;
                // hold the window the sibling gate uses to catch it.
                FaultGateRig.hold(() -> {
                    try {
                        return Files.readString(file);
                    } catch (IOException readFailure) {
                        throw new UncheckedIOException(readFailure);
                    }
                }, "beta\n"::equals, Duration.ofSeconds(6), "file content after the duplicate receipt");
                var read = reference("read", "read_file", Map.of("file_path", file.toString()));
                var result = settle(broker, join(broker.createExecution("harness", "runtime-session", "read-key", read)));
                assertEquals("success", result.getExecutionStatus());
                assertTrue(result.getResult().toString().contains("beta"));
                join(restored.release(adopted.getRequest(), adopted.getLease()));
            }
            assertTrue(operator.worker.isAlive(), "Broker release does not own physical worker termination");
            String token = (String) ((Map<?, ?>) operator.request.get("boot")).get("token");
            assertFalse(Files.readString(operator.stdout).contains(token));
            assertFalse(Files.readString(operator.stderr).contains(token));
        }
    }

    private static void assertSameLease(RuntimeLease expected, RuntimeLease actual) {
        assertEquals(expected.getRuntimeInstanceId(), actual.getRuntimeInstanceId());
        assertEquals(expected.getEndpoint(), actual.getEndpoint());
        assertEquals(expected.getLeaseId(), actual.getLeaseId());
        assertEquals(expected.getEpoch(), actual.getEpoch());
        assertTrue(expected.getToken().equals(actual.getToken()), "Lease token must remain unchanged");
    }

    private static RuntimeBrokerService broker(ExternalRuntimeProvisioner provisioner, RuntimeScope scope,
            HttpRuntimeTransport transport, InMemoryRuntimeBindingRepository bindings,
            InMemoryRuntimeSessionRepository sessions, InMemoryToolExecutionRepository executions, String owner) {
        return new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope), provisioner, transport,
                bindings, sessions, executions, owner, Duration.ofSeconds(30), Duration.ofSeconds(30));
    }

    private static Map<String, Object> reference(String call, String tool, Map<String, Object> input) {
        return Map.of("sessionId", "runtime-session", "promptId", "turn", "callId", call,
                "argsDigest", "digest-" + call, "toolName", tool, "input", input);
    }

    private static <T> T join(CompletionStage<T> result) throws Exception {
        return result.toCompletableFuture().get(35, TimeUnit.SECONDS);
    }

    private static ToolExecutionRecord settle(RuntimeBrokerService broker, ToolExecutionRecord record) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (!record.isSettled() && System.nanoTime() < deadline) {
            Thread.sleep(25);
            record = join(broker.getExecution("harness", "runtime-session", record.getExecutionCallId()));
        }
        assertTrue(record.isSettled(), "Execution must reach a terminal state");
        return record;
    }

    private final class Operator implements AutoCloseable {
        private static final String TOKEN = "operator-test-credential";
        private final HttpServer server;
        private final Path cli;
        private final Path workspace;
        private final Path stdout = directory.resolve("worker.stdout");
        private final Path stderr = directory.resolve("worker.stderr");
        private volatile Process worker;
        private volatile Map<String, Object> request;
        private volatile int allocations;
        private volatile int provisions;
        private volatile boolean unknown;
        private String endpoint;

        private Operator(Path cli, Path workspace) throws IOException {
            this.cli = cli;
            this.workspace = workspace;
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/operator/provision", this::handle);
            server.createContext("/operator/observe", this::handle);
            server.start();
        }

        private ExternalRuntimeProvisioner provisioner() {
            URI url = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/operator/");
            return new ExternalRuntimeProvisioner(new ExternalHttpRuntimeClient(url, TOKEN, Duration.ofSeconds(30)),
                    "operator", Duration.ofSeconds(30));
        }

        private void handle(HttpExchange exchange) throws IOException {
            try (exchange) {
                if (!"POST".equals(exchange.getRequestMethod())
                        || !("Bearer " + TOKEN).equals(exchange.getRequestHeaders().getFirst("Authorization"))
                        || !"no-store".equals(exchange.getRequestHeaders().getFirst("Cache-Control"))) {
                    exchange.sendResponseHeaders(403, -1);
                    return;
                }
                Map<String, Object> incoming = JsonCodec.parseObject(exchange.getRequestBody().readAllBytes(), "operator");
                boolean provision = exchange.getRequestURI().getPath().endsWith("/provision");
                if (provision) {
                    provisions++;
                    if (request == null) {
                        request = incoming;
                        startWorker(incoming);
                        // Lose the response only after allocation. Headers prevent the HTTP client retrying a bare EOF.
                        exchange.sendResponseHeaders(200, 1);
                        return;
                    }
                    if (!request.equals(incoming)) {
                        exchange.sendResponseHeaders(409, -1);
                        return;
                    }
                    respond(exchange, Map.of("protocolVersion", 1, "handle", request.get("handle"), "endpoint", endpoint));
                } else {
                    if (request == null || !request.get("provisionRequestId").equals(incoming.get("provisionRequestId"))
                            || !request.get("identity").equals(incoming.get("identity"))
                            || !request.get("handle").equals(incoming.get("handle"))) {
                        exchange.sendResponseHeaders(409, -1);
                        return;
                    }
                    respond(exchange, Map.of("protocolVersion", 1, "state", unknown ? "UNKNOWN" : "RUNNING",
                            "endpoint", endpoint));
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException("Operator interrupted while starting worker", error);
            }
        }

        private void startWorker(Map<String, Object> incoming) throws IOException, InterruptedException {
            var builder = new ProcessBuilder("node", cli.toString(), "managed-runtime-worker")
                    .directory(workspace.toFile()).redirectOutput(stdout.toFile()).redirectError(stderr.toFile());
            builder.environment().put("HOME", directory.toString());
            builder.environment().put("QWEN_RUNTIME_DIR", directory.resolve("runtime").toString());
            worker = builder.start();
            allocations++;
            try (var input = worker.getOutputStream()) {
                input.write(JsonCodec.encode(incoming.get("boot")));
                input.write('\n');
            }
            long deadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
            while (System.nanoTime() < deadline && worker.isAlive()) {
                String output = Files.readString(stdout);
                if (output.contains("\n")) {
                    Map<String, Object> ready = JsonCodec.parseObject(output.strip().getBytes(java.nio.charset.StandardCharsets.UTF_8), "worker ready");
                    if (!"ready".equals(ready.get("type"))) {
                        throw new IOException("Worker returned an invalid ready record");
                    }
                    endpoint = (String) ready.get("url");
                    return;
                }
                Thread.sleep(25);
            }
            throw new IOException("Worker did not emit its ready record");
        }

        private void respond(HttpExchange exchange, Map<String, Object> response) throws IOException {
            byte[] bytes = JsonCodec.encode(response);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
        }

        @Override
        public void close() throws Exception {
            server.stop(0);
            if (worker != null) {
                worker.destroy();
                if (!worker.waitFor(5, TimeUnit.SECONDS)) {
                    worker.destroyForcibly();
                    assertTrue(worker.waitFor(5, TimeUnit.SECONDS), "Owned worker must stop");
                }
            }
        }
    }
}
