/**
 * Copyright 2026 Alibaba Group
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The FG9 lose-once/hold reverse proxy. One instance fronts one HTTP
 * boundary (the Session Store, or the public API for one client's own
 * request) and passes every request through unless an armed rule
 * matches its method+path+body; a
 * matched rule then drops the reply after the upstream already committed
 * (the lose-once shape fault rounds live on), or holds it until the IT
 * releases the named latch (the controlled-ambiguity shape), or swallows
 * the request without ever forwarding it (a writer that dies before its
 * commit leaves the wire). The armed occurrence N means a DROP rule fires
 * on the first N matching requests while a HOLD or SWALLOW rule fires
 * only on the Nth matching one; everything else
 * passes through and is logged. Every observation lands in the per-case
 * proxy log; those lines are the fault-fired witness the gate asserts on.
 */
final class HostedSessionRelayForwardingProxy implements AutoCloseable {
    private static final Duration FORWARD_TIMEOUT = Duration.ofSeconds(60);

    /** A request matcher over method, path and body text. */
    @FunctionalInterface
    interface Matcher {
        boolean test(String method, String path, String body);
    }

    enum Disposition {
        /** Forward, consume the upstream response, destroy the reply. */
        DROP,
        /** Forward, consume, then answer only once released by name. */
        HOLD,
        /** Never forward; once released by name, answer 503. */
        SWALLOW,
    }

    /** One arming rule with its firing counter. */
    static final class Rule {
        private final Matcher matcher;
        private final Disposition disposition;
        private final String name;
        private final int occurrences;
        private final AtomicInteger seen = new AtomicInteger();

        private Rule(Matcher matcher, Disposition disposition, String name,
                int occurrences) {
            this.matcher = matcher;
            this.disposition = disposition;
            this.name = name;
            this.occurrences = occurrences;
        }

        static Rule drop(Matcher matcher, String name) {
            return new Rule(matcher, Disposition.DROP, name, 1);
        }

        static Rule hold(Matcher matcher, String name, int occurrence) {
            return new Rule(matcher, Disposition.HOLD, name, occurrence);
        }

        static Rule swallow(Matcher matcher, String name) {
            return new Rule(matcher, Disposition.SWALLOW, name, 1);
        }

        /** Whether this request takes the armed disposition. */
        boolean fires(String method, String path, String body) {
            if (!matcher.test(method, path, body)) {
                return false;
            }
            int index = seen.incrementAndGet();
            if (disposition != Disposition.DROP) {
                return index == occurrences;
            }
            return index <= occurrences;
        }
    }

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient client =
            HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
                    .connectTimeout(Duration.ofSeconds(10)).build();
    private final HttpServer server;
    private final Path logFile;
    private volatile URI upstream;
    private final List<Rule> rules = new CopyOnWriteArrayList<>();
    private final Map<String, CompletableFuture<Void>> latches =
            new ConcurrentHashMap<>();
    private final List<String> operations = new CopyOnWriteArrayList<>();

    private HostedSessionRelayForwardingProxy(Path logFile,
            HttpServer server) {
        this.logFile = logFile;
        this.server = server;
    }

