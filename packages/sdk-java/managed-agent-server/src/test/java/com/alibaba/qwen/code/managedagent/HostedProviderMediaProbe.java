package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.ProxySelector;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

final class HostedProviderMediaProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final List<Map<String, Object>> sessions;
    private final EmbeddedRuntimeBroker original;
    private final Supplier<EmbeddedRuntimeBroker> restart;
    private final Object provisioner;
    private final HttpClient upstream = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
    private final HttpClient forwarded;
    private final Map<String, Integer> dispatches = new ConcurrentHashMap<>();
    private final Map<String, JsonNode> executed = new ConcurrentHashMap<>();
    private final Map<String, JsonNode> references = new ConcurrentHashMap<>();
    private final Map<String, String> hashes = new ConcurrentHashMap<>();
    private final Map<String, Integer> lengths = new ConcurrentHashMap<>();
    private final Set<ProcessHandle> processes = ConcurrentHashMap.newKeySet();
    private final Set<String> finished = ConcurrentHashMap.newKeySet();
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private volatile EmbeddedRuntimeBroker restarted;
    private int dropped;

    HostedProviderMediaProbe(JdbcTemplate jdbc, String tenant, List<Map<String, Object>> sessions,
            EmbeddedRuntimeBroker broker, HttpServer server, Supplier<EmbeddedRuntimeBroker> restart) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        this.sessions = sessions;
        original = broker;
        this.restart = restart;
        server.setExecutor(executor);
        Object service = ReflectionTestUtils.getField(broker, "service");
        Object transport = ReflectionTestUtils.getField(service, "transport");
        provisioner = ReflectionTestUtils.getField(ReflectionTestUtils.getField(service, "provisioner"), "delegate");
        List<?> command = (List<?>) ReflectionTestUtils.getField(provisioner, "command");
        assertThat(command.size()).isEqualTo(3);
        assertThat(command.get(2)).isEqualTo("managed-runtime-worker");
        Path cli = Path.of(command.get(1).toString());
        Path readProbe = cli.getParent().getParent().resolve("integration-tests/helpers/provider-media-read-probe.mjs");
        ReflectionTestUtils.setField(provisioner, "command", List.of(command.get(0).toString(), "--import",
                readProbe.toUri().toString(), cli.toString(), "managed-runtime-worker"));
        forwarded = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                .proxy(ProxySelector.of(server.getAddress())).build();
        ReflectionTestUtils.setField(transport, "delegate", new HttpRuntimeTransport(forwarded));
        server.createContext("/", exchange -> {
            try {
                forward(exchange);
            } catch (Throwable cause) {
                // Payloads are private evidence: do not print JsonNode assertion diffs.
                recordFailure(cause, "worker proxy");
            } finally {
                exchange.close();
            }
        });
        server.createContext("/media/", exchange -> {
            try {
                assertThat(failure.get()).as("M4 worker proxy").isNull();
                String[] route = exchange.getRequestURI().getPath().split("/");
                assertThat(route).hasSize(4);
                var session = sessions.stream().filter(value -> value.get("sessionId").equals(route[2]))
                        .findFirst().orElseThrow();
                JsonNode fields = JSON.readTree(exchange.getRequestBody());
                Map<String, Object> answer = check(session, route[3], fields);
                byte[] body = JSON.writeValueAsBytes(answer);
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            } catch (Throwable cause) {
                recordFailure(cause, "ledger probe");
                exchange.sendResponseHeaders(500, -1);
            } finally {
                exchange.close();
            }
        });
    }

    private void recordFailure(Throwable cause, String stage) {
        String site = Arrays.stream(cause.getStackTrace())
                .filter(frame -> frame.getClassName().equals(HostedProviderMediaProbe.class.getName()))
                .findFirst().map(frame -> frame.getMethodName() + ":" + frame.getLineNumber()).orElse("unknown");
        String message = "M4_MEDIA_PROBE " + stage + " " + cause.getClass().getSimpleName() + " at " + site;
        if (failure.compareAndSet(null, new IllegalStateException(message))) System.err.println(message);
    }

    private void forward(HttpExchange exchange) throws Exception {
        assertThat(exchange.getRequestMethod()).isEqualTo("POST");
        assertThat(exchange.getRequestURI().getHost()).isEqualTo("127.0.0.1");
        String path = exchange.getRequestURI().getPath();
        assertThat(path).doesNotContain("/v2/");
        byte[] bytes = exchange.getRequestBody().readAllBytes();
        JsonNode body = JSON.readTree(bytes);
        String kind = body.path("operation").path("kind").asText();
        boolean provider = path.equals("/internal/managed-runtime/provider/v1/control");
        if (provider) assertThat(body.path("providerProtocol").asText()).isEqualTo("managed-runtime-provider/1");
        if (kind.equals("execute")) {
            assertThat(provider).isTrue();
            JsonNode reference = body.path("operation").path("reference");
            assertThat(reference.size()).isEqualTo(7);
            String runtimeId = reference.path("sessionId").asText();
            dispatches.merge(runtimeId, 1, Integer::sum);
            executed.put(runtimeId, reference);
            captureProcesses();
        }
        HttpRequest.Builder request = HttpRequest.newBuilder(exchange.getRequestURI())
                .timeout(Duration.ofSeconds(40)).POST(HttpRequest.BodyPublishers.ofByteArray(bytes));
        for (String header : List.of("Authorization", "Cache-Control", "Content-Type",
                "X-Qwen-Managed-Lease-Id", "X-Qwen-Managed-Lease-Epoch")) {
            String value = exchange.getRequestHeaders().getFirst(header);
            if (value != null) request.header(header, value);
        }
        var response = upstream.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
        if (kind.equals("execute")) {
            assertThat(response.statusCode()).isEqualTo(200);
            JsonNode result = JSON.readTree(response.body()).path("result");
            assertThat(result.has("responseParts")).isFalse();
            assertThat(result.path("result").has("llmContent")).isTrue();
            String harness = body.path("session").path("harnessSessionId").asText();
            finished.add(harness);
            var session = sessions.stream().filter(value -> value.get("sessionId").equals(harness))
                    .findFirst().orElseThrow();
            if (session.get("fault").equals("lost-execute") && dropped == 0) {
                Path file = Path.of(session.get("directory").toString()).resolve("proof.pdf");
                Files.write(file, Files.readAllBytes(file.resolveSibling("proof.pdf.replacement")));
                dropped++;
                return;
            }
        }
        for (String header : List.of("Content-Type", "Cache-Control")) {
            response.headers().firstValue(header).ifPresent(value -> exchange.getResponseHeaders().set(header, value));
        }
        exchange.sendResponseHeaders(response.statusCode(), response.body().length);
        exchange.getResponseBody().write(response.body());
    }

    private Map<String, Object> execution(Map<String, Object> session) {
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_execution WHERE harness_session_id = ?",
                session.get("sessionId"));
        assertThat(rows.size()).as("one SQL invocation per Session").isEqualTo(1);
        return rows.getFirst();
    }

    private Map<String, Object> check(Map<String, Object> session, String phase, JsonNode fields) throws Exception {
        String harness = session.get("sessionId").toString();
        if (phase.equals("worker-done")) return Map.of("done", finished.contains(harness));
        if (phase.equals("restart")) {
            assertThat(restarted).isNull();
            for (var value : sessions) check(value, "released", JSON.createObjectNode());
            original.close();
            for (var process : processes) {
                if (process.isAlive()) process.onExit().get(10, TimeUnit.SECONDS);
                assertThat(process.isAlive()).as("original media worker stopped").isFalse();
            }
            restarted = restart.get();
            return Map.of("brokerUrl", restarted.getBaseUri().toString());
        }
        var row = execution(session);
        String runtimeId = row.get("runtime_session_id").toString();
        JsonNode reference = JSON.readTree(row.get("reference_json").toString());
        if (phase.equals("prepared")) {
            assertThat(reference.size()).isEqualTo(7);
            assertThat(reference.equals(fields.path("reference"))).as("original seven-field reference").isTrue();
            references.put(harness, reference);
            assertThat(row.get("execution_call_id")).isEqualTo(fields.path("executionCallId").asText());
        }
        assertThat(reference.equals(references.get(harness))).as("immutable SQL reference").isTrue();
        boolean prepared = phase.equals("prepared");
        assertThat(row.get("execution_state")).isEqualTo(prepared ? "PREPARED" : "SETTLED");
        assertThat(((Number) row.get("dispatch_generation")).longValue()).isEqualTo(prepared ? 0 : 1);
        assertThat(dispatches.getOrDefault(runtimeId, 0)).as("physical provider execute count").isEqualTo(prepared ? 0 : 1);
        if (!prepared) {
            assertThat(reference.equals(executed.get(runtimeId))).as("executed original reference").isTrue();
            assertThat(row.get("execution_status")).isEqualTo(session.get("fault").equals("pdf-too-large") ? "error" : "success");
            byte[] encoded = JSON.writeValueAsBytes(JSON.readTree(row.get("result_json").toString()));
            String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(encoded));
            if (phase.equals("settled")) {
                hashes.put(harness, hash);
                lengths.put(harness, encoded.length);
            }
            assertThat(hash).isEqualTo(hashes.get(harness));
            assertThat(encoded.length).isEqualTo(lengths.get(harness));
            if (fields.has("resultHash")) assertThat(hash).isEqualTo(fields.path("resultHash").asText());
            if (fields.has("resultBytes")) assertThat(encoded.length).isEqualTo(fields.path("resultBytes").asInt());
        }
        String storageKey = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((tenant + "\u0000storage-" + sessions.indexOf(session)).getBytes(StandardCharsets.UTF_8)));
        var owner = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", storageKey);
        boolean released = phase.equals("released") || phase.equals("restarted");
        if (released) assertThat(owner.get("holder_key")).isNull();
        else assertThat(owner.get("holder_key")).isNotNull();
        assertThat(jdbc.queryForObject("SELECT session_state FROM qwen_runtime_session WHERE harness_session_id = ?"
                + " AND runtime_session_id = ?", String.class, harness, runtimeId)).isEqualTo(released ? "RELEASED" : "READY");
        if (phase.equals("restarted")) {
            assertThat(restarted).isNotNull();
            assertThat(Files.readString(Path.of(session.get("directory").toString())
                    .resolve(".provider-media-reads.json"))).isEqualTo(readCounts.get(harness));
        }
        if (phase.equals("released")) readCounts.put(harness, Files.readString(Path.of(session.get("directory").toString())
                .resolve(".provider-media-reads.json")));
        return Map.of("checked", phase);
    }

    private final Map<String, String> readCounts = new ConcurrentHashMap<>();

    void assertReport(Map<String, Object> session, JsonNode report) throws Exception {
        assertThat(failure.get()).as("M4 probe").isNull();
        check(session, "restarted", report);
        assertThat(dropped).isEqualTo(1);
        assertThat(execution(session).get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
        System.out.println("M4_MEDIA_LEDGER " + session.get("fault") + " dispatch=1 restarted=true owner=released");
    }

    private void captureProcesses() {
        for (Object value : ((Map<?, ?>) ReflectionTestUtils.getField(provisioner, "owned")).values()) {
            Process process = (Process) ReflectionTestUtils.getField(value, "process");
            if (process.isAlive()) {
                String[] arguments = process.info().arguments().orElseThrow();
                assertThat(List.of(arguments)).contains("--import", "managed-runtime-worker");
                assertThat(List.of(arguments).stream().anyMatch(argument -> argument.endsWith("/dist/cli.js")))
                        .as("packaged worker entry").isTrue();
            }
            processes.add(process.toHandle());
            processes.addAll(process.descendants().toList());
        }
    }

    @Override
    public void close() throws Exception {
        executor.shutdownNow();
        if (restarted != null) restarted.close();
        forwarded.shutdownNow();
        upstream.shutdownNow();
        captureProcesses();
        processes.forEach(ProcessHandle::destroyForcibly);
        for (var process : processes) if (process.isAlive()) process.onExit().get(10, TimeUnit.SECONDS);
    }
}
