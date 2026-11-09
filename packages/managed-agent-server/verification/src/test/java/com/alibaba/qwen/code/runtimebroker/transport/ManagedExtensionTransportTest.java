package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.protocol.ManagedContextProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ManagedExtensionTransportTest {
    private static final String OPERATION = "550e8400-e29b-41d4-a716-446655440000";
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST, "session");
    private static final ObjectMapper JSON = new ObjectMapper();

    @ParameterizedTest
    @ValueSource(strings = {"source_changed", "skill_source_unavailable", "skill_source_busy",
        "skill_snapshot_unavailable", "skill_snapshot_capacity", "skill_snapshot_pending",
        "skill_snapshot_conflict", "skill_source_limit", "skill_candidate_limit"})
    void preservesTheWorkersBoundedSkillRefusals(String code) throws Exception {
        var failure = skillFailure(code, "valid");
        assertEquals(409, failure.getStatusCode());
        assertEquals(code, failure.getCode());
        assertFalse(failure.isRetryable());
    }

    @ParameterizedTest
    @ValueSource(strings = {"unknown", "extra", "wrong-path", "wrong-status", "cacheable", "non-json", "encoded", "overflow"})
    void doesNotTrustSkillCodesOutsideTheirProtocolBoundary(String mode) throws Exception {
        var failure = skillFailure("source_changed", mode);
        assertEquals("wrong-status".equals(mode) ? "managed_runtime_unavailable" : "managed_runtime_identity_conflict", failure.getCode());
    }

    private RuntimeBrokerException skillFailure(String code, String mode) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            assertEquals("Bearer token", exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.getRequestBody().readAllBytes();
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("code", "unknown".equals(mode) ? "unrecognized_skill_code" : code);
            if ("extra".equals(mode)) {
                fields.put("error", "private failure");
            }
            if ("overflow".equals(mode)) {
                fields.put("padding", "x".repeat(ManagedExtensionProtocol.RESPONSE_LIMIT));
            }
            byte[] body = JsonCodec.encode(fields);
            exchange.getResponseHeaders().set("Cache-Control", "cacheable".equals(mode) ? "max-age=60" : "no-store");
            exchange.getResponseHeaders().set("Content-Type", "non-json".equals(mode) ? "text/plain" : "application/json");
            if ("encoded".equals(mode)) {
                exchange.getResponseHeaders().set("Content-Encoding", "gzip");
            }
            exchange.sendResponseHeaders("wrong-status".equals(mode) ? 500 : 409, body.length);
            try (var output = exchange.getResponseBody()) {
                output.write(body);
            }
        });
        server.start();
        try {
            var lease = new RuntimeLease("worker", URI.create("http://127.0.0.1:" + server.getAddress().getPort()), "token", "lease", 1);
            var binding = new RuntimeBindingRecord("binding", new RuntimeProvisionRequest(SCOPE, "harness"), 1,
                    RuntimeBindingRecord.State.READY, lease, false, null, null, 0, 0, Instant.now(), Instant.now());
            var transport = new HttpRuntimeTransport();
            var context = new ContextBinding("tenant", "workspace", 1, "storage", "nested/project", "context-config", 3);
            var operation = "wrong-path".equals(mode) ? transport.extensionStop(lease, "retirement")
                    : transport.extensionControl(binding, "harness", context, Map.of("kind", "extension-skill-candidates", "operationId", OPERATION));
            var failure = assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> operation.toCompletableFuture().get(5, TimeUnit.SECONDS));
            return (RuntimeBrokerException) failure.getCause();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void extendedAttestationUsesTheActualLaunchConfigurationAndRejectsADifferentCache(@TempDir Path directory) throws Exception {
        var request = new RuntimeProvisionRequest(SCOPE, "harness", "local-process", "storage");
        var seed = RuntimeProvisionSeed.create("extension-attest", 1);
        var configuration = ManagedExtensionExecutionProfile.configuration(SCOPE.getCapabilityDigest(), directory.toString(), null);
        var boot = ManagedContextProtocol.boot(request, seed, configuration);
        AtomicReference<byte[]> captured = new AtomicReference<>();
        AtomicReference<Map<String, Object>> response = new AtomicReference<>(ManagedContextProtocol.attestationResponse(boot));
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/managed-runtime/v3/attest", exchange -> {
            assertEquals("Bearer " + seed.getToken(), exchange.getRequestHeaders().getFirst("Authorization"));
            captured.set(exchange.getRequestBody().readAllBytes());
            byte[] bytes = JsonCodec.encode(response.get());
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        try {
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            assertThrows(IllegalArgumentException.class, () -> new HttpRuntimeTransport().attest(lease, request, seed));
            var transport = new HttpRuntimeTransport().withManagedExtensionCacheDirectory(directory.toString(), null);
            assertEquals(SCOPE, transport.attest(lease, request, seed).toCompletableFuture().get(5, TimeUnit.SECONDS).getScope());
            assertEquals(JSON.readTree(JsonCodec.encode(ManagedContextProtocol.attestationRequest(boot))), JSON.readTree(captured.get()));
            var changed = new LinkedHashMap<>(ManagedContextProtocol.attestationResponse(boot));
            changed.put("managedExtensions", ManagedExtensionExecutionProfile.configuration(SCOPE.getCapabilityDigest(), directory.resolve("other").toString(), null));
            response.set(changed);
            assertThrows(java.util.concurrent.ExecutionException.class,
                    () -> transport.attest(lease, request, seed).toCompletableFuture().get(5, TimeUnit.SECONDS));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void streamsBinaryBytesAndInjectsPrivateSettingsOnEveryExactPreparation(@TempDir Path directory) throws Exception {
        AtomicReference<byte[]> requestBytes = new AtomicReference<>();
        AtomicReference<String> method = new AtomicReference<>();
        AtomicReference<String> path = new AtomicReference<>();
        AtomicReference<String> contentType = new AtomicReference<>();
        AtomicReference<byte[]> response = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            method.set(exchange.getRequestMethod());
            path.set(exchange.getRequestURI().getRawPath());
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            assertEquals("Bearer token", exchange.getRequestHeaders().getFirst("Authorization"));
            assertEquals("lease", exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Id"));
            assertEquals("1", exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Lease-Epoch"));
            requestBytes.set(exchange.getRequestBody().readAllBytes());
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.get().length);
            exchange.getResponseBody().write(response.get());
            exchange.close();
        });
        server.start();
        try {
            var lease = new RuntimeLease("worker", URI.create("http://127.0.0.1:" + server.getAddress().getPort()), "token", "lease", 1);
            var binding = new RuntimeBindingRecord("binding", new RuntimeProvisionRequest(SCOPE, "harness"), 1,
                    RuntimeBindingRecord.State.READY, lease, false, null, null, 0, 0, Instant.now(), Instant.now());
            var transport = new HttpRuntimeTransport();
            byte[] binary = new byte[128 * 1024];
            new java.util.Random(1).nextBytes(binary);
            String digest = DigestUtils.sha256Hex(binary);
            Path archive = directory.resolve("extension.tar.gz");
            Files.write(archive, binary);
            response.set(JsonCodec.encode(Map.of("protocolVersion", 1, "packageDigest", digest)));
            transport.installExtensionPackage(binding, digest, archive).toCompletableFuture().get(5, TimeUnit.SECONDS);
            assertEquals("PUT", method.get());
            assertEquals("/internal/managed-runtime/v3/extensions/packages/" + digest, path.get());
            assertEquals("application/gzip", contentType.get());
            assertArrayEquals(binary, requestBytes.get());

            AtomicInteger resolutions = new AtomicInteger();
            transport.configureExtensionPreparation((owner, harness, operation) -> {
                assertEquals(binding, owner);
                assertEquals("harness", harness);
                assertFalse(operation.containsKey("settings"));
                var privateOperation = new LinkedHashMap<>(operation);
                privateOperation.put("settings", Map.of("extension", Map.of("API_TOKEN", "private-setting")));
                privateOperation.put("packageManifests", Map.of());
                privateOperation.put("toolProfile", "SHELL");
                resolutions.incrementAndGet();
                return CompletableFuture.completedFuture(privateOperation);
            });
            var operation = new LinkedHashMap<String, Object>();
            operation.put("kind", "extension-prepare");
            operation.put("operationId", OPERATION);
            operation.put("command", Map.of("operationId", OPERATION, "actorKey", "a".repeat(64), "expectedRevision", 0, "extensions", List.of()));
            operation.put("expectedRevision", 0);
            operation.put("extensions", List.of());
            operation.put("baseMcpServers", List.of());
            operation.put("baseHookCatalog", null);
            response.set(JsonCodec.encode(Map.of("protocolVersion", 1,
                    "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"),
                    "result", Map.of("operationId", OPERATION, "state", "prepared", "revision", 1, "executionMode", "developer-process-group"))));
            var context = new ContextBinding("tenant", "workspace", 1, "storage", "nested/project", "context-config", 3);
            for (int attempt = 0; attempt < 2; attempt++) {
                transport.extensionControl(binding, "harness", context, operation).toCompletableFuture().get(5, TimeUnit.SECONDS);
            }
            assertEquals(2, resolutions.get());
            assertEquals("POST", method.get());
            JsonNode wire = JSON.readTree(requestBytes.get());
            assertFalse(wire.has("runtimeSessionId"));
            assertEquals("harness", wire.required("sessionKey").required("sessionId").textValue());
            assertEquals("nested/project", wire.required("contextBinding").required("cwdRelative").textValue());
            assertEquals("3", wire.required("contextBinding").required("contextRevision").textValue());
            assertEquals("private-setting", wire.required("operation").required("settings").required("extension").required("API_TOKEN").textValue());

            response.set(JsonCodec.encode(Map.of("protocolVersion", 1, "retirementId", "retirement", "state", "stopped")));
            transport.extensionStop(lease, "retirement").toCompletableFuture().get(5, TimeUnit.SECONDS);
            assertEquals("/internal/managed-runtime/v3/extensions/retire", path.get());
            assertEquals(Map.of("protocolVersion", 1, "retirementId", "retirement"), JSON.readValue(requestBytes.get(), Map.class));
        } finally {
            server.stop(0);
        }
    }
}
