package com.alibaba.qwen.code.daemon;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedExtensionsClientTest {
    @TempDir Path directory;

    @Test
    void streamsAndSignsArchiveBytesAndKeepsConfigurationRecoveryOnTheOriginalOperation() throws Exception {
        byte[] signingKey = "fixture-key-with-newline\n".getBytes(StandardCharsets.UTF_8);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        List<String> paths = new CopyOnWriteArrayList<>();
        List<Throwable> errors = new CopyOnWriteArrayList<>();
        List<byte[]> bodies = new CopyOnWriteArrayList<>();
        server.createContext("/prefix/", exchange -> {
            byte[] body = exchange.getRequestBody().readAllBytes();
            bodies.add(body);
            paths.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
            try {
                var headers = exchange.getRequestHeaders();
                String canonical = "qwen-broker-auth-v1\n" + exchange.getRequestMethod() + "\n"
                        + exchange.getRequestURI().getRawPath() + "\n"
                        + (exchange.getRequestURI().getRawQuery() == null ? "" : exchange.getRequestURI().getRawQuery())
                        + "\ntenant\nactor\n" + headers.getFirst("X-Qwen-Signature-Timestamp")
                        + "\n" + hex(MessageDigest.getInstance("SHA-256").digest(body)) + "\n"
                        + (headers.getFirst("Idempotency-Key") == null ? "" : headers.getFirst("Idempotency-Key"));
                Mac hmac = Mac.getInstance("HmacSHA256");
                hmac.init(new SecretKeySpec(signingKey, "HmacSHA256"));
                assertEquals("v1=" + hex(hmac.doFinal(canonical.getBytes(StandardCharsets.UTF_8))), headers.getFirst("X-Qwen-Signature"));
                assertEquals("tenant", headers.getFirst("X-Qwen-Tenant-Id"));
                assertEquals("actor", headers.getFirst("X-Qwen-Actor-Id"));
                if ("application/octet-stream".equals(headers.getFirst("Content-Type"))) {
                    assertTrue(exchange.getRequestURI().getRawQuery().contains("manifest="
                            + Base64.getUrlEncoder().withoutPadding().encodeToString("{\"schemaVersion\":1}".getBytes(StandardCharsets.UTF_8))));
                }
            } catch (Throwable error) {
                errors.add(error);
            }
            byte[] result = "{\"operationId\":\"original\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, result.length);
            exchange.getResponseBody().write(result);
            exchange.close();
        });
        server.start();
        try {
            var client = new ManagedExtensionsClient(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/prefix"),
                    "tenant", "actor", signingKey);
            Path archive = directory.resolve("package.tar.gz");
            byte[] binary = new byte[] {0, 1, 2, (byte) 255};
            Files.write(archive, binary);
            client.publish("workspace", null, archive, Map.of("schemaVersion", 1), "publish-original");
            assertTrue(java.util.Arrays.equals(binary, bodies.get(0)));
            client.saveSettings("workspace", "extension", 0, Map.of("TOKEN", "fixture"), "settings-original");
            client.apply("session", 2, new ArrayList<>(), "apply-original");
            client.configurationOperation("session", "original");
            client.continueOperation("session", "original");
            client.recoverPrevious("session", "original");
            assertEquals(List.of("POST /prefix/v1/agents/workspaces/workspace/extensions",
                    "POST /prefix/v1/agents/workspaces/workspace/extensions/extension/settings",
                    "POST /prefix/v1/agents/sessions/session/extensions",
                    "GET /prefix/v1/agents/sessions/session/extensions/operations/original",
                    "POST /prefix/v1/agents/sessions/session/extensions/operations/original/continue",
                    "POST /prefix/v1/agents/sessions/session/extensions/operations/original/recover-previous"), paths);
            assertTrue(errors.isEmpty(), errors.toString());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void refusesOversizedArchivesBeforeMakingAnyRequest() throws Exception {
        Path archive = directory.resolve("large");
        try (var file = new java.io.RandomAccessFile(archive.toFile(), "rw")) {
            file.setLength(100L * 1024 * 1024 + 1);
        }
        var client = new ManagedExtensionsClient(URI.create("http://127.0.0.1:1"), "tenant", "actor", new byte[] {1});
        assertThrows(IllegalArgumentException.class, () -> client.publish("workspace", null, archive, Map.of(), "key"));
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte item : bytes) {
            value.append(Character.forDigit((item >>> 4) & 15, 16)).append(Character.forDigit(item & 15, 16));
        }
        return value.toString();
    }
}
