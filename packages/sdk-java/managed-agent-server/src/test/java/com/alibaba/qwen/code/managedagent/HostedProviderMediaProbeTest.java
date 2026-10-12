package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
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
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

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

    private static class EmptyOwned {
        private final Map<String, Object> owned = Map.of();
    }
}
