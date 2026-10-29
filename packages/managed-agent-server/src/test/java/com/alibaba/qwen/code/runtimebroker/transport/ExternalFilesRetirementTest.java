package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalStorageRegistry.RegisteredExternalStorage;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ExternalFilesRetirementTest {
    private final ObjectMapper json = new ObjectMapper();
    private final RegisteredExternalStorage storage = new RegisteredExternalStorage("e2b", "volume-a", 3,
            "workspace-a", "/external/workspace-a", "/workspace");
    private final RuntimeProvisionSeed seed = new RuntimeProvisionSeed("request-a", "runtime-a", "incarnation-a", "lease-a", 2, "private-fixture-token");
    private HttpServer server;
    private RuntimeBindingRecord binding;
    private Map<String, Object> response;
    private boolean authenticated;

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/managed-runtime/v2/publication:files-stop-drained", exchange -> {
            authenticated = "Bearer private-fixture-token".equals(exchange.getRequestHeaders().getFirst("Authorization"))
                    && "incarnation-a".equals(exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Runtime-Incarnation"))
                    && "3".equals(exchange.getRequestHeaders().getFirst("X-Qwen-Managed-Storage-Revision"))
                    && json.readTree(exchange.getRequestBody()).path("channel").asText().equals("all");
            byte[] body = json.writeValueAsBytes(response);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.getResponseHeaders().set("X-Qwen-Managed-Runtime-Incarnation", "incarnation-a");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        var scope = new RuntimeScope("tenant-a", "workspace-a", "1", "/workspace", WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, "session-a", ExternalWorkspaceProvisioner.FILES_KIND, "workspace-a");
        var lease = new RuntimeLease("runtime-a", URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        binding = new RuntimeBindingRecord("binding-a", request, seed, 1, RuntimeBindingRecord.State.DRAINING, lease,
                new RuntimeResourceHandle(ExternalWorkspaceProvisioner.FILES_KIND, 1, Map.of("fixture", true)),
                2, true, null, null, 0, 1, null, Instant.now(), Instant.now());
    }

    @AfterEach
    void close() {
        server.stop(0);
    }

    private Map<String, Object> proof() {
        var proof = new LinkedHashMap<String, Object>();
        proof.put("proofVersion", 1);
        proof.put("type", "files-stop-drained");
        proof.put("profile", "external-files/1");
        proof.put("tenantId", "tenant-a");
        proof.put("workspaceId", "workspace-a");
        proof.put("workspaceGeneration", "1");
        proof.put("storageId", "workspace-a");
        proof.put("storage", Map.of("kind", "external", "physicalKey", "volume-a", "registrationRevision", 3,
                "aliasPath", "/external/workspace-a", "mountRoot", "/workspace"));
        proof.put("runtimeInstanceId", "runtime-a");
        proof.put("runtimeIncarnation", "incarnation-a");
        proof.put("provisionRequestId", "request-a");
        proof.put("capabilityDigest", WorkspaceExecutionProfile.CAPABILITY_DIGEST);
        proof.put("leaseId", "lease-a");
        proof.put("epoch", 2);
        proof.put("retirementId", UUID.randomUUID().toString());
        proof.put("retiredAt", "2026-01-01T00:00:00.000Z");
        proof.put("filesOnly", true);
        proof.put("unreleasedSessions", 0);
        proof.put("pendingInvocations", 0);
        proof.put("channels", List.of());
        return proof;
    }

    private Map<String, Object> envelope(Map<String, Object> proof) throws Exception {
        byte[] bytes = json.writeValueAsBytes(proof);
        return Map.of("protocolVersion", 2, "state", "drained", "proof", Map.of("resourceId", UUID.randomUUID().toString(),
                "kind", "external-files-retirement", "schemaVersion", 1, "byteLength", bytes.length, "digest", DigestUtils.sha256Hex(bytes)),
                "proofBytes", Base64.getEncoder().encodeToString(bytes));
    }

    @Test
    void consumesExactBytesAndAuthenticatesTheOriginalWorkerAndStorageRevision() throws Exception {
        response = envelope(proof());
        assertThat(HttpRuntimeTransport.verifyExternalStopProof(binding, storage,
                new HttpRuntimeTransport().stopExternalFiles(binding, storage).toCompletableFuture().get(3, TimeUnit.SECONDS)))
                .isEqualTo(Instant.parse("2026-01-01T00:00:00Z"));
        assertThat(authenticated).isTrue();
    }

    @Test
    void rejectsHashValidProofsForAnotherIdentityOrUnsettledWork() throws Exception {
        for (var entry : Map.<String, Object>of("tenantId", "foreign", "runtimeIncarnation", "other", "epoch", 3,
                "storageId", "other", "pendingInvocations", 1, "filesOnly", false, "channels", List.of("stdout")).entrySet()) {
            var proof = proof();
            proof.put(entry.getKey(), entry.getValue());
            response = envelope(proof);
            refused();
        }
        response = Map.of("protocolVersion", 2, "state", "drained");
        refused();
        var original = envelope(proof());
        var changed = new LinkedHashMap<>(original);
        changed.put("proofBytes", Base64.getEncoder().encodeToString("tampered".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        response = changed;
        refused();
    }

    private void refused() {
        var failure = assertThrows(ExecutionException.class, () -> new HttpRuntimeTransport().stopExternalFiles(binding, storage)
                .toCompletableFuture().get(3, TimeUnit.SECONDS));
        assertThat(failure.getCause()).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("external_files_stop_unconfirmed"));
    }
}
