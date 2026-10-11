package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

// A Hosted Harness that died behind a partition (or whose pod moved to
// another node) leaves the client side of its SSE stream half-open: the
// read never returns. next() holds the stream's lock across that read,
// so a close() that waited for the lock wedged for good — and with it
// every generation adoption, which closes the stale client and its
// streams. Each close here runs on its own thread with a bounded join,
// so a regression fails instead of hanging the suite; the teardown then
// ends the held body, which also releases a wedged closer.
class HarnessEventStreamCloseTest {
    private static final String BOOT_ID =
            "11111111-1111-4111-8111-111111111111";
    private static final String SESSION_ID =
            "33333333-3333-4333-8333-333333333333";
    private static final String CLIENT_ID = "client-1";
    private static final String DIGEST = "sha256:"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String EVENT_EPOCH = "epoch-1";

    private HttpServer server;
    private ExecutorService serverExecutor;
    private URI baseUri;
    private CountDownLatch holdStream;

    @BeforeEach
    void setUp() throws IOException {
        holdStream = new CountDownLatch(1);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverExecutor = Executors.newCachedThreadPool();
        server.setExecutor(serverExecutor);
        server.createContext("/capabilities", exchange -> {
            byte[] bytes = ("{\"v\":1,\"mode\":\"http-bridge\","
                    + "\"features\":[\"hosted_harness_private_v1\","
                    + "\"managed_session_journal_delta_v1\"],"
                    + "\"transports\":[\"rest\"],\"hostedHarness\":{"
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
        // Headers, then a body that never arrives: from the client, a
        // half-open stream looks exactly like this.
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
                        holdStream.await();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                    exchange.close();
                });
        server.start();
        baseUri = URI.create("http://127.0.0.1:"
                + server.getAddress().getPort());
    }

    @AfterEach
    void tearDown() {
        holdStream.countDown();
        if (server != null) {
            server.stop(0);
        }
        if (serverExecutor != null) {
            serverExecutor.shutdownNow();
        }
    }

    // The generation adoption's path: closing the stale client closes
    // the stream a Turn's reader is blocked on.
    @Test
    @Timeout(60)
    void closingTheClientEndsAReadBlockedOnAHalfOpenStream()
            throws Exception {
        assertCloseEndsTheBlockedRead(HostedHarnessClient::close, null);
    }

    @Test
    @Timeout(60)
    void closingTheStreamEndsAReadBlockedOnAHalfOpenStream()
            throws Exception {
        AtomicReference<HarnessEventStream> opened = new AtomicReference<>();
        assertCloseEndsTheBlockedRead(client -> opened.get().close(),
                opened);
    }

    private void assertCloseEndsTheBlockedRead(
            Consumer<HostedHarnessClient> close,
            AtomicReference<HarnessEventStream> opened) throws Exception {
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .build();
        HarnessSessionRef session = client.createSession(
                CreateHarnessSession.builder()
                        .harnessSessionId(SESSION_ID)
                        .build());
        HarnessEventStream stream = client.streamEvents(
                StreamHarnessEvents.builder()
                        .session(session)
                        .lastEventId(0)
                        .eventEpoch(EVENT_EPOCH)
                        .build());
        if (opened != null) {
            opened.set(stream);
        }
        AtomicReference<Object> outcome = new AtomicReference<>();
        Thread reader = new Thread(() -> {
            try {
                outcome.set(stream.next());
            } catch (RuntimeException error) {
                outcome.set(error);
            }
        }, "half-open-reader");
        reader.setDaemon(true);
        reader.start();
        awaitParked(reader);

        // The read position stays readable while a read is blocked.
        Thread position = startDaemon("half-open-position",
                () -> stream.getLastEventId());
        position.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(position.isAlive(),
                "getLastEventId() waited on the blocked reader");

        Thread closer = startDaemon("half-open-close",
                () -> close.accept(client));
        closer.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(closer.isAlive(),
                "close() waited on the reader blocked on a half-open"
                        + " stream");
        reader.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(reader.isAlive(),
                "the blocked read did not end when its stream closed");
        // A local close is not the server ending the stream.
        IllegalStateException closed = assertInstanceOf(
                IllegalStateException.class, outcome.get());
        assertEquals("HarnessEventStream is closed", closed.getMessage());
        client.close();
    }

    // The reader is inside next() once it parks on the empty body.
    private static void awaitParked(Thread reader) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (reader.getState() != Thread.State.WAITING
                && reader.getState() != Thread.State.TIMED_WAITING) {
            assertTrue(System.nanoTime() < deadline,
                    "the reader never blocked on the stream: "
                            + reader.getState());
            Thread.sleep(10);
        }
        // Give a reader that parked anywhere else a chance to move on.
        Thread.sleep(200);
        assertTrue(reader.getState() == Thread.State.WAITING
                || reader.getState() == Thread.State.TIMED_WAITING);
    }

    private static Thread startDaemon(String name, Runnable task) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        thread.start();
        return thread;
    }
}
