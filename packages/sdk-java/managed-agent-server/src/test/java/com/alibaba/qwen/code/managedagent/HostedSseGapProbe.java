package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.StreamHarnessEvents;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.service.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.service.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.Principal;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

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

    static FilterRegistrationBean<Filter> authentication(String tenant) {
        AuthenticatedTenantActor actor = new AuthenticatedTenantActor() {
            public String tenantId() { return tenant; }
            public String actorId() { return "actor"; }
            public String getName() { return "fg6e-fixture"; }
        };
        FilterRegistrationBean<Filter> registration = new FilterRegistrationBean<>((request, response, chain) ->
                chain.doFilter(new HttpServletRequestWrapper((HttpServletRequest) request) {
                    @Override
                    public Principal getUserPrincipal() { return actor; }
                }, response));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        registration.setAsyncSupported(true);
        registration.setDispatcherTypes(DispatcherType.REQUEST, DispatcherType.ASYNC);
        registration.addUrlPatterns("/v1/agents/*", "/api/agent/web-shell/v1/*");
        return registration;
    }

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
                    case "entered" -> { assertExecution(false); yield Map.of(); }
                    case "held" -> Map.of("held", terminalHeld.getCount() == 0);
                    case "finished" -> {
                        assertExecution(true);
                        assertThat(terminalHeld.getCount()).isZero();
                        var events = events();
                        assertThat(events).extracting(row -> row.get("event_type"))
                                .containsExactly("session.created", "item.output_text.delta");
                        yield events;
                    }
                    case "release" -> { releaseTerminal.countDown(); yield Map.of(); }
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
        try (var client = HostedHarnessClient.builder().baseUri(URI.create(request.path("baseUrl").asText()))
                .bearerToken("hosted-process-fixture-token").capabilityDigest("sha256:" + "a".repeat(64)).build()) {
            assertThat(client.capabilities().getBootId()).isEqualTo(request.path("bootId").asText());
            // Use the real create response: SDK creation does not yet expose the private tool profile.
            HarnessSessionRef ref = ReflectionTestUtils.invokeMethod(client, "parseSession",
                    request.path("created").toString(), session, "FG6e actual POST /session response");
            try (var stream = client.streamEvents(StreamHarnessEvents.builder().session(ref)
                    .lastEventId(ref.getHarnessLastEventId()).eventEpoch(ref.getHarnessEventEpoch()).build())) {
                while (true) {
                    var event = stream.next();
                    assertThat(event).as("real source terminal required").isNotNull();
                    var projected = projector.project(new SourceEvent(event.getId(), event.getType(), event.getData(),
                            event.getPromptId(), event.getMetadata()), promptId);
                    if (projected == null) continue;
                    assertThat(event.getPromptId()).isEqualTo(promptId);
                    if (projected.terminal()) {
                        terminalHeld.countDown();
                        assertThat(releaseTerminal.await(45, TimeUnit.SECONDS)).as("terminal release").isTrue();
                    }
                    String key = ref.getHarnessBootId() + ":" + stream.getEventEpoch() + ":" + event.getId();
                    sourceKeys.add(key);
                    store.appendPublicEventIfAbsent(tenant, session, promptId, projected.type(), projected.data(),
                            projected.terminal(), key);
                    if (projected.terminal()) break;
                }
            }
        } catch (Throwable error) {
            failure.compareAndSet(null, error);
        }
    }

    private List<Map<String, Object>> events() {
        return jdbc.queryForList("SELECT * FROM managed_agent_event WHERE tenant_id = ? AND session_id = ?"
                + " ORDER BY sequence_id", tenant, session);
    }

    private void assertExecution(boolean finished) throws Exception {
        var rows = jdbc.queryForList("SELECT * FROM qwen_tool_execution WHERE harness_session_id = ?", session);
        assertThat(rows).hasSize(1);
        var execution = rows.getFirst();
        if (!finished) executionId = execution.get("execution_call_id").toString();
        assertThat(execution.get("execution_call_id")).isEqualTo(executionId);
        String storageKey = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((tenant + "\u0000storage-0").getBytes(StandardCharsets.UTF_8)));
        var owner = jdbc.queryForMap("SELECT * FROM managed_workspace_execution_lease WHERE storage_key = ?", storageKey);
        if (finished) assertThat(owner.get("holder_key")).isNull();
        else {
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
        assertThat(jdbc.queryForObject("SELECT session_state FROM qwen_runtime_session WHERE harness_session_id = ?"
                + " AND runtime_session_id = ?", String.class, session, promptId)).isEqualTo(finished ? "RELEASED" : "READY");
        if (finished) assertThat(Files.readString(proof)).isEqualTo("xx");
        var records = jdbc.queryForList("SELECT record_bytes FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ? ORDER BY journal_revision", byte[].class, tenant, session);
        var events = new ArrayList<JsonNode>();
        for (byte[] record : records) {
            for (String line : new String(record, StandardCharsets.UTF_8).lines().toList()) {
                JsonNode value = JSON.readTree(line);
                if (value.path("subtype").asText().equals("managed_session_event_v1")) events.add(value.path("managedSession"));
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
                .containsExactly("session.created", "item.output_text.delta", "turn.completed");
        assertThat(events.stream().skip(1).map(row -> row.get("source_key")).toList()).isEqualTo(sourceKeys);
        assertThat(events.stream().map(row -> ((Number) row.get("sequence_id")).longValue()).toList())
                .containsExactly(1L, 2L, 3L);
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
        for (Process process : processes) assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue();
        if (relay != null) relay.get(10, TimeUnit.SECONDS);
    }
}
