package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class HttpRuntimeTransportTest {
    @Test
    void forwardsTheManagedRuntimeProtocolWithLeaseFencing()
            throws Exception {
        List<CapturedRequest> requests = new ArrayList<>();
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/internal/managed-runtime/", exchange ->
                respond(exchange, requests));
        server.start();
        try {
            URI endpoint = URI.create("http://127.0.0.1:"
                    + server.getAddress().getPort());
            RuntimeLease lease = new RuntimeLease("runtime-1", endpoint,
                    "runtime-token", "lease-1", 7);
            RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                    "generation-1", "/workspace", "capability-digest",
                    "workspace");
            RuntimeSession session = new RuntimeSession("harness",
                    "runtime-session", "bootstrap", scope);
            HttpRuntimeTransport transport = new HttpRuntimeTransport();

            assertNull(transport.acquire(lease, session).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS));
            assertEquals("manifest", object(transport.control(lease, session,
                    operation("manifest")).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS)).get("kind"));
            assertEquals("success", transport.execute(lease, session,
                    reference()).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS).get("executionStatus"));
            assertEquals("executing", transport.status(lease, session,
                    reference(), 3).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS).get("state"));
            assertEquals("settled", transport.cancel(lease, session,
                    reference()).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS).get("state"));
            assertTrue(transport.release(lease, session).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS));
            RuntimeProvisionSeed seed = new RuntimeProvisionSeed(
                    "provision-1", "runtime-1", "incarnation-1", "lease-1",
                    7, "runtime-token");
            RuntimeAttestation attestation = transport.attest(lease,
                    new RuntimeProvisionRequest(scope, null,
                            "test-scheduler", "test-cluster",
                            "sha256:template"), seed).toCompletableFuture()
                    .get(2, TimeUnit.SECONDS);

            assertEquals(7, requests.size());
            assertEquals("/internal/managed-runtime/v1/prepare",
                    requests.get(0).path);
            assertEquals("/internal/managed-runtime/v2/manifest",
                    requests.get(1).path);
            assertEquals("/internal/managed-runtime/v2/status",
                    requests.get(3).path);
            assertEquals(3, requests.get(3).body.get("afterSeq"));
            assertEquals("Bearer runtime-token",
                    requests.get(0).authorization);
            assertEquals("lease-1", requests.get(0).leaseId);
            assertEquals("7", requests.get(0).leaseEpoch);
            assertEquals("tenant", requests.get(0).body.get("tenantId"));
            assertEquals("workspace",
                    requests.get(0).body.get("workspaceId"));
            assertEquals("/workspace",
                    requests.get(0).body.get("workspaceCwd"));
            assertEquals("runtime-session",
                    requests.get(0).body.get("sessionId"));
            assertEquals(1, requests.get(0).body.get("protocolVersion"));
            assertEquals(2, requests.get(1).body.get("protocolVersion"));
            assertEquals("runtime-1", attestation.getRuntimeInstanceId());
            assertEquals("incarnation-1",
                    attestation.getRuntimeIncarnation());
            assertEquals(scope, attestation.getScope());
            assertEquals("/internal/managed-runtime/v2/attest",
                    requests.get(6).path);
            assertEquals("generation-1",
                    requests.get(6).body.get("workspaceGeneration"));
            assertEquals("provision-1",
                    requests.get(6).body.get("provisionRequestId"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void treatsAttestationIdentityResponsesAsNonRetryableConflicts()
            throws Exception {
        for (AttestationResponse response : List.of(
                new AttestationResponse(409,
                        JsonCodec.encode(Map.of("code",
                                "managed_runtime_identity_conflict"))),
                new AttestationResponse(200,
                        JsonCodec.encode(Map.of("protocolVersion", 2))),
                new AttestationResponse(200,
                        JsonCodec.encode(Map.of("protocolVersion", 2.5))))) {
            HttpServer server = HttpServer.create(
                    new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/internal/managed-runtime/v2/attest",
                    exchange -> respond(exchange, response));
            server.start();
            try {
                RuntimeLease lease = new RuntimeLease("runtime-1",
                        URI.create("http://127.0.0.1:"
                                + server.getAddress().getPort()),
                        "runtime-token", "lease-1", 7);
                RuntimeScope scope = new RuntimeScope("tenant", "workspace",
                        "generation-1", "/workspace",
                        "capability-digest", "workspace");
                RuntimeProvisionSeed seed = new RuntimeProvisionSeed(
                        "provision-1", "runtime-1", "incarnation-1",
                        "lease-1", 7, "runtime-token");

                ExecutionException failure = assertThrows(
                        ExecutionException.class,
                        () -> new HttpRuntimeTransport().attest(lease,
                                new RuntimeProvisionRequest(scope, null,
                                        "test-scheduler", "test-cluster",
                                        "sha256:template"), seed)
                                .toCompletableFuture().get(2,
                                        TimeUnit.SECONDS));
                RuntimeBrokerException conflict = assertInstanceOf(
                        RuntimeBrokerException.class, failure.getCause());
                assertEquals("runtime_broker_attestation_conflict",
                        conflict.getCode());
                assertFalse(conflict.isRetryable());
            } finally {
                server.stop(0);
            }
        }
    }

    private static void respond(HttpExchange exchange,
            AttestationResponse response) throws IOException {
        exchange.getRequestBody().readAllBytes();
        exchange.sendResponseHeaders(response.status, response.body.length);
        exchange.getResponseBody().write(response.body);
        exchange.close();
    }

    private static void respond(HttpExchange exchange,
            List<CapturedRequest> requests) throws IOException {
        Map<String, Object> body = JsonCodec.parseObject(
                exchange.getRequestBody().readAllBytes(), "request");
        String path = exchange.getRequestURI().getPath();
        requests.add(new CapturedRequest(path,
                exchange.getRequestHeaders().getFirst("Authorization"),
                exchange.getRequestHeaders().getFirst(
                        "X-Qwen-Managed-Lease-Id"),
                exchange.getRequestHeaders().getFirst(
                        "X-Qwen-Managed-Lease-Epoch"), body));
        Map<String, Object> response = new LinkedHashMap<>();
        if (path.endsWith("/attest")) {
            response.put("protocolVersion", 2);
            response.put("runtimeInstanceId", "runtime-1");
            response.put("runtimeIncarnation", "incarnation-1");
            response.put("leaseId", "lease-1");
            response.put("epoch", 7);
            response.put("tenantId", body.get("tenantId"));
            response.put("workspaceId", body.get("workspaceId"));
            response.put("workspaceGeneration",
                    body.get("workspaceGeneration"));
            response.put("workspaceCwd", body.get("workspaceCwd"));
            response.put("capabilityDigest",
                    body.get("capabilityDigest"));
            response.put("isolationClass", body.get("isolationClass"));
            response.put("provisionRequestId",
                    body.get("provisionRequestId"));
        } else if (path.endsWith("/prepare")) {
            response.put("protocolVersion", 1);
            response.put("ready", true);
        } else if (path.endsWith("/release")) {
            response.put("protocolVersion", 2);
            response.put("released", true);
        } else {
            response.put("protocolVersion", 2);
            if (path.endsWith("/execute")) {
                response.put("result", executionResult("success"));
            } else if (path.endsWith("/status")) {
                response.put("result", executingStatus());
            } else if (path.endsWith("/cancel")) {
                response.put("result", cancelledStatus());
            } else {
                response.put("result", operation("manifest"));
            }
        }
        byte[] bytes = JsonCodec.encode(response);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static Map<String, Object> operation(String kind) {
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("kind", kind);
        return operation;
    }

    private static Map<String, Object> reference() {
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("sessionId", "runtime-session");
        reference.put("promptId", "turn-1");
        reference.put("callId", "tool-1");
        reference.put("capabilityDigest", "capability-digest");
        reference.put("policyRevision", "policy-1");
        reference.put("invocationId", "invocation-1");
        reference.put("argsDigest", "args-1");
        return reference;
    }

    private static Map<String, Object> executionResult(String state) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("executionStatus", state);
        return result;
    }

    private static Map<String, Object> cancelledStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", "settled");
        status.put("cancelRequested", true);
        status.put("lastSeq", 0);
        status.put("firstAvailableSeq", 1);
        status.put("progressGap", false);
        status.put("progress", List.of());
        status.put("result", executionResult("cancelled"));
        return status;
    }

    private static Map<String, Object> executingStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", "executing");
        status.put("cancelRequested", false);
        status.put("lastSeq", 3);
        status.put("firstAvailableSeq", 1);
        status.put("progressGap", false);
        status.put("progress", List.of());
        return status;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        return (Map<String, Object>) value;
    }

    private static final class CapturedRequest {
        private final String path;
        private final String authorization;
        private final String leaseId;
        private final String leaseEpoch;
        private final Map<String, Object> body;

        CapturedRequest(String path, String authorization, String leaseId,
                String leaseEpoch, Map<String, Object> body) {
            this.path = path;
            this.authorization = authorization;
            this.leaseId = leaseId;
            this.leaseEpoch = leaseEpoch;
            this.body = body;
        }
    }

    private static final class AttestationResponse {
        private final int status;
        private final byte[] body;

        AttestationResponse(int status, byte[] body) {
            this.status = status;
            this.body = body;
        }
    }
}
