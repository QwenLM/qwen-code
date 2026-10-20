package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.session.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.workspace.runtime.EmbeddedRuntimeBroker;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
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
                    case "workers" -> workers();
                    case "runtime" -> runtime(sessionId);
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
        try (var relayStream = HostedGateTestSupport.openRelayStream(request,
                sessionId, "FG8 actual POST /session response")) {
            activeStream.set(relayStream.stream());
            while (true) {
                com.alibaba.qwen.code.daemon.DaemonEvent event;
                try {
                    event = relayStream.stream().next();
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
                var projected = HostedGateTestSupport.projectEvent(projector,
                        event, turnId);
                if (projected == null) {
                    continue;
                }
                HostedGateTestSupport.appendProjected(store, tenant,
                        sessionId, relayStream, event, projected, turnId);
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
                "monitors", HostedGateTestSupport.extensionRecords(jdbc,
                        tenant, sessionId, "monitor_run"),
                "childRuns", HostedGateTestSupport.extensionRecords(jdbc,
                        tenant, sessionId, "child_run"),
                // FG8f sequences on the committed tool-result resources:
                // the driver watches full segments land before it kills or
                // arms the store-proxy faults.
                "resources", jdbc.queryForList(
                        "SELECT resource_id, kind, byte_length, sha256 FROM"
                                + " ma_resource WHERE session_scope_key = ?"
                                + " AND tenant_id = ? AND session_id = ? AND"
                                + " kind LIKE 'managed-tool-result-%' ORDER"
                                + " BY gmt_create, resource_id",
                        scopeKey(sessionId), tenant, sessionId),
                "relayAlive", relay != null && !relay.isDone(),
                "relayFailure", relayFailure == null ? ""
                        : relayFailure.toString());
    }

    // ma_resource keys on the Session's scope key and holds the inline
    // capture bytes, and the drivers poll these reads: filtered by the
    // unindexed tenant and session columns alone, each poll scans all the
    // bytes the lane has written so far (FG8f alone inlines tens of MiB a
    // case), so each later letter polls slower. The record read leads with
    // the same key.
    private String scopeKey(String sessionId) {
        return com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore
                .sessionScopeKey(tenant, sessionId);
    }

    // FG8c: the in-JVM embedded broker spawns each binding's managed worker
    // as a direct child of this JVM, so the live worker set is exactly the
    // JVM's children carrying the worker argument. The driver diffs it
    // around a case's first dispatch to name the one worker it signals.
    private List<Long> workers() {
        return ProcessHandle.current().children()
                .filter(ProcessHandle::isAlive)
                .filter(process -> List.of(process.info().arguments()
                        .orElse(new String[0]))
                        .contains("managed-runtime-worker"))
                .map(ProcessHandle::pid).sorted().toList();
    }

    // FG8c's generation ground truth: the Session's bindings (isolation is
    // per Harness Session), their slots and Runtime Sessions, and the full
    // loss fields of its execution rows.
    private Map<String, Object> runtime(String sessionId) {
        var bindings = jdbc.queryForList(
                "SELECT CAST(binding_id AS CHAR) AS binding_id, request_key,"
                        + " binding_state, runtime_generation,"
                        + " loss_evidence_json IS NOT NULL AS loss_evidence,"
                        + " stop_evidence_json IS NOT NULL AS stop_evidence,"
                        + " drain_requested FROM ma_runtime_binding WHERE"
                        + " tenant_id = ? AND isolation_key = ? ORDER BY"
                        + " runtime_generation", tenant, sessionId);
        var slots = new java.util.ArrayList<Map<String, Object>>();
        for (var key : bindings.stream().map(row -> row.get("request_key"))
                .distinct().toList()) {
            slots.addAll(jdbc.queryForList(
                    "SELECT request_key, last_generation,"
                            + " CAST(active_binding_id AS CHAR) AS"
                            + " active_binding_id FROM ma_runtime_slot"
                            + " WHERE request_key = ?", key));
        }
        return Map.of("bindings", bindings, "slots", slots,
                "runtimeSessions", jdbc.queryForList(
                        "SELECT CAST(runtime_session_id AS CHAR) AS"
                                + " runtime_session_id, session_state,"
                                + " runtime_generation FROM"
                                + " ma_runtime_session WHERE tenant_id = ?"
                                + " AND harness_session_id = ? ORDER BY"
                                + " last_active_at", tenant, sessionId),
                "executions", jdbc.queryForList(
                        "SELECT CAST(execution_call_id AS CHAR) AS"
                                + " execution_call_id, execution_state,"
                                + " execution_status, runtime_generation,"
                                + " CAST(runtime_session_id AS CHAR) AS"
                                + " runtime_session_id, CAST(loss_evidence_id"
                                + " AS CHAR) AS loss_evidence_id,"
                                + " abandoned_at IS NOT NULL AS abandoned,"
                                + " CAST(result_json AS CHAR) AS result_json"
                                + " FROM ma_tool_execution WHERE"
                                + " harness_session_id = ? ORDER BY"
                                + " execution_call_id", sessionId));
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
