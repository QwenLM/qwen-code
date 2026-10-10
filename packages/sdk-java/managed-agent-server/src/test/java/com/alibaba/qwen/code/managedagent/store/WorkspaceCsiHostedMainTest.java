package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspaceCsiHostedMainTest {
    @Test
    void cancelsAnIncompleteResponseBeforeClosingItsClient() throws Exception {
        var release = new CountDownLatch(1);
        var receiver = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var executor = Executors.newSingleThreadExecutor();
        receiver.setExecutor(executor);
        receiver.createContext("/text", exchange -> {
            try {
                exchange.getRequestBody().readAllBytes();
                exchange.getResponseHeaders().add("Cache-Control", "no-store");
                exchange.getResponseHeaders().add("X-Qwen-Harness-Boot-Id", "boot");
                exchange.sendResponseHeaders(200, 0);
                exchange.getResponseBody().write("{\"partial\":".getBytes(StandardCharsets.UTF_8));
                exchange.getResponseBody().flush();
                release.await(45, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        receiver.start();
        try {
            URI uri = URI.create("http://127.0.0.1:" + receiver.getAddress().getPort() + "/text");
            assertTimeoutPreemptively(Duration.ofSeconds(40), () -> {
                try (var client = HttpClient.newHttpClient()) {
                    assertThatThrownBy(() -> WorkspaceCsiHostedMain.post(client, uri, "operator", "boot",
                            Map.of("text", "hello"), JsonMapper.builder().build()))
                            .isInstanceOf(TimeoutException.class);
                }
            });
        } finally {
            release.countDown();
            receiver.stop(0);
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void readsOnlyTheClosedBoundedTextRequest(@TempDir Path directory) throws Exception {
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        String id = "550e8400-e29b-41d4-a716-446655440000";
        Path path = directory.resolve("text.json");
        String valid = json.writeValueAsString(new WorkspaceCsiHostedMain.TextRequest(id, "hello"));
        Files.writeString(path, valid);
        assertThat(WorkspaceCsiHostedMain.readText(path, json)).isEqualTo(
                new WorkspaceCsiHostedMain.TextRequest(id, "hello"));
        for (String rejected : List.of("null", valid + " {}", valid.replaceFirst("\\{", "{\"cwd\":\"/foreign\","),
                valid.replaceFirst("\\{", "{\"promptId\":\"foreign\","), " ".repeat(65537))) {
            Files.writeString(path, rejected);
            assertThatThrownBy(() -> WorkspaceCsiHostedMain.readText(path, json))
                    .isInstanceOf(IllegalArgumentException.class).hasMessage("Private CSI text request could not be read");
        }
        assertThatThrownBy(() -> new WorkspaceCsiHostedMain.TextRequest(id, " ")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new WorkspaceCsiHostedMain.TextRequest(id, "字".repeat(5500)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void acceptsOnlyTrustedHostedOrigins() {
        for (String accepted : List.of("http://127.0.0.1:43190", "http://localhost:43190/", "https://host.example")) {
            assertThat(WorkspaceCsiHostedMain.hostedUri(accepted).getHost()).isNotNull();
        }
        for (String rejected : List.of("http://host.example", "https://u:p@host.example", "https://host.example/session",
                "https://host.example?q=1", "https://host.example#f", "file:///host", "http://127.0.0.1:0")) {
            assertThatThrownBy(() -> WorkspaceCsiHostedMain.hostedUri(rejected)).isInstanceOf(IllegalArgumentException.class);
        }
    }
}
