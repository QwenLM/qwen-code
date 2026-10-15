package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.fastjson2.JSON;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * An execution whose record is UNKNOWN keeps answering
 * {@code 409 runtime_broker_execution_unknown} on the Broker HTTP
 * read/start/cancel observation routes, whatever the reason the original
 * Runtime could not be asked or could not answer (issue #13060). The ask of
 * the original Runtime is best-effort: when the worker is lost, the first
 * observation discovers the dead lease and retires the binding, and every
 * observation still answers the record's own UNKNOWN rather than the error
 * of the attempt ({@code runtime_execution_evidence_unavailable} while the
 * binding is being retired, {@code runtime_admission_closed} once it is
 * LOST). The record stays UNKNOWN and nothing is dispatched a second time.
 */
class UnknownExecutionObservationTest {
    @Test
    void workerLossKeepsTheUnknownAnswerOnReadStartAndCancel() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String runtime = "550e8400-e29b-41d4-a716-446655440302";
            fixture.service.acquire("harness", runtime, "bootstrap")
                    .toCompletableFuture().join();
            Map<String, Object> reference = Map.of("sessionId", runtime,
                    "promptId", "turn", "callId", "worker-call",
                    "capabilityDigest", "a".repeat(64), "policyRevision", "policy",
                    "invocationId", "invocation", "argsDigest", "b".repeat(64));
            String id = fixture.service.prepareExecution("harness", runtime,
                    "provider", reference).toCompletableFuture().join()
                    .getExecutionCallId();
            Map<String, Object> start = Map.of("protocolVersion", 1,
                    "requestId", "start", "harnessSessionId", "harness",
                    "runtimeSessionId", runtime);
            // The worker ran the call, but its execute answer is lost.
            HttpResponse<String> started = fixture.post(
                    "/executions/" + id + ":start", start);
            assertEquals(409, started.statusCode(), started.body());
            assertTrue(started.body().contains("runtime_broker_execution_unknown"),
                    started.body());
            assertEquals(ToolExecutionRecord.State.UNKNOWN,
                    fixture.service.getExecution("harness", runtime, id)
                            .toCompletableFuture().join().getState());
            assertEquals(1, fixture.transport.executions.get());

            // The worker is lost: the lease behind the binding no longer
            // answers, exactly as a SIGKILLed worker looks to the Broker.
            fixture.provisioner.alive = false;

            Map<String, String> observed = new LinkedHashMap<>();
            HttpRequest read = HttpRequest.newBuilder(fixture.uri("/executions/" + id
                    + "?requestId=read&harnessSessionId=harness&runtimeSessionId=" + runtime))
                    .header("Authorization", "Bearer secret").GET().build();
            HttpResponse<String> firstRead = fixture.client.send(read,
                    HttpResponse.BodyHandlers.ofString());
            observed.put("first read after the loss",
                    firstRead.statusCode() + " " + codeOf(firstRead));
            HttpResponse<String> secondRead = fixture.client.send(read,
                    HttpResponse.BodyHandlers.ofString());
            observed.put("read once the binding is retired",
                    secondRead.statusCode() + " " + codeOf(secondRead));
            HttpResponse<String> repeatedStart = fixture.post(
                    "/executions/" + id + ":start", start);
            observed.put("start retry",
                    repeatedStart.statusCode() + " " + codeOf(repeatedStart));
            HttpResponse<String> cancel = fixture.post(
                    "/executions/" + id + ":cancel", Map.of("protocolVersion", 1,
                            "requestId", "cancel", "harnessSessionId", "harness",
                            "runtimeSessionId", runtime));
            observed.put("cancel", cancel.statusCode() + " " + codeOf(cancel));

            // Nothing is started a second time and the record stays UNKNOWN.
            // The repository is read directly because the service-level read
            // is itself part of what is being observed.
            assertEquals(1, fixture.transport.executions.get());
            ToolExecutionRecord record = fixture.executions
                    .findByExecutionCallId(id);
            assertEquals(ToolExecutionRecord.State.UNKNOWN, record.getState());
            // The first read is what discovered the dead lease: it retired
            // the binding, so the later observations ran against a LOST
            // generation, not a merely unreachable one.
            assertEquals(RuntimeBindingRecord.State.LOST,
                    fixture.bindings.findById(record.getBindingId()).getState());

            // The expected contract: every observation of the UNKNOWN record
            // answers runtime_broker_execution_unknown, whatever the reason
            // the Broker could not learn more.
            Map<String, String> expected = new LinkedHashMap<>();
            for (String key : observed.keySet()) {
                expected.put(key, "409 runtime_broker_execution_unknown");
            }
            assertEquals(expected, observed);
        }
    }

    @Test
    void payloadStartRetryKeepsTheUnknownAnswer() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String runtime = "550e8400-e29b-41d4-a716-446655440302";
            fixture.service.acquire("harness", runtime, "bootstrap")
                    .toCompletableFuture().join();
            // A provider execution retires the binding when the first
            // observation after the loss discovers the dead lease.
            String provider = prepareProvider(fixture, runtime, "worker-call");
            fixture.post("/executions/" + provider + ":start",
                    providerStart(runtime));

            // A deferred raw execution on the same session, whose execute
            // answer is lost the same way. The service marks the reference
            // deferred itself.
            String payload = "{\"toolName\":\"write_file\",\"input\":{\"content\":\"x\"}}";
            String digest = "sha256:" + HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256")
                            .digest(payload.getBytes(StandardCharsets.UTF_8)));
            Map<String, Object> reference = Map.of("sessionId", runtime,
                    "promptId", "turn", "callId", "deferred-call",
                    "argsDigest", digest);
            String deferred = fixture.service.prepareExecution("harness",
                    runtime, "raw", reference).toCompletableFuture().join()
                    .getExecutionCallId();
            Map<String, Object> start = Map.of("protocolVersion", 1,
                    "requestId", "start", "harnessSessionId", "harness",
                    "runtimeSessionId", runtime, "payloadJson", payload);
            HttpResponse<String> started = fixture.post(
                    "/executions/" + deferred + ":start", start);
            assertEquals(409, started.statusCode(), started.body());
            assertTrue(started.body().contains("runtime_broker_execution_unknown"),
                    started.body());
            assertEquals(2, fixture.transport.executions.get());

            // The worker is lost and the provider observation retires the
            // binding, so the deferred record's generation is no longer live.
            fixture.provisioner.alive = false;
            HttpResponse<String> read = fixture.client.send(
                    HttpRequest.newBuilder(fixture.uri("/executions/" + provider
                            + "?requestId=read&harnessSessionId=harness&runtimeSessionId=" + runtime))
                            .header("Authorization", "Bearer secret").GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(409, read.statusCode(), read.body());
            assertEquals(RuntimeBindingRecord.State.LOST, fixture.bindings
                    .findById(fixture.executions.findByExecutionCallId(provider)
                            .getBindingId()).getState());

            // The start retry that must carry its payload answers the
            // record's own UNKNOWN, exactly like the reference-shape retry.
            HttpResponse<String> retried = fixture.post(
                    "/executions/" + deferred + ":start", start);
            assertEquals(409, retried.statusCode(), retried.body());
            assertTrue(retried.body().contains("runtime_broker_execution_unknown"),
                    retried.body());
            assertEquals(2, fixture.transport.executions.get());
            assertEquals(ToolExecutionRecord.State.UNKNOWN, fixture.executions
                    .findByExecutionCallId(deferred).getState());
        }
    }

    @Test
    void admissionErrorStandsForForeignOrNeverStartedRecords() throws Exception {
        try (Fixture fixture = new Fixture()) {
            String runtime = "550e8400-e29b-41d4-a716-446655440302";
            String other = "550e8400-e29b-41d4-a716-446655440303";
            fixture.service.acquire("harness", runtime, "bootstrap")
                    .toCompletableFuture().join();
            fixture.service.acquire("harness", other, "bootstrap")
                    .toCompletableFuture().join();
            String own = prepareProvider(fixture, runtime, "own-call");
            String foreign = prepareProvider(fixture, other, "foreign-call");
            String prepared = prepareProvider(fixture, runtime, "fresh-call");
            fixture.post("/executions/" + own + ":start", providerStart(runtime));
            fixture.post("/executions/" + foreign + ":start",
                    providerStart(other));

            // The loss retires only the first session's binding.
            fixture.provisioner.alive = false;
            fixture.client.send(HttpRequest.newBuilder(fixture.uri(
                    "/executions/" + own + "?requestId=read&harnessSessionId=harness&runtimeSessionId=" + runtime))
                    .header("Authorization", "Bearer secret").GET().build(),
                    HttpResponse.BodyHandlers.ofString());

            // A start naming another session's UNKNOWN record is not answered
            // with that record: the admission error stands.
            HttpResponse<String> cross = fixture.post(
                    "/executions/" + foreign + ":start", providerStart(runtime));
            assertEquals(409, cross.statusCode(), cross.body());
            assertTrue(cross.body().contains("runtime_admission_closed"),
                    cross.body());
            // So is a record that never started: PREPARED is not UNKNOWN.
            HttpResponse<String> fresh = fixture.post(
                    "/executions/" + prepared + ":start", providerStart(runtime));
            assertEquals(409, fresh.statusCode(), fresh.body());
            assertTrue(fresh.body().contains("runtime_admission_closed"),
                    fresh.body());
        }
    }

    private static String prepareProvider(Fixture fixture, String runtime,
            String callId) {
        Map<String, Object> reference = Map.of("sessionId", runtime,
                "promptId", "turn", "callId", callId,
                "capabilityDigest", "a".repeat(64), "policyRevision", "policy",
                "invocationId", "invocation", "argsDigest", "b".repeat(64));
        return fixture.service.prepareExecution("harness", runtime,
                "provider-" + callId, reference).toCompletableFuture().join()
                .getExecutionCallId();
    }

    private static Map<String, Object> providerStart(String runtime) {
        return Map.of("protocolVersion", 1, "requestId", "start",
                "harnessSessionId", "harness", "runtimeSessionId", runtime);
    }

    private static String codeOf(HttpResponse<String> response) {
        return JSON.parseObject(response.body()).getString("code");
    }

    private static final class Fixture implements AutoCloseable {
        private final FailingTransport transport = new FailingTransport();
        private final FlappingProvisioner provisioner = new FlappingProvisioner(
                new RuntimeLease("instance", URI.create("http://127.0.0.1:1234"),
                        "token", "lease", 1));
        private final HttpClient client = HttpClient.newHttpClient();
        private final InMemoryToolExecutionRepository executions =
                new InMemoryToolExecutionRepository(Clock.systemUTC());
        private final InMemoryRuntimeBindingRepository bindings =
                new InMemoryRuntimeBindingRepository();
        private final RuntimeBrokerService service;
        private final RuntimeBrokerHttpServer server;

        private Fixture() throws Exception {
            RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                    "generation", "/workspace", "capability", "workspace");
            service = new RuntimeBrokerService(
                    id -> CompletableFuture.completedFuture(scope),
                    provisioner, transport, bindings,
                    new InMemoryRuntimeSessionRepository(),
                    executions,
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            server = new RuntimeBrokerHttpServer(new InetSocketAddress("127.0.0.1", 0),
                    "secret", service);
            server.start();
        }

        private URI uri(String path) {
            return server.getBaseUri().resolve(RuntimeBrokerHttpServer.ROUTE_PREFIX + path);
        }

        private HttpResponse<String> post(String path, Map<String, Object> body) throws Exception {
            return client.send(HttpRequest.newBuilder(uri(path))
                    .header("Authorization", "Bearer secret")
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(JSON.toJSONString(body)))
                    .build(), HttpResponse.BodyHandlers.ofString());
        }

        @Override
        public void close() {
            server.close();
            client.close();
        }
    }

    /** A static lease whose backing worker can be reported dead. */
    private static final class FlappingProvisioner implements RuntimeProvisioner {
        private final RuntimeLease lease;
        private volatile boolean alive = true;

        private FlappingProvisioner(RuntimeLease lease) {
            this.lease = lease;
        }

        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            return CompletableFuture.completedFuture(lease);
        }

        @Override
        public String kind() {
            return "static";
        }

        @Override
        public boolean isUsable(RuntimeLease candidate) {
            return alive;
        }
    }

    private static final class FailingTransport implements RuntimeTransport {
        private final AtomicInteger executions = new AtomicInteger();
        private Map<String, Object> runtimeStatus = Map.of("state", "unknown");

        @Override
        public CompletionStage<Void> installPublisher(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> publisher) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> acknowledge(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, Map<String, Object> receipt) {
            return CompletableFuture.completedFuture(runtimeStatus);
        }

        @Override
        public CompletionStage<Map<String, Object>> status(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference, long afterSequence) {
            return CompletableFuture.completedFuture(runtimeStatus);
        }

        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease, RuntimeSession session,
                Map<String, Object> operation) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            executions.incrementAndGet();
            return CompletableFuture.failedFuture(new IllegalStateException("connection lost"));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> reference) {
            return CompletableFuture.completedFuture(runtimeStatus);
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease, RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }
}
