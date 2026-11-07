package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.adapter.memory.HoloMemoryProvider;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HoloMemoryProviderTest {
    private final ObjectMapper json = new ObjectMapper();
    private final Map<String, Map<String, Object>> entries = new LinkedHashMap<>();
    private final AtomicInteger deletes = new AtomicInteger();
    private HttpServer server;
    private HoloMemoryProvider provider;
    private JsonNode lastWrite;
    private JsonNode lastSearch;
    private boolean wrongScope;
    private boolean changedContent;
    private boolean loseWriteReply;
    private boolean oversizedSearch;
    private String writeEvent;

    @BeforeEach
    void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.start();
        provider = new HoloMemoryProvider("http://127.0.0.1:" + server.getAddress().getPort(), "synthetic-key", json);
    }

    @AfterEach
    void close() { server.stop(0); }

    private Query query(String operation, String content, String id) {
        return new Query("workspace", "writer", 1, operation, "prompt", "call",
                "search".equals(operation) ? "preference" : null,
                "remember".equals(operation) ? content : null, id, "forget".equals(operation) ? content : null);
    }

    @ParameterizedTest
    @ValueSource(strings = {"http://holo.internal", "ftp://127.0.0.1", "https:/missing-host",
            "https://u:p@holo.internal/", "https://holo.internal/?tenant=x", "https://holo.internal/#fragment", " "})
    void rejectsUnsafeEndpoints(String endpoint) {
        assertThatThrownBy(() -> new HoloMemoryProvider(endpoint, "synthetic-key", json))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "synthetic\rkey", "synthetic\nkey"})
    void rejectsInvalidServiceCredentials(String key) {
        assertThatThrownBy(() -> new HoloMemoryProvider("https://holo.internal", key, json))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"https://holo.internal", "http://localhost", "http://127.0.0.1", "http://[::1]"})
    void acceptsHttpsAndLoopbackHttp(String endpoint) {
        assertThat(new HoloMemoryProvider(endpoint, "synthetic-key", json)).isNotNull();
    }

    @Test
    void usesVerifiedHoloProtocolAndExactScopeForWriteReadSearchAndDelete() {
        var stored = provider.execute("scope-a", query("remember", "Use concise replies", null));
        assertThat(stored.status()).isEqualTo("stored");
        assertThat(lastWrite.path("infer").booleanValue()).isFalse();
        assertThat(lastWrite.path("user_id").textValue()).isEqualTo("scope-a");
        assertThat(lastWrite.path("messages").get(0).path("content").textValue()).isEqualTo("Use concise replies");
        assertThat(provider.execute("scope-a", query("get", null, stored.memoryId())).content()).isEqualTo("Use concise replies");
        assertThat(provider.execute("scope-b", query("get", null, stored.memoryId())).status()).isEqualTo("unavailable");
        assertThat(provider.execute("scope-a", query("search", null, null)).items()).hasSize(1);
        assertThat(lastSearch.path("filters").path("user_id").textValue()).isEqualTo("scope-a");
        assertThat(lastSearch.path("limit").intValue()).isEqualTo(5);
        assertThat(provider.execute("scope-b", query("search", null, null)).items()).isEmpty();
        assertThat(provider.execute("scope-a", query("forget", "Use concise replies", stored.memoryId())).status()).isEqualTo("deleted");
        assertThat(entries).isEmpty();
        assertThat(deletes).hasValue(1);
    }

    @Test
    void neverDeletesChangedContentOrForeignScope() {
        var stored = provider.execute("scope-a", query("remember", "Keep this", null));
        assertThat(provider.execute("scope-b", query("forget", "Keep this", stored.memoryId())).status()).isEqualTo("not_deleted");
        wrongScope = true;
        assertThat(provider.execute("scope-a", query("forget", "Keep this", stored.memoryId())).status()).isEqualTo("not_deleted");
        wrongScope = false;
        changedContent = true;
        assertThat(provider.execute("scope-a", query("forget", "Keep this", stored.memoryId())).status()).isEqualTo("not_deleted");
        assertThat(deletes).hasValue(0);
        assertThat(entries).hasSize(1);
    }

    @Test
    void lostWriteResponseIsUnknownAndOversizedReadsAreUnavailable() {
        loseWriteReply = true;
        assertThat(provider.execute("scope-a", query("remember", "Synthetic", null)).status()).isEqualTo("unknown");
        assertThat(entries).hasSize(1);
        oversizedSearch = true;
        assertThat(provider.execute("scope-a", query("search", null, null)).status()).isEqualTo("unavailable");
    }

    @Test
    void updateEventsAndUnsafeRecordIdentifiersCannotReportAStoredMemory() {
        writeEvent = "UPDATE";
        assertThat(provider.execute("scope-a", query("remember", "Synthetic", null)).status()).isEqualTo("unknown");
        assertThat(provider.execute("scope-a", query("get", null, "..")).status()).isEqualTo("unavailable");
        assertThat(deletes).hasValue(0);
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"Token synthetic-key".equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                respond(exchange, 401, Map.of("error", "unauthorized"));
                return;
            }
            String path = exchange.getRequestURI().getPath();
            if ("/v1/memories/".equals(path) && "POST".equals(exchange.getRequestMethod())) {
                lastWrite = json.readTree(exchange.getRequestBody());
                String id = UUID.randomUUID().toString();
                entries.put(id, Map.of("id", id, "user_id", lastWrite.path("user_id").textValue(),
                        "memory", lastWrite.path("messages").get(0).path("content").textValue()));
                if (loseWriteReply) {
                    return;
                }
                var response = new LinkedHashMap<>(entries.get(id));
                if (writeEvent != null) {
                    response.put("event", writeEvent);
                }
                respond(exchange, 200, Map.of("results", java.util.List.of(response)));
            } else if ("/v2/memories/search/".equals(path)) {
                lastSearch = json.readTree(exchange.getRequestBody());
                if (oversizedSearch) {
                    respond(exchange, 200, Map.of("extra", "x".repeat(70_000)));
                    return;
                }
                respond(exchange, 200, Map.of("results", entries.values().stream()
                        .filter(entry -> entry.get("user_id").equals(lastSearch.path("filters").path("user_id").textValue())).toList()));
            } else if (path.startsWith("/v1/memories/") && path.endsWith("/")) {
                String id = path.substring("/v1/memories/".length(), path.length() - 1);
                var value = entries.get(id);
                if (value == null) {
                    respond(exchange, 404, Map.of("error", "not_found"));
                }
                else if ("DELETE".equals(exchange.getRequestMethod())) {
                    deletes.incrementAndGet();
                    entries.remove(id);
                    respond(exchange, 200, Map.of("message", "deleted"));
                } else {
                    var copy = new LinkedHashMap<>(value);
                    if (wrongScope) {
                        copy.put("user_id", "foreign");
                    }
                    if (changedContent) {
                        copy.put("memory", "Changed after preview");
                    }
                    respond(exchange, 200, copy);
                }
            } else {
                respond(exchange, 404, Map.of("error", "not_found"));
            }
        }
    }

    private void respond(HttpExchange exchange, int status, Object value) throws IOException {
        byte[] bytes = json.writeValueAsString(value).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
}
