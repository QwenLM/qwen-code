package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class HostedProviderMediaProbeTest {
    @TempDir
    Path directory;

    @Test
    @Timeout(10)
    void droppedEvidenceRequiresTheActualSingleLostExecuteInjection() throws Exception {
        ObjectMapper json = new ObjectMapper();
        Map<String, Object> session = Map.of("sessionId", "harness", "fault", "lost-execute",
                "directory", directory.toString());
        byte[] original = "original PDF".getBytes(StandardCharsets.UTF_8);
        byte[] replacement = "replacement PDF".getBytes(StandardCharsets.UTF_8);
        Files.write(directory.resolve("proof.pdf"), original);
        Files.write(directory.resolve("proof.pdf.replacement"), replacement);
        var probe = mock(HostedProviderMediaProbe.class, CALLS_REAL_METHODS);
        HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
        ReflectionTestUtils.setField(probe, "upstream", client);
        ReflectionTestUtils.setField(probe, "sessions", List.of(session));
        ReflectionTestUtils.setField(probe, "dispatches", new ConcurrentHashMap<String, Integer>());
        ReflectionTestUtils.setField(probe, "executed", new ConcurrentHashMap<String, JsonNode>());
        ReflectionTestUtils.setField(probe, "finished", ConcurrentHashMap.newKeySet());
        ReflectionTestUtils.setField(probe, "processes", ConcurrentHashMap.newKeySet());
        ReflectionTestUtils.setField(probe, "provisioner", new EmptyOwned());
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(probe, "check",
                session, "dropped", json.createObjectNode())).containsEntry("done", false);

        AtomicInteger workerRequests = new AtomicInteger();
        byte[] response = json.writeValueAsBytes(Map.of("result", Map.of("result", Map.of("llmContent", "original PDF"))));
        HttpServer worker = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        worker.createContext("/internal/managed-runtime/provider/v1/control", exchange -> {
            exchange.getRequestBody().readAllBytes();
            workerRequests.incrementAndGet();
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        worker.start();
        try {
            URI uri = URI.create("http://127.0.0.1:" + worker.getAddress().getPort()
                    + "/internal/managed-runtime/provider/v1/control");
            byte[] body = json.writeValueAsBytes(Map.of("providerProtocol", "managed-runtime-provider/1",
                    "session", Map.of("harnessSessionId", "harness"),
                    "operation", Map.of("kind", "execute", "reference", Map.of(
                            "sessionId", "runtime", "promptId", "prompt", "callId", "call",
                            "invocationId", "invocation", "argsDigest", "args", "capabilityDigest", "capability",
                            "policyRevision", "policy"))));
            HttpExchange exchange = mock(HttpExchange.class);
            ByteArrayOutputStream forwarded = new ByteArrayOutputStream();
            when(exchange.getRequestMethod()).thenReturn("POST");
            when(exchange.getRequestURI()).thenReturn(uri);
            when(exchange.getRequestBody()).thenAnswer(ignored -> new ByteArrayInputStream(body));
            when(exchange.getRequestHeaders()).thenReturn(new Headers());
            when(exchange.getResponseHeaders()).thenReturn(new Headers());
            when(exchange.getResponseBody()).thenReturn(forwarded);

            ReflectionTestUtils.invokeMethod(probe, "forward", exchange);
            assertThat(workerRequests.get()).isEqualTo(1);
            assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(probe, "check",
                    session, "dropped", json.createObjectNode())).containsEntry("done", true);
            assertThat(ReflectionTestUtils.getField(probe, "dropped")).isEqualTo(1);
            assertThat(Files.readAllBytes(directory.resolve("proof.pdf"))).isEqualTo(replacement);
            verify(exchange, never()).sendResponseHeaders(anyInt(), anyLong());
            assertThat(forwarded.size()).isZero();

            ReflectionTestUtils.invokeMethod(probe, "forward", exchange);
            assertThat(workerRequests.get()).isEqualTo(2);
            assertThat(ReflectionTestUtils.getField(probe, "dropped")).isEqualTo(1);
            verify(exchange).sendResponseHeaders(200, response.length);
            assertThat(forwarded.toByteArray()).isEqualTo(response);
        } finally {
            worker.stop(0);
            client.close();
        }
    }

    @Test
    void mediaEvidenceUsesTheCanonicalSchemaAndPhysicalExecutionMembership() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:media-" + java.util.UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        String tenant = "media-租户";
        String physical = "a".repeat(64);
        Map<String, Object> session = Map.of("sessionId", "harness", "fault", "lost-execute",
                "directory", directory.toString());
        JsonNode reference = new ObjectMapper().valueToTree(Map.of(
                "sessionId", "runtime", "promptId", "prompt", "callId", "call",
                "invocationId", "invocation", "argsDigest", "args", "capabilityDigest", "capability",
                "policyRevision", "policy"));
        jdbc.update("INSERT INTO ma_tool_execution (execution_call_id_hash, execution_call_id,"
                + " idempotency_key_hash, idempotency_key, binding_id, runtime_generation, harness_session_id,"
                + " runtime_session_id, runtime_session_key, turn_id, tool_call_id, request_digest,"
                + " reference_json, execution_state, last_sequence, cancel_requested, dispatch_generation,"
                + " record_version) VALUES (?, 'execute', ?, 'key', 'binding', 1, 'harness', 'runtime', ?,"
                + " 'turn', 'call', 'digest', ?, 'PREPARED', 0, FALSE, 0, 1)",
                "b".repeat(64), "c".repeat(64), "d".repeat(64), reference.toString());
        jdbc.update("INSERT INTO ma_runtime_session (scope_key, runtime_session_id, tenant_id, workspace_id,"
                + " workspace_generation, canonical_cwd, capability_digest, isolation_class, harness_session_id,"
                + " turn_kind, binding_id, runtime_generation, session_state, record_version, last_active_at,"
                + " execution_storage_key)"
                + " VALUES (?, 'runtime', ?, 'workspace', '1', '/', 'capability', 'process', 'harness',"
                + " 'tool', 'binding', 1, 'READY', 1, ?, ?)", "e".repeat(64), tenant, System.currentTimeMillis(), physical);
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key, tenant_id, storage_id, physical_key)"
                + " VALUES (?, ?, ?, ?, 'storage-0', ?)",
                JdbcRuntimeBindingRepository.storageAliasKey(tenant, "storage-0"),
                "f".repeat(64), "0".repeat(64), tenant, physical);
        jdbc.update("INSERT INTO ma_storage_owner (storage_key) VALUES (?)", physical);
        var probe = mock(HostedProviderMediaProbe.class, CALLS_REAL_METHODS);
        ReflectionTestUtils.setField(probe, "jdbc", jdbc);
        ReflectionTestUtils.setField(probe, "tenant", tenant);
        ReflectionTestUtils.setField(probe, "sessions", List.of(session));
        ReflectionTestUtils.setField(probe, "references", new ConcurrentHashMap<String, JsonNode>());
        ReflectionTestUtils.setField(probe, "dispatches", new ConcurrentHashMap<String, Integer>());
        ReflectionTestUtils.setField(probe, "executed", new ConcurrentHashMap<String, JsonNode>());
        ReflectionTestUtils.setField(probe, "hashes", new ConcurrentHashMap<String, String>());
        ReflectionTestUtils.setField(probe, "lengths", new ConcurrentHashMap<String, Integer>());
        ReflectionTestUtils.setField(probe, "readCounts", new ConcurrentHashMap<String, String>());
        var fields = new ObjectMapper().createObjectNode().put("executionCallId", "execute");
        fields.set("reference", reference);
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(probe, "check", session, "prepared", fields))
                .containsEntry("checked", "prepared");
        jdbc.update("UPDATE ma_runtime_session SET execution_storage_key=?", "9".repeat(64));
        assertThatThrownBy(() -> ReflectionTestUtils.invokeMethod(probe, "check", session, "prepared", fields))
                .isInstanceOf(AssertionError.class).hasMessageContaining("physical execution membership");
        jdbc.update("UPDATE ma_runtime_session SET execution_storage_key=?", physical);
        jdbc.update("UPDATE ma_runtime_session SET binding_id='other'");
        assertThatThrownBy(() -> ReflectionTestUtils.invokeMethod(probe, "check", session, "prepared", fields))
                .isInstanceOf(AssertionError.class).hasMessageContaining("original runtime binding");
        jdbc.update("UPDATE ma_runtime_session SET binding_id='binding', runtime_generation=2");
        assertThatThrownBy(() -> ReflectionTestUtils.invokeMethod(probe, "check", session, "prepared", fields))
                .isInstanceOf(AssertionError.class).hasMessageContaining("original runtime generation");
        jdbc.update("UPDATE ma_runtime_session SET runtime_generation=1, execution_exclusive=TRUE");
        assertThatThrownBy(() -> ReflectionTestUtils.invokeMethod(probe, "check", session, "prepared", fields))
                .isInstanceOf(AssertionError.class).hasMessageContaining("shared execution membership");
        jdbc.update("UPDATE ma_runtime_session SET execution_exclusive=FALSE");
        jdbc.update("UPDATE ma_tool_execution SET execution_state='SETTLED', execution_status='success',"
                + " dispatch_generation=1, result_json='{}'");
        ReflectionTestUtils.setField(probe, "dispatches", Map.of("runtime", 1));
        ReflectionTestUtils.setField(probe, "executed", Map.of("runtime", reference));
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(probe, "check", session, "settled", fields))
                .containsEntry("checked", "settled");
        jdbc.update("UPDATE ma_runtime_session SET session_state='RELEASED'");
        assertThatThrownBy(() -> ReflectionTestUtils.invokeMethod(probe, "check", session, "released", fields))
                .isInstanceOf(AssertionError.class).hasMessageContaining("physical execution membership");
        jdbc.update("UPDATE ma_runtime_session SET execution_storage_key=NULL");
        Files.writeString(directory.resolve(".provider-media-reads.json"), "{}");
        assertThat(ReflectionTestUtils.<Map<String, Object>>invokeMethod(probe, "check", session, "released", fields))
                .containsEntry("checked", "released");
    }

    private static class EmptyOwned {
        private final Map<String, Object> owned = Map.of();
    }
}
