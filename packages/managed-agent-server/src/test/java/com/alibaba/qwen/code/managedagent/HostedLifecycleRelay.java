package com.alibaba.qwen.code.managedagent;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

final class HostedLifecycleRelay implements AutoCloseable {
    record Request(String method, String path, Map<String, List<String>> headers, byte[] body) { }

    interface Fault {
        default boolean before(Request request) throws Exception { return true; }
        default boolean after(Request request, int status) throws Exception { return true; }
    }

    private static final Set<String> HOP = Set.of("host", "content-length", "connection", "keep-alive",
            "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade");
    private final HttpServer server;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final AtomicReference<URI> backend = new AtomicReference<>();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private volatile Fault fault = new Fault() { };

    HostedLifecycleRelay() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(executor);
        server.createContext("/", this::forward);
        server.start();
    }

    URI uri() { return URI.create("http://127.0.0.1:" + server.getAddress().getPort()); }
    void backend(URI uri) { backend.set(uri); }
    void fault(Fault value) { fault = value; }
    Throwable failure() { return failure.get(); }

    private void forward(HttpExchange exchange) throws IOException {
        try {
            var request = new Request(exchange.getRequestMethod(), exchange.getRequestURI().toString(),
                    Map.copyOf(exchange.getRequestHeaders()), exchange.getRequestBody().readAllBytes());
            Fault selected = fault;
            if (!selected.before(request)) {
                return;
            }
            var outgoing = HttpRequest.newBuilder(backend.get().resolve(request.path()))
                    .method(request.method(), HttpRequest.BodyPublishers.ofByteArray(request.body()));
            copyHeaders(request.headers(), outgoing::header);
            var response = client.send(outgoing.build(), HttpResponse.BodyHandlers.ofInputStream());
            try (var input = response.body()) {
                if (!selected.after(request, response.statusCode())) {
                    return;
                }
                copyHeaders(response.headers().map(), (name, value) -> exchange.getResponseHeaders().add(name, value));
                boolean noBody = request.method().equals("HEAD") || response.statusCode() == 204 || response.statusCode() == 304;
                exchange.sendResponseHeaders(response.statusCode(), noBody ? -1 : 0);
                byte[] bytes = new byte[8192];
                for (int count; (count = input.read(bytes)) != -1;) {
                    exchange.getResponseBody().write(bytes, 0, count);
                    exchange.getResponseBody().flush();
                }
            }
        } catch (IOException disconnected) {
            // Killed owners and deliberately discarded ACKs close their sockets.
        } catch (Exception | AssertionError error) {
            failure.compareAndSet(null, error);
            byte[] bytes = "fixture relay failed".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(500, bytes.length);
            exchange.getResponseBody().write(bytes);
        } finally {
            exchange.close();
        }
    }

    private static void copyHeaders(Map<String, List<String>> headers,
            java.util.function.BiConsumer<String, String> copy) {
        var excluded = new HashSet<>(HOP);
        headers.forEach((name, values) -> {
            if (name.equalsIgnoreCase("connection")) {
                for (String value : values) {
                    for (String field : value.split(",")) {
                        excluded.add(field.strip().toLowerCase(Locale.ROOT));
                    }
                }
            }
        });
        headers.forEach((name, values) -> {
            if (!excluded.contains(name.toLowerCase(Locale.ROOT))) {
                values.forEach(value -> copy.accept(name, value));
            }
        });
    }

    @Override
    public void close() {
        server.stop(0);
        executor.shutdownNow();
        client.shutdownNow();
    }
}