    /** Binds an ephemeral port now; {@link #forwardTo} names the upstream
     * once it is listening, so the upstream's own port need not be picked
     * ahead of its boot. */
    static HostedSessionRelayForwardingProxy start(String label,
            Path logFile) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(
                "127.0.0.1", 0), 0);
        HostedSessionRelayForwardingProxy proxy =
                new HostedSessionRelayForwardingProxy(logFile, server);
        server.createContext("/", proxy::handle);
        server.start();
        proxy.record("PROXY up " + label);
        return proxy;
    }

    void forwardTo(URI target) {
        upstream = target;
        record("PROXY upstream=" + target);
    }

    String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    void arm(Rule rule) {
        rules.add(rule);
        record("PROXY armed " + rule.disposition + " " + rule.name);
    }

    /** Release every reply currently held under `name`. */
    void release(String name) {
        CompletableFuture<Void> latch = latches.remove(name);
        record("PROXY release " + name
                + (latch == null ? " (nothing held)" : ""));
        if (latch != null) {
            latch.complete(null);
        }
    }

    List<String> operations() {
        return operations;
    }

    @Override
    public void close() {
        for (CompletableFuture<Void> latch : latches.values()) {
            latch.complete(null);
        }
        server.stop(0);
        record("PROXY down");
    }

    private void handle(HttpExchange exchange) throws IOException {
        String method = exchange.getRequestMethod();
        String path = exchange.getRequestURI().getPath();
        byte[] body = exchange.getRequestBody().readAllBytes();
        if ("GET".equals(method) && isStreamPath(path)) {
            streamThrough(exchange, method, path, body);
            return;
        }
        String text = new String(body, StandardCharsets.UTF_8);
        String kind = tagOf(text);
        Rule armed = null;
        for (Rule rule : rules) {
            if (rule.fires(method, path, text)) {
                armed = rule;
                break;
            }
        }
        CompletableFuture<Void> holdLatch = null;
        if (armed != null && armed.disposition != Disposition.DROP) {
            holdLatch = new CompletableFuture<>();
            latches.put(armed.name, holdLatch);
        }
        String tag = method + " " + path + kind;
        if (armed != null && armed.disposition == Disposition.SWALLOW) {
            swallow(exchange, armed.name, tag, holdLatch);
            return;
        }
        try {
            HttpRequest.Builder forward = HttpRequest.newBuilder(upstream
                            .resolve(exchange.getRequestURI().toString()))
                    .timeout(FORWARD_TIMEOUT);
            copyHeaders(exchange, forward);
            forward.method(method,
                    body.length == 0 ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofByteArray(body));
            HttpResponse<byte[]> response = client.send(forward.build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            String status = " status=" + response.statusCode();
            if (armed == null) {
                record("PROXY passthru " + tag + status);
            } else if (armed.disposition == Disposition.DROP) {
                record("PROXY dropped " + armed.name + " " + tag + status);
                return;
            } else {
                record("PROXY holding " + armed.name + " " + tag + status);
                try {
                    holdLatch.get(90, TimeUnit.SECONDS);
                } catch (Exception interrupted) {
                    Thread.currentThread().interrupt();
                }
                record("PROXY released " + armed.name + " " + tag);
            }
            byte[] reply = response.body();
            for (Map.Entry<String, java.util.List<String>> header
                    : response.headers().map().entrySet()) {
                if (hopByHop(header.getKey())) {
                    continue;
                }
                exchange.getResponseHeaders().put(header.getKey(),
                        header.getValue());
            }
            exchange.sendResponseHeaders(response.statusCode(),
                    reply.length == 0 ? -1 : reply.length);
            if (reply.length > 0) {
                exchange.getResponseBody().write(reply);
            }
        } catch (IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            record("PROXY upstream-error " + tag + " " + failure);
            byte[] message = failure.toString()
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/plain");
            exchange.sendResponseHeaders(502, message.length);
            exchange.getResponseBody().write(message);
        } finally {
            exchange.close();
        }
    }

    /** The SWALLOW disposition: the request never reaches the upstream.
     * Its sender is meant to die while it waits, so the 503 it gets on
     * release normally meets a closed connection. */
    private void swallow(HttpExchange exchange, String name, String tag,
            CompletableFuture<Void> latch) throws IOException {
        record("PROXY swallowing " + name + " " + tag);
        try {
            latch.get(90, TimeUnit.SECONDS);
        } catch (Exception interrupted) {
            Thread.currentThread().interrupt();
        }
        record("PROXY swallowed " + name + " " + tag);
        try {
            byte[] message = "swallowed".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(503, message.length);
            exchange.getResponseBody().write(message);
        } catch (IOException gone) {
            // the sender is gone, as intended
        } finally {
            exchange.close();
        }
    }

    /** The relay verb (`kind`), journal commit (`operation`) and its
     * command id a body names, so the log tells one commit from another
     * and a replay from a new step. */
    private String tagOf(String text) {
        try {
            JsonNode parsed = json.readTree(text);
            JsonNode kind = parsed.path("kind");
            JsonNode operation = parsed.path("operation");
            JsonNode command = parsed.path("commandId");
            return (kind.isTextual() ? " kind=" + kind.asText() : "")
                    + (operation.isTextual() ? " op=" + operation.asText()
                            : "")
                    + (operation.isTextual() && command.isTextual()
                            ? " cmd=" + command.asText() : "");
        } catch (IOException ignored) {
            return "";
        }
    }

    /** The harness event/auxiliary streams live for minutes and cannot
     * be buffered by the ordinary commit path; they relay byte for byte. */
    private static boolean isStreamPath(String path) {
        return path.endsWith("/events") || path.endsWith("/stream")
                || path.endsWith("/events/stream");
    }

    private void streamThrough(HttpExchange exchange, String method,
            String path, byte[] body) throws IOException {
        String tag = method + " " + path + " (stream)";
        try {
            HttpRequest.Builder forward = HttpRequest.newBuilder(upstream
                            .resolve(exchange.getRequestURI().toString()))
                    .timeout(Duration.ofSeconds(10));
            copyHeaders(exchange, forward);
            forward.method(method,
                    body.length == 0 ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofByteArray(body));
            HttpResponse<java.io.InputStream> response = client.send(
                    forward.build(),
                    HttpResponse.BodyHandlers.ofInputStream());
            for (Map.Entry<String, java.util.List<String>> header
                    : response.headers().map().entrySet()) {
                if (hopByHop(header.getKey())
                        || "content-type".equalsIgnoreCase(header.getKey())) {
                    continue;
                }
                exchange.getResponseHeaders().put(header.getKey(),
                        header.getValue());
            }
            exchange.getResponseHeaders().set("Content-Type",
                    response.headers().firstValue("content-type")
                            .orElse("application/octet-stream"));
            // 0, not -1: HttpServer reads -1 as header-only (immediate
            // EOF), which starves the harness event stream of every
            // turn-settlement event.
            exchange.sendResponseHeaders(response.statusCode(), 0);
            byte[] chunk = new byte[8192];
            try (java.io.InputStream upstream = response.body()) {
                for (int read = upstream.read(chunk); read >= 0;
                        read = upstream.read(chunk)) {
                    if (read == 0) {
                        continue;
                    }
                    exchange.getResponseBody().write(chunk, 0, read);
                    exchange.getResponseBody().flush();
                }
            }
            record("PROXY passthru " + tag);
        } catch (IOException | InterruptedException failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            record("PROXY upstream-error " + tag + " " + failure);
        } finally {
            exchange.close();
        }
    }

    private static void copyHeaders(HttpExchange exchange,
            HttpRequest.Builder forward) {
        for (Map.Entry<String, List<String>> header
                : exchange.getRequestHeaders().entrySet()) {
            if (hopByHop(header.getKey())) {
                continue;
            }
            for (String value : header.getValue()) {
                forward.header(header.getKey(), value);
            }
        }
    }

    private static boolean hopByHop(String headerName) {
        String name = headerName.toLowerCase();
        return name.equals("connection") || name.equals("host")
                || name.equals("content-length")
                || name.equals("transfer-encoding") || name.equals("expect")
                || name.equals("keep-alive") || name.equals("upgrade");
    }

    private synchronized void record(String line) {
        operations.add(line);
        try {
            if (logFile != null) {
                Files.createDirectories(logFile.getParent());
                Files.write(logFile, List.of(line), StandardCharsets.UTF_8,
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            }
        } catch (IOException ignored) {
            // The in-memory log is still the assertion source.
        }
    }
}
