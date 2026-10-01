package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

final class HostedCancellationProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final List<Map<String, Object>> sessions;
    private final Object service;
    private final RuntimeTransport transport;
    private final Map<String, AtomicInteger> executions = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> completions = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> cancellations = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Object>> owners = new ConcurrentHashMap<>();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();

    HostedCancellationProbe(JdbcTemplate jdbc, String tenant, List<Map<String, Object>> sessions,
            EmbeddedRuntimeBroker broker, HttpServer server) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        this.sessions = sessions;
        service = ReflectionTestUtils.getField(broker, "service");
        transport = (RuntimeTransport) ReflectionTestUtils.getField(service, "transport");
        RuntimeTransport observed = (RuntimeTransport) Proxy.newProxyInstance(RuntimeTransport.class.getClassLoader(),
                new Class<?>[] {RuntimeTransport.class}, (proxy, method, args) -> {
                    String session = args != null && args.length > 1 && args[1] instanceof RuntimeSession runtime
                            ? runtime.getHarnessSessionId() : null;
                    if (method.getName().equals("execute")) increment(executions, session);
                    if (method.getName().equals("cancel")) increment(cancellations, session);
                    Object result;
                    try {
                        result = method.invoke(transport, args);
                    } catch (InvocationTargetException exception) {
                        throw exception.getCause();
                    }
                    if (method.getName().equals("execute")) {
                        return ((CompletionStage<?>) result).thenApply(value -> {
                            increment(completions, session);
                            return value;
                        });
                    }
                    return result;
                });
        ReflectionTestUtils.setField(service, "transport", observed);
        server.createContext("/cancellation/", exchange -> {
            try {
                assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                String[] route = exchange.getRequestURI().getPath().split("/");
                assertThat(route).hasSize(4);
                Map<String, Object> session = sessions.stream()
                        .filter(value -> value.get("sessionId").equals(route[2])).findFirst().orElseThrow();
                byte[] response = JSON.writeValueAsBytes(check(session, route[3]));
                exchange.sendResponseHeaders(200, response.length);
                exchange.getResponseBody().write(response);
            } catch (Throwable error) {
                failure.compareAndSet(null, error);
                byte[] response = error.toString().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, response.length);
                exchange.getResponseBody().write(response);
            } finally {
                exchange.close();
            }
        });
    }

    private Map<String, Object> execution(String session) {
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_execution WHERE harness_session_id = ?", session);
        assertThat(rows).hasSize(1);
        return rows.getFirst();
    }

    private Map<String, Object> owner(Map<String, Object> session) throws Exception {
        String storageKey = sha256((tenant + "\u0000storage-" + sessions.indexOf(session)).getBytes(StandardCharsets.UTF_8));
        return jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", storageKey);
    }

    private Map<String, Object> check(Map<String, Object> session, String phase) throws Exception {
        String id = session.get("sessionId").toString();
        String fault = session.get("fault").toString();
        boolean prepared = fault.equals("prepared");
        boolean blocked = List.of("status-unavailable", "cancel-reply").contains(fault);
        var execution = execution(id);
        if (phase.equals("state")) return Map.of("state", execution.get("execution_state"));
        if (phase.equals("prepared")) {
            assertThat(owners.putIfAbsent(id, owner(session))).isNull();
            assertThat(execution.get("execution_state")).isEqualTo("PREPARED");
            assertThat(count(executions, id)).isZero();
        } else if (phase.equals("entered")) {
            assertThat(execution.get("execution_state")).isEqualTo("EXECUTING");
            assertThat(count(executions, id)).isEqualTo(1);
            assertThat(count(completions, id)).isZero();
        } else if (phase.equals("pending")) {
            assertThat(prepared).isFalse();
            assertThat(execution.get("execution_state")).isEqualTo("CANCEL_REQUESTED");
            assertThat(execution.get("execution_status")).isNull();
            assertThat(execution.get("result_json")).isNull();
            assertThat(count(executions, id)).isEqualTo(1);
            assertThat(count(completions, id)).as("Cancellation ACK is not physical settlement").isZero();
            assertThat(count(cancellations, id)).isEqualTo(blocked ? 2 : 1);
            assertJournal(session, false, false, "await_runtime");
        } else {
            assertThat(phase).isIn("release", "finished");
            assertThat(execution.get("execution_state")).isEqualTo("SETTLED");
            assertThat(execution.get("execution_status")).isEqualTo("cancelled");
            assertThat(count(executions, id)).isEqualTo(prepared ? 0 : 1);
            assertThat(count(completions, id)).isEqualTo(prepared ? 0 : 1);
            assertThat(count(cancellations, id)).isEqualTo(prepared ? 0 : blocked ? 2 : 1);
            assertThat(Files.readString(Path.of(session.get("directory").toString()).resolve("proof.txt")))
                    .isEqualTo(prepared ? "x" : "xx");
            assertJournal(session, !blocked, phase.equals("finished") && !blocked,
                    blocked ? "await_runtime" : phase.equals("release") ? "results_ready" : "before_model");
        }
        assertThat(((Number) execution.get("dispatch_generation")).longValue())
                .isEqualTo(phase.equals("prepared") || prepared ? 0 : 1);
        boolean released = phase.equals("finished") && !blocked;
        var owner = owner(session);
        var original = owners.get(id);
        assertThat(original).as("captured storage owner").isNotNull();
        assertThat(original.get("binding_id")).isEqualTo(execution.get("binding_id"));
        assertThat(original.get("runtime_generation")).isEqualTo(execution.get("runtime_generation"));
        assertThat(original.get("runtime_session_id")).isEqualTo(execution.get("runtime_session_id"));
        assertThat(original.get("holder_key")).isEqualTo(sha256((execution.get("binding_id") + "\u0000"
                + execution.get("runtime_generation") + "\u0000" + execution.get("runtime_session_id"))
                .getBytes(StandardCharsets.UTF_8)));
        if (released) assertThat(owner.get("holder_key")).isNull();
        else assertThat(owner).as("original owner until confirmed cancellation").isEqualTo(original);
        assertThat(jdbc.queryForObject("SELECT session_state FROM qwen_runtime_session WHERE harness_session_id = ?"
                + " AND runtime_session_id = ?", String.class, id, execution.get("runtime_session_id")))
                .isEqualTo(released ? "RELEASED" : "READY");
        return Map.of("state", execution.get("execution_state"), "executions", count(executions, id),
                "completions", count(completions, id), "cancellations", count(cancellations, id));
    }

    void assertReport(Map<String, Object> session, JsonNode report) throws Exception {
        assertThat(failure.get()).as("independent cancellation probe").isNull();
        assertThat(report.path("fault").asText()).isEqualTo(session.get("fault"));
        var row = execution(session.get("sessionId").toString());
        assertThat(row.get("execution_call_id")).isEqualTo(report.path("executionCallId").asText());
        assertThat(row.get("idempotency_key")).isEqualTo(report.path("idempotencyKey").asText());
        assertThat(row.get("runtime_session_id")).isEqualTo(report.path("promptId").asText());
        assertThat(row.get("turn_id")).isEqualTo(report.path("promptId").asText());
        System.out.println("FG6D_LEDGER " + session.get("fault") + " " + JSON.writeValueAsString(check(session, "finished")));
    }

    private void assertJournal(Map<String, Object> session, boolean result, boolean terminal, String phase) throws Exception {
        String id = session.get("sessionId").toString();
        var rows = jdbc.queryForList("SELECT * FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision", tenant, id);
        var events = new ArrayList<JsonNode>();
        var transactions = new HashSet<String>();
        var identities = new HashSet<String>();
        long revision = 0;
        long sequence = 0;
        for (var row : rows) {
            assertThat(((Number) row.get("journal_revision")).longValue()).isEqualTo(++revision);
            assertThat(transactions.add(row.get("transaction_id").toString())).isTrue();
            for (String line : new String((byte[]) row.get("record_bytes"), StandardCharsets.UTF_8).lines().toList()) {
                JsonNode record = JSON.readTree(line);
                if (!record.path("subtype").asText().equals("managed_session_event_v1")) continue;
                JsonNode event = record.path("managedSession");
                assertThat(event.path("sequence").asLong()).isEqualTo(++sequence);
                assertThat(identities.add(event.path("eventId").asText())).isTrue();
                assertThat(event.path("sessionKey").path("sessionId").asText()).isEqualTo(id);
                events.add(event);
            }
        }
        var execution = execution(id);
        var inputs = events.stream().filter(event -> event.path("kind").asText().equals("input.accepted")).toList();
        assertThat(inputs).hasSize(1);
        assertThat(inputs.getFirst().path("payload").path("turnId").asText()).isEqualTo(execution.get("turn_id"));
        var intents = events.stream().filter(event -> event.path("kind").asText().equals("tool.intent")).toList();
        assertThat(intents).hasSize(1);
        assertThat(intents.getFirst().path("payload").path("executionCallId").asText()).isEqualTo(execution.get("execution_call_id"));
        var terminals = events.stream().filter(event -> event.path("kind").asText().equals("turn.settled")).toList();
        assertThat(terminals).hasSize(terminal ? 1 : 0);
        if (terminal) {
            assertThat(terminals.getFirst().path("payload").path("outcome").asText()).isEqualTo("cancelled");
            assertThat(terminals.getFirst().path("payload").path("turnId").asText()).isEqualTo(execution.get("turn_id"));
        }
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("message.committed")
                && event.path("payload").path("role").asText().equals("tool_result"))).hasSize(result ? 1 : 0);
        var outcomes = jdbc.queryForList("SELECT inline_bytes FROM qwen_managed_session_resource WHERE tenant_id = ?"
                + " AND session_id = ? AND kind = 'managed-tool-outcome'", byte[].class, tenant, id);
        assertThat(outcomes).hasSize(result ? 1 : 0);
        if (result) {
            JsonNode outcome = JSON.readTree(outcomes.getFirst());
            assertThat(outcome.path("executionCallId").asText()).isEqualTo(execution.get("execution_call_id"));
            assertThat(outcome.path("functionResponse").path("response").path("executionStatus").asText()).isEqualTo("cancelled");
        }
        var head = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?", tenant, id);
        assertThat(((Number) head.get("journal_revision")).longValue()).isEqualTo(revision);
        assertThat(((Number) head.get("committed_sequence")).longValue()).isEqualTo(sequence);
        byte[] bytes = jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource"
                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?", byte[].class, tenant, id,
                head.get("latest_checkpoint_resource_id"));
        assertThat(JSON.readTree(bytes).path("continuation").path("phase").asText()).isEqualTo(phase);
    }

    private static void increment(Map<String, AtomicInteger> counts, String session) {
        counts.computeIfAbsent(session, ignored -> new AtomicInteger()).incrementAndGet();
    }

    private static int count(Map<String, AtomicInteger> counts, String session) {
        AtomicInteger value = counts.get(session);
        return value == null ? 0 : value.get();
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    @Override
    public void close() throws InterruptedException {
        ReflectionTestUtils.setField(service, "transport", transport);
        Object provisioner = ReflectionTestUtils.getField(service, "provisioner");
        Object local = ReflectionTestUtils.getField(provisioner, "delegate");
        var owned = (Map<?, ?>) ReflectionTestUtils.getField(local, "owned");
        var processes = owned.values().stream()
                .map(value -> (Process) ReflectionTestUtils.getField(value, "process")).toList();
        processes.forEach(Process::destroyForcibly);
        for (Process process : processes) {
            assertThat(process.waitFor(5, TimeUnit.SECONDS)).as("Blocked worker cleanup").isTrue();
        }
    }
}
