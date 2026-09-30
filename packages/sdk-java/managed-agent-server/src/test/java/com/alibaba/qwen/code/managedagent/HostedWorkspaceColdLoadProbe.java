package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.LoadHarnessSession;
import com.alibaba.qwen.code.daemon.ManagedSessionStoreConnection;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;

final class HostedWorkspaceColdLoadProbe implements AutoCloseable {
    private final JdbcTemplate jdbc;
    private final String tenant;
    private final Map<String, byte[]> damaged = new HashMap<>();

    HostedWorkspaceColdLoadProbe(JdbcTemplate jdbc, String tenant, List<Map<String, Object>> sessions,
            String storeUrl, HttpServer server) {
        this.jdbc = jdbc;
        this.tenant = tenant;
        ObjectMapper json = new ObjectMapper();
        server.createContext("/cold-load", exchange -> {
            try {
                var request = json.readTree(exchange.getRequestBody());
                String sessionId = request.path("sessionId").asText();
                var session = sessions.stream().filter(value -> value.get("sessionId").equals(sessionId))
                        .findFirst().orElseThrow();
                byte[] response;
                int status = 200;
                if (request.has("damage")) {
                    String manifestId = request.path("manifestResourceId").asText();
                    var manifest = json.readTree(resource(sessionId, manifestId));
                    String sealId = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                            json.writeValueAsBytes(List.of(manifest.path("captureId").asText(), "stderr", "seal"))));
                    if (request.path("damage").asBoolean()) {
                        assertThat(damaged.putIfAbsent(sealId, resource(sessionId, sealId))).isNull();
                        assertThat(jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ?"
                                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                                new byte[0], tenant, sessionId, sealId)).isEqualTo(1);
                    } else {
                        byte[] original = damaged.remove(sealId);
                        assertThat(original).isNotNull();
                        assertThat(jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ?"
                                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                                original, tenant, sessionId, sealId)).isEqualTo(1);
                    }
                    response = json.writeValueAsBytes(Map.of("resourceId", sealId));
                } else {
                    try (var client = HostedHarnessClient.builder()
                            .baseUri(URI.create(request.path("harnessUrl").asText()))
                            .bearerToken("hosted-process-fixture-token")
                            .capabilityDigest("sha256:" + "a".repeat(64))
                            .requestTimeout(Duration.ofSeconds(90))
                            .heartbeatInterval(Duration.ZERO).build()) {
                        var connection = ManagedSessionStoreConnection.builder()
                                .baseUri(URI.create(request.path("storeUrl").asText(storeUrl)))
                                .tenantId(tenant).workspaceId(session.get("workspaceId").toString())
                                .writerId(client.capabilities().getBootId()).build();
                        var loaded = client.loadSession(new LoadHarnessSession(sessionId, connection));
                        response = json.writeValueAsBytes(Map.of("clientId", loaded.getHarnessClientId(),
                                "bootId", loaded.getHarnessBootId()));
                    } catch (DaemonHttpException error) {
                        status = error.getStatusCode();
                        response = error.getResponseBody().getBytes(StandardCharsets.UTF_8);
                    }
                }
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(status, response.length);
                exchange.getResponseBody().write(response);
            } catch (Throwable error) {
                byte[] response = error.toString().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(500, response.length);
                exchange.getResponseBody().write(response);
            } finally {
                exchange.close();
            }
        });
    }

    private byte[] resource(String sessionId, String resourceId) {
        return jdbc.queryForObject("SELECT inline_bytes FROM qwen_managed_session_resource"
                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?", byte[].class,
                tenant, sessionId, resourceId);
    }

    @Override
    public void close() {
        damaged.forEach((id, bytes) -> jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ?"
                + " WHERE tenant_id = ? AND resource_id = ?", bytes, tenant, id));
    }
}
