package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Private text producer for a previously committed original CSI Session. */
final class WorkspaceCsiHostedMain {
    private WorkspaceCsiHostedMain() {
    }

    record TextRequest(String promptId, String text) {
        TextRequest {
            if (promptId == null || !UUID.fromString(promptId).toString().equals(promptId)
                    || text == null || text.isBlank() || text.getBytes(StandardCharsets.UTF_8).length > 16 * 1024) {
                throw new IllegalArgumentException("Invalid private CSI text request");
            }
        }
    }

    static void run(String[] args) throws Exception {
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        var request = WorkspaceCsiRuntimeMain.readRequest(Path.of(args[1]), json);
        var text = readText(Path.of(args[2]), json);
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision(required("K2_AGENT_REVISION"));
        properties.getSessionStore().setBindingKey(required("QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY"));
        var credentials = new WriterCredentialPolicy(properties);
        var source = new DriverManagerDataSource(required("K2_JDBC_URL"), required("K2_JDBC_USER"),
                required("K2_JDBC_PASSWORD"));
        var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID"),
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY")));
        var access = new WorkspaceCsiRuntimeAccess(new JdbcTemplate(source), new DataSourceTransactionManager(source),
                json, properties, request.registration(), request.sessionId(), request.runtimeRequestKey(),
                bindings, new JdbcRuntimeSessionRepository(source), new HttpRuntimeTransport());
        var scope = access.resolve(request.sessionId()).toCompletableFuture().join();
        URI baseUri = hostedUri(required("K2_HOSTED_URL"));
        String token = required("K2_HOSTED_TOKEN");
        try (var negotiation = HostedHarnessClient.builder().baseUri(baseUri).bearerToken(token)
                .capabilityDigest(required("QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST")).build();
                var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
                        .followRedirects(HttpClient.Redirect.NEVER).build()) {
            String boot = negotiation.capabilities().getBootId();
            URI route = baseUri.resolve("/session/" + request.sessionId() + "/internal-csi/");
            JsonNode attached = post(client, route.resolve("attach"), token, boot,
                    Map.of("tenantId", scope.getTenantId(), "workspaceId", scope.getWorkspaceId(),
                            "writerToken", credentials.issue(scope.getTenantId(), scope.getWorkspaceId(),
                                    request.sessionId())), json);
            if (!attached.path("attached").asBoolean() || !request.sessionId().equals(
                    attached.path("sessionId").textValue()) || !boot.equals(attached.path("bootId").textValue())) {
                throw new IllegalStateException("Private CSI attachment response conflicts");
            }
            JsonNode result = post(client, route.resolve("text"), token, boot, text, json);
            if (!request.sessionId().equals(result.path("sessionId").textValue())
                    || !"turn_result".equals(result.path("subtype").textValue())
                    || !text.promptId().equals(result.path("systemPayload").path("promptId").textValue())) {
                throw new IllegalStateException("Private CSI text response conflicts");
            }
            System.out.println(json.writeValueAsString(result));
        }
    }

    static TextRequest readText(Path path, ObjectMapper json) {
        try (var input = Files.newInputStream(path)) {
            byte[] bytes = input.readNBytes(64 * 1024 + 1);
            if (bytes.length > 64 * 1024) {
                throw new IllegalArgumentException("Private CSI text request exceeds its limit");
            }
            TextRequest text = json.readValue(bytes, TextRequest.class);
            if (text == null) {
                throw new IllegalArgumentException("Private CSI text request is required");
            }
            return text;
        } catch (Exception failure) {
            throw new IllegalArgumentException("Private CSI text request could not be read");
        }
    }

    static URI hostedUri(String value) {
        URI uri = URI.create(value);
        String host = uri.getHost();
        boolean loopback = host != null && (host.equals("localhost") || host.equals("127.0.0.1")
                || host.equals("[::1]") || host.equals("::1"));
        if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (!uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/")) || uri.getPort() == 0 || uri.getPort() > 65535
                || (!"https".equals(uri.getScheme()) && !("http".equals(uri.getScheme()) && loopback))) {
            throw new IllegalArgumentException("Private Hosted URL must be an HTTPS or loopback HTTP origin");
        }
        return uri;
    }

    static JsonNode post(HttpClient client, URI uri, String token, String boot, Object body,
            ObjectMapper json) throws Exception {
        var request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + token).header("Content-Type", "application/json")
                .header("X-Qwen-Harness-Protocol-Version", "1").header("X-Qwen-Harness-Boot-Id", boot)
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
        var pending = client.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray());
        HttpResponse<byte[]> response;
        try {
            response = pending.get(30, TimeUnit.SECONDS);
        } finally {
            pending.cancel(true);
        }
        if (response.statusCode() != 200 || !boot.equals(response.headers()
                .firstValue("X-Qwen-Harness-Boot-Id").orElse(null))
                || !"no-store".equals(response.headers().firstValue("Cache-Control").orElse(null))
                || response.body().length > 1024 * 1024) {
            throw new IllegalStateException("Private Hosted response is unavailable");
        }
        var result = json.readTree(response.body());
        if (result == null || !result.isObject()) {
            throw new IllegalStateException("Private Hosted response is invalid");
        }
        return result;
    }

    private static String required(String name) {
        return WorkspaceCsiRuntimeMain.required(name);
    }
}
