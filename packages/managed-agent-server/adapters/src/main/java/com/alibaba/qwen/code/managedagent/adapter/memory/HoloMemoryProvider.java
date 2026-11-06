package com.alibaba.qwen.code.managedagent.adapter.memory;

import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Item;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

public final class HoloMemoryProvider implements MemoryProvider {
    private static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private final URI endpoint;
    private final String apiKey;
    private final ObjectMapper json;
    private final HttpClient client;

    public HoloMemoryProvider(String endpoint, String apiKey, ObjectMapper json) {
        this.endpoint = URI.create(endpoint.endsWith("/") ? endpoint : endpoint + "/");
        if (this.endpoint.getHost() == null || this.endpoint.getUserInfo() != null
                || this.endpoint.getQuery() != null || this.endpoint.getFragment() != null
                || !("https".equals(this.endpoint.getScheme()) || "http".equals(this.endpoint.getScheme())
                    && List.of("127.0.0.1", "localhost", "[::1]").contains(this.endpoint.getHost()))
                || apiKey == null || apiKey.isBlank() || apiKey.contains("\r") || apiKey.contains("\n")) {
            throw new IllegalArgumentException("Memory requires an HTTPS endpoint and a service credential.");
        }
        this.apiKey = apiKey;
        this.json = json;
        this.client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(5)).build();
    }

    @Override
    public Result execute(String namespace, Query query) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        boolean submitted = false;
        try {
            switch (query.operation()) {
                case "recall", "search": {
                    var response = request("POST", "v2/memories/search/", Map.of("query", query.query(),
                            "filters", Map.of("user_id", namespace), "limit", 5), deadline);
                    requireSuccess(response);
                    JsonNode records = response.body().path("results");
                    if (!records.isArray()) {
                        return Result.status("unavailable");
                    }
                    List<Item> result = new ArrayList<>();
                    int remaining = 4000;
                    for (JsonNode item : records) {
                        String id = item.path("id").textValue();
                        String content = item.path("memory").textValue();
                        if (!MemoryModels.identifier(id) || !MemoryModels.text(content, 4000)
                                || item.has("user_id") && !namespace.equals(item.path("user_id").textValue())) {
                            continue;
                        }
                        content = truncate(content, Math.min(1000, remaining));
                        result.add(new Item(id, content));
                        remaining -= content.length();
                        if (result.size() == 5 || remaining == 0) {
                            break;
                        }
                    }
                    return Result.items(result);
                }
                case "get": {
                    Target target = get(namespace, query.memoryId(), deadline);
                    return target.content() == null ? Result.status("unavailable")
                            : Result.entry("found", query.memoryId(), target.content());
                }
                case "remember": {
                    submitted = true;
                    var response = request("POST", "v1/memories/", Map.of("user_id", namespace,
                            "infer", false, "messages", List.of(Map.of("role", "user", "content", query.content()))), deadline);
                    requireSuccess(response);
                    JsonNode records = response.body().path("results");
                    if (!records.isArray() || records.size() != 1 || !completedAdd(response.body())
                            || !completedAdd(records.get(0))) {
                        return Result.status("unknown");
                    }
                    String id = records.get(0).path("id").textValue();
                    if (!MemoryModels.identifier(id)) {
                        return Result.status("unknown");
                    }
                    Target target = get(namespace, id, deadline);
                    return query.content().equals(target.content())
                            ? Result.entry("stored", id, null) : Result.status("unknown");
                }
                case "forget": {
                    Target target = get(namespace, query.memoryId(), deadline);
                    if (!query.expectedContent().equals(target.content())) {
                        return Result.status("not_deleted");
                    }
                    submitted = true;
                    requireSuccess(request("DELETE", path(query.memoryId()), null, deadline));
                    return get(namespace, query.memoryId(), deadline).absent()
                            ? Result.entry("deleted", query.memoryId(), null) : Result.status("unknown");
                }
                default: return Result.status("unavailable");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Result.status(submitted ? "unknown" : "forget".equals(query.operation()) ? "not_deleted" : "unavailable");
        } catch (Exception failure) {
            return Result.status(submitted ? "unknown" : "forget".equals(query.operation()) ? "not_deleted" : "unavailable");
        }
    }

    private Target get(String namespace, String id, long deadline) throws Exception {
        var response = request("GET", path(id), null, deadline);
        if (response.status() == 404) {
            return new Target(null, true);
        }
        requireSuccess(response);
        var value = response.body();
        if (!id.equals(value.path("id").textValue()) || !namespace.equals(value.path("user_id").textValue())
                || !MemoryModels.text(value.path("memory").textValue(), 4000)) {
            return new Target(null, false);
        }
        return new Target(value.path("memory").textValue(), false);
    }

    private Response request(String method, String path, Object body, long deadline) throws Exception {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) {
            throw new java.util.concurrent.TimeoutException();
        }
        var request = HttpRequest.newBuilder(endpoint.resolve(path)).timeout(Duration.ofNanos(remaining))
                .header("Accept", "application/json").header("Authorization", "Token " + apiKey)
                .header("Content-Type", "application/json").method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body))).build();
        var future = client.sendAsync(request, ignored -> new BoundedBody());
        try {
            var response = future.get(remaining, TimeUnit.NANOSECONDS);
            JsonNode value = response.statusCode() == 404 ? json.nullNode() : json.readTree(response.body());
            return new Response(response.statusCode(), value == null ? json.nullNode() : value);
        } finally {
            future.cancel(true);
        }
    }

    private static String path(String id) {
        if (!MemoryModels.identifier(id)) {
            throw new IllegalArgumentException("Invalid memory entry identity.");
        }
        return "v1/memories/" + URLEncoder.encode(id, StandardCharsets.UTF_8).replace("+", "%20") + "/";
    }
    private static boolean completedAdd(JsonNode value) {
        return value.isObject() && !value.hasNonNull("error") && !value.hasNonNull("errors")
                && (!value.has("status") || "SUCCEEDED".equals(value.path("status").textValue()))
                && (!value.has("event") || "ADD".equals(value.path("event").textValue()));
    }
    private static void requireSuccess(Response response) {
        if (response.status() < 200 || response.status() >= 300
                || response.body().hasNonNull("error") || response.body().hasNonNull("errors")) {
            throw new IllegalStateException("Memory provider request failed.");
        }
    }
    private static String truncate(String text, int limit) {
        int end = Math.min(text.length(), limit);
        if (end > 0 && Character.isHighSurrogate(text.charAt(end - 1))) {
            end--;
        }
        return text.substring(0, end);
    }
    private record Response(int status, JsonNode body) { }
    private record Target(String content, boolean absent) { }

    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private Flow.Subscription subscription;

        @Override public CompletionStage<byte[]> getBody() { return body; }
        @Override public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            value.request(1);
        }
        @Override public void onNext(List<ByteBuffer> buffers) {
            for (var buffer : buffers) {
                if (buffer.remaining() > MAX_RESPONSE_BYTES - bytes.size()) {
                    subscription.cancel();
                    body.completeExceptionally(new IllegalStateException("Memory response exceeds its limit."));
                    return;
                }
                byte[] value = new byte[buffer.remaining()];
                buffer.get(value);
                bytes.writeBytes(value);
            }
            subscription.request(1);
        }
        @Override public void onError(Throwable error) { body.completeExceptionally(error); }
        @Override public void onComplete() { body.complete(bytes.toByteArray()); }
    }
}
