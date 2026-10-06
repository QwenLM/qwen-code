package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

// Regression witness for the hosted-Harness wedge at
// https://github.com/QwenLM/qwen-code/issues/13333 : each Turn's SSE
// reader runs on a virtual thread (the managed-agent server's
// newVirtualThreadPerTaskExecutor). If HarnessEventStream.next() holds a
// monitor across the blocking socket read, every reader pins its carrier
// (JDK 21), and once open streams reach the carrier count no other
// virtual thread in the process ever runs again. The witness opens
// carriers+2 streams whose bodies never arrive, lets the readers reach
// the blocking read, and then proves an unrelated virtual-thread probe
// still gets scheduled. On JDK 24+ (JEP 491) monitors no longer pin, so
// the behavior-level assertion holds there regardless of the locking
// shape; the discriminative power lives on JDK 21.
class HarnessEventStreamPinningTest {
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
                    + "\"features\":[\"hosted_harness_private_v1\"],"
                    + "\"transports\":[\"rest\"],\"hostedHarness\":{"
                    + "\"protocolVersions\":{\"current\":1,"
                    + "\"supported\":[1]},\"bootId\":\"" + BOOT_ID
                    + "\",\"capabilityDigest\":\"" + DIGEST + "\"}}")
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8);
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
                    + "\"}").getBytes(
                            java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.getResponseHeaders().set(
                    HostedHarnessClient.BOOT_ID_HEADER, BOOT_ID);
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        // SSE endpoint that answers the headers then holds the body open
        // with no events — the shape of a held model stream.
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

    @Test
    @Timeout(120)
    void blockingStreamReadersMustNotStarveOtherVirtualThreads()
            throws Exception {
        assumeTrue(virtualThreadsAvailable(),
                "virtual threads unavailable on this JDK");
        int carriers = ForkJoinPool.getCommonPoolParallelism();
        int streamCount = carriers + 2;
        List<HarnessEventStream> streams = new ArrayList<>();
        List<Thread> readers = new ArrayList<>();
        AtomicInteger probeProgress = new AtomicInteger();
        boolean probeFinished = false;
        marker("streams-about-to-open carriers=" + carriers);
        // No try-with-resources: on a pinning runtime, blocked readers keep
        // their stream monitors, so client.close() would wedge this thread
        // on one of them before the assertion can fire.
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(baseUri)
                .bearerToken("harness-token")
                .capabilityDigest(DIGEST)
                .build();
        try {
            HarnessSessionRef session = client.createSession(
                    CreateHarnessSession.builder()
                            .harnessSessionId(SESSION_ID)
                            .build());
            for (int index = 0; index < streamCount; index++) {
                streams.add(client.streamEvents(
                        StreamHarnessEvents.builder()
                                .session(session)
                                .lastEventId(0)
                                .eventEpoch(EVENT_EPOCH)
                                .build()));
            }
            marker("streams-opened " + streams.size());
            for (HarnessEventStream stream : streams) {
                readers.add(startVirtualThread(() -> {
                    try {
                        stream.next();
                    } catch (RuntimeException expectedOnClose) {
                        // The test closes the streams from the main thread.
                    }
                }));
            }
            marker("readers-started");
            // Let every reader reach the blocking socket read inside
            // next(); on a pinning runtime that is when each carrier is
            // captured.
            sleepUnchecked(2000);
            Thread probe = startVirtualThread(() -> {
                for (int tick = 0; tick < 200; tick++) {
                    probeProgress.incrementAndGet();
                    sleepUnchecked(10);
                }
            });
            probeFinished = probeJoinUnchecked(probe, 30000);
            marker("probe-joined finished=" + probeFinished + " progress="
                    + probeProgress.get());
        } finally {
            holdStream.countDown();
            for (Thread reader : readers) {
                probeJoinUnchecked(reader, 3000);
            }
            if (probeFinished && probeProgress.get() >= 200) {
                for (HarnessEventStream stream : streams) {
                    stream.close();
                }
                client.close();
                marker("streams-closed");
            }
            // A starved probe means readers are still parked on their
            // monitors: any close() here would block uninterruptibly, so
            // leave the daemon virtual threads for the fork's teardown.
        }
        assertTrue(probeFinished && probeProgress.get() >= 200,
                "virtual threads starved within 30 s of " + streamCount
                        + " blocked stream readers on " + carriers
                        + " carriers (progress=" + probeProgress.get()
                        + ") — a reader pinned its carrier");
    }

    private static boolean virtualThreadsAvailable() {
        try {
            Thread.class.getMethod("ofVirtual");
            return true;
        } catch (NoSuchMethodException unavailable) {
            return false;
        }
    }

    private static void marker(String message) {
        System.err.println("PINNING-MARKER " + message);
    }

    // The module compiles at release 11, where virtual threads do not
    // exist; create them reflectively so the witness compiles everywhere
    // and runs wherever they exist.
    private static Thread startVirtualThread(Runnable task) {
        try {
            Object builder = Thread.class.getMethod("ofVirtual")
                    .invoke(null);
            return (Thread) Class.forName("java.lang.Thread$Builder$OfVirtual")
                    .getMethod("start", Runnable.class)
                    .invoke(builder, task);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void sleepUnchecked(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static boolean probeJoinUnchecked(Thread thread, long millis) {
        try {
            thread.join(millis);
            return !thread.isAlive();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }
}
