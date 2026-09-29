package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

final class HostedProviderControlProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PROVIDER_PATH = "/internal/managed-runtime/provider/v1/control";
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final List<Map<String, Object>> sessions;
    private final Object provisioner;
    private final HttpClient upstream = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
    private final HttpClient forwarded;
    private final Map<String, Map<String, Object>> owners = new HashMap<>();
    private final Map<String, JsonNode> references = new HashMap<>();
    private final Map<String, Integer> executions = new HashMap<>();
    private final Map<String, Integer> releases = new HashMap<>();
    private final Map<String, Integer> deactivations = new HashMap<>();
    private final Set<ProcessHandle> processes = new LinkedHashSet<>();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private boolean loseReleaseReply = true;
    private int dropped;

    HostedProviderControlProbe(JdbcTemplate jdbc, String tenant, List<Map<String, Object>> sessions,
            EmbeddedRuntimeBroker broker, HttpServer server) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        this.sessions = sessions;
        Object service = ReflectionTestUtils.getField(broker, "service");
        Object transport = ReflectionTestUtils.getField(service, "transport");
        provisioner = ReflectionTestUtils.getField(ReflectionTestUtils.getField(service, "provisioner"), "delegate");
        forwarded = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                .proxy(ProxySelector.of(server.getAddress())).build();
        ReflectionTestUtils.setField(transport, "delegate", new HttpRuntimeTransport(forwarded));
        server.createContext("/", exchange -> {
            try {
                forward(exchange);
            } catch (Throwable cause) {
                failure.compareAndSet(null, cause);
                cause.printStackTrace(System.err);
            } finally {
                exchange.close();
            }
        });
        server.createContext("/provider/", exchange -> {
            try {
                assertThat(failure.get()).as("worker proxy").isNull();
                assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                String[] route = exchange.getRequestURI().getPath().split("/");
                assertThat(route).hasSize(4);
                var session = sessions.stream().filter(value -> value.get("sessionId").equals(route[2])).findFirst().orElseThrow();
                check(session, route[3]);
                byte[] body = JSON.writeValueAsBytes(Map.of("checked", route[3], "dropped", dropped));
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            } catch (Throwable cause) {
                failure.compareAndSet(null, cause);
                byte[] body = cause.toString().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, body.length);
                exchange.getResponseBody().write(body);
            } finally {
                exchange.close();
            }
        });
    }

    private HttpResponse<byte[]> send(HttpExchange exchange, byte[] body) throws Exception {
        assertThat(exchange.getRequestURI().getHost()).isEqualTo("127.0.0.1");
        HttpRequest.Builder request = HttpRequest.newBuilder(exchange.getRequestURI())
                .timeout(Duration.ofSeconds(30)).POST(HttpRequest.BodyPublishers.ofByteArray(body));
        for (String header : List.of("Authorization", "Cache-Control", "Content-Type",
                "X-Qwen-Managed-Lease-Id", "X-Qwen-Managed-Lease-Epoch")) {
            request.header(header, exchange.getRequestHeaders().getFirst(header));
        }
        return upstream.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private void forward(HttpExchange exchange) throws Exception {
        assertThat(exchange.getRequestMethod()).isEqualTo("POST");
        byte[] body = exchange.getRequestBody().readAllBytes();
        JsonNode request = JSON.readTree(body);
        String path = exchange.getRequestURI().getPath();
        boolean provider = path.equals(PROVIDER_PATH);
        String runtimeId = provider ? request.path("session").path("runtimeSessionId").asText()
                : request.path("sessionId").asText(request.path("reference").path("sessionId").asText());
        String kind = provider ? request.path("operation").path("kind").asText() : "";
        boolean release = kind.equals("release");
        if (kind.equals("execute") || path.endsWith("/v2/execute")) executions.merge(runtimeId, 1, Integer::sum);
        if (release) releases.merge(runtimeId, 1, Integer::sum);
        if (path.endsWith("/v3/activation") && request.path("operation").asText().equals("release")) {
            assertThat(releases.getOrDefault(runtimeId, 0)).as("closure before deactivation").isPositive();
            deactivations.merge(runtimeId, 1, Integer::sum);
        }
        var response = send(exchange, body);
        if (release) {
            assertThat(response.statusCode()).isEqualTo(200);
            JsonNode answer = JSON.readTree(response.body());
            assertThat(answer.path("session")).isEqualTo(request.path("session"));
            assertThat(answer.path("result").asBoolean()).isTrue();
            var session = sessions.stream().filter(value -> value.get("sessionId")
                    .equals(request.path("session").path("harnessSessionId").asText())).findFirst().orElseThrow();
            assertThat(owner(session)).as("owner before worker acknowledgement").isEqualTo(owners.get(session.get("sessionId")));
            assertThat(deactivations.getOrDefault(runtimeId, 0)).isZero();
            ObjectNode closed = request.deepCopy();
            closed.set("operation", JSON.createObjectNode().put("kind", "acquire"));
            var refused = send(exchange, JSON.writeValueAsBytes(closed));
            assertThat(refused.statusCode()).as("worker admission already closed").isEqualTo(409);
            JsonNode error = JSON.readTree(refused.body());
            assertThat(error.path("code").asText()).isEqualTo("managed_runtime_provider_operation_failed");
            assertThat(error.path("error").asText()).isEqualTo("Managed Runtime Session is closed.");
            if (!session.get("fault").equals("raw-contract")) {
                ObjectNode status = request.deepCopy();
                status.set("operation", JSON.createObjectNode().put("kind", "status")
                        .set("reference", references.get(session.get("sessionId"))));
                var observed = send(exchange, JSON.writeValueAsBytes(status));
                assertThat(observed.statusCode()).isEqualTo(200);
                JsonNode receipt = JSON.readTree(observed.body()).path("result");
                assertThat(receipt.path("state").asText()).isEqualTo("settled");
                assertThat(receipt.path("result").path("executionStatus").asText()).isEqualTo("success");
            }
            if (session.get("fault").equals("release-reply") && loseReleaseReply) {
                assertThat(sessionState(session, runtimeId)).isEqualTo("RELEASING");
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
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_execution WHERE harness_session_id = ?", session.get("sessionId"));
        assertThat(rows).hasSize(1);
        return rows.getFirst();
    }

    private Map<String, Object> owner(Map<String, Object> session) throws Exception {
        String key = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((tenant + "\u0000storage-" + sessions.indexOf(session)).getBytes(StandardCharsets.UTF_8)));
        return jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", key);
    }

    private String sessionState(Map<String, Object> session, String runtimeId) {
        return jdbc.queryForObject("SELECT session_state FROM qwen_runtime_session WHERE harness_session_id = ?"
                + " AND runtime_session_id = ?", String.class, session.get("sessionId"), runtimeId);
    }

    private void captureProcesses() {
        for (Object value : new ArrayList<>(((Map<?, ?>) ReflectionTestUtils.getField(provisioner, "owned")).values())) {
            Process process = (Process) ReflectionTestUtils.getField(value, "process");
            processes.add(process.toHandle());
            processes.addAll(process.descendants().toList());
        }
    }

    private void check(Map<String, Object> session, String phase) throws Exception {
        captureProcesses();
        var row = execution(session);
        String id = session.get("sessionId").toString();
        String runtimeId = row.get("runtime_session_id").toString();
        JsonNode reference = JSON.readTree(row.get("reference_json").toString());
        boolean raw = session.get("fault").equals("raw-contract");
        if (!owners.containsKey(id)) {
            assertThat(phase).isEqualTo("prepared");
            owners.put(id, owner(session));
            references.put(id, reference);
            assertThat(owner(session).get("holder_key")).isNotNull();
            assertThat(owner(session).get("runtime_session_id")).isEqualTo(runtimeId);
            assertThat(reference.size()).isEqualTo(raw ? 5 : 7);
            assertThat(reference.has("toolName")).isFalse();
            assertThat(reference.has("input")).isFalse();
            assertThat(reference.path("sessionId").asText()).isEqualTo(runtimeId);
        }
        assertThat(reference).isEqualTo(references.get(id));
        assertThat(phase).isIn("prepared", "settled", "uncertain", "resume", "released");
        boolean prepared = phase.equals("prepared");
        assertThat(row.get("execution_state")).isEqualTo(prepared ? "PREPARED" : "SETTLED");
        assertThat(((Number) row.get("dispatch_generation")).longValue()).isEqualTo(prepared ? 0 : 1);
        assertThat(executions.getOrDefault(runtimeId, 0)).as("physical worker dispatches").isEqualTo(prepared ? 0 : 1);
        assertThat(Files.readString(Path.of(session.get("directory").toString()).resolve("proof.txt"))).isEqualTo(prepared ? "x" : "xx");
        if (prepared) assertThat(row.get("execution_status")).isNull();
        else assertThat(row.get("execution_status")).isEqualTo("success");
        boolean released = phase.equals("released");
        if (released) {
            assertThat(releases.getOrDefault(runtimeId, 0)).as("worker closures forwarded")
                    .isEqualTo(session.get("fault").equals("release-reply") ? dropped + 1 : 1);
            assertThat(owner(session).get("holder_key")).isNull();
            assertThat(deactivations.getOrDefault(runtimeId, 0)).isEqualTo(1);
            assertThat(sessionState(session, runtimeId)).isEqualTo("RELEASED");
        } else {
            assertThat(owner(session)).isEqualTo(owners.get(id));
            assertThat(deactivations.getOrDefault(runtimeId, 0)).isZero();
            assertThat(sessionState(session, runtimeId)).isEqualTo(
                    List.of("uncertain", "resume").contains(phase) ? "RELEASING" : "READY");
        }
        if (phase.equals("uncertain") || phase.equals("resume")) {
            assertThat(session.get("fault")).isEqualTo("release-reply");
            assertThat(dropped).isPositive();
        }
        if (phase.equals("resume")) loseReleaseReply = false;
    }

    void assertReport(Map<String, Object> session, JsonNode report) throws Exception {
        assertThat(failure.get()).as("provider proxy/probe").isNull();
        check(session, "released");
        var row = execution(session);
        assertThat(row.get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
        JsonNode expected = report.path("reference").deepCopy();
        if (session.get("fault").equals("raw-contract")) ((ObjectNode) expected).put("dispatchMode", "deferred");
        assertThat(JSON.readTree(row.get("reference_json").toString())).isEqualTo(expected);
        assertThat(row.get("idempotency_key")).isEqualTo(report.path("reservation").path("idempotencyKey").asText());
        System.out.println("FG6F_PROVIDER_LEDGER " + session.get("fault") + " original=" + row.get("execution_call_id")
                + " dispatch=1 effect=once owner=released");
    }

    @Override
    public void close() throws Exception {
        forwarded.shutdownNow();
        upstream.shutdownNow();
        captureProcesses();
        processes.forEach(ProcessHandle::destroyForcibly);
        for (ProcessHandle process : processes) {
            if (process.isAlive()) process.onExit().get(10, TimeUnit.SECONDS);
            assertThat(process.isAlive()).as("provider worker cleanup %s", process.pid()).isFalse();
        }
    }
}
