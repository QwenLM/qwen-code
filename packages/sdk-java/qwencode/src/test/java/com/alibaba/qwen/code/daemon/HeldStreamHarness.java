package com.alibaba.qwen.code.daemon;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// A fake Hosted Harness whose event stream answers its headers and then
// holds the body open with no events until released: the shape of a held
// model stream, and from the client the shape of a half-open connection.
// Shared by the stream tests so the capability handshake they speak lives
// in one place.
final class HeldStreamHarness {
    static final String BOOT_ID = "11111111-1111-4111-8111-111111111111";
    static final String SESSION_ID = "33333333-3333-4333-8333-333333333333";
    static final String CLIENT_ID = "client-1";
    static final String DIGEST = "sha256:"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    static final String EVENT_EPOCH = "epoch-1";

    private final CountDownLatch holdStream = new CountDownLatch(1);
    private final HttpServer server;
    private final ExecutorService serverExecutor;

    private HeldStreamHarness(HttpServer server,
            ExecutorService serverExecutor) {
        this.server = server;
        this.serverExecutor = serverExecutor;
    }

    static HeldStreamHarness start() throws IOException {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService serverExecutor = Executors.newCachedThreadPool();
        server.setExecutor(serverExecutor);
        HeldStreamHarness harness = new HeldStreamHarness(server,
                serverExecutor);
        server.createContext("/capabilities", exchange -> {
            byte[] bytes = ("{\"v\":1,\"mode\":\"http-bridge\","
                    + "\"features\":[\"hosted_harness_private_v1\","
                    + "\"managed_session_journal_delta_v1\"],"
                    + "\"transports\":[\"rest\"],\"hostedHarness\":{"
                    + "\"features\":[\"event-keepalive/1\"],"
                    + "\"protocolVersions\":{\"current\":1,"
                    + "\"supported\":[1]},\"bootId\":\"" + BOOT_ID
                    + "\",\"capabilityDigest\":\"" + DIGEST + "\"}}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.createContext("/session", exchange -> {
            byte[] bytes = ("{\"sessionId\":\"" + SESSION_ID
                    + "\",\"workspaceCwd\":\"/control\","
                    + "\"attached\":true,\"clientId\":\"" + CLIENT_ID
                    + "\"}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.getResponseHeaders().set(
                    HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.createContext("/session/" + SESSION_ID + "/events",
                exchange -> {
                    exchange.getResponseHeaders().set("Content-Type",
                            "text/event-stream");
                    exchange.getResponseHeaders().set("Content-Encoding",
                            "identity");
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.EVENT_EPOCH_HEADER,
                            EVENT_EPOCH);
                    exchange.getResponseHeaders().set(
                            HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
                    exchange.sendResponseHeaders(200, 0);
                    exchange.getResponseBody().flush();
                    try {
                        harness.holdStream.await();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.close();
                });
        server.start();
        return harness;
    }

    URI baseUri() {
        return URI.create("http://127.0.0.1:"
                + server.getAddress().getPort());
    }

    HostedHarnessClient client() {
        return HostedHarnessClient.builder()
                .baseUri(baseUri())
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .build();
    }

    // Ends every held body; a reader blocked on one then sees its end.
    void releaseBodies() {
        holdStream.countDown();
    }

    // Releases the bodies before stopping the server, which waits for
    // open exchanges.
    void stop() {
        releaseBodies();
        server.stop(0);
        serverExecutor.shutdownNow();
    }
}
