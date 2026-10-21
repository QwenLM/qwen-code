package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.session.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.workspace.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

final class HostedSseGapProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final String session;
    private final Path proof;
    private final Object brokerService;
    private final CountDownLatch terminalHeld = new CountDownLatch(1);
    private final CountDownLatch releaseTerminal = new CountDownLatch(1);
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private final List<String> sourceKeys = new ArrayList<>();
    private CompletableFuture<Void> relay;
    private String promptId;
    private String executionId;

    HostedSseGapProbe(JdbcTemplate jdbc, String tenant, Map<String, Object> session,
            EmbeddedRuntimeBroker broker, ManagedAgentStore store, HarnessEventProjector projector, HttpServer server) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        this.session = session.get("sessionId").toString();
        proof = Path.of(session.get("directory").toString()).resolve("proof.txt");
        brokerService = ReflectionTestUtils.getField(broker, "service");
        server.createContext("/sse-gap/", exchange -> {
            try {
                assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                assertThat(failure.get()).as("source relay failure").isNull();
                String phase = exchange.getRequestURI().getPath().substring("/sse-gap/".length());
                Object response = switch (phase) {
                    case "start" -> {
                        assertThat(relay).isNull();
                        JsonNode request = JSON.readTree(exchange.getRequestBody());
                        promptId = request.path("promptId").asText();
                        relay = CompletableFuture.runAsync(() -> relay(request, store, projector));
                        yield Map.of();
                    }
                    case "entered" -> {
                        assertExecution(false);
                        yield Map.of();
                    }
                    case "held" -> Map.of("held", terminalHeld.getCount() == 0);
                    case "finished" -> {
                        assertExecution(true);
                        assertThat(terminalHeld.getCount()).isZero();
                        var events = events();
                        assertThat(events).extracting(row -> row.get("event_type"))
                                .containsExactly("session.created", "item.tool_call.updated",
                                        "item.tool_call.updated", "item.output_text.delta");
                        yield events;
                    }
                    case "release" -> {
                        releaseTerminal.countDown();
                        yield Map.of();
                    }
                    case "ledger" -> {
                        relay.get(10, TimeUnit.SECONDS);
                        assertThat(failure.get()).isNull();
                        yield events();
                    }
                    default -> throw new IllegalArgumentException(phase);
                };
                byte[] bytes = JSON.writeValueAsBytes(response);
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (Throwable error) {
                failure.compareAndSet(null, error);
                byte[] bytes = error.toString().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, bytes.length);
                exchange.getResponseBody().write(bytes);
            } finally {
                exchange.close();
            }
        });
    }

    private void relay(JsonNode request, ManagedAgentStore store, HarnessEventProjector projector) {
        try (var relay = HostedGateTestSupport.openRelayStream(request, session,
                "FG6e actual POST /session response")) {
            while (true) {
                var event = relay.stream().next();
                assertThat(event).as("real source terminal required").isNotNull();
                var projected = HostedGateTestSupport.projectEvent(projector, event, promptId);
                if (projected == null) {
                    continue;
                }
                assertThat(event.getPromptId()).isEqualTo(promptId);
                if (projected.terminal()) {
                    terminalHeld.countDown();
                    assertThat(releaseTerminal.await(45, TimeUnit.SECONDS)).as("terminal release").isTrue();
                }
                sourceKeys.add(HostedGateTestSupport.appendProjected(store, tenant, session, relay, event,
                        projected, promptId));
                if (projected.terminal()) {
                    break;
                }
            }
        } catch (Throwable error) {
            failure.compareAndSet(null, error);
        }
    }

    private List<Map<String, Object>> events() {
        return jdbc.queryForList("SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE tenant_id = ? AND session_id = ? ORDER BY sequence_id", tenant, session);
    }

    private void assertExecution(boolean finished) throws Exception {
        var rows = jdbc.queryForList("SELECT " + ManagedSchemaProjection.TOOL_EXECUTION.columns() + " FROM ma_tool_execution WHERE harness_session_id = ?", session);
        assertThat(rows).hasSize(1);
        var execution = rows.getFirst();
        if (!finished) {
            executionId = execution.get("execution_call_id").toString();
        }
        assertThat(execution.get("execution_call_id")).isEqualTo(executionId);
        String storage = "storage-0";
        var owner = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns("o") + " FROM ma_storage_owner o JOIN ma_storage s ON s.physical_key = o.storage_key WHERE s.alias_key = ? AND s.tenant_id = ? AND s.storage_id = ?",
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageAliasKey(tenant, storage),
                tenant, storage);
        if (finished) {
            assertThat(owner.get("holder_key")).isNull();
        } else {
            assertThat(owner.get("holder_key")).isNotNull();
            assertThat(owner.get("binding_id")).isEqualTo(execution.get("binding_id"));
            assertThat(owner.get("runtime_generation")).isEqualTo(execution.get("runtime_generation"));
            assertThat(owner.get("runtime_session_id")).isEqualTo(promptId);
        }
        assertThat(execution.get("turn_id")).isEqualTo(promptId);
        assertThat(execution.get("runtime_session_id")).isEqualTo(promptId);
        assertThat(execution.get("execution_state")).isEqualTo(finished ? "SETTLED" : "EXECUTING");
        assertThat(execution.get("execution_status")).isEqualTo(finished ? "success" : null);
        assertThat(((Number) execution.get("dispatch_generation")).intValue()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT session_state FROM ma_runtime_session WHERE harness_session_id = ?"
                + " AND runtime_session_id = ?", String.class, session, promptId)).isEqualTo(finished ? "RELEASED" : "READY");
        if (finished) {
            assertThat(Files.readString(proof)).isEqualTo("xx");
        }
        var records = jdbc.queryForList("SELECT record_bytes FROM ma_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision", byte[].class, tenant, session);
        var events = new ArrayList<JsonNode>();
        for (byte[] record : records) {
            for (String line : new String(record, StandardCharsets.UTF_8).lines().toList()) {
                JsonNode value = JSON.readTree(line);
                if (value.path("subtype").asText().equals("managed_session_event_v1")) {
                    events.add(value.path("managedSession"));
                }
            }
        }
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("input.accepted"))).hasSize(1);
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("tool.intent"))).hasSize(1);
        assertThat(events.stream().filter(event -> event.path("kind").asText().equals("message.committed")
                && event.path("payload").path("role").asText().equals("tool_result"))).hasSize(finished ? 1 : 0);
        var terminals = events.stream().filter(event -> event.path("kind").asText().equals("turn.settled")).toList();
        assertThat(terminals).hasSize(finished ? 1 : 0);
        if (finished) {
            assertThat(terminals.getFirst().path("payload").path("turnId").asText()).isEqualTo(promptId);
            assertThat(terminals.getFirst().path("payload").path("outcome").asText()).isEqualTo("completed");
        }
    }

    void assertReport(JsonNode report) throws Exception {
        relay.get(10, TimeUnit.SECONDS);
        assertThat(failure.get()).as("SSE probe").isNull();
        assertThat(report.path("promptId").asText()).isEqualTo(promptId);
        assertExecution(true);
        var events = events();
        assertThat(events).extracting(row -> row.get("event_type"))
                .containsExactly("session.created", "item.tool_call.updated",
                        "item.tool_call.updated", "item.output_text.delta", "turn.completed");
        assertThat(events.stream().skip(1).map(row -> row.get("source_key")).toList()).isEqualTo(sourceKeys);
        assertThat(events.stream().map(row -> ((Number) row.get("sequence_id")).longValue()).toList())
                .containsExactly(1L, 2L, 3L, 4L, 5L);
        System.out.println("FG6E_LEDGER " + session + " " + report);
    }

    @Override
    public void close() throws Exception {
        releaseTerminal.countDown();
        Object provisioner = ReflectionTestUtils.getField(brokerService, "provisioner");
        Object local = ReflectionTestUtils.getField(provisioner, "delegate");
        var owned = (Map<?, ?>) ReflectionTestUtils.getField(local, "owned");
        var processes = owned.values().stream()
                .map(value -> (Process) ReflectionTestUtils.getField(value, "process")).toList();
        processes.forEach(Process::destroyForcibly);
        for (Process process : processes) {
            assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue();
        }
        if (relay != null) {
            relay.get(10, TimeUnit.SECONDS);
        }
    }
}
