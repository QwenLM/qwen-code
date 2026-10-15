package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.HarnessEventStream;
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
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

// FG8 (issue #14054): the gate-side half of the monitor_run and background
// shell fault gates. The probe relays the Harness session's real event
// stream into the store's public projection (the production projector and
// append path; the loop is test-owned, like FG6e) across as many turns as
// the case drives, and answers the driver's ground-truth probes over JDBC.
final class HostedMonitorRunProbe implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final ManagedAgentStore store;
    private final HarnessEventProjector projector;
    // One relay per case: the latch and the failure record rebuild per
    // relay-start, and relay-stop hands the completed future back to null so
    // the next case's relay-start never reads it as still active.
    private volatile CountDownLatch stopRelay = new CountDownLatch(1);
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private final AtomicReference<HarnessEventStream> activeStream =
            new AtomicReference<>();
    private CompletableFuture<Void> relay;

    static FilterRegistrationBean<Filter> authentication(String tenant) {
        AuthenticatedTenantActor actor = new AuthenticatedTenantActor() {
            public String tenantId() {
                return tenant;
            }

            public String actorId() {
                return "actor";
            }

            public String getName() {
                return "fg8-fixture";
            }
        };
        FilterRegistrationBean<Filter> registration =
                new FilterRegistrationBean<>((request, response, chain) ->
                        chain.doFilter(new HttpServletRequestWrapper(
                                (HttpServletRequest) request) {
                            @Override
                            public Principal getUserPrincipal() {
                                return actor;
                            }
                        }, response));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        registration.setAsyncSupported(true);
        registration.setDispatcherTypes(DispatcherType.REQUEST,
                DispatcherType.ASYNC);
        registration.addUrlPatterns("/v1/agents/*",
                "/api/agent/web-shell/v1/*");
        return registration;
    }

    HostedMonitorRunProbe(JdbcTemplate jdbc, String tenant,
            EmbeddedRuntimeBroker broker, ManagedAgentStore store,
            HarnessEventProjector projector, HttpServer server) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        this.store = store;
        this.projector = projector;
        server.createContext("/fg8/", exchange -> {
            try {
                assertThat(exchange.getRequestMethod()).isEqualTo("POST");
                String[] route = exchange.getRequestURI().getPath()
                        .split("/");
                assertThat(route).hasSize(4);
                String sessionId = route[2];
                Object response = switch (route[3]) {
                    case "relay-start" -> {
                        // A completed relay from an earlier case is fine —
                        // it is reaped, not active. An in-flight one is not.
                        assertThat(relay == null || relay.isDone())
                                .as("one active relay").isTrue();
                        stopRelay = new CountDownLatch(1);
                        failure.set(null);
                        JsonNode request = JSON.readTree(
                                exchange.getRequestBody());
                        relay = CompletableFuture.runAsync(
                                () -> relay(sessionId, request));
                        yield Map.of();
                    }
                    case "relay-stop" -> {
                        stopRelay.countDown();
                        HarnessEventStream stream = activeStream.get();
                        if (stream != null) {
                            stream.close();
                        }
                        assertThat(relay).isNotNull();
                        relay.get(30, TimeUnit.SECONDS);
                        relay = null;
                        assertThat(failure.get()).as("FG8 relay failure")
                                .isNull();
                        yield Map.of();
                    }
                    case "state" -> state(sessionId);
                    case "ledger" -> ledger(sessionId);
                    default -> throw new IllegalArgumentException(route[3]);
                };
                byte[] bytes = JSON.writeValueAsBytes(response);
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            } catch (Throwable error) {
                failure.compareAndSet(null, error);
                byte[] bytes = error.toString().getBytes(
                        StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, bytes.length);
                exchange.getResponseBody().write(bytes);
            } finally {
                exchange.close();
            }
        });
    }

    // The relay follows every turn of the Session — the launch turn, the
    // observation or exit notification turns — projecting each event with
    // the turn it belongs to. relay-stop closes the stream; the blocked
    // read then ends the loop.
    private void relay(String sessionId, JsonNode request) {
        try (var client = HostedHarnessClient.builder()
                .baseUri(URI.create(request.path("baseUrl").asText()))
                .bearerToken("hosted-process-fixture-token")
                .capabilityDigest("sha256:" + "a".repeat(64)).build()) {
            assertThat(client.capabilities().getBootId())
                    .isEqualTo(request.path("bootId").asText());
            HarnessSessionRef ref = ReflectionTestUtils.invokeMethod(client,
                    "parseSession", request.path("created").toString(),
                    sessionId, "FG8 actual POST /session response");
            try (var stream = client.streamEvents(StreamHarnessEvents
                    .builder().session(ref)
                    .lastEventId(ref.getHarnessLastEventId())
                    .eventEpoch(ref.getHarnessEventEpoch()).build())) {
                activeStream.set(stream);
                while (true) {
                    com.alibaba.qwen.code.daemon.DaemonEvent event;
                    try {
                        event = stream.next();
                    } catch (IllegalStateException closed) {
                        if (stopRelay.getCount() == 0) {
                            return;
                        }
                        throw closed;
                    }
                    if (event == null) {
                        return;
                    }
                    String turnId = event.getPromptId();
                    var projected = projector.project(
                            new SourceEvent(event.getId(), event.getType(),
                                    event.getData(), event.getPromptId(),
                                    event.getMetadata()), turnId);
                    if (projected == null) {
                        continue;
                    }
                    String key = ref.getHarnessBootId() + ":"
                            + stream.getEventEpoch() + ":" + event.getId();
                    store.appendPublicEventIfAbsent(tenant, sessionId, turnId,
                            projected.type(), projected.data(),
                            projected.terminal(), key);
                }
            }
        } catch (Throwable error) {
            if (stopRelay.getCount() != 0) {
                failure.compareAndSet(null, error);
            }
        } finally {
            activeStream.set(null);
        }
    }

    private Map<String, Object> state(String sessionId) {
        var executions = jdbc.queryForList(
                "SELECT execution_call_id, execution_state, execution_status"
                        + " FROM ma_tool_execution WHERE harness_session_id"
                        + " = ? ORDER BY execution_call_id", sessionId);
        var relayFailure = failure.get();
        return Map.of("executions", executions,
                "monitors", extensionRecords(sessionId, "monitor_run"),
                "childRuns", extensionRecords(sessionId, "child_run"),
                // FG8f sequences on the committed tool-result resources:
                // the driver watches full segments land before it kills or
                // arms the store-proxy faults.
                "resources", jdbc.queryForList(
                        "SELECT resource_id, kind, byte_length, sha256 FROM"
                                + " ma_resource WHERE"
                                + " tenant_id = ? AND session_id = ? AND kind"
                                + " LIKE 'managed-tool-result-%' ORDER BY"
                                + " created_at, resource_id", tenant,
                        sessionId),
                "relayAlive", relay != null && !relay.isDone(),
                "relayFailure", relayFailure == null ? ""
                        : relayFailure.toString());
    }

    private List<JsonNode> extensionRecords(String sessionId, String domain) {
        try {
            var rows = jdbc.queryForList(
                    "SELECT record_id, record_resource_id FROM"
                            + " ma_session_record WHERE"
                            + " tenant_id = ? AND session_id = ? AND domain"
                            + " = ? ORDER BY created_at, record_id", tenant,
                    sessionId, domain);
            var records = new java.util.ArrayList<JsonNode>();
            for (var row : rows) {
                var resources = jdbc.queryForList(
                        "SELECT CONVERT(inline_bytes USING utf8mb4) AS body"
                                + " FROM ma_resource WHERE"
                                + " tenant_id = ? AND session_id = ? AND"
                                + " resource_id = ?", tenant, sessionId,
                        row.get("record_resource_id"));
                assertThat(resources).as(domain + " record body").hasSize(1);
                records.add(JSON.readTree(
                        resources.getFirst().get("body").toString()));
            }
            return records;
        } catch (java.io.IOException failure) {
            throw new IllegalStateException(failure);
        }
    }

    private List<Map<String, Object>> ledger(String sessionId) {
        // The surfaces serve the SESSION stream only — a child task's
        // state_changed audit rows share the sequence space but are never
        // streamed, so the gate's ground truth filters them out exactly
        // the way findEvents does.
        return jdbc.queryForList(
                "SELECT * FROM ma_public_event WHERE stream_kind = 'SESSION'"
                        + " AND stream_id = X'' AND tenant_id = ? AND"
                        + " session_id = ? ORDER BY sequence_id", tenant,
                sessionId);
    }

    @Override
    public void close() throws Exception {
        stopRelay.countDown();
        HarnessEventStream stream = activeStream.get();
        if (stream != null) {
            stream.close();
        }
        if (relay != null) {
            relay.get(10, TimeUnit.SECONDS);
        }
    }
}
